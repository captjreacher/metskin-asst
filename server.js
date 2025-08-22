// server.js
// Chat Completions only (no Threads/Assistants) + legacy adapters
// Node >= 20, ESM ("type": "module" in package.json)

import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* -------------------- Config -------------------- */

const PORT = process.env.PORT || 10000;
const API_BASE = process.env.API_BASE_PATH || "/api";

const OPENAI_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.OPENAI_KEY ||
  process.env.OPENAI ||
  "";

if (!OPENAI_KEY) {
  console.error("FATAL: Missing OPENAI_API_KEY / OPENAI_KEY (project API key).");
  process.exit(1);
}

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_BASE = "https://api.openai.com/v1";
const OPENAI_BEARER = `Bearer ${OPENAI_KEY}`;

/* -------------------- App -------------------- */

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

// Parse JSON and text/plain (do NOT catch all text so JSON isn't mis-parsed)
app.use(express.json({ limit: "2mb" }));
app.use(express.text({ type: "text/plain", limit: "1mb" }));

// Static UI
app.use(express.static(path.join(__dirname, "public")));

/* -------------------- Helpers -------------------- */

async function chatComplete({ message, messages, model, system, temperature, top_p }) {
  let msgs = Array.isArray(messages) ? messages : [];
  if (!msgs.length && system) msgs.push({ role: "system", content: String(system) });
  if (!msgs.length && message) msgs.push({ role: "user", content: String(message) });
  if (!msgs.length) throw new Error("No input provided");

  const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: OPENAI_BEARER,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      messages: msgs,
      ...(typeof temperature === "number" ? { temperature } : {}),
      ...(typeof top_p === "number" ? { top_p } : {}),
    }),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data?.error?.message || `${r.status} ${r.statusText}`);
    e.response = { status: r.status, data };
    throw e;
  }
  return {
    answer: data?.choices?.[0]?.message?.content ?? "",
    usage: data?.usage ?? null,
    model: model || DEFAULT_MODEL,
  };
}

/* -------------------- Primary API (place BEFORE 404) -------------------- */

// Quick key/egress check
app.post(`${API_BASE}/selftest`, async (_req, res) => {
  try {
    const out = await chatComplete({ message: "Hello" });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(e?.response?.status || 500).json({ ok: false, error: e.message, details: e?.response?.data ?? null });
  }
});

// New, preferred endpoint
app.post(`${API_BASE}/chat`, async (req, res) => {
  try {
    const body = typeof req.body === "string" ? { message: req.body } : (req.body || {});
    const out = await chatComplete(body);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(e?.response?.status || 400).json({ ok: false, error: e.message || "Bad Request", details: e?.response?.data ?? null });
  }
});

/* -------------------- Legacy adapters (keep old UI working) -------------------- */

const fakeThreadId = () => `thread_chat_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// POST /api/threads -> return a fake id
app.post(`${API_BASE}/threads`, (_req, res) => res.json({ id: fakeThreadId() }));

// POST /api/threads/:threadId/messages -> ack (no state)
app.post(`${API_BASE}/threads/:threadId/messages`, (req, res) =>
  res.json({ ok: true, accepted: true, thread_id: req.params.threadId })
);

// POST /api/threads/:threadId/runs -> generate answer via chat
app.post(`${API_BASE}/threads/:threadId/runs`, async (req, res) => {
  try {
    const b = typeof req.body === "string" ? { message: req.body } : (req.body || {});
    const text = b.message || b.text || b.input || "Continue.";
    const out = await chatComplete({ message: text, model: b.model, system: b.system });
    res.json({ ok: true, ...out, thread_id: req.params.threadId, run_id: null, status: "completed", mode: "chat" });
  } catch (e) {
    res.status(e?.response?.status || 500).json({ ok: false, error: e.message, details: e?.response?.data ?? null });
  }
});

// Old single-shot endpoint many UIs use
app.post(`${API_BASE}/run`, async (req, res) => {
  try {
    const b = typeof req.body === "string" ? { message: req.body } : (req.body || {});
    const text = b.message || b.text || b.input;
    if (!text || !String(text).trim()) return res.status(400).json({ ok: false, error: "message is required" });
    const out = await chatComplete({ message: text, model: b.model, system: b.system });
    res.json({ ok: true, ...out, thread_id: b.thread_id ?? null, run_id: null, mode: "chat" });
  } catch (e) {
    res.status(e?.response?.status || 500).json({ ok: false, error: e.message, details: e?.response?.data ?? null });
  }
});

// Non-API fallbacks (if something still calls them)
app.post("/threads", (_req, res) => res.json({ id: fakeThreadId() }));
app.post("/threads/:threadId/messages", (req, res) =>
  res.json({ ok: true, accepted: true, thread_id: req.params.threadId })
);
app.post("/threads/:threadId/runs", async (req, res) => {
  try {
    const b = typeof req.body === "string" ? { message: req.body } : (req.body || {});
    const text = b.message || b.text || b.input || "Continue.";
    const out = await chatComplete({ message: text, model: b.model, system: b.system });
    res.json({ ok: true, ...out, thread_id: req.params.threadId, run_id: null, status: "completed", mode: "chat" });
  } catch (e) {
    res.status(e?.response?.status || 500).json({ ok: false, error: e.message, details: e?.response?.data ?? null });
  }
});

/* -------------------- 404 + SPA fallback -------------------- */

// API 404 — keep this AFTER all API routes above
app.use((req, res, next) => {
  if (req.path.startsWith(API_BASE)) return res.status(404).json({ ok: false, error: "Not Found" });
  next();
});

// Serve index.html for everything else
app.get("*", (req, res, next) => {
  if (req.path.startsWith(API_BASE)) return next();
  const indexPath = path.join(__dirname, "public", "index.html");
  res.sendFile(indexPath, (err) => { if (err) next(); });
});

/* -------------------- Start -------------------- */

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`[chat-only] model=${DEFAULT_MODEL}`);
});
