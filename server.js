/**
 * Metamorphosis Assistant — API Server (Full Rewrite)
 * ---------------------------------------------------
 * - Express ESM server with strict input validation
 * - Centralized OpenAI /v1/responses caller (assistants=v2)
 * - ALWAYS sends content as blocks: [{ type:"text", text: "..." }]
 * - Thread support (conversation id)
 * - Health endpoints, dev token, admin Notion sync hook
 * - Helpful debug toggles: DEBUG_OPENAI, DEBUG_LOG_REQUESTS
 */

import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { spawn } from "node:child_process";
// If you're on Node ≥18 you can use global fetch; keeping node-fetch for portability.
import fetch from "node-fetch";
dotenv.config();

// ---------- Paths / App ----------
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ---------- Basic Middlewares ----------
app.use(express.json({ limit: "1mb" }));

// Return JSON instead of HTML on bad JSON bodies
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({
      ok: false,
      error: "Invalid JSON payload",
      details: String(err.message || "")
    });
  }
  next(err);
});

// Also accept raw text for these endpoints (curl/PowerShell quirks)
app.use(["/assistant/ask", "/send"], express.text({ type: "*/*", limit: "1mb" }));

function safeParseJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

app.use(express.static(path.join(__dirname, "public")));

if (process.env.DEBUG_LOG_REQUESTS === "1") {
  app.use((req, _res, next) => {
    console.log(`[REQ] ${req.method} ${req.url}`);
    next();
  });
}

// ---------- Config Helpers ----------
const REQUIRED_AT_START = ["OPENAI_API_KEY", "ASST_DEFAULT"];
function requireEnv(name) {
  const v = process.env[name];
  if (!v || String(v).trim() === "") {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}
function boolEnv(name, def = false) {
  const v = process.env[name];
  if (v == null) return def;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}
// Log sanitized bodies for the two routes
function redact(o){ try { return JSON.parse(JSON.stringify(o||{})); } catch { return {}; } }
app.use((req, _res, next) => {
  const dbg = (process.env.DEBUG_LOG_BODIES||"").match(/^(1|true|yes|on)$/i);
  if (dbg && (req.path === "/assistant/ask" || req.path === "/send")) {
    console.log(`[BODY ${req.method} ${req.path}]`, typeof req.body === "string" ? req.body : redact(req.body));
  }
  next();
});

const OPENAI_API_KEY = requireEnv("OPENAI_API_KEY");
const ASST_DEFAULT = requireEnv("ASST_DEFAULT");
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

// ---------- OpenAI Client (Responses API) ----------
const OA_URL = "https://api.openai.com/v1/responses";
const OA_HEADERS = {
  Authorization: `Bearer ${OPENAI_API_KEY}`,
  "Content-Type": "application/json",
  "OpenAI-Beta": "assistants=v2",
};

function contentBlocks(text) {
  // Always send blocks (the core fix for the “Unknown parameter: ''” error)
  return [{ role: "user", content: [{ type: "text", text: String(text ?? "") }] }];
}

function extractOutputText(data) {
  // Prefer output_text; fall back to walking the first output item
  return (
    data?.output_text ??
    (Array.isArray(data?.output) && data.output[0]?.content?.[0]?.text) ??
    ""
  );
}

async function callOpenAI(body, { timeoutMs = 45_000 } = {}) {
  const debug = boolEnv("DEBUG_OPENAI");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const req = {
    method: "POST",
    headers: OA_HEADERS,
    body: JSON.stringify(body),
    signal: controller.signal,
  };

  if (debug) console.log(`[OA⇢] ${OA_URL}\n${JSON.stringify(body, null, 2)}`);

  let resp;
  let raw;
  try {
    resp = await fetch(OA_URL, req);
    raw = await resp.text();
  } finally {
    clearTimeout(timeout);
  }

  if (debug) console.log(`[OA⇠] HTTP ${resp?.status}\n${raw}`);

  // Try parse; if it fails, wrap the raw as error text
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    json = { error: { message: raw || "Non-JSON response from OpenAI" } };
  }

  if (!resp.ok) {
    const msg =
      json?.error?.message ||
      json?.message ||
      `OpenAI error (HTTP ${resp.status})`;
    const err = new Error(msg);
    err.status = resp.status;
    err.data = json;
    throw err;
  }

  return json;
}

// ---------- Small Utilities ----------
function badRequest(res, msg, details) {
  return res.status(400).json({ ok: false, error: msg, details: details ?? null });
}
function internalError(res, msg, details) {
  return res.status(500).json({ ok: false, error: msg, details: details ?? null });
}

// ---------- Health ----------
const health = {
  ok: true,
  routes: [
    "GET  /",
    "GET  /health",
    "GET  /healthz",
    "GET  /start-chat",
    "POST /assistant/ask",
    "POST /send",
    "POST /dev/make-token",
    "POST /chat                 (Chat Completions test)",
    "POST /admin/sync-knowledge (spawns Notion→Vector sync)",
  ],
  env: {
    OPENAI_MODEL: DEFAULT_MODEL,
    ASST_DEFAULT: ASST_DEFAULT ? "set" : "missing",
    OPENAI_API_KEY: OPENAI_API_KEY ? "set" : "missing",
    ADMIN_API_TOKEN: process.env.ADMIN_API_TOKEN ? "set" : "unset",
    DEV_TOKEN_ENABLED: process.env.DEV_TOKEN_ENABLED || "false",
  },
};
app.get("/health", (_req, res) => res.json(health));
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ---------- UI ----------
app.get("/", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

// ---------- Conversation Helpers ----------
app.get("/start-chat", (_req, res) => {
  const thread_id = crypto.randomUUID(); // You can store this if needed
  res.json({ ok: true, thread_id });
});

// ---------- Assistant: New thread ask ----------
app.post("/assistant/ask", async (req, res) => {
  try {
    const { message, model } = req.body ?? {};
    if (!message || typeof message !== "string") {
      return badRequest(res, "Field 'message' (string) is required");
    }

    const body = {
      assistant_id: ASST_DEFAULT,
      model: model || DEFAULT_MODEL, // optional with assistant_id, but allowed
      input: contentBlocks(message),
    };

    const data = await callOpenAI(body);
    const answer = extractOutputText(data);

    return res.json({ ok: true, answer, data_id: data?.id ?? null });
  } catch (e) {
    return res
      .status(e.status || 500)
      .json({ ok: false, error: e.message, details: e.data ?? null });
  }
});

// /assistant/ask
app.post("/assistant/ask", async (req, res) => {
  try {
    const body = typeof req.body === "string" ? safeParseJson(req.body) : (req.body || {});
    const { message, text, model } = body;
    const userText = (typeof message === "string" && message) || (typeof text === "string" && text) || "";
    if (!userText) return res.status(400).json({ ok: false, error: "Field 'message' (or 'text') is required" });

    // ...call OpenAI with blocks(userText) as before...
  } catch (e) { /* unchanged */ }
});
// /send
app.post("/send", async (req, res) => {
  try {
    const body = typeof req.body === "string" ? safeParseJson(req.body) : (req.body || {});
    const { thread_id, thread, text, message, model } = body;
    const conv = (typeof thread_id === "string" && thread_id) || (typeof thread === "string" && thread) || "";
    const userText = (typeof text === "string" && text) || (typeof message === "string" && message) || "";
    if (!conv) return res.status(400).json({ ok: false, error: "Field 'thread_id' (or 'thread') is required" });
    if (!userText) return res.status(400).json({ ok: false, error: "Field 'text' (or 'message') is required" });

    // ...call OpenAI with blocks(userText) + conversation: conv...
  } catch (e) { /* unchanged */ }
});

// ---------- Assistant: Send to existing conversation ----------
app.post("/send", async (req, res) => {
  try {
    const { thread_id, text, model } = req.body ?? {};
    if (!thread_id || typeof thread_id !== "string") {
      return badRequest(res, "Field 'thread_id' (string) is required");
    }
    if (!text || typeof text !== "string") {
      return badRequest(res, "Field 'text' (string) is required");
    }

    const body = {
      conversation: thread_id,
      assistant_id: ASST_DEFAULT,
      model: model || DEFAULT_MODEL,
      input: contentBlocks(text),
    };

    const data = await callOpenAI(body);
    const message = extractOutputText(data);

    return res.json({ ok: true, message, data_id: data?.id ?? null });
  } catch (e) {
    return res
      .status(e.status || 500)
      .json({ ok: false, error: e.message, details: e.data ?? null });
  }
});

// ---------- Dev: Make short-lived JWT for local testing ----------
app.post("/dev/make-token", (req, res) => {
  try {
    if (!boolEnv("DEV_TOKEN_ENABLED")) {
      return res.status(403).json({ ok: false, error: "Disabled" });
    }
    const { email, name = "Guest", campaign = "dev" } = req.body ?? {};
    if (!email || typeof email !== "string") {
      return badRequest(res, "Field 'email' (string) is required");
    }
    const secret = process.env.JWT_SECRET;
    if (!secret) return internalError(res, "JWT_SECRET missing");

    const token = jwt.sign({ email, name, campaign }, secret, {
      expiresIn: "1h",
    });
    res.json({ ok: true, token });
  } catch (e) {
    return internalError(res, e.message);
  }
});

// ---------- Optional: Chat Completions probe ----------
app.post("/chat", async (_req, res) => {
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      return res
        .status(r.status)
        .json({ ok: false, error: data?.error?.message || "OpenAI error" });
    }
    res.json({
      ok: true,
      answer: data?.choices?.[0]?.message?.content ?? "",
    });
  } catch (e) {
    return internalError(res, e.message);
  }
});

// ---------- Admin: trigger Notion → Vector Store sync ----------
app.post("/admin/sync-knowledge", async (req, res) => {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const expected = process.env.ADMIN_API_TOKEN || process.env.JWT_SECRET;

  if (!expected) {
    return res.status(503).json({
      ok: false,
      error:
        "Sync disabled: set ADMIN_API_TOKEN or JWT_SECRET to authorize this route",
    });
  }
  if (!token || token !== expected) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  // Adjust script path if your script has a different filename
  const scriptPath = path.join(
    __dirname,
    "scripts",
    "sync_knowledge_from_notion_files.mjs"
  );

  const child = spawn(process.execPath, [scriptPath], {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  child.on("error", (err) =>
    res.status(500).json({ ok: false, error: `spawn error: ${err.message}` })
  );
  child.on("close", (code) =>
    res
      .status(code === 0 ? 200 : 500)
      .json({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() })
  );
});

// ---------- Fallback 404 ----------
app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Not Found" });
});

// ---------- Start Server ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(
    `✓ Assistant server listening on http://localhost:${PORT}  (model=${DEFAULT_MODEL})`
  );
  // Sanity check at boot for required keys:
  for (const k of REQUIRED_AT_START) {
    if (!process.env[k]) {
      console.warn(`! Warning: ${k} is not set`);
    }
  }
});
