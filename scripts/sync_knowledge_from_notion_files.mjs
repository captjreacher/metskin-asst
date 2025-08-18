import "dotenv/config";

const {
  OPENAI_API_KEY,
  ASST_DEFAULT,
  NOTION_TOKEN,
  NOTION_DB_ID,
  VS_DEFAULT
} = process.env;

if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY missing");
if (!ASST_DEFAULT)   throw new Error("ASST_DEFAULT missing");
if (!NOTION_TOKEN)   throw new Error("NOTION_TOKEN missing");
if (!NOTION_DB_ID)   throw new Error("NOTION_DB_ID missing");

const OPENAI_API = "https://api.openai.com/v1";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// --- helpers ---
async function ofetch(url, opts={}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      ...(opts.headers || {})
    }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text().catch(()=> "")}`);
  return res;
}

async function nfetch(url, opts={}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      "Authorization": `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(opts.headers || {})
    }
  });
  if (!res.ok) throw new Error(`Notion ${res.status} ${res.statusText}: ${await res.text().catch(()=> "")}`);
  return res;
}

function getProp(page, name) { return page.properties?.[name]; }

function extractFiles(page) {
  // your files live in "file_upload" (Files & media)
  const files = getProp(page, "file_upload")?.files || [];
  return files.map(f => {
    if (f.type === "file")  return { url: f.file.url, name: f.name || "file" };
    if (f.type === "external") return { url: f.external.url, name: f.name || "external" };
    return null;
  }).filter(Boolean);
}

async function ensureVectorStore(name="metskin-knowledge") {
  if (VS_DEFAULT) {
    try {
      const r = await ofetch(`${OPENAI_API}/vector_stores/${VS_DEFAULT}`);
      return await r.json();
    } catch { /* fall through to create */ }
  }
  const r = await ofetch(`${OPENAI_API}/vector_stores`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name })
  });
  return await r.json();
}

async function uploadBatch(vsId, fileBlobs) {
  const form = new FormData();
  for (const { blob, filename } of fileBlobs) form.append("files", blob, filename);
  const r = await ofetch(`${OPENAI_API}/vector_stores/${vsId}/file_batches`, { method: "POST", body: form });
  return await r.json();
}

async function pollBatch(vsId, batchId, timeoutMs = 10 * 60 * 1000) {
  const start = Date.now();
  while (true) {
    const res = await ofetch(`${OPENAI_API}/vector_stores/${vsId}/file_batches/${batchId}`);
    const data = await res.json();
    if (data.status === "completed") return data;
    if (["failed","cancelled"].includes(data.status)) throw new Error(`Batch ${data.status}`);
    if (Date.now() - start > timeoutMs) throw new Error("Batch polling timeout");
    await new Promise(r => setTimeout(r, 2000));
  }
}

async function attachToAssistant(asstId, vsId) {
  const cur = await (await ofetch(`${OPENAI_API}/assistants/${asstId}`)).json();
  const tools = Array.isArray(cur.tools) ? cur.tools.slice() : [];
  if (!tools.find(t => t.type === "file_search")) tools.push({ type: "file_search" });

  const existing = cur.tool_resources?.file_search?.vector_store_ids ?? [];
  const set = new Set(existing); set.add(vsId);

  await ofetch(`${OPENAI_API}/assistants/${asstId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tools,
      tool_resources: { file_search: { vector_store_ids: [...set] } }
    })
  });
}

async function setNotionStatus(pageId, { indexedAtISO, versionText, uncheckSync }) {
  const props = {};
  // your field names:
  // "indexed_at" (date) and "vs_version_id" (text)
  if (indexedAtISO) props["indexed_at"] = { date: { start: indexedAtISO } };
  if (versionText)  props["vs_version_id"] = { rich_text: [{ type: "text", text: { content: versionText } }] };
  if (uncheckSync)  props["sync_indicator"] = { checkbox: false };

  // best effort—ignore if a property doesn't exist/type mismatch
  try {
    await nfetch(`${NOTION_API}/pages/${pageId}`, {
      method: "PATCH",
      body: JSON.stringify({ properties: props })
    });
  } catch {}
}

async function downloadAsBlob(url, fallbackName = "file") {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download failed ${r.status}`);
  const ct = r.headers.get("content-type") || "application/octet-stream";
  const buf = new Uint8Array(await r.arrayBuffer());
  return { blob: new Blob([buf], { type: ct }), filename: fallbackName };
}

(async () => {
  console.log("== Notion → Vector Store sync (using your schema) ==");

  // 1) Query Notion DB where sync_indicator == true
  const q = await nfetch(`${NOTION_API}/databases/${NOTION_DB_ID}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter: { property: "sync_indicator", checkbox: { equals: true } }
    })
  });
  const rows = (await q.json()).results || [];
  if (!rows.length) { console.log("No rows with sync_indicator = true."); return; }

  // 2) VS ensure
  const vs = await ensureVectorStore("metskin-knowledge");
  console.log("Vector Store:", vs.id);

  // 3) Collect & download the files
  const fileBlobs = [];
  const rowToBlobIdxs = new Map(); // pageId -> [blob indexes]
  for (const row of rows) {
    const pageId = row.id;
    const nameProp = getProp(row, "file_name");
    const displayName = nameProp?.title?.[0]?.plain_text || pageId;

    const items = extractFiles(row);
    if (!items.length) continue;

    const idxs = [];
    for (const it of items) {
      try {
        const { blob, filename } = await downloadAsBlob(it.url, it.name || "file");
        fileBlobs.push({ blob, filename });
        idxs.push(fileBlobs.length - 1);
        console.log(`+ queued: ${displayName} -> ${filename}`);
      } catch (e) {
        console.warn(`! skipped ${displayName} (${e.message})`);
      }
    }
    if (idxs.length) rowToBlobIdxs.set(pageId, idxs);
  }
  if (!fileBlobs.length) { console.log("No eligible files to upload."); return; }

  // 4) Upload batch & poll
  const batch = await uploadBatch(vs.id, fileBlobs);
  console.log("Batch:", batch.id, batch.status);
  const done = await pollBatch(vs.id, batch.id);
  console.log("Indexed:", done.file_counts);

  // 5) Attach to Assistant
  await attachToAssistant(ASST_DEFAULT, vs.id);
  console.log("Assistant attached:", ASST_DEFAULT);

  // 6) Write back indexed_at / vs_version_id and uncheck sync_indicator
  const fileIds = done.file_ids || [];
  const versionText = `batch:${done.id || batch.id} files:${fileIds.join(",")}`.slice(0, 1900); // stay safe on length
  const nowISO = new Date().toISOString();

  for (const [pageId, idxs] of rowToBlobIdxs.entries()) {
    const subIds = idxs.map(i => fileIds[i]).filter(Boolean);
    const vtext = subIds.length ? `batch:${done.id || batch.id} files:${subIds.join(",")}` : versionText;
    await setNotionStatus(pageId, { indexedAtISO: nowISO, versionText: vtext, uncheckSync: true });
  }

  console.log("\nDone. VS_DEFAULT =", vs.id);
})();
