# ストリーミング表示UI改善計画書

## 前提

- Step 1〜4 の LangChain ChatOpenAI 移行が完了済み
- 全ノードのトークンが `process.stderr` にストリーミング出力されている
- 現状はトークンがそのまま垂れ流しで、どのノードの出力か判別しにくい

## ゴール

ノード（処理ステップ）ごとに1行で表示し、トークンが流れるたびに同じ行を上書きする。
ノードが切り替わったら改行して次の行に進む。

### 表示イメージ

```
[計画作成] {"subtasks":["ログイン画面の確認","パスワードリセット手順"]}
[ツール選択]
[サブタスク回答] ログインできない場合、まずブラウザのキャッシュをクリア...
[振り返り] {"is_completed":true,"reason":"回答が十分です"}
[最終回答生成] ログインできない場合は以下の手順をお試しください...
```

各行はリアルタイムに上書きされながら伸びていき、ターミナル幅を超えた場合は末尾を `...` で省略する。

---

## 変更ファイル

`src/agent.ts`（`runAgent` メソッドのみ）

---

## 実装手順

### Step 1: ノードラベルの定義

ストリームループの前に、ノード名と表示ラベルの対応を定義する。

```typescript
const nodeLabels: Record<string, string> = {
  create_plan: "[計画作成] ",
  select_tools: "[ツール選択] ",
  create_subtask_answer: "[サブタスク回答] ",
  reflect_subtask: "[振り返り] ",
  create_answer: "[最終回答生成] ",
};
```

### Step 2: 状態変数の追加

現在のノードと、現在の行の内容を追跡する変数を追加する。

```typescript
let currentNode = "";
let currentLine = "";
```

### Step 3: ストリームループの書き換え

`for await` ループ内の `mode === "messages"` の処理を以下に変更する。

```typescript
for await (const [_namespace, mode, event] of stream) {
  if (mode === "messages") {
    const [chunk, metadata] = event;
    const node = metadata.langgraph_node;

    if (typeof chunk.content === "string" && chunk.content) {
      // ノードが切り替わったら改行して新しいラベルを出す
      if (node !== currentNode) {
        if (currentNode) process.stderr.write("\n");
        currentNode = node;
        currentLine = "";
      }

      currentLine += chunk.content;

      // 行頭に戻って上書き
      const label = nodeLabels[node] ?? `[${node}] `;
      const cols = process.stderr.columns || 80;
      const maxLen = cols - label.length;
      const display = currentLine.replace(/\n/g, " ");
      const truncated = display.length > maxLen
        ? display.slice(0, maxLen - 3) + "..."
        : display;
      process.stderr.write(`\r\x1b[K${label}${truncated}`);
    }
  } else if (mode === "values") {
    result = event;
  }
}
process.stderr.write("\n");
```

### 各要素の説明

| 要素 | 役割 |
|---|---|
| `currentNode` | 現在表示中のノード名を保持。切り替わり検知に使用 |
| `currentLine` | 現在の行に蓄積されたテキスト全体 |
| `\r` | キャリッジリターン。カーソルを行頭に戻す |
| `\x1b[K` | ANSI エスケープ。カーソルから行末までをクリア |
| `cols` | ターミナルの横幅。`process.stderr.columns` で取得 |
| `.replace(/\n/g, " ")` | トークン中の改行を除去して1行に収める |
| truncated | ターミナル幅を超えたら末尾を `...` に省略 |

---

## 確認方法

```bash
npx tsx src/index.ts "ログインできない"
```

stderr に直接出力されるため、リダイレクトせずに実行すると上書き表示が確認できる。

### 確認ポイント

- 各ノードごとにラベル付きで1行表示される
- トークンが流れるたびに同じ行が上書きされる
- ノードが切り替わると改行して次の行に進む
- ターミナル幅を超えた場合 `...` で省略される
- stdout の JSON 結果は従来通り出力される
