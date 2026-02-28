import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import { PDFParse } from "pdf-parse";
import type { SearchOutput } from "./models.js";

const CHUNK_SIZE = 300;
const CHUNK_OVERLAP = 20;

/**
 * テキストを指定サイズのチャンクに分割する（オーバーラップあり）
 */
function splitIntoChunks(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = start + CHUNK_SIZE;
    chunks.push(text.slice(start, end));
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

/**
 * 指定ディレクトリ内のPDFファイルを読み込み、チャンク分割してドキュメント配列として返す
 */
export async function loadPdfDocuments(
  dirPath: string,
): Promise<SearchOutput[]> {
  const files = readdirSync(dirPath).filter((f) => f.endsWith(".pdf"));
  const documents: SearchOutput[] = [];

  for (const fileName of files) {
    const filePath = join(dirPath, fileName);
    const buffer = readFileSync(filePath);
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    const text = result.text.replace(/\s+/g, " ").trim();
    const chunks = splitIntoChunks(text);

    for (const chunk of chunks) {
      documents.push({ file_name: fileName, content: chunk });
    }
  }

  return documents;
}

/**
 * 指定ディレクトリ内のCSVファイルを読み込み、Q&Aペアのドキュメント配列として返す
 */
export function loadCsvDocuments(dirPath: string): SearchOutput[] {
  const files = readdirSync(dirPath).filter((f) => f.endsWith(".csv"));
  const documents: SearchOutput[] = [];

  for (const fileName of files) {
    const filePath = join(dirPath, fileName);
    const content = readFileSync(filePath, "utf-8");
    const records: string[][] = parse(content, {
      columns: false,
      skip_empty_lines: true,
      from_line: 2,
    });

    for (const record of records) {
      const [q, a] = record;
      if (q && a) {
        documents.push({
          file_name: fileName,
          content: `Q: ${q}\nA: ${a}`,
        });
      }
    }
  }

  return documents;
}
