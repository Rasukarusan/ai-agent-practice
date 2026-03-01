import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import * as readline from "readline";
import { HelpDeskAgent } from "./agent.js";
import { loadSettings } from "./config.js";
import { searchDocuments, searchDocumentsByKeyword } from "./opensearch.js";

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

  const tools = [
    {
      type: "function" as const,
      function: {
        name: "search_xyz_manual",
        description:
          "XYZシステムのドキュメントを調査する関数。エラーコードや固有名詞が質問に含まれる場合は、この関数を使ってキーワード検索を行う。",
        parameters: {
          type: "object",
          properties: {
            keywords: {
              type: "string",
              description: "全文検索用のキーワード",
            },
          },
          required: ["keywords"],
        },
      },
      invoke: async (argsJson: string) => {
        const { keywords } = JSON.parse(argsJson);
        // console.log("search_xyz_manual called with:", keywords);
        return await searchDocumentsByKeyword(keywords);
      },
    },
    {
      type: "function" as const,
      function: {
        name: "search_xyz_qa",
        description: "XYZシステムの過去の質問回答ペアを検索する関数。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "検索クエリ" },
          },
          required: ["query"],
        },
      },
      invoke: async (argsJson: string) => {
        const { query } = JSON.parse(argsJson);
        console.log("search_xyz_qa called with:", query);
        return await searchDocuments(openai, query);
      },
    },
  ];

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

function setupEscListener(onEsc: () => void): () => void {
  if (!process.stdin.isTTY) return () => {};

  process.stdin.setRawMode(true);
  process.stdin.resume();

  const handler = (key: Buffer) => {
    if (key[0] === 0x1b && key.length === 1) {
      onEsc();
    }
    if (key[0] === 0x03) {
      process.exit();
    }
  };

  process.stdin.on("data", handler);

  return () => {
    process.stdin.removeListener("data", handler);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  };
}

function prompt(message: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

main();
