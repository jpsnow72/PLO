// Legacy preflop paths (PLO issue #42): the first Preflop UI fetched
// GET /api/preflop/ (the index) and GET /api/preflop/set/<id> (singular).
// The API moved to /api/preflop/index and /api/preflop/sets/<id>, and
// browsers holding a cached old app shell kept hitting the old paths and
// got the catch-all 404 ("Preflop library unavailable — Not found").
// The server now routes both legacy paths into the same handlers as
// their modern counterparts; these tests prove the status and body are
// identical either way, including the unknown-id 404.
//
// Boots the real server against a scratch PREFLOP_DIR seeded with a
// one-set index. Run with the api suite: node --test api/*.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plo-preflop-legacy-'));
const preflopDir = path.join(scratch, 'preflop');
fs.mkdirSync(path.join(preflopDir, 'sets'), { recursive: true });

const setDoc = {
  id: 'test-btn-rfi',
  table_size: '6max',
  position: 'BTN',
  context: 'rfi',
  hands: {},
};
fs.writeFileSync(
  path.join(preflopDir, 'index.json'),
  JSON.stringify({
    schema_version: 1,
    rangesets: [{ id: 'test-btn-rfi', path: 'sets/test-btn-rfi.json' }],
  }),
);
fs.writeFileSync(
  path.join(preflopDir, 'sets', 'test-btn-rfi.json'),
  JSON.stringify(setDoc),
);

process.env.PREFLOP_DIR = preflopDir;
process.env.DATA_DIR = path.join(scratch, 'data');

let server;
let baseUrl = '';

before(async () => {
  ({ server } = await import('./server.mjs'));
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
});

async function get(pathname) {
  const res = await fetch(`${baseUrl}${pathname}`);
  return { status: res.status, text: await res.text() };
}

test('GET /api/preflop/ serves the same index as GET /api/preflop/index', async () => {
  const modern = await get('/api/preflop/index');
  const legacy = await get('/api/preflop/');
  assert.equal(modern.status, 200);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.text, modern.text);
  assert.equal(JSON.parse(legacy.text).rangesets[0].id, 'test-btn-rfi');
});

test('GET /api/preflop/set/:id serves the same set as GET /api/preflop/sets/:id', async () => {
  const modern = await get('/api/preflop/sets/test-btn-rfi');
  const legacy = await get('/api/preflop/set/test-btn-rfi');
  assert.equal(modern.status, 200);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.text, modern.text);
  assert.deepEqual(JSON.parse(legacy.text), setDoc);
});

test('unknown set id: legacy and modern paths return the same 404 body', async () => {
  const modern = await get('/api/preflop/sets/no-such-set');
  const legacy = await get('/api/preflop/set/no-such-set');
  assert.equal(modern.status, 404);
  assert.equal(legacy.status, 404);
  assert.equal(legacy.text, modern.text);
});
