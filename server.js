/**
 * Metamorphosis Assistant — API Server (Vector Store enabled)
 * -----------------------------------------------------------
 * - Attaches vector_store_ids + file_search tool to EVERY Responses API call
 * - Works with or without assistant_id (USE_ASSISTANT_ID=true)
 * - Tracks previous_response_id per thread for multi-turn continuity
 * - Accepts JSON or raw-text bodies; returns JSON errors
 * - Optional in-process cron: set SYNC_CRON="*/30 * * * *"
 */

import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cron from "node-cron";
import { spawn } from "node:child_process";
import express from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import fetch from "node-fetch";

/* -------------------- ESM-safe __dirname -------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/* -------------------- Helpers / Flags -------------------- */
const on  = (v) => /^(1|true|yes|on)$/i.test(String(v || ""));
const csv = (s) => (s || "").split(",").map(x => x.trim()).filter(Boolean);

const DBG_REQ = on(process.env.DEBUG_LOG_REQUESTS);
const DBG_BOD = on(process.env.DEBUG_LOG_BODIES);
const DBG_OA  = on(process.env.DEBUG_OPENAI);

/* -------------------- Required env -------------------- */
function requireEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === "") throw new Error(`Missing required env: ${name}`);
  return v;
}

const OPENAI_API_KEY = requireEnv("OPENAI_API_KEY");
const DEFAULT_MODEL  = process.env.OPENAI_MODEL || "gpt-4.1-mini";

// Vector store(s)
const VS_FROM_SINGLE = process.env.VECTOR_STORE_ID ? [process.env.VECTOR_STORE_ID] : [];
const VECTOR_STORE_IDS = (VS_FROM_SINGLE.length ? VS_FROM_SINGLE : csv(process.env.VECTOR_STORE_IDS)).filter(Boolean);

// Assistant (optional)
const USE_ASSISTANT = on(process.env.USE_ASSISTANT_ID);
const ASST_DEFAULT  = USE_ASSISTANT ? requireEnv("ASST_DEFAULT") : process.env.ASST_DEFAULT;

// Global instructions (nice to have)
const ASST_INSTRUCTIONS =
  process.env.ASST_INSTRUCTIONS ||
  "You are the Metamorphosis Assistant. Use the knowledge base (file_search) to answer accurately. Be concise and cite filenames when helpful.";

/* -------------------- Optional in-process cron -------------------- */
// Runs the Notion→VectorStore sync script on a schedule if SYNC_CRON is set.
if (process.env.SYNC_CRON) {
  let running = false;
  const scriptPath = fileURLToPath(new URL("./scripts/sync_knowledge_from_notion_files.mjs", import.meta.url));

  cron.schedule(process.env.SYNC_CRON, () => {
    if (running) return;                 // prevent overlap
    running = true;
    const child = spawn(process.execPath, [scriptPath], { env: process.env, stdio: "inherit" });
    child.on("close", () => { running = false; });
    child.on("error", () => { running = false; });
  });

  console.log("✓ Notion sync scheduled with CRON:", process.env.SYNC_CRON);
}

/* -------------------- Express -------------------- */
const app = express();
app.use(express.json({ limit: "1mb" }));
// also accept raw text (curl/PowerShell quirks) on chat endpoints
app.use(["/assistant/ask", "/send"], express.text({ type: "*/*", limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

if (DBG_REQ) {
  app.use((req, _res, next) => { console.log(`[REQ] ${req.method} ${req.url}`); next(); });
}
function redact(x) { try { return JSON.parse(JSON.stringify(x || {})); } catch { return {}; } }
if (DBG_BOD) {
  app.use((req, _res, next) => {
    if (req.path === "/assistant/ask" || req.path === "/send") {
      console.log(`[BODY ${req.method} ${req.path}]`, typeof req.body === "string" ? req.body : redact(req.body));
    }
    next();
  });
}
// return JSON on invalid JSON
app.use((err, _req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, error: "Invalid JSON payload", details: String(err.message || "") });
  }
  next(err);
});
const bodyObj = (req) => (typeof req.body === "string" ? (JSON.parse(req.body || "{}") || {}) : (req.body || {}));

/* -------------------- OpenAI /v1/responses -------------------- */
const RESPONSES_URL = process.env.OPENAI_RESPONSES_URL || "https://api.openai.com/v1/responses";
const OA_HEADERS = {
  Authorization: `Bearer ${OPENAI_API_KEY}`,
  "Content-Type": "application/json",
  ...(USE_ASSISTANT ? { "OpenAI-Beta": "assistants=v2" } : {}), // assistant_id requires this header
};

const headersForLog = (h) => ({
  Authorization: h.Authorization ? `Bearer ${h.Authorization.slice(7, 11)}…` : "(missing)",
  "OpenAI-Beta": h["OpenAI-Beta"],
  "Content-Type": h["Content-Type"],
});

const blocks = (text) => [{ role: "user", content: [{ type: "input_text", text: String(text ?? "") }] }];

const withKnowledge = (payload) =>
  VECTOR_STORE_IDS.length
    ? {
        ...payload,
        tools: [{ type: "file_search" }],
        tool_resources: { file_search: { vector_store_ids: VECTOR_STORE_IDS } },
      }
    : payload;

async function callResponses(body, { timeoutMs = 45_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const req = { method: "POST", headers: OA_HEADERS, body: JSON.stringify(body), signal: controller.signal };

  if (DBG_OA) {
    console.log("[OA HEADERS]", headersForLog(OA_HEADERS));
    console.log("[OA⇢]", RESPONSES_URL, "\n" + JSON.stringify(body, null, 2));
  }

  let resp, raw;
  try { resp = await fetch(RESPONSES_URL, req); raw = await resp.text(); } finally { clearTimeout(timer); }
  if (DBG_OA) console.log("[OA⇠] HTTP", resp?.status, "\n" + raw);

  let json; try { json = JSON.parse(raw); } catch { json = { error: { message: raw || "Non-JSON response" } }; }
  if (!resp.ok) {
    const err = new Error(json?.error?.message || json?.message || `OpenAI error (HTTP ${resp.status})`);
    err.status = resp.status; err.data = json; throw err;
  }
  return json;
}

/* -------------------- Thread state -------------------- */
const lastResponseIdByThread = new Map();

/* -------------------- Routes -------------------- */
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    routes: [
      "GET  /", "GET  /health", "GET  /healthz", "GET  /start-chat",
      "POST /assistant/ask", "POST /send", "POST /dev/make-token",
      "POST /chat", "POST /admin/sync-knowledge",
    ],
    env: {
      OPENAI_API_KEY: "set",
      OPENAI_MODEL: DEFAULT_MODEL,
      VECTOR_STORE_IDS: VECTOR_STORE_IDS,
      USE_ASSISTANT_ID: USE_ASSISTANT,
      ASST_DEFAULT: USE_ASSISTANT ? (ASST_DEFAULT ? "set" : "missing") : "(not used)",
      DEBUG: { DEBUG_LOG_REQUESTS: DBG_REQ, DEBUG_LOG_BODIES: DBG_BOD, DEBUG_OPENAI: DBG_OA },
      SYNC_CRON: process.env.SYNC_CRON || null,
    },
  });
});
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/start-chat", (_req, res) => res.json({ ok: true, thread_id: crypto.randomUUID() }));

/* ----- First turn ----- */
app.post("/assistant/ask", async (req, res) => {
  try {
    const body = bodyObj(req);
    const { message, text, model, thread_id } = body;
    const userText = (typeof message === "string" && message) || (typeof text === "string" && text) || "";
    if (!userText) return res.status(400).json({ ok: false, error: "Field 'message' (or 'text') is required" });

    const prior = thread_id ? lastResponseIdByThread.get(thread_id) : undefined;

    const payload = withKnowledge({
      model: model || DEFAULT_MODEL,
      instructions: ASST_INSTRUCTIONS,
      input: blocks(userText),
      store: true,
      ...(prior ? { previous_response_id: prior } : {}),
      ...(USE_ASSISTANT ? { assistant_id: ASST_DEFAULT } : {}),
    });

    const data = await callResponses(payload);
    if (thread_id && data?.id) lastResponseIdByThread.set(thread_id, data.id);

    const answer =
      data?.output_text ??
      (Array.isArray(data?.output) && data.output[0]?.content?.[0]?.text) ??
      "";

    res.json({ ok: true, answer, data_id: data?.id ?? null });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, details: e.data ?? null });
  }
});

/* ----- Follow-up turns ----- */
app.post("/send", async (req, res) => {
  try {
    const body = bodyObj(req);
    const { thread_id, thread, text, message, model } = body;

    const conv = (typeof thread_id === "string" && thread_id) || (typeof thread === "string" && thread) || "";
    const userText = (typeof text === "string" && text) || (typeof message === "string" && message) || "";

    if (!conv)     return res.status(400).json({ ok: false, error: "Field 'thread_id' (or 'thread') is required" });
    if (!userText) return res.status(400).json({ ok: false, error: "Field 'text' (or 'message') is required" });

    const prior = lastResponseIdByThread.get(conv);

    const payload = withKnowledge({
      model: model || DEFAULT_MODEL,
      instructions: ASST_INSTRUCTIONS,
      input: blocks(userText),
      store: true,
      ...(prior ? { previous_response_id: prior } : {}),
      ...(USE_ASSISTANT ? { assistant_id: ASST_DEFAULT } : {}),
    });

    const data = await callResponses(payload);
    if (data?.id) lastResponseIdByThread.set(conv, data.id);

    const msg =
      data?.output_text ??
      (Array.isArray(data?.output) && data.output[0]?.content?.[0]?.text) ??
      "";

    res.json({ ok: true, message: msg, data_id: data?.id ?? null });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, details: e.data ?? null });
  }
});

/* ----- Dev token (optional) ----- */
app.post("/dev/make-token", (req, res) => {
  try {
    if (!on(process.env.DEV_TOKEN_ENABLED)) return res.status(403).json({ ok: false, error: "Disabled" });
    const { email, name = "Guest", campaign = "dev" } = bodyObj(req);
    if (!email || typeof email !== "string") return res.status(400).json({ ok: false, error: "Field 'email' (string) is required" });
    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ ok: false, error: "JWT_SECRET missing" });
    const token = jwt.sign({ email, name, campaign }, secret, { expiresIn: "1h" });
    res.json({ ok: true, token });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----- Optional Chat Completions probe ----- */
app.post("/chat", async (_req, res) => {
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Hello" }] }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ ok: false, error: data?.error?.message || "OpenAI error" });
    res.json({ ok: true, answer: data?.choices?.[0]?.message?.content ?? "" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----- Admin: trigger Notion → VectorStore sync ----- */
app.post("/admin/sync-knowledge", async (req, res) => {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const expected = process.env.ADMIN_API_TOKEN || process.env.JWT_SECRET;

  if (!expected) return res.status(503).json({ ok: false, error: "Sync disabled: set ADMIN_API_TOKEN or JWT_SECRET" });
  if (!token || token !== expected) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const scriptPath = fileURLToPath(new URL("./scripts/sync_knowledge_from_notion_files.mjs", import.meta.url));
  const child = spawn(process.execPath, [scriptPath], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });

  let stdout = "", stderr = "";
  child.stdout.on("data", d => (stdout += d.toString()));
  child.stderr.on("data", d => (stderr += d.toString()));
  child.on("error", err => res.status(500).json({ ok: false, error: `spawn error: ${err.message}` }));
  child.on("close", code => res.status(code === 0 ? 200 : 500).json({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }));
});

/* ----- 404 ----- */
app.use((_req, res) => res.status(404).json({ ok: false, error: "Not Found" }));

/* -------------------- Start -------------------- */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`✓ Assistant server listening on http://localhost:${PORT}`);
});
