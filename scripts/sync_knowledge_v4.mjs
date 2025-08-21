// scripts/sync_knowledge_v4.mjs
import "dotenv/config";
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { globSync } from "glob";
import crypto from "node:crypto";
import { Client as NotionClient } from "@notionhq/client";

// -------------------- OpenAI setup --------------------
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY");
  process.exit(1);
}
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// -------------------- Paths & IDs ---------------------
const KB_DIR = path.resolve("knowledge");
const NAME = process.env.VS_NAME || "Metamorphosis KB";
let vectorStoreId = process.env.VS_METAMORPHOSIS || process.env.VS_DEFAULT;

// -------------------- Notion setup -------------------
const NOTION_TOKEN = process.env.NOTION_TOKEN || "";
const NOTION_DB_ID = process.env.NOTION_DB_ID || "";
const NOTION_TITLE_PROP = process.env.NOTION_TITLE_PROP || "Name";
const notion = NOTION_TOKEN ? new NotionClient({ auth: NOTION_TOKEN }) : null;

// Small helpers
function sha1File(fp) {
  const h = crypto.createHash("sha1");
  h.update(fs.readFileSync(fp));
  return h.digest("hex");
}
function rt(s) {
  return [{ type: "text", text: { content: s || "" } }];
}
function notionDateNow() {
  return { start: new Date().toISOString() };
}

// -------------------- Preflight ----------------------
if (!fs.existsSync(KB_DIR)) {
  console.error("❌ Missing folder:", KB_DIR);
  process.exit(1);
}

// Optional Notion preflight (don’t crash; just warn and skip writes)
async function notionPreflight() {
  if (!notion || !NOTION_DB_ID) {
    console.warn("⚠️ NOTION_TOKEN/NOTION_DB_ID missing; skip Notion updates.");
    return false;
    }
  try {
    await notion.databases.retrieve({ database_id: NOTION_DB_ID });
    return true;
  } catch (e) {
    console.warn("⚠️ Notion preflight failed:", e?.body?.message || e?.message || e);
    return false;
  }
}

// Upsert Notion page by title
async function upsertNotionByTitle(title) {
  const q = await notion.databases.query({
    database_id: NOTION_DB_ID,
    filter: { property: NOTION_TITLE_PROP, title: { equals: title } },
    page_size: 1,
  });
  if (q.results.length) return q.results[0];
  return await notion.pages.create({
    parent: { database_id: NOTION_DB_ID },
    properties: { [NOTION_TITLE_PROP]: { title: [{ text: { content: title } }] } },
  });
}

// List all files in the vector store and map filename -> file_id
async function mapVsFilenamesToIds(vsId) {
  const map = new Map();
  let after;
  do {
    const page = await client.vectorStores.files.list(vsId, {
      limit: 100,
      ...(after ? { after } : {}),
    });
    for (const vsFile of page.data) {
      const meta = await client.files.retrieve(vsFile.id);
      map.set(meta.filename, vsFile.id);
    }
    after = page.has_more ? page.last_id : undefined;
  } while (after);
  return map;
}

// -------------------- Main ---------------------------
const pattern = `${KB_DIR.replace(/\\/g, "/")}/**/*.{md,txt,pdf}`;
const files = globSync(pattern, { nodir: true }).sort();

console.log("Pattern:", pattern);
console.log("Found:", files.length, "file(s)");
if (!files.length) process.exit(0);

// Create vector store if needed (stable path)
if (!vectorStoreId) {
  const vs = await client.vectorStores.create({ name: NAME });
  vectorStoreId = vs.id;
  console.log("✅ Created vector store:", vectorStoreId, `(${NAME})`);
} else {
  console.log("ℹ️ Using existing vector store:", vectorStoreId);
}

// Upload & index (stable path); IMPORTANT: pass { files: [...] }
const batch = await client.vectorStores.fileBatches.uploadAndPoll(
  vectorStoreId,
  { files: files.map((f) => fs.createReadStream(f)) }
);

// We already waited; print what we got
console.log("Batch status:", batch.status);
if (batch.file_counts) console.log("Batch counts:", batch.file_counts);

// Attach VS to assistant (stable path)
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

// Pretty-print id → filename table
try {
  const idByName = await mapVsFilenamesToIds(vectorStoreId);
  console.log("📄 Vector store files (id → filename):");
  for (const [name, id] of [...idByName.entries()].map(([k, v]) => [k, v])) {
    // flip for display: id first, then name
    console.log(`  ${id}  ${name}`);
  }
} catch (e) {
  console.warn("⚠️ Could not list files:", e?.message || e);
}

// Notion updates (best-effort)
const canWriteNotion = await notionPreflight();
if (canWriteNotion) {
  try {
    const idByName = await mapVsFilenamesToIds(vectorStoreId);
    for (const filePath of files) {
      const title = path.basename(filePath);
      const hash = sha1File(filePath);
      const fileId = idByName.get(title);
      const openAiUrl = fileId ? `openai://file/${fileId}` : null;

      const page = await upsertNotionByTitle(title);
      await notion.pages.update({
        page_id: page.id,
        properties: {
          source_url: { url: openAiUrl || null },                 // URL
          last_sync_status: { date: notionDateNow() },            // Date
          indexed_at: { date: notionDateNow() },                  // Date
          content_hash: { rich_text: rt(hash) },                  // Rich text
          last_error: { rich_text: rt("") },                      // Rich text
        },
      });
    }
    console.log("📝 Notion fields updated for", files.length, "file(s).");
  } catch (e) {
    console.warn("⚠️ Notion update skipped:", e?.body?.message || e?.message || e);
  }
}

console.log("✅ Vector store ready:", vectorStoreId);
