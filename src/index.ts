import { HelpDeskAgent } from "./agent.js";
import { loadSettings } from "./config.js";

const main = async () => {
  const args = process.argv.slice(2);
  const query = args.join(" ");

  if (!query) {
    console.error("Usage: tsx src/index.ts <質問>");
    process.exit(1);
  }

  const settings = loadSettings();
  const agent = new HelpDeskAgent(settings);
  await agent.runAgent(query);
};

main();
