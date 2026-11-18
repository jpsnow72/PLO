export function FrequencyBar({
  fraction,
  color,
  height = 'h-2.5',
}: {
  fraction: number;
  color: string;
  height?: string;
}) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div
      className={`w-full overflow-hidden rounded-full bg-navy-800 ${height}`}
      role="img"
      aria-label={`${pct.toFixed(1)} percent`}
    >
      <div
        className="h-full rounded-full transition-[width] duration-150"
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
    </div>
  );
}

export function pctText(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export interface SplitSegment {
  fraction: number;
  color: string;
  label: string;
}

/**
 * One horizontal bar split across actions: a segment per action,
 * width = that action's share, in the shared action colours. Used as
 * the matrix cells' fill and as the compact per-combo split in lists.
 * Segments below ~0.05% are dropped so rounding dust never paints.
 */
export function SplitBar({
  segments,
  className = '',
  height = 'h-full',
}: {
  segments: SplitSegment[];
  className?: string;
  height?: string;
}) {
  const visible = segments.filter((s) => s.fraction > 0.0005);
  const summary = segments
    .filter((s) => s.fraction > 0)
    .map((s) => `${s.label} ${pctText(s.fraction)}`)
    .join(', ');
  return (
    <div
      className={`flex w-full overflow-hidden ${height} ${className}`}
      role="img"
      aria-label={summary || 'No actions'}
    >
      {visible.map((s) => (
        <div
          key={s.label}
          className="h-full"
          style={{ width: `${s.fraction * 100}%`, backgroundColor: s.color }}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
