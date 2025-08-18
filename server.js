// server.js — Responses API using your Assistant (asst_…) + UI styled like index.html
import express from "express";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

// ---------- UI (mirrors your index.html look) ----------
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Metamorphosis Assistant</title>
<style>
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body { margin:0; font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; background:#0b0b0c; color:#e9e9ea }
  header { padding:14px 18px; border-bottom:1px solid #24242a; background:#121217 }
  main { max-width:960px; margin:22px auto; padding:0 16px }
  .panel { border:1px solid #252a33; border-radius:12px; background:#0f1117; padding:14px; min-height:220px }
  .messages { display:flex; flex-direction:column; gap:10px }
  .bubble { padding:10px 12px; border-radius:12px; max-width:86%; word-wrap:break-word; white-space:pre-wrap }
  .bubble.user { align-self:flex-end; background:#22577a; color:#e9f1f6 }
  .bubble.assistant { align-self:flex-start; background:#1f2937; color:#f1f5f9 }
  .bubble.system { align-self:center; background:#101316; color:#9aa1a8; border:1px dashed #2a313c }
  form { margin-top:14px; display:flex; gap:10px }
  input { flex:1; padding:12px 14px; border-radius:10px; border:1px solid #2e2e36; background:#0d0d12; color:#e9e9ea }
  button { padding:12px 16px; border-radius:10px; border:1px solid #3940ff33; background:#1f37ff; color:#fff; cursor:pointer }
  button:disabled { opacity:.6; cursor:not-allowed }
  .err { color:#ff8a8a }
</style>
</head>
<body>
<header><strong>Metamorphosis Assistant</strong></header>
<main>
  <div class="panel">
    <div id="msgs" class="messages">
      <div class="bubble system">Assistant ready. Ask me anything.</div>
    </div>
  </div>

  <form id="f">
    <input id="q" placeholder="Type your question…" autocomplete="off"/>
    <button id="send">Ask</button>
  </form>
</main>

<script>
  const msgs = document.getElementById('msgs');
  const form = document.getElementById('f');
  const input = document.getElementById('q');
  const btn = document.getElementById('send');

  function addBubble(role, text) {
    const div = document.createElement('div');
    div.className = 'bubble ' + role;
    div.textContent = text;
    msgs.appendChild(div);
    msgs.parentElement.scrollTop = msgs.parentElement.scrollHeight;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = input.value.trim();
    if (!message) return;

    addBubble('user', message);
    input.value = '';
    btn.disabled = true;

    try {
      const r = await fetch('/assistant/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message })
      });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || 'Request failed');
      addBubble('assistant', j.answer || '(no answer)');
    } catch (err) {
      addBubble('assistant', err.message);
    } finally {
      btn.disabled = false;
    }
  });
</script>
</body>
</html>`;

// ---------- Health ----------
const health = {
  ok: true,
  env: {
    assistant: process.env.ASST_DEFAULT || null,
    vector_store: process.env.VS_DEFAULT || null
  },
  routes: [
    "GET  /",
    "GET  /assistant",
    "POST /assistant/ask (Responses API via Assistant)",
    "GET  /health",
    "GET  /healthz"
  ]
};
app.get("/health",  (_req, res) => res.json(health));
app.get("/healthz", (_req, res) => res.json(health));

// ---------- UI routes ----------
app.get("/",          (_req, res) => res.type("html").send(page));
app.get("/assistant", (_req, res) => res.type("html").send(page));

// ---------- Assistant endpoint (Responses API; model = ASST_DEFAULT) ----------
app.post("/assistant/ask", async (req, res) => {
  try {
    const { message } = req.body ?? {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ ok:false, error:"Field 'message' is required" });
    }

    const { OPENAI_API_KEY, ASST_DEFAULT } = process.env;
    if (!OPENAI_API_KEY) return res.status(500).json({ ok:false, error:"OPENAI_API_KEY missing" });
    if (!ASST_DEFAULT)   return res.status(500).json({ ok:false, error:"ASST_DEFAULT missing (assistant id)" });

    // Use your Assistant ID so its attached vector store is used automatically.
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: ASST_DEFAULT,                         // e.g., asst_oex3IP6Y…
        input: [{ role: "user", content: message }]  // no 'tools' or 'tool_resources' needed here
      })
    });

    const data = await r.json();
    if (!r.ok) {
      const msg = (data && (data.error?.message || data.message)) || "OpenAI error";
      return res.status(r.status).json({ ok:false, error: msg });
    }

    // Responses API: prefer 'output_text'; fallback to first output item.
    const answer =
      data.output_text ??
      (Array.isArray(data.output) && data.output[0]?.content?.[0]?.text) ??
      "";

    return res.json({ ok:true, answer });
  } catch (err) {
    return res.status(500).json({ ok:false, error: err.message });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Assistant ready on http://localhost:${PORT}`));
