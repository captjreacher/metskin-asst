import "dotenv/config";
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { globSync } from "glob";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY");
  process.exit(1);
}

const KB_DIR = path.resolve("knowledge");
const NAME = process.env.VS_NAME || "Metamorphosis KB";

let vectorStoreId = process.env.VS_METAMORPHOSIS || process.env.VS_DEFAULT;

if (!fs.existsSync(KB_DIR)) {
  console.error("❌ Missing folder:", KB_DIR);
  process.exit(1);
}

if (!vectorStoreId) {
  const vs = await client.vectorStores.create({ name: NAME });
  vectorStoreId = vs.id;
  console.log("✅ Created vector store:", vectorStoreId, `(${NAME})`);
} else {
  console.log("ℹ️ Using existing vector store:", vectorStoreId);
}

const pattern = `${KB_DIR.replace(/\\/g, "/")}/**/*.{md,txt,pdf}`;
const files = globSync(pattern, { nodir: true }).sort();

console.log("Pattern:", pattern);
console.log("Found:", files.length, "file(s)");
if (!files.length) process.exit(0);

// ⬇️ The important change is `{ files: [...] }`
const batch = await client.vectorStores.fileBatches.uploadAndPoll(
  vectorStoreId,
  { files: files.map(f => fs.createReadStream(f)) }
);

console.log("Batch status:", batch.status);
if (batch.file_counts) console.log("Counts:", batch.file_counts);

const assistantId = process.env.ASST_METAMORPHOSIS || process.env.ASST_DEFAULT;
if (assistantId) {
  try {
    const updated = await client.assistants.update(assistantId, {
      tools: [{ type: "file_search" }],
      tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } },
    });
    console.log("🔗 Assistant updated:", updated.id);
  } catch (e) {
    console.warn("⚠️ Assistant update skipped:", e?.message || e);
  }
} else {
  console.warn("⚠️ No ASST_* id in .env; skipping assistant update.");
}

console.log("✅ Vector store ready:", vectorStoreId);
