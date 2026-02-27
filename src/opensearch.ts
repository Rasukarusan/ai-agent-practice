import { Client } from "@opensearch-project/opensearch";
import type OpenAI from "openai";
import { getCachedEmbedding, saveCachedEmbedding } from "./embedding-cache.js";
import type { SearchOutput } from "./models.js";

const OPENSEARCH_URL = process.env.OPENSEARCH_URL ?? "http://localhost:9200";

export const opensearchClient = new Client({
  node: OPENSEARCH_URL,
});

export const INDEX_DOCUMENTS = "documents";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;

const documentsMapping = {
  mappings: {
    properties: {
      file_name: { type: "keyword" },
      content: { type: "text", analyzer: "kuromoji" },
      embedding: {
        type: "knn_vector",
        dimension: EMBEDDING_DIMENSIONS,
        method: {
          name: "hnsw",
          space_type: "cosinesimil",
          engine: "lucene",
        },
      },
    },
  },
  settings: {
    index: {
      number_of_shards: 1,
      number_of_replicas: 0,
      knn: true,
    },
    analysis: {
      analyzer: {
        kuromoji: {
          type: "custom",
          tokenizer: "kuromoji_tokenizer",
          filter: ["kuromoji_baseform", "kuromoji_part_of_speech"],
        },
      },
    },
  },
};

/**
 * テキストをベクトル化する（キャッシュがあればAPIを呼ばない）
 */
export async function getEmbedding(
  openai: OpenAI,
  text: string,
): Promise<number[]> {
  const cached = getCachedEmbedding(text, EMBEDDING_MODEL);
  if (cached) {
    return cached;
  }

  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  const embedding = response.data[0].embedding;
  saveCachedEmbedding(text, EMBEDDING_MODEL, embedding);
  return embedding;
}

/**
 * documents インデックスを作成する（既に存在する場合はスキップ）
 */
export async function setupIndex(): Promise<void> {
  const exists = await opensearchClient.indices.exists({
    index: INDEX_DOCUMENTS,
  });

  if (exists.body) {
    console.log(`Index "${INDEX_DOCUMENTS}" already exists. Skipping.`);
    return;
  }

  await opensearchClient.indices.create({
    index: INDEX_DOCUMENTS,
    body: documentsMapping,
  });
  console.log(`Index "${INDEX_DOCUMENTS}" created.`);
}

const MAX_SEARCH_RESULTS = 3;

/**
 * キーワード検索でドキュメントを検索する（match クエリ）
 */
export async function searchDocumentsByKeyword(
  keywords: string,
): Promise<SearchOutput[]> {
  const response = await opensearchClient.search({
    index: INDEX_DOCUMENTS,
    body: {
      query: {
        match: { content: keywords },
      },
      size: MAX_SEARCH_RESULTS,
    },
  });

  return response.body.hits.hits.map(
    (hit: { _source: { file_name: string; content: string } }) => ({
      file_name: hit._source.file_name,
      content: hit._source.content,
    }),
  );
}

/**
 * knn ベクトル検索でドキュメントを検索する
 */
export async function searchDocuments(
  openai: OpenAI,
  query: string,
): Promise<SearchOutput[]> {
  const queryVector = await getEmbedding(openai, query);

  const response = await opensearchClient.search({
    index: INDEX_DOCUMENTS,
    body: {
      query: {
        knn: {
          embedding: {
            vector: queryVector,
            k: MAX_SEARCH_RESULTS,
          },
        },
      },
      size: MAX_SEARCH_RESULTS,
    },
  });

  return response.body.hits.hits.map(
    (hit: { _source: { file_name: string; content: string } }) => ({
      file_name: hit._source.file_name,
      content: hit._source.content,
    }),
  );
}

/**
 * ドキュメントが既に登録済みか確認する
 */
export async function documentExists(id: string): Promise<boolean> {
  const response = await opensearchClient.exists({
    index: INDEX_DOCUMENTS,
    id,
  });
  return response.body as boolean;
}

/**
 * ドキュメントを1件ベクトル化して登録する（IDを指定して冪等にする）
 */
export async function indexDocument(
  openai: OpenAI,
  doc: SearchOutput,
): Promise<void> {
  const embedding = await getEmbedding(openai, doc.content);

  await opensearchClient.index({
    index: INDEX_DOCUMENTS,
    id: doc.file_name,
    body: {
      ...doc,
      embedding,
    },
    refresh: "wait_for",
  });
}
