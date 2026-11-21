// Focused suite for the node-lock editor model (PLO issue #9):
// lib/nodelocks.ts — the percentage -> per-combo expansion, the
// lock-the-line assembly, and the sum-to-100 validation the shared
// NodeLockEditor component renders from.
//
// The rules under test:
//  - Expansion (GTW-style range-level editing): each action's overall
//    range-weighted total matches the user's percentages, every
//    combo's row sums to 1, and the solver's relative per-hand splits
//    are preserved (zero entries stay zero; cross-ratios between
//    combos are untouched by the fitting).
//  - Line locks: every earlier decision node on the path is included
//    with the SOLVER's frequencies there (its exact aggregate
//    vector); the user's edited lock for the current node comes last;
//    single-action nodes are skipped.
//  - Validation: percentages must each be within 0..100 and sum to
//    100; slider rebalancing keeps the total at exactly 100.
//
// Run route for the gate host, from ui/ (esbuild bundle -> CJS, the
// route the coordinator used for the sampled suite — solveTree.ts
// reads import.meta.env, which the define folds away):
//
//   npx esbuild tests/nodelocks.test.ts --bundle --platform=node \
//     --format=cjs --define:import.meta.env.DEV=false \
//     --outfile=/tmp/plo-nodelocks-test/nodelocks.test.cjs
//   node --test /tmp/plo-nodelocks-test/nodelocks.test.cjs

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assembleLineLocks,
  expandActionPercentages,
  lockToPayload,
  rebalancePercentages,
  solverPercentages,
  validatePercentages,
  type LockDraft,
} from '../src/lib/nodelocks';
import { parseSolve, type SolveData } from '../src/lib/solveTree';

const COMBO_A = 'Ac Ad Qh Qd';
const COMBO_B = 'Kc Kd Jh Jd';
const COMBO_C = 'Ts Th 9c 9d';

/** A minimal two-node river solve: OOP root (Check / Bet(75)), IP after check. */
function fixture(): SolveData {
  const raw = {
    board: 'As Ks Qs 7d 2c',
    starting_pot: 100,
    effective_stack: 100,
    iterations: 1000,
    exploitability: {
      nash_distance_pct: 0.1,
      nash_distance_chips: 0.1,
      mean_exploitability_pct: 0.1,
      mean_exploitability_chips: 0.1,
      oop_exploitability_chips: 0.05,
      ip_exploitability_chips: 0.05,
      oop_br_ev: 50,
      ip_br_ev: 50,
      oop_strategy_ev: 50,
      ip_strategy_ev: 50,
    },
    oop_evs: [
      { combo: COMBO_A, weight: 1, ev: 10 },
      { combo: COMBO_B, weight: 3, ev: 5 },
      { combo: COMBO_C, weight: 1, ev: 2 },
    ],
    ip_evs: [{ combo: '8s 6s 3h 4h', weight: 1, ev: 7 }],
    nodes: [
      {
        decision_id: 0,
        node_id: 0,
        player: 'OOP',
        history: 'root',
        pot: 100,
        to_call: 0,
        actions: ['Check', 'Bet(75)'],
        strategy: {
          [COMBO_A]: [0.8, 0.2],
          [COMBO_B]: [0.4, 0.6],
          [COMBO_C]: [1, 0],
        },
      },
      {
        decision_id: 1,
        node_id: 1,
        player: 'IP',
        history: 'X',
        pot: 100,
        to_call: 0,
        actions: ['Fold', 'Call'],
        strategy: { '8s 6s 3h 4h': [0.5, 0.5] },
      },
    ],
  };
  const data = parseSolve(raw);
  assert.ok(data);
  return data;
}

function approx(actual: number, expected: number, tol: number, what: string) {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${what}: expected ${expected} ± ${tol}, got ${actual}`,
  );
}

test('solverPercentages are the weighted aggregate of the node', () => {
  const data = fixture();
  const root = data.nodesByHistory.get('root');
  assert.ok(root);
  // (1*0.8 + 3*0.4 + 1*1) / 5 = 0.6 ; (1*0.2 + 3*0.6 + 1*0) / 5 = 0.4
  const pcts = solverPercentages(data, root);
  approx(pcts[0] ?? NaN, 60, 1e-9, 'Check aggregate');
  approx(pcts[1] ?? NaN, 40, 1e-9, 'Bet aggregate');
});

test('expansion: action totals match the user percentages, rows sum to 1', () => {
  const data = fixture();
  const root = data.nodesByHistory.get('root');
  assert.ok(root);
  const rows = expandActionPercentages(data, root, [25, 75]);
  assert.equal(rows.size, 3);
  let wTotal = 0;
  const totals = [0, 0];
  for (const [combo, row] of rows) {
    approx(row.reduce((a, b) => a + b, 0), 1, 1e-9, `row sum for ${combo}`);
    const w = data.weights.OOP.get(combo) ?? 1;
    wTotal += w;
    row.forEach((f, a) => {
      totals[a] = (totals[a] ?? 0) + w * f;
    });
  }
  approx((totals[0] ?? NaN) / wTotal, 0.25, 1e-6, 'Check total');
  approx((totals[1] ?? NaN) / wTotal, 0.75, 1e-6, 'Bet total');
});

test('expansion: per-hand splits preserved — zeros stay zero, cross-ratios hold', () => {
  const data = fixture();
  const root = data.nodesByHistory.get('root');
  assert.ok(root);
  const rows = expandActionPercentages(data, root, [50, 50]);
  const a = rows.get(COMBO_A);
  const b = rows.get(COMBO_B);
  const c = rows.get(COMBO_C);
  assert.ok(a && b && c);
  // COMBO_C never bets in the solver's strategy: the zero survives.
  assert.equal(c[1], 0);
  approx(c[0] ?? NaN, 1, 1e-9, 'pure combo stays pure');
  // Cross-ratio between A and B is a solver property the fit must not
  // move: (0.8/0.2) / (0.4/0.6) = 6.
  const cross = ((a[0] ?? NaN) / (a[1] ?? NaN)) / ((b[0] ?? NaN) / (b[1] ?? NaN));
  approx(cross, 6, 1e-4, 'cross-ratio A vs B');
});

test('line locks: earlier nodes ride at solver frequencies, user lock last', () => {
  const data = fixture();
  const draft: LockDraft = {
    history: 'X',
    player: 'IP',
    actionLabels: ['Fold', 'Call'],
    percentages: [70, 30],
    source: 'node',
  };
  const path: { nodeHistory: string }[] = [{ nodeHistory: 'root' }, { nodeHistory: 'X' }];
  const locks = assembleLineLocks(data, path, draft);
  assert.equal(locks.length, 2);
  const line = locks[0];
  assert.ok(line);
  assert.equal(line.history, 'root');
  assert.equal(line.player, 'OOP');
  assert.equal(line.source, 'line');
  // The line lock is the solver's own aggregate at the root: 60 / 40.
  approx(line.percentages[0] ?? NaN, 60, 1e-9, 'line lock Check');
  approx(line.percentages[1] ?? NaN, 40, 1e-9, 'line lock Bet');
  assert.equal(validatePercentages(line.percentages), null);
  // The user's edited lock is present verbatim, last.
  assert.deepEqual(locks[1], draft);
});

test('validation: sums and bounds are enforced, payload sums to exactly 1', () => {
  assert.equal(validatePercentages([66, 32, 1, 1]), null);
  assert.equal(validatePercentages([100]), null);
  assert.ok(validatePercentages([50, 40]) !== null);
  assert.ok(validatePercentages([50, 50.5]) !== null);
  assert.ok(validatePercentages([-1, 101]) !== null);
  assert.ok(validatePercentages([]) !== null);
  const payload = lockToPayload({
    history: 'root',
    player: 'OOP',
    actionLabels: ['Check', 'Bet(75)'],
    percentages: [60, 40],
    source: 'node',
  });
  assert.equal(payload.history, 'root');
  assert.equal(payload.player, 'OOP');
  approx(payload.frequencies.reduce((a, b) => a + b, 0), 1, 1e-12, 'payload sum');
  approx(payload.frequencies[0] ?? NaN, 0.6, 1e-12, 'payload Check');
});

test('rebalance: the moved slider wins, others scale, total stays exactly 100', () => {
  const next = rebalancePercentages([66, 32, 1, 1], 0, 50);
  assert.equal(next[0], 50);
  assert.equal(next.reduce((a, b) => a + b, 0), 100);
  // Proportional: the 32-action keeps the lion's share of the rest.
  assert.ok((next[1] ?? 0) > (next[2] ?? 0));
  assert.ok((next[1] ?? 0) > 40);
  const zeroed = rebalancePercentages([66, 32, 1, 1], 1, 0);
  assert.equal(zeroed[1], 0);
  assert.equal(zeroed.reduce((a, b) => a + b, 0), 100);
  const single = rebalancePercentages([100], 0, 30);
  assert.deepEqual(single, [100]);
});
