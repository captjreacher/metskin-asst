// server.js
// Minimal Express + OpenAI Chat Completions ONLY (no Threads/Assistants)
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
  process.env.OPENAI; // last resort env name

if (!OPENAI_KEY) {
  console.error("FATAL: Missing OPENAI_API_KEY/OPENAI_KEY env var.");
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

// Static UI if you have one
app.use(express.static(path.join(__dirname, "public")));

/* ----------------- Health ----------------- */

app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

/* ------------- OpenAI helpers ------------- */

const OPENAI_BASE = "https://api.openai.com/v1";
const OPENAI_BEARER = `Bearer ${OPENAI_KEY}`;

// One-shot chat completion (no memory, no threads)
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

/* ----------------- API ----------------- */

// Self-test: verifies key & egress without any client input
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
 * Body options:
 * - text/plain: the body IS the user message (simplest)
 * - application/json:
 *   {
 *     "message": "hi",              // single-shot
 *     "messages": [...],            // full chat history array (role/content)
 *     "system": "You are helpful",  // optional system prompt
 *     "model": "gpt-4o-mini",       // optional
 *     "temperature": 0.7,           // optional
 *     "top_p": 1                    // optional
 *   }
 */
app.post(`${API_BASE}/chat`, async (req, res) => {
  try {
    // Accept both JSON bodies and raw text
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

/* --------- Kill old /threads routes cleanly --------- */

// Anything hitting threads* gets a clear 410 Gone with pointer to /api/chat
function gone(req, res) {
  res.status(410).json({
    ok: false,
    error: "Threads API removed",
    details: {
      hint: "Use POST /api/chat with { message } or { messages }.",
      example: "curl -X POST /api/chat -H 'Content-Type: application/json' --data '{\"message\":\"hi\"}'",
    },
  });
}
app.post("/threads", gone);
app.post("/threads/:threadId/messages", gone);
app.post("/threads/:threadId/runs", gone);
app.get("/threads/:threadId/runs/:runId", gone);
app.get("/threads/:threadId/messages", gone);

// If you previously added /api/threads aliases, retire them too:
app.post(`${API_BASE}/threads`, gone);
app.post(`${API_BASE}/threads/:threadId/messages`, gone);
app.post(`${API_BASE}/threads/:threadId/runs`, gone);
app.get(`${API_BASE}/threads/:threadId/runs/:runId`, gone);

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
