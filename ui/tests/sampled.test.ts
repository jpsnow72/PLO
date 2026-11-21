// Focused suite for the SAMPLED chip + coverage rule (PLO issue #11):
// sampledInfo/sampledLabel in src/lib/sampled.ts and the LibraryRow
// plumbing in src/lib/library.ts that both the Library list and the
// Explorer header render from.
//
// The rule under test (Justin's call, 2026-11-21): a chip shows when
// either side's stored range_expansion mode is 'sample', numbered by
// the LOWER of the two sides' coverage_pct; 'top' is not sampling and
// is never badged; a missing/malformed record shows nothing; a sampled
// record with no numeric coverage anywhere shows nothing (no number
// may be fabricated).
//
// Run route for the gate host, from ui/ (mirrors preflop-stack.test.ts):
//
//   npx tsc tests/sampled.test.ts tests/node-test-shims.d.ts \
//     --outDir /tmp/plo-sampled-test --module commonjs --target es2020 \
//     --moduleResolution node --esModuleInterop --skipLibCheck
//   node --test /tmp/plo-sampled-test/tests/sampled.test.js

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { libraryRow } from '../src/lib/library';
import { sampledInfo, sampledLabel, sampledTitle } from '../src/lib/sampled';
import type { LibraryItem, RangeExpansion } from '../src/lib/types';

function side(partial: Partial<NonNullable<RangeExpansion['oop']>>): NonNullable<RangeExpansion['oop']> {
  return {
    set: 'constructed-v1-6max-btn',
    action: 'raise',
    cap: 300,
    mode: 'sample',
    seed: 42,
    kept_combos: 300,
    total_combos: 1200,
    coverage_pct: 50,
    base_set: null,
    base_action: 'raise',
    ...partial,
  };
}

test('both sides sampled: chip carries the LOWER coverage', () => {
  const info = sampledInfo({
    oop: side({ coverage_pct: 22.6173 }),
    ip: side({ coverage_pct: 61.5 }),
  });
  assert.ok(info);
  assert.equal(info.coveragePct, 22.6173);
  assert.deepEqual(info.sampledSides, ['oop', 'ip']);
  assert.equal(sampledLabel(info), 'SAMPLED · 22.6%');
});

test('one side sampled, other top: chip shows, numbered by the lower of both coverages', () => {
  const info = sampledInfo({
    oop: side({ mode: 'sample', coverage_pct: 80 }),
    ip: side({ mode: 'top', coverage_pct: 35.25 }),
  });
  assert.ok(info);
  assert.equal(info.coveragePct, 35.25);
  assert.deepEqual(info.sampledSides, ['oop']);
});

test('only one side recorded and sampled: chip uses that side coverage', () => {
  const info = sampledInfo({ oop: side({ coverage_pct: 12.5 }), ip: null });
  assert.ok(info);
  assert.equal(info.coveragePct, 12.5);
  assert.equal(sampledLabel(info), 'SAMPLED · 12.5%');
});

test('top on both sides: no chip (top-slice is not sampling)', () => {
  assert.equal(
    sampledInfo({ oop: side({ mode: 'top' }), ip: side({ mode: 'top' }) }),
    null,
  );
});

test('missing expansion (custom solve / sample): no chip', () => {
  assert.equal(sampledInfo(null), null);
  assert.equal(sampledInfo(undefined), null);
  assert.equal(sampledInfo({}), null);
  assert.equal(sampledInfo({ oop: null, ip: null }), null);
});

test('sampled but no numeric coverage anywhere: no chip, never a fabricated number', () => {
  assert.equal(
    sampledInfo({
      oop: side({ mode: 'sample', coverage_pct: null }),
      ip: side({ mode: 'sample', coverage_pct: undefined }),
    }),
    null,
  );
});

test('sampled side without coverage falls back to the other side number', () => {
  const info = sampledInfo({
    oop: side({ mode: 'sample', coverage_pct: null }),
    ip: side({ mode: 'top', coverage_pct: 44 }),
  });
  assert.ok(info);
  assert.equal(info.coveragePct, 44);
});

test('malformed modes are not sampling', () => {
  assert.equal(
    sampledInfo({ oop: side({ mode: 'Sample' }), ip: side({ mode: '' }) }),
    null,
  );
  assert.equal(sampledInfo({ oop: side({ mode: null }), ip: null }), null);
});

test('tooltip carries the per-side record', () => {
  const info = sampledInfo({
    oop: side({ coverage_pct: 22.6173, kept_combos: 300, total_combos: 1580, seed: 7 }),
    ip: side({ mode: 'top', coverage_pct: 61.5, kept_combos: 300, total_combos: 900, seed: null }),
  });
  assert.ok(info);
  const title = sampledTitle(info);
  assert.match(title, /OOP: sample mode, coverage 22\.6%, 300 of 1580 combos kept, seed 7/);
  assert.match(title, /IP: top mode, coverage 61\.5%, 300 of 900 combos kept/);
});

// ---------- LibraryRow plumbing ----------

function item(partial: Partial<LibraryItem> & { id: string }): LibraryItem {
  return {
    name: `Solve · ${partial.id}`,
    kind: 'flop',
    board: 'As Kd 7c',
    oop_range_set: null,
    ip_range_set: null,
    spot_id: null,
    nash_distance_pct: 0.2,
    iterations: 1000,
    finished_at: '2026-11-21T00:00:00.000Z',
    size_bytes: 12345,
    starting_pot: 100,
    effective_stack: 100,
    locked: false,
    range_expansion: null,
    ...partial,
  };
}

const noCatalog = new Map();

test('libraryRow: sampled solve rows carry the chip data + the raw record', () => {
  const expansion: RangeExpansion = {
    oop: side({ coverage_pct: 30 }),
    ip: side({ coverage_pct: 55 }),
  };
  const row = libraryRow(item({ id: 'a', range_expansion: expansion }), noCatalog);
  assert.ok(row.sampled);
  assert.equal(row.sampled.coveragePct, 30);
  assert.equal(row.rangeExpansion, expansion);
});

test('libraryRow: top-mode and expansion-less rows carry no chip', () => {
  const topRow = libraryRow(
    item({
      id: 'b',
      range_expansion: { oop: side({ mode: 'top' }), ip: side({ mode: 'top' }) },
    }),
    noCatalog,
  );
  assert.equal(topRow.sampled, null);
  const plainRow = libraryRow(item({ id: 'c' }), noCatalog);
  assert.equal(plainRow.sampled, null);
  assert.equal(plainRow.rangeExpansion, null);
});
