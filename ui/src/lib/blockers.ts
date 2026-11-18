// Blocker math for the Explorer's Blockers tab (rebrand slice 6,
// issue #18). Everything here is exact card-removal arithmetic over the
// loaded solve — no engine work, no re-solving:
//
//   - The player TO ACT at the current node is the range under study
//     ("villain"): they are the only player with strategy rows at this
//     node, so their action split — and how it shifts when combos are
//     removed — is stored data, not a model.
//   - The other player is "hero": the hand the user picks. Any villain
//     combo containing one of hero's cards is impossible and removed.
//   - Villain's range at the node is liveRange() from solveTree.ts:
//     each combo's reach is its starting weight times the frequencies
//     of the actions it took along the viewed line. Every share in
//     this module is reach-weighted over that live range.
//
// Ranking definition: cards rank by the reach-weighted share of
// villain's live range that holding the single card removes. An
// EV-weighted ranking ("which blocker is worth the most EV") needs
// per-action EVs at the node, which the payload does not carry —
// that is issue #8, and it is deliberately not approximated here.

import { RANKS_DESC, type Card, type Suit } from './cards';
import { liveRange, type SolveData, type SolveNode } from './solveTree';
import type { Player } from './types';

const SUITS: Suit[] = ['s', 'h', 'd', 'c'];

export interface LiveVillainCombo {
  combo: string;
  /** The combo's four card labels. */
  cards: string[];
  /** Reach weight at this node (see liveRange). */
  reach: number;
  /** Villain's action frequencies at this node (node.strategy row). */
  freqs: number[];
}

export interface CardImpact {
  card: Card;
  /** Reach-weighted share of villain's live range this one card removes, 0..1. */
  removedShare: number;
  /** How many of villain's live combos contain this card. */
  removedCombos: number;
  /**
   * Villain's action split (fractions, one per node.actions entry)
   * re-aggregated over the combos that survive holding this card.
   * Null when no combo survives.
   */
  continuingSplit: number[] | null;
}

export interface BlockerModel {
  hero: Player;
  villain: Player;
  /** Villain's live combos at this node, reach > 0. */
  live: LiveVillainCombo[];
  /** Total reach of villain's live range. */
  totalReach: number;
  /** Villain's action split over the whole live range (reach-weighted). */
  splitBefore: number[];
  /**
   * Every card not on the board, ranked by removedShare descending
   * (ties broken by combos removed, then card label). Board cards are
   * excluded: they are already dead for every combo in the range.
   */
  impacts: CardImpact[];
  /** The largest removedShare in `impacts` (heatmap scale), 0 when empty. */
  maxShare: number;
}

export function buildBlockerModel(
  data: SolveData,
  path: { nodeHistory: string }[],
  node: SolveNode,
  boardCards: Card[],
): BlockerModel {
  const villain = node.player;
  const hero: Player = villain === 'OOP' ? 'IP' : 'OOP';
  const actionCount = node.actions.length;

  const live: LiveVillainCombo[] = liveRange(data, path, villain).map((c) => ({
    combo: c.combo,
    cards: c.combo.split(' '),
    reach: c.reach,
    freqs: node.strategy[c.combo] ?? [],
  }));
  const totalReach = live.reduce((a, c) => a + c.reach, 0);

  // Reach-weighted action totals over the whole live range, plus the
  // same totals restricted to the combos each single card removes.
  // One pass: each combo contributes to its four cards.
  const splitWeighted = new Array<number>(actionCount).fill(0);
  const removedReach = new Map<string, number>();
  const removedCombos = new Map<string, number>();
  const removedSplit = new Map<string, number[]>();
  for (const c of live) {
    c.freqs.forEach((f, i) => {
      splitWeighted[i] = (splitWeighted[i] ?? 0) + c.reach * f;
    });
    for (const label of c.cards) {
      removedReach.set(label, (removedReach.get(label) ?? 0) + c.reach);
      removedCombos.set(label, (removedCombos.get(label) ?? 0) + 1);
      const rs = removedSplit.get(label) ?? new Array<number>(actionCount).fill(0);
      c.freqs.forEach((f, i) => {
        rs[i] = (rs[i] ?? 0) + c.reach * f;
      });
      removedSplit.set(label, rs);
    }
  }

  const splitBefore =
    totalReach === 0
      ? new Array<number>(actionCount).fill(0)
      : splitWeighted.map((t) => t / totalReach);

  const board = new Set(boardCards.map((c) => c.label));
  const impacts: CardImpact[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS_DESC) {
      const card: Card = { rank, suit, label: `${rank}${suit}` };
      if (board.has(card.label)) continue;
      const rr = removedReach.get(card.label) ?? 0;
      const rs = removedSplit.get(card.label);
      const surviveReach = totalReach - rr;
      impacts.push({
        card,
        removedShare: totalReach === 0 ? 0 : rr / totalReach,
        removedCombos: removedCombos.get(card.label) ?? 0,
        continuingSplit:
          surviveReach <= 0
            ? null
            : splitWeighted.map((t, i) => (t - (rs?.[i] ?? 0)) / surviveReach),
      });
    }
  }
  impacts.sort(
    (a, b) =>
      b.removedShare - a.removedShare ||
      b.removedCombos - a.removedCombos ||
      a.card.label.localeCompare(b.card.label),
  );

  return {
    hero,
    villain,
    live,
    totalReach,
    splitBefore,
    impacts,
    maxShare: impacts[0]?.removedShare ?? 0,
  };
}

export interface HandRemoval {
  /** Union removal: combos containing ANY of hero's picked cards. */
  removedShare: number;
  removedCombos: number;
  survivingCombos: number;
  /** Share of villain's live reach that survives, 0..1. */
  survivingShare: number;
  /**
   * Villain's action split over the surviving combos (reach-weighted).
   * Null when no combo survives.
   */
  splitAfter: number[] | null;
  /**
   * Solo effect of each picked card (the same numbers as its ranked
   * list row). Per-card figures overlap — a combo holding two of
   * hero's cards counts under each — while the totals above are the
   * union. Board cards in the hand are impossible (the picker and the
   * heatmap both exclude them) but would simply remove nothing extra:
   * every live combo is already board-free.
   */
  perCard: CardImpact[];
}

/** Removal effect of hero's whole picked hand (1–4 cards). */
export function analyseHand(model: BlockerModel, heroLabels: string[]): HandRemoval {
  const held = new Set(heroLabels);
  const actionCount = model.splitBefore.length;
  let removedReachTotal = 0;
  let removedCount = 0;
  const surviveSplitWeighted = new Array<number>(actionCount).fill(0);
  for (const c of model.live) {
    if (c.cards.some((label) => held.has(label))) {
      removedReachTotal += c.reach;
      removedCount += 1;
    } else {
      c.freqs.forEach((f, i) => {
        surviveSplitWeighted[i] = (surviveSplitWeighted[i] ?? 0) + c.reach * f;
      });
    }
  }
  const surviveReach = model.totalReach - removedReachTotal;
  const byLabel = new Map(model.impacts.map((im) => [im.card.label, im]));
  return {
    removedShare: model.totalReach === 0 ? 0 : removedReachTotal / model.totalReach,
    removedCombos: removedCount,
    survivingCombos: model.live.length - removedCount,
    survivingShare: model.totalReach === 0 ? 0 : surviveReach / model.totalReach,
    splitAfter:
      surviveReach <= 0 ? null : surviveSplitWeighted.map((t) => t / surviveReach),
    perCard: heroLabels
      .map((label) => byLabel.get(label))
      .filter((im): im is CardImpact => im !== undefined),
  };
}
