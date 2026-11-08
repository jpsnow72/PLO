// Study-layer data layer (ticket S1): types + runtime guards for the
// heuristics log and Quick Review, plus the pure logic that turns a
// parsed solve into flash cards.
//
// Honesty rules baked in here:
//  - Heuristic support stats (support_n / mean_freq / spread) are only
//    ever carried through when the server sent them — never derived or
//    invented client-side.
//  - A review card's "why" is assembled only from numbers the solve
//    actually contains: the hero combo's action frequencies, the range
//    aggregate at the node, and the combo's whole-solve EV. The engine
//    reports EV per combo for the whole solve, NOT per action — so no
//    per-action EV (or "EV gap between actions") is ever claimed; the
//    frequency gap between the top two actions is what the card cites.

import { parseCard, parseCardList, parseCombo, type Card } from './cards';
import { prettyAction } from '../components/actionStyle';
import {
  aggregateFrequencies,
  comboEv,
  comboWeight,
  liveCombos,
  type SolveData,
  type SolveNode,
} from './solveTree';
import type { Player } from './types';

// ---------- Heuristics ----------

export type HeuristicSource = 'manual' | 'ai-suggested' | 'mined';
export type HeuristicStatus = 'active' | 'retired';

export interface HeuristicTags {
  texture?: string;
  street?: string;
  spot_type?: string;
}

export interface Heuristic {
  id: string;
  text: string;
  source: HeuristicSource;
  tags: HeuristicTags;
  linked_spot_ids: string[];
  status: HeuristicStatus;
  /** Mined support stats — present only when the record carries them. */
  support_n?: number;
  mean_freq?: number;
  spread?: number;
  created_at: string;
  updated_at: string;
}

/** Fields a client may send on create/update (server strips the rest). */
export interface HeuristicInput {
  text?: string;
  source?: HeuristicSource;
  tags?: HeuristicTags;
  linked_spot_ids?: string[];
  status?: HeuristicStatus;
  support_n?: number | null;
  mean_freq?: number | null;
  spread?: number | null;
}

export const HEURISTIC_SOURCE_LABEL: Record<HeuristicSource, string> = {
  manual: 'Hand-written',
  'ai-suggested': 'AI-suggested',
  mined: 'Mined from solves',
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isHeuristicSource(v: unknown): v is HeuristicSource {
  return v === 'manual' || v === 'ai-suggested' || v === 'mined';
}

export function isHeuristic(v: unknown): v is Heuristic {
  if (!isRecord(v)) return false;
  if (
    typeof v.id !== 'string' ||
    typeof v.text !== 'string' ||
    !isHeuristicSource(v.source) ||
    !isRecord(v.tags) ||
    !Array.isArray(v.linked_spot_ids) ||
    !v.linked_spot_ids.every((id) => typeof id === 'string') ||
    (v.status !== 'active' && v.status !== 'retired') ||
    typeof v.created_at !== 'string' ||
    typeof v.updated_at !== 'string'
  ) {
    return false;
  }
  for (const key of ['texture', 'street', 'spot_type'] as const) {
    const tag = v.tags[key];
    if (tag !== undefined && typeof tag !== 'string') return false;
  }
  for (const key of ['support_n', 'mean_freq', 'spread'] as const) {
    const stat = v[key];
    if (stat !== undefined && !isFiniteNumber(stat)) return false;
  }
  return true;
}

/** Parse a GET /api/heuristics body; null when the shape is wrong. */
export function parseHeuristicsResponse(v: unknown): Heuristic[] | null {
  if (!isRecord(v) || !Array.isArray(v.heuristics)) return null;
  const out: Heuristic[] = [];
  for (const raw of v.heuristics) {
    if (!isHeuristic(raw)) return null;
    out.push(raw);
  }
  return out;
}

/** Parse a single-record response (POST/PUT); null when malformed. */
export function parseHeuristic(v: unknown): Heuristic | null {
  return isHeuristic(v) ? v : null;
}

// ---------- Study progress (Quick Review outcomes) ----------

export interface StudyProgress {
  total_events: number;
  got: number;
  missed: number;
  sessions: number;
  last_session_at: string | null;
  by_street: Record<string, { got: number; missed: number }>;
}

export function parseStudyProgress(v: unknown): StudyProgress | null {
  if (!isRecord(v)) return null;
  if (
    !isFiniteNumber(v.total_events) ||
    !isFiniteNumber(v.got) ||
    !isFiniteNumber(v.missed) ||
    !isFiniteNumber(v.sessions) ||
    !(typeof v.last_session_at === 'string' || v.last_session_at === null) ||
    !isRecord(v.by_street)
  ) {
    return null;
  }
  const byStreet: StudyProgress['by_street'] = {};
  for (const [street, counts] of Object.entries(v.by_street)) {
    if (!isRecord(counts) || !isFiniteNumber(counts.got) || !isFiniteNumber(counts.missed)) {
      return null;
    }
    byStreet[street] = { got: counts.got, missed: counts.missed };
  }
  return {
    total_events: v.total_events,
    got: v.got,
    missed: v.missed,
    sessions: v.sessions,
    last_session_at: v.last_session_at,
    by_street: byStreet,
  };
}

/** One graded card, as posted to POST /api/study/review-events. */
export interface ReviewEventInput {
  session_id: string;
  spot_id: string | null;
  source: 'library' | 'job' | 'sample';
  board: string;
  street: string;
  player: string;
  node_history: string;
  hero_combo: string;
  grade: 'got' | 'missed';
}

// ---------- Quick Review cards ----------

export interface ReviewCard {
  key: string;
  /** Library/job id of the solve this card came from; null for the sample. */
  solveId: string | null;
  solveName: string;
  source: 'library' | 'job' | 'sample';
  /** Board as shown on the card (solve board + this node's runout cards). */
  boardCards: Card[];
  boardLabel: string;
  street: 'flop' | 'turn' | 'river';
  player: Player;
  heroCombo: string;
  heroCards: Card[];
  nodeHistory: string;
  pot: number;
  toCall: number;
  actions: string[];
  /** The solver's mix for the hero combo at this node (the answer). */
  heroFreqs: number[];
  /** The range-level mix at this node, for context. */
  aggregateFreqs: number[];
  /** Whole-solve EV of the hero combo (solve-level, as the engine reports). */
  heroEv: number | null;
  /** One line, assembled only from the numbers above. */
  why: string;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

/**
 * The one-line "why" for a card, from the node's actual data only:
 * the hero combo's dominant action and frequency, the frequency gap to
 * the runner-up, whether the combo follows or deviates from the range's
 * dominant play, and the combo's whole-solve EV when the engine gave one.
 */
export function cardWhy(
  actions: string[],
  heroFreqs: number[],
  aggregateFreqs: number[],
  heroEv: number | null,
): string {
  const order = actions
    .map((label, i) => ({ label, f: heroFreqs[i] ?? 0 }))
    .sort((a, b) => b.f - a.f);
  const top = order[0];
  if (!top) return 'No strategy data at this node.';
  const parts: string[] = [];
  if (top.f >= 0.995) {
    parts.push(`${prettyAction(top.label)} is essentially pure here (${pct(top.f)} of this combo)`);
  } else {
    const second = order[1];
    const gapPts = Math.round((top.f - (second?.f ?? 0)) * 100);
    parts.push(
      second
        ? `${prettyAction(top.label)} leads the mix at ${pct(top.f)}, ${gapPts} pts ahead of ${prettyAction(second.label)}`
        : `${prettyAction(top.label)} at ${pct(top.f)}`,
    );
  }
  let aggTop = -1;
  let aggBest = -1;
  aggregateFreqs.forEach((f, i) => {
    if (f > aggBest) {
      aggBest = f;
      aggTop = i;
    }
  });
  const heroTopIdx = actions.indexOf(top.label);
  if (aggTop >= 0 && actions[aggTop] !== undefined) {
    if (aggTop === heroTopIdx) {
      parts.push(`the whole range leans the same way (${prettyAction(actions[aggTop])} ${pct(aggBest)})`);
    } else {
      parts.push(
        `this combo deviates — the range overall favours ${prettyAction(actions[aggTop])} (${pct(aggBest)})`,
      );
    }
  }
  if (heroEv !== null) {
    parts.push(`combo EV over the whole solve: ${heroEv >= 0 ? '+' : ''}${heroEv.toFixed(2)}`);
  }
  return parts.join('; ') + '.';
}

/** Display board for a node: the solve board plus its dealt runout cards. */
function nodeBoardCards(data: SolveData, node: SolveNode): Card[] {
  const cards = [...data.boardCards];
  const seen = new Set(cards.map((c) => c.label));
  for (const raw of [node.turn_card, node.river_card]) {
    if (!raw) continue;
    const card = parseCard(raw);
    if (card && !seen.has(card.label)) {
      cards.push(card);
      seen.add(card.label);
    }
  }
  return cards;
}

/**
 * Build flash cards from a parsed solve. Deterministic: nodes in solve
 * order, hero combos by descending range weight (then name). Terminal-
 * only rows (all-zero strategy, e.g. blocked combos) are skipped — a
 * card must have a real solver answer.
 */
export function buildReviewCards(
  data: SolveData,
  opts: {
    solveId: string | null;
    solveName: string;
    source: 'library' | 'job' | 'sample';
    perNode?: number;
  },
): ReviewCard[] {
  const perNode = opts.perNode ?? 2;
  const cards: ReviewCard[] = [];
  for (const node of data.nodesByHistory.values()) {
    if (node.actions.length === 0) continue;
    const combos = liveCombos(node)
      .map((combo) => ({ combo, weight: comboWeight(data, node.player, combo) }))
      .sort((a, b) => b.weight - a.weight || a.combo.localeCompare(b.combo))
      .slice(0, perNode);
    if (combos.length === 0) continue;
    const aggregateFreqs = aggregateFrequencies(data, node);
    const boardCards = nodeBoardCards(data, node);
    for (const { combo } of combos) {
      const heroFreqs = node.strategy[combo];
      if (!heroFreqs) continue;
      const heroCards = parseCombo(combo);
      if (!heroCards) continue;
      const heroEv = comboEv(data, node.player, combo);
      cards.push({
        key: `${opts.solveId ?? opts.source}:${node.history}:${combo}`,
        solveId: opts.solveId,
        solveName: opts.solveName,
        source: opts.source,
        boardCards,
        boardLabel: boardCards.map((c) => c.label).join(' '),
        street: node.streetName,
        player: node.player,
        heroCombo: combo,
        heroCards,
        nodeHistory: node.history,
        pot: node.pot,
        toCall: node.to_call,
        actions: node.actions,
        heroFreqs: [...heroFreqs],
        aggregateFreqs,
        heroEv,
        why: cardWhy(node.actions, heroFreqs, aggregateFreqs, heroEv),
      });
    }
  }
  return cards;
}

/** Fisher–Yates shuffle (returns a new array). */
export function shuffle<T>(items: T[], rng: () => number = Math.random): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i] as T;
    out[i] = out[j] as T;
    out[j] = tmp;
  }
  return out;
}

/** Convenience for pages: parse a board string into cards. */
export function boardCardsOf(board: string): Card[] {
  return parseCardList(board) ?? [];
}
