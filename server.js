// server.js
// Express + OpenAI Threads via REST (no SDK positional args)
// Node 20+, ESM ("type": "module")

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* -------------------- Config -------------------- */

const PORT = process.env.PORT || 10000;
const API_BASE = process.env.API_BASE_PATH || "/api";

const OPENAI_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.OPENAI_KEY ||
  process.env.OPENAI; // last resort

if (!OPENAI_KEY) {
  console.error("FATAL: Missing OPENAI_API_KEY/OPENAI_KEY");
  process.exit(1);
}

const ASSISTANT_ID =
  process.env.OPENAI_ASSISTANT_ID || process.env.ASST_DEFAULT || "";

const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const INSTRUCTIONS =
  process.env.ASST_INSTRUCTIONS ||
  "You are the Metamorphosis Assistant. Be concise, accurate, and helpful.";

const COOKIE_NAME = process.env.THREAD_COOKIE_NAME || "assistant_thread_id";
const COOKIE_SECURE =
  /^(1|true|yes|on)$/i.test(String(process.env.COOKIE_SECURE || "")) ||
  process.env.NODE_ENV === "production";

/* -------------------- App -------------------- */

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

app.use(express.json({ limit: "2mb" }));
app.use(express.text({ type: "*/*", limit: "1mb" }));

// Static UI
app.use(express.static(path.join(__dirname, "public")));

// Health
app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

/* -------------------- Helpers -------------------- */

const OPENAI_BASE = "https://api.openai.com/v1";
const OPENAI_BEARER = `Bearer ${OPENAI_KEY}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const looksLikeThreadId = (v) => typeof v === "string" && /^thread_[A-Za-z0-9]/.test(v);
const looksLikeRunId = (v) => typeof v === "string" && /^run_[A-Za-z0-9]/.test(v);

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const p of header.split(";")) {
    const s = p.trim();
    const i = s.indexOf("=");
    if (i > -1) out[s.slice(0, i)] = decodeURIComponent(s.slice(i + 1));
  }
  return out;
}

function setCookie(res, name, value, opts = {}) {
  const {
    httpOnly = true,
    sameSite = "Lax",
    secure = COOKIE_SECURE,
    path = "/",
    maxAge = 60 * 60 * 24 * 14, // 14 days
  } = opts;
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`];
  if (httpOnly) parts.push("HttpOnly");
  if (secure) parts.push("Secure");
  if (sameSite) parts.push(`SameSite=${sameSite}`);
  if (maxAge) parts.push(`Max-Age=${maxAge}`);
  res.append("Set-Cookie", parts.join("; "));
}

function errJson(res, status, msg, details) {
  return res.status(status).json({ ok: false, error: msg, details: details ?? null });
}

async function httpJson(url, init) {
  const r = await fetch(url, {
    ...init,
    headers: {
      Authorization: OPENAI_BEARER,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || `${r.status} ${r.statusText}`;
    const e = new Error(msg);
    e.response = { status: r.status, data };
    throw e;
  }
  return data;
}

// 1) Create thread
async function httpCreateThread() {
  const j = await httpJson(`${OPENAI_BASE}/threads`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  return j.id; // "thread_..."
}

// 2) Add message
async function httpAddMessage(threadId, text) {
  return httpJson(`${OPENAI_BASE}/threads/${encodeURIComponent(threadId)}/messages`, {
    method: "POST",
    body: JSON.stringify({
      role: "user",
      content: String(text),
    }),
  });
}

// 3) Start run (assistant or model mode)
async function httpStartRun(threadId, modelOverride) {
  const body = ASSISTANT_ID
    ? { assistant_id: ASSISTANT_ID }
    : { model: modelOverride || MODEL, instructions: INSTRUCTIONS };
  const j = await httpJson(
    `${OPENAI_BASE}/threads/${encodeURIComponent(threadId)}/runs`,
    { method: "POST", body: JSON.stringify(body) }
  );
  return j.id; // run_id
}

// 4) Poll run
async function httpWaitRun(threadId, runId, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const j = await httpJson(
      `${OPENAI_BASE}/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}`,
      { method: "GET" }
    );
    const s = j.status;
    if (s === "queued" || s === "in_progress") {
      await sleep(850);
      continue;
    }
    if (s === "requires_action") {
      const e = new Error("requires_action");
      e.details = { required_action: j.required_action };
      throw e;
    }
    return j; // completed/failed/cancelled/expired
  }
  throw new Error("Run timed out");
}

// 5) Read answer
async function httpGetAnswer(threadId, runId) {
  const j = await httpJson(
    `${OPENAI_BASE}/threads/${encodeURIComponent(threadId)}/messages?order=desc&limit=20`,
    { method: "GET" }
  );
  const msg = j.data.find((m) => m.role === "assistant" && m.run_id === runId);
  const part = msg?.content?.find((c) => c.type === "text");
  return part?.text?.value || "";
}

/* -------------------- API (cookie-scoped) -------------------- */

// Self-test (no Threads) — proves key + egress
app.post(`${API_BASE}/selftest`, async (_req, res) => {
  try {
    const j = await httpJson(`${OPENAI_BASE}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    return res.json({ ok: true, answer: j?.choices?.[0]?.message?.content ?? "" });
  } catch (e) {
    const details = e?.response?.data || e?.message || String(e);
    return errJson(res, e?.response?.status || 500, "OpenAI error", details);
  }
});

// One-shot ask/answer
app.post(`${API_BASE}/run`, async (req, res) => {
  try {
    const b = typeof req.body === "string" ? { message: req.body } : (req.body || {});
    const userText = b.message || b.text || b.input;
    if (!userText || !String(userText).trim()) {
      return errJson(res, 400, "message is required");
    }

    // cookie-scoped thread (create if missing)
    const cookies = parseCookies(req.headers.cookie || "");
    let threadId = cookies[COOKIE_NAME];
    if (!looksLikeThreadId(threadId)) {
      threadId = await httpCreateThread();
      setCookie(res, COOKIE_NAME, threadId);
    }

    await httpAddMessage(threadId, userText);
    const runId = await httpStartRun(threadId, b.model);
    await httpWaitRun(threadId, runId);
    const answer = await httpGetAnswer(threadId, runId);

    return res.json({ ok: true, answer, thread_id: threadId, run_id: runId, mode: ASSISTANT_ID ? "assistant" : "model" });
  } catch (e) {
    // graceful fallback to plain chat so the UI still gets an answer
    try {
      const b = typeof req.body === "string" ? { message: req.body } : (req.body || {});
      const userText = b.message || b.text || b.input;
      if (!userText || !String(userText).trim()) throw e;

      const j = await httpJson(`${OPENAI_BASE}/chat/completions`, {
        method: "POST",
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: String(userText) }],
        }),
      });
      const answer = j?.choices?.[0]?.message?.content ?? "";
      return res.json({ ok: true, answer, thread_id: null, run_id: null, mode: "fallback" });
    } catch (e2) {
      const details = e2?.response?.data || e2?.message || String(e2);
      return errJson(res, e2?.response?.status || 500, "OpenAI error", details);
    }
  }
});

/* ------------- Back-compat aliases for old UIs (/threads) ------------- */

// Create/reuse thread
app.post("/threads", async (req, res) => {
  try {
    const cookies = parseCookies(req.headers.cookie || "");
    let threadId = cookies[COOKIE_NAME];
    if (!looksLikeThreadId(threadId)) {
      threadId = await httpCreateThread();
      setCookie(res, COOKIE_NAME, threadId);
    }
    return res.json({ id: threadId });
  } catch (e) {
    const details = e?.response?.data || e?.message || String(e);
    return errJson(res, e?.response?.status || 500, "OpenAI error", details);
  }
});

// Append message (falls back to cookie thread if :threadId bad)
app.post("/threads/:threadId/messages", async (req, res) => {
  try {
    const b = typeof req.body === "string" ? { message: req.body } : (req.body || {});
    const text = b.message || b.text || b.input || b.content;
    if (!text || !String(text).trim()) return errJson(res, 400, "message is required");
    let { threadId } = req.params;
    if (!looksLikeThreadId(threadId)) {
      const cookies = parseCookies(req.headers.cookie || "");
      threadId = cookies[COOKIE_NAME];
      if (!looksLikeThreadId(threadId)) threadId = await httpCreateThread();
      setCookie(res, COOKIE_NAME, threadId);
    }
    await httpAddMessage(threadId, text);
    return res.json({ ok: true, thread_id: threadId });
  } catch (e) {
    const details = e?.response?.data || e?.message || String(e);
    return errJson(res, e?.response?.status || 500, "OpenAI error", details);
  }
});

// Start run (optional message in body)
app.post("/threads/:threadId/runs", async (req, res) => {
  try {
    const b = typeof req.body === "string" ? { message: req.body } : (req.body || {});
    const text = b.message || b.text || b.input;
    let { threadId } = req.params;
    if (!looksLikeThreadId(threadId)) {
      const cookies = parseCookies(req.headers.cookie || "");
      threadId = cookies[COOKIE_NAME];
      if (!looksLikeThreadId(threadId)) threadId = await httpCreateThread();
      setCookie(res, COOKIE_NAME, threadId);
    }
    if (text && String(text).trim()) await httpAddMessage(threadId, text);
    const runId = await httpStartRun(threadId, b.model);
    return res.json({ ok: true, thread_id: threadId, run_id: runId, status: "queued" });
  } catch (e) {
    const details = e?.response?.data || e?.message || String(e);
    return errJson(res, e?.response?.status || 500, "OpenAI error", details);
  }
});

/* -------------------- 404 + SPA fallback -------------------- */

app.use((req, res, next) => {
  if (req.path.startsWith(API_BASE) || req.path.startsWith("/threads")) {
    return res.status(404).json({ ok: false, error: "Not Found" });
  }
  next();
});

app.get("*", (req, res, next) => {
  if (req.path.startsWith(API_BASE) || req.path.startsWith("/threads")) return next();
  const indexPath = path.join(__dirname, "public", "index.html");
  res.sendFile(indexPath, (err) => { if (err) next(); });
});

/* -------------------- Start -------------------- */

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(
    `[assistant] mode=${ASSISTANT_ID ? "assistant" : "model"} ${ASSISTANT_ID || MODEL} cookie=${COOKIE_NAME} secure=${COOKIE_SECURE}`
  );
});
