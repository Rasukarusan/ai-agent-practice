# LLMトークンストリーミング実装計画書

## 概要

LangGraph の `stream_mode="messages"` を使い、LLMの出力トークンをリアルタイムにstderrへ表示する。
現在 OpenAI SDK を直接使っているLLM呼び出しを `@langchain/openai` の `ChatOpenAI` に移行し、
LangGraph のストリーミング基盤に乗せる。

## 現状

- LLM呼び出し: OpenAI SDK (`client.chat.completions.create / parse`) を直接使用
- グラフ実行: `graph.invoke()` で最終結果のみ取得
- 進捗表示: `BaseCallbackHandler` でノード開始/完了を表示（トークン単位のストリーミングなし）

## ゴール

各ノード内のLLM応答がトークン単位でリアルタイム表示される:

```
[0.0s] エージェント開始
[0.0s] プラン作成中...
[0.5s] [stream] {"subtasks":["ログイン手順を調べ...    ← トークンが流れる
[1.2s] プラン作成完了 (3個のサブタスク)
[1.3s] [1/3] 開始: ログイン手順を調べる
[1.3s] [1/3] ツール選択: search_xyz_manual
[2.5s] [1/3] search_xyz_manual("ログイン") -> 3件
[2.5s] [1/3] 回答作成中...
[2.6s] [stream] ログイン手順は以下の通りです...      ← トークンが流れる
[3.5s] [1/3] 回答作成完了
```

---

## 変更対象ファイル

| ファイル | 変更内容 |
|---|---|
| `package.json` | `@langchain/openai` 追加 |
| `src/agent.ts` | OpenAI SDK → ChatOpenAI に移行、`stream()` 導入 |
| `src/models.ts` | Tool 型を ChatOpenAI 互換に変更 |
| `src/index.ts` | ツール定義を ChatOpenAI 形式に合わせる |
| `src/cost_tracker.ts` | ChatOpenAI のトークン使用量取得に対応 |
| `src/progress.ts` | トークンストリーミング用メソッド追加 |
| `src/progress-handler.ts` | 変更なし（既存のノード開始/完了表示はそのまま） |

---

## 実装ステップ

### Step 1: `@langchain/openai` のインストール

```bash
npm install @langchain/openai
```

### Step 2: ChatOpenAI インスタンスの作成（`agent.ts`）

**Before:**
```typescript
this.client = new OpenAI({
  apiKey: this.settings.openai_api_key,
  baseURL: this.settings.openai_api_base,
});
```

**After:**
```typescript
import { ChatOpenAI } from "@langchain/openai";

this.chatModel = new ChatOpenAI({
  model: this.settings.openai_model,
  apiKey: this.settings.openai_api_key,
  configuration: { baseURL: this.settings.openai_api_base },
  temperature: 0,
  seed: 0,  // ChatOpenAI は model_kwargs で渡す必要があるかも（要確認）
});
```

### Step 3: 各ノード関数の移行

#### 3a. `createPlan` — 構造化出力（`parse` → `withStructuredOutput`）

**Before:**
```typescript
const response = await this.client.chat.completions.parse({
  model: this.settings.openai_model,
  messages,
  response_format: zodResponseFormat(planSchema, "plan"),
  temperature: 0,
  seed: 0,
});
const plan = response.choices[0].message.parsed;
```

**After:**
```typescript
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

const structured = this.chatModel.withStructuredOutput(planSchema);
const plan = await structured.invoke([
  new SystemMessage(this.prompts.plannerSystemPrompt),
  new HumanMessage(userPrompt),
]);
// plan は zodスキーマのパース済みオブジェクト
```

#### 3b. `reflectSubtask` — 構造化出力

`createPlan` と同じパターン。`reflectionResultSchema` を `withStructuredOutput` に渡す。

**注意:** `reflectSubtask` はメッセージ履歴（`state.messages`）を使う。
`ChatCompletionMessageParam[]` → LangChain の `BaseMessage[]` への変換が必要。
ヘルパー関数 `toLangChainMessages(messages)` を作る。

#### 3c. `selectTools` — ツール呼び出し（`tools` → `bindTools`）

**Before:**
```typescript
const response = await this.client.chat.completions.create({
  model: this.settings.openai_model,
  messages,
  tools: this.tools.map(({ type, function: fn }) => ({ type, function: fn })),
});
const toolCalls = response.choices[0].message.tool_calls;
```

**After:**
```typescript
const modelWithTools = this.chatModel.bindTools(this.tools);
const response = await modelWithTools.invoke(langchainMessages);
// response.tool_calls に LangChain 形式のツール呼び出しが入る
```

**影響:**
- `executeTools` もツール呼び出し結果の形式が変わる
- `state.messages` の型を `ChatCompletionMessageParam[]` → `BaseMessage[]` に変更する必要がある

#### 3d. `createSubtaskAnswer` / `createAnswer` — 通常のLLM呼び出し

**Before:**
```typescript
const response = await this.client.chat.completions.create({ ... });
const answer = response.choices[0].message.content ?? "";
```

**After:**
```typescript
const response = await this.chatModel.invoke(langchainMessages);
const answer = response.content as string;
```

### Step 4: メッセージ型の移行

`AgentSubGraphState` の `messages` を LangChain の `BaseMessage[]` に変更:

```typescript
import { BaseMessage } from "@langchain/core/messages";

const AgentSubGraphState = Annotation.Root({
  // ...
  messages: Annotation<BaseMessage[]>(),
  // LangGraph は messagesStateReducer を提供しているのでそれも検討
});
```

**ヘルパー関数** `toLangChainMessages` / `toOpenAIMessages` が必要になる場合がある
（特に tool_calls のフォーマット差異）。

### Step 5: Tool 型の変更（`models.ts`）

**Before:**
```typescript
export type Tool = ChatCompletionFunctionTool & {
  invoke: (args: string) => Promise<SearchOutput[]>;
};
```

**After (案):**
LangChain の `StructuredTool` を使うか、`bindTools` に渡せる形式に合わせる。
`bindTools` は OpenAI 形式のツール定義もそのまま受け付けるため、
既存の定義を維持しつつ `invoke` だけ分離する方法も可能:

```typescript
// ツール定義（LLMに渡す部分）と実行関数を分離
export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: object };
}
export type ToolExecutor = (args: string) => Promise<SearchOutput[]>;
```

### Step 6: ストリーミングの実装（`runAgent` / `executeSubgraph`）

`invoke()` を `stream()` に変更し、`stream_mode="messages"` でトークンを受け取る:

```typescript
async runAgent(question: string): Promise<AgentResult> {
  this.progress.start(question);
  const app = this.createGraph();

  let finalState: typeof AgentState.State | undefined;

  for await (const [message, metadata] of await app.stream(
    { question },
    { streamMode: "messages", callbacks: [new GraphProgressHandler(...)] },
  )) {
    // metadata.langgraph_node でどのノードからのトークンか判別
    if (message.type === "AIMessageChunk") {
      this.progress.streamToken(metadata.langgraph_node, message.content);
    }
  }

  // stream 完了後に最終状態を取得する方法は要調査
  // streamMode を ["messages", "values"] の配列で渡せる可能性あり
}
```

**課題:** `stream_mode="messages"` だけだと最終状態を取れない。
`streamMode: ["messages", "values"]` で両方受け取れるか要調査。
取れない場合は `invoke()` のまま `BaseCallbackHandler` でトークンイベントを受ける代替案を検討。

### Step 7: CostTracker の対応（`cost_tracker.ts`）

ChatOpenAI はレスポンスの `response_metadata.tokenUsage` でトークン数を返す。
現在の `parse` ラップ方式は使えなくなるため、以下のいずれかに変更:

**案A: LangChain のコールバックで集計**
```typescript
class CostCallbackHandler extends BaseCallbackHandler {
  handleLLMEnd(output) {
    // output.llmOutput.tokenUsage から集計
  }
}
```

**案B: ChatOpenAI の呼び出し後に手動集計**
```typescript
const response = await this.chatModel.invoke(messages);
this.costTracker.add(response.response_metadata.tokenUsage);
```

案A の方がロジックコードを汚さない（BaseCallbackHandler の方針と一致）。

### Step 8: progress.ts にストリーミング表示を追加

```typescript
streamToken(nodeName: string, content: string) {
  // 改行なしで stderr に書き出す（トークンを連続表示）
  process.stderr.write(content);
}
```

ノード切り替わり時に改行を入れる処理も必要。

---

## 注意事項・リスク

### メッセージ型の不整合
最大のリスク。OpenAI SDK の `ChatCompletionMessageParam` と LangChain の `BaseMessage` は
フォーマットが異なる（特に `tool_calls` / `ToolMessage` まわり）。
`state.messages` の型を変えるとサブグラフ全体に影響が及ぶ。

### 構造化出力のストリーミング
`withStructuredOutput` 使用時のストリーミングは JSON の部分文字列が流れるため、
表示が見づらい可能性がある。`createPlan` / `reflectSubtask` のトークンストリーミングは
省略する（表示しない）のが現実的。

### embeddings は対象外
`src/opensearch.ts` の `getEmbedding()` は OpenAI SDK 直接呼び出しのまま。
ストリーミング不要なので移行対象外。

### `seed` パラメータ
ChatOpenAI が `seed` パラメータをサポートするか要確認。
`model_kwargs: { seed: 0 }` で渡せる可能性あり。

### CostTracker の `parse` ラップ
現在は `parse` のみラップし `create` はラップしない設計。
ChatOpenAI 移行後はこの制約がなくなるが、集計方式自体の変更が必要。

---

## 移行順序（推奨）

影響範囲を最小化するため、段階的に移行する:

1. **`@langchain/openai` インストール + ChatOpenAI 作成**（Step 1-2）
2. **`createAnswer`（最もシンプルなノード）を ChatOpenAI に移行**（Step 3d）
   - ここで LangChain メッセージ変換の勘所を掴む
3. **`createPlan` を移行**（構造化出力パターン）（Step 3a）
4. **`selectTools` + `executeTools` を移行**（ツール呼び出しパターン）（Step 3c）
   - `state.messages` の型変更が必要 → 影響が最も大きい
5. **`createSubtaskAnswer` / `reflectSubtask` を移行**（Step 3b, 3d）
6. **CostTracker をコールバック方式に変更**（Step 7）
7. **`runAgent` にストリーミングを導入**（Step 6）
8. **`executeSubgraph` にストリーミングを導入**（Step 6）
