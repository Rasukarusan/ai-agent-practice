import { z } from "zod";

const settingsSchema = z.object({
  api_key: z.string(),
  model: z.string(),
  base_url: z.string().optional(),
});

export type Settings = z.infer<typeof settingsSchema>;

export function loadSettings(): Settings {
  return settingsSchema.parse({
    api_key: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL,
    base_url: process.env.LLM_BASE_URL,
  });
}
