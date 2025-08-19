import test from 'node:test';
import assert from 'node:assert/strict';
import { SamplesDB } from '../lib/notionSamples.mjs';

function createMockClient() {
  let created = null;
  let updated = null;
  let queryFilter = null;
  return {
    databases: {
      async query({ filter }) {
        queryFilter = filter;
        if (filter.rich_text && filter.rich_text.equals === 'existing-hash') {
          return { results: [{ id: 'page1' }] };
        }
        return { results: [] };
      }
    },
    pages: {
      async create({ properties }) {
        created = properties;
        return { id: 'new-page' };
      },
      async update({ page_id, properties }) {
        updated = { page_id, properties };
        return { id: page_id };
      }
    },
    _getState() {
      return { created, updated, queryFilter };
    }
  };
}

test('creates new page when hash not found', async () => {
  const mock = createMockClient();
  const db = new SamplesDB({ token: 'x', databaseId: 'db', client: mock });
  const sample = { requester: 'Alice', product: 'Lip Balm' };
  const id = await db.upsert(sample);
  assert.equal(id, 'new-page');
  assert.ok(mock._getState().created['Requester']);
  assert.ok(mock._getState().queryFilter.rich_text.equals);
});

test('updates page when hash exists', async () => {
  const mock = createMockClient();
  const db = new SamplesDB({ token: 'x', databaseId: 'db', client: mock });
  // Force hash to match existing-hash
  const sample = { requester: 'Bob', product: 'Lotion' };
  const hash = SamplesDB.hash(sample);
  // Monkey patch find to simulate existing
  mock.databases.query = async () => ({ results: [{ id: 'page1' }] });
  const id = await db.upsert(sample);
  assert.equal(id, 'page1');
  assert.equal(mock._getState().updated.page_id, 'page1');
  assert.ok(mock._getState().updated.properties['Content Hash']);
});
