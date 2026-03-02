import { z } from "zod";

const settingsSchema = z.object({
  gemini_api_key: z.string(),
  gemini_model: z.string(),
});

export type Settings = z.infer<typeof settingsSchema>;

export function loadSettings(): Settings {
  return settingsSchema.parse({
    gemini_api_key: process.env.GEMINI_API_KEY,
    gemini_model: process.env.GEMINI_MODEL,
  });
}
