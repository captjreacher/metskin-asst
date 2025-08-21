import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import cors from "cors"; // optional
import sqlite3 from "sqlite3";

dotenv.config();

// Resolve __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// Get OpenAI key from environment, with fallback to OPENAI_API_KEY
const OPENAI_KEY = process.env.OPENAI_KEY || process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.error("FATAL: Missing OPENAI_KEY or OPENAI_API_KEY environment variable");
  process.exit(1);
}



const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Optional prebuilt assistant. If not set, we call with model+instructions.
const ASST_DEFAULT = process.env.ASST_DEFAULT || "";

// Vector store IDs used by file_search; support single or comma-separated list.
const VS_IDS = Array.from(
  new Set(
    (process.env.VECTOR_STORE_IDS || process.env.VECTOR_STORE_ID || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  )
);

// Assistant instructions (fallback includes the training status phrase)
const ASST_INSTRUCTIONS =
  process.env.ASST_INSTRUCTIONS ||
  [
    "You are the Metamorphosis Product Assistant.",
    "Use file_search over the knowledge base to answer accurately and concisely.",
    "If the user says 'metskin-asst training status', reply exactly:",
    "Fully Trained and Reporting for Duty Captain",
  ].join(" ");

// Feature flags & debug
const on = (v) => /^(1|true|yes|on)$/i.test(String(v ?? ""));
const DBG_REQ = on(process.env.DEBUG_LOG_REQUESTS);
const DBG_BOD = on(process.env.DEBUG_LOG_BODIES);
const DBG_OA = on(process.env.DEBUG_OPENAI);
const ENABLE_CORS = on(process.env.ENABLE_CORS);

// Health log sampling (to avoid log spam on Render)
const HEALTH_LOG_SAMPLE_MS = Number(process.env.HEALTH_LOG_SAMPLE_MS || 60_000);

// Admin token (for /admin/sync-knowledge and /dev-token)
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN || process.env.JWT_SECRET || "";

// Optional cron schedule, e.g. "*/15 * * * *"
const SYNC_CRON = (process.env.SYNC_CRON || "").trim();

/* --------------------------- Crash Guards -------------------------- */

process.on("uncaughtException", (e) => console.error("[uncaught]", e));
process.on("unhandledRejection", (e) => console.error("[unhandled]", e));

/* ----------------------------- Express ----------------------------- */

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
  const origin = process.env.CORS_ORIGIN || true; // true = reflect request origin
  app.use(cors({ origin, credentials: true }));
  console.log("↪ CORS enabled. Origin:", origin === true ? "(dynamic)" : origin);
}

// Optional request logging via morgan (won’t crash if not installed)
let morgan;
try {
  morgan = (await import("morgan")).default;
} catch {
  console.warn("↪ morgan not installed; skipping request logging");
}
if (morgan) {
  app.use(
    morgan("combined", {
      skip: (req) => req.path === "/health", // keep health probes quiet
    })
  );
}

// Lightweight request/body debug
if (DBG_REQ) app.use((req, _res, next) => { console.log(`[REQ] ${req.method} ${req.url}`); next(); });

const safeParseJson = (s) => {
  try { return JSON.parse(s); } catch { return {}; }
};
const cleanCopy = (x) => {
  try { return JSON.parse(JSON.stringify(x || {})); } catch { return x; }
};
if (DBG_BOD) {
  app.use((req, _res, next) => {
    if (req.method !== "GET") {
      const b = typeof req.body === "string" ? safeParseJson(req.body) : (req.body || {});
      console.log(`[BODY] ${req.method} ${req.path}`, cleanCopy(b));
    }
    next();
  });
}

/* ------------------------------ Health ----------------------------- */

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

/* --------------------------- OpenAI Client -------------------------- */

const openai = new OpenAI({ apiKey: OPENAI_KEY });

/* ----------------------------- Helpers ----------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bodyObj = (req) => (typeof req.body === "string" ? safeParseJson(req.body) : (req.body || {}));
const validateId = (res, id, prefix, name, status = 400) => {
  if (!id?.startsWith(prefix)) {
    res.status(status).json({ ok: false, error: `Invalid ${name}`, [name]: id });
    return false;
  }
  return true;
};

/* ---------------------- Assistants Compat Routes -------------------- */

/** Create thread */
app.post("/threads", async (_req, res) => {
  try {
    const t = await openai.beta.threads.create();
    res.json(t);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/** Add a user message */
app.post("/threads/:threadId/messages", async (req, res) => {
  try {
    const threadId = req.params.threadId;
    if (!validateId(res, threadId, "thread_", "threadId")) return;
    const body = bodyObj(req);
    const text = body.content || body.message || body.text || "";
    if (!text) return res.status(400).json({ error: "Missing message text" });
    const msg = await openai.beta.threads.messages.create(threadId, { role: "user", content: text });
    res.json(msg);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/** Start a run */
app.post("/threads/:threadId/runs", async (req, res) => {
  try {
    const threadId = req.params.threadId;
    if (!validateId(res, threadId, "thread_", "threadId")) return;
    const tool_resources = VS_IDS.length ? { file_search: { vector_store_ids: VS_IDS } } : undefined;
    const payload = ASST_DEFAULT
      ? { assistant_id: ASST_DEFAULT, tools: [{ type: "file_search" }], tool_resources }
      : { model: DEFAULT_MODEL, instructions: ASST_INSTRUCTIONS, tools: [{ type: "file_search" }], tool_resources };
    const run = await openai.beta.threads.runs.create(threadId, payload);
    res.json(run);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/** Poll a run (guarded) */
app.get("/threads/:threadId/runs/:runId", async (req, res) => {
  try {
    const { threadId, runId } = req.params;
    if (!validateId(res, threadId, "thread_", "threadId")) return;
    if (!validateId(res, runId, "run_", "runId")) return;
    const run = await openai.beta.threads.runs.retrieve(threadId, runId);
    res.json(run);
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, details: e.data ?? null });
  }
});

/* -------------------------- SDK-only Ask ---------------------------- */
/** Convenience: send message + run + poll + return final text (no self-HTTP) */
app.post("/assistant/ask", async (req, res) => {
  try {
    // Parse body (PowerShell-safe)
    const isString = typeof req.body === "string";
    let b;
    try { b = isString ? JSON.parse(req.body) : (req.body || {}); }
    catch { b = { message: String(req.body || "") }; }

    let { thread_id: threadId, message, text, model } = b;
    const userText = message || text || "";
    if (!userText) return res.status(400).json({ ok: false, error: "Field 'message' (or 'text') is required" });

    // Create thread if not supplied
    if (!threadId) {
      const t = await openai.beta.threads.create();
      threadId = t.id;
    }
    if (!validateId(res, threadId, "thread_", "thread_id")) return;

    // Add message
    await openai.beta.threads.messages.create(threadId, { role: "user", content: userText });

    // Start run
    const tool_resources = VS_IDS.length ? { file_search: { vector_store_ids: VS_IDS } } : undefined;
    const payload = ASST_DEFAULT
      ? { assistant_id: ASST_DEFAULT, tools: [{ type: "file_search" }], tool_resources }
      : {
          model: model || DEFAULT_MODEL,
          instructions: ASST_INSTRUCTIONS,
          tools: [{ type: "file_search" }],
          tool_resources,
        };

    const run = await openai.beta.threads.runs.create(threadId, payload);
    const runId = run.id;
    if (!validateId(res, runId, "run_", "run_id", 502)) return;

    // Poll via SDK
    let status = "queued";
    do {
      await sleep(900);
      const r = await openai.beta.threads.runs.retrieve(threadId, runId);
      status = r.status;
      if (DBG_OA) console.log(`[OA] run ${runId} → ${status}`);
    } while (status === "queued" || status === "in_progress");

    // Fetch last assistant message for this run
    const msgs = await openai.beta.threads.messages.list(threadId);
    const last = msgs.data.find((m) => m.role === "assistant" && m.run_id === runId);
    const answer = last?.content?.find((c) => c.type === "text")?.text?.value ?? "";

    return res.json({ ok: true, answer, thread_id: threadId, run_id: runId });
  } catch (e) {
    return res.status(e.status || 500).json({ ok: false, error: e.message, details: e.data ?? null });
  }
});

/* ------------------------- OpenAI Probe Route ----------------------- */
/** Simple /chat probe to validate key+egress without Assistants */
app.post("/chat", async (_req, res) => {
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Hello" }] }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ ok: false, error: data?.error?.message || "OpenAI error" });
    res.json({ ok: true, answer: data?.choices?.[0]?.message?.content ?? "" });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ----------------------- Dev/Admin Endpoints ------------------------ */

/** Return a developer token (if configured) */
app.post("/dev-token", (_req, res) => {
  if (!ADMIN_TOKEN) return res.status(503).json({ error: "No ADMIN_API_TOKEN / JWT_SECRET set" });
  res.json({ token: ADMIN_TOKEN });
});

/** Resolve whichever sync script exists */
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

/** Trigger knowledge sync (protected) */
app.post("/admin/sync-knowledge", async (req, res) => {
  try {
    if (!ADMIN_TOKEN) return res.status(503).json({ ok: false, error: "Sync disabled: set ADMIN_API_TOKEN or JWT_SECRET" });
    const auth = req.headers["authorization"] || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== ADMIN_TOKEN) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const scriptPath = resolveSyncScript();
    if (!scriptPath) return res.status(500).json({ ok: false, error: "Sync script not found" });

    const child = spawn(process.execPath, ["-r", "dotenv/config", scriptPath], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "", stderr = "";
    const cap = (s, max = 200_000) => (s.length > max ? s.slice(-max) : s);
    child.stdout.on("data", (d) => (stdout = cap(stdout + d.toString())));
    child.stderr.on("data", (d) => (stderr = cap(stderr + d.toString())));

    const KILL_AFTER_MS = +(process.env.SYNC_TIMEOUT_MS || 120_000);
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, KILL_AFTER_MS);

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

/* -------------------------- Optional Cron --------------------------- */

if (SYNC_CRON) {
  try {
    const script = resolveSyncScript();
    if (!script) {
      console.warn("↪ SYNC_CRON set but no sync script found; skipping schedule.");
    } else {
      const cron = (await import("node-cron")).default;
      let running = false;
      cron.schedule(SYNC_CRON, () => {
        if (running) return;
        running = true;
        const child = spawn(process.execPath, ["-r", "dotenv/config", script], { env: process.env, stdio: "inherit" });
        child.on("close", () => { running = false; });
        child.on("error",  () => { running = false; });
      });
      console.log("✓ Notion/KB sync scheduled:", SYNC_CRON);
    }
  } catch (e) {
    console.warn("↪ Failed to schedule SYNC_CRON:", e.message);
  }
} else {
  console.log("↪ SYNC_CRON not set; no scheduled sync.");
}

/* --------------------------- 404 & Startup -------------------------- */

// Single 404 handler (must be last route)
app.use((_req, res) => res.status(404).json({ ok: false, error: "Not Found" }));

const port = process.env.PORT || 3000; // Render injects PORT
app.listen(port, () => {
  console.log(`✓ Assistant server listening on :${port}`);
  console.log(
    "[BOOT] Node", process.version,
    "ASST_DEFAULT", ASST_DEFAULT || "(none)",
    "VS", VS_IDS.length ? VS_IDS : "(none)"
  );
});
