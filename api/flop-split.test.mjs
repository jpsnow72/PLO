// Split flop storage (issue #57): a flop result is one JSON document
// of 5-9+ GB at library caps; the settle path used to read it whole and
// die over 2 GiB. These tests pin the replacement contract:
//   (a) the streaming splitter's round-trip on a serializer-shaped doc
//   (b) the splitter on a ~45 MB doc (streaming path exercised)
//   (c) queue settle of a flop job into header + parts + meta
//   (d) the turn-part GET route (and its 404s)
//   (e) split upload with resume (only missing parts are re-sent)
//   (f) an older central without the parts route: parts stay local
// Boots the real server (QUEUE_ENABLED=1) against a scratch catalog and
// fake engines, like target-override.test.mjs. Run with the api suite:
// node --test api/*.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, before, test } from 'node:test';
import { splitFlopResult } from './flop-split.mjs';
import { attemptSplitUpload } from './uploader.mjs';

// --- synthetic serializer-shaped documents ----------------------------------
// Mirrors engine/crates/plo-solve/src/json.rs
// (format_flop_solve_result_json): two-space indent, header scalars in
// serializer order, nodes as indented objects in one flat array.

function nodeText({
  decision_id,
  node_id,
  player = 'OOP',
  street,
  turn_card = null,
  river_card = null,
  history,
  payload = '',
  turnCardLate = false,
}) {
  const turnLine = `      "turn_card": ${turn_card === null ? 'null' : `"${turn_card}"`},\n`;
  const lines = [
    '    {',
    `      "decision_id": ${decision_id},`,
    `      "node_id": ${node_id},`,
    `      "player": "${player}",`,
    `      "street": "${street}",`,
  ];
  if (!turnCardLate) lines.push(turnLine.trimEnd());
  lines.push(
    `      "river_card": ${river_card === null ? 'null' : `"${river_card}"`},`,
    `      "history": "${history}",`,
  );
  if (turnCardLate) lines.push(turnLine.trimEnd());
  lines.push(
    '      "pot": 100.000000,',
    '      "to_call": 0.000000,',
    '      "actions": ["Check", "Bet(75)"],',
    `      "strategies": [[0.500000, 0.500000]${payload ? `, "${payload}"` : ''}]`,
    '    }',
  );
  return lines.join('\n');
}

function flopDoc({ nodes, board = 'As Kd 7c', iterations = 2000, nash = 0.364127 }) {
  return (
    '{\n' +
    `  "board": "${board}",\n` +
    '  "starting_pot": 100.000000,\n' +
    '  "effective_stack": 150.000000,\n' +
    `  "iterations": ${iterations},\n` +
    '  "locked": false,\n' +
    '  "locks": [],\n' +
    '  "exploitability": {\n' +
    `    "nash_distance_pct": ${nash},\n` +
    '    "nash_distance_chips": 0.364127,\n' +
    '    "mean_exploitability_pct": 0.200000,\n' +
    '    "max_exploitability_pct": 1.000000\n' +
    '  },\n' +
    '  "oop_evs": [{"combo": "As Ah Ks Kh", "ev": 54.440000}],\n' +
    '  "ip_evs": [{"combo": "Qd Qc Jd Jc", "ev": 45.560000}],\n' +
    '  "nodes": [\n' +
    nodes.join(',\n') +
    '\n  ]\n}\n'
  );
}

// The small fixture: 3 flop-street nodes interleaved with two turn
// subtrees (9s encountered before As), one node carrying its turn_card
// out of the serializer's usual position, river nodes inside subtrees.
const FLOP_NODES = [
  nodeText({ decision_id: 0, node_id: 0, street: 'flop', history: 'root' }),
  nodeText({ decision_id: 1, node_id: 1, player: 'IP', street: 'flop', history: 'X' }),
];
const TURN_9S_NODES = [
  nodeText({ decision_id: 2, node_id: 2, street: 'turn', turn_card: '9s', history: 'X|t:9s/root' }),
  nodeText({
    decision_id: 3,
    node_id: 3,
    player: 'IP',
    street: 'river',
    turn_card: '9s',
    river_card: '2c',
    history: 'X|t:9s/X|r:2c',
    turnCardLate: true,
  }),
];
const TURN_AS_NODES = [
  nodeText({ decision_id: 4, node_id: 4, street: 'turn', turn_card: 'As', history: 'X|t:As/root' }),
];
const TRAILING_FLOP_NODE = nodeText({
  decision_id: 5,
  node_id: 5,
  street: 'flop',
  history: 'B(75)',
});
const SMALL_NODES = [
  FLOP_NODES[0],
  TURN_9S_NODES[0],
  FLOP_NODES[1],
  TURN_AS_NODES[0],
  TURN_9S_NODES[1],
  TRAILING_FLOP_NODE,
];
const SMALL_DOC = flopDoc({ nodes: SMALL_NODES });

function decompressPart(file) {
  return zlib.brotliDecompressSync(fs.readFileSync(file)).toString('utf8');
}

// --- scratch server ----------------------------------------------------------

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'plo-split-'));
const engineDir = path.join(scratch, 'engine');
const dataDir = path.join(scratch, 'data');
const fixturePath = path.join(scratch, 'fixture-flop.json');
fs.mkdirSync(engineDir, { recursive: true });
fs.writeFileSync(fixturePath, SMALL_DOC);

const FAKE_FLOP = `#!/usr/bin/env node
const fs = require('node:fs');
fs.copyFileSync(${JSON.stringify(fixturePath)}, process.argv[3]);
process.exit(0);
`;
const FAKE_OTHER = `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(
  process.argv[3],
  JSON.stringify({ iterations: 25, exploitability: { nash_distance_pct: 0.25 } }),
);
process.exit(0);
`;
for (const [name, body] of [
  ['solve-flop', FAKE_FLOP],
  ['solve-turn', FAKE_OTHER],
  ['solve-river', FAKE_OTHER],
]) {
  const p = path.join(engineDir, name);
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
}

const repoCatalog = JSON.parse(
  fs.readFileSync(new URL('../data/library/spot-catalog.json', import.meta.url), 'utf8'),
);
const flopEntry = repoCatalog.entries.find((e) => e.id === '6max-btn-vs-bb-as-kd-7c-flop');
assert.ok(flopEntry, 'repo catalog must contain the As Kd 7c flop entry');
const catalogPath = path.join(scratch, 'catalog.json');
fs.writeFileSync(
  catalogPath,
  JSON.stringify({ schema_version: 1, name: 'split test catalog', entries: [flopEntry] }),
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

// --- (a) splitter round-trip --------------------------------------------------

test('splitter: header keeps flop nodes verbatim + split marker; parts hold their cards byte-verbatim', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plo-split-a-'));
  const src = path.join(dir, 'result.json');
  fs.writeFileSync(src, SMALL_DOC);
  const lib = path.join(dir, 'library');
  const info = await splitFlopResult(src, lib, 'solvea');

  assert.equal(info.nash_distance_pct, 0.364127);
  assert.equal(info.iterations, 2000);
  assert.equal(info.board, 'As Kd 7c');
  assert.equal(info.starting_pot, 100);
  assert.equal(info.effective_stack, 150);
  assert.equal(info.locked, false);
  assert.equal(info.node_count, SMALL_NODES.length);
  assert.deepEqual(info.parts, ['9s', 'As']); // encounter order, not sorted

  const headerText = fs.readFileSync(path.join(lib, 'solvea.json'), 'utf8');
  const header = JSON.parse(headerText);
  assert.equal(header.board, 'As Kd 7c');
  assert.equal(header.starting_pot, 100);
  assert.equal(header.exploitability.nash_distance_pct, 0.364127);
  assert.deepEqual(header.split, { format: 1, turn_cards: ['9s', 'As'] });
  const expectedFlop = [FLOP_NODES[0], FLOP_NODES[1], TRAILING_FLOP_NODE].map((t) =>
    JSON.parse(t),
  );
  assert.deepEqual(header.nodes, expectedFlop);
  for (const t of [FLOP_NODES[0], FLOP_NODES[1], TRAILING_FLOP_NODE]) {
    assert.ok(headerText.includes(t), 'header must embed flop node objects byte-verbatim');
  }

  const part9 = decompressPart(path.join(lib, 'solvea.turn-9s.json.br'));
  const part9Doc = JSON.parse(part9);
  assert.equal(part9Doc.turn_card, '9s');
  assert.deepEqual(part9Doc.nodes, TURN_9S_NODES.map((t) => JSON.parse(t)));
  for (const t of TURN_9S_NODES) {
    assert.ok(part9.includes(t), 'part must embed its node objects byte-verbatim');
  }
  const partAs = JSON.parse(decompressPart(path.join(lib, 'solvea.turn-As.json.br')));
  assert.deepEqual(partAs.nodes, TURN_AS_NODES.map((t) => JSON.parse(t)));
});

test('splitter: a flop with zero subtree nodes yields parts = []', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plo-split-z-'));
  const src = path.join(dir, 'result.json');
  fs.writeFileSync(src, flopDoc({ nodes: FLOP_NODES }));
  const lib = path.join(dir, 'library');
  const info = await splitFlopResult(src, lib, 'solvez');
  assert.deepEqual(info.parts, []);
  assert.equal(info.node_count, FLOP_NODES.length);
  const header = JSON.parse(fs.readFileSync(path.join(lib, 'solvez.json'), 'utf8'));
  assert.deepEqual(header.split, { format: 1, turn_cards: [] });
  assert.equal(header.nodes.length, FLOP_NODES.length);
  assert.deepEqual(
    fs.readdirSync(lib).filter((f) => f.includes('.turn-')),
    [],
  );
});

// --- (b) splitter on a large doc ----------------------------------------------

test('splitter: a ~45 MB doc splits correctly through the streaming path', async () => {
  const payload = 'x'.repeat(19_000);
  const cards = ['Qd', '3c'];
  const nodes = [
    nodeText({ decision_id: 0, node_id: 0, street: 'flop', history: 'root' }),
  ];
  let did = 1;
  const perCard = new Map(cards.map((c) => [c, []]));
  for (const card of cards) {
    for (let i = 0; i < 1100; i += 1) {
      const t = nodeText({
        decision_id: did,
        node_id: did,
        street: 'turn',
        turn_card: card,
        history: `X|t:${card}/n${i}`,
        payload,
      });
      did += 1;
      nodes.push(t);
      perCard.get(card).push(t);
    }
  }
  const doc = flopDoc({ nodes, iterations: 4000, nash: 0.5 });
  assert.ok(doc.length > 40 * 1024 * 1024, `fixture should exceed 40 MB (got ${doc.length})`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plo-split-b-'));
  const src = path.join(dir, 'result.json');
  fs.writeFileSync(src, doc);
  const lib = path.join(dir, 'library');
  const info = await splitFlopResult(src, lib, 'solvebig');
  assert.equal(info.node_count, nodes.length);
  assert.deepEqual(info.parts, cards);
  const header = JSON.parse(fs.readFileSync(path.join(lib, 'solvebig.json'), 'utf8'));
  assert.equal(header.nodes.length, 1);
  for (const card of cards) {
    const text = decompressPart(path.join(lib, `solvebig.turn-${card}.json.br`));
    const parsed = JSON.parse(text);
    assert.equal(parsed.nodes.length, 1100);
    assert.ok(text.includes(perCard.get(card)[0]), 'first node byte-verbatim');
    assert.ok(text.includes(perCard.get(card)[1099]), 'last node byte-verbatim');
  }
});

// --- (c)+(d) queue settle + serving -------------------------------------------

async function getQueueItems() {
  const res = await fetch(`${baseUrl}/api/queue`);
  assert.equal(res.status, 200);
  return (await res.json()).items;
}

async function watchQueue(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // The imported module never starts the queueTick interval; drive
    // ticks through the public control route like the other suites.
    const tick = await fetch(`${baseUrl}/api/queue/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set_concurrency', value: 1 }),
    });
    assert.equal(tick.status, 200);
    const items = await getQueueItems();
    if (items.length === 1 && (items[0].state === 'done' || items[0].state === 'failed')) {
      return items[0];
    }
    assert.ok(Date.now() < deadline, 'queue item did not settle in time');
    await sleep(200);
  }
}

test('queue settle: a flop job lands as header + parts + split meta; the raw result is deleted; parts serve', async () => {
  const res = await fetch(`${baseUrl}/api/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spot_ids: [flopEntry.id] }),
  });
  assert.equal(res.status, 200);
  const item = await watchQueue();
  assert.equal(item.state, 'done', `expected done, got ${item.state}: ${item.error ?? ''}`);
  const jobId = item.job_id;
  assert.ok(jobId);

  const jobRes = await fetch(`${baseUrl}/api/solves/${jobId}`);
  const job = await jobRes.json();
  assert.equal(job.status, 'done');
  assert.equal(job.nash_distance_pct, 0.364127);
  assert.equal(job.iterations, 2000);

  const libDir = path.join(dataDir, 'library');
  const header = JSON.parse(fs.readFileSync(path.join(libDir, `${jobId}.json`), 'utf8'));
  assert.equal(header.board, 'As Kd 7c');
  assert.deepEqual(header.split, { format: 1, turn_cards: ['9s', 'As'] });
  assert.equal(header.nodes.length, 3);
  for (const card of ['9s', 'As']) {
    assert.ok(
      fs.existsSync(path.join(libDir, `${jobId}.turn-${card}.json.br`)),
      `part for ${card} stored`,
    );
  }
  const meta = JSON.parse(
    fs.readFileSync(path.join(libDir, `${jobId}.meta.json`), 'utf8'),
  );
  assert.equal(meta.split, true);
  assert.equal(meta.split_parts_present, 2);
  assert.equal(meta.starting_pot, 100);
  assert.equal(meta.effective_stack, 150);
  assert.equal(meta.locked, false);
  assert.equal(meta.nash_distance_pct, 0.364127);
  assert.equal(meta.iterations, 2000);

  // The transient raw result is gone after a successful split.
  assert.equal(fs.existsSync(path.join(dataDir, 'jobs', jobId, 'result.json')), false);

  // The header doc serves through the library route.
  const headerRes = await fetch(`${baseUrl}/api/library/${jobId}`);
  assert.equal(headerRes.status, 200);
  assert.deepEqual((await headerRes.json()).split, { format: 1, turn_cards: ['9s', 'As'] });

  // (d) Part serving: each card returns exactly its nodes; unknown
  // card and unknown id 404 with an error body.
  const part9 = await fetch(`${baseUrl}/api/solves/${jobId}/turn/9s`);
  assert.equal(part9.status, 200);
  const part9Doc = await part9.json();
  assert.equal(part9Doc.turn_card, '9s');
  assert.deepEqual(part9Doc.nodes, TURN_9S_NODES.map((t) => JSON.parse(t)));
  const partAs = await fetch(`${baseUrl}/api/solves/${jobId}/turn/As`);
  assert.equal(partAs.status, 200);
  assert.deepEqual((await partAs.json()).nodes, TURN_AS_NODES.map((t) => JSON.parse(t)));

  const missingCard = await fetch(`${baseUrl}/api/solves/${jobId}/turn/2c`);
  assert.equal(missingCard.status, 404);
  assert.equal(typeof (await missingCard.json()).error, 'string');
  const missingId = await fetch(`${baseUrl}/api/solves/zzzzzzzz/turn/As`);
  assert.equal(missingId.status, 404);

  // The library list carries the header entry only — never part files.
  const list = await (await fetch(`${baseUrl}/api/library`)).json();
  const ids = list.library.map((e) => e.id);
  assert.ok(ids.includes(jobId));
  assert.ok(ids.every((i) => !i.includes('.turn-')), `no part ids in list: ${ids}`);
});

// --- (e) split upload with resume ----------------------------------------------

test('split upload: header + parts upload; a second run sends only the missing part', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plo-split-e-'));
  const src = path.join(dir, 'result.json');
  fs.writeFileSync(src, SMALL_DOC);
  const runnerLib = path.join(dir, 'library');
  const localId = 'runner001';
  const info = await splitFlopResult(src, runnerLib, localId);
  assert.deepEqual(info.parts, ['9s', 'As']);
  fs.writeFileSync(
    path.join(runnerLib, `${localId}.meta.json`),
    JSON.stringify({ id: localId, split: true, split_parts_present: 2 }, null, 2),
  );

  // Hold back the As part: the first run can only send 9s.
  const asPartPath = path.join(runnerLib, `${localId}.turn-As.json.br`);
  const asPartBytes = fs.readFileSync(asPartPath);
  fs.rmSync(asPartPath);

  const config = { central_url: baseUrl, session_cookie: 'test-session' };
  const centralLib = path.join(dataDir, 'library');
  const centralMetaPath = path.join(centralLib, `${flopEntry.id}.meta.json`);

  const run1 = await attemptSplitUpload({
    config,
    spot: flopEntry,
    libraryDir: runnerLib,
    localId,
  });
  assert.equal(run1.ok, true, run1.error ?? '');
  assert.deepEqual(run1.sent_parts, ['9s']);
  assert.deepEqual(run1.acknowledged_parts, ['9s']);
  let centralMeta = JSON.parse(fs.readFileSync(centralMetaPath, 'utf8'));
  assert.equal(centralMeta.split, true);
  assert.equal(centralMeta.split_parts_present, 1);
  assert.ok(fs.existsSync(path.join(centralLib, `${flopEntry.id}.turn-9s.json.br`)));

  // Restore the held-back part; the resume sends only As.
  fs.writeFileSync(asPartPath, asPartBytes);
  const run2 = await attemptSplitUpload({
    config,
    spot: flopEntry,
    libraryDir: runnerLib,
    localId,
  });
  assert.equal(run2.ok, true, run2.error ?? '');
  assert.deepEqual(run2.sent_parts, ['As']);
  assert.deepEqual([...run2.acknowledged_parts].sort(), ['9s', 'As']);
  centralMeta = JSON.parse(fs.readFileSync(centralMetaPath, 'utf8'));
  assert.equal(centralMeta.split_parts_present, 2);
  const localMeta = JSON.parse(
    fs.readFileSync(path.join(runnerLib, `${localId}.meta.json`), 'utf8'),
  );
  assert.deepEqual([...localMeta.split_uploaded_parts].sort(), ['9s', 'As']);

  // A third run is a no-op: nothing left to send.
  const run3 = await attemptSplitUpload({
    config,
    spot: flopEntry,
    libraryDir: runnerLib,
    localId,
  });
  assert.equal(run3.ok, true, run3.error ?? '');
  assert.deepEqual(run3.sent_parts, []);

  // And central serves the uploaded part back.
  const served = await fetch(`${baseUrl}/api/solves/${flopEntry.id}/turn/As`);
  assert.equal(served.status, 200);
  assert.deepEqual((await served.json()).nodes, TURN_AS_NODES.map((t) => JSON.parse(t)));
});

// --- (f) older central without the parts route ---------------------------------

test('split upload: a central without the parts route (404) keeps parts local, no crash', async () => {
  const stub = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/library/ingest') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'created' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plo-split-f-'));
    const src = path.join(dir, 'result.json');
    fs.writeFileSync(src, SMALL_DOC);
    const runnerLib = path.join(dir, 'library');
    const localId = 'runner002';
    await splitFlopResult(src, runnerLib, localId);
    fs.writeFileSync(
      path.join(runnerLib, `${localId}.meta.json`),
      JSON.stringify({ id: localId, split: true, split_parts_present: 2 }, null, 2),
    );
    const outcome = await attemptSplitUpload({
      config: {
        central_url: `http://127.0.0.1:${stub.address().port}`,
        session_cookie: 'test-session',
      },
      spot: flopEntry,
      libraryDir: runnerLib,
      localId,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /split-parts route \(404\)/);
    // No data loss: both parts are still on local disk, unacknowledged.
    assert.ok(fs.existsSync(path.join(runnerLib, `${localId}.turn-9s.json.br`)));
    assert.ok(fs.existsSync(path.join(runnerLib, `${localId}.turn-As.json.br`)));
    const meta = JSON.parse(
      fs.readFileSync(path.join(runnerLib, `${localId}.meta.json`), 'utf8'),
    );
    assert.deepEqual(meta.split_uploaded_parts ?? [], []);
  } finally {
    await new Promise((resolve) => stub.close(() => resolve()));
  }
});
