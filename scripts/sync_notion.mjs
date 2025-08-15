// scripts/sync_notion.mjs
import 'dotenv/config';
import fs from 'node:fs/promises';
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import { Client as Notion } from '@notionhq/client';
import { NotionToMarkdown } from 'notion-to-md';

// ===== env =====
const {
  NOTION_TOKEN,
  NOTION_DB_ID,
  OPENAI_API_KEY,
  VECTOR_STORE_ID, // required: target vector store
} = process.env;

function requireEnv(name, val) {
  if (!val) throw new Error(`Missing required env: ${name}`);
}
requireEnv('NOTION_TOKEN', NOTION_TOKEN);
requireEnv('NOTION_DB_ID', NOTION_DB_ID);
requireEnv('OPENAI_API_KEY', OPENAI_API_KEY);
requireEnv('VECTOR_STORE_ID', VECTOR_STORE_ID);

// ===== clients =====
const notion = new Notion({ auth: NOTION_TOKEN });
const n2m = new NotionToMarkdown({ notionClient: notion });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ===== state =====
const STATE_FILE = '.notion_sync_state.json';

async function loadState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    return { lastSyncISO: '1970-01-01T00:00:00.000Z' };
  }
}
async function saveState(s) {
  await fs.writeFile(STATE_FILE, JSON.stringify(s, null, 2));
}

// ===== helpers =====
const safeTitle = (page) =>
  page.properties?.Name?.title?.[0]?.plain_text?.trim() ||
  page.properties?.Title?.title?.[0]?.plain_text?.trim() ||
  page.id;

const sanitize = (s) => s.replace(/[^\w.-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();

async function queryChangedPages(sinceISO) {
  let cursor;
  const results = [];
  do {
    const resp = await notion.databases.query({
      database_id: NOTION_DB_ID,
      start_cursor: cursor,
      filter: {
        and: [
          // If your DB lacks "Publish" (checkbox), remove this filter
          { property: 'Publish', checkbox: { equals: true } },
          { timestamp: 'last_edited_time', last_edited_time: { after: sinceISO } },
        ],
      },
      sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
      page_size: 50,
    });
    results.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return results;
}

async function pageToMarkdownString(pageId) {
  const mdBlocks = await n2m.pageToMarkdown(pageId);
  const md = n2m.toMarkdownString(mdBlocks)?.parent ?? '';
  return md.trim();
}

async function uploadMarkdownToVectorStore(filename, markdownString) {
  if (typeof markdownString !== 'string' || markdownString.trim().length === 0) {
    console.warn(`[skip] Empty markdown for ${filename}`);
    return null;
  }

  // Use toFile in Node (avoids relying on browser File)
  const file = await openai.files.create({
    file: await toFile(Buffer.from(markdownString, 'utf8'), filename, { type: 'text/markdown' }),
    purpose: 'assistants',
  });

  await openai.beta.vectorStores.fileBatches.createAndPoll({
    vector_store_id: VECTOR_STORE_ID,
    file_ids: [file.id],
  });

  return file.id;
}

async function updateNotionFileId(pageId, fileId) {
  try {
    await notion.pages.update({
      page_id: pageId,
      properties: {
        'File ID': { rich_text: [{ type: 'text', text: { content: fileId } }] },
      },
    });
  } catch (err) {
    console.warn(`[warn] Could not write "File ID" on page ${pageId}: ${err?.message || err}`);
  }
}

// ===== main =====
(async () => {
  const state = await loadState();
  const changed = await queryChangedPages(state.lastSyncISO);

  if (changed.length === 0) {
    console.log('No changes.');
    return;
  }

  let uploaded = 0, skipped = 0, failed = 0;

  for (const page of changed) {
    const pageId = page.id;
    const title = safeTitle(page);
    const slug = page.properties?.Slug?.rich_text?.[0]?.plain_text?.trim();
    const filename = `${sanitize(slug || title || pageId.slice(0, 8))}.md`;

    try {
      const md = await pageToMarkdownString(pageId);
      const fileId = await uploadMarkdownToVectorStore(filename, md);
      if (fileId) {
        uploaded++;
        console.log(`[ok] Synced: ${title} → ${fileId}`);
        await updateNotionFileId(pageId, fileId);
      } else {
        skipped++;
      }
    } catch (e) {
      failed++;
      console.error(`[err] ${filename}: ${e?.message || e}`);
    }
  }

  await saveState({ lastSyncISO: new Date().toISOString() });
  console.log(`\nDone. Uploaded: ${uploaded}, Skipped: ${skipped}, Failed: ${failed}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
