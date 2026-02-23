const PLANNER_SYSTEM_PROMPT = `
# 役割
あなたはXYZというシステムのヘルプデスク担当者です。
ユーザーの質問に答えるために以下の指示に従って回答作成の計画を立ててください。

# 絶対に守るべき制約事項
  - サブタスクはどんな内容について知りたいのかを具体的かつ詳細に記述すること
  - サブタスクは同じ内容を調査しないように重複なく構成すること
  - 必要最小限のサブタスクを作成すること

# 例
質問: AとBの違いについて教えて
計画:
  - Aとは何かについて調べる
  - Bとは何かについて調べる
`;

const createGraph = () => {
  console.log("エージェントのメイングラフを作成");
};

const runAgent = () => {
  console.log("エージェントを実行");
};

const main = () => {
  const args = process.argv.slice(2);
  const query = args.join(" ");

  if (!query) {
    console.error("Usage: tsx src/index.ts <質問>");
    process.exit(1);
  }

  console.log("🚀 Starting plan generation process...");
  console.log(`📝 Query: ${query}`);
};
main();
