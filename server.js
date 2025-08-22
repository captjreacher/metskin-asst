// server.js
// Chat Completions only (no real Threads) + legacy adapters + dual API bases + diagnostics
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
const ENV_BASE = process.env.API_BASE_PATH || "/api";       // honor env, but we also hard-mount /api
const API_BASES = Array.from(new Set([ENV_BASE, "/api"]));  // guarantee /api works

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

// Parse JSON and text/plain (avoid catching all text so JSON isn't mis-parsed as string)
app.use(express.json({ limit: "2mb" }));
app.use(express.text({ type: "text/plain", limit: "1mb" }));

// Static UI (if present in /public)
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

const fakeThreadId = () =>
  `thread_chat_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/* -------------------- Mount per-base API (both ENV_BASE and /api) -------------------- */

function mountApi(base) {
  // Health (duplicate under each base is fine)
  app.get("/health", (_req, res) => res.status(200).send("ok"));
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // Self-test (quick key/egress check)
  app.post(`${base}/selftest`, async (_req, res) => {
    try {
      const out = await chatComplete({ message: "Hello" });
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(e?.response?.status || 500).json({ ok: false, error: e.message, details: e?.response?.data ?? null });
    }
  });

  // Preferred endpoint (text/plain or JSON)
  app.post(`${base}/chat`, async (req, res) => {
    try {
      const body = typeof req.body === "string" ? { message: req.body } : (req.body || {});
      const out = await chatComplete(body);
      res.json({ ok: true, ...out });
    } catch (e) {
      res.status(e?.response?.status || 400).json({ ok: false, error: e.message || "Bad Request", details: e?.response?.data ?? null });
    }
  });

  // Legacy one-shot endpoint many UIs call
  app.post(`${base}/run`, async (req, res) => {
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

  // Legacy Threads-like adapters (no real Threads used)
  app.post(`${base}/threads`, (_req, res) => res.json({ id: fakeThreadId() }));

  app.post(`${base}/threads/:threadId/messages`, (req, res) =>
    res.json({ ok: true, accepted: true, thread_id: req.params.threadId })
  );

  app.post(`${base}/threads/:threadId/runs`, async (req, res) => {
    try {
      const b = typeof req.body === "string" ? { message: req.body } : (req.body || {});
      const text = b.message || b.text || b.input || "Continue.";
      const out = await chatComplete({ message: text, model: b.model, system: b.system });
      res.json({ ok: true, ...out, thread_id: req.params.threadId, run_id: null, status: "completed", mode: "chat" });
    } catch (e) {
      res.status(e?.response?.status || 500).json({ ok: false, error: e.message, details: e?.response?.data ?? null });
    }
  });

  // Optional: minimal messages list so old UIs don't 404
  app.get(`${base}/threads/:threadId/messages`, (_req, res) =>
    res.json({ ok: true, data: [], has_more: false })
  );

  // Helpful per-base 404 (AFTER all routes above)
  app.all(`${base}/*`, (req, res) =>
    res.status(404).json({ ok: false, error: "Not Found", details: { method: req.method, path: req.path, base } })
  );
}

// Mount under both the env base and /api (covers misconfig and older clients)
API_BASES.forEach((b) => mountApi(b));

/* -------------------- Non-API legacy fallbacks -------------------- */

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

/* -------------------- Diagnostics -------------------- */

// List mounted routes to debug 404s quickly
app.get("/__diag/routes", (_req, res) => {
  const routes = [];
  app._router.stack.forEach((m) => {
    if (m.route?.path) routes.push({ method: Object.keys(m.route.methods)[0]?.toUpperCase(), path: m.route.path });
    else if (m.name === "router" && m.handle?.stack) {
      m.handle.stack.forEach((h) => { if (h.route) routes.push({ method: Object.keys(h.route.methods)[0]?.toUpperCase(), path: h.route.path }); });
    }
  });
  res.json({ ok: true, bases: API_BASES, routes });
});

/* -------------------- SPA fallback -------------------- */

// Serve index.html for everything else
app.get("*", (req, res, next) => {
  // API 404s handled by per-base catch-alls above
  const indexPath = path.join(__dirname, "public", "index.html");
  res.sendFile(indexPath, (err) => { if (err) next(); });
});

/* -------------------- Start -------------------- */

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`[chat-only] model=${DEFAULT_MODEL}`);
  console.log(`API bases mounted at: ${API_BASES.join(", ")}`);
});
