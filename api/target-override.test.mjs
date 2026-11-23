// Per-entry accuracy-target override for catalog solves (2026-11-23):
// a catalog entry may carry `target_exploitability_pct`, which wins
// over the tier rule in translateCatalogEntry (balanced -> 0.3,
// precise -> 0.1). Justin's call: queued 100bb flops solve to 0.5%
// while the running batch keeps 0.3%, so the override lives in the
// catalog data, not in code.
//
// Boots the real server (QUEUE_ENABLED=1) against a scratch catalog
// built from real repo entries, with fake engines that finish
// instantly, and asserts the target recorded on each produced job:
//   (a) flop entry WITH the 0.5 override      -> job target 0.5
//   (b) flop entry without it (tier balanced) -> job target 0.3
//   (c) river entry, tier precise, no override -> job target 0.1
//   (d) entries with an invalid override (-1, "high") -> queue item
//       failed with a naming error, and NO job is created.
// Run with the api suite: node --test api/*.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plo-target-'));
const engineDir = path.join(scratch, 'engine');
const dataDir = path.join(scratch, 'data');
fs.mkdirSync(engineDir, { recursive: true });

const FAKE_ENGINE = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(
  process.argv[3],
  JSON.stringify({ iterations: 25, exploitability: { nash_distance_pct: 0.25 } }),
);
process.exit(0);
`;

for (const name of ['solve-flop', 'solve-turn', 'solve-river']) {
  const p = path.join(engineDir, name);
  fs.writeFileSync(p, FAKE_ENGINE);
  fs.chmodSync(p, 0o755);
}

// Scratch catalog: real entries, cloned, with the override field set
// or stripped explicitly so the test pins server behavior regardless
// of how the shipped catalog data evolves.
const repoCatalog = JSON.parse(
  fs.readFileSync(new URL('../data/library/spot-catalog.json', import.meta.url), 'utf8'),
);
function pickEntry(id) {
  const entry = repoCatalog.entries.find((e) => e.id === id);
  assert.ok(entry, `repo catalog must contain ${id}`);
  return JSON.parse(JSON.stringify(entry));
}

const entryA = pickEntry('6max-btn-vs-bb-as-kd-7c-flop');
entryA.target_exploitability_pct = 0.5;

const entryB = pickEntry('6max-btn-vs-bb-qs-jd-tc-flop');
delete entryB.target_exploitability_pct;
assert.equal(entryB.tier, 'balanced');

const entryC = pickEntry('6max-btn-vs-bb-as-kd-7c-3s-5s-river');
delete entryC.target_exploitability_pct;
assert.equal(entryC.tier, 'precise');

const entryBadNeg = pickEntry('6max-btn-vs-bb-qs-jd-tc-flop');
entryBadNeg.id = '6max-btn-vs-bb-qs-jd-tc-flop-badneg';
entryBadNeg.target_exploitability_pct = -1;

const entryBadStr = pickEntry('6max-btn-vs-bb-qs-jd-tc-flop');
entryBadStr.id = '6max-btn-vs-bb-qs-jd-tc-flop-badstr';
entryBadStr.target_exploitability_pct = 'high';

const catalogPath = path.join(scratch, 'catalog.json');
fs.writeFileSync(
  catalogPath,
  JSON.stringify({
    schema_version: 1,
    name: 'target-override test catalog',
    entries: [entryA, entryB, entryC, entryBadNeg, entryBadStr],
  }),
);

process.env.DATA_DIR = dataDir;
process.env.ENGINE_BIN = engineDir;
process.env.CATALOG_PATH = catalogPath;
process.env.QUEUE_ENABLED = '1';
process.env.QUEUE_SMOKE_MAX_ITERATIONS = '25';

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getQueueItems() {
  const res = await fetch(`${baseUrl}/api/queue`);
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.items;
}

/** Polls the queue until every item is done or failed; returns the items. */
async function watchQueue(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // The imported server module never starts the queueTick interval
    // (that lives in the main-entry block), so drive ticks through the
    // public API instead: a no-op set_concurrency POST triggers a tick
    // server-side, settling finished jobs and starting queued ones.
    const tick = await fetch(`${baseUrl}/api/queue/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set_concurrency', value: 1 }),
    });
    assert.equal(tick.status, 200);
    const items = await getQueueItems();
    if (
      items.length === 5 &&
      items.every((i) => i.state === 'done' || i.state === 'failed')
    ) {
      return items;
    }
    assert.ok(Date.now() < deadline, 'queue items did not settle in time');
    await sleep(250);
  }
}

async function getJob(id) {
  const res = await fetch(`${baseUrl}/api/solves/${id}`);
  assert.equal(res.status, 200);
  return res.json();
}

test('catalog target override wins over the tier rule; invalid overrides fail with no job', async () => {
  const ids = [entryA.id, entryB.id, entryC.id, entryBadNeg.id, entryBadStr.id];
  const res = await fetch(`${baseUrl}/api/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spot_ids: ids }),
  });
  assert.equal(res.status, 200);
  const posted = await res.json();
  assert.deepEqual([...posted.added].sort(), [...ids].sort());

  const items = await watchQueue();
  const byId = new Map(items.map((i) => [i.spot_id, i]));

  // (a) the 0.5 override is what the job ran to.
  const itemA = byId.get(entryA.id);
  assert.equal(itemA.state, 'done');
  assert.equal(itemA.target_exploitability_pct, 0.5);
  assert.equal((await getJob(itemA.job_id)).target_exploitability_pct, 0.5);

  // (b) no override, balanced tier: the historical 0.3.
  const itemB = byId.get(entryB.id);
  assert.equal(itemB.state, 'done');
  assert.equal(itemB.target_exploitability_pct, 0.3);
  assert.equal((await getJob(itemB.job_id)).target_exploitability_pct, 0.3);

  // (c) no override, precise tier: the historical 0.1.
  const itemC = byId.get(entryC.id);
  assert.equal(itemC.state, 'done');
  assert.equal(itemC.target_exploitability_pct, 0.1);
  assert.equal((await getJob(itemC.job_id)).target_exploitability_pct, 0.1);

  // (d) invalid overrides: the item fails, the error names the entry
  // and the field, and no job exists for either spot.
  for (const bad of [entryBadNeg, entryBadStr]) {
    const item = byId.get(bad.id);
    assert.equal(item.state, 'failed');
    assert.match(item.error, /invalid target_exploitability_pct/);
    assert.ok(item.error.includes(bad.id), 'error must name the entry');
    assert.equal(item.job_id, null);
  }
  const jobsRes = await fetch(`${baseUrl}/api/jobs`);
  assert.equal(jobsRes.status, 200);
  const { jobs } = await jobsRes.json();
  assert.equal(jobs.length, 3);
  assert.deepEqual(
    jobs.map((j) => j.spot_id).sort(),
    [entryA.id, entryB.id, entryC.id].sort(),
  );
});
