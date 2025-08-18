// server.js — API server for Metamorphosis Assistant
import express from "express";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import fetch from "node-fetch";
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Default model used for OpenAI Responses API
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ---------- Health ----------
const health = {
  ok: true,
  env: {
    assistant: process.env.ASST_DEFAULT || null,
    vector_store: process.env.VS_DEFAULT || null
  },
  routes: [
    "GET  /                (UI)",
    "POST /assistant/ask   (Responses API via assistant_id)",
    "GET  /start-chat",
    "POST /send",
    "POST /dev/make-token",
    "POST /chat            (Chat Completions test)",
    "GET  /health",
    "GET  /healthz"
  ]
};
app.get("/health",  (_req, res) => res.json(health));
app.get("/healthz", (_req, res) => res.json(health));

// ---------- UI ----------
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

// ---------- Assistant endpoint (Responses API via assistant_id) ----------
  app.post("/assistant/ask", async (req, res) => {
  try {
    const { message, model } = req.body ?? {};
    if (!message || typeof message !== "string") {
      return res
        .status(400)
        .json({ ok: false, error: "Field 'message' is required" });
    }
    const { OPENAI_API_KEY, ASST_DEFAULT } = process.env;
    if (!OPENAI_API_KEY)
      return res.status(500).json({ ok: false, error: "OPENAI_API_KEY missing" });
    if (!ASST_DEFAULT)
      return res
        .status(500)
        .json({ ok: false, error: "ASST_DEFAULT missing (assistant id)" });

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2",
      },
      body: JSON.stringify({
        assistant_id: ASST_DEFAULT,
        model: model || DEFAULT_MODEL,
        input: [
          {
            role: "user",
            content: [{ type: "text", text: message }],
          },
        ],
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      const msg =
        (data && (data.error?.message || data.message)) || "OpenAI error";
      return res.status(r.status).json({ ok: false, error: msg });
    }

    const answer =
      data.output_text ??
      (Array.isArray(data.output) && data.output[0]?.content?.[0]?.text) ??
      "";

    return res.json({ ok: true, answer });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
  });

// ---------- Start chat (creates conversation id) ----------
app.get("/start-chat", (_req, res) => {
  // Conversation ids can be arbitrary strings. Generate a UUID to track a chat.
  const thread_id = crypto.randomUUID();
  res.json({ ok: true, thread_id });
});

// ---------- Send message on existing thread ----------
app.post("/send", async (req, res) => {
  try {
    const { thread_id, text, model } = req.body ?? {};
    if (!thread_id || !text) {
      return res
        .status(400)
        .json({ ok: false, error: "Fields 'thread_id' and 'text' are required" });
    }
    const { OPENAI_API_KEY, ASST_DEFAULT } = process.env;
    if (!OPENAI_API_KEY)
      return res
        .status(500)
        .json({ ok: false, error: "OPENAI_API_KEY missing" });
    if (!ASST_DEFAULT)
      return res
        .status(500)
        .json({ ok: false, error: "ASST_DEFAULT missing (assistant id)" });

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "assistants=v2",
      },
      body: JSON.stringify({
        conversation: thread_id,
        assistant_id: ASST_DEFAULT,
        model: model || DEFAULT_MODEL,
        input: [
          {
            role: "user",
            content: [{ type: "text", text }],
          },
        ],
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      return res
        .status(r.status)
        .json({ ok: false, error: data?.error?.message || "OpenAI error" });
    }

    const message =
      data.output_text ||
      (Array.isArray(data.output) && data.output[0]?.content?.[0]?.text) ||
      "";

    res.json({ ok: true, message });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Dev token generator ----------
app.post("/dev/make-token", (req, res) => {
  const { DEV_TOKEN_ENABLED, JWT_SECRET } = process.env;
  if (DEV_TOKEN_ENABLED !== "true") {
    return res.status(403).json({ ok: false, error: "Disabled" });
  }
  const { email, name = "Guest", campaign = "dev" } = req.body ?? {};
  if (!email) {
    return res.status(400).json({ ok: false, error: "email required" });
  }
  if (!JWT_SECRET) {
    return res.status(500).json({ ok: false, error: "JWT_SECRET missing" });
  }
  const token = jwt.sign({ email, name, campaign }, JWT_SECRET, {
    expiresIn: "1h",
  });
  res.json({ ok: true, token });
});

// ---------- Chat Completions test endpoint (raw fetch) ----------
app.post("/chat", async (req, res) => {
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4-turbo",
        messages: [{ role: "user", content: "Hello" }]
      })
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ ok:false, error: data?.error?.message || "OpenAI error" });
    }

    const answer = data.choices?.[0]?.message?.content ?? "";
    res.json({ ok:true, answer });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 10000;     // Render provides PORT; local can use .env PORT
app.listen(PORT, () => {
  console.log(`Assistant ready on http://localhost:${PORT}`);
});
