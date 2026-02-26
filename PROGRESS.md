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
- [x] `AgentSubGraphState` — サブグラフの State 定義（`subtaskAnswer`, `reflectionResults` 追加済み）
- [x] `HelpDeskAgent` クラスの骨組み（constructor, client, tools, toolMap）
- [x] `createPlan` — 計画生成ノード（Structured Output で `planSchema` を使用）
- [x] `shouldContinueExecSubtasks` — `Send` でサブタスクを並列ディスパッチ
- [x] `executeSubgraph` — サブグラフの呼び出し
- [x] `createSubGraph` — サブグラフのグラフ定義
- [x] `selectTools` — ツール選択ノード（初回/リトライでプロンプト切り替え）
- [x] `executeTools` — ツール実行ノード（`toolCall.type !== "function"` のガード付き）
- [x] `createGraph` — メイングラフのグラフ定義
- [x] `runAgent` — エントリーポイント

### 実装済み（今回のセッション）

- [x] `createSubtaskAnswer` — サブタスク回答生成ノード
- [x] `reflectSubtask` — サブタスクの内省ノード（Structured Output で `reflectionResultSchema` 使用）
- [x] `shouldContinueExecSubtaskFlow` — リフレクション結果による条件分岐
- [x] サブグラフのループ接続（`addConditionalEdges` で `reflect_subtask` → `select_tools` or `END`）
- [x] `executeSubgraph` の戻り値を `Subtask` 型で返すようにする
- [x] `executeTools` の return 漏れ修正 + `JSON.stringify` 修正
- [x] `createAnswer` — 最終回答生成ノード
- [x] メイングラフに `create_answer` ノード追加 + `create_plan → END` のエッジ削除

### 未実装（次にやること）

- [ ] `runAgent` の戻り値を `AgentResult` 型にする
- [ ] ツールの本実装（`index.ts` の仮ツールを実際の検索ツールに置き換える）

## Claude Code への指示（振る舞いルール）

- 実装はユーザーが行う。Claude Code はコードの内容を提示するだけで、直接ファイルを編集しない
- 1つのステップが終わるごとに、**現時点で実行したらどうなるか** と **何ができるようになったか** を必ず書くこと
- 元の Python コード（`genai-agent-advanced-book/chapter4/src/agent.py`）を参照して正確に移植すること

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
