/**
 * Drawing annotations (rebrand slice 8, issue #20): freehand strokes
 * drawn over the Explorer's table. Pure model + geometry helpers —
 * the strokes themselves live in the zustand store (see useStore)
 * so they survive walking the tree within one solve; they are
 * session-local and never leave the client.
 *
 * Coordinates are in the overlay's viewBox units (0..100 on both
 * axes, mapped from the rendered box), so a stroke replays at any
 * table size. The box is wider than it is tall, so a viewBox unit is
 * a few more pixels horizontally than vertically — strokes stretch
 * slightly with the table, which is fine for annotation.
 */

export interface DrawPoint {
  x: number;
  y: number;
}

export interface DrawStroke {
  color: string;
  /** Stroke width in viewBox units. */
  width: number;
  points: DrawPoint[];
}

export type DrawTool = 'pen' | 'eraser';

/**
 * Pen colours from our own palette: the amber accent, table-light
 * green, and the hearts/diamonds suit colours, plus white. (The
 * felt itself is the darker table green #2E9E6B, so the light green
 * #3FBF82 is the visible "green" on it.)
 */
export const DRAW_COLORS: { name: string; hex: string }[] = [
  { name: 'Amber', hex: '#F5A623' },
  { name: 'Green', hex: '#3FBF82' },
  { name: 'Red', hex: '#E05B4B' },
  { name: 'Blue', hex: '#4E9BE0' },
  { name: 'White', hex: '#FFFFFF' },
];

/** Pen widths in viewBox units (≈4 / 7 / 13 px on a 640 px table). */
export const DRAW_WIDTHS: { label: string; value: number }[] = [
  { label: 'S', value: 0.6 },
  { label: 'M', value: 1.1 },
  { label: 'L', value: 2.0 },
];

/** Eraser reach in viewBox units, added to a stroke's half-width. */
export const ERASER_RADIUS = 2.2;

/**
 * SVG path for a stroke, smoothed with quadratic segments through
 * the midpoints (the standard midpoint-quadratic smoothing: each
 * recorded point becomes a control point, so the curve passes near
 * every point without the jitter of raw polyline corners). A single
 * point renders as a dot via a zero-length segment + round caps.
 */
export function strokePathD(points: DrawPoint[]): string {
  if (points.length === 0) return '';
  const first = points[0]!;
  if (points.length === 1) {
    return `M ${first.x} ${first.y} L ${first.x} ${first.y}`;
  }
  let d = `M ${first.x} ${first.y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const next = points[i + 1]!;
    d += ` Q ${p.x} ${p.y} ${(p.x + next.x) / 2} ${(p.y + next.y) / 2}`;
  }
  const last = points[points.length - 1]!;
  d += ` L ${last.x} ${last.y}`;
  return d;
}

function segmentDistance(p: DrawPoint, a: DrawPoint, b: DrawPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Does the eraser at `p` touch this stroke? True when the point is
 * within the stroke's half-width + ERASER_RADIUS of its polyline.
 */
export function strokeHit(stroke: DrawStroke, p: DrawPoint): boolean {
  const reach = stroke.width / 2 + ERASER_RADIUS;
  const pts = stroke.points;
  if (pts.length === 0) return false;
  if (pts.length === 1) return Math.hypot(p.x - pts[0]!.x, p.y - pts[0]!.y) <= reach;
  for (let i = 1; i < pts.length; i++) {
    if (segmentDistance(p, pts[i - 1]!, pts[i]!) <= reach) return true;
  }
  return false;
}
