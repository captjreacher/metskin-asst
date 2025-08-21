import "dotenv/config";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const vectorStoreId = process.env.VS_METAMORPHOSIS || process.env.VS_DEFAULT;

if (!vectorStoreId) {
  console.error("No vector store id. Set VS_METAMORPHOSIS or VS_DEFAULT in .env");
  process.exit(1);
}

async function main() {
  let after;
  const all = [];
  do {
    const page = await client.vectorStores.files.list(vectorStoreId, {
      limit: 100,
      ...(after ? { after } : {}),
    });
    all.push(...page.data);
    after = page.has_more ? page.last_id : undefined;
  } while (after);

  for (const vsFile of all) {
    const f = await client.files.retrieve(vsFile.id);
    console.log(`${vsFile.id}\t${f.filename}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
