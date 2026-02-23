import { z } from "zod";

const settingsSchema = z.object({
  openai_api_key: z.string(),
  openai_api_base: z.string(),
  openai_model: z.string(),
});

export type Settings = z.infer<typeof settingsSchema>;

export function loadSettings(): Settings {
  return settingsSchema.parse({
    openai_api_key: process.env.OPENAI_API_KEY,
    openai_api_base: process.env.OPENAI_API_BASE,
    openai_model: process.env.OPENAI_MODEL,
  });
}
