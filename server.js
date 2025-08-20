// Metamorphosis Assistant — API Server (Responses v2 + Vector Stores)
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

const USE_ASSISTANT = on(process.env.USE_ASSISTANT_ID);
const ASST_DEFAULT  = process.env.ASST_DEFAULT || '';
if (USE_ASSISTANT && !ASST_DEFAULT) console.warn('[BOOT] USE_ASSISTANT_ID=true but ASST_DEFAULT is not set.');

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
export async function chatWithModel({ message, model = DEFAULT_MODEL }) {
  const resp = await openai.responses.create({
    model,
    input: [{ role: 'user', content: message }],
  });
  return resp.output_text;
}

/* ============================= Express app ============================= */
const app = express();
app.use(express.json({ limit: '1mb' }));
// Accept raw text on chat endpoints (curl/PowerShell quirks)
app.use(['/assistant/ask', '/send'], express.text({ type: '*/*', limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
const bodyObj = (req) => (typeof req.body === 'string' ? safeParseJson(req.body) : (req.body || {}));

/* ============================= Responses API helpers ============================= */
const RESPONSES_URL = process.env.OPENAI_RESPONSES_URL || 'https://api.openai.com/v1/responses';
const OA_HEADERS = {
  Authorization: `Bearer ${OPENAI_KEY}`,
  'Content-Type': 'application/json',
  'OpenAI-Beta': 'assistants=v2', // for Responses attachments
};
const headersForLog = (h) => ({
  Authorization: h.Authorization ? `Bearer ${h.Authorization.slice(7, 11)}…` : '(missing)',
  'OpenAI-Beta': h['OpenAI-Beta'] || '(none)',
  'Content-Type': h['Content-Type'],
});

// Minimal, safe message builder
const blocks = (text) => [
  { role: 'user', content: [{ type: 'input_text', text: String(text ?? '') }] },
];

// Attach vector stores using `attachments`
const withKnowledge = (payload) => {
  if (!VECTOR_STORE_IDS.length) return payload;

  const attachments = VECTOR_STORE_IDS.map((id) => ({
    vector_store_id: id,
    tools: [{ type: 'file_search' }],
  }));

  const existing = Array.isArray(payload.attachments) ? payload.attachments : [];
  return { ...payload, attachments: [...existing, ...attachments] };
};

async function callResponses(body, { timeoutMs = 45_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const req = { method: 'POST', headers: OA_HEADERS, body: JSON.stringify(body), signal: controller.signal };

  if (DBG_OA) {
    console.log('[OA HEADERS]', headersForLog(OA_HEADERS));
    console.log('[OA⇢]', RESPONSES_URL, '\n' + JSON.stringify(body, null, 2));
  }

  let resp, raw;
  try {
    resp = await fetch(RESPONSES_URL, req);
    raw = await resp.text();
  } finally {
    clearTimeout(timer);
  }
  if (DBG_OA) console.log('[OA⇠] HTTP', resp?.status, '\n' + raw);

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    json = { error: { message: raw || 'Non-JSON response' } };
  }
  if (!resp.ok) {
    const err = new Error(json?.error?.message || json?.message || `OpenAI error (HTTP ${resp.status})`);
    err.status = resp.status;
    err.data = json;
    throw err;
  }
  return json;
}

/* ============================= Thread state ============================= */
const lastResponseIdByThread = new Map();

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
      USE_ASSISTANT_ID: USE_ASSISTANT,
      ASST_DEFAULT: USE_ASSISTANT ? (ASST_DEFAULT ? 'set' : 'missing') : '(not used)',
      DEBUG: { DEBUG_LOG_REQUESTS: DBG_REQ, DEBUG_LOG_BODIES: DBG_BOD, DEBUG_OPENAI: DBG_OA },
      SYNC_CRON: cronExpr || null,
      NEED_BETA: true,
    },
  });
});
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/start-chat', (_req, res) => res.json({ ok: true, thread_id: crypto.randomUUID() }));

// First turn
app.post('/assistant/ask', async (req, res) => {
  try {
    const body = bodyObj(req);
    const { message, text, model, thread_id } = body;
    const userText = (typeof message === 'string' && message) || (typeof text === 'string' && text) || '';
    if (!userText) return res.status(400).json({ ok: false, error: "Field 'message' (or 'text') is required" });

    const prior = thread_id ? lastResponseIdByThread.get(thread_id) : undefined;

    const payload = withKnowledge({
      model: model || DEFAULT_MODEL,
      instructions: ASST_INSTRUCTIONS,
      input: blocks(userText),
      store: true,
      ...(prior ? { previous_response_id: prior } : {}),
      ...(USE_ASSISTANT && ASST_DEFAULT ? { assistant_id: ASST_DEFAULT } : {}),
    });

    const data = await callResponses(payload);
    if (thread_id && data?.id) lastResponseIdByThread.set(thread_id, data.id);

    const answer = data?.output_text ?? (Array.isArray(data?.output) && data.output[0]?.content?.[0]?.text) ?? '';
    res.json({ ok: true, answer, data_id: data?.id ?? null });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, details: e.data ?? null });
  }
});

// Follow-ups
app.post('/send', async (req, res) => {
  try {
    const body = bodyObj(req);
    const { thread_id, thread, text, message, model } = body;
    const conv = (typeof thread_id === 'string' && thread_id) || (typeof thread === 'string' && thread) || '';
    const userText = (typeof text === 'string' && text) || (typeof message === 'string' && message) || '';
    if (!conv)     return res.status(400).json({ ok: false, error: "Field 'thread_id' (or 'thread') is required" });
    if (!userText) return res.status(400).json({ ok: false, error: "Field 'text' (or 'message') is required" });

    const prior = lastResponseIdByThread.get(conv);

    const payload = withKnowledge({
      model: model || DEFAULT_MODEL,
      instructions: ASST_INSTRUCTIONS,
      input: blocks(userText),
      store: true,
      ...(prior ? { previous_response_id: prior } : {}),
      ...(USE_ASSISTANT && ASST_DEFAULT ? { assistant_id: ASST_DEFAULT } : {}),
    });

    const data = await callResponses(payload);
    if (data?.id) lastResponseIdByThread.set(conv, data.id);

    const msg = data?.output_text ?? (Array.isArray(data?.output) && data.output[0]?.content?.[0]?.text) ?? '';
    res.json({ ok: true, message: msg, data_id: data?.id ?? null });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message, details: e.data ?? null });
  }
});

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
  console.log('[BOOT] Node', process.version, 'USE_ASSISTANT_ID', USE_ASSISTANT, 'VS', VECTOR_STORE_IDS);
});
