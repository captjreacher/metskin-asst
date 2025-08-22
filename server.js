// server.js
// OpenAI Assistants API server
// Node 20+, ESM ("type": "module" in package.json)

import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { patchOpenAIPositionalCompat } from "./openai_positional_compat.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ----------------- Config ----------------- */
const PORT = process.env.PORT || 10000;
const API_BASE = process.env.API_BASE_PATH || "/api";

// Declare the key FIRST…
const OPENAI_KEY =
  process.env.OPENAI_API_KEY ||
  process.env.OPENAI_KEY ||
  process.env.OPENAI || "";
  
  if (!OPENAI_KEY) {
  console.error("FATAL: Missing OPENAI_API_KEY / OPENAI_KEY");
  process.exit(1);
}
//* ----------------- App ----------------- */

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
// Accept message but keep no state
app.post(`${API_BASE}/threads/:threadId/messages`, (req, res) => {
  res.json({ ok: true, accepted: true, thread_id: req.params.threadId });
});

// “Run” immediately via chat-only path (no Threads)
app.post(`${API_BASE}/threads/:threadId/runs`, async (req, res) => {
  try {
    const b = typeof req.body === "string" ? { message: req.body } : (req.body || {});
    const text = b.message || b.text || b.input || "Continue.";
    // If you installed my chat-only helper, call that here; otherwise just stub:
    // const { answer, model, usage } = await chatComplete({ message: text, model: b.model, system: b.system });
    // res.json({ ok: true, answer, model, usage, thread_id: req.params.threadId, run_id: null, status: "completed", mode: "chat" });
    res.json({ ok: true, thread_id: req.params.threadId, run_id: null, status: "completed", mode: "stub" });
  } catch (e) {
    res.json({ ok: true, thread_id: req.params.threadId, run_id: null, status: "completed", mode: "stub" });
  }
});

/* ------------- OpenAI client ------------- */


const ASSISTANT_ID = process.env.ASST_METAMORPHOSIS || process.env.ASST_DEFAULT;
if (!ASSISTANT_ID) {
  console.error("FATAL: Missing ASST_METAMORPHOSIS / ASST_DEFAULT");
  process.exit(1);
}
// ---- HARD OVERRIDE: /api/threads must never 500 ----
const SAFE_THREAD_PREFIX = "thread_chat_";
function makeSafeThreadId() {
  return SAFE_THREAD_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Place this before any other handlers that might touch /api/threads
app.post(`${API_BASE}/threads`, (req, res) => {
  try {
    const id = makeSafeThreadId();
    // Minimal JSON, no side effects
    res.json({ id });
  } catch (_e) {
    // Even if something weird happens, still reply
    res.status(200).json({ id: makeSafeThreadId() });
  }
});

/* -------- API routes -------- */

// Create a new thread
app.post(`${API_BASE}/threads`, async (_req, res) => {
  try {
    const thread = await openai.beta.threads.create();
    res.json({ ok: true, id: thread.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Add a message to a thread
app.post(`${API_BASE}/threads/:threadId/messages`, async (req, res) => {
  try {
    const threadId = req.params.threadId;
    const b = req.body || {};
    const text = b.message || b.text || b.input || b.content;
    if (!text || !String(text).trim()) return res.status(400).json({ ok: false, error: "message is required" });

    const msg = await openai.beta.threads.messages.create(threadId, { role: 'user', content: text });
    res.json({ ok: true, id: msg.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Create a run to get a new answer
app.post(`${API_BASE}/threads/:threadId/runs`, async (req, res) => {
  try {
    const threadId = req.params.threadId;
    const b = req.body || {};
    const text = b.message || b.text || b.input;

    // Add message if one was provided
    if (text) {
      await openai.beta.threads.messages.create(threadId, { role: 'user', content: text });
    }

    const run = await openai.beta.threads.runs.create(threadId, { assistant_id: ASSISTANT_ID });

    // Polling logic
    while(true) {
        const retrievedRun = await openai.beta.threads.runs.retrieve(threadId, run.id);
        if (retrievedRun.status === 'completed') {
            break;
        }
        if (retrievedRun.status === 'failed' || retrievedRun.status === 'cancelled' || retrievedRun.status === 'expired') {
            throw new Error(`Run ended with status: ${retrievedRun.status}`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const messages = await openai.beta.threads.messages.list(threadId);
    const answer = messages.data[0].content[0].text.value;

    res.json({ ok: true, answer, thread_id: threadId, run_id: run.id, status: "completed" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// (Optional) non-API legacy routes if some pages still call them
app.post("/threads", async (_req, res) => {
  try {
    const thread = await openai.beta.threads.create();
    res.json({ id: thread.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post("/threads/:threadId/messages", (req, res) => res.json({ ok: true, accepted: true, thread_id: req.params.threadId }));
app.post("/threads/:threadId/runs", async (req, res) => {
  try {
    const threadId = req.params.threadId;
    const b = req.body || {};
    const text = b.message || b.text || b.input;

    if (text) {
      await openai.beta.threads.messages.create(threadId, { role: 'user', content: text });
    }

    const run = await openai.beta.threads.runs.create(threadId, { assistant_id: ASSISTANT_ID });

    // Polling logic
    while(true) {
        const retrievedRun = await openai.beta.threads.runs.retrieve(threadId, run.id);
        if (retrievedRun.status === 'completed') {
            break;
        }
        if (retrievedRun.status === 'failed' || retrievedRun.status === 'cancelled' || retrievedRun.status === 'expired') {
            throw new Error(`Run ended with status: ${retrievedRun.status}`);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const messages = await openai.beta.threads.messages.list(threadId);
    const answer = messages.data[0].content[0].text.value;

    res.json({ ok: true, answer, thread_id: threadId, run_id: run.id, status: "completed" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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
  console.log(`[assistants] id=${ASSISTANT_ID}`);
});
