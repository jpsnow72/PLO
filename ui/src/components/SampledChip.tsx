// The SAMPLED chip: shown on solves whose preflop ranges were trimmed
// by weighted sampling (see lib/sampled.ts for the rule). Deliberately
// the plain neutral meta-chip treatment — the same border/ink styling
// as the Library's Source chip — never the solid green of the certified
// GTO badge and never the amber of the LOCKED / APPROXIMATION family:
// sampling is provenance metadata, not a quality verdict either way.

import { sampledLabel, sampledTitle, type SampledInfo } from '../lib/sampled';

export function SampledChip({ info }: { info: SampledInfo }) {
  return (
    <span
      className="rounded-full border border-navy-600 px-2 py-0.5 text-[11px] uppercase tracking-wide text-ink-dim"
      title={sampledTitle(info)}
    >
      {sampledLabel(info)}
    </span>
  );
}
