// server.js
// Chat Completions only (no Threads/Assistants) + legacy route adapters
// Node 20+, ESM ("type": "module" in package.json)

import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ----------------- Config ----------------- */

const PORT = process.env.PORT || 10000;
const API_BASE = process.env.API_BASE_PATH || "/api";

const OPENAI_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.OPENAI_KEY ||
  process.env.OPENAI;

if (!OPENAI_KEY) {
  console.error("FATAL: Missing OPENAI_API_KEY / OPENAI_KEY");
  process.exit(1);
}

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/* ----------------- App ----------------- */

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

// Accept JSON and raw text (so you can POST plain text too)
app.use(express.json({ limit: "2mb" }));
app.use(express.text({ type: "*/*", limit: "1mb" }));

// Static UI (optional)
app.use(express.static(path.join(__dirname, "public")));

/* ----------------- Health ----------------- */

app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

/* ------------- OpenAI helper ------------- */

const OPENAI_BASE = "https://api.openai.com/v1";
const OPENAI_BEARER = `Bearer ${OPENAI_KEY}`;

async function chatComplete({ message, messages, model, system, temperature, top_p }) {
  // Build messages array
  let msgs = Array.isArray(messages) ? messages : [];
  if (!msgs.length && system) msgs.push({ role: "system", content: String(system) });
  if (!msgs.length && message) msgs.push({ role: "user", content: String(message) });
  if (!msgs.length) throw new Error("No input provided");

  const body = {
    model: model || DEFAULT_MODEL,
    messages: msgs,
    ...(typeof temperature === "number" ? { temperature } : {}),
    ...(typeof top_p === "number" ? { top_p } : {}),
  };

  const r = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: OPENAI_BEARER,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || `${r.status} ${r.statusText}`;
    const e = new Error(msg);
    e.response = { status: r.status, data };
    throw e;
  }

  const answer = data?.choices?.[0]?.message?.content ?? "";
  return { answer, usage: data?.usage ?? null, model: body.model };
}

/* ----------------- Primary API ----------------- */

// Self-test (quick project-key/egress check)
app.post(`${API_BASE}/selftest`, async (_req, res) => {
  try {
    const { answer, model } = await chatComplete({ message: "Hello" });
    res.json({ ok: true, answer, model });
  } catch (e) {
    res.status(e?.response?.status || 500).json({
      ok: false,
      error: e.message,
      details: e?.response?.data ?? null,
    });
  }
});

/**
 * POST /api/chat
 * Body:
 *   - text/plain: body is the user message
 *   - application/json:
 *       { "message": "hi" }
 *       { "messages": [{role, content}, ...], "system": "...", "model": "...", ... }
 */
app.post(`${API_BASE}/chat`, async (req, res) => {
  try {
    const isString = typeof req.body === "string";
    const b = isString ? { message: req.body } : (req.body || {});
    const { answer, model, usage } = await chatComplete(b);
    res.json({ ok: true, answer, model, usage });
  } catch (e) {
    res.status(e?.response?.status || 400).json({
      ok: false,
      error: e.message || "Bad Request",
      details: e?.response?.data ?? null,
    });
  }
});

/* -------- Legacy adapters (keep old frontends working) -------- */

// Generate a harmless thread-like id so UIs expecting it don’t break
const fakeThreadId = () => `thread_chat_${Math.random().toString(36).slice(2, 10)}`;

// Old: POST /api/run  with { message, thread_id? }
app.post(`${API_BASE}/run`, async (req, res) => {
  try {
    const b = typeof req.body === "string" ? { message: req.body } : (req.body || {});
    const text = b.message || b.text || b.input;
    if (!text || !String(text).trim()) return res.status(400).json({ ok: false, error: "message is required" });

    const { answer, model, usage } = await chatComplete({ message: text, model: b.model, system: b.system });
    res.json({ ok: true, answer, model, usage, thread_id: b.thread_id ?? null, run_id: null, mode: "chat" });
  } catch (e) {
    res.status(e?.response?.status || 500).json({ ok: false, error: e.message, details: e?.response?.data ?? null });
  }
});

// Old: POST /api/threads  -> return a fake id
app.post(`${API_BASE}/threads`, (_req, res) => {
  res.json({ id: fakeThreadId() });
});

// Old: POST /api/threads/:threadId/messages  (no-op accept)
app.post(`${API_BASE}/threads/:threadId/messages`, async (req, res) => {
  try {
    const b = typeof req.body === "string" ? { message: req.body } : (req.body || {});
    const text = b.message || b.text || b.input || b.content;
    if (!text || !String(text).trim()) return res.status(400).json({ ok: false, error: "message is required" });
    // No state kept; just acknowledge
    res.json({ ok: true, accepted: true, thread_id: req.params.threadId });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Old: POST /api/threads/:threadId/runs  -> run immediately via chat
app.post(`${API_BASE}/threads/:threadId/runs`, async (req, res) => {
  try {
    // In this chat-only server, thread_ids are ephemeral. If the client has an old one, reject it.
    const threadId = req.params.threadId;
    if (!threadId.startsWith("thread_chat_")) {
      return res.status(410).json({
        ok: false,
        error: "Thread not found or has expired.",
        details: { thread_id: threadId, code: "thread_gone" },
      });
    }

    const b = typeof req.body === "string" ? { message: req.body } : (req.body || {});
    const text = b.message || b.text || b.input;
    const { answer, model, usage } = await chatComplete({ message: text || "Continue.", model: b.model, system: b.system });
    res.json({ ok: true, answer, model, usage, thread_id: req.params.threadId, run_id: null, status: "completed", mode: "chat" });
  } catch (e) {
    res.status(e?.response?.status || 500).json({ ok: false, error: e.message, details: e?.response?.data ?? null });
  }
});

// (Optional) non-API legacy routes if some pages still call them
app.post("/threads", (_req, res) => res.json({ id: fakeThreadId() }));
app.post("/threads/:threadId/messages", (req, res) => res.json({ ok: true, accepted: true, thread_id: req.params.threadId }));
app.post("/threads/:threadId/runs", async (req, res) => {
  try {
    // In this chat-only server, thread_ids are ephemeral. If the client has an old one, reject it.
    const threadId = req.params.threadId;
    if (!threadId.startsWith("thread_chat_")) {
      return res.status(410).json({
        ok: false,
        error: "Thread not found or has expired.",
        details: { thread_id: threadId, code: "thread_gone" },
      });
    }

    const b = typeof req.body === "string" ? { message: req.body } : (req.body || {});
    const text = b.message || b.text || b.input;
    const { answer, model, usage } = await chatComplete({ message: text || "Continue.", model: b.model, system: b.system });
    res.json({ ok: true, answer, model, usage, thread_id: req.params.threadId, run_id: null, status: "completed", mode: "chat" });
  } catch (e) {
    res.status(e?.response?.status || 500).json({ ok: false, error: e.message, details: e?.response?.data ?? null });
  }
});

/* ----------------- 404 + SPA fallback ----------------- */

app.use((req, res, next) => {
  if (req.path.startsWith(API_BASE)) {
    return res.status(404).json({ ok: false, error: "Not Found" });
  }
  next();
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith(API_BASE)) return next();
  const indexPath = path.join(__dirname, "public", "index.html");
  res.sendFile(indexPath, (err) => { if (err) next(); });
});

/* ----------------- Start ----------------- */

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`[chat-only] model=${DEFAULT_MODEL}`);
});
