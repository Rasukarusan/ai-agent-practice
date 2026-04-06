import { initMemory } from "./memory.js";

const main = async () => {
  const openaiApiKey = process.env.OPENAI_API_KEY;
  if (!openaiApiKey) {
    console.error("OPENAI_API_KEY が設定されていません");
    process.exit(1);
  }

  const memory = await initMemory({
    openaiApiKey,
    llmModel: process.env.MEM0_LLM_MODEL,
    embeddingModel: process.env.MEM0_EMBEDDING_MODEL,
    historyDbPath: process.env.MEM0_HISTORY_DB_PATH,
  });

  const args = process.argv.slice(2);
  const command = args[0] ?? "list";
  const userId = process.env.MEM0_USER_ID ?? "default";

  switch (command) {
    case "list": {
      const result = await memory.getAll({ userId });
      if (!result?.results?.length) {
        console.log("メモリが見つかりませんでした");
        return;
      }
      console.log(`\n📋 ${userId} のメモリ一覧（${result.results.length}件）\n`);
      for (const item of result.results) {
        console.log(`  ID: ${item.id}`);
        console.log(`  内容: ${item.memory}`);
        if (item.createdAt) console.log(`  作成: ${item.createdAt}`);
        if (item.updatedAt) console.log(`  更新: ${item.updatedAt}`);
        console.log();
      }
      break;
    }
    case "search": {
      const query = args.slice(1).join(" ");
      if (!query) {
        console.error("Usage: memory-viewer search <クエリ>");
        process.exit(1);
      }
      const result = await memory.search(query, { userId });
      if (!result?.results?.length) {
        console.log("関連するメモリが見つかりませんでした");
        return;
      }
      console.log(`\n🔍 「${query}」の検索結果（${result.results.length}件）\n`);
      for (const item of result.results) {
        console.log(`  ID: ${item.id}`);
        console.log(`  内容: ${item.memory}`);
        if (item.score) console.log(`  関連度: ${item.score.toFixed(3)}`);
        console.log();
      }
      break;
    }
    case "history": {
      const memoryId = args[1];
      if (!memoryId) {
        console.error("Usage: memory-viewer history <memory-id>");
        process.exit(1);
      }
      const history = await memory.history(memoryId);
      if (!history?.length) {
        console.log("履歴が見つかりませんでした");
        return;
      }
      console.log(`\n📜 メモリ ${memoryId} の履歴（${history.length}件）\n`);
      for (const entry of history) {
        console.log(` `, entry);
      }
      break;
    }
    case "delete": {
      const memoryId = args[1];
      if (!memoryId) {
        console.error("Usage: memory-viewer delete <memory-id>");
        process.exit(1);
      }
      const result = await memory.delete(memoryId);
      console.log(result.message);
      break;
    }
    case "reset": {
      await memory.deleteAll({ userId });
      console.log(`${userId} のメモリをすべて削除しました`);
      break;
    }
    default:
      console.log(`Usage: memory-viewer <command>

コマンド:
  list              メモリ一覧を表示
  search <クエリ>   メモリを検索
  history <id>      メモリの変更履歴を表示
  delete <id>       メモリを削除
  reset             すべてのメモリを削除`);
  }
};

main();
