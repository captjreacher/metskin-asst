// server.js — Metamorphosis Assistant API (Assistants API v2, ESM)

import express from "express";
import dotenv from "dotenv";
dotenv.config();

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import cron from "node-cron";
import OpenAI from "openai";

// Optional CORS (enable via ENABLE_CORS=true)
import cors from "cors";

// ------------------ Paths / ESM __dirname ------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------------ Env & flags ------------------
const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.error("[BOOT] Missing OPENAI_API_KEY");
  process.exit(1);
}

const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const on = (v) => /^(1|true|yes|on)$/i.test(String(v ?? ""));
const csv = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);

// Vector stores (support single or list)
const vsSingle =
  process.env.VECTOR_STORE_ID ||
  process.env.VS_DEFAULT ||
  process.env.VS_METAMORPHOSIS ||
  "";
const vsMulti = process.env.VECTOR_STORE_IDS ? csv(process.env.VECTOR_STORE_IDS) : [];
const VECTOR_STORE_IDS = Array.from(new Set([...(vsSingle ? [vsSingle] : []), ...vsMulti])).filter(Boolean);
if (!VECTOR_STORE_IDS.length) console.warn("[BOOT] No vector stores set. Add VECTOR_STORE_ID or VECTOR_STORE_IDS.");

const ASST_DEFAULT = process.env.ASST_DEFAULT || "";
if (!ASST_DEFAULT) console.warn("[BOOT] ASST_DEFAULT is not set.");

const ASST_INSTRUCTIONS =
  process.env.ASST_INSTRUCTIONS ||
  "You are the Metamorphosis Product Assistant. Use file_search over the knowledge base to answer accurately and concisely. If user says 'metskin-asst training status', reply exactly: 'Fully Trained and Reporting for Duty Captain'.";

// Debug flags
const DBG_REQ = on(process.env.DEBUG_LOG_REQUESTS);
const DBG_BOD = on(process.env.DEBUG_LOG_BODIES);
const DBG_OA = on(process.env.DEBUG_OPENAI);

// ------------------ Crash guards ------------------
process.on("uncaughtException", (e) => console.error("[uncaught]", e));
process.on("unhandledRejection", (e) => console.error("[unhandled]", e));

// ------------------ Express app ------------------
const app = express();
app.use(express.json({ limit: "2mb" }));
// Accept raw text on chat endpoints (curl/PowerShell quirks)
app.use(["/assistant/ask", "/send"], express.text({ type: "*/*", limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Optional CORS
if (on(process.env.ENABLE_CORS)) {
  const corsOrigin = process.env.CORS_ORIGIN || true; // true = reflect request origin
  app.use(cors({ origin: corsOrigin, credentials: true }));
  console.log("↪ CORS enabled. Origin:", corsOrigin === true ? "(dynamic)" : corsOrigin);
}

// Optional request logging via morgan (safe if not installed)
let morgan;
try {
  morgan = (await import("morgan")).default;
} catch {
  console.warn("morgan not installed; skipping request logging");
}
if (morgan) {
  app.use(
    morgan("combined", {
      skip: (req) => req.path === "/health",
    })
  );
}

// Throttle /health logs to avoid spam
let lastHealthLog = 0;
app.get("/health", (_req, res) => {
  const now = Date.now();
  const sampleMs = Number(process.env.HEALTH_LOG_SAMPLE_MS || 60000); // 60s
  if (now - lastHealthLog >= sampleMs) {
    lastHealthLog = now;
    console.log(`[health] ok ${new Date().toISOString()}`);
  }
  res.status(200).send("ok");
});
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) => res.status(200).send("alive"));

// Simple request logging / body dump (debug)
if (DBG_REQ) app.use((req, _res, next) => { console.log(`[REQ] ${req.method} ${req.url}`); next(); });
const safeParseJson = (s) => { try { return JSON.parse(s); } catch { return {}; } };
const redact = (x) => { try { return JSON.parse(JSON.stringify(x || {})); } catch { return {}; } };
if (DBG_BOD) app.use((req, _res, next) => {
  if (req.path === "/assistant/ask" || req.path === "/send") {
    const body = typeof req.body === "string" ? safeParseJson(req.body) : (req.body || {});
    console.log(`[BODY ${req.method} ${req.path}]`, redact(body));
  }
  next();
});

// Invalid JSON → 400
app.use((err, _req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, error: "Invalid JSON payload", details: String(err.message || "") });
  }
  next(err);
});

const bodyObj = (req) => (typeof req.body === "string" ? safeParseJson(req.body) : (req.body || {}));

// ------------------ OpenAI client ------------------
const openai = new OpenAI({ apiKey: OPENAI_KEY });

// ------------------ Assistants helpers ------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getAssistantResponse(threadId, runId) {
  let runStatus;
  do {
    await sleep(1000);
    const run = await openai.beta.threads.runs.retrieve(threadId, runId);
    runStatus = run.status;
    if (DBG_OA) console.log(`[OA] Run status for ${runId}: ${runStatus}`);
  } while (runStatus === "queued" || runStatus === "in_progress");

  if (runStatus === "completed") {
    const messages = await openai.beta.threads.messages.list(threadId);
    const lastMessage = messages.data.find((m) => m.run_id === runId && m.role === "assistant");
    if (lastMessage) {
      const content = lastMessage.content[0];
      if (content?.type === "text") return content.text.value || "";
    }
    return "";
  } else {
    const run = await openai.beta.threads.runs.retrieve(threadId, runId);
    const errorMessage = run.last_error ? run.last_error.message : `Run failed with status: ${runStatus}`;
    throw new Error(errorMessage);
  }
}

// ------------------ Thread store (ephemeral) ------------------
const threadStore = new Map();

// ------------------ Routes ------------------
app.get("/start-chat", async (_req, res) => {
  try {
    const thread = await openai.beta.threads.create();
    threadStore.set(thread.id, thread);
    res.json({ ok: true, thread_id: thread.id });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

async function handleChat(req, res) {
  try {
    const body = bodyObj(req);
    let { thread_id, message, text, model } = body;
    const userText = message || text || "";
    if (!userText) return res.status(400).json({ ok: false, error: "Field 'message' (or 'text') is required" });

    if (!thread_id) {
      const thread = await openai.beta.threads.create();
      thread_id = thread.id;
    }

    await openai.beta.threads.messages.create(thread_id, { role: "user", content: userText });

    const toolResources =
      VECTOR_STORE_IDS.length > 0
        ? { file_search: { vector_store_ids: VECTOR_STORE_IDS } }
        : {};

    const run = await openai.beta.threads.runs.create(thread_id, {
      assistant_id: ASST_DEFAULT, // if omitted, model+instructions still work
      model: model || DEFAULT_MODEL,
      instructions: ASST_INSTRUCTIONS,
      tools: [{ type: "file_search" }],
      tool_resources: toolResources,
    });

    const answer = await getAssistantResponse(thread_id, run.id);
    res.json({ ok: true, answer, data_id: run.id, thread_id });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, details: e.data ?? null });
  }
}

app.post("/assistant/ask", handleChat);
app.post("/send", handleChat);

// Simple probe using Chat Completions API
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

// Admin: trigger Notion → VectorStore sync
app.post("/admin/sync-knowledge", async (req, res) => {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const expected = process.env.ADMIN_API_TOKEN || process.env.JWT_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: "Sync disabled: set ADMIN_API_TOKEN or JWT_SECRET" });
  if (!token || token !== expected) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const scriptPath = fileURLToPath(new URL("./scripts/sync_knowledge_from_notion_files.mjs", import.meta.url));
  if (!fs.existsSync(scriptPath)) return res.status(500).json({ ok: false, error: "Sync script not found", scriptPath });

  const child = spawn(process.execPath, ["-r", "dotenv/config", scriptPath], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  const cap = (s, max = 200_000) => (s.length > max ? s.slice(-max) : s);
  child.stdout.on("data", (d) => (stdout = cap(stdout + d.toString())));
  child.stderr.on("data", (d) => (stderr = cap(stderr + d.toString())));
  const KILL_AFTER_MS = +(process.env.SYNC_TIMEOUT_MS || 120_000);
  const t = setTimeout(() => { timedOut = true; try { child.kill("SIGKILL"); } catch {} }, KILL_AFTER_MS);
  child.on("error", (err) => { clearTimeout(t); return res.status(500).json({ ok: false, error: `spawn error: ${err.message}`, scriptPath, stdout, stderr }); });
  child.on("close", (code) => { clearTimeout(t); const ok = code === 0 && !timedOut; return res.status(ok ? 200 : 500).json({ ok, code, timedOut, scriptPath, stdout: stdout.trim(), stderr: stderr.trim() }); });
});

// 404
app.use((_req, res) => res.status(404).json({ ok: false, error: "Not Found" }));

// ------------------ Optional: schedule Notion sync ------------------
const cronExpr = (process.env.SYNC_CRON || "").trim();
if (cronExpr) {
  try {
    const scriptPath = fileURLToPath(new URL("./scripts/sync_knowledge_from_notion_files.mjs", import.meta.url));
    let running = false;
    cron.schedule(cronExpr, () => {
      if (running) return;
      running = true;
      const child = spawn(process.execPath, ["-r", "dotenv/config", scriptPath], { env: process.env, stdio: "inherit" });
      child.on("close", () => { running = false; });
      child.on("error", () => { running = false; });
    });
    console.log("✓ Notion sync scheduled:", cronExpr);
  } catch (e) {
    console.error("[BOOT] Failed to schedule SYNC_CRON:", e.message);
  }
} else {
  console.log("↪ SYNC_CRON not set; no scheduled sync.");
}

// ------------------ Start ------------------
const port = process.env.PORT || 3000; // Render injects PORT
app.listen(port, () => {
  console.log(`✓ Assistant server listening on :${port}`);
  console.log("[BOOT] Node", process.version, "ASST_DEFAULT", ASST_DEFAULT || "(none)", "VS", VECTOR_STORE_IDS);
});
