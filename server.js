// server.js
// Node 18+ (ESM). Ensure package.json has: { "type": "module" }

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';

// ---------- App & core config ----------
const app  = express();
const PORT = process.env.PORT || 3001;

app.enable('trust proxy'); // required on Render

// Canonical host (optional but recommended)
const CANONICAL_HOST = process.env.CANONICAL_HOST; // e.g. metamorphosis.assist.maximisedai.com
app.use((req, res, next) => {
  if (CANONICAL_HOST && req.headers.host && req.headers.host !== CANONICAL_HOST) {
    return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
  }
  next();
});

// HSTS (optional hardening)
app.use((_, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  next();
});

// CORS (lock to your domain + local dev)
const ALLOW_ORIGINS = new Set([
  'https://metamorphosis.assist.maximisedai.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);       // curl/Postman/server-to-server
    cb(null, ALLOW_ORIGINS.has(origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

// ---------- Admin token (ONE copy only) ----------
const ADMIN = (process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '').trim();
const ADMIN_SOURCE = process.env.ADMIN_TOKEN
  ? 'ADMIN_TOKEN'
  : (process.env.ADMIN_API_TOKEN ? 'ADMIN_API_TOKEN' : 'none');
const ADMIN_LAST4 = ADMIN ? ADMIN.slice(-4) : null;

console.log(`[boot] admin source=${ADMIN_SOURCE} len=${ADMIN.length}`);

function requireAdminBearer(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok || tok !== ADMIN) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

// ---------- Notion config ----------
const NOTION_TOKEN  = process.env.NOTION_TOKEN || '';
const NOTION_DB_ID  = process.env.NOTION_SAMPLES_DB_ID || process.env.NOTION_DB_ID || '';
const NOTION_VERSION = '2022-06-28';
const notionEnabled = Boolean(NOTION_TOKEN && NOTION_DB_ID);

const NOTION_H = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json',
};

// ---------- Helpers ----------
const nowIso = () => new Date().toISOString();
const redact = (str, keep = 4) => {
  if (!str) return '';
  if (str.length <= keep) return '*'.repeat(str.length);
  return `${str.slice(0, keep)}…${'*'.repeat(Math.max(0, str.length - keep - 1))}`;
};

// Optional: simple log row creator
async function notionCreateSampleLog({ threadId, runId, args = {}, downstream = {}, meta = {} }) {
  if (!notionEnabled) return { skipped: true, reason: 'notion disabled' };

  const props = {
    Name:     { title: [{ text: { content: `Thread ${threadId || ''}` } }] },
    Run:      { rich_text: [{ text: { content: runId || '' } }] },
    Thread:   threadId ? { rich_text: [{ text: { content: threadId } }] } : undefined,
    Campaign: meta?.campaign ? { rich_text: [{ text: { content: meta.campaign } }] } : undefined,
    Args:       Object.keys(args).length ? { rich_text: [{ text: { content: JSON.stringify(args) } }] } : undefined,
    Downstream: Object.keys(downstream).length ? { rich_text: [{ text: { content: JSON.stringify(downstream) } }] } : undefined,
  };
  Object.keys(props).forEach(k => props[k] === undefined && delete props[k]);

  const r = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: NOTION_H,
    body: JSON.stringify({ parent: { database_id: NOTION_DB_ID }, properties: props }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Notion create failed: ${r.status} ${JSON.stringify(j)}`);
  return { ok: true, page_id: j.id };
}

// Find a page by Sample_id (TITLE) and update Order_status (RICH_TEXT)
async function notionUpdateBySampleId({ sample_id, order_status, sent_by }) {
  if (!notionEnabled) throw new Error('Notion not configured');

  // Query by exact title; switch to "contains" if needed.
  const q = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
    method: 'POST',
    headers: NOTION_H,
    body: JSON.stringify({
      filter: { property: 'sample_id', title: { equals: sample_id } },
      page_size: 1,
    }),
  });
  const qj = await q.json();
  if (!q.ok) throw new Error(`Notion query failed: ${q.status} ${JSON.stringify(qj)}`);

  const page = qj.results?.[0];
  if (!page) throw new Error(`sample_id "${sample_id}" not found`);

  const props = {
    // order_status is rich_text (NOT select)
    'order_status': { rich_text: [{ text: { content: String(order_status || '') } }] },
    'date_sent':    { date: { start: nowIso() } },
    'sent_by':      { rich_text: [{ text: { content: String(sent_by || '') } }] },
  };

  const u = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
    method: 'PATCH',
    headers: NOTION_H,
    body: JSON.stringify({ properties: props }),
  });
  const uj = await u.json();
  if (!u.ok) throw new Error(`Notion update failed: ${u.status} ${JSON.stringify(uj)}`);

  return { ok: true, page_id: page.id };
}

// ---------- Routes ----------
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    time: nowIso(),
    admin: { source: ADMIN_SOURCE, len: ADMIN.length, last4: ADMIN_LAST4 },
    env: { port: String(PORT), notion_enabled: notionEnabled, notion_db_id: redact(NOTION_DB_ID) },
    routes: [
      'GET    /health',
      'GET    /dev/auth/ping',
      'GET    /dev/debug/echo-auth',
      'PATCH  /dev/samples/:sample_id/status',
    ],
  });
});

// Option A: redirect root to health
app.get('/', (req, res) => res.redirect(302, '/health'));

// Option B: small landing JSON
app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'metskin-asst',
    endpoints: [
      'GET /health',
      'GET /dev/auth/ping',
      'PATCH /dev/samples/:sample_id/status'
    ]
  });
});

// Debug: show what Authorization header the server received
app.get('/dev/debug/echo-auth', (req, res) => {
  res.json({ auth: req.headers.authorization || null });
});

// Protected ping (auth only, no Notion)
app.get('/dev/auth/ping', requireAdminBearer, (req, res) => {
  res.json({ ok: true, message: 'auth ok' });
});

// Update status by sample_id (Admin-protected)
app.patch('/dev/samples/:sample_id/status', requireAdminBearer, async (req, res) => {
  try {
    const { sample_id } = req.params;
    const { order_status, sent_by } = req.body || {};
    if (!sample_id)    return res.status(400).json({ ok: false, error: 'sample_id is required' });
    if (!order_status) return res.status(400).json({ ok: false, error: 'order_status is required' });

    const result = await notionUpdateBySampleId({ sample_id, order_status, sent_by });
    res.json({ ok: true, sample_id, order_status, sent_by, result });
  } catch (err) {
    console.error('[PATCH /dev/samples/:sample_id/status] error:', err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// (Optional) Dev helper: mint a token
app.post('/dev/make-token', (req, res) => {
  const token = 'dev_' + crypto.randomBytes(16).toString('hex');
  res.json({ ok: true, token });
});

// Fallback 404
app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found', path: req.path }));

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
  if (!notionEnabled) console.log('[warn] Notion disabled – set NOTION_TOKEN and NOTION_DB_ID/NOTION_SAMPLES_DB_ID');
});