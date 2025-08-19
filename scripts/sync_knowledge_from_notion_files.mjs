// Sync Notion pages/files into an OpenAI Vector Store
// ---------------------------------------------------
// NOTION DB fields expected (defaults; override via PROP_* envs if needed):
//   file_name (Title), ingest (Checkbox), content_source (Text/Select: 'notion_page'|'file_upload'),
//   file_upload (Files & media), tags (Multi-select), file_version (Text/Select), source_url (URL),
//   indexed_at (Date), last_sync_status (Text/Select), last_error (Text), content_hash (Text), vs_file_id (Text)
//
// Env required:
//   OPENAI_API_KEY=sk-...
//   VECTOR_STORE_ID=vs_...                        # single store (recommended)
//   # or: VECTOR_STORE_IDS=vs_kb,vs_samples       # parallel to NOTION_SOURCES entries
//
// Notion sources (either JSON or simple paired envs):
//   NOTION_SOURCES='[{"name":"knowledge","token":"ntn_...","db_ids":["db_xxx"]}]'
//   # or:
//   NOTION_TOKEN=ntn_...           NOTION_DB_ID=db_xxx,db_yyy
//   NOTION_TOKEN_SAMPLES=ntn_...   NOTION_SAMPLES_DB_ID=db_zzz  (optional)
//
// Run:  node scripts/sync_knowledge_from_notion_files.mjs
// Hook: server route POST /admin/sync-knowledge will spawn this script

import "dotenv/config";
import crypto from "crypto";
import fetch from "node-fetch";
import FormData from "form-data";
import { Client as Notion } from "@notionhq/client";

/* ------------------------- helpers ------------------------- */

const csv = (s) => (s || "").split(",").map(x => x.trim()).filter(Boolean);
const required = (name, v) => {
  if (!v || (Array.isArray(v) && v.length === 0)) throw new Error(`Missing env: ${name}`);
  return v;
};
const sha256 = (text) => "sha256:" + crypto.createHash("sha256").update(text, "utf8").digest("hex");
const nowIso = () => new Date().toISOString();

/* ------------------------- config ------------------------- */

const OPENAI_API_KEY = required("OPENAI_API_KEY", process.env.OPENAI_API_KEY);

// Sources: JSON or paired envs
let sources;
if (process.env.NOTION_SOURCES) {
  sources = JSON.parse(process.env.NOTION_SOURCES);
} else {
  const primary = { name: "knowledge", token: process.env.NOTION_TOKEN, db_ids: csv(process.env.NOTION_DB_ID) };
  const samples = { name: "samples", token: process.env.NOTION_TOKEN_SAMPLES || process.env.NOTION_TOKEN, db_ids: csv(process.env.NOTION_SAMPLES_DB_ID) };
  sources = [primary, samples].filter(s => s.token && s.db_ids.length);
}
if (!sources.length) throw new Error("No Notion sources configured.");

// Vector store mapping
const VS_ID  = process.env.VECTOR_STORE_ID;
const VS_IDS = csv(process.env.VECTOR_STORE_IDS);
const pickStore = (i) => VS_ID || (VS_IDS.length > i ? VS_IDS[i] : VS_IDS[0]);
sources = sources.map((s, i) => ({ ...s, vector_store_id: required("VECTOR_STORE_ID(S)", pickStore(i)) }));

// ---------- Notion property names (allow overrides) ----------
const PROP = {
  FILE_NAME:      process.env.PROP_FILE_NAME      || "file_name",
  INGEST:         process.env.PROP_INGEST         || "ingest",
  CONTENT_SOURCE: process.env.PROP_CONTENT_SOURCE || "content_source",
  FILE_UPLOAD:    process.env.PROP_FILE_UPLOAD    || "file_upload",
  TAGS:           process.env.PROP_TAGS           || "tags",
  VERSION:        process.env.PROP_VERSION        || "file_version",
  SOURCE_URL:     process.env.PROP_SOURCE_URL     || "source_url",
  INDEXED_AT:     process.env.PROP_INDEXED_AT     || "indexed_at",
  STATUS:         process.env.PROP_STATUS         || "last_sync_status",
  ERROR:          process.env.PROP_ERROR          || "last_error",
  HASH:           process.env.PROP_HASH           || "content_hash",
  VS_FILE_ID:     process.env.PROP_VS_FILE_ID     || "vs_file_id",
};
// ---------- end mapping ----------

/* ------------------------- OpenAI helpers ------------------------- */

const OA_BASE = "https://api.openai.com/v1";

async function uploadTextAsFile(text, filename) {
  const form = new FormData();
  form.append("file", Buffer.from(text, "utf8"), { filename, contentType: "text/markdown" });
  form.append("purpose", "assistants");

  const res = await fetch(`${OA_BASE}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...form.getHeaders() },
    body: form,
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Upload file failed: ${res.status} ${JSON.stringify(j)}`);
  return j; // { id, filename, ... }
}

async function addFileToVectorStore(vectorStoreId, fileId) {
  const res = await fetch(`${OA_BASE}/vector_stores/${vectorStoreId}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Add to vector store failed: ${res.status} ${JSON.stringify(j)}`);
  return j; // { id, file_id, ... }
}

async function deleteVectorStoreFile(vectorStoreId, vsFileIdOrFileId) {
  try {
    await fetch(`${OA_BASE}/vector_stores/${vectorStoreId}/files/${vsFileIdOrFileId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    });
  } catch { /* best-effort */ }
}

/* ------------------------- Notion helpers ------------------------- */

function textFromRich(maybeRich) {
  if (!maybeRich) return "";
  if (Array.isArray(maybeRich)) return maybeRich.map(r => r?.plain_text || "").join("");
  return String(maybeRich || "");
}

function getProp(page, name) {
  const p = page.properties?.[name];
  if (!p) return undefined;
  switch (p.type) {
    case "title":        return textFromRich(p.title);
    case "rich_text":    return textFromRich(p.rich_text);
    case "url":          return p.url || "";
    case "select":       return p.select?.name || "";
    case "multi_select": return p.multi_select?.map(o => o.name) || [];
    case "checkbox":     return !!p.checkbox;
    case "date":         return p.date?.start || "";
    case "files":        return p.files || [];
    case "number":       return p.number;
    default:             return undefined;
  }
}

function setPropUpdate(name, type, value) {
  switch (type) {
    case "date":   return { [name]: { date: value ? { start: value } : null } };
    case "text":   return { [name]: { rich_text: value ? [{ type: "text", text: { content: String(value).slice(0, 2000) } }] : [] } };
    case "select": return { [name]: { select: value ? { name: value } : null } };
    default:       return {};
  }
}

async function fetchAllPages(notion, dbId) {
  let hasMore = true, cursor, out = [];
  while (hasMore) {
    const r = await notion.databases.query({ database_id: dbId, start_cursor: cursor });
    out.push(...r.results);
    hasMore = r.has_more;
    cursor = r.next_cursor || undefined;
  }
  return out;
}

async function fetchBlocksToMarkdown(notion, blockId) {
  const lines = [];
  let cursor, hasMore = true;
  while (hasMore) {
    const r = await notion.blocks.children.list({ block_id: blockId, start_cursor: cursor });
    for (const b of r.results) {
      const t = b.type;
      const rich = b[t]?.rich_text;
      const txt = textFromRich(rich);
      if (t?.startsWith("heading_") && txt) {
        const level = t === "heading_1" ? 1 : (t === "heading_2" ? 2 : 3);
        lines.push("#".repeat(level) + " " + txt);
      } else if (t === "paragraph" && txt) {
        lines.push(txt);
      } else if (t === "bulleted_list_item" && txt) {
        lines.push("- " + txt);
      } else if (t === "numbered_list_item" && txt) {
        lines.push("1. " + txt);
      }
      if (b.has_children) {
        const child = await fetchBlocksToMarkdown(notion, b.id);
        if (child) lines.push(child);
      }
    }
    hasMore = r.has_more;
    cursor = r.next_cursor || undefined;
  }
  return lines.filter(Boolean).join("\n");
}

async function downloadNotionFile(fileObj) {
  const url = fileObj?.external?.url || fileObj?.file?.url;
  if (!url) return "";
  const res = await fetch(url);
  if (!res.ok) return "";
  return await res.text();
}

/* ------------------------- main sync ------------------------- */

async function processSource(source) {
  const notion = new Notion({ auth: source.token });
  const vsId = source.vector_store_id;

  console.log(`[sync] Source '${source.name}' → VS ${vsId}; DBs: ${source.db_ids.join(", ")}`);

  for (const dbId of source.db_ids) {
    const pages = await fetchAllPages(notion, dbId);
    console.log(`  - DB ${dbId}: ${pages.length} pages`);

    for (const page of pages) {
      const pageId = page.id;
      const title   = getProp(page, PROP.FILE_NAME) || "(untitled)";
      const ingest  = getProp(page, PROP.INGEST); // boolean (or undefined)
      const tags    = getProp(page, PROP.TAGS) || [];
      const version = getProp(page, PROP.VERSION) || "";
      const srcUrl  = getProp(page, PROP.SOURCE_URL) || "";
      const contentSource = (getProp(page, PROP.CONTENT_SOURCE) || "notion_page").toLowerCase();

      if (ingest === false) {
        // mark skipped (best-effort)
        await notion.pages.update({
          page_id: pageId,
          properties: {
            ...setPropUpdate(PROP.STATUS, "select", "skipped"),
            ...setPropUpdate(PROP.ERROR, "text", ""),
          }
        }).catch(()=>{});
        continue;
      }

      try {
        // 1) Extract text
        let text = "";
        if (contentSource === "file_upload") {
          const files = getProp(page, PROP.FILE_UPLOAD) || [];
          if (files.length) {
            text = await downloadNotionFile(files[0]);
          } else {
            text = await fetchBlocksToMarkdown(notion, pageId);
          }
        } else {
          text = await fetchBlocksToMarkdown(notion, pageId);
        }
        if (!text || !text.trim()) throw new Error("No text content extracted");

        // 2) Change detection
        const hash = sha256(text);
        const prevHash = getProp(page, PROP.HASH) || "";
        if (prevHash && prevHash === hash) {
          await notion.pages.update({
            page_id: pageId,
            properties: {
              ...setPropUpdate(PROP.STATUS, "select", "ok"),
              ...setPropUpdate(PROP.ERROR, "text", ""),
            }
          }).catch(()=>{});
          continue; // unchanged, skip upload
        }

        // 3) Replace previous VS file if known
        const prevVsFileId = getProp(page, PROP.VS_FILE_ID) || "";
        if (prevVsFileId) await deleteVectorStoreFile(vsId, prevVsFileId);

        // 4) Upload (with a tiny front-matter header for better retrieval)
        const filename = `${title.replace(/[^\w.-]+/g, "_")}${version ? "." + version : ""}.md`;
        const header = [
          '---',
          `title: ${title}`,
          version ? `version: ${version}` : null,
          tags?.length ? `tags: ${tags.join(', ')}` : null,
          srcUrl ? `source_url: ${srcUrl}` : null,
          `page_id: ${pageId}`,
          `synced_at: ${nowIso()}`,
          '---',
          ''
        ].filter(Boolean).join('\n');

        const upload = await uploadTextAsFile(header + text, filename);
        const vsFile = await addFileToVectorStore(vsId, upload.id);

        // 5) Write back success
        await notion.pages.update({
          page_id: pageId,
          properties: {
            ...setPropUpdate(PROP.INDEXED_AT, "date", nowIso()),
            ...setPropUpdate(PROP.STATUS, "select", "ok"),
            ...setPropUpdate(PROP.ERROR, "text", ""),
            ...setPropUpdate(PROP.HASH, "text", hash),
            ...setPropUpdate(PROP.VS_FILE_ID, "text", vsFile.id || ""),
          }
        });

      } catch (e) {
        const msg = (e && e.message) ? e.message.slice(0, 1900) : String(e).slice(0, 1900);
        console.error(`[sync] ERROR page ${pageId} (${title}):`, msg);
        await notion.pages.update({
          page_id: pageId,
          properties: {
            ...setPropUpdate(PROP.STATUS, "select", "error"),
            ...setPropUpdate(PROP.ERROR, "text", msg),
          }
        }).catch(()=>{});
      }
    }
  }
}

(async () => {
  console.log("[sync] Starting Notion → Vector Store sync");
  console.log("[sync] Sources:", sources.map(s => ({ name: s.name, dbs: s.db_ids.length, vs: s.vector_store_id })));
  for (const src of sources) {
    await processSource(src);
  }
  console.log("[sync] Complete");
})();
