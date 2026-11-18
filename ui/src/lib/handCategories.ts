// Made-hand categories for Omaha combos, in the vocabulary of the
// reference tool's Categories view (f23): Straight Flush, Four of a
// Kind, Full House, Flush, Straight, Set, Two Pair, Pair, No Made
// Hand. A combo's category is its best five-card made hand under
// Omaha rules — exactly two hole cards plus three board cards —
// enumerated over every legal five-card subset. "Set" covers all
// three of a kind (a pocket pair meeting a board card and a board
// pair met by one hole card are the same strength class, and the
// reference vocabulary does not split them). Draws are not
// categories: the Matrix tab's flush-relation filters cover those.

import { RANK_ORDER, type Card } from './cards';

export type HandCategory =
  | 'Straight Flush'
  | 'Four of a Kind'
  | 'Full House'
  | 'Flush'
  | 'Straight'
  | 'Set'
  | 'Two Pair'
  | 'Pair'
  | 'No Made Hand';

/** Categories strongest first — the display order. */
export const HAND_CATEGORIES: HandCategory[] = [
  'Straight Flush',
  'Four of a Kind',
  'Full House',
  'Flush',
  'Straight',
  'Set',
  'Two Pair',
  'Pair',
  'No Made Hand',
];

const LABEL_BY_SCORE: Record<number, HandCategory> = {
  8: 'Straight Flush',
  7: 'Four of a Kind',
  6: 'Full House',
  5: 'Flush',
  4: 'Straight',
  3: 'Set',
  2: 'Two Pair',
  1: 'Pair',
  0: 'No Made Hand',
};

/** Strength score of one five-card hand, 0 (high card) to 8 (straight flush). */
function fiveCardScore(cards: Card[]): number {
  const flush = cards.every((c) => c.suit === cards[0]?.suit);
  const distinct = [...new Set(cards.map((c) => RANK_ORDER[c.rank] ?? 0))].sort((a, b) => b - a);
  let straight = false;
  if (distinct.length === 5) {
    // Ordinary straight, or the wheel A-5-4-3-2 (descending [14,5,4,3,2]:
    // five distinct ranks headed by 14 then 5 can only be the wheel).
    straight =
      (distinct[0] ?? 0) - (distinct[4] ?? 0) === 4 ||
      (distinct[0] === 14 && distinct[1] === 5);
  }
  const counts = new Map<number, number>();
  for (const c of cards) {
    const r = RANK_ORDER[c.rank] ?? 0;
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  const groups = [...counts.values()].sort((a, b) => b - a);
  if (straight && flush) return 8;
  if (groups[0] === 4) return 7;
  if (groups[0] === 3 && groups[1] === 2) return 6;
  if (flush) return 5;
  if (straight) return 4;
  if (groups[0] === 3) return 3;
  if (groups[0] === 2 && groups[1] === 2) return 2;
  if (groups[0] === 2) return 1;
  return 0;
}

/**
 * The made-hand category of a 4-card Omaha combo on a 3–5 card
 * board: the best category over all exactly-two-hole + three-board
 * five-card subsets. Returns 'No Made Hand' for anything unusable
 * (wrong card counts).
 */
export function classifyOmahaHand(hole: Card[], board: Card[]): HandCategory {
  if (hole.length !== 4 || board.length < 3 || board.length > 5) return 'No Made Hand';
  let best = 0;
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      const h1 = hole[i];
      const h2 = hole[j];
      if (!h1 || !h2) continue;
      for (let a = 0; a < board.length; a++) {
        for (let b = a + 1; b < board.length; b++) {
          for (let c = b + 1; c < board.length; c++) {
            const b1 = board[a];
            const b2 = board[b];
            const b3 = board[c];
            if (!b1 || !b2 || !b3) continue;
            const score = fiveCardScore([h1, h2, b1, b2, b3]);
            if (score > best) best = score;
            if (best === 8) return LABEL_BY_SCORE[8] ?? 'Straight Flush';
          }
        }
      }
    }
  }
  return LABEL_BY_SCORE[best] ?? 'No Made Hand';
}
