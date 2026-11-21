// Library list must carry each solve's stored range_expansion record
// (PLO issue #11): the UI's SAMPLED chip reads mode + coverage from the
// list payload, so listLibrary surfaces the meta sidecar's record
// verbatim — sampled, top, and absent records alike (the chip rule
// itself lives in the UI; the API's job is not to drop the data).
//
// Boots the real server against a scratch DATA_DIR seeded with three
// library entries. Run with the api suite: node --test api/*.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plo-library-sampled-'));
process.env.DATA_DIR = dataDir;

const libraryDir = path.join(dataDir, 'library');
fs.mkdirSync(libraryDir, { recursive: true });

function seedSolve(id, meta) {
  const result = {
    board: 'As Kd 7c',
    starting_pot: 100,
    effective_stack: 150,
    iterations: 1200,
    exploitability: { nash_distance_pct: 0.2 },
  };
  fs.writeFileSync(path.join(libraryDir, `${id}.json`), JSON.stringify(result));
  if (meta !== undefined) {
    fs.writeFileSync(path.join(libraryDir, `${id}.meta.json`), JSON.stringify(meta));
  }
}

const sampledExpansion = {
  oop: { set: 's1', action: 'raise', cap: 300, mode: 'sample', seed: 7, kept_combos: 300, total_combos: 1580, coverage_pct: 22.6173, base_set: null, base_action: 'raise' },
  ip: { set: 's2', action: 'raise', cap: 300, mode: 'sample', seed: 7, kept_combos: 300, total_combos: 1724, coverage_pct: 61.5, base_set: null, base_action: 'raise' },
};
const topExpansion = {
  oop: { ...sampledExpansion.oop, mode: 'top' },
  ip: { ...sampledExpansion.ip, mode: 'top' },
};

seedSolve('solve-sampled', { name: 'Sampled solve', kind: 'flop', range_expansion: sampledExpansion });
seedSolve('solve-top', { name: 'Top solve', kind: 'flop', range_expansion: topExpansion });
seedSolve('solve-plain', { name: 'Plain solve', kind: 'flop' });

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
  await new Promise((resolve) => server.close(() => resolve()));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('GET /api/library carries range_expansion from the meta sidecar', async () => {
  const res = await fetch(`${baseUrl}/api/library`);
  assert.equal(res.status, 200);
  const { library } = await res.json();
  const byId = new Map(library.map((item) => [item.id, item]));

  assert.deepEqual(byId.get('solve-sampled').range_expansion, sampledExpansion);
  // Top-mode records pass through too — badging policy is the UI's call.
  assert.deepEqual(byId.get('solve-top').range_expansion, topExpansion);
  // No expansion in meta -> explicit null, never undefined/absent.
  assert.equal(byId.get('solve-plain').range_expansion, null);
});
