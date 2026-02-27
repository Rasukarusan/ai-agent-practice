import OpenAI from "openai";
import { loadSettings } from "./config.js";
import { documentExists, indexDocument, setupIndex } from "./opensearch.js";

const sampleDocuments = [
  {
    file_name: "xyz-overview.md",
    content:
      "XYZシステムは社内のヘルプデスク業務を管理するためのシステムです。チケットの作成、割り当て、ステータス管理が行えます。",
  },
  {
    file_name: "xyz-login.md",
    content:
      "XYZシステムへのログインは社内SSOを使用します。初回ログイン時はIT部門への申請が必要です。パスワードリセットはSSOポータルから行えます。",
  },
  {
    file_name: "xyz-ticket.md",
    content:
      "チケットの作成方法：ダッシュボードから「新規チケット」ボタンをクリックし、件名・説明・優先度を入力して送信します。添付ファイルも追加できます。",
  },
];

async function main() {
  const settings = loadSettings();
  const openai = new OpenAI({
    apiKey: settings.openai_api_key,
    baseURL: settings.openai_api_base,
  });

  await setupIndex();

  console.log("Seeding sample documents (with embeddings)...");
  for (const doc of sampleDocuments) {
    if (await documentExists(doc.file_name)) {
      console.log(`  Skipped (already exists): ${doc.file_name}`);
      continue;
    }
    await indexDocument(openai, doc);
    console.log(`  Indexed: ${doc.file_name}`);
  }
  console.log("Done.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Failed to setup index:", err);
    process.exit(1);
  });
