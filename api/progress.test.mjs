// Solver progress reporting (PLO issue #48): the engine emits
// "PROGRESS iter=<n> expl_pct=<x.xxxx> elapsed_s=<s>" lines on stderr
// while it solves. runJob captures the stream to a per-job engine.log,
// keeps the latest reading on the job record as `progress`, and the
// record is exposed by GET /api/solves/:id. A job whose engine emits
// nothing must carry progress: null — values are never fabricated.
//
// Boots the real server against a scratch DATA_DIR + ENGINE_BIN holding
// two fake engines (node scripts): solve-river reports progress twice
// before writing its result; solve-turn stays silent. Run with the api
// suite: node --test api/*.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plo-progress-'));
const engineDir = path.join(scratch, 'engine');
const dataDir = path.join(scratch, 'data');
fs.mkdirSync(engineDir, { recursive: true });

const FAKE_RIVER = `#!/usr/bin/env node
const fs = require('node:fs');
const resultPath = process.argv[3];
process.stderr.write('PROGRESS iter=1000 expl_pct=1.5000 elapsed_s=0\\n');
setTimeout(() => {
  process.stderr.write('PROGRESS iter=2000 expl_pct=0.2500 elapsed_s=1\\n');
  setTimeout(() => {
    fs.writeFileSync(
      resultPath,
      JSON.stringify({ iterations: 2000, exploitability: { nash_distance_pct: 0.25 } }),
    );
    process.exit(0);
  }, 1200);
}, 1200);
`;

const FAKE_TURN = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(
  process.argv[3],
  JSON.stringify({ iterations: 500, exploitability: { nash_distance_pct: 0.4 } }),
);
process.exit(0);
`;

for (const [name, body] of [
  ['solve-river', FAKE_RIVER],
  ['solve-turn', FAKE_TURN],
]) {
  const p = path.join(engineDir, name);
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
}

process.env.DATA_DIR = dataDir;
process.env.ENGINE_BIN = engineDir;

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

async function postSolve(spot) {
  const res = await fetch(`${baseUrl}/api/solves`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(spot),
  });
  assert.equal(res.status, 202);
  return res.json();
}

async function getJob(id) {
  const res = await fetch(`${baseUrl}/api/solves/${id}`);
  assert.equal(res.status, 200);
  return res.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls the job until it leaves queued/running; returns every snapshot seen. */
async function watchJob(id, timeoutMs = 15000) {
  const snapshots = [];
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await getJob(id);
    snapshots.push(job);
    if (job.status === 'done' || job.status === 'error') return snapshots;
    assert.ok(Date.now() < deadline, `job ${id} did not settle in time`);
    await sleep(100);
  }
}

test('a reporting engine: job exposes the latest PROGRESS reading, live and at settle', async () => {
  const created = await postSolve({
    board: 'As Ad Ac 3s 2s',
    target_exploitability_pct: 0.3,
  });
  assert.equal(created.progress, null);
  assert.equal(created.target_exploitability_pct, 0.3);

  const snapshots = await watchJob(created.id);
  const final = snapshots[snapshots.length - 1];
  assert.equal(final.status, 'done');
  assert.equal(final.nash_distance_pct, 0.25);

  // A mid-run snapshot carried a real progress reading while running.
  const live = snapshots.find((s) => s.status === 'running' && s.progress !== null);
  assert.ok(live, 'expected a running snapshot with progress');
  assert.ok(live.progress.iter === 1000 || live.progress.iter === 2000);
  assert.equal(typeof live.progress.received_at, 'string');

  // At settle the record holds the LAST reading, not the first.
  assert.equal(final.progress.iter, 2000);
  assert.equal(final.progress.expl_pct, 0.25);
  assert.equal(final.progress.elapsed_s, 1);
  assert.equal(typeof final.progress.received_at, 'string');

  // The full stderr stream is captured per job.
  const log = fs.readFileSync(path.join(dataDir, 'jobs', created.id, 'engine.log'), 'utf8');
  assert.match(log, /PROGRESS iter=1000 expl_pct=1\.5000 elapsed_s=0/);
  assert.match(log, /PROGRESS iter=2000 expl_pct=0\.2500 elapsed_s=1/);
});

test('a silent engine: job finishes with progress null, never fabricated', async () => {
  const created = await postSolve({ board: 'As Ad Ac 3s' });
  const snapshots = await watchJob(created.id);
  const final = snapshots[snapshots.length - 1];
  assert.equal(final.status, 'done');
  assert.equal(final.progress, null);
  for (const s of snapshots) {
    assert.equal(s.progress, null);
  }
});
