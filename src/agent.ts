import { Annotation, END, Send, START, StateGraph } from "@langchain/langgraph";
import OpenAI from "openai";
import { zodResponseFormat } from "openai/helpers/zod.mjs";
import type { ChatCompletionMessageParam } from "openai/resources";
import type { Settings } from "./config";
import { CostTracker } from "./cost_tracker.js";
import type { ReflectionResult, SearchOutput, Subtask } from "./models.js";
import { planSchema, type Subtask } from "./models.js";
import { HelpDeskAgentPrompts } from "./prompt";

const MAX_CHALLENGE_COUNT = 3;

const AgentSubGraphState = Annotation.Root({
  question: Annotation<string>(),
  plan: Annotation<string[]>(),
  subtask: Annotation<string>(),
  isCompleted: Annotation<boolean>(),
  messages: Annotation<ChatCompletionMessageParam[]>(),
  challengeCount: Annotation<number>(),
});

const AgentState = Annotation.Root({
  question: Annotation<string>(),
  plan: Annotation<string[]>(),
  currentStep: Annotation<number>(),
  subtaskResults: Annotation<Subtask[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  // lastAnswer: Annotation<string>(),
});

export class HelpDeskAgent {
  private settings: Settings;
  private prompts: HelpDeskAgentPrompts;
  private client: OpenAI;
  private costTracker = new CostTracker();

  constructor(
    settings: Settings,
    prompts: HelpDeskAgentPrompts = new HelpDeskAgentPrompts(),
  ) {
    this.settings = settings;
    this.prompts = prompts;
    this.client = new OpenAI({
      apiKey: this.settings.openai_api_key,
      baseURL: this.settings.openai_api_base,
    });
    this.costTracker.wrap(this.client);
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
    console.log("subgraph result:", result);
    return { subtaskResults: [] };
  }

  private createSubGraph() {
    const workflow = new StateGraph(AgentSubGraphState)
      .addNode("select_tools", (state) => {
        console.log("select_tools", state.subtask);
        return {};
      })
      .addEdge(START, "select_tools")
      .addEdge("select_tools", END);
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
    console.log(plan);
    if (!plan) throw new Error("Plan is null");

    return { plan: plan.subtasks };
  }

  createGraph() {
    const workflow = new StateGraph(AgentState)
      .addNode("create_plan", (state) => this.createPlan(state))
      .addNode("execute_subtasks", (state) => this.executeSubgraph(state))
      .addEdge(START, "create_plan")
      .addConditionalEdges("create_plan", (state) =>
        this.shouldContinueExecSubtasks(state),
      )
      .addEdge("create_plan", END);
    return workflow.compile();
  }

  async runAgent(question: string) {
    const app = this.createGraph();
    const result = await app.invoke({ question });
    console.log(result);
    this.costTracker.printReport(this.settings.openai_model);
  }
}
