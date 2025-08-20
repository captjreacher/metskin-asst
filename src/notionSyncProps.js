// src/notionSyncProps.js
import { notion } from "./notionClient.js";

const LAST_SYNC_STATUS = "last_sync_status"; // Date
const LAST_ERROR       = "last_error";       // Rich text
const INDEXED_AT       = "indexed_at";       // (Date) if you want to set once

function nowIso() {
  return new Date().toISOString();
}

export async function markSyncOk(pageId) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      [LAST_SYNC_STATUS]: { date: { start: nowIso() } },
      [LAST_ERROR]: { rich_text: [] },
    },
  });
}

export async function markSyncError(pageId, err) {
  const msg = String(err?.message ?? err ?? "").slice(0, 1900);
  await notion.pages.update({
    page_id: pageId,
    properties: {
      [LAST_SYNC_STATUS]: { date: { start: nowIso() } },
      [LAST_ERROR]: {
        rich_text: [{ type: "text", text: { content: msg } }],
      },
    },
  });
}

export async function setIndexedAtOnce(pageId) {
  await notion.pages.update({
    page_id: pageId,
    properties: {
      [INDEXED_AT]: { date: { start: nowIso() } },
    },
  });
}
