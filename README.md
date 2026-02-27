# ai-agent-practice

LangGraph ベースのヘルプデスクエージェント。OpenSearch によるベクトル検索（kNN）で社内ドキュメントを検索し、回答を生成する。

## 前提条件

- Node.js v25+
- pnpm
- Docker / Docker Compose

## セットアップ

### 1. 依存パッケージのインストール

```bash
pnpm install
```

### 2. 環境変数の設定

`.env` ファイルをプロジェクトルートに作成する。

```bash
cp .env.example .env
```

```env
OPENAI_API_KEY=sk-xxx
OPENAI_API_BASE=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o
```

### 3. OpenSearch の起動

```bash
docker compose up -d
```

以下のサービスが起動する。

| サービス | URL | 説明 |
|---|---|---|
| OpenSearch | http://localhost:9200 | 検索エンジン（API） |
| OpenSearch Dashboards | http://localhost:5601 | 管理UI |

起動確認:

```bash
curl http://localhost:9200
```

### 4. インデックス作成とサンプルデータ投入

```bash
pnpm setup-index
```

OpenSearch に `documents` インデックスを作成し、サンプルドキュメントをベクトル化して登録する。

## 実行

```bash
# 直接実行
pnpm tsx --env-file=.env src/index.ts "XYZシステムのログイン方法を教えて"

# watch モード
pnpm dev "XYZシステムのログイン方法を教えて"
```

## OpenSearch の管理

```bash
# 停止
docker compose down

# データも含めて完全に削除
docker compose down -v

# ログ確認
docker compose logs -f opensearch

# インデックス一覧の確認
curl http://localhost:9200/_cat/indices?v
```
