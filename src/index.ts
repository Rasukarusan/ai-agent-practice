import { HelpDeskAgent } from "./agent.js";
import { loadSettings } from "./config.js";
import { searchDocuments } from "./opensearch.js";

const main = async () => {
  const args = process.argv.slice(2);
  const query = args.join(" ");

  if (!query) {
    console.error("Usage: tsx src/index.ts <質問>");
    process.exit(1);
  }

  const tools = [
    {
      type: "function" as const,
      function: {
        name: "search",
        description: "ドキュメントを検索する",
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
        console.log("search called with:", query);
        return await searchDocuments(query);
      },
    },
  ];

  const settings = loadSettings();
  const agent = new HelpDeskAgent(settings, tools);
  await agent.runAgent(query);
};

main();
