// node scripts/sync-knowledge.mjs
import "dotenv/config";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ASSISTANT_ID = process.env.ASSISTANT_ID;
const LOCAL_DIR = path.resolve("knowledge");   // your local folder
const VECTOR_STORE_NAME = "metamorphosis-prod";

async function main() {
  // 1) Create (or reuse) a vector store
  const vs = await openai.beta.vectorStores.create({ name: VECTOR_STORE_NAME });

  // 2) Upload all files from /knowledge
  const files = fs.readdirSync(LOCAL_DIR).map(f => path.join(LOCAL_DIR, f));
  const batch = await openai.beta.vectorStores.fileBatches.uploadAndPoll(vs.id, {
    files: files.map(f => fs.createReadStream(f))
  });
  console.log("Uploaded:", batch);

  // 3) Attach the vector store to your assistant
  await openai.beta.assistants.update(ASSISTANT_ID, {
    tool_resources: { file_search: { vector_store_ids: [vs.id] } }
  });
  console.log("Attached vector store to assistant:", vs.id);
}

main().catch(e => { console.error(e); process.exit(1); });
