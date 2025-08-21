import "dotenv/config";
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { globSync } from "glob";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const vectorStoreId = process.env.VS_METAMORPHOSIS || process.env.VS_DEFAULT;
if (!vectorStoreId) {
  console.error("❌ Set VS_METAMORPHOSIS or VS_DEFAULT in .env");
  process.exit(1);
}

const KB_DIR = path.resolve("knowledge");
const pattern = `${KB_DIR.replace(/\\/g, "/")}/**/*.{md,txt,pdf}`;
const local = globSync(pattern, { nodir: true }).sort();

function sha1(filePath) {
  const h = crypto.createHash("sha1");
  h.update(fs.readFileSync(filePath));
  return h.digest("hex");
}

function base(f) { return path.basename(f); }

async function listVSFilesAll() {
  const out = [];
  let after;
  do {
    const page = await client.vectorStores.files.list(vectorStoreId, {
      limit: 100,
      ...(after ? { after } : {}),
    });
    out.push(...page.data);
    after = page.has_more ? page.last_id : undefined;
  } while (after);
  return out;
}

async function main() {
  console.log(`Local pattern: ${pattern}`);
  console.log(`Local files: ${local.length}`);

  const vsFiles = await listVSFilesAll();
  console.log(`Vector store files: ${vsFiles.length}`);

  // Map VS file id -> filename via Files API
  const vsMap = new Map();
  for (const v of vsFiles) {
    const meta = await client.files.retrieve(v.id);
    vsMap.set(v.id, meta.filename);
  }

  // Build sets by filename (most intuitive check)
  const localSet = new Set(local.map(base));
  const vsSet = new Set([...vsMap.values()]);

  const missingInVS = [...localSet].filter(x => !vsSet.has(x));
  const extraInVS = [...vsSet].filter(x => !localSet.has(x));

  // Optional: hash check to detect same filename but changed content
  const localHashes = new Map(local.map(f => [base(f), sha1(f)]));

  console.log("\n=== ID → filename in VS ===");
  for (const [id, name] of vsMap.entries()) {
    console.log(`${id}\t${name}`);
  }

  console.log("\n=== Diff ===");
  if (missingInVS.length) {
    console.log("❌ Missing in VS:", missingInVS);
  } else {
    console.log("✅ No filenames missing in VS");
  }
  if (extraInVS.length) {
    console.log("⚠️ Present in VS but not locally:", extraInVS);
  } else {
    console.log("✅ No extras in VS");
  }

  // (Optional) warn if you re-uploaded same filename but content changed
  // We cannot compare hashes inside VS, but this at least flags local changes:
  console.log("\n(Info) Local file hashes:");
  for (const [name, hash] of localHashes.entries()) {
    console.log(`${name}\t${hash}`);
  }
}

main().catch(e => {
  console.error("Audit failed:", e?.message || e);
  process.exit(1);
});
