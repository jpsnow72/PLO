// Solver-wizard model: form state -> engine spot JSON.
//
// Engine spot format (see plo-solve json.rs):
//   board: "As Ks Qs 7d" (turn) or "As Ks Qs 7d 2c" (river)
//   oop_range / ip_range: ["Ts 9s 3c 4c:1.0", ...] (":weight" optional)
//   pot, stacks: numbers
//   river spots: bet_sizes / raise_sizes / max_raises
//   turn spots:  turn_bet_sizes / river_bet_sizes / *_raise_sizes /
//                turn_max_raises / river_max_raises / include_all_in
//   flop spots:  flop_bet_sizes / turn_bet_sizes / river_bet_sizes (+ the
//                matching raise/max-raises keys) and per-street
//                flop_include_all_in / turn_include_all_in /
//                river_include_all_in; solved exactly unless the spot JSON
//                requests bucketing (the wizard never does)
//   both: max_iterations, target_exploitability_pct

import { parseCardList, parseCombo } from './cards';

export interface StreetSizes {
  /** Up to 3 bet sizes, as fractions of pot (0.33 = 33%). */
  betSizes: number[];
  /** Up to 3 raise sizes, as fractions of pot. */
  raiseSizes: number[];
  allIn: boolean;
  maxRaises: number;
}

export type AccuracyTier = 'fast' | 'balanced' | 'precise';

export const TIER_TARGET_PCT: Record<AccuracyTier, number> = {
  fast: 0.5,
  balanced: 0.25,
  precise: 0.1,
};

export const TIER_LABEL: Record<AccuracyTier, string> = {
  fast: 'Fast · 0.5% of pot',
  balanced: 'Balanced · 0.25% of pot',
  precise: 'Precise · 0.1% of pot',
};

export interface WizardForm {
  board: string;
  oopRange: string;
  ipRange: string;
  pot: number;
  stacks: number;
  flop: StreetSizes;
  turn: StreetSizes;
  river: StreetSizes;
  tier: AccuracyTier;
  maxIterations: number;
}

export function emptyStreetSizes(betSizes: number[]): StreetSizes {
  return { betSizes, raiseSizes: [1.0], allIn: true, maxRaises: 2 };
}

export function defaultWizardForm(): WizardForm {
  return {
    board: 'As Ks Qs 7d 2c',
    oopRange: 'Ts 9s 3c 4c, Jd Td 8h 9h, 3d 4d 5c 6c',
    ipRange: '8s 6s 3h 4h, Jh Th 8d 9d, 3s 4s 5d 6d:0.5',
    pot: 100,
    stacks: 100,
    flop: emptyStreetSizes([0.5, 0.75]),
    turn: emptyStreetSizes([0.33, 0.75]),
    river: emptyStreetSizes([0.33, 0.75, 1.0]),
    tier: 'balanced',
    maxIterations: 200000,
  };
}

export interface RangeEntry {
  combo: string;
  weight: number;
}

/**
 * Parse a range textarea: combos separated by commas and/or newlines,
 * each "Ts 9s 3c 4c" with optional ":weight" suffix.
 * Returns entries or a list of human-readable errors.
 */
export function parseRangeText(text: string): { entries: RangeEntry[]; errors: string[] } {
  const entries: RangeEntry[] = [];
  const errors: string[] = [];
  const parts = text
    .split(/[\n,]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  // A combo itself contains spaces, so splitting on commas/newlines only is
  // correct; a bare newline-separated list of card tokens is NOT supported.
  for (const part of parts) {
    const colon = part.lastIndexOf(':');
    let comboText = part;
    let weight = 1;
    if (colon >= 0) {
      const w = Number(part.slice(colon + 1));
      if (!Number.isFinite(w) || w < 0) {
        errors.push(`Bad weight in "${part}"`);
        continue;
      }
      weight = w;
      comboText = part.slice(0, colon).trim();
    }
    const cards = parseCombo(comboText);
    if (!cards) {
      errors.push(`Not a valid 4-card combo: "${part}"`);
      continue;
    }
    entries.push({ combo: cards.map((c) => c.label).join(' '), weight });
  }
  if (entries.length === 0 && errors.length === 0) errors.push('Range is empty');
  return { entries, errors };
}

export interface SpotBuild {
  spot: Record<string, unknown> | null;
  errors: string[];
  street: 'flop' | 'turn' | 'river' | null;
}

/** Validate the form and build the engine spot JSON. */
export function buildSpot(form: WizardForm): SpotBuild {
  const errors: string[] = [];
  const boardCards = parseCardList(form.board);
  if (!boardCards || ![3, 4, 5].includes(boardCards.length)) {
    errors.push('Board must be 3, 4 or 5 valid cards, e.g. "As Ks Qs 7d 2c"');
    return { spot: null, errors, street: null };
  }
  const boardSet = new Set(boardCards.map((c) => c.label));
  if (boardSet.size !== boardCards.length) errors.push('Board has duplicate cards');

  const oop = parseRangeText(form.oopRange);
  const ip = parseRangeText(form.ipRange);
  errors.push(...oop.errors.map((e) => `OOP range: ${e}`));
  errors.push(...ip.errors.map((e) => `IP range: ${e}`));
  for (const entry of [...oop.entries, ...ip.entries]) {
    const cards = parseCombo(entry.combo);
    if (cards && cards.some((c) => boardSet.has(c.label))) {
      errors.push(`Combo ${entry.combo} uses a board card`);
    }
  }
  if (!(form.pot > 0)) errors.push('Pot must be positive');
  if (!(form.stacks > 0)) errors.push('Effective stacks must be positive');
  if (errors.length > 0) return { spot: null, errors, street: null };

  const street: SpotBuild['street'] =
    boardCards.length === 5 ? 'river' : boardCards.length === 4 ? 'turn' : 'flop';

  const base: Record<string, unknown> = {
    board: boardCards.map((c) => c.label).join(' '),
    oop_range: oop.entries.map((e) => `${e.combo}:${e.weight}`),
    ip_range: ip.entries.map((e) => `${e.combo}:${e.weight}`),
    pot: form.pot,
    stacks: form.stacks,
    max_iterations: form.maxIterations,
    target_exploitability_pct: TIER_TARGET_PCT[form.tier],
  };

  if (street === 'river') {
    base.bet_sizes = form.river.betSizes;
    base.raise_sizes = form.river.raiseSizes;
    base.max_raises = form.river.maxRaises;
  } else {
    // Turn and flop parsers read per-street keys.
    base.flop_bet_sizes = form.flop.betSizes;
    base.flop_raise_sizes = form.flop.raiseSizes;
    base.flop_max_raises = form.flop.maxRaises;
    base.turn_bet_sizes = form.turn.betSizes;
    base.turn_raise_sizes = form.turn.raiseSizes;
    base.turn_max_raises = form.turn.maxRaises;
    base.river_bet_sizes = form.river.betSizes;
    base.river_raise_sizes = form.river.raiseSizes;
    base.river_max_raises = form.river.maxRaises;
    // Per-street all-in toggles (the parsers honour these directly); the
    // shared flag stays as a fallback for older spot files.
    base.flop_include_all_in = form.flop.allIn;
    base.turn_include_all_in = form.turn.allIn;
    base.river_include_all_in = form.river.allIn;
    base.include_all_in = form.flop.allIn || form.turn.allIn || form.river.allIn;
  }

  return { spot: base, errors: [], street };
}
