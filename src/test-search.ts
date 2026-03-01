import { searchDocuments } from "./opensearch.js";

async function main() {
  const query = process.argv.slice(2).join(" ") || "ログイン方法";

  console.log(`検索クエリ: "${query}"\n`);

  const results = await searchDocuments(query);

  if (results.length === 0) {
    console.log("検索結果: 0件");
    return;
  }

  console.log(`検索結果: ${results.length}件\n`);
  for (const doc of results) {
    console.log(`--- ${doc.file_name} ---`);
    console.log(doc.content);
    console.log();
  }
}

main().catch((err) => {
  console.error("Search failed:", err);
  process.exit(1);
});
