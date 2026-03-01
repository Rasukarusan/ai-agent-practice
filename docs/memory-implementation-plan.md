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

| 種類 | 何を覚えるか | 具体例 | 実装方式 | 想定保存先 |
|------|------------|-------|---------|-----------|
| **Semantic（意味記憶）** | 事実・知識 | 「パスワードは8文字以上必要」「SSOはSAML方式」 | Collection（複数ドキュメント）or Profile（単一構造化ドキュメント） | OpenSearch（`memories` インデックス）← 今回実装 |
| **Episodic（エピソード記憶）** | 過去の成功体験 | 「パスワード質問には search_xyz_manual が有効だった」 | Few-shot 例として保存（状況・思考・成功理由） | OpenSearch（別インデックス）or RDB |
| **Procedural（手続き記憶）** | 振る舞いのルール | 「回答は箇条書きで簡潔にすべき」 | システムプロンプトの自動最適化 | ファイル or DB（ベクトル検索は不要） |

> **Semantic と Procedural の違い:**
> 「ユーザーは簡潔な回答が好き」と**知っている**のが Semantic（事実の記録）。
> それを受けて「回答は簡潔にせよ」と**行動ルールに変換する**のが Procedural（振る舞いへの反映）。
> つまり Semantic → Procedural の順で、知識が行動に変わる関係にある。

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

## メモリ管理（コンテキスト肥大化への対策）

### 問題の分離

「保存」と「コンテキストへの読み込み」は別問題。

- **保存はどんどんしていい**（ストレージは安い）
- **問題はコンテキストに何を載せるか**

### コンテキストへの読み込み戦略

| 戦略 | 概要 | 備考 |
|------|------|------|
| **RAG的フィルタリング** | 今の会話に関連するメモリだけをベクトル検索で取得（Top-N件） | OpenSearchを使う本実装に最適 |
| **重要度スコアリング** | 重要度・鮮度・参照頻度などのスコアが低いものは読み込まない | スコア管理が必要 |
| **メモリの圧縮・統合** | 似たメモリを定期的にLLMでまとめる（例: 複数のパスワード条件 → 1件に統合） | バックグラウンド処理向き |

→ 本実装では `searchMemories()` で関連度Top-N件のみ取得する方式を採用。

### 保存側の管理

- **TTL（有効期限）**: 古いメモリは自動削除
- **重複チェック**: 同じ内容は上書き or スキップ
- **件数上限**: 上限を設けて古いものから削除

### 重複削除・統合の優先度

初期段階では重複削除・統合の優先度は低い。

**理由:**
- ベクトル検索のTop-N取得が自然にフィルタリングしてくれる（重複があっても同じ話が複数返るだけで、LLMは普通に処理できる）
- 保存コストは安い（数千件の短い事実テキスト + ベクトルは誤差レベル）
- 統合処理自体にLLMコストがかかる（効果が見合うかは運用してみないとわからない）

**困るケースが出てから対処すればよい:**
- 「Top-5件が全部ほぼ同じ内容で、多様な知識が引けない」が起きたら対策する
- 対策案①: **MMR（Maximal Marginal Relevance）** で検索時に類似結果を間引く（統合より軽量）
- 対策案②: **保存時の簡易重複チェック**（コサイン類似度が閾値以上なら上書き）

### langmem の統合機能（参考）

langmem はCollection パターンで、新しい会話が来るたびに既存メモリと照合して自動で統合する:

| 操作 | 条件 | 例 |
|------|------|-----|
| **INSERT** | 新しい事実 | 新しいメモリとして追加 |
| **UPDATE** | 既存メモリと矛盾・補完する情報 | 「パスワードは8文字以上」→「10文字以上に変更された」で上書き |
| **DELETE** | 無効になった情報 | メモリを削除 |

さらに **Background Memory Manager** があり、会話の外でバックグラウンドで冗長なメモリの統合・古いメモリの整理を自動で行う。

**今回の実装との違い:**

| | langmem | 今回の実装 |
|---|---------|-----------|
| 事実抽出 | あり | あり |
| 既存メモリとの照合・更新 | あり（LLMが判断） | **なし**（常にINSERT） |
| 削除 | あり | なし |
| バックグラウンド統合 | あり | なし |
| 検索時のフィルタリング | あり（重要度・鮮度考慮） | あり（Top-N件のみ） |

→ 初期段階では常にINSERTで十分。実際に重複が問題になってから「保存時に既存メモリと類似度チェック → 閾値以上なら上書き」を足せばよい。

### まとめ

「全部読まない」が本質的な解決策。mem0やlangmemもRAG的フィルタリング＋重複排除＋定期的な統合を組み合わせている。ただし初期段階では重複削除・統合は不要で、Top-N検索だけで十分機能する。

## メモリ関連OSSの比較（langmem / mem0 以外）

langmem・mem0 以外にも、LLMエージェント向けの長期メモリOSSが多数存在する。今後の拡張や設計の参考として整理する。

### 主要OSS

| ライブラリ | 概要 | 特徴 |
|-----------|------|------|
| **[Letta](https://github.com/cpacker/MemGPT)**（旧MemGPT） | UC Berkeley発。OS的なメモリ階層管理 | コンテキストウィンドウ=メインメモリ、外部DB=ディスクとみなし、ページイン/ページアウトで管理。今回のTop-N取得はこの簡易版と言える |
| **[Zep](https://github.com/getzep/zep)** | エピソード記憶・時系列に強い | Temporal Knowledge Graphで時間軸を考慮した記憶管理。会話の流れを構造化して保存 |
| **[SimpleMem](https://github.com/aiming-lab/SimpleMem)** | セマンティック圧縮によるメモリ効率化 | 2026年2月公開。GPT-4.1-miniでF1=43.24（Mem0は34.20）。トークン消費を抑えつつ高精度 |
| **[A-MEM](https://arxiv.org/abs/2502.12110)** | エージェントが自律的にメモリを管理 | 2025年2月論文。メモリのINSERT/UPDATE/DELETEをエージェント自身が判断 |
| **[MemOS](https://arxiv.org/abs/2506.06326)** | メモリをOS的に統合管理する抽象レイヤー | 事実・要約・体験など異なるストアを単一のAPIで統合 |
| **[Supermemory](https://github.com/supermemoryai/supermemory)** | 時間注釈付きセマンティックトレース | 軽量・スケーラブル。長期稼働エージェント向け |

### ベンチマーク比較（LoCoMo等）

| ライブラリ | Average F1（GPT-4.1-mini） | 備考 |
|-----------|---------------------------|------|
| SimpleMem | 43.24 | 最高スコア。圧縮でトークン効率も良い |
| Mem0 | 34.20 | 成熟したエコシステム。Graph Memory対応 |
| langmem | — | LangGraph統合が強み。ベンチマーク非公開 |
| A-MEM | — | 研究段階だが自律管理が特徴的 |

### 設計アプローチの分類

| アプローチ | 代表例 | 概要 |
|-----------|--------|------|
| **OS的メモリ階層** | Letta (MemGPT) | コンテキスト=RAM、DB=ディスクとしてスワップ管理 |
| **グラフベース** | Mem0, Zep | エンティティ間の関係をグラフ構造で保持 |
| **圧縮・統合** | SimpleMem, LightMem | セマンティック圧縮でトークン効率を最大化 |
| **自律管理** | A-MEM, MemOS | エージェント自身がメモリのCRUDを判断 |
| **RAG + 抽出** | langmem, 今回の実装 | LLMで事実を抽出し、ベクトル検索で関連メモリを取得 |

### 今後の拡張に向けて

- **コスト最適化が必要になったら**: SimpleMem の圧縮アプローチを参考に、保存時にメモリを圧縮してトークン消費を抑える
- **時系列が重要になったら**: Zep の Temporal Knowledge Graph を参考に、メモリに時間的な文脈を付与する
- **メモリが増えすぎたら**: Letta のページイン/ページアウト方式や、A-MEM の自律的なメモリ整理を検討する
- **エンティティ間の関係が重要になったら**: Mem0 の Graph Memory を参考に、事実間の関係をグラフ構造で管理する
