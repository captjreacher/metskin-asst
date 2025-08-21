// server.js
// OpenAI Assistants API server
// Node 20+, ESM ("type": "module" in package.json)

import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ----------------- Config ----------------- */

const PORT = process.env.PORT || 10000;
const API_BASE = process.env.API_BASE_PATH || "/api";



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

/* ------------- OpenAI client ------------- */

const openai = new OpenAI();

const ASSISTANT_ID = process.env.ASST_METAMORPHOSIS || process.env.ASST_DEFAULT;
if (!ASSISTANT_ID) {
  console.error("FATAL: Missing ASST_METAMORPHOSIS / ASST_DEFAULT");
  process.exit(1);
}

const assistant = {
  createThread: async () => {
    return await openai.beta.threads.create();
  },

  addMessage: async (threadId, message) => {
    return await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: message,
    });
  },

  createRun: async (threadId) => {
    return await openai.beta.threads.runs.create(threadId, {
      assistant_id: ASSISTANT_ID,
    });
  },

  pollRun: async (threadId, runId) => {
    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        try {
          const run = await openai.beta.threads.runs.retrieve(threadId, runId);
          if (run.status === "completed") {
            clearInterval(interval);
            resolve(run);
          } else if (run.status === "failed" || run.status === "cancelled" || run.status === "expired") {
            clearInterval(interval);
            reject(new Error(`Run ended with status: ${run.status}`));
          }
        } catch (error) {
          clearInterval(interval);
          reject(error);
        }
      }, 1000);
    });
  },

  getLastMessage: async (threadId) => {
    const messages = await openai.beta.threads.messages.list(threadId);
    return messages.data[0];
  },
};

/* -------- Legacy adapters (keep old frontends working) -------- */

// Create a new thread
app.post(`${API_BASE}/threads`, async (_req, res) => {
  try {
    const thread = await assistant.createThread();
    res.json({ ok: true, id: thread.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Add a message to a thread
app.post(`${API_BASE}/threads/:threadId/messages`, async (req, res) => {
  try {
    const b = typeof req.body === "string" ? { message: req.body } : (req.body || {});
    const text = b.message || b.text || b.input || b.content;
    if (!text || !String(text).trim()) return res.status(400).json({ ok: false, error: "message is required" });

    const msg = await assistant.addMessage(req.params.threadId, text);
    res.json({ ok: true, id: msg.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Create a run to get a new answer
app.post(`${API_BASE}/threads/:threadId/runs`, async (req, res) => {
  try {
    const threadId = req.params.threadId;
    const b = typeof req.body === "string" ? { message: req.body } : (req.body || {});
    const text = b.message || b.text || b.input;

    // Add message if one was provided
    if (text) {
      await assistant.addMessage(threadId, text);
    }

    const run = await assistant.createRun(threadId);
    await assistant.pollRun(threadId, run.id);

    const message = await assistant.getLastMessage(threadId);
    const answer = message.content[0].text.value;

    res.json({ ok: true, answer, thread_id: threadId, run_id: run.id, status: "completed" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// (Optional) non-API legacy routes if some pages still call them
app.post("/threads", async (_req, res) => {
  try {
    const thread = await assistant.createThread();
    res.json({ id: thread.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
app.post("/threads/:threadId/messages", (req, res) => res.json({ ok: true, accepted: true, thread_id: req.params.threadId }));
app.post("/threads/:threadId/runs", async (req, res) => {
  try {
    const threadId = req.params.threadId;
    const b = typeof req.body === "string" ? { message: req.body } : (req.body || {});
    const text = b.message || b.text || b.input;

    if (text) {
      await assistant.addMessage(threadId, text);
    }

    const run = await assistant.createRun(threadId);
    await assistant.pollRun(threadId, run.id);

    const message = await assistant.getLastMessage(threadId);
    const answer = message.content[0].text.value;

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
