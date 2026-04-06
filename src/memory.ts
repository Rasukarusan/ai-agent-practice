import { Memory } from "mem0ai/oss";

interface MemoryInitConfig {
  openaiApiKey: string;
  llmModel?: string;
  embeddingModel?: string;
  historyDbPath?: string;
}

let memoryInstance: Memory | null = null;

export async function initMemory(config: MemoryInitConfig): Promise<Memory> {
  if (memoryInstance) return memoryInstance;

  memoryInstance = new Memory({
    version: "v1.1",
    llm: {
      provider: "openai",
      config: {
        apiKey: config.openaiApiKey,
        model: config.llmModel ?? "gpt-4.1-nano",
      },
    },
    embedder: {
      provider: "openai",
      config: {
        apiKey: config.openaiApiKey,
        model: config.embeddingModel ?? "text-embedding-3-small",
      },
    },
    historyDbPath: config.historyDbPath ?? "memory.db",
  });

  return memoryInstance;
}

export async function searchMemories(
  memory: Memory,
  query: string,
  userId: string,
): Promise<string> {
  const result = await memory.search(query, { userId });
  if (!result?.results || result.results.length === 0) return "";

  return result.results
    .map(
      (r) =>
        `- ${r.memory}${r.score ? ` (関連度: ${r.score.toFixed(2)})` : ""}`,
    )
    .join("\n");
}

export async function saveMemory(
  memory: Memory,
  messages: Array<{ role: string; content: string }>,
  userId: string,
): Promise<void> {
  await memory.add(messages, { userId });
}
