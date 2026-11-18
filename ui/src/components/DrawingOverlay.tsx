import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  DRAW_COLORS,
  DRAW_WIDTHS,
  strokeHit,
  strokePathD,
  type DrawPoint,
  type DrawStroke,
} from '../lib/drawing';
import { useStore } from '../store/useStore';

/**
 * Drawing mode (rebrand slice 8, issue #20): freehand annotation
 * over the Explorer's table, in the pattern of the captured
 * reference's drawing mode — a pen with a few colours and widths,
 * an eraser, undo and clear, toggled from the Table view.
 *
 * Tech: one absolutely-positioned SVG over the table area, strokes
 * as smoothed SVG paths in a 0..100 viewBox (see lib/drawing).
 * Strokes live in the store, keyed to the loaded solve: they
 * survive walking the tree, reset when another solve loads, and
 * are never persisted or sent to the API. The overlay renders the
 * strokes at all times but only captures the pointer while drawing
 * mode is on — off, it is pointer-events-none and the table below
 * interacts exactly as before.
 */

const SCOPE_HINT =
  'Annotations are kept for this solve only, in this session — they are never saved or sent anywhere.';

export function DrawingToolbar() {
  const active = useStore((s) => s.drawingActive);
  const setActive = useStore((s) => s.setDrawingActive);
  const tool = useStore((s) => s.drawingTool);
  const setTool = useStore((s) => s.setDrawingTool);
  const color = useStore((s) => s.drawingColor);
  const setColor = useStore((s) => s.setDrawingColor);
  const width = useStore((s) => s.drawingWidth);
  const setWidth = useStore((s) => s.setDrawingWidth);
  const strokeCount = useStore((s) => s.drawingStrokes.length);
  const undo = useStore((s) => s.undoDrawingStroke);
  const clear = useStore((s) => s.clearDrawingStrokes);

  const toolBtn = (selected: boolean) =>
    `rounded px-2 py-1 text-xs ${
      selected
        ? 'bg-navy-800 font-semibold text-ink ring-1 ring-table'
        : 'text-ink-dim hover:bg-navy-800 hover:text-ink'
    }`;

  return (
    <div className="flex flex-wrap items-center gap-2 self-start">
      <button
        type="button"
        aria-pressed={active}
        title={`Draw on the table. ${SCOPE_HINT}`}
        onClick={() => setActive(!active)}
        className={
          active
            ? 'rounded-md bg-table px-3 py-1.5 text-xs font-semibold text-white hover:bg-table-dark'
            : 'rounded-md bg-navy-800 px-3 py-1.5 text-xs font-semibold text-ink-dim hover:text-ink'
        }
      >
        ✎ Draw{strokeCount > 0 ? ` (${strokeCount})` : ''}
      </button>

      {active ? (
        <>
          <span className="flex items-center gap-1" role="group" aria-label="Pen colour">
            {DRAW_COLORS.map((c) => (
              <button
                key={c.hex}
                type="button"
                title={`${c.name} pen`}
                aria-label={`${c.name} pen`}
                aria-pressed={tool === 'pen' && color === c.hex}
                onClick={() => setColor(c.hex)}
                className={`h-5 w-5 rounded-full ${
                  tool === 'pen' && color === c.hex
                    ? 'ring-2 ring-ink ring-offset-2 ring-offset-navy-900'
                    : 'ring-1 ring-black/40 hover:ring-ink-dim'
                }`}
                style={{ backgroundColor: c.hex }}
              />
            ))}
          </span>

          <span className="flex items-center gap-1" role="group" aria-label="Pen width">
            {DRAW_WIDTHS.map((w) => (
              <button
                key={w.label}
                type="button"
                title={`${w.label} width`}
                aria-pressed={width === w.value}
                onClick={() => setWidth(w.value)}
                className={`${toolBtn(width === w.value)} flex w-8 flex-col items-center gap-0.5`}
              >
                <span
                  className="block w-4 rounded-full bg-current"
                  style={{ height: `${Math.max(2, w.value * 3)}px` }}
                />
                <span className="text-[10px] leading-none">{w.label}</span>
              </button>
            ))}
          </span>

          <span className="flex items-center gap-1" role="group" aria-label="Tool">
            <button
              type="button"
              aria-pressed={tool === 'pen'}
              onClick={() => setTool('pen')}
              className={toolBtn(tool === 'pen')}
            >
              Pen
            </button>
            <button
              type="button"
              aria-pressed={tool === 'eraser'}
              onClick={() => setTool('eraser')}
              className={toolBtn(tool === 'eraser')}
            >
              Eraser
            </button>
          </span>
        </>
      ) : null}

      {strokeCount > 0 ? (
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={undo}
            className="rounded px-2 py-1 text-xs text-ink-dim hover:bg-navy-800 hover:text-ink"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={clear}
            className="rounded px-2 py-1 text-xs text-ink-dim hover:bg-navy-800 hover:text-ink"
          >
            Clear all
          </button>
        </span>
      ) : null}

      {active ? (
        <span className="text-[11px] text-ink-faint">Esc stops drawing · {SCOPE_HINT}</span>
      ) : null}
    </div>
  );
}

/** Minimum move between recorded points, in viewBox units. */
const MIN_POINT_STEP = 0.35;

export function DrawingOverlay() {
  const active = useStore((s) => s.drawingActive);
  const setActive = useStore((s) => s.setDrawingActive);
  const tool = useStore((s) => s.drawingTool);
  const color = useStore((s) => s.drawingColor);
  const width = useStore((s) => s.drawingWidth);
  const strokes = useStore((s) => s.drawingStrokes);
  const addStroke = useStore((s) => s.addDrawingStroke);
  const removeStrokes = useStore((s) => s.removeDrawingStrokes);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const pressingRef = useRef(false);
  // The in-progress stroke is local: it is only committed to the
  // store on pointer-up, so a half-drawn line never hits undo.
  const [current, setCurrent] = useState<DrawStroke | null>(null);

  // Esc leaves drawing mode (the strokes stay).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActive(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, setActive]);

  const toLocal = (e: ReactPointerEvent<SVGSVGElement>): DrawPoint | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: ((e.clientX - rect.left) / rect.width) * 100,
      y: ((e.clientY - rect.top) / rect.height) * 100,
    };
  };

  const eraseAt = (p: DrawPoint) => {
    const all = useStore.getState().drawingStrokes;
    const hits: number[] = [];
    all.forEach((s, i) => {
      if (strokeHit(s, p)) hits.push(i);
    });
    if (hits.length > 0) removeStrokes(hits);
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!active) return;
    const p = toLocal(e);
    if (!p) return;
    e.preventDefault();
    svgRef.current?.setPointerCapture(e.pointerId);
    pressingRef.current = true;
    if (tool === 'eraser') {
      eraseAt(p);
    } else {
      setCurrent({ color, width, points: [p] });
    }
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!active || !pressingRef.current) return;
    const p = toLocal(e);
    if (!p) return;
    if (tool === 'eraser') {
      eraseAt(p);
      return;
    }
    setCurrent((prev) => {
      if (!prev) return prev;
      const last = prev.points[prev.points.length - 1]!;
      if (Math.abs(p.x - last.x) < MIN_POINT_STEP && Math.abs(p.y - last.y) < MIN_POINT_STEP) {
        return prev;
      }
      return { ...prev, points: [...prev.points, p] };
    });
  };

  const endStroke = () => {
    if (!pressingRef.current) return;
    pressingRef.current = false;
    if (tool === 'pen' && current && current.points.length > 0) {
      addStroke(current);
    }
    setCurrent(null);
  };

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
      className={`absolute inset-0 z-20 h-full w-full ${
        active ? 'pointer-events-auto cursor-crosshair touch-none' : 'pointer-events-none'
      }`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endStroke}
      onPointerCancel={endStroke}
    >
      {strokes.map((s, i) => (
        <path
          key={i}
          d={strokePathD(s.points)}
          stroke={s.color}
          strokeWidth={s.width}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {current ? (
        <path
          d={strokePathD(current.points)}
          stroke={current.color}
          strokeWidth={current.width}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}
    </svg>
  );
}
