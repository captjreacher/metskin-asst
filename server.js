// server.js  (Node 18+, ESM)
import "dotenv/config";
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import path from "path";
import { fileURLToPath } from "url";

// --- Setup ---
const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CORS ---
/**
 * Allow your production hosts and local dev.
 * Set ALLOWED_ORIGINS in Render as a comma-separated list if needed.
 * e.g. "https://metskinbot.onrender.com,https://assist.maximisedai.com"
 */
const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // curl / same-origin
      try {
        const ok =
          origin.startsWith("http://localhost") ||
          origin.startsWith("http://127.0.0.1") ||
          ALLOWED.includes(origin) ||
          // quick helpers for common patterns:
          /\.assist\.maximisedai\.com$/i.test(new URL(origin).hostname) ||
          /\.onrender\.com$/i.test(new URL(origin).hostname);

        return cb(null, !!ok);
      } catch {
        return cb(null, false);
      }
    },
    credentials: false,
  })
);

// --- Tenants (by Host header) ---
const TENANTS = {
  "metamorphosis.assist.maximisedai.com": {
    ASSISTANT_ID: process.env.ASST_METAMORPHOSIS || process.env.ASST_DEFAULT,
    VECTOR_STORE_ID: process.env.VS_METAMORPHOSIS || process.env.VS_DEFAULT,
  },
  "assist.maximisedai.com": {
    ASSISTANT_ID: process.env.ASST_DEFAULT,
    VECTOR_STORE_ID: process.env.VS_DEFAULT,
  },
  // onrender default
  "metskinbot.onrender.com": {
    ASSISTANT_ID: process.env.ASST_DEFAULT,
    VECTOR_STORE_ID: process.env.VS_DEFAULT,
  },
};
app.use((req, _res, next) => {
  const host = (req.headers.host || "").toLowerCase();
  req.tenant =
    TENANTS[host] || { ASSISTANT_ID: process.env.ASST_DEFAULT, VECTOR_STORE_ID: process.env.VS_DEFAULT };
  next();
});

// --- ENV / OpenAI headers ---
const {
  OPENAI_API_KEY,
  JWT_SECRET,
  APP_BASE_URL,       // optional: your OTHER backend (public URL only)
  BOT_APP_TOKEN,      // bearer for APP_BASE_URL
  MAKE_WEBHOOK_URL,   // fallback for tool call
} = process.env;

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!JWT_SECRET) throw new Error("Missing JWT_SECRET");

const OAI_HEADERS = {
  Authorization: `Bearer ${OPENAI_API_KEY}`,
  "Content-Type": "application/json",
  "OpenAI-Beta": "assistants=v2", // REQUIRED for v2
};

// --- Utility: wait/poll run & handle tool calls ---
async function waitForRun(threadId, runId) {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const r = await fetch(`https://api.openai.com/v1/threads/runs/${runId}`, {
      headers: OAI_HEADERS,
    });
    const data = await r.json();
    const status = data.status;

    if (status === "queued" || status === "in_progress") {
      await new Promise(res => setTimeout(res, 800));
      continue;
    }

    if (status === "requires_action" && data.required_action?.submit_tool_outputs) {
      for (const call of data.required_action.submit_tool_outputs.tool_calls || []) {
        const fn = call.function?.name;
        const args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        let output = { ok: false };

        try {
          if (fn === "submit_sample_request") {
            if (APP_BASE_URL && BOT_APP_TOKEN) {
              const resp = await fetch(`${APP_BASE_URL}/api/requests/samples`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${BOT_APP_TOKEN}`,
                },
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

        await fetch(`https://api.openai.com/v1/threads/runs/${runId}/submit_tool_outputs`, {
          method: "POST",
          headers: OAI_HEADERS,
          body: JSON.stringify({
            tool_outputs: [{ tool_call_id: call.id, output: JSON.stringify(output) }],
          }),
        });
      }
      await new Promise(res => setTimeout(res, 500));
      continue;
    }

    return data; // completed/failed/cancelled/expired
  }
  throw new Error("Run timeout");
}

// ---------- API ROUTES (before static/catch-all) ----------

// Health
app.get("/health", (_req, res) => res.json({ ok: true, tenant: _req.tenant }));

// Dev token generator (enable only while testing)
if ((process.env.DEV_TOKEN_ENABLED || "").toLowerCase() === "true") {
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

// Start chat: validate token, create thread, return assistant_id
app.get("/start-chat", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ ok: false, error: "Missing token" });

    const payload = jwt.verify(token, JWT_SECRET); // {email,name,campaign}

    const r = await fetch("https://api.openai.com/v1/threads", {
      method: "POST",
      headers: OAI_HEADERS,
      body: JSON.stringify({
        metadata: {
          lead_email: payload.email || "",
          lead_name: payload.name || "",
          campaign: payload.campaign || "email",
          tenant_assistant: req.tenant.ASSISTANT_ID,
        },
      }),
    });

    if (!r.ok) {
      const body = await r.text();
      return res.status(502).json({ ok: false, error: "OpenAI thread create failed", body });
    }

    const thread = await r.json();
    res.json({ ok: true, thread_id: thread.id, assistant_id: req.tenant.ASSISTANT_ID });
  } catch (e) {
    res.status(401).json({ ok: false, error: "Invalid or expired link" });
  }
});

// Send a message & run assistant
app.post("/send", async (req, res) => {
  try {
    const { thread_id, text } = req.body || {};
    if (!thread_id || !text) return res.status(400).json({ ok: false, error: "thread_id and text required" });

    // Add user message
    const mr = await fetch(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
      method: "POST",
      headers: OAI_HEADERS,
      body: JSON.stringify({ role: "user", content: text }),
    });
    if (!mr.ok) {
      const body = await mr.text();
      return res.status(502).json({ ok: false, error: "OpenAI add message failed", body });
    }

    // Create run with tenant assistant
    const run = await fetch("https://api.openai.com/v1/threads/runs", {
      method: "POST",
      headers: OAI_HEADERS,
      body: JSON.stringify({ assistant_id: req.tenant.ASSISTANT_ID, thread_id }),
    }).then(r => r.json());

    await waitForRun(thread_id, run.id);

    // Get latest assistant message
    const msgs = await fetch(
      `https://api.openai.com/v1/threads/${thread_id}/messages?limit=10`,
      { headers: OAI_HEADERS }
    ).then(r => r.json());

    const lastAssistant = (msgs.data || []).find(m => m.role === "assistant");
    const raw = lastAssistant?.content?.[0]?.text?.value ?? "";
    let data;
    try { data = raw ? JSON.parse(raw) : { message: "" }; }
    catch { data = { raw }; }

    res.json({ ok: true, data });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});
// log so we can see it in Render logs
const devEnabled = (process.env.DEV_TOKEN_ENABLED || "").toLowerCase() === "true";
console.log(`[BOOT] DEV_TOKEN_ENABLED=${devEnabled}`);

if (devEnabled) {
  console.log("[BOOT] Mounting /dev/make-token");
  app.post("/dev/make-token", (req, res) => {
    try {
      const { email = "", name = "Guest", campaign = "dev" } = req.body || {};
      const token = jwt.sign({ email, name, campaign }, process.env.JWT_SECRET, { expiresIn: "7d" });
      res.json({ ok: true, token });
    } catch (e) {
      res.status(500).json({ ok: false, error: "Token generation failed" });
    }
  });
}
// ---------- STATIC + CATCH-ALL (after API routes) ----------
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (_req, res) =>
  res.status(200).send('Server running. Open <a href="/index.html">/index.html</a> with ?token=...')
);
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- LISTEN ----------
const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () => console.log(`Listening on :${PORT}`));


