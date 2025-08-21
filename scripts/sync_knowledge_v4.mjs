// scripts/sync_knowledge_v4.mjs
import dotenv from "dotenv";
dotenv.config({ path: ".env", override: true });

import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { globSync } from "glob";
import { Client as NotionClient } from "@notionhq/client";
import { toFile } from "openai/uploads";

// ---------- OpenAI ----------
if (!process.env.OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY");
  process.exit(1);
}
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------- Paths & IDs ----------
const KB_DIR = path.resolve("knowledge");
const NAME = process.env.VS_NAME || "Metamorphosis KB";
let vectorStoreId = process.env.VS_METAMORPHOSIS || process.env.VS_DEFAULT;

// ---------- Notion ----------
const NOTION_TOKEN = process.env.NOTION_TOKEN || "";
const NOTION_DB_ID = process.env.NOTION_DB_ID || "";
const notion = NOTION_TOKEN ? new NotionClient({ auth: NOTION_TOKEN }) : null;

const PROP_TITLE      = process.env.NOTION_TITLE_PROP      || "Name";              // Title
const PROP_VERSION    = process.env.NOTION_VERSION_PROP    || "file_version";      // Select
const PROP_FILE_NAME  = process.env.NOTION_FILE_NAME_PROP  || "file_name";         // Rich text
const PROP_SOURCE_URL = process.env.NOTION_SOURCE_URL_PROP || "source_url";        // URL
const PROP_HASH       = process.env.NOTION_HASH_PROP       || "content_hash";      // Rich text
const PROP_INDEXED_AT = process.env.NOTION_INDEXED_AT_PROP || "indexed_at";        // Date
const PROP_LAST_SYNC  = process.env.NOTION_LAST_SYNC_PROP  || "last_sync_status";  // Date

let NOTION_DB_PROPS = new Set(); // populated in preflight

// ---------- Helpers ----------
function toSha1(fp) {
  const h = crypto.createHash("sha1");
  h.update(fs.readFileSync(fp));
  return h.digest("hex");
}
function titleKey(fp) {
  return path.basename(fp, path.extname(fp)); // name without extension
}
function rt(s) {
  return [{ type: "text", text: { content: s || "" } }];
}
function notionDateNow() {
  return { start: new Date().toISOString() };
}
function safeGetRichTextPlain(page, prop) {
  const v = page.properties?.[prop];
  const a = v?.type === "rich_text" ? v.rich_text : [];
  return a?.[0]?.plain_text || "";
}
function safeGetSelectName(page, prop) {
  const v = page.properties?.[prop];
  return v?.type === "select" ? v.select?.name || "" : "";
}
function parseVn(s) {
  const m = /^v(\d+)$/.exec(s || "");
  return m ? parseInt(m[1], 10) : 0;
}

// Ensure "vN" exists as a select option
async function ensureVersionOption(versionName) {
  if (!notion || !NOTION_DB_ID) return;
  const db = await notion.databases.retrieve({ database_id: NOTION_DB_ID });
  const prop = db.properties?.[PROP_VERSION];
  if (!prop || prop.type !== "select") return;

  const existing = new Set((prop.select?.options || []).map(o => o.name));
  if (existing.has(versionName)) return;

  const newOptions = [...(prop.select?.options || []), { name: versionName, color: "default" }];
  await notion.databases.update({
    database_id: NOTION_DB_ID,
    properties: { [PROP_VERSION]: { select: { options: newOptions } } },
  });
}

// Upsert page by Name (without extension)
async function upsertNotionByTitle(notionTitle) {
  const q = await notion.databases.query({
    database_id: NOTION_DB_ID,
    filter: { property: PROP_TITLE, title: { equals: notionTitle } },
    page_size: 1,
  });
  if (q.results.length) return q.results[0];
  return await notion.pages.create({
    parent: { database_id: NOTION_DB_ID },
    properties: { [PROP_TITLE]: { title: [{ text: { content: notionTitle } }] } },
  });
}

// Map filename -> file_id in vector store
async function mapVsFilenamesToIds(vsId) {
  const map = new Map();
  let after;
  do {
    const page = await client.vectorStores.files.list(vsId, {
      limit: 100, ...(after ? { after } : {}),
    });
    for (const vsFile of page.data) {
      const meta = await client.files.retrieve(vsFile.id);
      map.set(meta.filename, vsFile.id);
    }
    after = page.has_more ? page.last_id : undefined;
  } while (after);
  return map;
}

// Notion preflight
async function notionPreflightStrict() {
  if (!notion) throw new Error("NOTION_TOKEN missing");
  if (!NOTION_DB_ID) throw new Error("NOTION_DB_ID missing");
  const me = await notion.users.me();
  console.log(`🔑 Notion bot workspace: ${me.bot?.workspace_name || me.name}`);
  const db = await notion.databases.retrieve({ database_id: NOTION_DB_ID });
  NOTION_DB_PROPS = new Set(Object.keys(db.properties || {}));
  console.log(`✅ Notion DB reachable: ${db.id}`);
}

// ---------- Start ----------
if (!fs.existsSync(KB_DIR)) {
  console.error("❌ Missing folder:", KB_DIR);
  process.exit(1);
}

const pattern = `${KB_DIR.replace(/\\/g, "/")}/**/*.{md,txt,pdf}`;
const files = globSync(pattern, { nodir: true }).sort();
console.log("Pattern:", pattern);
console.log("Found:", files.length, "file(s)");
if (!files.length) process.exit(0);

// Create vector store if needed
if (!vectorStoreId) {
  const vs = await client.vectorStores.create({ name: NAME });
  vectorStoreId = vs.id;
  console.log("✅ Created vector store:", vectorStoreId, `(${NAME})`);
} else {
  console.log("ℹ️ Using existing vector store:", vectorStoreId);
}

// Notion preflight (non-fatal)
try {
  await notionPreflightStrict();
} catch (e) {
  console.warn("⚠️ Notion preflight:", e?.message || e);
}

// ---- PASS 1: decide versions per file (hash diff) ----
const plan = [];
if (notion && NOTION_DB_ID) {
  for (const fp of files) {
    const nameNoExt = titleKey(fp);
    const ext = path.extname(fp) || "";
    const hash = toSha1(fp);

    // Find/create page
    const page = await upsertNotionByTitle(nameNoExt);

    const prevHash = safeGetRichTextPlain(page, PROP_HASH);
    const prevVerName = safeGetSelectName(page, PROP_VERSION);
    const prevN = parseVn(prevVerName);

    const changed = !prevHash || prevHash !== hash;
    const finalN = prevN >= 1 ? (changed ? prevN + 1 : prevN) : 1; // start v1; bump on change
    const verName = `v${finalN}`;

    try { await ensureVersionOption(verName); } catch {}

    const displayName = `${nameNoExt}_${verName}`;     // Notion "file_name"
    const uploadName  = `${nameNoExt}_${verName}${ext}`; // OpenAI filename

    plan.push({ fp, nameNoExt, ext, hash, pageId: page.id, verName, displayName, uploadName });
  }
} else {
  // No Notion → default v1
  for (const fp of files) {
    const nameNoExt = titleKey(fp);
    const ext = path.extname(fp) || "";
    const verName = "v1";
    plan.push({
      fp, nameNoExt, ext, hash: toSha1(fp),
      pageId: null, verName, displayName: `${nameNoExt}_${verName}`,
      uploadName: `${nameNoExt}_${verName}${ext}`,
    });
  }
}

// ---- PASS 2: upload to VS using versioned filenames ----
const uploadables = await Promise.all(
  plan.map(p => toFile(fs.createReadStream(p.fp), p.uploadName))
);

const batch = await client.vectorStores.fileBatches.uploadAndPoll(
  vectorStoreId,
  { files: uploadables }
);

console.log("Batch status:", batch.status);
if (batch.file_counts) console.log("Batch counts:", batch.file_counts);

// Attach VS to assistant (stable-or-beta safe)
const assistantId = process.env.ASST_METAMORPHOSIS || process.env.ASST_DEFAULT;
const asstClient =
  (client.assistants && typeof client.assistants.update === "function")
    ? client.assistants
    : (client.beta?.assistants);

if (assistantId && asstClient?.update) {
  try {
    const updated = await asstClient.update(assistantId, {
      tools: [{ type: "file_search" }],
      tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } },
    });
    console.log("🔗 Assistant updated:", updated.id);
  } catch (e) {
    console.warn("⚠️ Assistant update failed:", e?.message || e);
  }
} else {
  console.warn("⚠️ Assistants API not available on this SDK; skipped assistant update.");
}

// ---- PASS 3: write back to Notion (version, file_name, urls, hashes, dates) ----
try {
  if (notion && NOTION_DB_ID) {
    const idByFilename = await mapVsFilenamesToIds(vectorStoreId);
    const has = (prop) => NOTION_DB_PROPS.has(prop);

    for (const p of plan) {
      if (!p.pageId) continue;

      const fileId    = idByFilename.get(p.uploadName);
      const openAiUrl = fileId ? `openai://file/${fileId}` : null;

      const props = {};
      if (has(PROP_VERSION))    props[PROP_VERSION]    = { select: { name: p.verName } };
      if (has(PROP_FILE_NAME))  props[PROP_FILE_NAME]  = { rich_text: rt(p.displayName) };
      if (has(PROP_SOURCE_URL)) props[PROP_SOURCE_URL] = { url: openAiUrl || null };
      if (has(PROP_HASH))       props[PROP_HASH]       = { rich_text: rt(p.hash) };
      if (has(PROP_INDEXED_AT)) props[PROP_INDEXED_AT] = { date: notionDateNow() };
      if (has(PROP_LAST_SYNC))  props[PROP_LAST_SYNC]  = { date: notionDateNow() };

      if (Object.keys(props).length) {
        await notion.pages.update({ page_id: p.pageId, properties: props });
      }
    }

    console.log("📝 Notion version + filename + metadata updated for", plan.length, "file(s).");
  } else {
    console.warn("⚠️ Notion unavailable; skipped Notion writes.");
  }
} catch (e) {
  console.warn("⚠️ Notion update skipped:", e?.body?.message || e?.message || e);
}

// Pretty-print: id → filename
try {
  const idByFilename = await mapVsFilenamesToIds(vectorStoreId);
  console.log("📄 Vector store files (id → filename):");
  for (const [name, id] of [...idByFilename.entries()].map(([k, v]) => [k, v])) {
    console.log(`  ${id}  ${name}`);
  }
} catch (e) {
  console.warn("⚠️ Could not list files:", e?.message || e);
}

console.log("✅ Vector store ready:", vectorStoreId);
