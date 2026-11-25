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
//   - Flop solves add one more chance level on top: an action that closes
//     the flop street leads to one turn subtree root per turn card with
//     history `{childHistory}|t:{Card}`; inside those subtrees the turn
//     solver's own `{...}|r:{Card}` river roots hang below the namespaced
//     turn path (e.g. `B(75)/C|t:As/X/X|r:Kd`).

import { parseCard, parseCardList, RANK_ORDER, type Card } from './cards';
import type { Player, RawSolve, RawSolveNode } from './types';

export interface SolveNode extends RawSolveNode {
  /** Normalised street: river solves report every node as "river". */
  streetName: 'flop' | 'turn' | 'river';
}

/**
 * Split-solve state (issue #57): a flop solve stored in pieces. The
 * header doc indexes only the flop street; each turn card's subtree
 * is grafted into `nodesByHistory` on first use (see graftTurnNodes
 * and lib/splitSolve.ts). `loadedCards` is the session cache — a card
 * in it never needs fetching again for this solve.
 */
export interface SplitInfo {
  format: 1;
  /** Every turn card the full solve has a subtree for. */
  turnCards: string[];
  /** Cards whose nodes are already grafted into the index. */
  loadedCards: Set<string>;
}

export interface SolveData {
  raw: RawSolve;
  kind: 'river' | 'turn' | 'flop';
  boardCards: Card[];
  root: SolveNode;
  nodesByHistory: Map<string, SolveNode>;
  weights: Record<Player, Map<string, number>>;
  evs: Record<Player, Map<string, number>>;
  /** Split-solve state, or null for ordinary (whole-tree) solves. */
  split: SplitInfo | null;
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

/** Normalise one raw node: attach the street name every surface reads. */
function toSolveNode(n: RawSolveNode, kind: SolveData['kind']): SolveNode {
  const streetName: SolveNode['streetName'] =
    n.street === 'flop' || n.street === 'turn' || n.street === 'river'
      ? n.street
      : n.river_card
        ? 'river'
        : kind === 'flop'
          ? 'flop'
          : kind === 'turn'
            ? 'turn'
            : 'river';
  return { ...n, streetName };
}

/** Defensive read of the split marker on a raw solve doc. */
function parseSplit(raw: RawSolve): SplitInfo | null {
  const s = raw.split;
  if (!isRecord(s) || s.format !== 1 || !Array.isArray(s.turn_cards)) return null;
  const turnCards = s.turn_cards.filter((c): c is string => typeof c === 'string');
  if (turnCards.length === 0) return null;
  return { format: 1, turnCards, loadedCards: new Set() };
}

/** Parse + index a raw solve JSON value. Returns null if the shape is wrong. */
export function parseSolve(value: unknown): SolveData | null {
  if (!isRawSolve(value)) return null;
  const raw = value;
  const boardCards = parseCardList(raw.board) ?? [];
  const kind: SolveData['kind'] =
    boardCards.length === 3
      ? 'flop'
      : boardCards.length === 4
        ? 'turn'
        : boardCards.length === 5
          ? 'river'
          : raw.nodes.some((n) => typeof n.street === 'string')
            ? 'turn'
            : 'river';

  const nodesByHistory = new Map<string, SolveNode>();
  let root: SolveNode | null = null;
  for (const n of raw.nodes) {
    const node = toSolveNode(n, kind);
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

  const data: SolveData = {
    raw,
    kind,
    boardCards,
    root,
    nodesByHistory,
    weights,
    evs,
    split: parseSplit(raw),
  };
  if (import.meta.env.DEV) devCheckFrequencySums(data);
  return data;
}

// ---------- Split solves: lookup states + lazy graft (issue #57) ------------

/** The turn card a history lives under (`...|t:As/...`), or null. */
export function historyTurnCard(history: string): string | null {
  const m = /\|t:([^/|]+)/.exec(history);
  return m ? (m[1] ?? null) : null;
}

export type NodeLookupState = 'present' | 'unloaded-card' | 'absent';

/**
 * Where a history stands in the loaded model:
 *  - 'present':       the node is indexed and can be rendered now;
 *  - 'unloaded-card': the history belongs to a split solve's turn
 *                     subtree for a card that has not been fetched
 *                     yet — navigation must load that card first;
 *  - 'absent':        the solve has no such node at all.
 * Non-split solves only ever answer 'present' or 'absent'.
 */
export function nodeLookupState(data: SolveData, history: string): NodeLookupState {
  if (data.nodesByHistory.has(history)) return 'present';
  if (data.split) {
    const card = historyTurnCard(history);
    if (card && data.split.turnCards.includes(card) && !data.split.loadedCards.has(card)) {
      return 'unloaded-card';
    }
  }
  return 'absent';
}

/**
 * Validate a GET /api/solves/:id/turn/<card> body. Returns its nodes,
 * or null when the body is not the payload the contract promises
 * (wrong card echoed, no nodes array, a node without the fields the
 * tree walker reads). Nothing is partially applied on null.
 */
export function parseTurnPayload(value: unknown, card: string): RawSolveNode[] | null {
  if (!isRecord(value) || value.turn_card !== card || !Array.isArray(value.nodes)) return null;
  if (value.nodes.length === 0) return null;
  for (const n of value.nodes) {
    if (!isRecord(n)) return null;
    if (typeof n.history !== 'string' || typeof n.player !== 'string') return null;
    if (!Array.isArray(n.actions) || !isRecord(n.strategy)) return null;
    // A per-card payload must stay inside its own card: a node naming
    // a different turn card would graft one card's fetch into
    // another's subtree.
    if (historyTurnCard(n.history) !== card) return null;
  }
  return value.nodes as RawSolveNode[];
}

/**
 * Graft one turn card's payload into the index. Idempotent (a card
 * already loaded is a no-op success). Returns false — and changes
 * nothing — for non-split data or a malformed payload, so callers can
 * surface a retry instead of a half-loaded tree.
 */
export function graftTurnNodes(data: SolveData, card: string, payload: unknown): boolean {
  if (!data.split || !data.split.turnCards.includes(card)) return false;
  if (data.split.loadedCards.has(card)) return true;
  const nodes = parseTurnPayload(payload, card);
  if (!nodes) return false;
  for (const n of nodes) {
    const node = toSolveNode(n, data.kind);
    data.nodesByHistory.set(node.history, node);
  }
  data.split.loadedCards.add(card);
  return true;
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
  /** Which chance node this option belongs to: dealing the turn or the river. */
  street: 'turn' | 'river';
  node: SolveNode;
}

export type StepResult =
  | { type: 'node'; node: SolveNode }
  | { type: 'runout'; baseHistory: string; options: RunoutOption[] }
  /**
   * Split solves only: the action closes the flop street, but no turn
   * card's subtree is loaded yet, so there are no subtree roots to
   * offer as options. `cards` are the solve's available turn cards;
   * picking one triggers its fetch + graft (lib/splitSolve.ts), after
   * which the same step resolves as a normal 'runout'.
   */
  | { type: 'split-runout'; baseHistory: string; cards: string[] }
  | { type: 'terminal'; actionLabel: string };

/**
 * What happens when `actionLabel` is taken at `node`:
 *  - a direct child decision node (normal case),
 *  - a chance node (flop street closed -> pick a turn card; turn street
 *    closed -> pick a river card), or
 *  - a terminal (fold / call / check that ends the hand, or an all-in
 *    runout with no further decisions in this solve).
 */
export function resolveStep(data: SolveData, node: SolveNode, actionLabel: string): StepResult {
  const child = childHistory(node, actionLabel);
  const direct = data.nodesByHistory.get(child);
  if (direct) return { type: 'node', node: direct };

  // Chance nodes: subtree roots live at `{child}|t:{Card}` (turn deal, flop
  // solves) or `{child}|r:{Card}` (river deal, turn and flop solves).
  const chanceSpecs = [
    { marker: 't', street: 'turn' },
    { marker: 'r', street: 'river' },
  ] as const;
  for (const spec of chanceSpecs) {
    const prefix = `${child}|${spec.marker}:`;
    const options: RunoutOption[] = [];
    for (const candidate of data.nodesByHistory.values()) {
      if (!candidate.history.startsWith(prefix)) continue;
      const rest = candidate.history.slice(prefix.length);
      if (rest.includes('/') || rest.includes('|')) continue; // only subtree roots
      const card =
        spec.street === 'turn'
          ? (candidate.turn_card ?? rest)
          : (candidate.river_card ?? rest);
      options.push({ card, street: spec.street, node: candidate });
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
    // Split solves: no turn subtree is loaded yet, so no subtree root
    // could be found — but the header doc names every available turn
    // card. Any non-fold action whose child is absent at a flop node
    // closed the street (flop-street children are all in the header);
    // the caller offers the cards and loads the picked one. (An
    // all-in close emits no subtrees even in a whole solve; there the
    // loaded payload simply has no root for this line and the caller
    // falls back to the terminal message.)
    if (spec.marker === 't' && data.split && actionLabel !== 'Fold') {
      return { type: 'split-runout', baseHistory: child, cards: [...data.split.turnCards] };
    }
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

// ---------- Per-action EVs (issue #8) ---------------------------------------

/**
 * Defensive read of a node's per-action EV table (`combo_action_evs`:
 * combo -> EV per action, aligned with `actions`, in chips). Returns
 * the row for `combo`, or null when the payload carries no such table
 * or the row is absent/misaligned — the same pattern the quiz grader
 * uses (quiz.ts), so every surface agrees on what "available" means.
 * Callers treat null as "not available" and fall back to their
 * no-field rendering; nothing is ever estimated.
 */
export function comboActionEvs(node: SolveNode, combo: string): number[] | null {
  const raw = (node as unknown as Record<string, unknown>).combo_action_evs;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const row = (raw as Record<string, unknown>)[combo];
  if (!Array.isArray(row) || row.length !== node.actions.length) return null;
  if (!row.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return row as number[];
}

/** True when at least one of the node's strategy rows has a readable
 *  per-action EV row — i.e. this node carries the #8 field. */
export function nodeHasActionEvs(node: SolveNode): boolean {
  return Object.keys(node.strategy).some((combo) => comboActionEvs(node, combo) !== null);
}

/**
 * The combo's EV at this node: its per-action EVs weighted by its own
 * frequencies here (Σ freq × action EV). Null when the payload has no
 * per-action EVs for the combo, or the combo has no live strategy row
 * at this node (a blocked combo's all-zero row is not a value).
 */
export function comboNodeEv(node: SolveNode, combo: string): number | null {
  const evs = comboActionEvs(node, combo);
  const freqs = node.strategy[combo];
  if (!evs || !freqs) return null;
  let freqSum = 0;
  let ev = 0;
  freqs.forEach((f, i) => {
    freqSum += f;
    ev += f * (evs[i] ?? 0);
  });
  return freqSum > 0 ? ev : null;
}

/**
 * EV Diff for a combo at this node: the EV of the solver's most-taken
 * action for the combo minus the EV of its best action, in chips —
 * always <= 0, and 0 when the main line is a best action (in
 * particular when the strategy is pure on the best action). Null when
 * per-action EVs are unavailable or the combo is not live here.
 */
export function comboEvDiff(node: SolveNode, combo: string): number | null {
  const evs = comboActionEvs(node, combo);
  const freqs = node.strategy[combo];
  if (!evs || !freqs) return null;
  let freqSum = 0;
  let main = 0;
  freqs.forEach((f, i) => {
    freqSum += f;
    if (f > (freqs[main] ?? 0)) main = i;
  });
  if (freqSum <= 0) return null;
  return (evs[main] ?? 0) - Math.max(...evs);
}

/**
 * EV Diff for one specific action of a combo at this node: that
 * action's EV minus the combo's best action EV, in chips (<= 0, and 0
 * when the action is a best action for the combo). Null when
 * per-action EVs are unavailable.
 */
export function actionEvDiff(
  node: SolveNode,
  combo: string,
  actionIdx: number,
): number | null {
  const evs = comboActionEvs(node, combo);
  if (!evs) return null;
  const ev = evs[actionIdx];
  if (ev === undefined) return null;
  return ev - Math.max(...evs);
}

export interface LineMoney {
  /**
   * Chips each player has put into the pot along the current path, inside
   * the solved tree. The starting pot is pre-tree money; the payload does
   * not split it between the players, so it is attributed to neither.
   */
  committed: Record<Player, number>;
  /** Stack behind at the current node: effective stack minus committed. */
  stackBehind: Record<Player, number>;
}

/**
 * Per-player money along a path, derived from the payload's own pot
 * figures: the pot only changes when a player acts, so the pot difference
 * between consecutive path nodes is exactly what the player to act at the
 * earlier node put in with that action. A street-closing action's chips
 * land in the runout subtree root's pot, so runout steps attribute the
 * same way. No action amounts are parsed or assumed.
 */
export function lineMoney(data: SolveData, path: { nodeHistory: string }[]): LineMoney {
  const committed: Record<Player, number> = { OOP: 0, IP: 0 };
  for (let i = 0; i + 1 < path.length; i++) {
    const fromStep = path[i];
    const toStep = path[i + 1];
    if (!fromStep || !toStep) continue;
    const from = data.nodesByHistory.get(fromStep.nodeHistory);
    const to = data.nodesByHistory.get(toStep.nodeHistory);
    if (!from || !to) continue;
    const delta = to.pot - from.pot;
    if (delta > 0) committed[from.player] += delta;
  }
  return {
    committed,
    stackBehind: {
      OOP: Math.max(0, data.raw.effective_stack - committed.OOP),
      IP: Math.max(0, data.raw.effective_stack - committed.IP),
    },
  };
}

export interface RangePresence {
  /** Combos of the player's range that can still be held at this node. */
  combos: number;
  /** Reach-weighted share of the player's starting range still live, 0..1. */
  share: number;
  /** Total combos in the player's starting range (the *_evs lists). */
  totalCombos: number;
}

/**
 * Per-combo reach at the node a path leads to: combo -> its range
 * weight times, for every decision node of that player along the path,
 * the frequency of the action the line actually took there (found by
 * matching child histories, so street-closing actions count too).
 * Combos containing a dealt board card are impossible and excluded;
 * for the player to act, the current node's own all-zero
 * (card-blocked) rows drop out the same way. Frequencies come straight
 * from ancestor nodes' strategy rows — nothing is modelled. Only
 * combos with reach > 0 are returned.
 */
function comboReach(
  data: SolveData,
  path: { nodeHistory: string }[],
  player: Player,
): Map<string, number> {
  const weights = data.weights[player];

  const lastStep = path[path.length - 1];
  const current = lastStep ? data.nodesByHistory.get(lastStep.nodeHistory) : undefined;

  // Dead cards: the full board at the current node.
  const dead = new Set<string>(data.boardCards.map((c) => c.label));
  if (current?.turn_card) dead.add(current.turn_card);
  if (current?.river_card) dead.add(current.river_card);

  // This player's decision nodes along the path, with the action taken.
  const decisions: { node: SolveNode; actionIdx: number }[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const fromStep = path[i];
    const toStep = path[i + 1];
    if (!fromStep || !toStep) continue;
    const from = data.nodesByHistory.get(fromStep.nodeHistory);
    if (!from || from.player !== player) continue;
    const actionIdx = from.actions.findIndex((label) => {
      const h = childHistory(from, label);
      return toStep.nodeHistory === h || toStep.nodeHistory.startsWith(`${h}|`);
    });
    if (actionIdx >= 0) decisions.push({ node: from, actionIdx });
  }

  const reach = new Map<string, number>();
  for (const [combo, w] of weights) {
    if (combo.split(' ').some((c) => dead.has(c))) continue;
    let presence = w;
    for (const d of decisions) {
      const freqs = d.node.strategy[combo];
      presence *= freqs ? (freqs[d.actionIdx] ?? 0) : 0;
      if (presence === 0) break;
    }
    // For the player to act, the current node's own rows also gate:
    // card-blocked combos carry all-zero rows there.
    if (presence > 0 && current && current.player === player) {
      const row = current.strategy[combo];
      if (!row || row.reduce((a, b) => a + b, 0) <= 0) presence = 0;
    }
    if (presence > 0) reach.set(combo, presence);
  }
  return reach;
}

/**
 * How much of `player`'s starting range is still live at the node a
 * path leads to, aggregated from comboReach.
 */
export function rangePresence(
  data: SolveData,
  path: { nodeHistory: string }[],
  player: Player,
): RangePresence {
  const weights = data.weights[player];
  let totalWeight = 0;
  for (const w of weights.values()) totalWeight += w;

  const reach = comboReach(data, path, player);
  let liveWeight = 0;
  for (const r of reach.values()) liveWeight += r;
  return {
    combos: reach.size,
    share: totalWeight === 0 ? 0 : liveWeight / totalWeight,
    totalCombos: weights.size,
  };
}

export interface LiveCombo {
  combo: string;
  /** Starting range weight from the *_evs lists. */
  weight: number;
  /**
   * Reach weight at this node: the starting weight times the product
   * of the player's taken-action frequencies along the path (see
   * comboReach). This is how much of the combo actually arrives here.
   */
  reach: number;
  /** Whole-solve EV of the combo, null when the payload has none. */
  ev: number | null;
}

/**
 * Every combo of `player`'s range still live at the node a path leads
 * to, with its starting weight, reach weight and whole-solve EV.
 * Sorted by reach descending, then combo string.
 */
export function liveRange(
  data: SolveData,
  path: { nodeHistory: string }[],
  player: Player,
): LiveCombo[] {
  const reach = comboReach(data, path, player);
  const out: LiveCombo[] = [];
  for (const [combo, r] of reach) {
    out.push({
      combo,
      weight: data.weights[player].get(combo) ?? 0,
      reach: r,
      ev: data.evs[player].get(combo) ?? null,
    });
  }
  out.sort((a, b) => b.reach - a.reach || a.combo.localeCompare(b.combo));
  return out;
}
