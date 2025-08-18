/**
 * Metamorphosis Assistant — API Server (Vector Store enabled)
 * -----------------------------------------------------------
 * - Vector stores are attached to EVERY Responses API call.
 * - Works without assistant_id (default) or with it (USE_ASSISTANT_ID=true).
 * - Threads via previous_response_id (stored per thread_id).
 * - Always sends content blocks; always includes a model.
 * - Accepts JSON or raw text bodies; returns JSON errors.
 * - Loud logging toggles: DEBUG_LOG_REQUESTS, DEBUG_LOG_BODIES, DEBUG_OPENAI.
 */

import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { spawn } from "node:child_process";
import fetch from "node-fetch";

dotenv.config();

/* -------------------- App / Debug -------------------- */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const on = (v) => /^(1|true|yes|on)$/i.test(String(v || ""));
const DBG_REQ = on(process.env.DEBUG_LOG_REQUESTS);
const DBG_BOD = on(process.env.DEBUG_LOG_BODIES);
const DBG_OA  = on(process.env.DEBUG_OPENAI);

/* -------------------- Env -------------------- */
function requireEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === "") throw new Error(`Missing required env: ${name}`);
  return v;
}

const OPENAI_API_KEY = requireEnv("OPENAI_API_KEY");
const DEFAULT_MODEL  = process.env.OPENAI_MODEL || "gpt-4.1-mini";

// Vector stores: comma-separated vs_ IDs
const VECTOR_STORE_IDS = (process.env.VECTOR_STORE_IDS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

// Global purpose/instructions for the assistant
const ASST_INSTRUCTIONS =
  process.env.ASST_INSTRUCTIONS ||
  "You are the Metamorphosis Assistant. Use the knowledge base (file_search) to answer questions precisely. Prefer concise, actionable answers and cite relevant filenames when helpful.";

const USE_ASSISTANT = on(process.env.USE_ASSISTANT_ID); // optional
const ASST_DEFAULT  = USE_ASSISTANT ? requireEnv("ASST_DEFAULT") : process.env.ASST_DEFAULT;

/* -------------------- Parsers & Error Handling -------------------- */
app.use(express.json({ limit: "1mb" }));

// Return JSON (not HTML) on JSON parse errors
app.use((err, _req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({
      ok: false,
      error: "Invalid JSON payload",
      details: String(err.message || ""),
    });
  }
  next(err);
});

// Also accept raw text for these endpoints (curl/PowerShell quirks)
app.use(["/assistant/ask", "/send"], express.text({ type: "*/*", limit: "1mb" }));

// Static UI
app.use(express.static(path.join(__dirname, "public")));

// Request logger
if (DBG_REQ) {
  app.use((req, _res, next) => {
    console.log(`[REQ] ${req.method} ${req.url}`);
    next();
  });
}

// Body logger (sanitized / string)
function redact(obj) { try { return JSON.parse(JSON.stringify(obj || {})); } catch { return {}; } }
if (DBG_BOD) {
  app.use((req, _res, next) => {
    if (req.path === "/assistant/ask" || req.path === "/send") {
      console.log(`[BODY ${req.method} ${req.path}]`, typeof req.body === "string" ? req.body : redact(req.body));
    }
    next();
  });
}
function safeParseJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function bodyObj(req)     { return typeof req.body === "string" ? safeParseJson(req.body) : (req.body || {}); }

/* -------------------- OpenAI /v1/responses -------------------- */
const RESPONSES_URL = process.env.OPENAI_RESPONSES_URL || "https://api.openai.com/v1/responses";
const OA_HEADERS = {
  Authorization: `Bearer ${OPENAI_API_KEY}`,
  "Content-Type": "application/json",
  ...(USE_ASSISTANT ? { "OpenAI-Beta": "assistants=v2" } : {}), // only when using assistant_id
};

// Build a content block array
function blocks(text) {
  return [{ role: "user", content: [{ type: "input_text", text: String(text ?? "") }] }];
}

// Attach vector stores (and file_search tool) to a payload
function withKnowledge(payload) {
  if (!VECTOR_STORE_IDS.length) return payload;
  return {
    ...payload,
    tools: [{ type: "file_search" }],
    tool_resources: {
      file_search: { vector_store_ids: VECTOR_STORE_IDS },
    },
  };
}

// Friendly header log
function headersForLog(h) {
  const mask = h.Authorization ? `Bearer ${h.Authorization.slice(7, 11)}…` : "(missing)";
  return { "Content-Type": h["Content-Type"], "OpenAI-Beta": h["OpenAI-Beta"], Authorization: mask };
}

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

/* -------------------- Thread State -------------------- */
// We persist the last response.id per thread for multi-turn continuity.
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
    const { message, text, model, thread_id: providedThread } = body;
    const userText = (typeof message === "string" && message) || (typeof text === "string" && text) || "";
    if (!userText) return res.status(400).json({ ok: false, error: "Field 'message' (or 'text') is required" });

    const prior = providedThread ? lastResponseIdByThread.get(providedThread) : undefined;

    const payload = withKnowledge({
      model: model || DEFAULT_MODEL,                       // required
      instructions: ASST_INSTRUCTIONS,                     // global purpose
      input: blocks(userText),
      store: true,                                         // store for continuity
      ...(prior ? { previous_response_id: prior } : {}),   // continue if known
      ...(USE_ASSISTANT ? { assistant_id: ASST_DEFAULT } : {}),
    });

    const data = await callResponses(payload);
    const answer = data?.output_text ??
      (Array.isArray(data?.output) && data.output[0]?.content?.[0]?.text) ?? "";

    if (providedThread && data?.id) lastResponseIdByThread.set(providedThread, data.id);

    return res.json({ ok: true, answer, data_id: data?.id ?? null });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message, details: e.data ?? null });
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

    const msg = data?.output_text ??
      (Array.isArray(data?.output) && data.output[0]?.content?.[0]?.text) ?? "";

    return res.json({ ok: true, message: msg, data_id: data?.id ?? null });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message, details: e.data ?? null });
  }
});

/* ----- Dev token (optional) ----- */
app.post("/dev/make-token", (req, res) => {
  try {
    if (!on(process.env.DEV_TOKEN_ENABLED)) return res.status(403).json({ ok: false, error: "Disabled" });
    const body = bodyObj(req);
    const { email, name = "Guest", campaign = "dev" } = body;
    if (!email || typeof email !== "string") return res.status(400).json({ ok: false, error: "Field 'email' (string) is required" });
    const secret = process.env.JWT_SECRET;
    if (!secret) return res.status(500).json({ ok: false, error: "JWT_SECRET missing" });
    const token = jwt.sign({ email, name, campaign }, secret, { expiresIn: "1h" });
    res.json({ ok: true, token });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
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
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----- Admin: Notion sync ----- */
app.post("/admin/sync-knowledge", async (req, res) => {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const expected = process.env.ADMIN_API_TOKEN || process.env.JWT_SECRET;

  if (!expected) return res.status(503).json({ ok: false, error: "Sync disabled: set ADMIN_API_TOKEN or JWT_SECRET" });
  if (!token || token !== expected) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const scriptPath = path.join(__dirname, "scripts", "sync_knowledge_from_notion_files.mjs");
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
