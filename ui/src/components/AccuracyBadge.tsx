// Accuracy badges. Two visually distinct families, by design:
//  - GTO (certified): the solve's exploitability was measured by the
//    engine's independent best-response checker. Solid green.
//  - APPROXIMATION: guidance not backed by a measured solve (the future
//    multiway lens). Amber outline, never solid green — the two must
//    never be confusable at a glance.

export function AccuracyBadge({ nashPct }: { nashPct: number }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full bg-table px-2.5 py-1 text-xs font-semibold text-white"
      title="Nash distance measured by the engine's independent best-response checker, as a percent of the starting pot. Lower is more accurate."
    >
      <span aria-hidden="true">✓</span>
      GTO · Nash {nashPct.toFixed(3)}% pot
    </span>
  );
}

export function ApproximationBadge({ label = 'APPROXIMATION' }: { label?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-accent px-2.5 py-1 text-xs font-semibold text-accent"
      title="Guidance derived from principles or approximate methods — not a measured solver output."
    >
      <span aria-hidden="true">≈</span>
      {label}
    </span>
  );
}
