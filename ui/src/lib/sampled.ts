// Sampled-range badge logic — the single source both the Library list
// and the Explorer header render from.
//
// A catalog (or capped custom) solve's stored meta records, per side,
// how its preflop range was trimmed to the combo cap before solving
// (range_expansion: { oop, ip }, each { mode, coverage_pct, ... }).
// Since 2026-11-21 the default trim is 'sample': a seeded weighted draw
// that sketches the whole range. 'top' keeps a deterministic
// premium-heavy slice instead — a different, older policy, NOT sampling,
// and it is never badged as such.
//
// Chip rule (Justin's call, 2026-11-21):
//  - Show the chip when EITHER side's mode is 'sample'.
//  - The number is the LOWER of the two sides' coverage_pct — the
//    honest worst case. A side absent from the record contributes
//    nothing; if no present side carries a numeric coverage, there is
//    no number to print and no chip (never fabricate one).
//  - 'top' on both sides, a missing/null expansion (custom solves with
//    hand-entered ranges, the bundled sample), or a malformed record
//    all show nothing.

import type { RangeExpansion, RangeExpansionSide } from './types';

export interface SampledInfo {
  /** Worst-case (minimum) coverage across the recorded sides, 0–100. */
  coveragePct: number;
  oop: RangeExpansionSide | null;
  ip: RangeExpansionSide | null;
  /** Which sides were actually sampled ('oop' and/or 'ip'). */
  sampledSides: ('oop' | 'ip')[];
}

function numericCoverage(side: RangeExpansionSide | null): number | null {
  if (!side) return null;
  const v = side.coverage_pct;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The chip's data for a solve, or null when no chip should render. */
export function sampledInfo(
  expansion: RangeExpansion | null | undefined,
): SampledInfo | null {
  if (!expansion || typeof expansion !== 'object') return null;
  const oop = expansion.oop ?? null;
  const ip = expansion.ip ?? null;
  const sampledSides: ('oop' | 'ip')[] = [];
  if (oop?.mode === 'sample') sampledSides.push('oop');
  if (ip?.mode === 'sample') sampledSides.push('ip');
  if (sampledSides.length === 0) return null;
  const coverages = [numericCoverage(oop), numericCoverage(ip)].filter(
    (v): v is number => v !== null,
  );
  if (coverages.length === 0) return null;
  return {
    coveragePct: Math.min(...coverages),
    oop,
    ip,
    sampledSides,
  };
}

/** Chip text: `SAMPLED · 22.6%` (coverage to one decimal). */
export function sampledLabel(info: SampledInfo): string {
  return `SAMPLED · ${info.coveragePct.toFixed(1)}%`;
}

function sideDetail(label: string, side: RangeExpansionSide | null): string | null {
  if (!side) return null;
  const parts = [`${label}: ${side.mode ?? 'unknown'} mode`];
  const cov = numericCoverage(side);
  if (cov !== null) parts.push(`coverage ${cov.toFixed(1)}%`);
  if (typeof side.kept_combos === 'number' && typeof side.total_combos === 'number') {
    parts.push(`${side.kept_combos} of ${side.total_combos} combos kept`);
  }
  if (typeof side.seed === 'number') parts.push(`seed ${side.seed}`);
  return parts.join(', ');
}

/** Tooltip text: what sampling means here + the per-side record. */
export function sampledTitle(info: SampledInfo): string {
  const head =
    "This solve's ranges were trimmed to the combo cap by a seeded weighted draw (sampling) that sketches the whole range, not a top slice. The percentage is the lower of the two sides' range-weight coverage — the worst case.";
  const details = [sideDetail('OOP', info.oop), sideDetail('IP', info.ip)].filter(
    (v): v is string => v !== null,
  );
  return details.length > 0 ? `${head} ${details.join(' · ')}` : head;
}
