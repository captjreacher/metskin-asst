// server.js  (Node 18+, ESM)
import "dotenv/config";
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

// ---------- paths ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- CORS (lock down with ALLOWED_ORIGINS in prod) ----------
const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // same-origin/curl
      try {
        const host = new URL(origin).host.toLowerCase();
        const ok =
          host.startsWith("localhost:") ||
          ALLOWED.includes(origin) ||
          host.endsWith(".onrender.com") ||
          host.endsWith(".maximisedai.com");
        cb(null, ok);
      } catch {
        cb(null, false);
      }
    },
    credentials: false,
  })
);

// ---------- Env / OpenAI headers ----------
const {
  OPENAI_API_KEY,
  JWT_SECRET,
  APP_BASE_URL,     // optional: other backend you call from a tool (public URL only)
  BOT_APP_TOKEN,    // bearer for APP_BASE_URL
  MAKE_WEBHOOK_URL, // optional fallback
} = process.env;

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!JWT_SECRET) throw new Error("Missing JWT_SECRET");

const OAI_HEADERS = {
  Authorization: `Bearer ${OPENAI_API_KEY}`,
  "Content-Type": "application/json",
  "OpenAI-Beta": "assistants=v2", // REQUIRED for v2
};

// ---------- Multi-tenant (by host header) ----------
const TENANTS = {
  "metamorphosis.assist.maximisedai.com": {
    ASSISTANT_ID: process.env.ASST_METAMORPHOSIS || process.env.ASST_DEFAULT,
    VECTOR_STORE_ID: process.env.VS_METAMORPHOSIS || process.env.VS_DEFAULT,
  },
  "metskinbot.onrender.com": {
    ASSISTANT_ID: process.env.ASST_DEFAULT,
    VECTOR_STORE_ID: process.env.VS_DEFAULT,
  },
};
function getTenant(req) {
  const host = (req.headers.host || "").toLowerCase();
  return TENANTS[host] || { ASSISTANT_ID: process.env.ASST_DEFAULT, VECTOR_STORE_ID: process.env.VS_DEFAULT };
}

// ---------- Helpers ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForRun(threadId, runId) {
  const deadline = Date.now() + 60_000; // 60s budget
  while (Date.now() < deadline) {
    const r = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, { headers: OAI_HEADERS });
    const data = await r.json();
    const status = data.status;

    if (status === "queued" || status === "in_progress") {
      await sleep(800);
      continue;
    }

    if (status === "requires_action" && data.required_action?.submit_tool_outputs) {
      // Handle tool calls
      for (const call of data.required_action.submit_tool_outputs.tool_calls || []) {
        const fn = call.function?.name;
        const args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        let output = { ok: false };

        try {
          if (fn === "submit_sample_request") {
            if (APP_BASE_URL && BOT_APP_TOKEN) {
              const resp = await fetch(`${APP_BASE_URL}/api/requests/samples`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${BOT_APP_TOKEN}` },
                body: JSON.stringify(args),
              });
              output = { ok: resp.ok, status: resp.status };
            } else if (MAKE_WEBHOOK_URL) {
              const resp = await fetch(MAKE_WEBHOOK_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(args),
              });
              output = { ok: resp.ok, status: resp.status };
            } else {
              output = { ok: false, error: "No downstream configured" };
            }
          } else {
            output = { ok: false, error: `Unknown tool: ${fn}` };
          }
        } catch (err) {
          output = { ok: false, error: String(err?.message || err) };
        }

        await fetch(
          `https://api.openai.com/v1/threads/${threadId}/runs/${runId}/submit_tool_outputs`,
          {
            method: "POST",
            headers: OAI_HEADERS,
            body: JSON.stringify({ tool_outputs: [{ tool_call_id: call.id, output: JSON.stringify(output) }] }),
          }
        );
      }
      await sleep(500);
      continue;
    }

    return data; // completed/failed/cancelled/expired
  }
  throw new Error("Run timeout");
}

// ---------- API ROUTES (place BEFORE static/catch-all) ----------

// Health (handy for Render + domain wiring)
app.get("/health", (req, res) => res.json({ ok: true, tenant: getTenant(req) }));

// Dev token route (enable only while testing)
const devEnabled = (process.env.DEV_TOKEN_ENABLED || "").toLowerCase() === "true";
console.log(`[BOOT] DEV_TOKEN_ENABLED=${devEnabled}`);
if (devEnabled) {
  console.log("[BOOT] Mounting /dev/make-token");
  app.post("/dev/make-token", (req, res) => {
    try {
      const { email = "", name = "Guest", campaign = "dev" } = req.body || {};
      const token = jwt.sign({ email, name, campaign }, JWT_SECRET, { expiresIn: "7d" });
      res.json({ ok: true, token });
    } catch {
      res.status(500).json({ ok: false, error: "Token generation failed" });
    }
  });
}

// Start: verify token → create thread → return ids
app.get("/start-chat", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ ok: false, error: "Missing token" });

    const payload = jwt.verify(token, JWT_SECRET); // {email,name,campaign}
    const tenant = getTenant(req);

    const r = await fetch("https://api.openai.com/v1/threads", {
      method: "POST",
      headers: OAI_HEADERS,
      body: JSON.stringify({
        metadata: {
          lead_email: payload.email || "",
          lead_name: payload.name || "",
          campaign: payload.campaign || "email",
          tenant_assistant: tenant.ASSISTANT_ID || "",
        },
      }),
    });

    if (!r.ok) {
      const body = await r.text();
      return res.status(502).json({ ok: false, error: "OpenAI thread create failed", body });
    }

    const thread = await r.json();
    res.json({ ok: true, thread_id: thread.id, assistant_id: tenant.ASSISTANT_ID });
  } catch (e) {
    res.status(401).json({ ok: false, error: "Invalid or expired link" });
  }
});

// Send: add message → run assistant → wait → return latest assistant content
app.post("/send", async (req, res) => {
  try {
    const { thread_id, text } = req.body || {};
    if (!thread_id || !text) return res.status(400).json({ ok: false, error: "thread_id and text required" });

    // 1) add user message
    const m = await fetch(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
      method: "POST",
      headers: OAI_HEADERS,
      body: JSON.stringify({ role: "user", content: text }),
    });
    if (!m.ok) {
      const body = await m.text();
      return res.status(502).json({ ok: false, where: "messages.create", body });
    }

    // 2) create run
    const tenant = getTenant(req);
    const runResp = await fetch(`https://api.openai.com/v1/threads/${thread_id}/runs`, {
      method: "POST",
      headers: OAI_HEADERS,
      body: JSON.stringify({ assistant_id: tenant.ASSISTANT_ID }),
    });
    if (!runResp.ok) {
      const body = await runResp.text();
      return res.status(502).json({ ok: false, where: "runs.create", body });
    }
    const run = await runResp.json();

    // 3) wait & handle tools
    await waitForRun(thread_id, run.id);

    // 4) fetch messages and return the latest assistant content
    const list = await fetch(`https://api.openai.com/v1/threads/${thread_id}/messages?limit=10`, {
      headers: OAI_HEADERS,
    }).then(r => r.json());

    const lastAssistant = (list.data || []).find(msg => msg.role === "assistant");
    const raw = lastAssistant?.content?.[0]?.text?.value ?? "";
    let data;
    try { data = raw ? JSON.parse(raw) : { message: "" }; }
    catch { data = { raw }; }

    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ---------- Static + catch-all (AFTER API routes) ----------
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) =>
  res.status(200).send('Server running. Open <a href="/index.html">/index.html</a> with ?token=...')
);
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ---------- Listen (Render needs 0.0.0.0 + provided PORT) ----------
const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on :${PORT}`));

