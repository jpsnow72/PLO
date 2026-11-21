// Node-lock editor model (issue #9): the pure logic behind the visual
// lock editor shared by the Explorer (Edit Node) and the Solver
// (staged locks). Everything here is a pure function over the loaded
// solve's own data — the component layer only renders it.
//
// The contract this feeds (verified in engine source, NODELOCK-NOTES.md
// + engine/crates/plo-solve/src/locks.rs + api/server.mjs
// locksFieldError): a lock is { history, player, frequencies } where
// `frequencies` is ONE vector over the node's legal actions, summing
// to 1, and the engine holds EVERY combo of the acting player at that
// node to that vector from iteration 0. The API shape-validates the
// same flat array. There is no per-combo lock vector in the v1 engine
// (the buffer seam would support one as a v2 — see NODELOCK-NOTES
// "Deferred / gaps"), so the payload built here is exactly the user's
// range-level percentages, as fractions.
//
// The percentage -> per-combo EXPANSION below exists because GTO
// Wizard's editor (capture gtw2-f28, "Set Range Frequencies") thinks
// at range level too: the user sets each action's OVERALL percentage
// and the solver keeps its own per-hand splits. Our engine cannot
// take per-combo locks today, so the expansion is not the payload —
// it is the tested, ready-to-use redistribution the editor will hand
// the engine the day per-combo locks land, and the notes record the
// gap plainly rather than pretending the uniform vector is one.

import { aggregateFrequencies, liveCombos, type SolveData, type SolveNode } from './solveTree';
import type { Player } from './types';

/** One lock as the editor works with it: range-level percentages. */
export interface LockDraft {
  /** Output history key of the decision node (the engine's node identity). */
  history: string;
  player: Player;
  /** Action labels at the node, aligned with `percentages`. */
  actionLabels: string[];
  /** Overall action percentages for the whole range; must sum to 100. */
  percentages: number[];
  /**
   * How this lock got here: 'node' — set by hand on the node being
   * edited; 'line' — an earlier node on the current line, locked at
   * the solver's own frequencies; 'staged' — carried into the Solver
   * from the Explorer hand-off.
   */
  source: 'node' | 'line' | 'staged';
}

/** The engine/API payload for one lock (see the header comment). */
export interface NodeLockPayload {
  history: string;
  player: Player;
  frequencies: number[];
}

/** Human label for a node: "OOP · river · B(75) · pot 175.0". */
export function nodeLockLabel(node: SolveNode): string {
  return `${node.player} · ${node.streetName} · ${node.history} · pot ${node.pot.toFixed(1)}`;
}

/**
 * Validate editor percentages: every entry a finite number in
 * [0, 100], at least one entry, and the total 100 (within 0.01 — the
 * editor works in whole percents, and full-precision solver
 * aggregates carry float dust only). Returns an error string or null.
 */
export function validatePercentages(percentages: number[]): string | null {
  if (percentages.length === 0) return 'A lock needs at least one action.';
  for (const p of percentages) {
    if (!Number.isFinite(p) || p < 0 || p > 100) {
      return 'Every action percentage must be a number between 0 and 100.';
    }
  }
  const sum = percentages.reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 100) > 0.01) {
    return `Action percentages must add up to 100 (they add up to ${sum.toFixed(1)}).`;
  }
  return null;
}

/**
 * Rebalance after one slider moves (the behaviour the editor uses for
 * slider drags, in the spirit of the reference's Set Range
 * Frequencies sliders): the moved action takes the requested whole
 * percent and the OTHER actions are scaled proportionally so the
 * total stays exactly 100. Whole percents throughout; the rounding
 * residue goes to the largest remainders, so the result always sums
 * to exactly 100. Numeric inputs do NOT rebalance — they flag an
 * invalid total instead (validatePercentages), so a user typing a
 * number is never silently rewritten.
 */
export function rebalancePercentages(
  percentages: number[],
  index: number,
  value: number,
): number[] {
  const n = percentages.length;
  if (index < 0 || index >= n) return [...percentages];
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  if (n === 1) return [100];
  const rest = 100 - clamped;
  const others = percentages.filter((_, i) => i !== index);
  const otherSum = others.reduce((a, b) => a + b, 0);
  const scaled =
    otherSum > 0
      ? others.map((p) => (p / otherSum) * rest)
      : others.map(() => rest / others.length);
  // Largest-remainder rounding to whole percents summing to exactly rest.
  const floors = scaled.map((v) => Math.floor(v));
  let residue = rest - floors.reduce((a, b) => a + b, 0);
  const byRemainder = scaled
    .map((v, i) => ({ i, r: v - Math.floor(v) }))
    .sort((a, b) => b.r - a.r);
  for (const { i } of byRemainder) {
    if (residue <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    residue -= 1;
  }
  const out: number[] = new Array(n) as number[];
  out[index] = clamped;
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (i !== index) {
      out[i] = floors[k] ?? 0;
      k += 1;
    }
  }
  return out;
}

/**
 * The solver's own overall percentages at a node: the reach/weight-
 * weighted aggregate of its per-combo frequencies (aggregateFrequencies),
 * as full-precision percentages summing to ~100. This is both the
 * editor's starting point ("Reset to solver frequencies" restores it)
 * and the vector a line lock pins an earlier node to.
 */
export function solverPercentages(data: SolveData, node: SolveNode): number[] {
  return aggregateFrequencies(data, node).map((f) => f * 100);
}

/**
 * Expand range-level action percentages into per-combo frequency rows,
 * GTW-style: each action's OVERALL (range-weighted) total matches the
 * user's percentages, every combo's row sums to 1, and the solver's
 * relative per-hand splits are preserved (a combo the solver never
 * takes an action with keeps a zero there; cross-ratios between
 * combos within the scaling are untouched).
 *
 * Method: iterative proportional fitting (Sinkhorn) over the solver's
 * live rows — alternately scale actions to the target totals and rows
 * to sum 1, which converges to the unique matrix with both margins
 * and the solver's cross-ratio structure. Fallbacks, both documented
 * in NODELOCK-UI-NOTES: an action the solver never takes anywhere
 * (current total 0) but the user targets above 0 has no split to
 * preserve, so it is seeded uniformly across live combos before
 * fitting; a combo whose live row is entirely zeroed by the targets
 * receives the target vector itself.
 *
 * NOTE: this expansion is NOT what the v1 engine consumes (it takes
 * one uniform vector per node — see the header). It is the editor's
 * redistribution model, unit-tested here so the per-combo engine
 * follow-up inherits a proven mapping.
 */
export function expandActionPercentages(
  data: SolveData,
  node: SolveNode,
  percentages: number[],
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const combos = liveCombos(node);
  if (combos.length === 0) return out;
  const target = percentages.map((p) => p / 100);
  const weights = combos.map((c) => data.weights[node.player].get(c) ?? 1);
  const weightSum = weights.reduce((a, b) => a + b, 0) || 1;

  // Seed rows from the solver's own frequencies.
  const rows: number[][] = combos.map((combo) => {
    const row = node.strategy[combo];
    return node.actions.map((_, a) => (row ? (row[a] ?? 0) : 0));
  });
  // Actions with no solver mass anywhere but a positive target: seed
  // uniformly (no split exists to preserve).
  node.actions.forEach((_, a) => {
    const total = rows.reduce((acc, r) => acc + (r[a] ?? 0), 0);
    if (total <= 0 && (target[a] ?? 0) > 0) {
      rows.forEach((r) => {
        r[a] = target[a] ?? 0;
      });
    }
  });
  // A combo left with an all-zero row gets the target vector itself.
  rows.forEach((r, i) => {
    if (r.reduce((a, b) => a + b, 0) <= 0) rows[i] = [...target];
  });

  // Iterative proportional fitting: match weighted action totals,
  // then row sums, until both hold (or the iteration budget ends —
  // the margins are consistent by construction, so this converges
  // quickly on real nodes).
  for (let iter = 0; iter < 200; iter++) {
    // Scale actions to target totals.
    node.actions.forEach((_, a) => {
      const total = rows.reduce((acc, r, i) => acc + (weights[i] ?? 1) * (r[a] ?? 0), 0) / weightSum;
      const want = target[a] ?? 0;
      if (total > 0) {
        const k = want / total;
        rows.forEach((r) => {
          r[a] = (r[a] ?? 0) * k;
        });
      }
    });
    // Scale rows to sum 1.
    rows.forEach((r, i) => {
      const sum = r.reduce((a, b) => a + b, 0);
      if (sum > 0) {
        rows[i] = r.map((v) => v / sum);
      }
    });
    // Convergence check: both margins within tolerance.
    let maxErr = 0;
    node.actions.forEach((_, a) => {
      const total = rows.reduce((acc, r, i) => acc + (weights[i] ?? 1) * (r[a] ?? 0), 0) / weightSum;
      maxErr = Math.max(maxErr, Math.abs(total - (target[a] ?? 0)));
    });
    rows.forEach((r) => {
      maxErr = Math.max(maxErr, Math.abs(r.reduce((a, b) => a + b, 0) - 1));
    });
    if (maxErr < 1e-9) break;
  }

  combos.forEach((combo, i) => out.set(combo, rows[i] ?? []));
  return out;
}

/**
 * Assemble the "lock the line to this node" lock set: one lock per
 * EARLIER decision node on the current path (each pinned to the
 * solver's own frequencies there — the exact aggregate vectors from
 * the loaded solve), followed by the user's edited lock for the
 * current node. Single-action nodes are skipped (no decision to pin),
 * as is any earlier node that somehow repeats the current history.
 * Path steps are the store's { nodeHistory } steps; steps that do not
 * resolve in the loaded solve are skipped, never invented.
 */
export function assembleLineLocks(
  data: SolveData,
  path: { nodeHistory: string }[],
  currentDraft: LockDraft,
): LockDraft[] {
  const locks: LockDraft[] = [];
  const seen = new Set<string>();
  for (const step of path) {
    if (step.nodeHistory === currentDraft.history) break;
    if (seen.has(step.nodeHistory)) continue;
    const node = data.nodesByHistory.get(step.nodeHistory);
    if (!node) continue;
    if (node.actions.length < 2) continue;
    seen.add(node.history);
    locks.push({
      history: node.history,
      player: node.player,
      actionLabels: [...node.actions],
      percentages: solverPercentages(data, node),
      source: 'line',
    });
  }
  locks.push(currentDraft);
  return locks;
}

/**
 * The payload for one draft: the user's percentages as fractions,
 * renormalised so they sum to exactly 1 (the engine's tolerance is
 * 1e-6 — whole-percent drafts already sum to 1, full-precision solver
 * aggregates carry only float dust, which this absorbs).
 */
export function lockToPayload(draft: LockDraft): NodeLockPayload {
  const raw = draft.percentages.map((p) => p / 100);
  const sum = raw.reduce((a, b) => a + b, 0);
  const frequencies = sum > 0 ? raw.map((f) => f / sum) : raw;
  return { history: draft.history, player: draft.player, frequencies };
}

/** Short summary of a draft for lock lists: "Check 66% · Bet(75) 34%". */
export function lockSummary(draft: LockDraft): string {
  return draft.actionLabels
    .map((label, i) => `${label} ${Math.round(draft.percentages[i] ?? 0)}%`)
    .join(' · ');
}
