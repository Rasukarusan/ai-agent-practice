# langmem 的メモリ機能の追加（OpenSearch + LLMによる事実抽出）

## Context

ヘルプデスクエージェントが「使えば使うほど賢くなる」仕組みを作る。
langmem（Python only）の考え方を参考に、TypeScript で同等の仕組みを自前実装する。
RAG のように生データを保存するのではなく、**LLM に会話から重要な事実を抽出させ、要約された知識として OpenSearch に蓄積**する。
既存の `src/opensearch.ts`（クライアント、embedding、kNN検索）を再利用し、OpenSearch に直接保存する。

## LLMのメモリ実現方式の比較

| 方式 | 保存先 | 粒度 | 代表例 |
|------|-------|------|-------|
| コンテキスト | なし（プロンプト内） | 会話全文 | ChatGPTのセッション内 |
| RAG | ベクトルDB | ドキュメント/Q&A単位 | 独自実装が多い |
| 要約・抽出 | ベクトルDB / RDS | ユーザー特性・事実 | ChatGPTのメモリ、langmem |

今回は**要約・抽出**方式を採用する。

## langmem のメモリ3分類（参考）

| 種類 | 何を覚えるか | 具体例 | 実装方式 |
|------|------------|-------|---------|
| **Semantic（意味記憶）** | 事実・知識 | 「パスワードは8文字以上必要」「SSOはSAML方式」 | Collection（複数ドキュメント）or Profile（単一構造化ドキュメント） |
| **Episodic（エピソード記憶）** | 過去の成功体験 | 「パスワード質問には search_xyz_manual が有効だった」 | Few-shot 例として保存（状況・思考・成功理由） |
| **Procedural（手続き記憶）** | 振る舞いのルール | 「回答は箇条書きで簡潔にすべき」 | システムプロンプトの自動最適化 |

### メモリの形成方法
- **Active（ホットパス）**: 会話中に即座にメモリ更新（レイテンシ増加）
- **Background**: 会話後に非同期でメモリ抽出・統合（レイテンシなし）

### 今回のスコープ
**Semantic Memory（意味記憶）** を Active 方式で実装する。

## 変更ファイルと内容

### 1. `src/memory.ts`（新規作成）

事実の抽出・保存・検索を担当するモジュール。

**1-1. 事実抽出関数**

LLM に会話（質問＋回答）を渡し、覚えるべき事実を抽出させる。

```typescript
async function extractFacts(question: string, answer: string): Promise<string[]> {
  // LLM に「この会話から覚えるべき事実を抽出して」と依頼
  // 構造化出力で事実のリストを返す
}
```

抽出される事実の例:
- 入力: 「パスワードに利用できる文字は？」→「8文字以上、大文字小文字、数字、特殊文字を含む...」
- 抽出: ["パスワードは最低8文字以上必要", "大文字と小文字の両方が必要", "特殊文字が最低1つ必要"]

**1-2. 事実保存関数**

抽出した各事実を個別にベクトル化して OpenSearch の `memories` インデックスに保存する。

```typescript
async function saveMemories(facts: string[], question: string): Promise<void> {
  for (const fact of facts) {
    const embedding = await getEmbedding(fact);
    await opensearchClient.index({
      index: "memories",
      body: { fact, source_question: question, embedding, created_at: new Date().toISOString() },
    });
  }
}
```

**1-3. 関連メモリ検索関数**

質問に関連する過去の事実を kNN 検索で取得する。

```typescript
async function searchMemories(question: string, limit = 5): Promise<string[]> {
  const embedding = await getEmbedding(question);
  // kNN 検索で類似する事実を返す
}
```

**1-4. インデックス初期化関数**

```typescript
async function setupMemoryIndex(): Promise<void> {
  // memories インデックスを作成（knn_vector 対応）
}
```

**OpenSearch に保存されるドキュメント構造:**
```json
{
  "fact": "パスワードは最低8文字以上必要",
  "source_question": "パスワードに利用できる文字は？",
  "embedding": [0.012, -0.034, ...],
  "created_at": "2026-03-01T12:00:00Z"
}
```

### 2. `src/agent.ts`（修正）

**2-1. `createPlan` を修正**

計画立案前に `searchMemories()` で関連する過去の事実を検索し、見つかればプロンプトに含める。

```typescript
async createPlan(state) {
  const memories = await searchMemories(state.question);
  // memories が見つかったら plannerWithMemoryUserPrompt を使う
}
```

**2-2. `createAnswer` の後に事実抽出・保存を追加**

最終回答生成後に LLM で事実を抽出し、OpenSearch に保存する。
方法は2つ:
- (A) `createAnswer` 内で回答生成後に呼ぶ
- (B) 新ノード `save_memories` を追加してグラフに組み込む

→ **(B) 新ノード `save_memories` を追加** の方がグラフの責務が明確。

```
create_answer → save_memories → END
```

### 3. `src/prompt.ts`（修正）

**3-1. 事実抽出用プロンプトを追加**

```
以下の質問と回答から、今後の質問応答に役立つ事実を抽出してください。
事実は1つずつ短い文で、具体的に記述してください。
一般的な知識ではなく、このシステム固有の情報のみを抽出してください。

質問: {question}
回答: {answer}
```

**3-2. メモリ付きプランナープロンプトを追加**

```
{question}

以下はこのシステムについて過去に学んだ事実です。
計画を立てる際の参考にしてください。
過去の事実で十分カバーされている内容はサブタスクから省略しても構いません。

関連する過去の知識:
{memories}
```

### 4. `src/index.ts`（修正）

起動時に `setupMemoryIndex()` を呼び出してインデックスを初期化する。

## データフロー

```
質問が来る
  ↓
[createPlan]
  1. searchMemories() で関連する過去の事実を検索
  2. 見つかった → メモリ付きプロンプトで計画生成（サブタスク削減）
  3. 見つからない → 通常通り計画生成
  ↓
[execute_subtasks] ← 変更なし
  ↓
[createAnswer]
  最終回答を生成
  ↓
[save_memories]  ← 新ノード
  1. LLM に質問＋回答を渡して事実を抽出
  2. 各事実をベクトル化して OpenSearch に保存
  ↓
結果を返す（次回以降、保存した事実が活用される）
```

## 検証方法

1. `docker compose up -d` で OpenSearch 起動
2. 1回目: `npx tsx src/index.ts "パスワードに利用できる文字は？"`
   - 回答生成 → 事実抽出 → OpenSearch に保存
3. データ確認:
   ```bash
   curl -s http://localhost:9200/memories/_search?pretty
   ```
   → 「パスワードは最低8文字以上必要」等の事実が個別に保存されている
4. 2回目: `npx tsx src/index.ts "パスワードの条件を教えて"`
   - 関連する事実が見つかり、計画が効率化される（サブタスク数の削減）
5. デバッグログで「関連メモリ N 件見つかった」「事実 N 件抽出・保存した」を確認
