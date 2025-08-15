// scripts/sync_knowledge.mjs
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { glob } from "glob";

const { OPENAI_API_KEY, ASST_DEFAULT, VS_DEFAULT } = process.env;
if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
if (!ASST_DEFAULT) throw new Error("ASST_DEFAULT missing");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function ensureVectorStore(name = "metskin-knowledge") {
  if (VS_DEFAULT) {
    try { return await openai.beta.vectorStores.retrieve(VS_DEFAULT); }
    catch { /* fall through and create */ }
  }
  return await openai.beta.vectorStores.create({ name });
}

async function uploadFiles(vectorStoreId, files) {
  const batch = await openai.beta.vectorStores.fileBatches.uploadAndPoll(
    vectorStoreId,
    { files: files.map(f => fs.createReadStream(f)) }
  );
  if (batch.status !== "completed") {
    console.error("Upload status:", batch.status, batch);
    throw new Error("Vector store upload failed");
  }
  return batch;
}

async function attachStoreToAssistant(assistantId, vectorStoreId) {
  const asst = await openai.beta.assistants.retrieve(assistantId);
  const tools = asst.tools || [];
  const resources = asst.tool_resources || {};
  const current = new Set(resources?.file_search?.vector_store_ids || []);
  if (!current.has(vectorStoreId)) {
    await openai.beta.assistants.update(assistantId, {
      tools: [...tools, { type: "file_search" }],
      tool_resources: { file_search: { vector_store_ids: [...current, vectorStoreId] } },
    });
  }
}

(async () => {
  const root = path.resolve(process.cwd(), "knowledge");
  const patterns = ["**/*.md", "**/*.txt", "**/*.csv", "**/*.yaml", "**/*.yml"];
  const files = (await Promise.all(patterns.map(p => glob(p, { cwd: root, nodir: true }))))
    .flat().map(f => path.join(root, f));

  if (files.length === 0) { console.log("No knowledge files found in:", root); process.exit(0); }

  const vs = await ensureVectorStore("metskin-knowledge");
  console.log("Vector Store:", vs.id);

  await uploadFiles(vs.id, files);
  console.log(`Uploaded ${files.length} files.`);

  await attachStoreToAssistant(process.env.ASST_DEFAULT, vs.id);
  console.log("Attached store to assistant:", process.env.ASST_DEFAULT);

  console.log("\nAdd/update in your .env:\nVS_DEFAULT=" + vs.id);
})();
