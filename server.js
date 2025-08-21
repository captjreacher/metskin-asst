// server.js
// Metamorphosis Assistant – Express + OpenAI Threads API
// Node 20+ (ESM)

import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import fs from "node:fs";
import { spawn } from "node:child_process";
import cors from "cors"; // optional
import sqlite3 from "sqlite3";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const on = (v) => /^(1|true|yes|on)$/i.test(String(v ?? ""));

const OPENAI_KEY = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.error("FATAL: Missing OPENAI_KEY / OPENAI_API_KEY");
  process.exit(1);
}

const API_BASE = process.env.API_BASE_PATH || "/api";
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// If you have a pre-built Assistant, set ASST_DEFAULT (or OPENAI_ASSISTANT_ID)
// and we’ll run with that; otherwise we call the model directly.
const ASST_DEFAULT =
  process.env.ASST_DEFAULT || process.env.OPENAI_ASSISTANT_ID || "";

// Optional file_search wiring (Vector Store IDs). Disabled by default to avoid
// “Unknown parameter: tool_resources” on older/staged APIs. Flip flag to enable.
const ENABLE_TOOL_RESOURCES = on(process.env.ENABLE_TOOL_RESOURCES || "0");
const VS_IDS = Array.from(
  new Set(
    (process.env.VECTOR_STORE_IDS || process.env.VECTOR_STORE_ID || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  )
);

const ENABLE_CORS = on(process.env.ENABLE_CORS || "1");
const HEALTH_LOG_SAMPLE_MS = Number(process.env.HEALTH_LOG_SAMPLE_MS || 60_000);
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN || process.env.JWT_SECRET || "";
const SYNC_CRON = (process.env.SYNC_CRON || "").trim();

const ASST_INSTRUCTIONS =
  process.env.ASST_INSTRUCTIONS ||
  [
    "You are the Metamorphosis Product Assistant.",
    "Use file_search over the knowledge base to answer accurately and concisely.",
    "If the user says 'metskin-asst training status', reply exactly:",
    "Fully Trained and Reporting for Duty Captain",
  ].join(" ");

/* ------------------------------ App --------------------------------- */

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true);

// static GUI (served from /public) — NOW it's safe
app.use(express.static(path.join(__dirname, "public")));

// JSON for most routes
app.use(express.json({ limit: "2mb" }));
// Also accept raw text on key chat routes (PowerShell & odd clients)
app.use(["/send"], express.text({ type: "*/*", limit: "1mb" }));

// Initialize local SQLite database
const DB_FILE = process.env.DB_PATH || path.join(__dirname, "data.db");
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) {
    console.error("\u21AA Failed to connect to SQLite DB:", err.message);
  } else {
    console.log("\u2713 Connected to SQLite DB at", DB_FILE);
  }
});
app.locals.db = db;

// Optional CORS
if (ENABLE_CORS) {
  const origin = process.env.CORS_ORIGIN || true; // reflect request origin
  app.use(cors({ origin, credentials: true }));
  console.log("↪ CORS enabled. Origin:", origin === true ? "(dynamic)" : origin);
}

// Accept JSON and raw text (handy for curl/PowerShell posting plain strings)
app.use(express.json({ limit: "2mb" }));
app.use(express.text({ type: "*/*", limit: "1mb" }));

// Serve static UI from /public at /
app.use(express.static(path.join(__dirname, "public")));

/* ------------------------------ Health ------------------------------ */

let lastHealthLog = 0;
app.get("/health", (_req, res) => {
  const now = Date.now();
  if (now - lastHealthLog >= HEALTH_LOG_SAMPLE_MS) {
    lastHealthLog = now;
    console.log(`[health] ok ${new Date().toISOString()}`);
  }
  res.status(200).send("ok");
});
app.get("/healthz", (_req, res) => res.json({ ok: true }));

/* ---------------------------- OpenAI SDK ---------------------------- */

const openai = new OpenAI({ apiKey: OPENAI_KEY });

/* ----------------------------- Helpers ------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const safeParseJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
};
const bodyObj = (req) =>
  typeof req.body === "string" ? safeParseJson(req.body) : req.body || {};

// Some hosted SDKs changed prefixes in the past. Keep validation permissive.
const looksLikeId = (val, expectedPrefix) =>
  typeof val === "string" &&
  val.length > expectedPrefix.length + 6 && // cheap length check
  val.startsWith(expectedPrefix);

const isBad = (v) =>
  v == null ||
  v === "" ||
  v === "undefined" ||
  v === "null" ||
  (typeof v === "string" && v.trim() === "");

// Optional tools / tool_resources
const getTools = () => [{ type: "file_search" }];
const getToolResources = () => {
  if (!ENABLE_TOOL_RESOURCES) return undefined;
  if (!VS_IDS.length) return undefined;
  return { file_search: { vector_store_ids: VS_IDS } };
};

// Create a thread (helper)
async function createThread() {
  const t = await openai.beta.threads.create();
  return t.id;
}

async function addUserMessage(threadId, text) {
  if (isBad(threadId)) throw new Error("Missing threadId");
  if (isBad(text)) return;
  await openai.beta.threads.messages.create(threadId, {
    role: "user",
    content: String(text),
  });
}

async function startRun(threadId, modelOverride) {
  const tool_resources = getToolResources();
  if (ASST_DEFAULT) {
    return openai.beta.threads.runs.create(threadId, {
      assistant_id: ASST_DEFAULT,
      tools: getTools(),
      ...(tool_resources ? { tool_resources } : {}),
    });
  }
  return openai.beta.threads.runs.create(threadId, {
    model: modelOverride || DEFAULT_MODEL,
    instructions: ASST_INSTRUCTIONS,
    tools: getTools(),
    ...(tool_resources ? { tool_resources } : {}),
  });
}

/* ----------------------------- API: Threads ------------------------- */

// POST /api/threads  -> { id, ... }
app.post(`${API_BASE}/threads`, async (_req, res) => {
  try {
    const id = await createThread();
    res.json({ id });
  } catch (e) {
    console.error("Create thread error:", e);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/threads/:threadId/messages  -> append a user message
app.post(`${API_BASE}/threads/:threadId/messages`, async (req, res) => {
  try {
    const { threadId } = req.params;
    if (isBad(threadId) || !looksLikeId(threadId, "thread_")) {
      return res.status(400).json({ error: "Invalid threadId" });
    }
    const b = bodyObj(req);
    const text = b.content || b.message || b.text || "";
    if (isBad(text)) return res.status(400).json({ error: "Missing message text" });

    const msg = await openai.beta.threads.messages.create(threadId, {
      role: "user",
      content: text,
    });
    res.json(msg);
  } catch (e) {
    console.error("Add message error:", e);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// POST /api/threads/:threadId/runs  -> start run (optionally accepts {message})
app.post(`${API_BASE}/threads/:threadId/runs`, async (req, res) => {
  try {
    let { threadId } = req.params;

    // Guard against “undefined/null” in the URL (common client bug)
    if (isBad(threadId) || !looksLikeId(threadId, "thread_")) {
      return res.status(400).json({
        error:
          "Missing or invalid threadId. Create a thread first or use /api/run to auto-create.",
      });
    }

    const b = bodyObj(req);
    const userText = b.message || b.text || b.input || "";

    if (!isBad(userText)) {
      await addUserMessage(threadId, userText);
    }

    const run = await startRun(threadId, b.model);
    res.json(run);
  } catch (e) {
    console.error("Start run error:", e);
    res.status(e.status || 500).json({ error: e.message, details: e.data ?? null });
  }
});

// GET /api/threads/:threadId/runs/:runId  -> retrieve run
app.get(`${API_BASE}/threads/:threadId/runs/:runId`, async (req, res) => {
  try {
    const { threadId, runId } = req.params;
    if (isBad(threadId) || !looksLikeId(threadId, "thread_")) {
      return res.status(400).json({ error: "Invalid threadId" });
    }
    if (isBad(runId) || !looksLikeId(runId, "run_")) {
      return res.status(400).json({ error: "Invalid runId" });
    }
    const run = await openai.beta.threads.runs.retrieve(threadId, runId);
    res.json(run);
  } catch (e) {
    console.error("Retrieve run error:", e);
    res.status(e.status || 500).json({ error: e.message, details: e.data ?? null });
  }
});

// GET /api/threads/:threadId/messages -> list messages (handy for debugging)
app.get(`${API_BASE}/threads/:threadId/messages`, async (req, res) => {
  try {
    const { threadId } = req.params;
    if (isBad(threadId) || !looksLikeId(threadId, "thread_")) {
      return res.status(400).json({ error: "Invalid threadId" });
    }
    const msgs = await openai.beta.threads.messages.list(threadId);
    res.json(msgs);
  } catch (e) {
    console.error("List messages error:", e);
    res.status(e.status || 500).json({ error: e.message });
  }
});

/* ---------------- Convenience: Create/Run/Poll in one ---------------- */

// POST /api/run
// Body: { message: string, thread_id?: string, model?: string }
// → auto-creates a thread if missing, appends message, starts run, polls to done,
//   returns { ok, answer, thread_id, run_id }
app.post(`${API_BASE}/run`, async (req, res) => {
  try {
    const b = bodyObj(req);
    let { thread_id: threadId, message, text, input, model } = b || {};
    const userText = message || text || input || "";

    if (isBad(userText)) {
      return res.status(400).json({ ok: false, error: "Field 'message' (or 'text'/'input') is required" });
    }

    if (isBad(threadId) || !looksLikeId(threadId, "thread_")) {
      threadId = await createThread();
    }

    await addUserMessage(threadId, userText);
    const run = await startRun(threadId, model);
    const runId = run.id;

    // Poll until done (avoid log spam)
    let status = run.status;
    while (status === "queued" || status === "in_progress") {
      await sleep(900);
      const r = await openai.beta.threads.runs.retrieve(threadId, runId);
      status = r.status;
    }

    // Fetch latest assistant message for this run
    const msgs = await openai.beta.threads.messages.list(threadId);
    const last = msgs.data.find((m) => m.role === "assistant" && m.run_id === runId);
    const answer = last?.content?.find((c) => c.type === "text")?.text?.value ?? "";

    return res.json({ ok: true, answer, thread_id: threadId, run_id: runId });
  } catch (e) {
    console.error("One-shot run error:", e);
    return res.status(e.status || 500).json({ ok: false, error: e.message, details: e.data ?? null });
  }
});

/* ----------------------- Simple Chat Probe (no Threads) -------------- */

// POST /api/chat  -> quick key/egress test
app.post(`${API_BASE}/chat`, async (_req, res) => {
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      return res
        .status(r.status)
        .json({ ok: false, error: data?.error?.message || "OpenAI error" });
    }
    res.json({ ok: true, answer: data?.choices?.[0]?.message?.content ?? "" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ------------------------ Admin: Sync Knowledge ---------------------- */

function resolveSyncScript() {
  const candidates = [
    "./scripts/sync_knowledge_from_notion_files.mjs",
    "./scripts/sync_knowledge_v4.mjs",
  ];
  for (const rel of candidates) {
    const p = fileURLToPath(new URL(rel, import.meta.url));
    if (fs.existsSync(p)) return p;
  }
  return null;
}

app.post(`${API_BASE}/admin/sync-knowledge`, async (req, res) => {
  try {
    if (!ADMIN_TOKEN)
      return res
        .status(503)
        .json({ ok: false, error: "Sync disabled: set ADMIN_API_TOKEN or JWT_SECRET" });

    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const scriptPath = resolveSyncScript();
    if (!scriptPath) return res.status(500).json({ ok: false, error: "Sync script not found" });

    const child = spawn(process.execPath, ["-r", "dotenv/config", scriptPath], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "",
      stderr = "";
    const cap = (s, max = 200_000) => (s.length > max ? s.slice(-max) : s);
    child.stdout.on("data", (d) => (stdout = cap(stdout + d.toString())));
    child.stderr.on("data", (d) => (stderr = cap(stderr + d.toString())));

    const KILL_AFTER_MS = +(process.env.SYNC_TIMEOUT_MS || 120_000);
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, KILL_AFTER_MS);

    child.on("error", (err) => {
      clearTimeout(t);
      res.status(500).json({ ok: false, error: `spawn error: ${err.message}`, stdout, stderr });
    });

    child.on("close", (code) => {
      clearTimeout(t);
      const ok = code === 0 && !timedOut;
      res.status(ok ? 200 : 500).json({ ok, code, timedOut, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ---------------------------- 404 + Start --------------------------- */

app.use((_req, res) => res.status(404).json({ ok: false, error: "Not Found" }));

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✓ Assistant server listening on :${port}`);
  console.log(
    "[BOOT]",
    "ASST_DEFAULT",
    ASST_DEFAULT || "(model mode)",
    "VS",
    VS_IDS.length ? VS_IDS : "(none)",
    "tool_resources",
    ENABLE_TOOL_RESOURCES ? "enabled" : "disabled"
  );
});
