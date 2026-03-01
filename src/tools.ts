import type OpenAI from "openai";
import type { Tool } from "./models.js";
import { searchDocuments, searchDocumentsByKeyword } from "./opensearch.js";

export function createTools(openai: OpenAI): Tool[] {
  return [
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
}
