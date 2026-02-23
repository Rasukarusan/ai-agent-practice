# Python → TypeScript 書き直し 進捗メモ

## 概要

`genai-agent-advanced-book/chapter4/src/agent.py`（LangGraphベースのヘルプデスクエージェント）を TypeScript に書き直している。

## 元のPythonファイル一覧

| ファイル | 役割 |
|---|---|
| `chapter4/src/agent.py` | メインエージェント（LangGraph） |
| `chapter4/src/models.py` | Pydanticモデル |
| `chapter4/src/configs.py` | 環境変数設定 |
| `chapter4/src/custom_logger.py` | ロガー |
| `chapter4/src/prompts.py` | プロンプトテンプレート |

## TypeScriptプロジェクト

場所: `/Users/tanakanaoto/Documents/github/ai-agent-practice`

## 完了したファイル

### 1. `src/config.ts` — 完了
- Zodで環境変数をバリデーション
- `dotenv` は不要（`tsx --env-file=.env` で読み込み済み）

### 2. `src/custom_logger.ts` — 完了
- 自前の軽量ロガー（debug/info/error）

### 3. `src/prompt.ts` — 完了
- プロンプト定数 + `HelpDeskAgentPrompts` クラス
- Python版をそのまま移植

### 4. `src/models.ts` — 完了
- Zodスキーマ + 型定義
- `planSchema`, `reflectionResultSchema` は OpenAI Structured Output の `response_format` で使用
- `SearchOutput.from_hit()` / `from_point()` は未移植（Qdrant依存、必要時に追加）

### 5. `src/cost_tracker.ts` — 完了（独自追加）
- OpenAI APIのトークン使用量・コストを記録するユーティリティ

### 6. `src/index.ts` — 完了（仮実装）
- エントリーポイント
- 仮のツール定義（`search`）を `HelpDeskAgent` に渡している

### 7. `src/agent.ts` — 途中

## agent.ts の進捗詳細

### エージェントの全体フロー（メイングラフ）
```
START → create_plan → [Send で並列] execute_subtasks → create_answer → END
```

### サブグラフのフロー
```
START → select_tools → execute_tools → create_subtask_answer → reflect_subtask
                ↑                                                      ↓
                └──────────── 未完了 & 回数 < 3 なら戻る ──────────────┘
```

### 実装済み

- [x] `AgentState` — メイングラフの State 定義
- [x] `AgentSubGraphState` — サブグラフの State 定義（最小限。`subtaskAnswer`, `toolResults`, `reflectionResults` はまだ追加していない）
- [x] `HelpDeskAgent` クラスの骨組み（constructor, client, tools, toolMap）
- [x] `createPlan` — 計画生成ノード（Structured Output で `planSchema` を使用）
- [x] `shouldContinueExecSubtasks` — `Send` でサブタスクを並列ディスパッチ
- [x] `executeSubgraph` — サブグラフの呼び出し
- [x] `createSubGraph` — サブグラフのグラフ定義
- [x] `selectTools` — ツール選択ノード（初回/リトライでプロンプト切り替え）
- [x] `executeTools` — ツール実行ノード（`toolCall.type !== "function"` のガード付き）
- [x] `createGraph` — メイングラフのグラフ定義
- [x] `runAgent` — エントリーポイント

### 未実装（次にやること）

- [ ] `createSubtaskAnswer` — サブタスク回答生成ノード
  - `messages` を渡してLLMにテキスト回答を生成させる
  - `AgentSubGraphState` に `subtaskAnswer: Annotation<string>()` を追加する
- [ ] `reflectSubtask` — サブタスクの内省（リフレクション）ノード
  - Structured Output で `reflectionResultSchema` を使用
  - `AgentSubGraphState` に `reflectionResults` を追加する
  - `challengeCount` をインクリメント、`isCompleted` を更新
- [ ] `shouldContinueExecSubtaskFlow` — リフレクション結果による条件分岐
  - 完了 or `challengeCount >= MAX_CHALLENGE_COUNT` なら END、そうでなければ `select_tools` に戻る
- [ ] サブグラフの全ノード接続
  - `select_tools → execute_tools → create_subtask_answer → reflect_subtask`
  - `reflect_subtask` から `addConditionalEdges` でループ
- [ ] `executeSubgraph` の戻り値を `Subtask` 型で返すようにする
- [ ] `createAnswer` — 最終回答生成ノード
  - `AgentState` に `lastAnswer: Annotation<string>()` を追加する
- [ ] メイングラフに `create_answer` ノードを追加
- [ ] `runAgent` の戻り値を `AgentResult` 型にする
- [ ] ツールの本実装（`index.ts` の仮ツールを実際の検索ツールに置き換える）
- [ ] `selectTools` で `this.tools` をそのまま渡すとエラーになる問題の修正済み（`openaiTools` として `type` と `function` だけ抽出して渡す）

## 学んだこと・注意点

### LangGraph.js と Python版の対応

| Python | TypeScript |
|---|---|
| `TypedDict` | `Annotation.Root({...})` |
| `Annotated[Sequence[X], operator.add]` | `Annotation<X[]>({ reducer: (a, b) => [...a, ...b] })` |
| `response_format=Plan` (Pydantic) | `zodResponseFormat(planSchema, "plan")` (Zod) |
| `StateGraph(State)` | `new StateGraph(State)` |
| `Send("node", data)` | `new Send("node", data)` |
| `workflow.compile()` | `workflow.compile()` |
| `add_conditional_edges` | `addConditionalEdges` |

### OpenAI SDK v6 の注意点

- `ChatCompletionMessageToolCall` は `ChatCompletionMessageFunctionToolCall | ChatCompletionMessageCustomToolCall` のユニオン型
- `function` プロパティにアクセスするには `toolCall.type !== "function"` でガードが必要
- ツール定義に `invoke` などの余計なプロパティがあると API エラーになる。渡す前に `type` と `function` だけ抽出する

### addEdge vs addConditionalEdges

- `addEdge` → 固定ルート（必ず次のノードへ）
- `addConditionalEdges` → 関数の戻り値でルートを決定
- `Send` による並列実行は `addConditionalEdges` でのみ可能
- `addNode` と `addEdge` の順番は自由（`compile()` まではただの定義）

## 実行方法

```bash
# 開発実行
pnpm tsx --env-file=.env src/index.ts "AとBの違いについて教えて"

# watchモード
pnpm dev AとBの違いについて教えて
```
