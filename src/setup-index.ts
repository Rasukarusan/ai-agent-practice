import { join } from "node:path";
import OpenAI from "openai";
import { loadSettings } from "./config.js";
import { loadCsvDocuments, loadPdfDocuments } from "./load-documents.js";
import { documentExists, indexDocument, setupIndex } from "./opensearch.js";

const DATA_DIR = join(import.meta.dirname, "..", "data");

async function main() {
  const settings = loadSettings();
  const openai = new OpenAI({
    apiKey: settings.openai_api_key,
    baseURL: settings.openai_api_base,
  });

  await setupIndex();

  console.log("Loading documents from data/ ...");
  const pdfDocs = await loadPdfDocuments(DATA_DIR);
  const csvDocs = loadCsvDocuments(DATA_DIR);
  const allDocs = [...pdfDocs, ...csvDocs];
  console.log(`  PDF chunks: ${pdfDocs.length}, CSV rows: ${csvDocs.length}`);

  console.log("Indexing documents (with embeddings)...");
  for (let i = 0; i < allDocs.length; i++) {
    const doc = allDocs[i];
    const docId = `${doc.file_name}-${i}`;

    if (await documentExists(docId)) {
      console.log(`  Skipped (already exists): ${docId}`);
      continue;
    }
    await indexDocument(openai, doc, docId);
    console.log(`  Indexed: ${docId}`);
  }
  console.log(`Done. Total: ${allDocs.length} documents indexed.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Failed to setup index:", err);
    process.exit(1);
  });
