// server.js
// Chat + Assistants API server with vector-store support
// Node >= 20, ESM ("type": "module" in package.json)

import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

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
const ASST_DEFAULT = process.env.ASST_DEFAULT || ""; // assistant with vector-store attached

const openai = new OpenAI({ apiKey: OPENAI_KEY });

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

// Fallback Chat Completions helper (legacy)
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
    console.error("chatComplete error", data);
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

// Assistants API helper with vector-store aware assistant
async function assistantComplete({ message, thread_id, system }) {
  if (!ASST_DEFAULT) throw new Error("ASST_DEFAULT not configured");
  const threadId =
    thread_id || (await openai.beta.threads.create({})).id;
  if (!message) throw new Error("message is required");
  await openai.beta.threads.messages.create(threadId, {
    role: "user",
    content: message,
  });
  const run = await openai.beta.threads.runs.create(threadId, {
    assistant_id: ASST_DEFAULT,
    ...(system ? { instructions: String(system) } : {}),
  });
  let status = run.status;
  while (status === "queued" || status === "in_progress") {
    await new Promise((r) => setTimeout(r, 500));
    const r2 = await openai.beta.threads.runs.retrieve(run.id, { thread_id: threadId });
    status = r2.status;
  }
  if (status !== "completed") {
    throw new Error(`Run ${status}`);
  }
  const messages = await openai.beta.threads.messages.list(threadId);
  const latest = messages.data.find((m) => m.role === "assistant");
  const answer = latest?.content
    ?.map((c) => (c.type === "text" ? c.text.value : ""))
    .join("\n")
    .trim();
  return { answer, thread_id: threadId, run_id: run.id, status };
}


/* -------------------- Mount per-base API (both ENV_BASE and /api) -------------------- */

function mountApi(base) {
  // Health (duplicate under each base is fine)
  app.get("/health", (_req, res) => res.status(200).send("ok"));
  app.get("/healthz", (_req, res) => res.json({ ok: true }));

  // Self-test (quick key/egress check)
  app.post(`${base}/selftest`, async (_req, res) => {
    try {
      const helper = ASST_DEFAULT ? assistantComplete : chatComplete;
      const out = await helper({ message: "Hello" });
      res.json({ ok: true, ...out });
    } catch (e) {
      console.error("/selftest error", e);
      res
        .status(e?.response?.status || 500)
        .json({ ok: false, error: e.message, details: e?.response?.data ?? null });
    }
  });

  // Preferred endpoint (text/plain or JSON)
  app.post(`${base}/chat`, async (req, res) => {
    try {
      const body =
        typeof req.body === "string" ? { message: req.body } : (req.body || {});
      const helper = ASST_DEFAULT ? assistantComplete : chatComplete;
      const out = await helper(body);
      res.json({ ok: true, ...out });
    } catch (e) {
      console.error("/chat error", e);
      res
        .status(e?.response?.status || 400)
        .json({ ok: false, error: e.message || "Bad Request", details: e?.response?.data ?? null });
    }
  });

  // Legacy one-shot endpoint many UIs call
  app.post(`${base}/run`, async (req, res) => {
    try {
      const b = typeof req.body === "string" ? { message: req.body } : (req.body || {});
      const text = b.message || b.text || b.input;
      if (!text || !String(text).trim()) return res.status(400).json({ ok: false, error: "message is required" });
      const helper = ASST_DEFAULT ? assistantComplete : chatComplete;
      const out = await helper({ message: text, thread_id: b.thread_id, system: b.system });
      res.json({ ok: true, ...out, mode: ASST_DEFAULT ? "assistant" : "chat" });
    } catch (e) {
      console.error("/run error", e);
      res
        .status(e?.response?.status || 500)
        .json({ ok: false, error: e.message, details: e?.response?.data ?? null });
    }
  });

    // Threads API adapters
    app.post(`${base}/threads`, async (_req, res) => {
      try {
        const thread = await openai.beta.threads.create({});
        res.json({ id: thread.id });
      } catch (e) {
        console.error("create thread error", e);
        res
          .status(e?.response?.status || 500)
          .json({ ok: false, error: e.message, details: e?.response?.data ?? null });
      }
    });

    app.post(`${base}/threads/:threadId/messages`, async (req, res) => {
      try {
        const { threadId } = req.params;
        if (!threadId) return res.status(400).json({ ok: false, error: "threadId required" });
        const b = typeof req.body === "string" ? { message: req.body } : (req.body || {});
        const text = b.message || b.text || b.input;
        if (!text) return res.status(400).json({ ok: false, error: "message is required" });
        await openai.beta.threads.messages.create(threadId, {
          role: "user",
          content: text,
        });
        res.json({ ok: true, accepted: true, thread_id: threadId });
      } catch (e) {
        console.error("add message error", e);
        res
          .status(e?.response?.status || 500)
          .json({ ok: false, error: e.message, details: e?.response?.data ?? null });
      }
    });

    app.post(`${base}/threads/:threadId/runs`, async (req, res) => {
      try {
        const { threadId } = req.params;
        if (!threadId || threadId === "undefined")
          return res.status(400).json({ ok: false, error: "threadId required" });
        const b = typeof req.body === "string" ? { message: req.body } : (req.body || {});
        const text = b.message || b.text || b.input || "Continue.";
        const out = await assistantComplete({ message: text, thread_id: threadId, system: b.system });
        res.json({ ok: true, ...out, status: "completed", mode: "assistant" });
      } catch (e) {
        console.error("run thread error", e);
        res
          .status(e?.response?.status || 500)
          .json({ ok: false, error: e.message, details: e?.response?.data ?? null });
      }
    });

    app.get(`${base}/threads/:threadId/messages`, async (req, res) => {
      try {
        const { threadId } = req.params;
        if (!threadId) return res.status(400).json({ ok: false, error: "threadId required" });
        const messages = await openai.beta.threads.messages.list(threadId);
        res.json({ ok: true, data: messages.data, has_more: messages.has_more });
      } catch (e) {
        console.error("list messages error", e);
        res
          .status(e?.response?.status || 500)
          .json({ ok: false, error: e.message, details: e?.response?.data ?? null });
      }
    });

  // Helpful per-base 404 (AFTER all routes above)
  app.all(`${base}/*`, (req, res) =>
    res.status(404).json({ ok: false, error: "Not Found", details: { method: req.method, path: req.path, base } })
  );
}

// Mount under both the env base and /api (covers misconfig and older clients)
API_BASES.forEach((b) => mountApi(b));

/* -------------------- Non-API legacy fallbacks -------------------- */

// Provide root-level thread endpoints for older clients
app.post("/threads", async (_req, res) => {
  try {
    const thread = await openai.beta.threads.create({});
    res.json({ id: thread.id });
  } catch (e) {
    console.error("create thread error", e);
    res
      .status(e?.response?.status || 500)
      .json({ ok: false, error: e.message, details: e?.response?.data ?? null });
  }
});

app.post("/threads/:threadId/messages", async (req, res) => {
  try {
    const { threadId } = req.params;
    if (!threadId) return res.status(400).json({ ok: false, error: "threadId required" });
    const b = typeof req.body === "string" ? { message: req.body } : (req.body || {});
    const text = b.message || b.text || b.input;
    if (!text) return res.status(400).json({ ok: false, error: "message is required" });
    await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: text,
    });
    res.json({ ok: true, accepted: true, thread_id: threadId });
  } catch (e) {
    console.error("add message error", e);
    res
      .status(e?.response?.status || 500)
      .json({ ok: false, error: e.message, details: e?.response?.data ?? null });
  }
});

app.post("/threads/:threadId/runs", async (req, res) => {
  try {
    const { threadId } = req.params;
    if (!threadId || threadId === "undefined")
      return res.status(400).json({ ok: false, error: "threadId required" });
    const b = typeof req.body === "string" ? { message: req.body } : (req.body || {});
    const text = b.message || b.text || b.input || "Continue.";
    const out = await assistantComplete({ message: text, thread_id: threadId, system: b.system });
    res.json({ ok: true, ...out, status: "completed", mode: "assistant" });
  } catch (e) {
    console.error("run thread error", e);
    res
      .status(e?.response?.status || 500)
      .json({ ok: false, error: e.message, details: e?.response?.data ?? null });
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
  if (ASST_DEFAULT) console.log(`[assistant] id=${ASST_DEFAULT}`);
  else console.log(`[chat-only] model=${DEFAULT_MODEL}`);
  console.log(`API bases mounted at: ${API_BASES.join(", ")}`);
});
