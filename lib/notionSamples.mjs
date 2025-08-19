import crypto from 'node:crypto';
import { Client } from '@notionhq/client';

/**
 * SamplesDB handles creating or updating sample request pages in Notion.
 */
export class SamplesDB {
  /**
   * @param {Object} options
   * @param {string} options.token - Notion API token
   * @param {string} options.databaseId - Notion database ID for samples
   * @param {Client} [options.client] - optional Notion client instance for testing
   */
  constructor({ token, databaseId, client }) {
    this.notion = client || new Client({ auth: token });
    this.databaseId = databaseId;
  }

  /**
   * Compute a stable hash of the sample content for change detection.
   * @param {Object} sample
   * @returns {string}
   */
  static hash(sample) {
    const json = JSON.stringify(sample, Object.keys(sample).sort());
    return crypto.createHash('sha256').update(json).digest('hex');
  }

  /**
   * Create or update a sample request in Notion.
   * @param {Object} sample
   * @returns {Promise<string>} page ID
   */
  async upsert(sample) {
    const contentHash = SamplesDB.hash(sample);
    const existing = await this.#findByHash(contentHash);

    if (existing) {
      console.info('Updating Notion sample page', existing.id);
      await this.notion.pages.update({
        page_id: existing.id,
        properties: this.#buildProperties(sample, contentHash)
      });
      return existing.id;
    }

    console.info('Creating Notion sample page');
    const res = await this.notion.pages.create({
      parent: { database_id: this.databaseId },
      properties: this.#buildProperties(sample, contentHash)
    });
    return res.id;
  }

  async #findByHash(hash) {
    try {
      const res = await this.notion.databases.query({
        database_id: this.databaseId,
        filter: {
          property: 'Content Hash',
          rich_text: { equals: hash }
        }
      });
      return res.results[0];
    } catch (err) {
      console.error('Notion query failed', err);
      throw err;
    }
  }

  #buildProperties(sample, hash) {
    return {
      'Status': { select: { name: sample.status || 'intake' } },
      'Requester': { title: [{ text: { content: sample.requester || 'Unknown' } }] },
      'Product': { rich_text: [{ text: { content: sample.product || '' } }] },
      'Qty': { number: sample.qty || 1 },
      'Recipient': { rich_text: [{ text: { content: sample.recipient || '' } }] },
      'Address': { rich_text: [{ text: { content: sample.address || '' } }] },
      'Purpose': { rich_text: [{ text: { content: sample.purpose || '' } }] },
      'Deadline': sample.deadline ? { date: { start: sample.deadline } } : undefined,
      'Policy Result': { rich_text: [{ text: { content: sample.policy_result || '' } }] },
      'Approval Needed': { checkbox: !!sample.approval_needed },
      'Approver': sample.approver ? { rich_text: [{ text: { content: sample.approver } }] } : undefined,
      'Notes': sample.notes ? { rich_text: [{ text: { content: sample.notes } }] } : undefined,
      'Content Hash': { rich_text: [{ text: { content: hash } }] }
    };
  }
}

export default SamplesDB;
