// Metamorphosis Assistant — API Server (Assistants API v2)
// -------------------------------------------------------------------
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { spawn } from 'node:child_process';
import express from 'express';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import OpenAI from 'openai';

// Optional CORS (enable if your frontend is on a different domain)
import cors from 'cors';

/* ============================= Env & Flags ============================= */
const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) { console.error('[BOOT] Missing OPENAI_API_KEY'); process.exit(1); }

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const on  = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));
const csv = (s) => (s || '').split(',').map(x => x.trim()).filter(Boolean);

// Vector stores (support both single + list envs)
const vsSingle = process.env.VECTOR_STORE_ID || process.env.VS_DEFAULT || process.env.VS_METAMORPHOSIS || '';
const vsMulti  = process.env.VECTOR_STORE_IDS ? csv(process.env.VECTOR_STORE_IDS) : [];
const VECTOR_STORE_IDS = Array.from(new Set([...(vsSingle ? [vsSingle] : []), ...vsMulti])).filter(Boolean);
if (!VECTOR_STORE_IDS.length) console.warn('[BOOT] No vector stores set. Add VECTOR_STORE_ID or VECTOR_STORE_IDS.');

const ASST_DEFAULT  = process.env.ASST_DEFAULT || '';
if (!ASST_DEFAULT) console.warn('[BOOT] ASST_DEFAULT is not set.');

const ASST_INSTRUCTIONS = process.env.ASST_INSTRUCTIONS ||
  'You are the Metamorphosis Assistant. Use file_search over the knowledge base to answer accurately and concisely.';

const DBG_REQ = on(process.env.DEBUG_LOG_REQUESTS);
const DBG_BOD = on(process.env.DEBUG_LOG_BODIES);
const DBG_OA  = on(process.env.DEBUG_OPENAI);

/* ============================= Crash Guards ============================= */
process.on('uncaughtException', (e) => console.error('[uncaught]', e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e));

/* ============================= __dirname (ESM) ============================= */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/* ============================= Optional: Notion sync cron ============================= */
const cronExpr = (process.env.SYNC_CRON || '').trim();
if (cronExpr) {
  try {
    const scriptPath = fileURLToPath(new URL('./scripts/sync_knowledge_from_notion_files.mjs', import.meta.url));
    let running = false;
    cron.schedule(cronExpr, () => {
      if (running) return;
      running = true;
      const child = spawn(process.execPath, [scriptPath], { env: process.env, stdio: 'inherit' });
      child.on('close', () => { running = false; });
      child.on('error',  () => { running = false; });
    });
    console.log('✓ Notion sync scheduled:', cronExpr);
  } catch (e) {
    console.error('[BOOT] Failed to schedule SYNC_CRON:', e.message);
  }
} else {
  console.log('↪ SYNC_CRON not set; no scheduled sync.');
}

/* ============================= OpenAI (single instance) ============================= */
const openai = new OpenAI({ apiKey: OPENAI_KEY });

/* ============================= Express app ============================= */
const app = express();
app.use(express.json({ limit: '2mb' }));
// Accept raw text on chat endpoints (curl/PowerShell quirks)
app.use(['/assistant/ask', '/send'], express.text({ type: '*/*', limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Optional CORS: allow single origin or all in DEV
if (on(process.env.ENABLE_CORS)) {
  const corsOrigin = process.env.CORS_ORIGIN || true; // true = reflect request origin
  app.use(cors({ origin: corsOrigin, credentials: true }));
  console.log('↪ CORS enabled. Origin:', corsOrigin === true ? '(dynamic)' : corsOrigin);
}

if (DBG_REQ) app.use((req, _res, next) => { console.log(`[REQ] ${req.method} ${req.url}`); next(); });
const redact = (x) => { try { return JSON.parse(JSON.stringify(x || {})); } catch { return {}; } };

if (DBG_BOD) app.use((req, _res, next) => {
  if (req.path === '/assistant/ask' || req.path === '/send') {
    console.log(`[BODY ${req.method} ${req.path}]`, typeof req.body === 'string' ? req.body : redact(req.body));
  }
  next();
});
// Invalid JSON → 400
app.use((err, _req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'Invalid JSON payload', details: String(err.message || '') });
  }
  next(err);
});

const safeParseJson = (s) => { try { return JSON.parse(s); } catch { return {}; } };
const bodyObj = (req) => {
    const body = typeof req.body === 'string' ? safeParseJson(req.body) : (req.body || {});
    // No longer need stripLegacyAttachments as we are not using it.
    return body;
}

/* ============================= Assistants API v2 helpers ============================= */

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function getAssistantResponse(threadId, runId) {
    let runStatus;
    do {
        await sleep(1000); // Poll every second
        const run = await openai.beta.threads.runs.retrieve(threadId, runId);
        runStatus = run.status;
        if (DBG_OA) console.log(`[OA] Run status for ${runId}: ${runStatus}`);
    } while (runStatus === 'queued' || runStatus === 'in_progress');

    if (runStatus === 'completed') {
        const messages = await openai.beta.threads.messages.list(threadId);
        const lastMessage = messages.data.find(m => m.run_id === runId && m.role === 'assistant');
        if (lastMessage) {
            const content = lastMessage.content[0];
            if(content.type === 'text') {
                return content.text.value;
            }
        }
        return '';
    } else {
        const run = await openai.beta.threads.runs.retrieve(threadId, runId);
        const errorMessage = run.last_error ? run.last_error.message : `Run failed with status: ${runStatus}`;
        throw new Error(errorMessage);
    }
}


/* ============================= Thread state ============================= */
// This is not a robust way to handle thread state in a production server.
// For a real application, you would want to store this in a database.
const threadStore = new Map();

/* ============================= Routes ============================= */
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    routes: [
      'GET  /', 'GET  /health', 'GET  /healthz', 'GET  /start-chat',
      'POST /assistant/ask', 'POST /send', 'POST /dev/make-token',
      'POST /chat', 'POST /admin/sync-knowledge',
    ],
    env: {
      OPENAI_API_KEY: OPENAI_KEY ? 'set' : 'missing',
      OPENAI_MODEL: DEFAULT_MODEL,
      VECTOR_STORE_IDS,
      ASST_DEFAULT: ASST_DEFAULT ? 'set' : 'missing',
      DEBUG: { DEBUG_LOG_REQUESTS: DBG_REQ, DEBUG_LOG_BODIES: DBG_BOD, DEBUG_OPENAI: DBG_OA },
      SYNC_CRON: cronExpr || null,
      ENABLE_CORS: on(process.env.ENABLE_CORS),
    },
  });
});
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/start-chat', async (_req, res) => {
    try {
        const thread = await openai.beta.threads.create();
        threadStore.set(thread.id, thread);
        res.json({ ok: true, thread_id: thread.id });
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// First turn and follow-ups are handled by the same logic now
async function handleChat(req, res) {
    try {
        const body = bodyObj(req);
        let { thread_id, message, text, model } = body;
        const userText = message || text || '';
        if (!userText) return res.status(400).json({ ok: false, error: "Field 'message' (or 'text') is required" });

        if (!thread_id) {
            const thread = await openai.beta.threads.create();
            thread_id = thread.id;
        }

        await openai.beta.threads.messages.create(thread_id, {
            role: 'user',
            content: userText,
        });

        const toolResources = VECTOR_STORE_IDS.length > 0 ? {
            file_search: {
                vector_store_ids: VECTOR_STORE_IDS
            }
        } : {};

        const run = await openai.beta.threads.runs.create(thread_id, {
            assistant_id: ASST_DEFAULT,
            model: model || DEFAULT_MODEL,
            instructions: ASST_INSTRUCTIONS,
            tools: [{ type: 'file_search' }],
            tool_resources: toolResources,
        });

        const answer = await getAssistantResponse(thread_id, run.id);

        res.json({ ok: true, answer: answer, data_id: run.id, thread_id: thread_id });
    } catch (e) {
        res.status(e.status || 500).json({ ok: false, error: e.message, details: e.data ?? null });
    }
}

app.post('/assistant/ask', handleChat);
app.post('/send', handleChat);


// Dev token (optional)
app.post('/dev/make-token', (req, res) => {
  try {
    if (!on(process.env.DEV_TOKEN_ENABLED)) return res.status(403).json({ ok: false, error: 'Disabled' });
    const { email, name = 'Guest', campaign = 'dev' } = bodyObj(req);
    if (!email || typeof email !== 'string') return res.status(400).json({ ok: false, error: "Field 'email' (string) is required" });
    const secret = process.env.JWT_SECRET; if (!secret) return res.status(500).json({ ok: false, error: 'JWT_SECRET missing' });
    const token = jwt.sign({ email, name, campaign }, secret, { expiresIn: '1h' });
    res.json({ ok: true, token });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Simple probe for chat-completions (separate from Responses)
app.post('/chat', async (_req, res) => {
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Hello' }] }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ ok: false, error: data?.error?.message || 'OpenAI error' });
    res.json({ ok: true, answer: data?.choices?.[0]?.message?.content ?? '' });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Admin: trigger Notion → VectorStore sync
app.post('/admin/sync-knowledge', async (req, res) => {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const expected = process.env.ADMIN_API_TOKEN || process.env.JWT_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'Sync disabled: set ADMIN_API_TOKEN or JWT_SECRET' });
  if (!token || token !== expected) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const scriptPath = fileURLToPath(new URL('./scripts/sync_knowledge_from_notion_files.mjs', import.meta.url));
  if (!fs.existsSync(scriptPath)) return res.status(500).json({ ok: false, error: 'Sync script not found', scriptPath });

  const child = spawn(process.execPath, ['-r', 'dotenv/config', scriptPath], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false;
  const cap = (s, max = 200_000) => (s.length > max ? s.slice(-max) : s);
  child.stdout.on('data', (d) => (stdout = cap(stdout + d.toString())));
  child.stderr.on('data', (d) => (stderr = cap(stderr + d.toString())));
  const KILL_AFTER_MS = +(process.env.SYNC_TIMEOUT_MS || 120_000);
  const t = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch {} }, KILL_AFTER_MS);
  child.on('error', (err) => { clearTimeout(t); return res.status(500).json({ ok: false, error: `spawn error: ${err.message}`, scriptPath, stdout, stderr }); });
  child.on('close', (code) => { clearTimeout(t); const ok = code === 0 && !timedOut; return res.status(ok ? 200 : 500).json({ ok, code, timedOut, scriptPath, stdout: stdout.trim(), stderr: stderr.trim() }); });
});

// 404
app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not Found' }));

/* ============================= Start ============================= */
const PORT = process.env.PORT || 10000; // Render injects PORT
app.listen(PORT, () => {
  console.log(`✓ Assistant server listening on :${PORT}`);
  console.log('[BOOT] Node', process.version, 'ASST_DEFAULT', ASST_DEFAULT, 'VS', VECTOR_STORE_IDS);
});
