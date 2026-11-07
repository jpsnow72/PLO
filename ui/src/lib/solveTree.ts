// Solve-tree data layer: parses raw engine solve JSON into an indexed,
// navigable tree. All navigation is derived from the engine's `history`
// strings, never from assumptions about the game:
//
//   - Action labels map to history tokens exactly as the engine builds them
//     (see plo-solve game.rs `history_token`): Check->X, Fold->F, Call->C,
//     Bet(n)->B(n), BetAllIn(n)->BAI(n), Raise(n)->R(n), RaiseAllIn(n)->RAI(n).
//   - A child node's history is `parent/token`, or just `token` at the root.
//   - In turn solves, when an action closes the turn street there is no direct
//     child; instead one river subtree root exists per river card with
//     history `{childHistory}|r:{Card}`. That is the chance node: the UI
//     presents a runout picker.

import { parseCard, parseCardList, RANK_ORDER, type Card } from './cards';
import type { Player, RawSolve, RawSolveNode } from './types';

export interface SolveNode extends RawSolveNode {
  /** Normalised street: river solves report every node as "river". */
  streetName: 'turn' | 'river';
}

export interface SolveData {
  raw: RawSolve;
  kind: 'river' | 'turn';
  boardCards: Card[];
  root: SolveNode;
  nodesByHistory: Map<string, SolveNode>;
  weights: Record<Player, Map<string, number>>;
  evs: Record<Player, Map<string, number>>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isRawSolve(v: unknown): v is RawSolve {
  if (!isRecord(v)) return false;
  return (
    typeof v.board === 'string' &&
    typeof v.starting_pot === 'number' &&
    typeof v.effective_stack === 'number' &&
    isRecord(v.exploitability) &&
    typeof v.exploitability.nash_distance_pct === 'number' &&
    Array.isArray(v.oop_evs) &&
    Array.isArray(v.ip_evs) &&
    Array.isArray(v.nodes) &&
    v.nodes.length > 0
  );
}

/** Parse + index a raw solve JSON value. Returns null if the shape is wrong. */
export function parseSolve(value: unknown): SolveData | null {
  if (!isRawSolve(value)) return null;
  const raw = value;
  const boardCards = parseCardList(raw.board) ?? [];
  const kind: SolveData['kind'] = raw.nodes.some((n) => typeof n.street === 'string')
    ? 'turn'
    : 'river';

  const nodesByHistory = new Map<string, SolveNode>();
  let root: SolveNode | null = null;
  for (const n of raw.nodes) {
    const streetName: SolveNode['streetName'] =
      n.street === 'turn' || n.street === 'river'
        ? n.street
        : n.river_card
          ? 'river'
          : kind === 'turn'
            ? 'turn'
            : 'river';
    const node: SolveNode = { ...n, streetName };
    nodesByHistory.set(node.history, node);
    if (node.history === 'root') root = node;
  }
  if (!root) return null;

  const weights: SolveData['weights'] = { OOP: new Map(), IP: new Map() };
  const evs: SolveData['evs'] = { OOP: new Map(), IP: new Map() };
  for (const ce of raw.oop_evs) {
    weights.OOP.set(ce.combo, ce.weight);
    evs.OOP.set(ce.combo, ce.ev);
  }
  for (const ce of raw.ip_evs) {
    weights.IP.set(ce.combo, ce.weight);
    evs.IP.set(ce.combo, ce.ev);
  }

  const data: SolveData = { raw, kind, boardCards, root, nodesByHistory, weights, evs };
  if (import.meta.env.DEV) devCheckFrequencySums(data);
  return data;
}

/** Dev-only sanity check: every live combo row should sum to ~1. */
function devCheckFrequencySums(data: SolveData): void {
  for (const node of data.nodesByHistory.values()) {
    for (const [combo, freqs] of Object.entries(node.strategy)) {
      const sum = freqs.reduce((a, b) => a + b, 0);
      if (sum > 0 && Math.abs(sum - 1) > 0.02) {
        // eslint-disable-next-line no-console
        console.warn(
          `[solve] frequency sum ${sum.toFixed(3)} != 1 for ${combo} at ${node.history}`,
        );
      }
    }
  }
}

/** Engine history token for an action label (mirrors plo-solve game.rs). */
export function actionToken(actionLabel: string): string {
  if (actionLabel === 'Check') return 'X';
  if (actionLabel === 'Fold') return 'F';
  if (actionLabel === 'Call') return 'C';
  const bet = /^Bet\((.+)\)$/.exec(actionLabel);
  if (bet) return `B(${bet[1]})`;
  const betAllIn = /^BetAllIn\((.+)\)$/.exec(actionLabel);
  if (betAllIn) return `BAI(${betAllIn[1]})`;
  const raiseAllIn = /^RaiseAllIn\((.+)\)$/.exec(actionLabel);
  if (raiseAllIn) return `RAI(${raiseAllIn[1]})`;
  const raise = /^Raise\((.+)\)$/.exec(actionLabel);
  if (raise) return `R(${raise[1]})`;
  return actionLabel;
}

export function childHistory(node: SolveNode, actionLabel: string): string {
  const token = actionToken(actionLabel);
  return node.history === 'root' ? token : `${node.history}/${token}`;
}

export interface RunoutOption {
  card: string;
  node: SolveNode;
}

export type StepResult =
  | { type: 'node'; node: SolveNode }
  | { type: 'runout'; baseHistory: string; options: RunoutOption[] }
  | { type: 'terminal'; actionLabel: string };

/**
 * What happens when `actionLabel` is taken at `node`:
 *  - a direct child decision node (normal case),
 *  - a chance node (turn street closed -> pick a river card), or
 *  - a terminal (fold / call / check that ends the hand, or an all-in
 *    runout with no further decisions in this solve).
 */
export function resolveStep(data: SolveData, node: SolveNode, actionLabel: string): StepResult {
  const child = childHistory(node, actionLabel);
  const direct = data.nodesByHistory.get(child);
  if (direct) return { type: 'node', node: direct };

  const prefix = `${child}|r:`;
  const options: RunoutOption[] = [];
  for (const candidate of data.nodesByHistory.values()) {
    if (!candidate.history.startsWith(prefix)) continue;
    const rest = candidate.history.slice(prefix.length);
    if (rest.includes('/')) continue; // only subtree roots, not deeper nodes
    options.push({ card: candidate.river_card ?? rest, node: candidate });
  }
  if (options.length > 0) {
    options.sort((a, b) => {
      const ra = parseCard(a.card);
      const rb = parseCard(b.card);
      const byRank = (RANK_ORDER[rb?.rank ?? ''] ?? 0) - (RANK_ORDER[ra?.rank ?? ''] ?? 0);
      return byRank !== 0 ? byRank : a.card.localeCompare(b.card);
    });
    return { type: 'runout', baseHistory: child, options };
  }
  return { type: 'terminal', actionLabel };
}

/** Combos with a live strategy row at this node (blocked combos have all-zero rows). */
export function liveCombos(node: SolveNode): string[] {
  return Object.keys(node.strategy).filter((combo) => {
    const freqs = node.strategy[combo];
    return freqs !== undefined && freqs.reduce((a, b) => a + b, 0) > 0;
  });
}

/**
 * Range-aggregate frequency per action at a node: weighted by each combo's
 * range weight (from the solve's *_evs lists). Blocked (all-zero) combos are
 * excluded. Returns one number per action index, summing to ~1.
 */
export function aggregateFrequencies(data: SolveData, node: SolveNode): number[] {
  const totals = node.actions.map(() => 0);
  let weightSum = 0;
  for (const combo of liveCombos(node)) {
    const w = data.weights[node.player].get(combo) ?? 1;
    const freqs = node.strategy[combo];
    if (!freqs) continue;
    weightSum += w;
    freqs.forEach((f, i) => {
      totals[i] += w * f;
    });
  }
  if (weightSum === 0) return totals;
  return totals.map((t) => t / weightSum);
}

/** Weighted average of the acting player's per-combo EVs (solve-level, from *_evs). */
export function rangeEv(data: SolveData, player: Player): number {
  const evMap = data.evs[player];
  const wMap = data.weights[player];
  let num = 0;
  let den = 0;
  for (const [combo, ev] of evMap) {
    const w = wMap.get(combo) ?? 1;
    num += w * ev;
    den += w;
  }
  return den === 0 ? 0 : num / den;
}

export function comboEv(data: SolveData, player: Player, combo: string): number | null {
  return data.evs[player].get(combo) ?? null;
}

export function comboWeight(data: SolveData, player: Player, combo: string): number {
  return data.weights[player].get(combo) ?? 1;
}
