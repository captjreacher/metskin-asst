import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Papa from "papaparse";

const csvPath = path.resolve("knowledge", "products.csv");
const outPath = path.resolve("knowledge", "products.md");

const csv = fs.readFileSync(csvPath, "utf8");
const { data, errors } = Papa.parse(csv, { header: true, skipEmptyLines: true });
if (errors.length) {
  console.error("CSV parse errors:", errors.slice(0,3));
  process.exit(1);
}

let md = "# Product Catalogue\n\n";
for (const r of data) {
  if (!r.sku && !r.name) continue;
  md += `## ${r.name || "(Unnamed)"} — ${r.sku || ""}\n`;
  for (const [k,v] of Object.entries(r)) {
    if (!v || ["name","sku"].includes(k)) continue;
    md += `- **${k.replaceAll("_"," ")}:** ${String(v).trim()}\n`;
  }
  md += "\n";
}
fs.writeFileSync(outPath, md);
console.log("Wrote", outPath);
