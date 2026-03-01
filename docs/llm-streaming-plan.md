# LLMトークンストリーミング実装計画書

## 前提

- `main` ブランチのまっさらな状態からスタート
- 進捗表示系のクラス（ProgressReporter, GraphProgressHandler 等）は存在しない
- 現状は `graph.invoke()` → `console.log(JSON.stringify(result))` で結果出力のみ

## 現状のLLM呼び出し一覧（全5箇所）

| メソッド | SDK メソッド | パターン | `state.messages` 使用 |
|---|---|---|---|
| `createAnswer` | `create()` | 通常のチャット | **No**（独自にメッセージ構築） |
| `createPlan` | `parse()` | 構造化出力 | **No**（独自にメッセージ構築） |
| `selectTools` | `create()` | ツール呼び出し | **Yes** |
| `executeTools` | — (ツール実行) | — | **Yes** |
| `createSubtaskAnswer` | `create()` | 通常のチャット | **Yes** |
| `reflectSubtask` | `parse()` | 構造化出力 | **Yes** |

**ポイント**: `createAnswer` と `createPlan` は `state.messages` を使わない。
つまりこの2つは **メッセージ型を変えずに** 単独で ChatOpenAI に移行できる。

---

## Step 1: 最小構成でストリーミングを体感する

**ゴール**: `createAnswer`（最終回答生成）の1ノードだけ ChatOpenAI に移行し、
トークンが stderr にリアルタイムに流れるのを確認する。

**変更ファイル**: `package.json`, `src/agent.ts` のみ

### 1-1. `@langchain/openai` をインストール

```bash
npm install @langchain/openai
```

### 1-2. ChatOpenAI インスタンスを追加（既存の OpenAI client は残す）

```typescript
// agent.ts
import { ChatOpenAI } from "@langchain/openai";

export class HelpDeskAgent {
  private client: OpenAI;           // ← 既存のまま残す
  private chatOpenAi: ChatOpenAI;   // ← 追加

  constructor(settings, tools, prompts) {
    // 既存
    this.client = new OpenAI({ ... });
    this.costTracker.wrap(this.client);

    // 追加
    this.chatOpenAi = new ChatOpenAI({
      model: this.settings.openai_model,
      apiKey: this.settings.openai_api_key,
      configuration: { baseURL: this.settings.openai_api_base },
      temperature: 0,
    });
  }
}
```

### 1-3. `createAnswer` だけ ChatOpenAI に変更

```typescript
// Before
private async createAnswer(state: typeof AgentState.State) {
  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: this.prompts.createLastAnswerSystemPrompt },
    { role: "user", content: userPrompt },
  ];
  const response = await this.client.chat.completions.create({
    model: this.settings.openai_model, messages, temperature: 0, seed: 0,
  });
  return { lastAnswer: response.choices[0].message.content ?? "" };
}

// After
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

private async createAnswer(state: typeof AgentState.State) {
  const messages = [
    new SystemMessage(this.prompts.createLastAnswerSystemPrompt),
    new HumanMessage(userPrompt),
  ];
  const response = await this.chatOpenAi.invoke(messages);
  return { lastAnswer: response.content as string };
}
```

他のノード（`createPlan`, `selectTools` 等）は一切変更しない。

### 1-4. `runAgent` を `invoke()` → `stream()` に変更

```typescript
async runAgent(question: string): Promise<AgentResult> {
  const app = this.createGraph();

  const stream = await app.stream(
    { question },
    { streamMode: ["messages", "values"] },
  );

  let result: typeof AgentState.State | undefined;

  for await (const [mode, event] of stream) {
    if (mode === "messages") {
      // [AIMessageChunk, metadata] のタプル
      const [chunk, metadata] = event;
      if (typeof chunk.content === "string" && chunk.content) {
        process.stderr.write(chunk.content);
      }
    } else if (mode === "values") {
      result = event;
    }
  }
  process.stderr.write("\n");

  if (!result) throw new Error("No result from stream");

  const agentResult: AgentResult = { /* 既存通り */ };
  console.log(JSON.stringify(agentResult, null, 2));
  this.costTracker.printReport(this.settings.openai_model);
  return agentResult;
}
```

### 1-5. 確認方法

```bash
npx tsx src/index.ts "ログインできない" 2>stream.log
# stream.log に createAnswer のトークンがリアルタイムに流れていればOK
# stdout には従来通り JSON 結果が出力される
```

### この時点での状態

- `createAnswer` だけトークンがストリームされる
- 他のノードは OpenAI SDK 直接のまま（ストリームされない、壊れもしない）
- CostTracker は `parse` のみ集計（`createAnswer` の分は漏れる — 後で対応）

---

## Step 2: `createPlan` を ChatOpenAI に移行（構造化出力）

**ゴール**: 構造化出力パターンの移行を確認する。
（`createPlan` も `state.messages` を使わないので単独で移行可能）

**変更ファイル**: `src/agent.ts` のみ

```typescript
// Before
const response = await this.client.chat.completions.parse({
  model: this.settings.openai_model,
  messages: [
    { role: "system", content: this.prompts.plannerSystemPrompt },
    { role: "user", content: userPrompt },
  ],
  response_format: zodResponseFormat(planSchema, "plan"),
  temperature: 0, seed: 0,
});
const plan = response.choices[0].message.parsed;

// After
const structured = this.chatOpenAi.withStructuredOutput(planSchema);
const plan = await structured.invoke([
  new SystemMessage(this.prompts.plannerSystemPrompt),
  new HumanMessage(userPrompt),
]);
// plan は { subtasks: string[] } そのもの
```

### ストリーミング表示について

構造化出力は JSON 断片がストリームされるため、表示しても意味がない。
`runAgent` のストリームループでノード名をチェックしてスキップする:

```typescript
if (mode === "messages") {
  const [chunk, metadata] = event;
  // 構造化出力ノードはスキップ
  if (metadata.langgraph_node === "create_plan") continue;
  // ...
}
```

### この時点での状態

- `createAnswer`: ChatOpenAI（ストリーミングあり）
- `createPlan`: ChatOpenAI（ストリーミングはスキップ）
- サブグラフの4ノード: OpenAI SDK のまま
- CostTracker: `parse` のラップ対象が減る（`createPlan` の分が漏れる）

---

## Step 3: サブグラフ全ノードを一括移行

**ゴール**: `state.messages` を `BaseMessage[]` に変更し、
サブグラフの全ノードを ChatOpenAI に移行する。

**変更ファイル**: `src/agent.ts`, `src/models.ts`

`state.messages` の型変更はサブグラフ内の全ノードに波及するため、
4ノード（`selectTools`, `executeTools`, `createSubtaskAnswer`, `reflectSubtask`）を
**一括で移行する**。

### 3-1. メッセージ型の変更

```typescript
import { BaseMessage, SystemMessage, HumanMessage, AIMessage, ToolMessage }
  from "@langchain/core/messages";

const AgentSubGraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>(),   // ← 変更
  // ... 他は変更なし
});
```

### 3-2. `selectTools` の移行

```typescript
// Before
const response = await this.client.chat.completions.create({
  model: this.settings.openai_model,
  messages,
  tools: this.tools.map(({ type, function: fn }) => ({ type, function: fn })),
  temperature: 0, seed: 0,
});
messages.push({ role: "assistant", tool_calls: response.choices[0].message.tool_calls });

// After
const modelWithTools = this.chatOpenAi.bindTools(
  this.tools.map(({ type, function: fn }) => ({ type, function: fn }))
);
const response = await modelWithTools.invoke(messages);
messages.push(response);   // AIMessage をそのまま追加
```

### 3-3. `executeTools` の移行

```typescript
// Before
const lastMessage = messages[messages.length - 1];
// lastMessage.tool_calls → OpenAI 形式

// After
const lastMessage = messages[messages.length - 1] as AIMessage;
// lastMessage.tool_calls → LangChain 形式

for (const toolCall of lastMessage.tool_calls) {
  const toolName = toolCall.name;                        // ← .function.name ではなく .name
  const toolArgs = JSON.stringify(toolCall.args);        // ← .function.arguments ではなく .args（オブジェクト）

  const tool = this.toolMap[toolName];
  const toolResult = await tool.invoke(toolArgs);

  currentToolResults.push({
    tool_name: toolName,
    args: toolArgs,
    results: Array.isArray(toolResult) ? toolResult : [],
  });

  messages.push(new ToolMessage({                        // ← { role: "tool" } ではなく ToolMessage
    content: JSON.stringify(toolResult),
    tool_call_id: toolCall.id!,
  }));
}
```

### 3-4. `createSubtaskAnswer` の移行

```typescript
// Before
const response = await this.client.chat.completions.create({ ... });
const subtaskAnswer = response.choices[0].message.content ?? "";
messages.push({ role: "assistant", content: subtaskAnswer });

// After
const response = await this.chatOpenAi.invoke(messages);
const subtaskAnswer = response.content as string;
messages.push(response);
```

### 3-5. `reflectSubtask` の移行

```typescript
// Before
const response = await this.client.chat.completions.parse({
  ..., response_format: zodResponseFormat(reflectionResultSchema, "reflectionResult"),
});
const reflectionResult = response.choices[0].message.parsed;
messages.push({ role: "assistant", content: JSON.stringify(reflectionResult) });

// After
const structured = this.chatOpenAi.withStructuredOutput(reflectionResultSchema);
const reflectionResult = await structured.invoke(messages);
messages.push(new AIMessage(JSON.stringify(reflectionResult)));
```

### 3-6. `selectTools` 初回/リトライのメッセージ構築

```typescript
// 初回
messages = [
  new SystemMessage(this.prompts.subtaskSystemPrompt),
  new HumanMessage(userPrompt),
];

// リトライ: tool/tool_calls メッセージを除外
messages = state.messages.filter(
  (m) => !(m instanceof ToolMessage) && !(m as AIMessage).tool_calls?.length
);
messages.push(new HumanMessage(this.prompts.subtaskRetryAnswerUserPrompt));
```

### 3-7. サブグラフのストリーミング伝播

LangGraph はサブグラフのストリームイベントを自動伝播しない。
`subgraphs: true` を指定して有効化する:

```typescript
const stream = await app.stream(
  { question },
  { streamMode: ["messages", "values"], subgraphs: true },
);
```

### この時点での状態

- 全ノードが ChatOpenAI 経由
- `createSubtaskAnswer` と `createAnswer` のトークンがストリーミング表示される
- `createPlan`, `reflectSubtask`, `selectTools` はストリーミング表示スキップ
- OpenAI SDK は `agent.ts` では不要に（ただし `opensearch.ts` の embeddings で使用）

---

## Step 4: CostTracker の移行 + 不要コード削除

**ゴール**: 全 LLM 呼び出しのコストを正しく集計する。

**変更ファイル**: `src/cost_tracker.ts`, `src/agent.ts`

### 4-1. CostTracker を BaseCallbackHandler 方式に変更

```typescript
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";

export class CostTracker extends BaseCallbackHandler {
  name = "CostTracker";
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
    // 既存のコスト計算ロジックをそのまま流用
  }
}
```

### 4-2. agent.ts で callbacks に渡す

```typescript
const costTracker = new CostTracker();
const stream = await app.stream(
  { question },
  {
    streamMode: ["messages", "values"],
    callbacks: [costTracker],
  },
);
// ... stream 処理 ...
costTracker.printReport(this.settings.openai_model);
```

### 4-3. 不要コードの削除

- `agent.ts` から `import OpenAI` を削除
- `agent.ts` から `this.client` を削除
- `agent.ts` から `zodResponseFormat` のインポートを削除
- `agent.ts` から `ChatCompletionMessageParam` のインポートを削除
- `CostTracker` の旧 `wrap()` メソッドを削除

---

## 注意事項

### メッセージ型の差異（Step 3 で最も注意が必要）

| | OpenAI SDK | LangChain |
|---|---|---|
| ツール名 | `toolCall.function.name` | `toolCall.name` |
| ツール引数 | `toolCall.function.arguments`（JSON文字列） | `toolCall.args`（パース済みオブジェクト） |
| tool結果 | `{ role: "tool", content, tool_call_id }` | `new ToolMessage({ content, tool_call_id })` |
| tool_calls判定 | `"tool_calls" in msg` | `msg instanceof AIMessage && msg.tool_calls.length` |

### embeddings は対象外

`src/opensearch.ts` は OpenAI SDK 直接のまま。`openai` パッケージは残す。

### `subgraphs: true` の出力形式

有効にすると `stream()` の出力にネームスペース情報が追加される。
イベントの判別ロジックが変わる可能性があるため、Step 3-7 で要検証。
