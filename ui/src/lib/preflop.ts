// Preflop range-set data layer: types + runtime shape guards for the
// documents served by the job service under /api/preflop/*, plus the
// combo mathematics shared by the Preflop Ranges screen and the Solver
// wizard.
//
// A range set maps canonical hand-class keys (a representative combo whose
// suits are labelled by first occurrence, e.g. "As Ah Ks Kh") to per-action
// frequencies. The concrete combos of a class are exactly the distinct
// suit-permutation images of the representative (24 suit permutations,
// each image normalised by sorting its cards rank-descending, then suit in
// s/h/d/c order, deduped). The size of that image set is the class
// multiplicity; summing combo-weighted frequencies over a real set file
// reproduces the set's published totals exactly (verified against the
// generated sets: 270,725 combos, e.g. 49.0% raise for 6-max BTN RFI).
//
// These ranges are CONSTRUCTED (method constructed-equity-v1): built from
// exact card features and seeded Monte Carlo equities against published
// cross-check targets. They are not solver output and must never be
// presented with the certified-GTO styling.

import { RANK_ORDER, type Suit } from './cards';

export type TableSize = '6max' | '9max';
export type SetContext = 'rfi' | 'vs_rfi' | 'three_bet' | 'sb_play';

export interface PreflopSource {
  name: string;
  url?: string;
  licence: string;
  retrieved: string;
}

export interface PreflopProvenance {
  method: string;
  tool?: string;
  tool_version?: string;
  config_version?: string;
  config_hash?: string;
  sources: PreflopSource[];
  derivation?: string;
}

export interface PreflopSetIndexEntry {
  id: string;
  path: string;
  table_size: TableSize;
  position: string;
  context: SetContext;
  stack_bb: number;
  source?: PreflopSource;
  provenance?: {
    method: string;
    config_version?: string;
    config_hash?: string;
  };
}

export interface PreflopIndex {
  schema_version: number;
  rangesets: PreflopSetIndexEntry[];
}

export type HandActions = Record<string, number>;

export interface PreflopSetDoc {
  schema_version: number;
  id: string;
  table_size: TableSize;
  position: string;
  context: SetContext;
  context_detail?: string;
  stack_bb: number;
  rake_note: string;
  notes?: string;
  source?: PreflopSource;
  provenance?: PreflopProvenance;
  hands: Record<string, HandActions>;
}

export interface PreflopClassFeatures {
  pair_kind: string; // none | one_pair | two_pair | trips | quads
  top_pair_rank: number; // 0 when pair_kind is "none", else 2..14
  suitedness: string; // double | four | three | single | rainbow
  rundown_len: number;
  pair_component: number;
  suitedness_component: number;
  connectedness_component: number;
  high_card_component: number;
}

export interface PreflopClass {
  hand: string;
  multiplicity: number;
  equity_vs_random: number;
  equity_vs_reference: number;
  score: number;
  features: PreflopClassFeatures;
}

export interface PreflopClassTable {
  method: string;
  config_version?: string;
  config_hash?: string;
  total_combos: number;
  class_count: number;
  classes: PreflopClass[];
}

// ------------------------------ guards ------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isSource(v: unknown): v is PreflopSource {
  return (
    isRecord(v) &&
    typeof v.name === 'string' &&
    typeof v.licence === 'string' &&
    typeof v.retrieved === 'string' &&
    (v.url === undefined || typeof v.url === 'string')
  );
}

const TABLE_SIZES: readonly string[] = ['6max', '9max'];
const CONTEXTS: readonly string[] = ['rfi', 'vs_rfi', 'three_bet', 'sb_play'];

export function isPreflopIndex(v: unknown): v is PreflopIndex {
  if (!isRecord(v) || !Array.isArray(v.rangesets)) return false;
  return v.rangesets.every(
    (e) =>
      isRecord(e) &&
      typeof e.id === 'string' &&
      typeof e.path === 'string' &&
      TABLE_SIZES.includes(String(e.table_size)) &&
      typeof e.position === 'string' &&
      CONTEXTS.includes(String(e.context)) &&
      isNumber(e.stack_bb),
  );
}

export function isPreflopSetDoc(v: unknown): v is PreflopSetDoc {
  if (!isRecord(v)) return false;
  if (
    typeof v.id !== 'string' ||
    !TABLE_SIZES.includes(String(v.table_size)) ||
    typeof v.position !== 'string' ||
    !CONTEXTS.includes(String(v.context)) ||
    !isNumber(v.stack_bb) ||
    typeof v.rake_note !== 'string' ||
    !isRecord(v.hands)
  ) {
    return false;
  }
  // Every hand maps action names to frequencies in [0, 1].
  for (const actions of Object.values(v.hands)) {
    if (!isRecord(actions)) return false;
    for (const freq of Object.values(actions)) {
      if (!isNumber(freq) || freq < 0 || freq > 1) return false;
    }
  }
  if (v.source !== undefined && !isSource(v.source)) return false;
  if (v.provenance !== undefined) {
    const p = v.provenance;
    if (!isRecord(p) || typeof p.method !== 'string' || !Array.isArray(p.sources)) return false;
    if (!p.sources.every(isSource)) return false;
  }
  return true;
}

export function isPreflopClassTable(v: unknown): v is PreflopClassTable {
  if (!isRecord(v) || !Array.isArray(v.classes) || !isNumber(v.total_combos)) return false;
  return v.classes.every(
    (c) =>
      isRecord(c) &&
      typeof c.hand === 'string' &&
      isNumber(c.multiplicity) &&
      isNumber(c.equity_vs_random) &&
      isNumber(c.equity_vs_reference) &&
      isNumber(c.score) &&
      isRecord(c.features) &&
      typeof c.features.pair_kind === 'string' &&
      typeof c.features.suitedness === 'string' &&
      isNumber(c.features.rundown_len),
  );
}

// --------------------------- combo mathematics ---------------------------

const SUITS: Suit[] = ['s', 'h', 'd', 'c'];

function suitPermutations(): Suit[][] {
  const perms: Suit[][] = [];
  const used = [false, false, false, false];
  const current: Suit[] = [];
  const walk = () => {
    if (current.length === 4) {
      perms.push([...current]);
      return;
    }
    for (let i = 0; i < 4; i += 1) {
      if (used[i]) continue;
      used[i] = true;
      current.push(SUITS[i]);
      walk();
      current.pop();
      used[i] = false;
    }
  };
  walk();
  return perms;
}

const SUIT_PERMS = suitPermutations();

/**
 * All concrete combos of the class named by a canonical representative
 * key, each normalised to rank-descending / suit s,h,d,c card order.
 */
export function classCombos(key: string): string[] {
  const cards = key.split(' ').map((tok) => ({ rank: tok[0], suit: tok[1] as Suit }));
  if (cards.length !== 4 || cards.some((c) => !(c.rank in RANK_ORDER) || !SUITS.includes(c.suit))) {
    return [];
  }
  const seen = new Set<string>();
  for (const perm of SUIT_PERMS) {
    const mapping: Record<Suit, Suit> = { s: perm[0], h: perm[1], d: perm[2], c: perm[3] };
    const mapped = cards.map((c) => ({ rank: c.rank, suit: mapping[c.suit] }));
    mapped.sort(
      (a, b) =>
        (RANK_ORDER[b.rank] ?? 0) - (RANK_ORDER[a.rank] ?? 0) ||
        SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit),
    );
    seen.add(mapped.map((c) => `${c.rank}${c.suit}`).join(' '));
  }
  return [...seen];
}

/** Class multiplicity (concrete combo count) computed from the key alone. */
export function classMultiplicity(key: string): number {
  return classCombos(key).length;
}

/**
 * Multiplicity lookup: prefer the class table's recorded multiplicity,
 * fall back to computing the suit-permutation orbit from the key.
 */
export function multiplicityOf(
  key: string,
  tableByHand: Map<string, PreflopClass> | null,
): number {
  const fromTable = tableByHand?.get(key);
  if (fromTable) return fromTable.multiplicity;
  return classMultiplicity(key);
}

/** Total concrete combos covered by a set document. */
export function setTotalCombos(
  doc: PreflopSetDoc,
  tableByHand: Map<string, PreflopClass> | null,
): number {
  let total = 0;
  for (const key of Object.keys(doc.hands)) total += multiplicityOf(key, tableByHand);
  return total;
}

/**
 * Combo-weighted frequency of each action in a set, as fractions of all
 * combos the set covers (fold included when present in the data).
 */
export function actionTotals(
  doc: PreflopSetDoc,
  tableByHand: Map<string, PreflopClass> | null,
): Record<string, number> {
  const weighted: Record<string, number> = {};
  let total = 0;
  for (const [key, actions] of Object.entries(doc.hands)) {
    const mult = multiplicityOf(key, tableByHand);
    total += mult;
    for (const [action, freq] of Object.entries(actions)) {
      weighted[action] = (weighted[action] ?? 0) + mult * freq;
    }
  }
  if (total === 0) return {};
  const totals: Record<string, number> = {};
  for (const [action, w] of Object.entries(weighted)) totals[action] = w / total;
  return totals;
}

/** Concrete combos whose frequency for `action` is > 0. */
export function combosInAction(
  doc: PreflopSetDoc,
  action: string,
  tableByHand: Map<string, PreflopClass> | null,
): number {
  let count = 0;
  for (const [key, actions] of Object.entries(doc.hands)) {
    if ((actions[action] ?? 0) > 0) count += multiplicityOf(key, tableByHand);
  }
  return count;
}

// ------------------------------ set semantics ------------------------------

/**
 * The action whose frequencies define the continuing range when a set is
 * loaded into a solve (mirrors the API rule): RFI sets -> raise, vs-RFI
 * sets -> call. Null for contexts the API rejects (sb_play, three_bet).
 */
export function solveActionForContext(context: SetContext): string | null {
  if (context === 'rfi') return 'raise';
  if (context === 'vs_rfi') return 'call';
  return null;
}

/** Sets the Solver wizard may load (same rule as the API). */
export function isSolveCompatible(entry: PreflopSetIndexEntry): boolean {
  return solveActionForContext(entry.context) !== null;
}

/** Opener position of a vs_rfi set, parsed from its context_detail. */
export function openerOf(doc: Pick<PreflopSetDoc, 'context_detail'>): string | null {
  if (!doc.context_detail) return null;
  const m = /^vs (\S+) open/.exec(doc.context_detail);
  return m ? m[1] : null;
}

/** Human label for a set, used in pickers and headers. */
export function setLabel(
  entry: Pick<PreflopSetIndexEntry, 'table_size' | 'position' | 'context'> & {
    context_detail?: string;
  },
): string {
  const opener = openerOf(entry);
  switch (entry.context) {
    case 'rfi':
      return `${entry.table_size} · ${entry.position} RFI`;
    case 'sb_play':
      return `${entry.table_size} · ${entry.position} first-in (SB play)`;
    case 'vs_rfi':
      return `${entry.table_size} · ${entry.position} vs ${opener ?? '?'} open`;
    case 'three_bet':
      return `${entry.table_size} · ${entry.position} vs 3-bet`;
    default:
      return `${entry.table_size} · ${entry.position}`;
  }
}

/** Position display order per table size. */
export const POSITION_ORDER: Record<TableSize, string[]> = {
  '6max': ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'],
  '9max': ['UTG', 'UTG+1', 'UTG+2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
};

export function sortPositions(positions: string[], tableSize: TableSize): string[] {
  const order = POSITION_ORDER[tableSize];
  return [...positions].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

// ------------------------------ feature tags ------------------------------

const RANK_BY_VALUE: Record<number, string> = {
  14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T', 9: '9', 8: '8', 7: '7',
  6: '6', 5: '5', 4: '4', 3: '3', 2: '2',
};

export function rankLabel(value: number): string {
  return RANK_BY_VALUE[value] ?? '?';
}

const PAIR_KIND_LABEL: Record<string, string> = {
  none: 'No pair',
  one_pair: 'Pair',
  two_pair: 'Two pair',
  trips: 'Trips',
  quads: 'Quads',
};

const SUITEDNESS_LABEL: Record<string, string> = {
  double: 'Double-suited',
  four: 'Four-flush',
  three: 'Three-flush',
  single: 'Single-suited',
  rainbow: 'Rainbow',
};

/** Display tags for a class's exact features. */
export function featureTags(cls: PreflopClass): string[] {
  const f = cls.features;
  const tags: string[] = [];
  const pairLabel = PAIR_KIND_LABEL[f.pair_kind] ?? f.pair_kind;
  tags.push(
    f.top_pair_rank > 0 ? `${pairLabel} ${rankLabel(f.top_pair_rank)}${rankLabel(f.top_pair_rank)}` : pairLabel,
  );
  tags.push(SUITEDNESS_LABEL[f.suitedness] ?? f.suitedness);
  if (f.rundown_len >= 2) tags.push(`Rundown ${f.rundown_len}`);
  return tags;
}

// --------------------------- pair-rank summary ---------------------------

export interface PairRankBucket {
  key: string;
  label: string;
  /** Combo-weighted frequency of the action, as a fraction of all combos. */
  fraction: number;
  /** Concrete combos in this bucket (any frequency). */
  combos: number;
}

/**
 * Aggregate an action's combo-weighted frequency by pair-rank class:
 * one bucket per paired rank (AAxx … 22xx), an any-pair total, and the
 * no-pair rundowns (pair_kind "none" with a 3+ card rundown chain).
 * Requires class-table features; returns [] without them.
 */
export function pairRankSummary(
  doc: PreflopSetDoc,
  action: string,
  tableByHand: Map<string, PreflopClass>,
  totalCombos: number,
): PairRankBucket[] {
  if (totalCombos === 0) return [];
  const byRank = new Map<number, { weighted: number; combos: number }>();
  let anyPair = { weighted: 0, combos: 0 };
  let rundowns = { weighted: 0, combos: 0 };
  for (const [key, actions] of Object.entries(doc.hands)) {
    const cls = tableByHand.get(key);
    if (!cls) continue;
    const mult = cls.multiplicity;
    const weighted = mult * (actions[action] ?? 0);
    if (cls.features.pair_kind !== 'none' && cls.features.top_pair_rank > 0) {
      const bucket = byRank.get(cls.features.top_pair_rank) ?? { weighted: 0, combos: 0 };
      bucket.weighted += weighted;
      bucket.combos += mult;
      byRank.set(cls.features.top_pair_rank, bucket);
      anyPair.weighted += weighted;
      anyPair.combos += mult;
    } else if (cls.features.pair_kind === 'none' && cls.features.rundown_len >= 3) {
      rundowns.weighted += weighted;
      rundowns.combos += mult;
    }
  }
  const buckets: PairRankBucket[] = [];
  for (let rank = 14; rank >= 2; rank -= 1) {
    const bucket = byRank.get(rank);
    if (!bucket) continue;
    const r = rankLabel(rank);
    buckets.push({
      key: `pair-${rank}`,
      label: `${r}${r}xx`,
      fraction: bucket.weighted / totalCombos,
      combos: bucket.combos,
    });
  }
  buckets.push({
    key: 'any-pair',
    label: 'Any pair',
    fraction: anyPair.weighted / totalCombos,
    combos: anyPair.combos,
  });
  buckets.push({
    key: 'rundowns',
    label: 'No-pair rundowns (3–4 connected)',
    fraction: rundowns.weighted / totalCombos,
    combos: rundowns.combos,
  });
  return buckets;
}
