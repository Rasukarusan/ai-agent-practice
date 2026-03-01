import { randomUUID } from "node:crypto";
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
  const tools = createTools();
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
