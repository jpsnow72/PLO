// Focused suite for split-solve exploration (PLO issue #57):
// lib/solveTree.ts (split marker, lookup states, graft, the
// split-runout step) + lib/splitSolve.ts (the deduping turn-card
// loader and the quiz preparation).
//
// The rules under test:
//  - A split header doc indexes only the flop street; a history
//    under an unloaded turn card reports 'unloaded-card', a loaded
//    one 'present', anything else 'absent'. Non-split docs have no
//    third state.
//  - Closing the flop street with no card loaded resolves as a
//    'split-runout' offering the header's turn cards; Fold never
//    does. After a graft, the same step resolves as a normal runout.
//  - The loader fetches a card ONCE however many triggers race,
//    grafts make its nodes navigable by history (including the river
//    chance node inside the card), a failed fetch caches nothing and
//    a retry succeeds, and malformed payloads graft nothing.
//  - Quiz preparation loads exactly one random available card, and
//    question generation then sees the flop street + that card only.
//
// Run route for the gate host, from ui/ (esbuild bundle -> CJS, the
// route the other UI suites use — solveTree.ts reads import.meta.env,
// which the define folds away):
//
//   npx esbuild tests/split-solve.test.ts --bundle --platform=node \
//     --format=cjs --define:import.meta.env.DEV=false \
//     --outfile=/tmp/plo-split-test/split-solve.test.cjs
//   node --test /tmp/plo-split-test/split-solve.test.cjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectSpotQuestions } from '../src/lib/quiz';
import {
  graftTurnNodes,
  historyTurnCard,
  nodeLookupState,
  parseSolve,
  resolveStep,
  type SolveData,
} from '../src/lib/solveTree';
import { prepareSplitForQuiz, TurnCardLoader } from '../src/lib/splitSolve';

const COMBO_OOP = 'Ac Ad Qh Qd';
const COMBO_IP = 'Kc Kh Jh Jd';

const EXPLOITABILITY = {
  nash_distance_pct: 0.364,
  nash_distance_chips: 0.36,
  mean_exploitability_pct: 0.3,
  mean_exploitability_chips: 0.3,
  oop_exploitability_chips: 0.18,
  ip_exploitability_chips: 0.18,
  oop_br_ev: 50,
  ip_br_ev: 50,
  oop_strategy_ev: 50,
  ip_strategy_ev: 50,
};

function node(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    decision_id: 0,
    node_id: 0,
    pot: 100,
    to_call: 0,
    ...partial,
  };
}

/** A split flop header: two flop nodes, turn cards As + Kd unloaded. */
function splitFixture(): SolveData {
  const raw = {
    board: 'Ts 9h 8d',
    starting_pot: 100,
    effective_stack: 150,
    iterations: 2000,
    exploitability: EXPLOITABILITY,
    oop_evs: [{ combo: COMBO_OOP, weight: 1, ev: 10 }],
    ip_evs: [{ combo: COMBO_IP, weight: 1, ev: 9 }],
    split: { format: 1, turn_cards: ['As', 'Kd'] },
    nodes: [
      node({
        player: 'OOP',
        street: 'flop',
        history: 'root',
        actions: ['Check', 'Fold'],
        strategy: { [COMBO_OOP]: [1, 0] },
      }),
      node({
        player: 'IP',
        street: 'flop',
        history: 'X',
        actions: ['Check', 'Fold'],
        strategy: { [COMBO_IP]: [1, 0] },
      }),
    ],
  };
  const data = parseSolve(raw);
  assert.ok(data);
  return data;
}

const TURN_AS = {
  turn_card: 'As',
  nodes: [
    node({
      player: 'OOP',
      street: 'turn',
      turn_card: 'As',
      history: 'X/X|t:As',
      actions: ['Check', 'Bet(75)'],
      strategy: { [COMBO_OOP]: [0.5, 0.5] },
    }),
    node({
      player: 'IP',
      street: 'turn',
      turn_card: 'As',
      history: 'X/X|t:As/X',
      actions: ['Check', 'Fold'],
      strategy: { [COMBO_IP]: [0.25, 0.75] },
    }),
    node({
      player: 'OOP',
      street: 'river',
      turn_card: 'As',
      river_card: '2c',
      history: 'X/X|t:As/X/X|r:2c',
      actions: ['Check'],
      strategy: { [COMBO_OOP]: [1] },
    }),
  ],
};

const TURN_KD = {
  turn_card: 'Kd',
  nodes: [
    node({
      player: 'OOP',
      street: 'turn',
      turn_card: 'Kd',
      history: 'X/X|t:Kd',
      actions: ['Check', 'Bet(75)'],
      strategy: { [COMBO_OOP]: [0.6, 0.4] },
    }),
  ],
};

/** Fetcher stub: serves payloads by card, optionally failing a card's first attempt. */
function stubFetcher(failFirst: string[] = []) {
  const calls: string[] = [];
  const payloads: Record<string, unknown> = { As: TURN_AS, Kd: TURN_KD };
  const failed = new Set<string>();
  const fetcher = async (_solveId: string, card: string): Promise<unknown> => {
    calls.push(card);
    if (failFirst.includes(card) && !failed.has(card)) {
      failed.add(card);
      throw new Error('network down');
    }
    const body = payloads[card];
    if (!body) throw new Error('404');
    return body;
  };
  return { fetcher, calls };
}

test('parse: split header indexes the flop street and names its cards', () => {
  const data = splitFixture();
  assert.equal(data.kind, 'flop');
  assert.ok(data.split);
  assert.deepEqual(data.split.turnCards, ['As', 'Kd']);
  assert.equal(data.split.loadedCards.size, 0);
  assert.equal(data.nodesByHistory.size, 2);
  assert.equal(nodeLookupState(data, 'root'), 'present');
  assert.equal(nodeLookupState(data, 'X'), 'present');
  assert.equal(nodeLookupState(data, 'X/X|t:As'), 'unloaded-card');
  assert.equal(nodeLookupState(data, 'X/X|t:Kd/X'), 'unloaded-card');
  assert.equal(nodeLookupState(data, 'X|t:Qh'), 'absent'); // not a card of this solve
  assert.equal(nodeLookupState(data, 'B(75)'), 'absent');
  assert.equal(historyTurnCard('X/X|t:As/X/X|r:2c'), 'As');
  assert.equal(historyTurnCard('X'), null);
});

test('non-split docs: no split state, no third lookup state, loader refuses', async () => {
  const raw = {
    board: 'As Ks Qs 7d 2c',
    starting_pot: 100,
    effective_stack: 100,
    iterations: 1000,
    exploitability: EXPLOITABILITY,
    oop_evs: [{ combo: COMBO_OOP, weight: 1, ev: 10 }],
    ip_evs: [{ combo: COMBO_IP, weight: 1, ev: 9 }],
    nodes: [
      node({
        player: 'OOP',
        history: 'root',
        actions: ['Check'],
        strategy: { [COMBO_OOP]: [1] },
      }),
    ],
  };
  const data = parseSolve(raw);
  assert.ok(data);
  assert.equal(data.split, null);
  assert.equal(nodeLookupState(data, 'X/X|t:As'), 'absent');
  const { fetcher, calls } = stubFetcher();
  const loader = new TurnCardLoader(fetcher);
  assert.equal(await loader.ensureCard(data, 'solve-1', 'As'), false);
  assert.deepEqual(calls, []); // never fetched: nothing to graft into
  assert.equal(graftTurnNodes(data, 'As', TURN_AS), false);
});

test('resolveStep: closing the flop with nothing loaded offers the split cards', () => {
  const data = splitFixture();
  const ipNode = data.nodesByHistory.get('X');
  assert.ok(ipNode);
  const step = resolveStep(data, ipNode, 'Check');
  assert.equal(step.type, 'split-runout');
  if (step.type === 'split-runout') {
    assert.equal(step.baseHistory, 'X/X');
    assert.deepEqual(step.cards, ['As', 'Kd']);
  }
  // Fold ends the hand — it never deals a card.
  const root = data.nodesByHistory.get('root');
  assert.ok(root);
  assert.equal(resolveStep(data, root, 'Fold').type, 'terminal');
});

test('loader: concurrent triggers share one fetch; the graft is navigable', async () => {
  const data = splitFixture();
  const { fetcher, calls } = stubFetcher();
  const loader = new TurnCardLoader(fetcher);
  const [a, b] = await Promise.all([
    loader.ensureCard(data, 'solve-1', 'As'),
    loader.ensureCard(data, 'solve-1', 'As'),
  ]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.deepEqual(calls, ['As']); // exactly one fetch for two triggers
  // A later trigger is a cache hit — still one fetch.
  assert.equal(await loader.ensureCard(data, 'solve-1', 'As'), true);
  assert.deepEqual(calls, ['As']);

  assert.equal(nodeLookupState(data, 'X/X|t:As'), 'present');
  assert.equal(nodeLookupState(data, 'X/X|t:Kd'), 'unloaded-card');

  // The same step that offered the cards now resolves as a runout.
  const ipNode = data.nodesByHistory.get('X');
  assert.ok(ipNode);
  const step = resolveStep(data, ipNode, 'Check');
  assert.equal(step.type, 'runout');
  if (step.type === 'runout') {
    assert.deepEqual(
      step.options.map((o) => o.card),
      ['As'],
    );
  }
  // Inside the grafted card, walking continues by history — including
  // the river chance node, which must NOT be mistaken for a split
  // turn branch even though the solve is split.
  const turnRoot = data.nodesByHistory.get('X/X|t:As');
  assert.ok(turnRoot);
  const inner = resolveStep(data, turnRoot, 'Check');
  assert.equal(inner.type, 'node');
  const ipTurn = data.nodesByHistory.get('X/X|t:As/X');
  assert.ok(ipTurn);
  const riverStep = resolveStep(data, ipTurn, 'Check');
  assert.equal(riverStep.type, 'runout');
  if (riverStep.type === 'runout') {
    assert.deepEqual(
      riverStep.options.map((o) => o.card),
      ['2c'],
    );
  }
});

test('loader: a failed fetch caches nothing and the retry succeeds', async () => {
  const data = splitFixture();
  const { fetcher, calls } = stubFetcher(['Kd']);
  const loader = new TurnCardLoader(fetcher);
  assert.equal(await loader.ensureCard(data, 'solve-1', 'Kd'), false);
  assert.equal(nodeLookupState(data, 'X/X|t:Kd'), 'unloaded-card'); // retryable state
  assert.equal(await loader.ensureCard(data, 'solve-1', 'Kd'), true);
  assert.equal(nodeLookupState(data, 'X/X|t:Kd'), 'present');
  assert.deepEqual(calls, ['Kd', 'Kd']);
});

test('graft: malformed payloads change nothing', () => {
  const data = splitFixture();
  const before = data.nodesByHistory.size;
  // Wrong card echoed back.
  assert.equal(graftTurnNodes(data, 'As', { turn_card: 'Kd', nodes: TURN_KD.nodes }), false);
  // A node naming a different card than the payload's.
  assert.equal(
    graftTurnNodes(data, 'As', { turn_card: 'As', nodes: TURN_KD.nodes }),
    false,
  );
  // No nodes at all.
  assert.equal(graftTurnNodes(data, 'As', { turn_card: 'As', nodes: [] }), false);
  // A card the solve does not have.
  assert.equal(graftTurnNodes(data, 'Qh', TURN_AS), false);
  assert.equal(data.nodesByHistory.size, before);
  assert.equal(data.split?.loadedCards.size, 0);
});

test('quiz preparation: one random card loads; questions stay inside loaded content', async () => {
  const data = splitFixture();
  const { fetcher, calls } = stubFetcher();
  const loader = new TurnCardLoader(fetcher);
  const card = await prepareSplitForQuiz(data, 'solve-1', loader, () => 0);
  assert.equal(card, 'As');
  assert.deepEqual(calls, ['As']);
  const questions = collectSpotQuestions({
    id: 'solve-1',
    name: 'Split flop',
    source: 'library',
    data,
  });
  assert.ok(questions.length > 0);
  // A question from the grafted card's turn node exists...
  assert.ok(questions.some((q) => q.street === 'turn' && q.itemKey.includes('|t:As')));
  // ...and none from the card that was never loaded.
  assert.ok(!questions.some((q) => q.itemKey.includes('|t:Kd')));
});
