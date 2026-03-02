import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  Annotation,
  END,
  Send,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import type { Settings } from "./config.js";
import { CostTracker } from "./cost_tracker.js";
import {
  type AgentResult,
  planSchema,
  type ReflectionResult,
  reflectionResultSchema,
  type Subtask,
  type Tool,
  type ToolResult,
} from "./models.js";
import { HelpDeskAgentPrompts } from "./prompt.js";
import { StreamDisplay } from "./stream_display.js";

const MAX_CHALLENGE_COUNT = 3;

const AgentSubGraphState = Annotation.Root({
  question: Annotation<string>(),
  plan: Annotation<string[]>(),
  subtask: Annotation<string>(),
  subtaskAnswer: Annotation<string>(),
  isCompleted: Annotation<boolean>(),
  messages: Annotation<BaseMessage[]>(),
  challengeCount: Annotation<number>(),
  reflectionResults: Annotation<ReflectionResult[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  toolResults: Annotation<ToolResult[][]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
});

const AgentState = Annotation.Root({
  question: Annotation<string>(),
  plan: Annotation<string[]>(),
  currentStep: Annotation<number>(),
  previousSubtaskResults: Annotation<Subtask[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  subtaskResults: Annotation<Subtask[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  lastAnswer: Annotation<string>(),
});

interface RunAgentOptions {
  question: string;
  threadId: string;
  signal?: AbortSignal;
  previousSubtaskResults?: Subtask[];
}

export class HelpDeskAgent {
  private settings: Settings;
  private prompts: HelpDeskAgentPrompts;
  private client: ChatGoogleGenerativeAI;
  private tools: Tool[];
  private toolMap: Record<string, Tool>;
  private costTracker = new CostTracker();


  constructor(
    settings: Settings,
    tools: Tool[] = [],
    prompts: HelpDeskAgentPrompts = new HelpDeskAgentPrompts(),
  ) {
    this.settings = settings;
    this.tools = tools;
    this.prompts = prompts;
    this.client = new ChatGoogleGenerativeAI({
      model: this.settings.model,
      apiKey: this.settings.api_key,
      baseUrl: this.settings.base_url,
      temperature: 0,
    });
    this.toolMap = Object.fromEntries(tools.map((t) => [t.function.name, t]));
  }

  private async createAnswer(state: typeof AgentState.State) {
    const allResults = [
      ...state.previousSubtaskResults,
      ...state.subtaskResults,
    ];
    const subtaskResults = allResults.map(
      (r) => [r.task_name, r.subtask_answer] as const,
    );

    const userPrompt = this.prompts.createLastAnswerUserPrompt
      .replace("{question}", state.question)
      .replace("{subtask_results}", String(subtaskResults));

    const messages = [
      new SystemMessage(this.prompts.createLastAnswerSystemPrompt),
      new HumanMessage(userPrompt),
    ];

    const response = await this.client.invoke(messages);
    return { lastAnswer: response.content as string };
  }

  private shouldContinueExecSubtasksFlow(
    state: typeof AgentSubGraphState.State,
  ): "end" | "continue" {
    if (state.isCompleted || state.challengeCount >= MAX_CHALLENGE_COUNT) {
      return "end";
    }
    return "continue";
  }

  private async reflectSubtask(state: typeof AgentSubGraphState.State) {
    const messages: BaseMessage[] = [...state.messages];

    messages.push(new HumanMessage(this.prompts.subtaskReflectionUserPrompt));

    const structured = this.client.withStructuredOutput(
      reflectionResultSchema,
    );
    const reflectionResult = await structured.invoke(messages);

    messages.push(new AIMessage(JSON.stringify(reflectionResult)));

    const challengeCount = state.challengeCount + 1;
    const updateState: Record<string, unknown> = {
      messages,
      reflectionResults: [reflectionResult],
      challengeCount,
      isCompleted: reflectionResult.is_completed,
    };

    if (
      challengeCount >= MAX_CHALLENGE_COUNT &&
      !reflectionResult.is_completed
    ) {
      updateState.subtaskAnswer = `「${state.subtask}」の回答が見つかりませんでした。`;
    }

    return updateState;
  }

  private async createSubtaskAnswer(state: typeof AgentSubGraphState.State) {
    const messages = [...state.messages];

    const response = await this.client.invoke(messages);
    const subtaskAnswer = response.content as string;
    messages.push(response);

    return { messages, subtaskAnswer };
  }

  private async executeTools(state: typeof AgentSubGraphState.State) {
    const messages = [...state.messages];
    const lastMessage = messages[messages.length - 1] as AIMessage;

    if (!lastMessage.tool_calls?.length) {
      throw new Error("Toolcalls are null");
    }

    const currentToolResults: ToolResult[] = [];

    for (const toolCall of lastMessage.tool_calls) {
      const toolName = toolCall.name;
      const toolArgs = JSON.stringify(toolCall.args);

      const tool = this.toolMap[toolName];
      const toolResult = await tool.invoke(toolArgs);

      currentToolResults.push({
        tool_name: toolName,
        args: toolArgs,
        results: Array.isArray(toolResult) ? toolResult : [],
      });

      messages.push(
        new ToolMessage({
          content: JSON.stringify(toolResult),
          tool_call_id: toolCall.id ?? "",
        }),
      );
    }

    return { messages, toolResults: [currentToolResults] };
  }

  private async selectTools(state: typeof AgentSubGraphState.State) {
    let messages: BaseMessage[];

    if (state.challengeCount === 0) {
      // 初回：プロンプトを新規作成
      const userPrompt = this.prompts.subtaskToolSelectionUserPrompt
        .replace("{question}", state.question)
        .replace("{plan}", state.plan.join(","))
        .replace("{subtask}", state.subtask);

      messages = [
        new SystemMessage(this.prompts.subtaskSystemPrompt),
        new HumanMessage(userPrompt),
      ];
    } else {
      // リトライ：過去のメッセージにリトライ指示を追加
      messages = state.messages.filter(
        (m) =>
          !(m instanceof ToolMessage) && !(m as AIMessage).tool_calls?.length,
      );
      messages.push(
        new HumanMessage(this.prompts.subtaskRetryAnswerUserPrompt),
      );
    }

    const modelWithTools = this.client.bindTools(
      this.tools.map(({ type, function: fn }) => ({ type, function: fn })),
    );
    const response = await modelWithTools.invoke(messages);
    if (!response.tool_calls?.length) throw new Error("Tool calls are null");

    messages.push(response);
    return { messages };
  }

  private async executeSubgraph(state: typeof AgentState.State) {
    const subgraph = this.createSubGraph();
    const result = await subgraph.invoke({
      question: state.question,
      plan: state.plan,
      subtask: state.plan[state.currentStep],
      isCompleted: false,
      challengeCount: 0,
      messages: [],
    });

    const subtaskResult: Subtask = {
      task_name: result.subtask,
      tool_results: result.toolResults,
      reflection_results: result.reflectionResults,
      is_completed: result.isCompleted,
      subtask_answer: result.subtaskAnswer,
      challenge_count: result.challengeCount,
    };

    return { subtaskResults: [subtaskResult] };
  }

  private createSubGraph() {
    const workflow = new StateGraph(AgentSubGraphState)
      .addNode("select_tools", (state) => this.selectTools(state))
      .addNode("execute_tools", (state) => this.executeTools(state))
      .addNode("create_subtask_answer", (state) =>
        this.createSubtaskAnswer(state),
      )
      .addNode("reflect_subtask", (state) => this.reflectSubtask(state))
      .addEdge(START, "select_tools")
      .addEdge("select_tools", "execute_tools")
      .addEdge("execute_tools", "create_subtask_answer")
      .addEdge("create_subtask_answer", "reflect_subtask")
      .addConditionalEdges(
        "reflect_subtask",
        (state) => this.shouldContinueExecSubtasksFlow(state),
        { continue: "select_tools", end: END },
      );
    return workflow.compile();
  }

  shouldContinueExecSubtasks(state: typeof AgentState.State) {
    return state.plan.map(
      (_, idx) =>
        new Send("execute_subtasks", {
          question: state.question,
          plan: state.plan,
          currentStep: idx,
        }),
    );
  }

  async createPlan(state: typeof AgentState.State) {
    const hasPrevious = state.previousSubtaskResults.length > 0;
    const userPrompt = hasPrevious
      ? this.prompts.replanUserPrompt
          .replace("{question}", state.question)
          .replace(
            "{completed_subtasks}",
            state.previousSubtaskResults
              .map((r) => `- ${r.task_name}: ${r.subtask_answer}`)
              .join("\n"),
          )
      : this.prompts.plannerUserPrompt.replace("{question}", state.question);

    const structured = this.client.withStructuredOutput(planSchema);
    const plan = await structured.invoke([
      new SystemMessage(this.prompts.plannerSystemPrompt),
      new HumanMessage(userPrompt),
    ]);
    if (!plan) throw new Error("Plan is null");

    return { plan: plan.subtasks };
  }

  createGraph() {
    const workflow = new StateGraph(AgentState)
      .addNode("create_plan", (state) => this.createPlan(state))
      .addNode("execute_subtasks", (state) => this.executeSubgraph(state))
      .addNode("create_answer", (state) => this.createAnswer(state))
      .addEdge(START, "create_plan")
      .addConditionalEdges("create_plan", (state) =>
        this.shouldContinueExecSubtasks(state),
      )
      .addEdge("execute_subtasks", "create_answer")
      .addEdge("create_answer", END);
    return workflow.compile();
  }

  async runAgent(
    options: RunAgentOptions,
  ): Promise<AgentResult | { aborted: true; completedSubtasks: Subtask[] }> {
    const { question, threadId, signal, previousSubtaskResults } = options;
    const app = this.createGraph();
    const config = { configurable: { thread_id: threadId } };
    const stream = await app.stream(
      { question, previousSubtaskResults: previousSubtaskResults ?? [] },
      {
        ...config,
        streamMode: ["messages", "values"],
        subgraphs: true,
        callbacks: [this.costTracker],
        signal,
      },
    );

    let result: typeof AgentState.State | undefined;
    const display = new StreamDisplay();

    try {
      for await (const [_namespace, mode, event] of stream) {
        if (mode === "messages") {
          const [chunk, metadata] = event;
          const node = metadata.langgraph_node as string;
          const ns = Array.isArray(_namespace)
            ? _namespace.join("/")
            : String(_namespace);

          if (typeof chunk.content === "string" && chunk.content) {
            display.update(node, ns, chunk.content);
          }
        } else if (mode === "values") {
          result = event;
        }
      }
    } catch (e) {
      if (signal?.aborted) {
        display.finish("aborted");
        return {
          aborted: true,
          completedSubtasks: result?.subtaskResults ?? [],
        };
      }
      throw e;
    }
    display.finish();

    if (!result) throw new Error("No result from stream");

    const agentResult: AgentResult = {
      question,
      plan: { subtasks: result.plan },
      subtasks: result.subtaskResults,
      answer: result.lastAnswer,
    };
    console.log(agentResult);
    this.costTracker.printReport(this.settings.model);
    return agentResult;
  }
}
