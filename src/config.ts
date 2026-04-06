import { initChatModel } from "langchain/chat_models/universal";
import { z } from "zod";

const settingsSchema = z.object({
  api_key: z.string(),
  model: z.string(),
  base_url: z.string().optional(),
  thinking: z.boolean().default(true),
  tool_choice: z.enum(["any", "required"]),
  mem0_enabled: z.boolean().default(false),
  mem0_base_url: z.string().url().default("http://localhost:8000"),
  mem0_user_id: z.string().default("helpdesk-user"),
  mem0_api_key: z.string().optional(),
  mem0_search_limit: z.number().int().min(1).max(20).default(5),
});

export type Settings = z.infer<typeof settingsSchema>;

export function loadSettings(): Settings {
  const model = process.env.LLM_MODEL ?? "";
  return settingsSchema.parse({
    api_key: process.env.LLM_API_KEY,
    model,
    base_url: process.env.LLM_BASE_URL,
    thinking: process.env.LLM_THINKING !== "false",
    tool_choice: model.startsWith("gemini") ? "any" : "required",
    mem0_enabled: process.env.MEM0_ENABLED === "true",
    mem0_base_url: process.env.MEM0_BASE_URL,
    mem0_user_id: process.env.MEM0_USER_ID,
    mem0_api_key: process.env.MEM0_API_KEY,
    mem0_search_limit: Number(process.env.MEM0_SEARCH_LIMIT ?? 5),
  });
}

/**
 * モデル名からプロバイダを推定する。
 * initChatModel のデフォルト推定では gemini が google-vertexai に割り当てられるため、
 * google-genai に補正する。
 */
function inferModelProvider(model: string): string | undefined {
  if (model.startsWith("gemini")) return "google-genai";
  // それ以外は initChatModel のデフォルト推定に任せる
  return undefined;
}

export async function createChatClient(settings: Settings) {
  const provider = inferModelProvider(settings.model);

  const kwargs: Record<string, unknown> = {
    apiKey: settings.api_key,
    temperature: 0,
  };

  if (provider === "google-genai") {
    if (settings.base_url) kwargs.baseUrl = settings.base_url;
    if (!settings.thinking) kwargs.thinkingConfig = { thinkingBudget: 0 };
  } else {
    if (settings.base_url)
      kwargs.configuration = { baseURL: settings.base_url };
  }

  return initChatModel(settings.model, {
    modelProvider: provider,
    ...kwargs,
  });
}
