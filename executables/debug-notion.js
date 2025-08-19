import { Client } from "@notionhq/client";

// init client
const notion = new Client({ auth: process.env.NOTION_TOKEN });

// run
const dbId = process.env.NOTION_DB_ID;  // adjust if checking SAMPLES DB
const db = await notion.databases.retrieve({ database_id: dbId });

for (const [k, v] of Object.entries(db.properties)) {
  console.log(`${k}  →  ${v.type}`);
}
