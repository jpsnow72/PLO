// Starting Hands study core: everything the drill needs from the
// preflop range-set documents — set selection (table size, rake
// variant, spot, position, opener), the drill-card pool, grading, and
// the seeded starter heuristics.
//
// DATA HONESTY (same rules as the rest of the study layer):
//  - Every number comes from the loaded set document and the class
//    table: per-class action frequencies, combo multiplicities, set
//    totals. Nothing is derived from solver output — these are
//    CONSTRUCTED ranges (see lib/preflop.ts) and are labelled as such
//    everywhere they appear.
//  - Grading is frequency match, exactly like the Quiz trainer's
//    frequency mode: the score is the frequency with which the
//    constructed range itself takes the picked action with this hand
//    class. There is no EV behind a preflop grade and none is claimed.
//  - A class whose canonical key does not parse into four distinct
//    cards is excluded from the pool rather than rendered with
//    invented cards.
//  - Seeded heuristics are generated from the set's own totals at
//    runtime — the percentages in their text are the set's numbers,
//    never hand-written constants.

import { parseCombo, type Card } from './cards';
import {
  actionTotals,
  multiplicityOf,
  openerOf,
  pairRankSummary,
  POSITION_ORDER,
  type PreflopClass,
  type PreflopIndex,
  type PreflopSetDoc,
  type PreflopSetIndexEntry,
  type TableSize,
} from './preflop';
import { bandForScore, type GradeResult, type QuizTopic } from './quiz';
import type { Heuristic } from './study';

// ------------------------------ set selection ------------------------------

export type RakeVariant = 'raked' | 'no-rake' | 'unknown';

export const RAKE_VARIANTS: RakeVariant[] = ['raked', 'no-rake', 'unknown'];

export const VARIANT_LABEL: Record<RakeVariant, string> = {
  raked: 'Raked',
  'no-rake': 'No-rake',
  unknown: 'Rake not stated',
};

/**
 * Normalise a free-text rake description. "No rake" patterns are
 * checked before bare "rake" so "no rake modelled" never reads as
 * raked.
 */
function variantFromText(text: string): RakeVariant | null {
  const t = text.toLowerCase();
  if (/no[-_ ]?rake|rake[-_ ]?free|unraked/.test(t)) return 'no-rake';
  if (/raked|rake/.test(t)) return 'raked';
  return null;
}

/**
 * The rake variant of a set. Preference order: an explicit `rake`
 * field on the index entry (the data layer's field, read defensively
 * — lib/preflop.ts does not declare it yet), then a `rake` field on
 * the set document, then the document's free-text `rake_note`. The v1
 * documents state "no rake modelled in construction", so until the
 * data carries an explicit field they classify as no-rake — which is
 * what their construction actually assumed.
 */
export function variantOfSet(
  entry: PreflopSetIndexEntry,
  doc?: PreflopSetDoc | null,
): RakeVariant {
  const entryRake = (entry as unknown as Record<string, unknown>).rake;
  if (typeof entryRake === 'string') {
    const v = variantFromText(entryRake);
    if (v) return v;
  }
  if (doc) {
    const docRake = (doc as unknown as Record<string, unknown>).rake;
    if (typeof docRake === 'string') {
      const v = variantFromText(docRake);
      if (v) return v;
    }
    const fromNote = variantFromText(doc.rake_note);
    if (fromNote) return fromNote;
  }
  return 'unknown';
}

export type SpotKind = 'first-in' | 'defense';

export const SPOT_LABEL: Record<SpotKind, string> = {
  'first-in': 'First-in',
  defense: 'vs open (defense)',
};

/** Which set contexts belong to each drill spot type. */
export function spotKindOf(entry: Pick<PreflopSetIndexEntry, 'context'>): SpotKind | null {
  if (entry.context === 'rfi' || entry.context === 'sb_play') return 'first-in';
  if (entry.context === 'vs_rfi') return 'defense';
  return null; // vs_three_bet continuations are not a starting-hands spot
}

const OPENER_TOKEN: Record<string, string> = {
  utg: 'UTG',
  utgplus1: 'UTG+1',
  utgplus2: 'UTG+2',
  mp: 'MP',
  lj: 'LJ',
  hj: 'HJ',
  co: 'CO',
  btn: 'BTN',
  sb: 'SB',
  bb: 'BB',
};

/**
 * Opener position for a defense set, parsed from the generated set id
 * ("constructed-v1-6max-bb-vs-btn" -> "BTN"). Used ONLY to label the
 * setup picker — once a set is loaded, the session displays the
 * document's own context_detail (openerOf) as the authority. Returns
 * null when the id does not follow the convention.
 */
export function openerFromSetId(id: string): string | null {
  const tokens = id.toLowerCase().split('-');
  const vs = tokens.indexOf('vs');
  if (vs === -1 || vs + 1 >= tokens.length) return null;
  return OPENER_TOKEN[tokens[vs + 1] ?? ''] ?? null;
}

export interface StudySetOption {
  entry: PreflopSetIndexEntry;
  variant: RakeVariant;
  spot: SpotKind;
  /** Opener label for defense sets (id-derived until the doc loads). */
  opener: string | null;
}

/** Every index entry usable by the drill, with its selection facets. */
export function studySetOptions(index: PreflopIndex): StudySetOption[] {
  const out: StudySetOption[] = [];
  for (const entry of index.rangesets) {
    const spot = spotKindOf(entry);
    if (!spot) continue;
    out.push({
      entry,
      variant: variantOfSet(entry),
      spot,
      opener: spot === 'defense' ? openerFromSetId(entry.id) : null,
    });
  }
  return out;
}

// ------------------------------ actions ------------------------------

export const ACTION_ORDER = ['fold', 'call', 'raise', 'three_bet'];

export const PREFLOP_ACTION_LABEL: Record<string, string> = {
  fold: 'Fold',
  call: 'Call',
  raise: 'Raise',
  three_bet: '3-bet',
};

export const PREFLOP_ACTION_COLOR: Record<string, string> = {
  raise: '#f5a623',
  three_bet: '#d96c4f',
  call: '#2aa198',
  fold: '#8a4b57',
};

export function preflopActionLabel(action: string): string {
  return PREFLOP_ACTION_LABEL[action] ?? action.replace(/_/g, ' ');
}

export function preflopActionColor(action: string): string {
  return PREFLOP_ACTION_COLOR[action] ?? '#7a8aa0';
}

/** The set's action menu: every action any class in the set can take. */
export function actionMenu(doc: PreflopSetDoc): string[] {
  const present = new Set<string>();
  for (const actions of Object.values(doc.hands)) {
    for (const action of Object.keys(actions)) present.add(action);
  }
  const ordered = ACTION_ORDER.filter((a) => present.has(a));
  const extras = [...present].filter((a) => !ACTION_ORDER.includes(a)).sort();
  return [...ordered, ...extras];
}

// ------------------------------ drill cards ------------------------------

export interface PreflopDrillCard {
  /** SRS item key: "preflop|<set id>|<class key>". */
  itemKey: string;
  classKey: string;
  /** The class's representative combo (the canonical key IS one). */
  heroCards: Card[];
  /** The set's action menu, aligned with `frequencies`. */
  actions: string[];
  frequencies: number[];
  multiplicity: number;
  cls: PreflopClass | null;
}

/**
 * The draw pool for one set: every class whose key parses into four
 * distinct cards. Classes without a renderable representative combo
 * are skipped — never rendered from invented cards.
 */
export function buildDrillPool(
  doc: PreflopSetDoc,
  tableByHand: Map<string, PreflopClass> | null,
): PreflopDrillCard[] {
  const menu = actionMenu(doc);
  const pool: PreflopDrillCard[] = [];
  for (const [key, actions] of Object.entries(doc.hands)) {
    const cards = parseCombo(key);
    if (!cards) continue;
    pool.push({
      itemKey: `preflop|${doc.id}|${key}`,
      classKey: key,
      heroCards: cards,
      actions: menu,
      frequencies: menu.map((a) => actions[a] ?? 0),
      multiplicity: multiplicityOf(key, tableByHand),
      cls: tableByHand?.get(key) ?? null,
    });
  }
  return pool;
}

/** Weighted sample without replacement (weight = class multiplicity). */
export function drawWeighted(
  pool: PreflopDrillCard[],
  count: number,
  excludeKeys: Set<string>,
  rng: () => number = Math.random,
): PreflopDrillCard[] {
  const remaining = pool.filter((c) => !excludeKeys.has(c.itemKey));
  const picked: PreflopDrillCard[] = [];
  while (picked.length < count && remaining.length > 0) {
    let total = 0;
    for (const c of remaining) total += c.multiplicity;
    if (total <= 0) break;
    let roll = rng() * total;
    let idx = 0;
    for (let i = 0; i < remaining.length; i += 1) {
      roll -= remaining[i]?.multiplicity ?? 0;
      if (roll <= 0) {
        idx = i;
        break;
      }
    }
    const [card] = remaining.splice(idx, 1);
    if (card) picked.push(card);
  }
  return picked;
}

// ------------------------------ grading ------------------------------

/**
 * Grade a drill answer by frequency match against the constructed
 * range: the score is the frequency with which this range takes the
 * picked action with this exact hand class. The detail copy names the
 * mode and the data for what it is — a constructed range, not solver
 * output — mirroring the Quiz trainer's honesty copy.
 */
export function gradePreflopAnswer(card: PreflopDrillCard, chosenIdx: number): GradeResult {
  const chosenFreq = card.frequencies[chosenIdx] ?? 0;
  let bestIdx = 0;
  card.frequencies.forEach((f, i) => {
    if (f > (card.frequencies[bestIdx] ?? 0)) bestIdx = i;
  });
  const score = Math.min(1, Math.max(0, chosenFreq));
  const band = bandForScore(score);
  const chosenLabel = preflopActionLabel(card.actions[chosenIdx] ?? '');
  const bestLabel = preflopActionLabel(card.actions[bestIdx] ?? '');
  return {
    grading: 'frequency',
    score,
    band,
    headline:
      band === 'solid'
        ? `${chosenLabel} matches this range's main line for this hand`
        : band === 'partial'
          ? `${chosenLabel} is part of this range's mix — its main line is ${bestLabel}`
          : `This range rarely takes ${chosenLabel} with this hand — its main line is ${bestLabel}`,
    detail:
      'Graded by frequency match against a constructed range: your score is how often this ' +
      'range takes your pick with this exact hand class. These ranges are built from hand ' +
      'features and equities (constructed, not solver output), so no EV-loss figure exists ' +
      'or is shown.',
    evLostChips: null,
    bestActionIdx: bestIdx,
  };
}

// ------------------------------ topics / progress ------------------------------

/**
 * Quiz-store topic for a preflop position + spot. The store's topics
 * are free-form ("<texture>|<street>|<spot_type>"), so per-position
 * accuracy persists across devices under texture "preflop".
 */
export function preflopTopic(position: string, spot: SpotKind): QuizTopic {
  return {
    texture: 'preflop',
    street: position,
    spot_type: spot === 'first-in' ? 'first-in' : 'vs-open',
  };
}

export function preflopTopicKey(position: string, spot: SpotKind): string {
  const t = preflopTopic(position, spot);
  return `${t.texture}|${t.street}|${t.spot_type}`;
}

// ------------------------------ seeded heuristics ------------------------------

export interface SeededHeuristic {
  id: string;
  title: string;
  text: string;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

function guidanceFor(share: number, kind: 'open' | 'continue'): string {
  if (share >= 0.45) {
    return kind === 'open'
      ? 'That is wide — position is doing the work, so the bottom of the range leans on double-suited and rundown shapes rather than raw high cards.'
      : 'That is a wide defence — the blind is priced in, so well-connected and double-suited hands continue even without a pair.';
  }
  if (share >= 0.25) {
    return kind === 'open'
      ? 'A solid middle — premium pairs and well-connected double-suited hands do most of the opening; weak single-suited and offsuit rundowns mostly fold.'
      : 'A solid middle — continuing is concentrated in pairs, double-suited hands and strong rundowns; the weakest offsuit hands fold.';
  }
  return kind === 'open'
    ? 'That is tight — opening is concentrated in pairs and the best double-suited rundowns; marginal hands wait for a better seat.'
    : 'That is a tight defence — continuing is concentrated in pairs and the best double-suited rundowns; most unpaired hands fold.';
}

/**
 * Starter heuristic cards for one set, generated from the set's own
 * combo-weighted totals (and class-table feature aggregates when the
 * table is loaded). They are study aids derived from this data —
 * badged as seeded starters in the UI, and only enter Justin's
 * personal log if he saves them there himself.
 */
export function seededHeuristics(
  doc: PreflopSetDoc,
  tableByHand: Map<string, PreflopClass> | null,
  totalCombos: number,
): SeededHeuristic[] {
  const totals = actionTotals(doc, tableByHand);
  const spot = spotKindOf(doc);
  const opener = openerOf(doc);
  const where =
    spot === 'defense'
      ? `${doc.position} facing a ${opener ?? 'an'} open`
      : doc.context === 'sb_play'
        ? `${doc.position} first-in (SB play)`
        : `${doc.position} first-in`;
  const title = `${doc.table_size} · ${where}`;
  const cards: SeededHeuristic[] = [];

  if (spot === 'defense') {
    const fold = totals.fold ?? 0;
    const call = totals.call ?? 0;
    const threeBet = totals.three_bet ?? 0;
    const cont = call + threeBet;
    cards.push({
      id: `seeded|${doc.id}|shape`,
      title,
      text:
        `${where}: this constructed range folds ${pct(fold)}, calls ${pct(call)} and 3-bets ${pct(threeBet)} ` +
        `of all combos. ${guidanceFor(cont, 'continue')}`,
    });
  } else {
    const raise = totals.raise ?? 0;
    cards.push({
      id: `seeded|${doc.id}|shape`,
      title,
      text:
        `${where}: this constructed range raises ${pct(raise)} of all combos and folds the rest. ` +
        `${guidanceFor(raise, 'open')}`,
    });
  }

  // Feature card: how pairs vs no-pair rundowns take the set's main
  // continuing action. Needs the class table (features + totals).
  if (tableByHand && totalCombos > 0) {
    const primary =
      spot === 'defense' ? ((totals.call ?? 0) >= (totals.three_bet ?? 0) ? 'call' : 'three_bet') : 'raise';
    const verb = primary === 'three_bet' ? '3-bet' : primary;
    const buckets = pairRankSummary(doc, primary, tableByHand, totalCombos);
    const anyPair = buckets.find((b) => b.key === 'any-pair');
    const rundowns = buckets.find((b) => b.key === 'rundowns');
    const parts: string[] = [];
    if (anyPair && anyPair.combos > 0) {
      const within = (anyPair.fraction * totalCombos) / anyPair.combos;
      parts.push(
        `pairs are ${pct(anyPair.combos / totalCombos)} of all combos and ${verb} at ${pct(within)} within the group`,
      );
    }
    if (rundowns && rundowns.combos > 0) {
      const within = (rundowns.fraction * totalCombos) / rundowns.combos;
      parts.push(
        `no-pair rundowns (3–4 connected) are ${pct(rundowns.combos / totalCombos)} of combos and ${verb} at ${pct(within)}`,
      );
    }
    if (parts.length > 0) {
      cards.push({
        id: `seeded|${doc.id}|features`,
        title: `${title} — what continues`,
        text: `In this range, ${parts.join('; ')}.`,
      });
    }
  }

  return cards;
}

// ------------------------------ personal heuristics ------------------------------

const ALL_POSITIONS: string[] = [
  ...POSITION_ORDER['9max'],
  ...POSITION_ORDER['6max'],
];

/** Is this log entry about preflop starting hands at all? */
export function isStartingHandsHeuristic(h: Heuristic): boolean {
  const blob = [h.tags.texture ?? '', h.tags.street ?? '', h.tags.spot_type ?? '']
    .join(' ')
    .toLowerCase();
  return blob.includes('preflop') || blob.includes('starting-hand');
}

/**
 * Justin's own starting-hands heuristics that fit the current spot:
 * position-specific matches first, then spot-type matches, then
 * general starting-hands rules. Retired entries never surface.
 */
export function personalForSpot(
  heuristics: Heuristic[],
  position: string,
  spot: SpotKind,
): Heuristic[] {
  const scored: { h: Heuristic; score: number }[] = [];
  for (const h of heuristics) {
    if (h.status !== 'active') continue;
    if (!isStartingHandsHeuristic(h)) continue;
    const blob = [h.tags.texture ?? '', h.tags.street ?? '', h.tags.spot_type ?? '']
      .join(' ')
      .toLowerCase();
    // Position matching is token-based: substring matching would let
    // "co" or "sb" false-positive inside unrelated tag words.
    const tokens = blob.split(/[^a-z0-9+]+/).filter((t) => t.length > 0);
    let score = 0;
    if (tokens.includes(position.toLowerCase())) score += 2;
    else if (ALL_POSITIONS.some((p) => p !== position && tokens.includes(p.toLowerCase()))) {
      continue; // tagged for a different specific position
    }
    if (
      (spot === 'first-in' && (blob.includes('first-in') || blob.includes('rfi'))) ||
      (spot === 'defense' && (blob.includes('defense') || blob.includes('defence') || blob.includes('vs')))
    ) {
      score += 1;
    }
    scored.push({ h, score });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.h);
}

/** Tags the "Save to my heuristics" action writes for a seeded card. */
export function saveTagsFor(position: string, spot: SpotKind): Heuristic['tags'] {
  return {
    texture: 'preflop',
    street: 'preflop',
    spot_type: `starting-hands ${position} ${spot === 'first-in' ? 'first-in' : 'vs-open'}`,
  };
}

export type { TableSize };
