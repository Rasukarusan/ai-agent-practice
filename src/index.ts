import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { HelpDeskAgent } from "./agent.js";
import { prompt, setupEscListener } from "./cli.js";
import { loadSettings } from "./config.js";
import { createTools } from "./tools.js";

const main = async () => {
  const args = process.argv.slice(2);
  let query = args.join(" ");

  if (!query) {
    console.error("Usage: tsx src/index.ts <質問>");
    process.exit(1);
  }

  const settings = loadSettings();
  const openai = new OpenAI({
    apiKey: settings.openai_api_key,
    baseURL: settings.openai_api_base,
  });

  const tools = createTools(openai);
  const agent = new HelpDeskAgent(settings, tools);
  const threadId = randomUUID();
  let isResume = false;

  while (true) {
    const abortController = new AbortController();
    const cleanup = setupEscListener(() => abortController.abort());

    const result = await agent.runAgent({
      question: query,
      threadId,
      signal: abortController.signal,
      isResume,
    });

    cleanup();

    if (result === "aborted") {
      console.error(
        "\n⏸  中断しました。指示を入力してください（空Enterで再開、qで終了）:",
      );
      const input = await prompt("> ");
      if (input === "q") break;
      query = input || "続けてください";
      isResume = true;
      continue;
    }
    break;
  }
};

main();
