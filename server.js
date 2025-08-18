// server.js
import express from "express";
import fetch from "node-fetch";           // If on Node 18+ you can use global fetch and remove this
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

// ---------- Simple Assistant UI (served at "/") ----------
const assistantPage = /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Metamorphosis Assistant</title>
  <style>
    body { font: 16px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; background:#0b0b0c; color:#e9e9ea; }
    header { padding: 16px 20px; background:#131316; border-bottom:1px solid #232327; }
    main { max-width: 800px; margin: 24px auto; padding: 0 16px; }
    #log { white-space: pre-wrap; background:#111; border:1px solid #202024; border-radius:12px; padding:16px; min-height:180px; }
    form { display:flex; gap:8px; margin-top:16px; }
    input,button { font:inherit; }
    input { flex:1; padding:12px 14px; border-radius:10px; border:1px solid #303036; background:#0f0f11; color:#e9e9ea; }
    button { padding:12px 16px; border:1px solid #3a3a42; border-radius:10px; background:#1f37ff; color:#fff; cursor:pointer; }
    button:disabled { opacity:.6; cursor:not-allowed; }
    .sys { color:#8b8b94; }
    .err { color:#ff8a8a; }
  </style>
</head>
<body>
  <header><strong>Metamorphosis Assistant</strong></header>
  <main>
    <div id="log"><span class="sys">Assistant ready. Ask me anything.</span></div>
    <form id="f">
      <input id="q" placeholder="Type your question…" autocomplete="off" />
      <button id="send">Ask</button>
    </form>
  </main>
  <script>
    const log = document.getElementById('log');
    const f = document.getElementById('f');
    const q = document.getElementById('q');
    const btn = document.getElementById('send');

    function add(role, text, cls='') {
      const who = role === 'user' ? 'You' : 'Assistant';
      const line = document.createElement('div');
      if (cls) line.className = cls;
      line.textContent = who + ': ' + text;
      log.appendChild(document.createElement('br'));
      log.appendChild(line);
      log.scrollTop = log.scrollHeight;
    }

    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const message = q.value.trim();
      if (!message) return;
      add('user', message);
      q.value = '';
      btn.disabled = true;

      try {
        const r = await fetch('/assistant/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message })
        });
        const j = await r.json();
        if (!r.ok || !j.ok) throw new Error(j.error || 'Request failed');
        add('assistant', j.answer ?? '(no answer)');
      } catch (err) {
        add('assistant', err.message, 'err');
      } finally {
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;

// ---------- Routes ----------

// Health: shows what’s enabled
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    env: {
      notion_samples_db_id: process.env.NOTION_SAMPLES_DB_ID || null,
      title_prop: process.env.NOTION_TITLE_PROP || "Name",
    },
    routes: [
      "GET  /            (assistant UI)",
      "GET  /assistant   (assistant UI)",
      "POST /assistant/ask",
      "GET  /health"
    ]
  });
});

// Serve the assistant UI on "/" and "/assistant"
app.get("/", (_req, res) => res.type("html").send(assistantPage));
app.get("/assistant", (_req, res) => res.type("html").send(assistantPage));

// Assistant API: POST { message } -> answer
app.post("/assistant/ask", async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ ok: false, error: "Field 'message' is required" });
    }

    // Call OpenAI chat completions (uses your .env OPENAI_API_KEY)
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",  // or any available model
        messages: [
          { role: "system", content: "You are a helpful assistant for Metamorphosis." },
          { role: "user", content: message }
        ]
      })
    });

    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ ok: false, error: data.error?.message || "OpenAI error" });
    }

    const answer = data?.choices?.[0]?.message?.content ?? "";
    res.json({ ok: true, answer });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Assistant ready on http://localhost:${PORT}`);
});
