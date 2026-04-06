import { randomUUID } from "node:crypto";
import { HelpDeskAgent } from "./agent.js";
import { prompt, setupEscListener } from "./cli.js";
import { loadSettings } from "./config.js";
import { initMemory } from "./memory.js";
import type { Subtask } from "./models.js";
import { createTools } from "./tools.js";

const main = async () => {
  const args = process.argv.slice(2);
  const query = args.join(" ");

  if (!query) {
    console.error("Usage: tsx src/index.ts <質問>");
    process.exit(1);
  }

  const settings = loadSettings();
  const tools = createTools();

  // mem0 メモリの初期化
  const openaiApiKey = process.env.OPENAI_API_KEY;
  const memory = openaiApiKey
    ? await initMemory({
        openaiApiKey,
        llmModel: process.env.MEM0_LLM_MODEL,
        embeddingModel: process.env.MEM0_EMBEDDING_MODEL,
        historyDbPath: process.env.MEM0_HISTORY_DB_PATH,
      })
    : undefined;

  if (memory) {
    console.error("🧠 mem0 メモリが有効です");
  }

  const userId = process.env.MEM0_USER_ID ?? "default";
  const agent = await new HelpDeskAgent(settings, tools, undefined, memory).init();
  const originalQuestion = query;
  let currentQuestion = query;
  let previousSubtasks: Subtask[] = [];

  while (true) {
    const threadId = randomUUID();
    const abortController = new AbortController();
    const cleanup = setupEscListener(() => abortController.abort());

    const result = await agent.runAgent({
      question: currentQuestion,
      threadId,
      signal: abortController.signal,
      previousSubtaskResults:
        previousSubtasks.length > 0 ? previousSubtasks : undefined,
      userId,
    });

    cleanup();

    if ("aborted" in result) {
      previousSubtasks = [...previousSubtasks, ...result.completedSubtasks];
      console.error(
        "\n⏸  中断しました。指示を入力してください（空Enterで再開、qで終了）:",
      );
      const input = await prompt("> ");
      if (input === "q") break;
      currentQuestion = input
        ? `${originalQuestion}\n追加の質問: ${input}`
        : originalQuestion;
      continue;
    }
    break;
  }
};

main();
