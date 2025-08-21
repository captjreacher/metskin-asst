// test-notion.mjs
import 'dotenv/config';

const TOKEN = process.env.NOTION_TOKEN;
const DB_ID = process.env.NOTION_DB_ID;
const NOTION = "https://api.notion.com/v1";
const H = {
  "Authorization": `Bearer ${TOKEN}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json"
};

function die(msg, extra) {
  console.error("❌", msg, extra || "");
  process.exit(1);
}

async function req(path, init={}) {
  const r = await fetch(NOTION + path, { ...init, headers: { ...H, ...(init.headers||{}) }});
  const t = await r.text();
  let j; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
  if (!r.ok) die(`${init.method||"GET"} ${path} failed: ${r.status}`, j);
  return j;
}

(async () => {
  if (!TOKEN) die("Set NOTION_TOKEN env var");
  if (!DB_ID) die("Set NOTION_DB_ID env var");

  // 1) Who am I?
  const me = await req("/users/me");
  console.log("✅ Token OK for:", me?.name || me?.bot?.owner?.workspace_name || "unknown");

  // 2) Create a page in the test DB
  const title = `Metamorphosis test - ${new Date().toISOString()}`;
  const create = await req("/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: DB_ID },
      properties: {
        Name: { title: [{ type: "text", text: { content: title } }] }
      }
    })
  });
  const pageId = create.id;
  console.log("✅ Page created:", pageId);

  // 3) Append a paragraph block
  await req(`/blocks/${pageId}/children`, {
    method: "PATCH",
    body: JSON.stringify({
      children: [{
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: "Hello from the Metamorphosis Assistant test 🎉" } }] }
      }]
    })
  });
  console.log("✅ Paragraph appended");

  // 4) Read back the children
  const kids = await req(`/blocks/${pageId}/children?page_size=10`);
  const txt = kids?.results?.find(b => b.type === "paragraph")?.paragraph?.rich_text?.[0]?.plain_text || "";
  if (txt.includes("Hello from the Metamorphosis Assistant test")) {
    console.log("✅ Readback matches. Integration looks GOOD.");
  } else {
    die("Readback did not match expected content", kids);
  }

  // 5) Optional cleanup (archive the page)
  if (process.env.NOTION_ARCHIVE === "true") {
    await req(`/pages/${pageId}`, { method: "PATCH", body: JSON.stringify({ archived: true }) });
    console.log("🧹 Page archived");
  }
})().catch(e => die("Unhandled error", e));
