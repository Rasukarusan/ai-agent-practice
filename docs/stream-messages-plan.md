# LLMトークンストリーミング実装計画書

## 前提

この計画書はまっさらな状態（`main` ブランチ相当）から始めることを前提とする。
つまり以下のファイル/クラスは存在しない:
- `src/progress.ts`（ProgressReporter）
- `src/progress-handler.ts`（GraphProgressHandler）
- BaseCallbackHandler による進捗表示

現在のコードは `graph.invoke()` で最終結果を受け取り、
`console.log(JSON.stringify(agentResult))` で出力するのみ。

---

## 概要

LangGraph の `stream_mode="messages"` を使い、LLMの出力トークンをリアルタイムに
stderrへ表示する。現在 OpenAI SDK を直接使っているLLM呼び出しを
`@langchain/openai` の `ChatOpenAI` に移行し、LangGraph のストリーミング基盤に乗せる。

## 現状のアーキテクチャ

```
index.ts
  └─ agent.ts (HelpDeskAgent)
       ├─ OpenAI SDK 直接利用 (client.chat.completions.create / parse)
       ├─ graph.invoke() で最終結果のみ取得
       ├─ CostTracker: parse をモンキーパッチで使用量集計
       └─ 進捗表示: なし（結果のJSON出力のみ）
```

### LLM呼び出し一覧（全5箇所）

| メソッド | SDK メソッド | パターン |
|---|---|---|
| `createPlan` | `parse()` | 構造化出力 (`zodResponseFormat`) |
| `reflectSubtask` | `parse()` | 構造化出力 (`zodResponseFormat`) |
| `selectTools` | `create()` | ツール呼び出し (`tools` パラメータ) |
| `createSubtaskAnswer` | `create()` | 通常のチャット |
| `createAnswer` | `create()` | 通常のチャット |

## ゴール

各ノード内のLLM応答がトークン単位でリアルタイムに stderr 表示される:

```
[createPlan] プラン作成中...
[selectTools] ツール選択中...
[executeTools] search_xyz_manual("ログイン") 実行
[createSubtaskAnswer] ログイン手順は以下の通りです。まず...  ← トークンが流れる
[reflectSubtask] 評価中...
[createAnswer] 最終回答を生成中: まとめると...              ← トークンが流れる
```

構造化出力ノード（`createPlan`, `reflectSubtask`）はJSON断片が流れるだけなので
ストリーミング表示は省略し、テキスト応答ノード（`createSubtaskAnswer`, `createAnswer`）
のみトークンをストリーミング表示する。

---

## 変更対象ファイル

| ファイル | 変更内容 |
|---|---|
| `package.json` | `@langchain/openai` 追加 |
| `src/agent.ts` | OpenAI SDK → ChatOpenAI に移行、`invoke()` → `stream()` |
| `src/models.ts` | Tool 型の整理（ツール定義と実行関数の分離） |
| `src/index.ts` | ツール定義を新しい型に合わせる |
| `src/cost_tracker.ts` | ChatOpenAI のコールバック方式に変更 |

新規作成なし。

---

## 実装ステップ

### Step 1: `@langchain/openai` のインストール

```bash
npm install @langchain/openai
```

### Step 2: ChatOpenAI インスタンスの作成（`agent.ts`）

OpenAI SDK のクライアントを ChatOpenAI に置き換える。

**Before:**
```typescript
import OpenAI from "openai";

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
  modelKwargs: { seed: 0 },
});
```

`OpenAI` のインポートは削除する（`opensearch.ts` の embeddings 用は別途残す）。

### Step 3: メッセージ型の移行

`AgentSubGraphState` の `messages` を LangChain の `BaseMessage[]` に変更する。
これが最も影響範囲の大きい変更。

**Before:**
```typescript
import type { ChatCompletionMessageParam } from "openai/resources";

const AgentSubGraphState = Annotation.Root({
  messages: Annotation<ChatCompletionMessageParam[]>(),
  // ...
});
```

**After:**
```typescript
import { BaseMessage } from "@langchain/core/messages";

const AgentSubGraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>(),
  // ...
});
```

OpenAI SDK 形式のメッセージを手動で組み立てていた箇所を
LangChain のメッセージクラスに置き換える:

```typescript
// Before
messages = [
  { role: "system", content: "..." },
  { role: "user", content: "..." },
];

// After
import { SystemMessage, HumanMessage, AIMessage, ToolMessage } from "@langchain/core/messages";

messages = [
  new SystemMessage("..."),
  new HumanMessage("..."),
];
```

### Step 4: 各ノード関数の移行

#### 4a. `createAnswer` — 通常のLLM呼び出し（最もシンプル）

**Before:**
```typescript
const response = await this.client.chat.completions.create({
  model: this.settings.openai_model,
  messages,
  temperature: 0,
  seed: 0,
});
return { lastAnswer: response.choices[0].message.content ?? "" };
```

**After:**
```typescript
const response = await this.chatModel.invoke(messages);
return { lastAnswer: response.content as string };
```

#### 4b. `createSubtaskAnswer` — 通常のLLM呼び出し + メッセージ履歴更新

**Before:**
```typescript
const response = await this.client.chat.completions.create({ ... });
const subtaskAnswer = response.choices[0].message.content ?? "";
messages.push({ role: "assistant", content: subtaskAnswer });
```

**After:**
```typescript
const response = await this.chatModel.invoke(messages);
const subtaskAnswer = response.content as string;
messages.push(response);  // AIMessage をそのまま追加
```

#### 4c. `createPlan` — 構造化出力

**Before:**
```typescript
const response = await this.client.chat.completions.parse({
  model: this.settings.openai_model,
  messages: [...],
  response_format: zodResponseFormat(planSchema, "plan"),
  temperature: 0,
  seed: 0,
});
const plan = response.choices[0].message.parsed;
```

**After:**
```typescript
const structured = this.chatModel.withStructuredOutput(planSchema);
const plan = await structured.invoke(messages);
// plan は { subtasks: string[] } 型のパース済みオブジェクト
```

#### 4d. `reflectSubtask` — 構造化出力 + メッセージ履歴

```typescript
const structured = this.chatModel.withStructuredOutput(reflectionResultSchema);
const reflectionResult = await structured.invoke(messages);
messages.push(new AIMessage(JSON.stringify(reflectionResult)));
```

#### 4e. `selectTools` — ツール呼び出し

**Before:**
```typescript
const response = await this.client.chat.completions.create({
  model: this.settings.openai_model,
  messages,
  tools: this.tools.map(({ type, function: fn }) => ({ type, function: fn })),
  temperature: 0,
  seed: 0,
});
const toolCalls = response.choices[0].message.tool_calls;
messages.push({ role: "assistant", tool_calls: toolCalls });
```

**After:**
```typescript
const modelWithTools = this.chatModel.bindTools(
  this.tools.map(({ type, function: fn }) => ({ type, function: fn }))
);
const response = await modelWithTools.invoke(messages);
// response.tool_calls は LangChain 形式: { name, args, id, type }[]
messages.push(response);  // AIMessage をそのまま追加
```

#### 4f. `executeTools` — ツール実行結果の格納

**Before:**
```typescript
messages.push({
  role: "tool" as const,
  content: JSON.stringify(toolResult),
  tool_call_id: toolCall.id,
});
```

**After:**
```typescript
import { ToolMessage } from "@langchain/core/messages";

messages.push(new ToolMessage({
  content: JSON.stringify(toolResult),
  tool_call_id: toolCall.id,
}));
```

LangChain の `AIMessage.tool_calls` は OpenAI SDK の `tool_calls` と
フォーマットが異なる点に注意:

```typescript
// OpenAI SDK
toolCall.function.name       // ツール名
toolCall.function.arguments  // JSON文字列

// LangChain
toolCall.name   // ツール名
toolCall.args   // パース済みオブジェクト（JSON.stringify が必要）
```

### Step 5: Tool 型の整理（`models.ts`）

`bindTools` は OpenAI 形式のツール定義をそのまま受け付けるため、
大きな変更は不要。ただし `invoke` プロパティを分離しておくと見通しがよい:

```typescript
// Before
export type Tool = ChatCompletionFunctionTool & {
  invoke: (args: string) => Promise<SearchOutput[]>;
};

// After
import type { ChatCompletionTool } from "openai/resources";

export interface AgentTool {
  definition: ChatCompletionTool;
  invoke: (args: string) => Promise<SearchOutput[]>;
}
```

`index.ts` のツール定義もこれに合わせる。

### Step 6: ストリーミングの実装

`graph.invoke()` を `graph.stream()` に変更し、トークンを受け取る。

```typescript
async runAgent(question: string): Promise<AgentResult> {
  const app = this.createGraph();

  // streamMode: ["messages", "values"] で
  // トークンストリームと最終状態の両方を受け取る
  const stream = await app.stream(
    { question },
    { streamMode: ["messages", "values"] },
  );

  let result: typeof AgentState.State | undefined;

  for await (const event of stream) {
    if (Array.isArray(event)) {
      // streamMode: "messages" のイベント: [AIMessageChunk, metadata]
      const [chunk, metadata] = event;
      const nodeName = metadata.langgraph_node;

      // 構造化出力ノードはスキップ（JSONの断片なので表示しても意味がない）
      if (nodeName === "create_plan" || nodeName === "reflect_subtask") continue;

      // テキスト応答ノードのトークンを stderr に表示
      if (typeof chunk.content === "string" && chunk.content) {
        process.stderr.write(chunk.content);
      }
    } else {
      // streamMode: "values" のイベント: 状態の更新
      result = event;
    }
  }

  if (!result) throw new Error("No result from stream");

  const agentResult: AgentResult = {
    question,
    plan: { subtasks: result.plan },
    subtasks: result.subtaskResults,
    answer: result.lastAnswer,
  };
  console.log(JSON.stringify(agentResult, null, 2));
  this.costTracker.printReport(this.settings.openai_model);
  return agentResult;
}
```

**サブグラフのストリーミング:**
`executeSubgraph` 内でもサブグラフを `stream()` で実行すれば
サブタスク実行中のトークンもストリーミング可能。
ただし LangGraph はサブグラフのストリームイベントを親に自動伝播するため、
親の `stream()` だけで十分な可能性がある（要検証）。

### Step 7: CostTracker の対応

現在の `parse` モンキーパッチ方式は ChatOpenAI では使えないため、
LangChain のコールバックを使う方式に変更する。

```typescript
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";

export class CostCallbackHandler extends BaseCallbackHandler {
  name = "CostCallbackHandler";
  private usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, apiCalls: 0 };

  handleLLMEnd(output: any) {
    const tokenUsage = output?.llmOutput?.tokenUsage;
    if (tokenUsage) {
      this.usage.promptTokens += tokenUsage.promptTokens ?? 0;
      this.usage.completionTokens += tokenUsage.completionTokens ?? 0;
      this.usage.totalTokens += tokenUsage.totalTokens ?? 0;
    }
    this.usage.apiCalls += 1;
  }

  printReport(model: string) {
    // 既存の printReport と同じロジック
  }
}
```

使い方:
```typescript
const costHandler = new CostCallbackHandler();
const stream = await app.stream(
  { question },
  {
    streamMode: ["messages", "values"],
    callbacks: [costHandler],
  },
);
// ... stream 処理 ...
costHandler.printReport(this.settings.openai_model);
```

### Step 8: 不要コードの削除

- `openai` パッケージのインポートを `agent.ts` から削除
  （`opensearch.ts` の embeddings 用は残す）
- `zodResponseFormat` のインポートを削除
- `ChatCompletionMessageParam` 型のインポートを削除
- 旧 `CostTracker` の `wrap()` メソッドを削除

---

## 注意事項・リスク

### 1. メッセージ型の変換（最大のリスク）

OpenAI SDK の `ChatCompletionMessageParam` と LangChain の `BaseMessage` は
フォーマットが異なる。特に:

- `tool_calls` の構造が違う（LangChain は `args` がパース済みオブジェクト）
- `role: "tool"` → `ToolMessage` クラス
- `role: "assistant"` + `tool_calls` → `AIMessage` の `tool_calls` プロパティ

`state.messages` の型変更はサブグラフ全体に波及するため、
Step 3-4 をまとめて一気に移行する必要がある。

### 2. `streamMode: ["messages", "values"]` の両立

トークンストリームと最終状態を同時に取得する方法が
LangGraph.js でサポートされているか要検証。
サポートされていない場合は:
- `streamMode: "messages"` でトークン表示
- 別途 `getState()` で最終状態を取得

### 3. サブグラフのストリームイベント伝播

LangGraph がサブグラフ（`executeSubgraph` 内で作成）のストリームイベントを
親グラフに自動伝播するかどうか要検証。
伝播しない場合はサブグラフ側でも明示的にストリーミング処理が必要。

### 4. embeddings は対象外

`src/opensearch.ts` の `getEmbedding()` は OpenAI SDK 直接呼び出しのまま。
ストリーミング不要なので移行対象外。`openai` パッケージ自体は残す。

### 5. `seed` パラメータ

ChatOpenAI が `seed` をサポートするか要確認。
`modelKwargs: { seed: 0 }` で渡せる可能性あり。
再現性が不要なら省略も可。

---

## 移行順序（推奨）

メッセージ型の変更が全体に波及するため、段階的移行は困難。
**一括移行**を推奨する:

1. **`@langchain/openai` インストール**（Step 1）
2. **ChatOpenAI インスタンス作成 + 全ノード関数の移行**（Step 2-4）
   - メッセージ型の変更と全ノードの移行を同時に行う
   - コンパイルが通るまで一気に進める
3. **Tool 型の整理 + `index.ts` の修正**（Step 5）
4. **CostTracker をコールバック方式に変更**（Step 7）
5. **`invoke()` → `stream()` への切り替え**（Step 6）
6. **不要コードの削除**（Step 8）
7. **動作確認 + サブグラフのストリーム伝播検証**
