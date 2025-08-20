// src/notionClient.js (new file or wherever you init Notion)
import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../.env") }); // adjust depth to your root

import { Client } from "@notionhq/client";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) throw new Error("NOTION_TOKEN missing");

export const notion = new Client({ auth: NOTION_TOKEN });

