# Escキーによるインターセプト＆再開機能 計画書

## 背景

Claude Codeでは、実行中にEscキーを押すと処理を中断し、「続けて」と入力すると途中から再開できる。
同様の体験を`agent.ts`のLangGraphベースのエージェントでも実現したい。

## ゴール

1. ストリーミング実行中にEscキーで処理を中断できる
2. 中断後にユーザーが新たな指示を入力し、途中の状態から再開できる
3. 再開時にユーザーの追加指示をStateに反映できる

## アーキテクチャ

### Claude Codeとの違い

| | Claude Code | このプロジェクト |
|---|---|---|
| 状態管理 | 会話履歴（メッセージ配列） | LangGraphのState（plan, subtaskResults等） |
| 中断 | APIコール中断、履歴はそのまま | ストリーム中断、グラフの途中状態が消える |
| 再開 | 履歴を付けて再度API呼ぶだけ | **チェックポインターで状態保存が必要** |

Claude Codeは会話履歴がそのまま状態になるためチェックポインター不要だが、
LangGraphではノード間のState遷移をチェックポインターで永続化しないと中断時に状態が失われる。

### 採用するアプローチ：AbortController + チェックポインター

```
[実行中] ──Escキー──> [中断] ──ユーザー入力──> [State更新] ──> [途中から再開]
                        │                        │
                  AbortController.abort()    app.updateState()
                  チェックポイントに            新しい指示を
                  状態が保存済み               Stateに反映
                                                │
                                          app.stream(null, config)
                                          最後のチェックポイントから再開
```

---

## 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `src/agent.ts` | チェックポインター追加、`runAgent`のシグネチャ変更、AbortSignal対応 |
| `src/index.ts` | 対話ループ化、Escキー検知（stdin raw mode）、再開ロジック |
| `src/stream_display.ts` | 中断時の表示クリーンアップ（`finish`の呼び分け） |
| `package.json` | 必要に応じて依存追加（`@langchain/langgraph`に`MemorySaver`は同梱済み） |

---

## 実装手順

### Step 1: チェックポインターの導入（`agent.ts`）

`createGraph()`の`compile()`にチェックポインターを渡す。

```typescript
import { MemorySaver } from "@langchain/langgraph";

// クラスメンバに追加
private checkpointer = new MemorySaver();

// createGraph()を変更
createGraph() {
  const workflow = new StateGraph(AgentState)
    .addNode("create_plan", (state) => this.createPlan(state))
    .addNode("execute_subtasks", (state) => this.executeSubgraph(state))
    .addNode("create_answer", (state) => this.createAnswer(state))
    .addEdge(START, "create_plan")
    .addConditionalEdges("create_plan", (state) =>
      this.shouldContinueExecSubtasks(state),
    )
    .addEdge("execute_subtasks", "create_answer")
    .addEdge("create_answer", END);
  return workflow.compile({ checkpointer: this.checkpointer });
}
```

### Step 2: `runAgent`をAbortSignal対応にする（`agent.ts`）

`runAgent`のシグネチャを変更し、`signal`と`thread_id`を受け取れるようにする。

```typescript
interface RunAgentOptions {
  question: string;
  threadId: string;
  signal?: AbortSignal;
  isResume?: boolean;  // 再開時はtrue
}

async runAgent(options: RunAgentOptions): Promise<AgentResult | "aborted"> {
  const { question, threadId, signal, isResume } = options;
  const app = this.createGraph();
  const config = { configurable: { thread_id: threadId } };

  // 再開時：Stateを更新してからnullで再開
  if (isResume) {
    await app.updateState(config, { question });
  }

  const stream = await app.stream(
    isResume ? null : { question },
    {
      ...config,
      streamMode: ["messages", "values"],
      subgraphs: true,
      callbacks: [this.costTracker],
      signal,
    },
  );

  let result: typeof AgentState.State | undefined;
  const display = new StreamDisplay();

  try {
    for await (const [_namespace, mode, event] of stream) {
      if (mode === "messages") {
        const [chunk, metadata] = event;
        const node = metadata.langgraph_node as string;
        const ns = Array.isArray(_namespace)
          ? _namespace.join("/")
          : String(_namespace);
        if (typeof chunk.content === "string" && chunk.content) {
          display.update(node, ns, chunk.content);
        }
      } else if (mode === "values") {
        result = event;
      }
    }
  } catch (e) {
    if (signal?.aborted) {
      display.finish("aborted");
      return "aborted";
    }
    throw e;
  }

  display.finish();
  // ... 結果の組み立て（既存通り）
}
```

### Step 3: Escキー検知と対話ループ（`index.ts`）

`index.ts`をワンショット実行から対話ループに変更する。

```typescript
import * as readline from "readline";
import { randomUUID } from "crypto";

const main = async () => {
  const settings = loadSettings();
  const agent = new HelpDeskAgent(settings, tools);

  // 初回の質問はコマンドライン引数 or プロンプト入力
  const args = process.argv.slice(2);
  let query = args.join(" ");
  if (!query) {
    query = await prompt("質問を入力: ");
  }

  let threadId = randomUUID();
  let isResume = false;

  while (true) {
    const abortController = new AbortController();

    // Escキー検知の設定
    const cleanup = setupEscListener(() => {
      abortController.abort();
    });

    const result = await agent.runAgent({
      question: query,
      threadId,
      signal: abortController.signal,
      isResume,
    });

    cleanup(); // stdinリスナー解除

    if (result === "aborted") {
      console.error("\n⏸  中断しました。指示を入力してください（空Enterで再開、qで終了）:");
      const input = await prompt("> ");

      if (input === "q") break;

      query = input || "続けてください";
      isResume = true;
      continue;
    }

    // 正常終了
    break;
  }
};

// Escキーリスナーのセットアップ
function setupEscListener(onEsc: () => void): () => void {
  if (!process.stdin.isTTY) return () => {};

  process.stdin.setRawMode(true);
  process.stdin.resume();

  const handler = (key: Buffer) => {
    if (key[0] === 0x1b && key.length === 1) {  // Escキー（単体）
      onEsc();
    }
    if (key[0] === 0x03) {  // Ctrl+C
      process.exit();
    }
  };

  process.stdin.on("data", handler);

  return () => {
    process.stdin.removeListener("data", handler);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  };
}
```

### Step 4: StreamDisplayの中断対応（`stream_display.ts`）

`finish`メソッドに中断時の表示を追加する。

```typescript
finish(reason?: "aborted"): void {
  if (reason === "aborted") {
    process.stderr.write("\n");
    process.stderr.write("\x1b[33m⏸  処理を中断しました\x1b[0m\n");
  } else {
    process.stderr.write("\n");
  }
}
```

---

## 再開時の動作詳細

### チェックポインターの再開粒度

再開はノード単位で行われる。中断タイミングによる挙動：

| 中断タイミング | 保存済みの状態 | 再開時の動作 |
|---|---|---|
| `create_plan`実行中 | なし（最初のノード） | `create_plan`を最初からやり直し |
| `create_plan`完了後、サブタスク実行中 | `plan`が確定 | 未完了のサブタスクから実行 |
| 一部のサブタスク完了後 | 完了済みサブタスクの`subtaskResults` | 残りのサブタスクを実行 |
| `create_answer`実行中 | 全サブタスク完了 | `create_answer`をやり直し |

### `Send`（並列実行）との互換性

現在の実装では`Send`でサブタスクを並列実行しているが、チェックポインターは`Send`で生成された各ノードの完了も個別に追跡する。
ただし、**並列実行の途中で中断した場合の挙動は要検証**。

---

## 注意事項・考慮点

1. **EscキーとANSIエスケープシーケンスの区別**
   - 矢印キー等もEsc（`0x1b`）で始まるが、後続バイトがある
   - `key.length === 1` で単体のEscキーのみを検知する

2. **`MemorySaver`はインメモリ**
   - プロセス再起動で状態が消える
   - プロセス内での中断→再開のみ対応（今回のスコープではこれで十分）

3. **サブグラフのチェックポインター**
   - `createSubGraph()`の`compile()`にも同じチェックポインターを渡す必要があるか要検証
   - メイングラフのチェックポインターがサブグラフもカバーするかはLangGraphのバージョンによる

4. **コスト追跡**
   - 中断→再開でも`CostTracker`は同じインスタンスを使うため、累計で正しくカウントされる

---

## 確認方法

```bash
npx tsx src/index.ts "ログインできない"
```

### 確認ポイント

- [ ] 実行中にEscキーで中断できる
- [ ] 中断時に「⏸ 処理を中断しました」と表示される
- [ ] 中断後にプロンプトが表示され、入力を受け付ける
- [ ] 空Enterで「続けてください」として再開される
- [ ] 新しい指示を入力して再開できる
- [ ] 再開時に途中の状態（plan等）が引き継がれる
- [ ] Ctrl+Cで完全終了できる
- [ ] 正常完了時は従来通り結果が表示される
