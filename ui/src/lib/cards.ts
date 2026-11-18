// Card primitives. Engine card strings look like "As", "Td", "9c".
// Combos are space-separated: "Ts 9s 3c 4c". Boards likewise: "As Ks Qs 7d 2c".

export type Suit = 's' | 'h' | 'd' | 'c';

export interface Card {
  rank: string; // 'A' | 'K' | ... | '2'
  suit: Suit;
  label: string; // original two-char label, e.g. "As"
}

export const RANK_ORDER: Record<string, number> = {
  A: 14,
  K: 13,
  Q: 12,
  J: 11,
  T: 10,
  '9': 9,
  '8': 8,
  '7': 7,
  '6': 6,
  '5': 5,
  '4': 4,
  '3': 3,
  '2': 2,
};

export const RANKS_DESC = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

export const SUIT_SYMBOL: Record<Suit, string> = {
  s: '♠',
  h: '♥',
  d: '♦',
  c: '♣',
};

export const SUIT_NAME: Record<Suit, string> = {
  s: 'spades',
  h: 'hearts',
  d: 'diamonds',
  c: 'clubs',
};

export const RANK_NAME: Record<string, string> = {
  A: 'Ace',
  K: 'King',
  Q: 'Queen',
  J: 'Jack',
  T: 'Ten',
  '9': 'Nine',
  '8': 'Eight',
  '7': 'Seven',
  '6': 'Six',
  '5': 'Five',
  '4': 'Four',
  '3': 'Three',
  '2': 'Two',
};

/** Full spoken name of a card, e.g. "Ace of spades" — for aria labels/titles. */
export function cardName(card: Card): string {
  return `${RANK_NAME[card.rank] ?? card.rank} of ${SUIT_NAME[card.suit]}`;
}

const VALID_RANKS = new Set(Object.keys(RANK_ORDER));
const VALID_SUITS = new Set<string>(['s', 'h', 'd', 'c']);

export function parseCard(token: string): Card | null {
  const t = token.trim();
  if (t.length !== 2) return null;
  const rank = t[0].toUpperCase();
  const suit = t[1].toLowerCase();
  if (!VALID_RANKS.has(rank) || !VALID_SUITS.has(suit)) return null;
  return { rank, suit: suit as Suit, label: `${rank}${suit}` };
}

/** Parse a space/comma separated card list ("As Ks Qs" or "As, Ks"). Returns null on any bad token. */
export function parseCardList(text: string): Card[] | null {
  const tokens = text
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const cards: Card[] = [];
  for (const tok of tokens) {
    const c = parseCard(tok);
    if (!c) return null;
    cards.push(c);
  }
  return cards;
}

/** Parse a 4-card combo string like "Ts 9s 3c 4c". Returns null if invalid. */
export function parseCombo(text: string): Card[] | null {
  const cards = parseCardList(text);
  if (!cards || cards.length !== 4) return null;
  const seen = new Set(cards.map((c) => c.label));
  if (seen.size !== 4) return null;
  return cards;
}

export function formatCards(cards: Card[]): string {
  return cards.map((c) => c.label).join(' ');
}

/**
 * Canonical class key for the range grid: the combo's two highest ranks.
 * e.g. "Ts 9s 3c 4c" -> "T9", "As Ah Kd Qc" -> "AA".
 * This is the grouping used by the 13x13-style grid.
 */
export function canonicalClass(combo: string): string {
  const cards = parseCombo(combo);
  if (!cards) return '??';
  const ranks = cards
    .map((c) => c.rank)
    .sort((a, b) => (RANK_ORDER[b] ?? 0) - (RANK_ORDER[a] ?? 0));
  return `${ranks[0]}${ranks[1]}`;
}

/** Canonical class label for a grid cell (hi rank, lo rank). */
export function classLabel(hi: string, lo: string): string {
  return `${hi}${lo}`;
}

/**
 * Suitedness shape of a 4-card combo, in the same vocabulary as the
 * preflop class table's `features.suitedness` (see SUITEDNESS_FILTERS
 * in lib/preflop.ts): [2,2] double, [2,1,1] single, [3,1] three,
 * [4] four (monotone), [1,1,1,1] rainbow. Computed from the combo's
 * own cards only — exact, no payload support needed.
 */
export type SuitednessShape = 'double' | 'single' | 'three' | 'four' | 'rainbow';

export function comboSuitedness(cards: Card[]): SuitednessShape {
  const counts = new Map<Suit, number>();
  for (const c of cards) counts.set(c.suit, (counts.get(c.suit) ?? 0) + 1);
  const shape = [...counts.values()].sort((a, b) => b - a);
  if (shape.length === 1) return 'four';
  if (shape.length === 4) return 'rainbow';
  if (shape[0] === 3) return 'three';
  if (shape[0] === 2 && shape[1] === 2) return 'double';
  return 'single';
}

export type FlushRelation = 'flush' | 'draw' | 'none';

/**
 * A combo's flush relation to a board, under Omaha rules (a flush
 * uses exactly two hole cards and three board cards):
 *  - 'flush': some suit has >= 3 board cards and >= 2 hole cards.
 *  - 'draw': not a flush, but some suit has >= 2 board cards and
 *    >= 2 hole cards (four to a flush with a card to come).
 *  - 'none': neither. On a board with at most one card per suit no
 *    combo can be better than 'none'.
 */
export function flushRelation(cards: Card[], board: Card[]): FlushRelation {
  const suits: Suit[] = ['s', 'h', 'd', 'c'];
  let draw = false;
  for (const suit of suits) {
    const onBoard = board.filter((c) => c.suit === suit).length;
    const inHand = cards.filter((c) => c.suit === suit).length;
    if (onBoard >= 3 && inHand >= 2) return 'flush';
    if (onBoard >= 2 && inHand >= 2) draw = true;
  }
  return draw ? 'draw' : 'none';
}

/**
 * The sub-matrix key of a combo inside its canonical class: the two
 * lowest ranks, high first — the "remaining cards" once the class's
 * top two ranks are fixed. e.g. "As Ah Kd Qc" (class AA) -> "KQ".
 * Returns null for an unparseable combo.
 */
export function remainingClass(combo: string): string | null {
  const cards = parseCombo(combo);
  if (!cards) return null;
  const ranks = cards
    .map((c) => c.rank)
    .sort((a, b) => (RANK_ORDER[b] ?? 0) - (RANK_ORDER[a] ?? 0));
  return `${ranks[2]}${ranks[3]}`;
}
