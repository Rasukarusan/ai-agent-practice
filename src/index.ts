import OpenAI from "openai";
import { HelpDeskAgent } from "./agent.js";
import { loadSettings } from "./config.js";
import { searchDocuments, searchDocumentsByKeyword } from "./opensearch.js";

const main = async () => {
  const args = process.argv.slice(2);
  const query = args.join(" ");

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
        console.log("search_xyz_manual called with:", keywords);
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
  await agent.runAgent(query);
};

main();
