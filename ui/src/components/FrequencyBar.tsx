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
