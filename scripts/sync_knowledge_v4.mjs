import "dotenv/config";
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { globSync } from "glob";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("❌ Missing OPENAI_API_KEY");
  process.exit(1);
}
const client = new OpenAI({ apiKey });

const KB_DIR = path.resolve("knowledge");
const NAME = process.env.VS_NAME || "Metamorphosis KB";

// Prefer tenant-specific, fall back to default
let vectorStoreId = process.env.VS_METAMORPHOSIS || process.env.VS_DEFAULT;

// 0) Folder check
if (!fs.existsSync(KB_DIR)) {
  console.error("❌ Missing folder:", KB_DIR);
  process.exit(1);
}

// 1) Create vector store if needed
if (!vectorStoreId) {
  const vs = await client.beta.vectorStores.create({ name: NAME });
  vectorStoreId = vs.id;
  console.log("✅ Created vector store:", vectorStoreId, `(${NAME})`);
} else {
  console.log("ℹ️ Using existing vector store:", vectorStoreId);
}

// 2) Collect files
const pattern = `${KB_DIR.replace(/\\/g, "/")}/**/*.{md,txt,pdf}`;
const files = globSync(pattern, { nodir: true }).sort();

console.log("Pattern:", pattern);
console.log("Found:", files.length, "file(s)");

if (files.length === 0) {
  console.log("ℹ️ No files found in", KB_DIR);
  process.exit(0);
}

// 3) Upload & wait for indexing
const streams = files.map(f => fs.createReadStream(f));
const batch = await client.beta.vectorStores.fileBatches.uploadAndPoll(
  vectorStoreId,
  { files: streams }
);
console.log("Batch status:", batch.status);
console.log("Counts:", batch.file_counts);

// 4) Attach to assistant
const assistantId = process.env.ASST_METAMORPHOSIS || process.env.ASST_DEFAULT;
if (assistantId) {
  const updated = await client.beta.assistants.update(assistantId, {
    tools: [{ type: "file_search" }],
    tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } },
  });
  console.log("🔗 Assistant updated:", updated.id);
} else {
  console.warn("⚠️ No ASST_* id in .env; skipping assistant update.");
}

console.log("✅ Vector store ready:", vectorStoreId);
