// server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import path from "path";
import { fileURLToPath } from "url";

// Node 18+ has global fetch

const app = express();
app.use(express.json());

// --- CORS (allow your hosted domains; permissive in dev) ---
const allowHost = /\.assist\.maximisedai\.com$/i;
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      try {
        const ok =
          allowHost.test(new URL(origin).hostname) ||
          origin.startsWith("http://localhost") ||
          origin.startsWith("http://127.0.0.1");
        cb(null, ok);
      } catch {
        cb(null, false);
      }
    },
  })
);

// --- Static /public ---
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "public")));

// --- Multi-tenant map by host ---
const TENANTS = {
  "metamorphosis.assist.maximisedai.com": {
    ASSISTANT_ID: process.env.ASST_METAMORPHOSIS || process.env.ASST_DEFAULT,
    VECTOR_STORE_ID: process.env.VS_METAMORPHOSIS || process.env.VS_DEFAULT,
  },
  // default/root host
  "assist.maximisedai.com": {
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

// --- ENV & OpenAI headers ---
const {
  OPENAI_API_KEY,
  JWT_SECRET,
  APP_BASE_URL,
  BOT_APP_KEY, // bot -> app bearer
  MAKE_WEBHOOK_URL, // fallback
  PORT = 3001,
} = process.env;

if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!JWT_SECRET) throw new Error("Missing JWT_SECRET");

const OAI_HEADERS = {
  Authorization: `Bearer ${OPENAI_API_KEY}`,
  "Content-Type": "application/json",
};

// --- Root + health ---
app.get("/", (_req, res) =>
  res.status(200).send('Server running. Open <a href="/index.html">/index.html</a> with ?token=... to chat.')
);
app.get("/health", (req, res) => res.json({ ok: true, tenant: req.tenant }));

// --- Start a chat: verify JWT, create thread, return tenant assistant ---
app.get("/start-chat", async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: "Missing token" });

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
      return res.status(502).json({ error: "OpenAI thread create failed", body });
    }

    const thread = await r.json();
    res.json({ thread_id: thread.id, assistant_id: req.tenant.ASSISTANT_ID });
  } catch (e) {
    res.status(401).json({ error: "Invalid or expired link" });
  }
});

// --- Poll a run; handle tool calls (App first, Make as fallback) ---
async function waitForRun(threadId, runId) {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const rr = await fetch(`https://api.openai.com/v1/threads/runs/${runId}`, {
      headers: OAI_HEADERS,
    }).then((r) => r.json());

    const status = rr.status;

    if (status === "queued" || status === "in_progress") {
      await new Promise((r) => setTimeout(r, 800));
      continue;
    }

    if (status === "requires_action" && rr.required_action?.submit_tool_outputs) {
      for (const call of rr.required_action.submit_tool_outputs.tool_calls || []) {
        const fn = call.function?.name;
        const args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        let output = { ok: false };

        try {
          if (fn === "submit_sample_request") {
            if (APP_BASE_URL && BOT_APP_KEY) {
              const resp = await fetch(`${APP_BASE_URL}/api/requests/samples`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${BOT_APP_KEY}`,
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
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }

    return rr; // completed/failed/cancelled/expired
  }
  throw new Error("Run timeout");
}

// --- Send message + run assistant (uses tenant assistant) ---
app.post("/send", async (req, res) => {
  try {
    const { thread_id, text } = req.body || {};
    if (!thread_id || !text) return res.status(400).json({ error: "thread_id and text required" });

    // Add user message
    const mr = await fetch(`https://api.openai.com/v1/threads/${thread_id}/messages`, {
      method: "POST",
      headers: OAI_HEADERS,
      body: JSON.stringify({ role: "user", content: text }),
    });
    if (!mr.ok) {
      const body = await mr.text();
      return res.status(502).json({ error: "OpenAI add message failed", body });
    }

    // Create a run for the tenant assistant
    const run = await fetch("https://api.openai.com/v1/threads/runs", {
      method: "POST",
      headers: OAI_HEADERS,
      body: JSON.stringify({ assistant_id: req.tenant.ASSISTANT_ID, thread_id }),
    }).then((r) => r.json());

    await waitForRun(thread_id, run.id);

    // Get latest assistant message (filter role=assistant)
    const msgs = await fetch(
      `https://api.openai.com/v1/threads/${thread_id}/messages?limit=10`,
      { headers: OAI_HEADERS }
    ).then((r) => r.json());

    const lastAssistant = (msgs.data || []).find((m) => m.role === "assistant");
    const raw = lastAssistant?.content?.[0]?.text?.value ?? "{}";
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { raw };
    }
    res.json({ status: "ok", data: payload });
  } catch (err) {
    res.status(500).json({ error: "Server error", detail: String(err?.message || err) });
  }
});

// --- Dev-only token generator ---
if (String(process.env.DEV_TOKEN_ENABLED || "false").toLowerCase() === "true") {
  app.post("/dev/make-token", (req, res) => {
    try {
      const { email = "", name = "Guest", campaign = "dev" } = req.body || {};
      const token = jwt.sign({ email, name, campaign }, JWT_SECRET, { expiresIn: "1d" });
      res.json({ token });
    } catch (e) {
      res.status(500).json({ error: "Token generation failed" });
    }
  });
}

app.listen(PORT, () => console.log(`Assistant server on http://localhost:${PORT}`));
