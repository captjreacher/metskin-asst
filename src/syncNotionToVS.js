// src/syncNotionToVS.js (example)
import { markSyncOk, markSyncError, setIndexedAtOnce } from "./notionSyncProps.js";
// … import your OpenAI client (ensure it uses process.env.OPENAI_API_KEY)

export async function syncPage(page) {
  const pageId = page.id;

  try {
    // 1) Upload the file/content to your Vector Store
    // await uploadToVectorStore(page)

    // 2) Mark success in Notion
    await markSyncOk(pageId);

    // 3) Optionally set indexed_at the first time (guard this in your code)
    // await setIndexedAtOnce(pageId);
  } catch (e) {
    await markSyncError(pageId, e);
    // Re-throw or log as needed
  }
}
