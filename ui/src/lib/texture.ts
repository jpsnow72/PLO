// Board texture classification, used by the Spot Picker to group solves
// into texture families. Derived from the board string alone.

import { parseCardList, RANK_ORDER } from './cards';

export type TextureFamily = 'flush-heavy' | 'paired' | 'connected' | 'dry';

export const FAMILY_LABEL: Record<TextureFamily, string> = {
  'flush-heavy': 'Flush-heavy / monotone',
  paired: 'Paired boards',
  connected: 'Connected / wet',
  dry: 'Dry / rainbow',
};

export const FAMILY_BLURB: Record<TextureFamily, string> = {
  'flush-heavy':
    'Three or more cards of one suit. Nut advantage dominates; non-nut flushes are traps.',
  paired: 'A pair on board. Full-house combos reshape both ranges; bluffs get cheaper.',
  connected: 'Close ranks with straight potential. Wraps and combo draws everywhere.',
  dry: 'Disconnected, rainbow boards. Equity is stable across runouts; c-bet strategy is cleaner.',
};

export function boardFamilies(board: string): TextureFamily[] {
  const cards = parseCardList(board);
  if (!cards) return ['dry'];
  const families: TextureFamily[] = [];
  const rankCounts = new Map<string, number>();
  const suitCounts = new Map<string, number>();
  for (const c of cards) {
    rankCounts.set(c.rank, (rankCounts.get(c.rank) ?? 0) + 1);
    suitCounts.set(c.suit, (suitCounts.get(c.suit) ?? 0) + 1);
  }
  if ([...rankCounts.values()].some((n) => n >= 2)) families.push('paired');
  if ([...suitCounts.values()].some((n) => n >= 3)) families.push('flush-heavy');
  const distinctRanks = [...rankCounts.keys()]
    .map((r) => RANK_ORDER[r] ?? 0)
    .sort((a, b) => b - a);
  if (
    distinctRanks.length >= 3 &&
    (distinctRanks[0] ?? 0) - (distinctRanks[distinctRanks.length - 1] ?? 0) <= 5
  ) {
    families.push('connected');
  }
  if (families.length === 0) families.push('dry');
  return families;
}
