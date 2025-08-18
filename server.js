// server.js
// Node 18+ (ESM). Ensure package.json has: { "type": "module" }

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';

// ---------- App & core config ----------
const app  = express();
const PORT = process.env.PORT || 3001;

app.enable('trust proxy');                 // required on Render
app.use(express.json());

// Canonical host redirect (optional)
const CANONICAL_HOST = (process.env.CANONICAL_HOST || '').trim(); // e.g. metamorphosis.assist.maximisedai.com
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

// CORS (tighten as you prefer)
const ALLOW_ORIGINS = new Set([
  'https://metamorphosis.assist.maximisedai.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);   // curl/Postman/server-to-server
    cb(null, ALLOW_ORIGINS.has(origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ---------- Admin token (one source only) ----------
const ADMIN = (process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '').trim();
const ADMIN_SOURCE = process.env.ADMIN_TOKEN
  ? 'ADMIN_TOKEN'
  : (process.env.ADMIN_API_TOKEN ? 'ADMIN_API_TOKEN' : 'none');

function requireAdminBearer(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok || tok !== ADMIN) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

// ---------- Notion configuration ----------
const NOTION_VERSION = '2022-06-28';

// “Default/ops” DB (if you keep it for logs etc.)
const NOTION_TOKEN_DEFAULT = (process.env.NOTION_TOKEN || '').trim();
const NOTION_DB_ID_DEFAULT = (process.env.NOTION_DB_ID || '').trim();

// **Samples DB (this is the one the PATCH route uses)**
const NOTION_TOKEN_SAMPLES = (process.env.NOTION_TOKEN_SAMPLES || NOTION_TOKEN_DEFAULT).trim();
const NOTION_SAMPLES_DB_ID = (process.env.NOTION_SAMPLES_DB_ID || '').trim();

// Title property to search by (page “Name”)
const NOTION_TITLE_PROP = (process.env.NOTION_TITLE_PROP || 'Name').trim();

const notionEnabled = Boolean(NOTION_TOKEN_SAMPLES && NOTION_SAMPLES_DB_ID);

// Generic Notion fetch (pick token per call)
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

// ---------- Routes ----------

// health
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    admin: { source: ADMIN_SOURCE, len: ADMIN.length },
    env: {
      notion_samples_db_id: NOTION_SAMPLES_DB_ID ? NOTION_SAMPLES_DB_ID.slice(0, 8) : null,
      tokens: {
        samples_len: NOTION_TOKEN_SAMPLES.length,
        default_len: NOTION_TOKEN_DEFAULT.length,
        same: NOTION_TOKEN_SAMPLES && NOTION_TOKEN_DEFAULT
              ? NOTION_TOKEN_SAMPLES === NOTION_TOKEN_DEFAULT
              : null,
      },
      title_prop: NOTION_TITLE_PROP,
    },
    routes: [
      'GET  /health',
      'GET  /dev/auth/ping',
      'GET  /dev/debug/echo-auth',
      'PATCH /dev/samples/:sample_id/status',
    ],
  });
});

// keep a single root route
app.get('/', (_req, res) => res.redirect(302, '/health'));

// debug: echo what Authorization the server received
app.get('/dev/debug/echo-auth', (req, res) => {
  res.json({ auth: req.headers.authorization || null });
});

// protected ping (auth only, no Notion)
app.get('/dev/auth/ping', requireAdminBearer, (_req, res) => {
  res.json({ ok: true, message: 'auth ok' });
});

// PATCH: update a Samples row by its title (sample_id) -> order_status/sent_by/date_sent
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

    // 1) Find the page by title equals sample_id
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

    // 2) Update the properties (rich_text + date)
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

// dev helper – mint a token
app.post('/dev/make-token', (_req, res) => {
  const token = 'dev_' + crypto.randomBytes(16).toString('hex');
  res.json({ ok: true, token });
});

// 404 fallback
app.use((req, res) => res.status(404).json({ ok: false, error: 'not_found', path: req.path }));

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
  if (!notionEnabled) {
    console.log('[warn] Notion Samples disabled – set NOTION_TOKEN_SAMPLES and NOTION_SAMPLES_DB_ID');
  }
});
