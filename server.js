// server.js
// Node 18+ (ESM). package.json must include: { "type": "module" }

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';

// ------------------------- App & basics -------------------------
const app  = express();
const PORT = process.env.PORT || 3001;

app.enable('trust proxy');
app.use(express.json());

// Optional canonical redirect (Render-friendly)
const CANONICAL_HOST = (process.env.CANONICAL_HOST || '').trim();
app.use((req, res, next) => {
  if (CANONICAL_HOST && req.headers.host && req.headers.host !== CANONICAL_HOST) {
    return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
  }
  next();
});

// Simple security hardening
app.use((_, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  next();
});

// CORS (adjust as needed)
const ALLOW_ORIGINS = new Set([
  'https://metamorphosis.assist.maximisedai.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true); // curl/Postman/server-to-server
    cb(null, ALLOW_ORIGINS.has(origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ------------------------- Auth -------------------------
const ADMIN = (process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '').trim();
const ADMIN_SOURCE = process.env.ADMIN_TOKEN
  ? 'ADMIN_TOKEN'
  : (process.env.ADMIN_API_TOKEN ? 'ADMIN_API_TOKEN' : 'none');

function requireAdminBearer(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok || tok !== ADMIN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

// Assistant public switch (default: public like before)
const ASSIST_PUBLIC = (process.env.ASSIST_PUBLIC ?? 'true').toLowerCase() !== 'false';

// ------------------------- Notion config -------------------------
const NOTION_VERSION = '2022-06-28';

const NOTION_TOKEN_DEFAULT = (process.env.NOTION_TOKEN || '').trim(); // optional, for any default DB
const NOTION_DB_ID_DEFAULT = (process.env.NOTION_DB_ID || '').trim();  // optional, if you keep it

// Samples DB (used by PATCH)
const NOTION_TOKEN_SAMPLES = (process.env.NOTION_TOKEN_SAMPLES || NOTION_TOKEN_DEFAULT || '').trim();
const NOTION_SAMPLES_DB_ID = (process.env.NOTION_SAMPLES_DB_ID || '').trim();

// Title (Name) property used to look up the row by page title
const NOTION_TITLE_PROP = (process.env.NOTION_TITLE_PROP || 'Name').trim();

const notionEnabled = Boolean(NOTION_TOKEN_SAMPLES && NOTION_SAMPLES_DB_ID);

// Generic Notion fetch with per-call token
async function notionFetch(path, { token = NOTION_TOKEN_DEFAULT, method = 'GET', body } = {}) {
  const resp = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      'Authorization'  : `Bearer ${token}`,
      'Notion-Version' : NOTION_VERSION,
      'Content-Type'   : 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await resp.json().catch(() => ({}));
  return { resp, json };
}

// ------------------------- Routes -------------------------

// Root -> health (keeps the single entry point stable)
app.get('/', (_req, res) => res.redirect(302, '/health'));

// Health: shows config + available endpoints
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    admin: { source: ADMIN_SOURCE, len: ADMIN.length },
    env: {
      notion_samples_db_id: NOTION_SAMPLES_DB_ID ? NOTION_SAMPLES_DB_ID.slice(0, 8) : null,
      tokens: {
        samples_len: NOTION_TOKEN_SAMPLES.length,
        default_len: NOTION_TOKEN_DEFAULT.length,
        same: (NOTION_TOKEN_SAMPLES && NOTION_TOKEN_DEFAULT)
          ? NOTION_TOKEN_SAMPLES === NOTION_TOKEN_DEFAULT
          : null,
      },
      title_prop: NOTION_TITLE_PROP,
      assist_public: ASSIST_PUBLIC,
    },
    routes: [
      'GET   /health',
      'GET   /dev/auth/ping',
      'GET   /dev/debug/echo-auth',
      'PATCH /dev/samples/:sample_id/status',
      'POST  /assistant/ask',
      'POST  /dev/assistant/ask',
    ],
  });
});

// Debug: echo Authorization header the server received
app.get('/dev/debug/echo-auth', (req, res) => {
  res.json({ auth: req.headers.authorization || null });
});

// Protected ping
app.get('/dev/auth/ping', requireAdminBearer, (_req, res) => {
  res.json({ ok: true, message: 'auth ok' });
});

// PATCH: update a Samples row (lookup by page title == sample_id)
app.patch('/dev/samples/:sample_id/status', requireAdminBearer, async (req, res) => {
  if (!notionEnabled) {
    return res.status(500).json({
      ok: false,
      error: 'NOTION_SAMPLES_NOT_CONFIGURED',
      detail: 'Set NOTION_TOKEN_SAMPLES and NOTION_SAMPLES_DB_ID',
    });
  }

  try {
    const { sample_id } = req.params;
    const { order_status, sent_by } = req.body || {};

    if (!sample_id)    return res.status(400).json({ ok: false, error: 'sample_id is required' });
    if (!order_status) return res.status(400).json({ ok: false, error: 'order_status is required' });

    // 1) Find page by title (Name)
    const queryBody = {
      filter: { property: NOTION_TITLE_PROP, title: { equals: String(sample_id) } },
      page_size: 2,
    };
    const { resp: qResp, json: qJson } = await notionFetch(
      `/databases/${NOTION_SAMPLES_DB_ID}/query`,
      { token: NOTION_TOKEN_SAMPLES, method: 'POST', body: queryBody },
    );

    if (!qResp.ok) {
      return res.status(qResp.status).json({ ok: false, error: 'NOTION_QUERY_FAILED', detail: qJson });
    }
    if (!qJson.results?.length) {
      return res.status(404).json({ ok: false, error: 'SAMPLE_NOT_FOUND', sample_id });
    }

    const pageId = qJson.results[0].id;

    // 2) Update properties
    const updateBody = {
      properties: {
        order_status: { rich_text: [{ text: { content: String(order_status ?? '') } }] },
        sent_by:      { rich_text: [{ text: { content: String(sent_by ?? '') } }] },
        date_sent:    { date: { start: new Date().toISOString().slice(0, 10) } },
      },
    };

    const { resp: uResp, json: uJson } = await notionFetch(
      `/pages/${pageId}`,
      { token: NOTION_TOKEN_SAMPLES, method: 'PATCH', body: updateBody },
    );

    return res.status(uResp.status).json({ ok: uResp.ok, page_id: pageId, detail: uJson });
  } catch (err) {
    return res.status(500).json({ ok: false, error: 'SERVER_ERROR', detail: String(err) });
  }
});

// ------------------------- Assistant (OpenAI) -------------------------
// We expose BOTH routes so the old frontend and your dev tests work.
// - /assistant/ask           (public by default; set ASSIST_PUBLIC=false to require admin)
// - /dev/assistant/ask       (always requires admin)

async function handleAssistant(req, res) {
  try {
    const { message } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ ok: false, error: 'message is required' });
    }

    const apiKey = (process.env.OPENAI_API_KEY || '').trim();
    if (!apiKey) return res.status(500).json({ ok: false, error: 'missing_OPENAI_API_KEY' });

    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type' : 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are a helpful assistant for Metamorphosis.' },
          { role: 'user', content: String(message) },
        ],
      }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({ ok: false, error: 'openai_error', detail: data });
    }

    const reply = data?.choices?.[0]?.message?.content ?? '';
    return res.json({ ok: true, reply, raw: data });
  } catch (err) {
    console.error('assistant error:', err);
    return res.status(500).json({ ok: false, error: 'assistant_failed' });
  }
}

// Public assistant (unless ASSIST_PUBLIC=false)
app.post('/assistant/ask', (req, res, next) => {
  if (!ASSIST_PUBLIC) return requireAdminBearer(req, res, () => handleAssistant(req, res));
  return handleAssistant(req, res, next);
});

// Dev assistant (always admin-protected)
app.post('/dev/assistant/ask', requireAdminBearer, handleAssistant);

// ------------------------- Utilities -------------------------
app.post('/dev/make-token', (_req, res) => {
  const token = 'dev_' + crypto.randomBytes(16).toString('hex');
  res.json({ ok: true, token });
});

// 404
app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found', path: req.path }));

// ------------------------- Start -------------------------
app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
  if (!notionEnabled) {
    console.log('[warn] Notion Samples disabled – set NOTION_TOKEN_SAMPLES and NOTION_SAMPLES_DB_ID');
  }
});
