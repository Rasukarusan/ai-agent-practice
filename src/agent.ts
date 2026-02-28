import { Annotation, END, Send, START, StateGraph } from "@langchain/langgraph";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod.mjs";
import type { ChatCompletionMessageParam } from "openai/resources";
import type { Settings } from "./config";
import { CostTracker } from "./cost_tracker.js";
import {
  type AgentResult,
  agentResultSchema,
  planSchema,
  type ReflectionResult,
  reflectionResultSchema,
  type SearchOutput,
  type Subtask,
  type Tool,
  type ToolResult,
} from "./models.js";
import { HelpDeskAgentPrompts } from "./prompt";

const MAX_CHALLENGE_COUNT = 3;

const AgentSubGraphState = Annotation.Root({
  question: Annotation<string>(),
  plan: Annotation<string[]>(),
  subtask: Annotation<string>(),
  subtaskAnswer: Annotation<string>(),
  isCompleted: Annotation<boolean>(),
  messages: Annotation<ChatCompletionMessageParam[]>(),
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
  subtaskResults: Annotation<Subtask[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  lastAnswer: Annotation<string>(),
});

export class HelpDeskAgent {
  private settings: Settings;
  private prompts: HelpDeskAgentPrompts;
  private client: OpenAI;
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
    this.client = new OpenAI({
      apiKey: this.settings.openai_api_key,
      baseURL: this.settings.openai_api_base,
    });
    this.toolMap = Object.fromEntries(tools.map((t) => [t.function.name, t]));
    this.costTracker.wrap(this.client);
  }

  private async createAnswer(state: typeof AgentState.State) {
    const subtaskResults = state.subtaskResults.map(
      (r) => [r.task_name, r.subtask_answer] as const,
    );

    const userPrompt = this.prompts.createLastAnswerUserPrompt
      .replace("{question}", state.question)
      .replace("{subtask_results}", String(subtaskResults));

    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: this.prompts.createLastAnswerSystemPrompt },
      { role: "user", content: userPrompt },
    ];

    const response = await this.client.chat.completions.create({
      model: this.settings.openai_model,
      messages,
      temperature: 0,
      seed: 0,
    });
    return { lastAnswer: response.choices[0].message.content ?? "" };
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
    const messages: ChatCompletionMessageParam[] = [...state.messages];

    messages.push({
      role: "user",
      content: this.prompts.subtaskReflectionUserPrompt,
    });

    const response = await this.client.chat.completions.parse({
      model: this.settings.openai_model,
      messages,
      response_format: zodResponseFormat(
        reflectionResultSchema,
        "reflectionResult",
      ),
      temperature: 0,
      seed: 0,
    });

    const reflectionResult = response.choices[0].message.parsed;
    if (!reflectionResult) throw new Error("Reflection resul is null");

    messages.push({
      role: "assistant",
      content: JSON.stringify(reflectionResult),
    });

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

    const response = await this.client.chat.completions.create({
      model: this.settings.openai_model,
      messages,
      temperature: 0,
      seed: 0,
    });

    const subtaskAnswer = response.choices[0].message.content ?? "";
    messages.push({ role: "assistant", content: subtaskAnswer });

    return { messages, subtaskAnswer };
  }

  private async executeTools(state: typeof AgentSubGraphState.State) {
    const messages = [...state.messages];
    const lastMessage = messages[messages.length - 1];

    if (!("tool_calls" in lastMessage) || !lastMessage.tool_calls) {
      throw new Error("Toolcalls are null");
    }

    const currentToolResults: ToolResult[] = [];

    for (const toolCall of lastMessage.tool_calls) {
      if (toolCall.type !== "function") continue;
      const toolName = toolCall.function.name;
      const toolArgs = toolCall.function.arguments;

      const tool = this.toolMap[toolName];
      const toolResult = await tool.invoke(toolArgs);

      currentToolResults.push({
        tool_name: toolName,
        args: toolArgs,
        results: Array.isArray(toolResult) ? toolResult : [],
      });

      messages.push({
        role: "tool" as const,
        content: JSON.stringify(toolResult),
        tool_call_id: toolCall.id,
      });
    }

    return { messages, toolResults: [currentToolResults] };
  }

  private async selectTools(state: typeof AgentSubGraphState.State) {
    let messages: ChatCompletionMessageParam[];

    if (state.challengeCount === 0) {
      // 初回：プロンプトを新規作成
      const userPrompt = this.prompts.subtaskToolSelectionUserPrompt
        .replace("{question}", state.question)
        .replace("{plan}", state.plan.join(","))
        .replace("{subtask}", state.subtask);

      messages = [
        { role: "system", content: this.prompts.subtaskSystemPrompt },
        { role: "user", content: userPrompt },
      ];
    } else {
      // リトライ：過去のメッセージにリトライ指示を追加
      messages = state.messages.filter(
        (m) => m.role !== "tool" && !("tool_calls" in m),
      );
      messages.push({
        role: "user",
        content: this.prompts.subtaskRetryAnswerUserPrompt,
      });
    }

    const response = await this.client.chat.completions.create({
      model: this.settings.openai_model,
      messages,
      // tools内にinvokeがあり、それを送るとOpenAI側で弾かれる可能性があるため。
      // ChatCompletionTool型としてはtype, functionのみを期待している
      tools: this.tools.map(({ type, function: fn }) => ({
        type,
        function: fn,
      })),
      temperature: 0,
      seed: 0,
    });

    const toolCalls = response.choices[0].message.tool_calls;
    if (!toolCalls) throw new Error("Tool calls are null");
    messages.push({
      role: "assistant",
      tool_calls: toolCalls,
    });
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

    console.log("subgraph result:", result);
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
    const userPrompt = this.prompts.plannerUserPrompt.replace(
      "{question}",
      state.question,
    );

    const response = await this.client.chat.completions.parse({
      model: this.settings.openai_model,
      messages: [
        { role: "system", content: this.prompts.plannerSystemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: zodResponseFormat(planSchema, "plan"),
      temperature: 0,
      seed: 0,
    });
    const plan = response.choices[0].message.parsed;
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

  async runAgent(question: string): Promise<AgentResult> {
    const app = this.createGraph();
    const result = await app.invoke({ question });

    const agentResult: AgentResult = {
      question,
      plan: { subtasks: result.plan },
      subtasks: result.subtaskResults,
      answer: result.lastAnswer,
    };
    console.log(JSON.stringify(agentResult, null, 2));
    this.costTracker.printReport(this.settings.openai_model);
    return agentResult;
  }
}
