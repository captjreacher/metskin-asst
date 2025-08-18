// server.js  — Responses API + file_search using your Assistant ID (asst_...)
// Node 18+ (Render uses Node 20.x)
import express from "express";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());

// ---------- Simple UI ----------
const page = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Metamorphosis Assistant</title>
<style>
:root{color-scheme:dark} body{margin:0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0b0c;color:#e9e9ea}
header{padding:14px 18px;border-bottom:1px solid #24242a;background:#121217}
main{max-width:820px;margin:22px auto;padding:0 16px}
#log{min-height:180px;background:#101014;border:1px solid #23232a;border-radius:12px;padding:14px;white-space:pre-wrap}
form{display:flex;gap:8px;margin-top:14px} input,button{font:inherit}
input{flex:1;padding:12px 14px;border-radius:10px;border:1px solid #2e2e36;background:#0d0d12;color:#e9e9ea}
button{padding:12px 16px;border-radius:10px;border:1px solid #3940ff33;background:#1f37ff;color:#fff;cursor:pointer}
button:disabled{opacity:.6;cursor:not-allowed} .err{color:#ff8a8a} .sys{color:#9aa}
</style></head><body>
<header><strong>Metamorphosis Assistant</strong></header>
<main>
<div id="log"><span class="sys">Assistant ready. Ask me anything.</span></div>
<form id="f"><input id="q" placeholder="Type your question…" autocomplete="off"/><button id="send">Ask</button></form>
</main>
<script>
const log=document.getElementById('log'), f=document.getElementById('f'), q=document.getElementById('q'), btn=document.getElementById('send');
function add(role,text,cls){const d=document.createElement('div'); if(cls) d.className=cls; d.textContent=(role==='user'?'You':'Assistant')+': '+text; log.appendChild(document.createElement('br')); log.appendChild(d); log.scrollTop=log.scrollHeight;}
f.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const message=q.value.trim(); if(!message) return;
  add('user',message); q.value=''; btn.disabled=true;
  try{
    const r=await fetch('/assistant/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message})});
    const j=await r.json(); if(!r.ok||!j.ok) throw new Error(j.error||'Request failed');
    add('assistant', j.answer ?? '(no answer)');
  }catch(err){ add('assistant', err.message, 'err'); } finally{ btn.disabled=false; }
});
</script></body></html>`;

// ---------- Health ----------
const healthEnv = {
  assistant: process.env.ASST_DEFAULT || null,
  vector_store: process.env.VS_DEFAULT || null,
};
const health = { ok: true, env: healthEnv, routes: [
  "GET  /            (UI)",
  "GET  /assistant   (UI)",
  "POST /assistant/ask (Responses API, file_search via Assistant)",
  "GET  /health", "GET  /healthz"
]};
app.get("/health",  (_req,res)=>res.json(health));
app.get("/healthz", (_req,res)=>res.json(health));

// ---------- UI ----------
app.get("/",          (_req,res)=>res.type("html").send(page));
app.get("/assistant", (_req,res)=>res.type("html").send(page));

// ---------- Assistant endpoint (Responses API) ----------
app.post("/assistant/ask", async (req, res) => {
  try {
    const { message } = req.body ?? {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ ok: false, error: "Field 'message' is required" });
    }
    const { OPENAI_API_KEY, ASST_DEFAULT } = process.env;
    if (!OPENAI_API_KEY) return res.status(500).json({ ok:false, error:"OPENAI_API_KEY missing" });
    if (!ASST_DEFAULT)   return res.status(500).json({ ok:false, error:"ASST_DEFAULT missing (assistant id with your vector store attached)" });

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        // Use your Assistant ID so its attached vector store is used.
        model: ASST_DEFAULT,                 // e.g. asst_oex3IP6Y...
        input: [{ role: "user", content: message }],
        tools: [{ type: "file_search" }],    // No tool_resources in Responses API
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      const msg = (data && (data.error?.message || data.message)) || "OpenAI error";
      return res.status(r.status).json({ ok: false, error: msg });
    }

    const answer =
      data.output_text ??
      (Array.isArray(data.output) && data.output[0]?.content?.[0]?.text) ??
      "";

    return res.json({ ok: true, answer });
  } catch (err) {
    return res.status(500).json({ ok:false, error: err.message });
  }
});

// ---------- Start ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Assistant ready on http://localhost:${PORT}`));
