import { z } from "zod";

export const searchOutputSchema = z.object({
  file_name: z.string(),
  content: z.string(),
});
export type SearchOutput = z.infer<typeof searchOutputSchema>;

export const planSchema = z.object({
  subtasks: z
    .array(z.string())
    .describe("問題を解決するためのサブタスクリスト"),
});
export type Plan = z.infer<typeof planSchema>;

export const toolResultSchema = z.object({
  tool_name: z.string(),
  args: z.string(),
  results: z.array(searchOutputSchema),
});
export type ToolResult = z.infer<typeof toolResultSchema>;

export const reflectionResultSchema = z.object({
  advice: z
    .string()
    .describe(
      "評価がNGの場合は、別のツールを試す、別の文言でツールを試すなど、なぜNGなのかとどうしたら改善できるかを考えアドバイスを作成してください。アドバイスの内容は過去のアドバイスと計画内の他のサブタスクと重複しないようにしてください。アドバイスの内容をもとにツール選択・実行からやり直します。",
    ),
  is_completed: z
    .boolean()
    .describe(
      "ツールの実行結果と回答から、サブタスクに対して正しく回答できているかの評価結果",
    ),
});
export type ReflectionResult = z.infer<typeof reflectionResultSchema>;

export const subtaskSchema = z.object({
  task_name: z.string(),
  tool_results: z.array(z.array(toolResultSchema)),
  reflection_results: z.array(reflectionResultSchema),
  is_completed: z.boolean(),
  subtask_answer: z.string(),
  challenge_count: z.number(),
});
export type Subtask = z.infer<typeof subtaskSchema>;

export const agentResultSchema = z.object({
  question: z.string(),
  plan: planSchema,
  subtasks: z.array(subtaskSchema),
  answer: z.string(),
});
export type AgentResult = z.infer<typeof agentResultSchema>;
