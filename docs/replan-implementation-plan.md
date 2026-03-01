# 再計画ノード追加による中断・再開の改善

## Context

現在の中断・再開はチェックポイントから単純に再開するため、中断時に追加した質問が計画に反映されない。
ユーザーの期待: 元の質問 + 追加指示を統合して再計画し、完了済みサブタスクは再利用、新規サブタスクのみ実行して最終回答を生成する。

## 方針

チェックポイント再開をやめ、中断時に「完了済みサブタスク結果」を持ち帰り、新スレッドで再実行する。
プランナーに完了済み結果を渡して追加サブタスクのみ生成させ、最終回答では全結果を使う。

## 変更ファイルと内容

### 1. `src/agent.ts`

#### 1-1. AgentState に `previousSubtaskResults` を追加

```typescript
const AgentState = Annotation.Root({
  question: Annotation<string>(),
  plan: Annotation<string[]>(),
  currentStep: Annotation<number>(),
  previousSubtaskResults: Annotation<Subtask[]>({  // 追加
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  subtaskResults: Annotation<Subtask[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  lastAnswer: Annotation<string>(),
});
```

#### 1-2. RunAgentOptions を変更

`isResume` を削除し、`previousSubtaskResults` を追加。

```typescript
interface RunAgentOptions {
  question: string;
  threadId: string;
  signal?: AbortSignal;
  previousSubtaskResults?: Subtask[];
}
```

#### 1-3. `createPlan` を修正

`previousSubtaskResults` が存在する場合、完了済みサブタスクの情報をプロンプトに含めて、追加サブタスクのみ生成させる。

```typescript
async createPlan(state: typeof AgentState.State) {
  const hasPrevious = state.previousSubtaskResults.length > 0;

  const userPrompt = hasPrevious
    ? this.prompts.replanUserPrompt
        .replace("{question}", state.question)
        .replace("{completed_subtasks}",
          state.previousSubtaskResults
            .map(r => `- ${r.task_name}: ${r.subtask_answer}`)
            .join("\n"))
    : this.prompts.plannerUserPrompt.replace("{question}", state.question);

  // ... 以降は同じ
}
```

#### 1-4. `createAnswer` を修正

`previousSubtaskResults` + `subtaskResults` を結合して最終回答を生成。

```typescript
private async createAnswer(state: typeof AgentState.State) {
  const allResults = [...state.previousSubtaskResults, ...state.subtaskResults];
  const subtaskResults = allResults.map(
    (r) => [r.task_name, r.subtask_answer] as const,
  );
  // ... 以降は同じ
}
```

#### 1-5. `runAgent` を修正

- 中断時: `"aborted"` ではなく、完了済みサブタスク結果を返す
- 再開時: `previousSubtaskResults` を初期Stateに含めて新規実行
- チェックポイント再開（`updateState` + `null` ストリーム）は削除

```typescript
// 戻り値の型
type AbortedResult = { aborted: true; completedSubtasks: Subtask[] };

async runAgent(options: RunAgentOptions): Promise<AgentResult | AbortedResult> {
  const { question, threadId, signal, previousSubtaskResults } = options;
  const app = this.createGraph();
  const config = { configurable: { thread_id: threadId } };

  const stream = await app.stream(
    { question, previousSubtaskResults: previousSubtaskResults ?? [] },
    { ...config, streamMode: ["messages", "values"], subgraphs: true, callbacks: [this.costTracker], signal },
  );

  // ... ストリーム処理 ...

  // catch内:
  if (signal?.aborted) {
    display.finish("aborted");
    return { aborted: true, completedSubtasks: result?.subtaskResults ?? [] };
  }
}
```

### 2. `src/prompt.ts`

#### 2-1. 再計画用プロンプトを追加

```typescript
const REPLAN_USER_PROMPT = `
{question}

以下のサブタスクは既に完了しています。これらと重複する内容は含めず、追加で必要なサブタスクのみを計画してください。

完了済みサブタスク:
{completed_subtasks}
`;
```

#### 2-2. `HelpDeskAgentPrompts` にメンバ追加

```typescript
replanUserPrompt: string;
// constructor内:
this.replanUserPrompt = options.replanUserPrompt ?? REPLAN_USER_PROMPT;
```

### 3. `src/index.ts`

#### 3-1. 中断時に完了済みサブタスクを保持

```typescript
let previousSubtasks: Subtask[] = [];

while (true) {
  // ...
  const result = await agent.runAgent({
    question: query,
    threadId: randomUUID(),  // 毎回新しいスレッド
    signal: abortController.signal,
    previousSubtaskResults: previousSubtasks.length > 0 ? previousSubtasks : undefined,
  });

  if ("aborted" in result) {
    previousSubtasks = [...previousSubtasks, ...result.completedSubtasks];
    // ユーザー入力を受け付け、queryを更新
    // ...
    continue;
  }
  break;
}
```

#### 3-2. 質問の結合

中断が複数回あっても元の質問と追加指示を統合する。

```typescript
const originalQuestion = query;  // 初回の質問を保持
// 中断時:
const input = await prompt("> ");
query = input
  ? `${originalQuestion}\n追加の質問: ${input}`
  : originalQuestion;
```

## 検証方法

```bash
npx tsx src/index.ts "パスワードに利用できる文字、最新リリースの取得方法について教えて"
```

1. 実行中にEscで中断
2. 「SSOログインについても教えて」と入力
3. 再計画で「SSOログインについて調べる」のみが新規サブタスクとして生成される
4. 最終回答にパスワード・最新リリース・SSOの3点が含まれる
