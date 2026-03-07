# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

LangGraph + OpenSearch ベースのマルチエージェント型ヘルプデスクシステム（TypeScript）。ユーザーの質問をサブタスクに分割し、OpenSearch でドキュメント検索（ベクトル検索 + キーワード検索）を行い、回答を生成する。元は Python（`genai-agent-advanced-book/chapter4/`）から移植。

## コマンド

```bash
pnpm install                # 依存パッケージインストール
pnpm dev "質問文"            # 開発実行（watch モード）
pnpm build                  # TypeScript コンパイル（tsc）
pnpm start                  # ビルド済みコード実行
pnpm lint                   # Biome によるリント
pnpm format                 # Biome によるフォーマット
pnpm setup-index            # OpenSearch インデックス作成・データ投入
docker compose up -d        # OpenSearch 起動（localhost:9200）
```

直接実行: `pnpm tsx --env-file=.env src/index.ts "質問文"`

## アーキテクチャ

### エージェントフロー（LangGraph）

**メイングラフ:**
```
START → create_plan → execute_subtasks（並列Send） → create_answer → END
```

**サブグラフ（各サブタスク）:**
```
select_tools → execute_tools → create_subtask_answer → reflect_subtask
    ↑                                                       ↓
    └──────────── 評価NGかつリトライ < 3回なら戻る ──────────┘
```

### 主要ファイル

| ファイル | 役割 |
|---|---|
| `src/agent.ts` | `HelpDeskAgent` クラス。メイングラフ + サブグラフ定義 |
| `src/config.ts` | 環境変数管理（Zod検証）、モデルプロバイダ推定、tool_choice解決 |
| `src/models.ts` | Zodスキーマ（Plan, ToolResult, ReflectionResult, Subtask） |
| `src/tools.ts` | ツール定義（search_xyz_manual: キーワード検索、search_xyz_qa: ベクトル検索） |
| `src/opensearch.ts` | OpenSearch クライアント、kNN/キーワード検索 |
| `src/prompt.ts` | プロンプトテンプレート（HelpDeskAgentPrompts クラス） |
| `src/cost_tracker.ts` | Token使用量・コスト集計（Gemini/OpenAI対応） |
| `src/stream_display.ts` | ストリーミング出力の視覚化・進捗表示 |
| `src/index.ts` | エントリーポイント。CLI引数から質問を受け取り実行 |
| `src/cli.ts` | CLIインタフェース（ESC中断リスナー、プロンプト入力） |

### LLMモデル抽象化

`config.ts` で環境変数 `LLM_MODEL` のプレフィックスからプロバイダを自動推定:
- `gemini-*` → `google-genai`（tool_choice: `"any"`）
- それ以外 → OpenAI互換（tool_choice: `"required"`）

`@langchain/core` の `initChatModel` で統一的に初期化。

### OpenSearch 検索

同一 `documents` インデックスで2種類の検索を提供:
- **ベクトル検索**: Embedding（text-embedding-3-small, 1536次元）+ kNN（cosine similarity）
- **キーワード検索**: Kuromoji日本語解析 + match query

チャンク: 300字 + 20字オーバーラップ

### 中断・再開

ESC押下で実行を中断し、完了済みサブタスクを保持。ユーザー指示で計画を更新（replan）して再開可能。

## 技術スタック

- **ランタイム**: Node.js v25+、pnpm
- **言語**: TypeScript（ES2022、NodeNext モジュール）
- **リンター**: Biome
- **LLM**: LangChain/LangGraph（OpenAI / Gemini 切り替え可能）
- **検索**: OpenSearch 3.5.0（Docker Compose、Kuromorojiプラグイン）

## 環境変数（.env）

```env
LLM_API_KEY=          # Gemini or OpenAI API key
LLM_MODEL=            # gemini-2.5-flash, gpt-4o など
OPENAI_API_KEY=       # Embedding用
OPENSEARCH_URL=http://localhost:9200
```

詳細は `.env.example` を参照。
