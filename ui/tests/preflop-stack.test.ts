// Focused suite for the v1.4 stack partition (PLO issue #29): the
// Preflop page's group selection, the missing-stack_bb default, the
// availability fallback, setLabel's stack tag, and the Starting Hands
// study partition. It pins the helpers in src/lib/preflop.ts and
// src/lib/preflopStudy.ts that both pages' selection code runs on.
//
// The UI package has no test runner; this suite follows the tree's
// JS test idiom (api/*.test.mjs: node:test + node:assert/strict)
// carried to the TS lib. It lives outside src/ so `npm run build`
// never type-checks it. Run route for the gate host, from ui/:
//
//   npx tsc tests/preflop-stack.test.ts tests/node-test-shims.d.ts \
//     --outDir /tmp/plo-stack-test --module commonjs --target es2020 \
//     --moduleResolution node --esModuleInterop --skipLibCheck
//   node --test /tmp/plo-stack-test/tests/preflop-stack.test.js

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_STACK_BB,
  isPreflopIndex,
  resolveStack,
  selectGroupSets,
  setLabel,
  stackOf,
  stacksIn,
  type PreflopIndex,
  type PreflopSetIndexEntry,
} from '../src/lib/preflop';
import { studySetOptions } from '../src/lib/preflopStudy';

// Fixture entries shaped like the real index. The deep200 entries are
// listed BEFORE their v1.2 counterparts on purpose: that is the
// worst-case order for first-match selection — without the stack
// partition, the deep set is the one a slot would resolve to.
function entry(partial: Partial<PreflopSetIndexEntry> & { id: string }): PreflopSetIndexEntry {
  return {
    path: `sets/${partial.id}.json`,
    table_size: '6max',
    position: 'BB',
    context: 'vs_rfi',
    stack_bb: 100,
    rake: 'no-rake',
    ...partial,
  };
}

const DEEP_BB_VS_BTN = entry({
  id: 'constructed-v1.4-6max-deep200-bb-vs-btn',
  stack_bb: 200,
});
const V12_BB_VS_BTN = entry({ id: 'constructed-v1.2-6max-norake-bb-vs-btn' });
const DEEP_UTG_RFI = entry({
  id: 'constructed-v1.4-6max-deep200-utg-rfi',
  position: 'UTG',
  context: 'rfi',
  stack_bb: 200,
});
const V12_UTG_RFI = entry({
  id: 'constructed-v1.2-6max-norake-utg-rfi',
  position: 'UTG',
  context: 'rfi',
});
const DEEP_CONTINUATION = entry({
  id: 'constructed-v1.4-6max-deep200-btn-vs-bb-3bet',
  position: 'BTN',
  context: 'vs_three_bet',
  stack_bb: 200,
});
const V12_CONTINUATION = entry({
  id: 'constructed-v1.2-6max-norake-btn-vs-bb-3bet',
  position: 'BTN',
  context: 'vs_three_bet',
});
const RAKED_BB_VS_BTN = entry({
  id: 'constructed-v1-6max-bb-vs-btn',
  rake: 'raked',
});

// A pre-v1.2 index entry: no rake field, no stack_bb field at all.
const LEGACY_RAW = {
  id: 'constructed-v1-6max-sb-rfi',
  path: 'sets/constructed-v1-6max-sb-rfi.json',
  table_size: '6max',
  position: 'SB',
  context: 'sb_play',
};
const LEGACY = LEGACY_RAW as unknown as PreflopSetIndexEntry;

const INDEX: PreflopIndex = {
  schema_version: 1,
  rangesets: [
    DEEP_BB_VS_BTN,
    DEEP_UTG_RFI,
    DEEP_CONTINUATION,
    V12_BB_VS_BTN,
    V12_UTG_RFI,
    V12_CONTINUATION,
    RAKED_BB_VS_BTN,
    LEGACY,
  ],
};

const FIRST_IN = ['rfi', 'sb_play'] as const;

test('stack partition resolves the previously-shadowed slots, one set per stack', () => {
  const vsRfi100 = selectGroupSets(INDEX, {
    tableSize: '6max',
    rake: 'no-rake',
    stack: 100,
    contexts: ['vs_rfi'],
  });
  assert.deepEqual(
    vsRfi100.filter((e) => e.position === 'BB' && e.id.endsWith('-vs-btn')).map((e) => e.id),
    ['constructed-v1.2-6max-norake-bb-vs-btn'],
  );

  const vsRfi200 = selectGroupSets(INDEX, {
    tableSize: '6max',
    rake: 'no-rake',
    stack: 200,
    contexts: ['vs_rfi'],
  });
  assert.deepEqual(
    vsRfi200.filter((e) => e.position === 'BB' && e.id.endsWith('-vs-btn')).map((e) => e.id),
    ['constructed-v1.4-6max-deep200-bb-vs-btn'],
  );

  const firstIn100 = selectGroupSets(INDEX, {
    tableSize: '6max',
    rake: 'no-rake',
    stack: 100,
    contexts: FIRST_IN,
  });
  assert.deepEqual(firstIn100.map((e) => e.id), ['constructed-v1.2-6max-norake-utg-rfi']);
  const firstIn200 = selectGroupSets(INDEX, {
    tableSize: '6max',
    rake: 'no-rake',
    stack: 200,
    contexts: FIRST_IN,
  });
  assert.deepEqual(firstIn200.map((e) => e.id), ['constructed-v1.4-6max-deep200-utg-rfi']);

  const cont100 = selectGroupSets(INDEX, {
    tableSize: '6max',
    rake: 'no-rake',
    stack: 100,
    contexts: ['vs_three_bet'],
  });
  assert.deepEqual(cont100.map((e) => e.id), ['constructed-v1.2-6max-norake-btn-vs-bb-3bet']);
  const cont200 = selectGroupSets(INDEX, {
    tableSize: '6max',
    rake: 'no-rake',
    stack: 200,
    contexts: ['vs_three_bet'],
  });
  assert.deepEqual(cont200.map((e) => e.id), ['constructed-v1.4-6max-deep200-btn-vs-bb-3bet']);

  // The rake partition still applies inside a stack: no deep set is
  // raked, so the raked 200bb pool is empty and the raked 100bb pool
  // holds only the raked set.
  const raked200 = selectGroupSets(INDEX, {
    tableSize: '6max',
    rake: 'raked',
    stack: 200,
    contexts: ['vs_rfi'],
  });
  assert.deepEqual(raked200, []);
  const raked100 = selectGroupSets(INDEX, {
    tableSize: '6max',
    rake: 'raked',
    stack: 100,
    contexts: ['vs_rfi'],
  });
  assert.deepEqual(raked100.map((e) => e.id), ['constructed-v1-6max-bb-vs-btn']);
});

test('missing stack_bb is treated as 100bb — in stackOf, selection, and the guard', () => {
  assert.equal(stackOf({}), DEFAULT_STACK_BB);
  assert.equal(stackOf({ stack_bb: undefined }), 100);
  assert.equal(stackOf({ stack_bb: 200 }), 200);
  assert.equal(stackOf({ stack_bb: Number.NaN }), 100);

  // The legacy entry (no stack_bb field) lands in the 100bb pool of
  // its own rake variant and in no 200bb pool.
  const rakedFirstIn100 = selectGroupSets(INDEX, {
    tableSize: '6max',
    rake: 'raked',
    stack: 100,
    contexts: FIRST_IN,
  });
  assert.deepEqual(rakedFirstIn100.map((e) => e.id), ['constructed-v1-6max-sb-rfi']);
  const rakedFirstIn200 = selectGroupSets(INDEX, {
    tableSize: '6max',
    rake: 'raked',
    stack: 200,
    contexts: FIRST_IN,
  });
  assert.deepEqual(rakedFirstIn200, []);

  // The guard accepts an index whose entries lack stack_bb entirely
  // (the field stays optional — gating on it is the past-bug class),
  // and still rejects a present-but-wrong-typed stack_bb.
  assert.equal(isPreflopIndex({ schema_version: 1, rangesets: [LEGACY_RAW] }), true);
  assert.equal(isPreflopIndex(INDEX), true);
  assert.equal(
    isPreflopIndex({ schema_version: 1, rangesets: [{ ...LEGACY_RAW, stack_bb: '200' }] }),
    false,
  );
});

test('stack availability and fallback follow the existing selector rule', () => {
  const noRake = INDEX.rangesets.filter((e) => e.rake === 'no-rake');
  const raked = INDEX.rangesets.filter((e) => e.rake === 'raked');
  assert.deepEqual(stacksIn(noRake), [100, 200]);
  assert.deepEqual(stacksIn(raked), [100]);
  assert.deepEqual(stacksIn([]), []);

  // Keep the current stack when sets exist at it…
  assert.equal(resolveStack(noRake, 200), 200);
  assert.equal(resolveStack(noRake, 100), 100);
  // …otherwise fall back to an available stack instead of an empty
  // page (200bb requested where only 100bb exists, and vice versa).
  assert.equal(resolveStack(raked, 200), 100);
  assert.equal(resolveStack([DEEP_BB_VS_BTN], 100), 200);
  assert.equal(resolveStack([], 100), null);
});

test('setLabel names the stack only where it disambiguates', () => {
  assert.equal(
    setLabel({ ...DEEP_BB_VS_BTN, context_detail: 'vs BTN open' }),
    '6max · BB vs BTN open · 200bb · No-rake',
  );
  // 100bb stays unmarked: the v1.2 label is byte-identical to before.
  assert.equal(
    setLabel({ ...V12_BB_VS_BTN, context_detail: 'vs BTN open' }),
    '6max · BB vs BTN open · No-rake',
  );
  // Legacy data (no rake, no stack) keeps its historical label.
  assert.equal(setLabel(LEGACY), '6max · SB first-in (SB play)');
});

test('study options carry the stack partition (sessions never mix depths)', () => {
  const options = studySetOptions(INDEX);
  const deep = options.find((o) => o.entry.id === DEEP_BB_VS_BTN.id);
  const v12 = options.find((o) => o.entry.id === V12_BB_VS_BTN.id);
  assert.ok(deep);
  assert.ok(v12);
  assert.equal(deep?.stack, 200);
  assert.equal(v12?.stack, 100);
  assert.equal(deep?.spot, 'defense');
  assert.equal(deep?.opener, 'BTN');

  // The Starting Hands chosenOption rule (size + variant + stack +
  // spot + position + opener) resolves the BB-vs-BTN defense slot to
  // exactly one set per stack.
  const pick = (stack: number) =>
    options.find(
      (o) =>
        o.entry.table_size === '6max' &&
        o.variant === 'no-rake' &&
        o.stack === stack &&
        o.spot === 'defense' &&
        o.entry.position === 'BB' &&
        o.opener === 'BTN',
    )?.entry.id;
  assert.equal(pick(100), 'constructed-v1.2-6max-norake-bb-vs-btn');
  assert.equal(pick(200), 'constructed-v1.4-6max-deep200-bb-vs-btn');

  // Continuation sets stay out of the drill, at both stacks.
  assert.equal(
    options.some((o) => o.entry.context === 'vs_three_bet'),
    false,
  );
});
