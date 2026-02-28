import {
  Annotation,
  Command,
  END,
  MemorySaver,
  Send,
  START,
  StateGraph,
  interrupt,
} from "@langchain/langgraph";
import * as readline from "node:readline/promises";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod.mjs";
import type { ChatCompletionMessageParam } from "openai/resources";
import type { Settings } from "./config.js";
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
import { HelpDeskAgentPrompts } from "./prompt.js";

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
  planFeedback: Annotation<string>(),
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
  // サブグラフを一度だけコンパイルして再利用する（Chapter 6 パターン）
  private compiledSubGraph;

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
    this.compiledSubGraph = this.createSubGraph();
  }

  // ===== Main Graph Nodes =====

  async createPlan(state: typeof AgentState.State) {
    console.log("[create_plan] プラン作成中...");

    // ユーザーからのフィードバックがあればプラン作成に反映
    const question = state.planFeedback
      ? `${state.question}\n\nユーザーからの追加要望: ${state.planFeedback}`
      : state.question;

    const userPrompt = this.prompts.plannerUserPrompt.replace(
      "{question}",
      question,
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

    console.log("[create_plan] プラン作成完了");
    for (const [i, s] of plan.subtasks.entries()) {
      console.log(`  ${i + 1}. ${s}`);
    }

    return { plan: plan.subtasks };
  }

  /**
   * interrupt() でグラフの実行を一時停止し、ユーザーにプランの確認を求める。
   * ユーザーが "ok" を入力 → planFeedback を空にして続行
   * ユーザーが修正内容を入力 → planFeedback に保存し create_plan へ戻る
   */
  private reviewPlan(state: typeof AgentState.State) {
    const planDisplay = state.plan
      .map((s, i) => `${i + 1}. ${s}`)
      .join("\n");

    // interrupt() でワークフローを一時停止
    // resume 時にユーザーの入力がここに返ってくる
    const feedback = interrupt(planDisplay);

    if (!feedback || feedback === "ok" || feedback === "OK") {
      console.log("[review_plan] プラン承認済み");
      return { planFeedback: "" };
    }

    console.log(`[review_plan] プラン修正リクエスト: ${feedback}`);
    return { planFeedback: String(feedback) };
  }

  /**
   * プランレビュー後のルーティング:
   * - planFeedback あり → create_plan に戻って再作成
   * - planFeedback なし → Send で各サブタスクを並列実行
   */
  private routeAfterReview(state: typeof AgentState.State): string | Send[] {
    if (state.planFeedback) {
      return "create_plan";
    }
    return state.plan.map(
      (_, idx) =>
        new Send("execute_subtasks", {
          question: state.question,
          plan: state.plan,
          currentStep: idx,
        }),
    );
  }

  private async createAnswer(state: typeof AgentState.State) {
    console.log("[create_answer] 最終回答作成中...");

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

    console.log("[create_answer] 最終回答作成完了");
    return { lastAnswer: response.choices[0].message.content ?? "" };
  }

  // ===== SubGraph Nodes =====

  private shouldContinueExecSubtasksFlow(
    state: typeof AgentSubGraphState.State,
  ): "end" | "continue" {
    if (state.isCompleted || state.challengeCount >= MAX_CHALLENGE_COUNT) {
      return "end";
    }
    return "continue";
  }

  private async reflectSubtask(state: typeof AgentSubGraphState.State) {
    console.log(
      `  [reflect] リフレクション中... (${state.challengeCount + 1}/${MAX_CHALLENGE_COUNT})`,
    );

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
    if (!reflectionResult) throw new Error("Reflection result is null");

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

    if (reflectionResult.is_completed) {
      console.log("  [reflect] -> OK");
    } else {
      console.log(`  [reflect] -> NG: ${reflectionResult.advice}`);
    }

    if (
      challengeCount >= MAX_CHALLENGE_COUNT &&
      !reflectionResult.is_completed
    ) {
      updateState.subtaskAnswer = `「${state.subtask}」の回答が見つかりませんでした。`;
    }

    return updateState;
  }

  private async createSubtaskAnswer(state: typeof AgentSubGraphState.State) {
    console.log("  [subtask_answer] サブタスク回答作成中...");

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
    console.log("  [execute_tools] ツール実行中...");

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

      console.log(`    -> ${toolName}(${toolArgs})`);

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
    const isRetry = state.challengeCount > 0;
    console.log(
      `  [select_tools] ${isRetry ? "リトライ: " : ""}ツール選択中...`,
    );

    let messages: ChatCompletionMessageParam[];

    if (state.challengeCount === 0) {
      const userPrompt = this.prompts.subtaskToolSelectionUserPrompt
        .replace("{question}", state.question)
        .replace("{plan}", state.plan.join(","))
        .replace("{subtask}", state.subtask);

      messages = [
        { role: "system", content: this.prompts.subtaskSystemPrompt },
        { role: "user", content: userPrompt },
      ];
    } else {
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

  // ===== SubGraph Construction & Execution =====

  private async executeSubgraph(state: typeof AgentState.State) {
    const subtask = state.plan[state.currentStep];
    console.log(
      `[execute_subtasks] サブタスク実行中 (${state.currentStep + 1}/${state.plan.length}): ${subtask}`,
    );

    const result = await this.compiledSubGraph.invoke({
      question: state.question,
      plan: state.plan,
      subtask,
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

    const status = subtaskResult.is_completed ? "完了" : "未完了";
    console.log(`[execute_subtasks] サブタスク${status}: ${subtask}`);

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

  // ===== Main Graph Construction =====

  createGraph() {
    const workflow = new StateGraph(AgentState)
      .addNode("create_plan", (state) => this.createPlan(state))
      .addNode("review_plan", (state) => this.reviewPlan(state))
      .addNode("execute_subtasks", (state) => this.executeSubgraph(state))
      .addNode("create_answer", (state) => this.createAnswer(state))
      .addEdge(START, "create_plan")
      .addEdge("create_plan", "review_plan")
      .addConditionalEdges("review_plan", (state) =>
        this.routeAfterReview(state),
      )
      .addEdge("execute_subtasks", "create_answer")
      .addEdge("create_answer", END);

    // MemorySaver: interrupt による中断/再開に必要なチェックポインター
    return workflow.compile({ checkpointer: new MemorySaver() });
  }

  // ===== Agent Execution with Streaming + Interrupt =====

  async runAgent(question: string): Promise<AgentResult> {
    const app = this.createGraph();
    const config = { configurable: { thread_id: crypto.randomUUID() } };
    const streamConfig = { ...config, streamMode: "updates" as const };

    // graph.stream() でノードごとの進捗をリアルタイム表示
    for await (const _event of app.stream({ question }, streamConfig)) {
      // 進捗表示は各ノード内の console.log で行うため、ここではストリーム消化のみ
    }

    // interrupt ループ: プランレビューで一時停止 → ユーザー入力 → 再開
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      let graphState = await app.getState(config);
      while (graphState.next.length > 0) {
        // interrupt の値（プラン表示）を取得
        const tasks = graphState.tasks as Array<{
          interrupts?: Array<{ value: string }>;
        }>;
        const interruptValue = tasks?.[0]?.interrupts?.[0]?.value;
        if (interruptValue) {
          console.log("\n--- プラン確認 ---");
          console.log(interruptValue);
          console.log("------------------");
        }

        const feedback = await rl.question(
          'プランを承認する場合は「ok」、修正する場合は修正内容を入力: ',
        );

        // Command({ resume }) で interrupt から再開
        for await (const _event of app.stream(
          new Command({ resume: feedback || "ok" }),
          streamConfig,
        )) {
          // ストリーム消化
        }

        graphState = await app.getState(config);
      }
    } finally {
      rl.close();
    }

    // 最終ステートから結果を取得
    const finalState = await app.getState(config);
    const values = finalState.values as typeof AgentState.State;

    const agentResult: AgentResult = {
      question,
      plan: { subtasks: values.plan },
      subtasks: values.subtaskResults,
      answer: values.lastAnswer,
    };
    console.log(JSON.stringify(agentResult, null, 2));
    this.costTracker.printReport(this.settings.openai_model);
    return agentResult;
  }
}
