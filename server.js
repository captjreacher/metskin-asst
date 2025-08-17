// server.js
// ESM-friendly Express server (Node 18+). Ensure package.json has: { "type": "module" }

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';

// ---------- Config ----------
const app = express();
const PORT = process.env.PORT || 3001;

// Notion config
const NOTION_DB_ID = process.env.NOTION_SAMPLES_DB_ID || process.env.NOTION_DB_ID || '';
const NOTION_TOKEN = process.env.NOTION_TOKEN || '';
const NOTION_VERSION = '2022-06-28';
const notionEnabled = Boolean(NOTION_TOKEN && NOTION_DB_ID);

const NOTION_H = {
  'Authorization': `Bearer ${NOTION_TOKEN}`,
  'Notion-Version': NOTION_VERSION,
  'Content-Type': 'application/json'
};

// ---------- Middleware ----------
app.use(cors());
app.use(express.json());

// ---------- Helpers ----------
function requireAdminBearer(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

function nowIso() {
  return new Date().toISOString();
}

function redact(str, keep = 4) {
  if (!str) return '';
  if (str.length <= keep) return '*'.repeat(str.length);
  return `${str.slice(0, keep)}…${'*'.repeat(Math.max(0, str.length - keep - 1))}`;
}

// ---------- Notion: create log (single definition) ----------
/**
 * Creates a basic row in your Notion samples DB.
 * You can call this from other routes when you want an audit trail.
 */
async function notionCreateSampleLog({ threadId, runId, args = {}, downstream = {}, meta = {} }) {
  if (!notionEnabled) return { skipped: true, reason: 'notion disabled' };

  const properties = {
    Name: { title: [{ text: { content: `Thread ${threadId || ''}` } }] },
    Run: { rich_text: [{ text: { content: runId || '' } }] },
    Thread: threadId ? { rich_text: [{ text: { content: threadId } }] } : undefined,
    Campaign: meta?.campaign ? { rich_text: [{ text: { content: meta.campaign } }] } : undefined,
    Args: Object.keys(args).length
      ? { rich_text: [{ text: { content: JSON.stringify(args) } }] }
      : undefined,
    Downstream: Object.keys(downstream).length
      ? { rich_text: [{ text: { content: JSON.stringify(downstream) } }] }
      : undefined
  };

  // strip undefined
  Object.keys(properties).forEach(k => properties[k] === undefined && delete properties[k]);

  const resp = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: NOTION_H,
    body: JSON.stringify({
      parent: { database_id: NOTION_DB_ID },
      properties
    })
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`Notion create failed: ${resp.status} ${JSON.stringify(data)}`);
  }
  return { ok: true, page_id: data.id };
}

// Looks up a page by Sample_id (TITLE) and updates Order_status (RICH_TEXT)
async function notionUpdateBySampleId({ sample_id, order_status, sent_by }) {
  if (!notionEnabled) throw new Error('Notion not configured');

  // 1) Find page by Sample_id (title)
  const q = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
    method: 'POST',
    headers: NOTION_H,
    body: JSON.stringify({
      // Use "equals" for exact match; use "contains" if your title includes extra text.
      // filter: { property: 'Sample_id', title: { contains: sample_id } },
      filter: { property: 'Sample_id', title: { equals: sample_id } },
      page_size: 1
    })
  });
  const qj = await q.json();
  if (!q.ok) throw new Error(`Notion query failed: ${q.status} ${JSON.stringify(qj)}`);

  const page = qj.results?.[0];
  if (!page) throw new Error(`sample_id "${sample_id}" not found`);

  // 2) Update properties
  const props = {
    // Order_status is rich_text (NOT select)
    'Order_status': { rich_text: [{ text: { content: String(order_status || '') } }] },
    'Date_sent':    { date: { start: new Date().toISOString() } },
    'Sent_by':      { rich_text: [{ text: { content: String(sent_by || '') } }] }
  };

  const u = await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
    method: 'PATCH',
    headers: NOTION_H,
    body: JSON.stringify({ properties: props })
  });
  const uj = await u.json();
  if (!u.ok) throw new Error(`Notion update failed: ${u.status} ${JSON.stringify(uj)}`);

  return { ok: true, page_id: page.id };
}

// ---------- Routes ----------

// Health
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    time: nowIso(),
    env: {
      port: String(PORT),
      notion_enabled: notionEnabled,
      notion_db_id: redact(NOTION_DB_ID)
    },
    routes: [
      'GET    /health',
      'PATCH  /dev/samples/:sample_id/status'
    ]
  });
});

// Admin-protected: update sample status by sample_id
// Body: { "order_status": "sent", "sent_by": "DavidS" }
app.patch('/dev/samples/:sample_id/status', requireAdminBearer, async (req, res) => {
  try {
    const { sample_id } = req.params;
    const { order_status, sent_by } = req.body || {};

    if (!sample_id) return res.status(400).json({ ok: false, error: 'sample_id is required' });
    if (!order_status) return res.status(400).json({ ok: false, error: 'order_status is required' });

    const result = await notionUpdateBySampleId({ sample_id, order_status, sent_by });
    res.json({ ok: true, sample_id, order_status, sent_by, result });
  } catch (err) {
    console.error('[PATCH /dev/samples/:sample_id/status] error:', err);
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// (Optional) simple dev token generator to mirror your earlier testing flow.
// POST /dev/make-token  { "email":"x", "name":"y", "campaign":"z" }
app.post('/dev/make-token', (req, res) => {
  try {
    const { email = '', name = '', campaign = '' } = req.body || {};
    const token = 'dev_' + crypto.randomBytes(16).toString('hex');
    res.json({ ok: true, token, email, name, campaign });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

// Fallback 404 (keep last)
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found', path: req.path });
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`API listening on ${PORT}`);
  if (!notionEnabled) {
    console.log('[warn] Notion disabled – set NOTION_TOKEN and NOTION_DB_ID');
  }
});
