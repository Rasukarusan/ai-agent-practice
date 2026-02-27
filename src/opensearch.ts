import { Client } from "@opensearch-project/opensearch";
import type { SearchOutput } from "./models.js";

const OPENSEARCH_URL = process.env.OPENSEARCH_URL ?? "http://localhost:9200";

export const opensearchClient = new Client({
  node: OPENSEARCH_URL,
});

export const INDEX_DOCUMENTS = "documents";

const documentsMapping = {
  mappings: {
    properties: {
      file_name: { type: "keyword" },
      content: { type: "text", analyzer: "kuromoji" },
    },
  },
  settings: {
    index: {
      number_of_shards: 1,
      number_of_replicas: 0,
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

/**
 * OpenSearch の documents インデックスを検索する
 */
export async function searchDocuments(query: string): Promise<SearchOutput[]> {
  const response = await opensearchClient.search({
    index: INDEX_DOCUMENTS,
    body: {
      query: {
        match: {
          content: query,
        },
      },
      size: 5,
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
 * ドキュメントを1件登録する
 */
export async function indexDocument(doc: SearchOutput): Promise<void> {
  await opensearchClient.index({
    index: INDEX_DOCUMENTS,
    body: doc,
    refresh: "wait_for",
  });
}
