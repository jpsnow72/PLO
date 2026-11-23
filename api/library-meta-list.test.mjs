// Library list must be built from the meta sidecar, never by parsing
// the solve documents (PLO issue #55): parsing multi-hundred-MB
// solve files made GET /api/library take ~77 s at the origin and 502
// through Cloudflare Pages. Entries with a readable meta list from
// the sidecar alone; entries with no usable meta keep the historical
// fallback (read + parse the document); entries with neither readable
// are skipped, as before.
//
// Boots the real server against a scratch DATA_DIR seeded with
// library entries. Run with the api suite: node --test api/*.test.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plo-library-meta-list-'));
process.env.DATA_DIR = dataDir;

const libraryDir = path.join(dataDir, 'library');
fs.mkdirSync(libraryDir, { recursive: true });

function seed(id, doc, meta) {
  const docText = typeof doc === 'string' ? doc : JSON.stringify(doc);
  fs.writeFileSync(path.join(libraryDir, `${id}.json`), docText);
  if (meta !== undefined) {
    const metaText = typeof meta === 'string' ? meta : JSON.stringify(meta, null, 2);
    fs.writeFileSync(path.join(libraryDir, `${id}.meta.json`), metaText);
  }
}

const BOGUS = '{invalid json';

// (1) Complete runJob-shaped meta, deliberately invalid solve file:
// the entry must list entirely from the sidecar.
const metaGood = {
  id: 'meta-good',
  name: 'Catalog · 6max-btn-vs-bb-as-kd-7c-flop',
  kind: 'flop',
  street: 'flop',
  board: 'As Kd 7c',
  oop_range_set: 'constructed-v1-6max-bb-vs-btn',
  ip_range_set: 'constructed-v1-6max-btn-rfi',
  spot_id: '6max-btn-vs-bb-as-kd-7c-flop',
  range_expansion: {
    oop: { mode: 'sample', coverage_pct: 22.6 },
    ip: { mode: 'sample', coverage_pct: 61.5 },
  },
  locked: true,
  starting_pot: 100,
  effective_stack: 150,
  nash_distance_pct: 0.123,
  iterations: 4321,
  finished_at: '2026-11-20T00:00:00.000Z',
};
seed('meta-good', BOGUS, metaGood);

// (2) No meta at all: the historical fallback reads the document.
seed('doc-only', {
  board: 'Qs Jd Tc',
  starting_pot: 200,
  effective_stack: 250,
  iterations: 999,
  exploitability: { nash_distance_pct: 0.456 },
  locked: true,
});

// (3) Meta unreadable (invalid JSON): same fallback as (2).
seed(
  'meta-bad-doc-good',
  {
    board: 'Ah Qd 4c',
    starting_pot: 50,
    effective_stack: 90,
    iterations: 42,
    exploitability: { nash_distance_pct: 0.1 },
    locked: false,
  },
  'nope{',
);

// (4) Neither readable: skipped, while the healthy entries still list.
seed('both-bad', '{broken', 'nope{');

// (5) Cross-path parity: for the fields both paths source from the
// document, a meta-sourced item and a doc-sourced item built from
// equivalent data must agree. The meta-only fields (oop_range_set,
// ip_range_set, spot_id, range_expansion) are the sidecar's alone —
// the document never carried them — so they are asserted separately
// below rather than folded into the twin comparison. The meta twin
// carries no name, so both paths exercise the `Solve · <board>`
// fallback.
const twinMeta = {
  kind: 'flop',
  street: 'flop',
  board: 'As Kd 7c',
  oop_range_set: 'set-a',
  ip_range_set: 'set-b',
  spot_id: 'twin-spot',
  range_expansion: {
    oop: { mode: 'sample', coverage_pct: 50 },
    ip: { mode: 'sample', coverage_pct: 75 },
  },
  locked: false,
  starting_pot: 100,
  effective_stack: 150,
  nash_distance_pct: 0.2,
  iterations: 1200,
  finished_at: null,
};
const twinDoc = {
  board: 'As Kd 7c',
  starting_pot: 100,
  effective_stack: 150,
  iterations: 1200,
  exploitability: { nash_distance_pct: 0.2 },
  locked: false,
};
seed('meta-twin', BOGUS, twinMeta);
seed('doc-twin', twinDoc);

const ITEM_KEYS = [
  'board',
  'effective_stack',
  'finished_at',
  'id',
  'ip_range_set',
  'iterations',
  'kind',
  'locked',
  'name',
  'nash_distance_pct',
  'oop_range_set',
  'range_expansion',
  'size_bytes',
  'spot_id',
  'starting_pot',
].sort();

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

test('GET /api/library lists from the meta sidecar and keeps the doc fallback', async () => {
  const res = await fetch(`${baseUrl}/api/library`);
  assert.equal(res.status, 200);
  const { library } = await res.json();
  const byId = new Map(library.map((item) => [item.id, item]));

  // (1) Invalid solve document, complete meta: lists, from the meta.
  const good = byId.get('meta-good');
  assert.deepEqual(Object.keys(good).sort(), ITEM_KEYS);
  assert.equal(good.name, metaGood.name);
  assert.equal(good.kind, 'flop');
  assert.equal(good.board, 'As Kd 7c');
  assert.equal(good.oop_range_set, 'constructed-v1-6max-bb-vs-btn');
  assert.equal(good.ip_range_set, 'constructed-v1-6max-btn-rfi');
  assert.equal(good.spot_id, '6max-btn-vs-bb-as-kd-7c-flop');
  assert.equal(good.nash_distance_pct, 0.123);
  assert.equal(good.iterations, 4321);
  assert.equal(good.finished_at, '2026-11-20T00:00:00.000Z');
  assert.equal(good.starting_pot, 100);
  assert.equal(good.effective_stack, 150);
  assert.equal(good.locked, true);
  assert.deepEqual(good.range_expansion, metaGood.range_expansion);
  // size_bytes is the on-disk file size (the bogus document), not a parse.
  assert.equal(good.size_bytes, Buffer.byteLength(BOGUS, 'utf8'));

  // (2) No meta: the document supplies everything, as before.
  const docOnly = byId.get('doc-only');
  assert.deepEqual(Object.keys(docOnly).sort(), ITEM_KEYS);
  assert.equal(docOnly.name, 'Solve · Qs Jd Tc');
  assert.equal(docOnly.kind, 'flop');
  assert.equal(docOnly.board, 'Qs Jd Tc');
  assert.equal(docOnly.oop_range_set, null);
  assert.equal(docOnly.ip_range_set, null);
  assert.equal(docOnly.spot_id, null);
  assert.equal(docOnly.nash_distance_pct, 0.456);
  assert.equal(docOnly.iterations, 999);
  assert.equal(docOnly.finished_at, null);
  assert.equal(docOnly.starting_pot, 200);
  assert.equal(docOnly.effective_stack, 250);
  assert.equal(docOnly.locked, true);
  assert.equal(docOnly.range_expansion, null);

  // (3) Unreadable meta: same fallback as (2).
  const badMeta = byId.get('meta-bad-doc-good');
  assert.equal(badMeta.name, 'Solve · Ah Qd 4c');
  assert.equal(badMeta.board, 'Ah Qd 4c');
  assert.equal(badMeta.nash_distance_pct, 0.1);
  assert.equal(badMeta.iterations, 42);
  assert.equal(badMeta.locked, false);

  // (4) Neither readable: absent, and the healthy entries still list.
  assert.equal(byId.has('both-bad'), false);
  assert.equal(library.length, 5);

  // (5) Parity on the doc-sourced fields for equivalent data. (id is
  // excluded — it is each entry's own filename — and size_bytes is
  // asserted separately below: it follows each file's own length.)
  const metaTwin = byId.get('meta-twin');
  const docTwin = byId.get('doc-twin');
  const DOC_SOURCED = [
    'board',
    'kind',
    'name',
    'nash_distance_pct',
    'iterations',
    'finished_at',
    'starting_pot',
    'effective_stack',
    'locked',
  ];
  const docSourced = (item) =>
    Object.fromEntries(DOC_SOURCED.map((key) => [key, item[key]]));
  assert.deepEqual(docSourced(metaTwin), docSourced(docTwin));
  // The name fallback fired on both paths (neither twin supplies one).
  assert.equal(metaTwin.name, 'Solve · As Kd 7c');
  assert.equal(docTwin.name, 'Solve · As Kd 7c');
  assert.equal(metaTwin.size_bytes, Buffer.byteLength(BOGUS, 'utf8'));
  assert.equal(docTwin.size_bytes, Buffer.byteLength(JSON.stringify(twinDoc), 'utf8'));
  // Meta-only fields: the meta path lists the seeded sidecar values;
  // the doc fallback lists null — the historical behaviour, since the
  // document never carried these fields (same as (2) above).
  assert.equal(metaTwin.oop_range_set, 'set-a');
  assert.equal(metaTwin.ip_range_set, 'set-b');
  assert.equal(metaTwin.spot_id, 'twin-spot');
  assert.deepEqual(metaTwin.range_expansion, twinMeta.range_expansion);
  assert.equal(docTwin.oop_range_set, null);
  assert.equal(docTwin.ip_range_set, null);
  assert.equal(docTwin.spot_id, null);
  assert.equal(docTwin.range_expansion, null);
});
