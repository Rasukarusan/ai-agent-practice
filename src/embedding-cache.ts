import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

interface EmbeddingCacheEntry {
  text_hash: string;
  model: string;
  embedding: number[];
}

interface EmbeddingCacheData {
  [key: string]: EmbeddingCacheEntry;
}

const CACHE_PATH = "data/embeddings-cache.json";

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function loadCache(): EmbeddingCacheData {
  if (!existsSync(CACHE_PATH)) return {};
  const raw = readFileSync(CACHE_PATH, "utf-8");
  return JSON.parse(raw) as EmbeddingCacheData;
}

function saveCache(cache: EmbeddingCacheData): void {
  const dir = dirname(CACHE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
}

/**
 * キャッシュから embedding を取得する。なければ undefined。
 */
export function getCachedEmbedding(
  text: string,
  model: string,
): number[] | undefined {
  const cache = loadCache();
  const hash = hashText(text);
  const entry = cache[hash];
  if (entry && entry.model === model) {
    return entry.embedding;
  }
  return undefined;
}

/**
 * embedding をキャッシュに保存する。
 */
export function saveCachedEmbedding(
  text: string,
  model: string,
  embedding: number[],
): void {
  const cache = loadCache();
  const hash = hashText(text);
  cache[hash] = { text_hash: hash, model, embedding };
  saveCache(cache);
}
