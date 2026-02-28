/**
 * LangGraph のコールバックシステムを利用した進捗レポーター
 *
 * BaseCallbackHandler を継承し、各ノードの開始・完了イベントを
 * ProgressReporter に委譲する。ロジックコードを一切変更せずに
 * 進捗表示を実現する。
 */
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { ChatCompletionMessageParam } from "openai/resources";
import type { ToolResult } from "./models.js";
import type { ProgressReporter } from "./progress.js";

interface RunContext {
  name: string;
  stepIndex?: number;
  totalSteps?: number;
  parentRunId?: string;
}

export class GraphProgressHandler extends BaseCallbackHandler {
  name = "GraphProgressHandler";

  private progress: ProgressReporter;
  private maxChallengeCount: number;
  private runs = new Map<string, RunContext>();

  constructor(progress: ProgressReporter, maxChallengeCount: number) {
    super();
    this.progress = progress;
    this.maxChallengeCount = maxChallengeCount;
  }

  /**
   * runId の親チェーンを辿り、execute_subtasks ノードの
   * stepIndex / totalSteps を見つける
   */
  private getSubtaskContext(
    runId: string,
  ): { stepIndex: number; totalSteps: number } | undefined {
    let current: string | undefined = runId;
    while (current) {
      const run = this.runs.get(current);
      if (!run) return undefined;
      if (run.stepIndex !== undefined && run.totalSteps !== undefined) {
        return { stepIndex: run.stepIndex, totalSteps: run.totalSteps };
      }
      current = run.parentRunId;
    }
    return undefined;
  }

  handleChainStart(
    _chain: Serialized,
    inputs: Record<string, unknown>,
    runId: string,
    _runType?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
    parentRunId?: string,
  ) {
    const name = runName ?? "";
    const ctx: RunContext = { name, parentRunId };

    switch (name) {
      case "create_plan":
        this.progress.creatingPlan();
        break;
      case "execute_subtasks": {
        const stepIndex = inputs.currentStep as number;
        const plan = inputs.plan as string[];
        ctx.stepIndex = stepIndex;
        ctx.totalSteps = plan.length;
        this.progress.subtaskStart(stepIndex, plan.length, plan[stepIndex]);
        break;
      }
      case "create_answer":
        this.progress.creatingFinalAnswer();
        break;
    }

    this.runs.set(runId, ctx);
  }

  handleChainEnd(
    outputs: Record<string, unknown>,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
  ) {
    const run = this.runs.get(runId);
    if (!run) return;

    const ctx = this.getSubtaskContext(runId);

    switch (run.name) {
      case "create_plan":
        this.progress.planCreated(outputs.plan as string[]);
        break;

      case "select_tools": {
        if (!ctx) break;
        const msgs = outputs.messages as ChatCompletionMessageParam[];
        const lastMsg = msgs[msgs.length - 1];
        if ("tool_calls" in lastMsg && lastMsg.tool_calls) {
          const names = (
            lastMsg.tool_calls as {
              type: string;
              function: { name: string };
            }[]
          )
            .filter((tc) => tc.type === "function")
            .map((tc) => tc.function.name);
          this.progress.toolsSelected(ctx.stepIndex, ctx.totalSteps, names);
        }
        break;
      }

      case "execute_tools": {
        if (!ctx) break;
        const toolResults = outputs.toolResults as ToolResult[][];
        for (const batch of toolResults) {
          for (const tr of batch) {
            this.progress.toolExecuted(
              ctx.stepIndex,
              ctx.totalSteps,
              tr.tool_name,
              tr.args,
              tr.results.length,
            );
          }
        }
        break;
      }

      case "create_subtask_answer":
        if (ctx) {
          this.progress.subtaskAnswerCreated(ctx.stepIndex, ctx.totalSteps);
        }
        break;

      case "reflect_subtask": {
        if (!ctx) break;
        this.progress.reflection(
          ctx.stepIndex,
          ctx.totalSteps,
          outputs.isCompleted as boolean,
          outputs.challengeCount as number,
          this.maxChallengeCount,
        );
        break;
      }
    }
  }
}
