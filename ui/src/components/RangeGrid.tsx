import { useMemo, useState } from 'react';
import { canonicalClass, RANK_ORDER, RANKS_DESC } from '../lib/cards';
import { comboWeight, liveCombos, type SolveData, type SolveNode } from '../lib/solveTree';
import { actionColor } from './actionStyle';
import { pctText } from './FrequencyBar';

interface Props {
  data: SolveData;
  node: SolveNode;
  /** Index of the action the grid is coloured by. */
  colorActionIdx: number;
  selectedCombo: string | null;
  onSelectCombo: (combo: string) => void;
}

interface CellData {
  key: string;
  combos: string[];
  /** Weight-averaged frequency of the colour action across the cell. */
  freq: number;
}

/**
 * 13x13-style range grid: PLO combos grouped by canonical class (the
 * combo's two highest ranks). Cell colour intensity = how often the class
 * takes the selected action at this node (from the solve JSON).
 */
export function RangeGrid({ data, node, colorActionIdx, selectedCombo, onSelectCombo }: Props) {
  const [selectedCell, setSelectedCell] = useState<string | null>(null);

  const cells = useMemo(() => {
    const map = new Map<string, { combos: string[]; wFreq: number; wSum: number }>();
    for (const combo of liveCombos(node)) {
      const key = canonicalClass(combo);
      const w = comboWeight(data, node.player, combo);
      const freq = node.strategy[combo]?.[colorActionIdx] ?? 0;
      const entry = map.get(key) ?? { combos: [], wFreq: 0, wSum: 0 };
      entry.combos.push(combo);
      entry.wFreq += w * freq;
      entry.wSum += w;
      map.set(key, entry);
    }
    const out = new Map<string, CellData>();
    for (const [key, v] of map) {
      out.set(key, { key, combos: v.combos, freq: v.wSum === 0 ? 0 : v.wFreq / v.wSum });
    }
    return out;
  }, [data, node, colorActionIdx]);

  const color = actionColor(node.actions[colorActionIdx] ?? '');
  const selectedCellData = selectedCell ? cells.get(selectedCell) : undefined;

  return (
    <div>
      <div
        className="grid gap-[2px]"
        style={{ gridTemplateColumns: 'repeat(13, minmax(0, 1fr))' }}
        role="grid"
        aria-label={`${node.player} range by hand class, coloured by ${node.actions[colorActionIdx] ?? ''}`}
      >
        {RANKS_DESC.map((hi) =>
          RANKS_DESC.map((lo) => {
            const key = `${hi}${lo}`;
            if ((RANK_ORDER[hi] ?? 0) < (RANK_ORDER[lo] ?? 0)) {
              return <div key={key} aria-hidden="true" />;
            }
            const cell = cells.get(key);
            const isSelected = selectedCell === key;
            if (!cell) {
              return (
                <div
                  key={key}
                  className="flex aspect-square items-center justify-center rounded-[3px] bg-navy-900/60 text-[9px] text-ink-faint/50"
                  aria-hidden="true"
                >
                  {key}
                </div>
              );
            }
            return (
              <button
                key={key}
                type="button"
                role="gridcell"
                onClick={() => setSelectedCell(key)}
                aria-label={`${key}: ${cell.combos.length} combos, takes this action ${pctText(cell.freq)}`}
                className={`relative flex aspect-square flex-col items-center justify-center overflow-hidden rounded-[3px] text-[9px] leading-tight ${
                  isSelected ? 'ring-2 ring-accent' : 'ring-1 ring-navy-700'
                }`}
              >
                <span
                  className="absolute inset-0"
                  style={{ backgroundColor: color, opacity: 0.12 + 0.88 * cell.freq }}
                  aria-hidden="true"
                />
                <span className="relative font-semibold text-white drop-shadow">{key}</span>
                <span className="relative text-white/85 drop-shadow">
                  {Math.round(cell.freq * 100)}
                </span>
              </button>
            );
          }),
        )}
      </div>

      {selectedCellData ? (
        <div className="mt-3">
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Class {selectedCellData.key} · {selectedCellData.combos.length} combos
          </h4>
          <ul className="flex flex-col gap-1">
            {selectedCellData.combos.map((combo) => {
              const freq = node.strategy[combo]?.[colorActionIdx] ?? 0;
              const isSel = combo === selectedCombo;
              return (
                <li key={combo}>
                  <button
                    type="button"
                    onClick={() => onSelectCombo(combo)}
                    className={`flex w-full items-center justify-between rounded-md px-2 py-1 font-mono text-xs ${
                      isSel
                        ? 'bg-navy-800 text-ink ring-1 ring-table'
                        : 'text-ink-dim hover:bg-navy-800 hover:text-ink'
                    }`}
                    aria-pressed={isSel}
                  >
                    <span>{combo}</span>
                    <span>{pctText(freq)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <p className="mt-3 text-xs text-ink-faint">
          Select a hand class to list its combos, then a combo for full detail.
        </p>
      )}
    </div>
  );
}
