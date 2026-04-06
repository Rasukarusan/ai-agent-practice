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
pnpm tsx --env-file=.env src/index.ts "パスワードに利用できる文字、最新リリースの取得方法について教えて"

# watch モード
pnpm dev "パスワードに利用できる文字、最新リリースの取得方法について教えて"
```


## Mem0 OSS（オープンソース版）を導入する

このリポジトリは、**Mem0 OSS のREST API** に対応しています。  
`MEM0_ENABLED=true` にすると、以下が有効になります。

- 回答前に `POST /search` で過去メモリを検索し、計画作成に活用
- 回答後に `POST /memories` へ会話を保存

### 1. Mem0 APIサーバーを起動

Mem0公式ドキュメントの OSS REST API 手順に沿って起動します（例: Docker）。

```bash
docker run -p 8000:8000 --env-file .env mem0/mem0-api-server
```

### 2. このプロジェクトの `.env` を設定

```env
MEM0_ENABLED=true
MEM0_BASE_URL=http://localhost:8000
MEM0_USER_ID=helpdesk-user
# Mem0で ADMIN_API_KEY を設定している場合のみ指定
MEM0_API_KEY=your-secret-api-key
MEM0_SEARCH_LIMIT=5
```

### 3. 動作確認

```bash
# エージェント実行
pnpm tsx --env-file=.env src/index.ts "パスワード要件を教えて"

# Mem0 API 側で検索確認（任意）
curl -X POST http://localhost:8000/search \
  -H "Content-Type: application/json" \
  -d '{"query":"パスワード","user_id":"helpdesk-user"}'
```

> 注意: Mem0 OSS は `/v1` プレフィックスなしのエンドポイントです（`/memories`, `/search`）。

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
