import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";

const settingsSchema = z.object({
  api_key: z.string(),
  model: z.string(),
  base_url: z.string().optional(),
  thinking: z.boolean().default(true),
});

export type Settings = z.infer<typeof settingsSchema>;

export function loadSettings(): Settings {
  return settingsSchema.parse({
    api_key: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL,
    base_url: process.env.LLM_BASE_URL,
    thinking: process.env.LLM_THINKING !== "false",
  });
}

function isGemini(model: string): boolean {
  return model.startsWith("gemini");
}

export function getToolChoice(model: string): "any" | "required" {
  return isGemini(model) ? "any" : "required";
}

export function createChatClient(settings: Settings): BaseChatModel {
  if (isGemini(settings.model)) {
    return new ChatGoogleGenerativeAI({
      model: settings.model,
      apiKey: settings.api_key,
      baseUrl: settings.base_url,
      temperature: 0,
      thinkingConfig: settings.thinking ? undefined : { thinkingBudget: 0 },
    });
  }
  return new ChatOpenAI({
    model: settings.model,
    apiKey: settings.api_key,
    configuration: { baseURL: settings.base_url },
    temperature: 0,
  });
}
