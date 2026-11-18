// Solver-wizard model: form state -> engine spot JSON.
//
// Engine spot format (see plo-solve json.rs):
//   board: "As Ks Qs 7d" (turn) or "As Ks Qs 7d 2c" (river)
//   oop_range / ip_range: ["Ts 9s 3c 4c:1.0", ...] (":weight" optional)
//   ...or oop_range_set / ip_range_set: a preflop set id the API expands
//   server-side (RFI sets -> raise range, vs-RFI sets -> call range)
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
//   optional: locks (engine + API accept them; the wizard does not emit
//   them — the visual lock editor is issue #9, see SOLVER-PARITY-NOTES.md)

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
  /**
   * Preflop range-set loading: when a side carries a set id, the side is
   * in "set mode" — buildSpot emits `<side>_range_set` and the API expands
   * the set server-side; the manual textarea text is kept but ignored.
   */
  oopRangeSet: string | null;
  ipRangeSet: string | null;
  pot: number;
  stacks: number;
  flop: StreetSizes;
  turn: StreetSizes;
  river: StreetSizes;
  tier: AccuracyTier;
  /**
   * Custom accuracy target (% of pot), or null to use the tier preset
   * (TIER_TARGET_PCT[tier]). Emitted as target_exploitability_pct either
   * way — the engine contract takes the number, not the tier name.
   */
  targetPctOverride: number | null;
  maxIterations: number;
}

/** The target a form will actually emit: the override when set, else the tier preset. */
export function targetPctFor(form: WizardForm): number {
  return form.targetPctOverride ?? TIER_TARGET_PCT[form.tier];
}

export function emptyStreetSizes(betSizes: number[]): StreetSizes {
  return { betSizes, raiseSizes: [1.0], allIn: true, maxRaises: 2 };
}

export function defaultWizardForm(): WizardForm {
  return {
    board: 'As Ks Qs 7d 2c',
    oopRange: 'Ts 9s 3c 4c, Jd Td 8h 9h, 3d 4d 5c 6c',
    ipRange: '8s 6s 3h 4h, Jh Th 8d 9d, 3s 4s 5d 6d:0.5',
    oopRangeSet: null,
    ipRangeSet: null,
    pot: 100,
    stacks: 100,
    // Default bet menus per street (approved 2026-11-17, gauged from GTO
    // Wizard's solved trees): flop 33%/75%, turn 50%/100%, river 50%/100%.
    // All-in is the separate `allIn` toggle in emptyStreetSizes (default
    // on) at every street; raises default to pot (1.0), max 2 raises.
    flop: emptyStreetSizes([0.33, 0.75]),
    turn: emptyStreetSizes([0.5, 1.0]),
    river: emptyStreetSizes([0.5, 1.0]),
    tier: 'balanced',
    targetPctOverride: null,
    maxIterations: 200000,
  };
}

export interface RangeEntry {
  combo: string;
  weight: number;
}

/** "AsKsQsTh" -> "As Ks Qs Th" (only for a bare 8-char compact combo). */
function compactToSpaced(text: string): string {
  if (!text.includes(' ') && text.length === 8) {
    return (text.match(/.{2}/g) ?? []).join(' ');
  }
  return text;
}

/**
 * Parse a range textarea: combos separated by commas and/or newlines.
 * Three entry shapes are accepted, freely mixed:
 *   - "Ts 9s 3c 4c" with optional ":weight" suffix (weight is a plain
 *     number, e.g. ":0.5");
 *   - PPT format "AsKsQsTh@100" — a compact (or spaced) combo plus "@"
 *     and a weight PERCENT in [0, 100], converted to weight/100.
 * Every malformed entry produces a human-readable error — entries are
 * never silently dropped. Returns entries plus the error list.
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
    // PPT format: "<combo>@<percent>".
    const at = part.lastIndexOf('@');
    if (at >= 0) {
      const pct = Number(part.slice(at + 1));
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        errors.push(`Bad PPT weight in "${part}" (@ must be a percent 0-100)`);
        continue;
      }
      const cards = parseCombo(compactToSpaced(part.slice(0, at).trim()));
      if (!cards) {
        errors.push(`Not a valid 4-card combo: "${part}"`);
        continue;
      }
      entries.push({ combo: cards.map((c) => c.label).join(' '), weight: pct / 100 });
      continue;
    }
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

  // A side in set mode skips manual parsing entirely: the API expands the
  // named preflop set server-side (and validates board conflicts itself
  // through the engine's card removal).
  const emptyRange: { entries: RangeEntry[]; errors: string[] } = { entries: [], errors: [] };
  const oop = form.oopRangeSet ? emptyRange : parseRangeText(form.oopRange);
  const ip = form.ipRangeSet ? emptyRange : parseRangeText(form.ipRange);
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
  // Accuracy fields are emitted verbatim (max_iterations /
  // target_exploitability_pct), so they are validated here like every
  // other field — a NaN or a non-positive cap must never reach the API.
  if (!Number.isInteger(form.maxIterations) || form.maxIterations <= 0) {
    errors.push('Max iterations must be a positive whole number');
  }
  if (form.targetPctOverride !== null) {
    const t = form.targetPctOverride;
    if (!Number.isFinite(t) || t <= 0 || t > 5) {
      errors.push('Custom target must be a Nash distance between 0 and 5% of pot');
    }
  }
  if (errors.length > 0) return { spot: null, errors, street: null };

  const street: SpotBuild['street'] =
    boardCards.length === 5 ? 'river' : boardCards.length === 4 ? 'turn' : 'flop';

  const base: Record<string, unknown> = {
    board: boardCards.map((c) => c.label).join(' '),
    pot: form.pot,
    stacks: form.stacks,
    max_iterations: form.maxIterations,
    target_exploitability_pct: targetPctFor(form),
  };
  if (form.oopRangeSet) {
    base.oop_range_set = form.oopRangeSet;
  } else {
    base.oop_range = oop.entries.map((e) => `${e.combo}:${e.weight}`);
  }
  if (form.ipRangeSet) {
    base.ip_range_set = form.ipRangeSet;
  } else {
    base.ip_range = ip.entries.map((e) => `${e.combo}:${e.weight}`);
  }

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
