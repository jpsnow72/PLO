import { useMemo, useState } from 'react';
import { parseCombo } from '../lib/cards';
import { comboWeight, liveCombos, type SolveData, type SolveNode } from '../lib/solveTree';
import { actionColor, prettyAction } from './actionStyle';
import { CardRow } from './CardChip';
import { pctText } from './FrequencyBar';

interface Props {
  data: SolveData;
  node: SolveNode;
  /** Range-aggregate frequency per action (from the solve JSON). */
  aggregates: number[];
  selectedCombo: string | null;
  onSelectCombo: (combo: string) => void;
}

type SortKey = 'freq' | 'ev';

interface Row {
  combo: string;
  freq: number;
  /** Solve-level EV of the combo (whole tree), null when the payload has none. */
  ev: number | null;
  weight: number;
}

const ROW_CAP = 50;

function ActionTable({
  data,
  node,
  actionIdx,
  aggregate,
  sortKey,
  selectedCombo,
  onSelectCombo,
}: {
  data: SolveData;
  node: SolveNode;
  actionIdx: number;
  aggregate: number;
  sortKey: SortKey;
  selectedCombo: string | null;
  onSelectCombo: (combo: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const label = node.actions[actionIdx] ?? '';

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (const combo of liveCombos(node)) {
      const freq = node.strategy[combo]?.[actionIdx] ?? 0;
      if (freq <= 0) continue;
      out.push({
        combo,
        freq,
        ev: data.evs[node.player].get(combo) ?? null,
        weight: comboWeight(data, node.player, combo),
      });
    }
    out.sort((a, b) => {
      if (sortKey === 'freq') return b.freq - a.freq || b.weight - a.weight;
      // EV descending, combos without an EV in the payload last.
      if (a.ev === null && b.ev === null) return b.freq - a.freq;
      if (a.ev === null) return 1;
      if (b.ev === null) return -1;
      return b.ev - a.ev || b.freq - a.freq;
    });
    return out;
  }, [data, node, actionIdx, sortKey]);

  if (rows.length === 0) return null;
  const visible = expanded ? rows : rows.slice(0, ROW_CAP);
  const color = actionColor(label);

  return (
    <section
      aria-label={`${prettyAction(label)} — combos taking this action`}
      className="overflow-hidden rounded-lg border border-navy-700 bg-navy-900 shadow-panel"
    >
      <header
        className="flex items-baseline justify-between gap-2 px-3 py-2"
        style={{ backgroundColor: color }}
      >
        <h3 className="text-sm font-bold text-white">{prettyAction(label)}</h3>
        <span className="num font-mono text-xs font-semibold text-white/90">
          {pctText(aggregate)} · {rows.length} combos
        </span>
      </header>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-navy-700 text-left text-[11px] uppercase tracking-wide text-ink-faint">
            <th scope="col" className="px-3 py-1.5 font-semibold">Hand</th>
            <th scope="col" className="num px-2 py-1.5 text-right font-semibold">Freq</th>
            <th scope="col" className="num px-2 py-1.5 text-right font-semibold">EV (solve)</th>
            <th
              scope="col"
              className="num px-2 py-1.5 text-right font-semibold"
              title="Per-action EVs are not in the engine payload — see the note below the tables."
            >
              EV Diff
            </th>
            <th scope="col" className="num px-3 py-1.5 text-right font-semibold">Weight</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => {
            const cards = parseCombo(row.combo);
            const isSel = row.combo === selectedCombo;
            return (
              <tr
                key={row.combo}
                onClick={() => onSelectCombo(row.combo)}
                aria-selected={isSel}
                className={`cursor-pointer border-b border-navy-800 last:border-0 ${
                  isSel ? 'bg-navy-800 ring-1 ring-inset ring-table' : 'hover:bg-navy-850'
                }`}
              >
                <td className="px-3 py-1.5">
                  {cards ? (
                    <CardRow cards={cards} size="sm" />
                  ) : (
                    <span className="font-mono text-xs text-ink">{row.combo}</span>
                  )}
                </td>
                <td className="num px-2 py-1.5 text-right font-mono text-ink">{pctText(row.freq)}</td>
                <td className="num px-2 py-1.5 text-right font-mono text-ink-dim">
                  {row.ev === null ? '—' : row.ev.toFixed(2)}
                </td>
                <td className="num px-2 py-1.5 text-right font-mono text-ink-faint">—</td>
                <td className="num px-3 py-1.5 text-right font-mono text-ink-dim">
                  {row.weight.toFixed(2)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > ROW_CAP ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full px-3 py-1.5 text-xs font-semibold text-table-light hover:bg-navy-850"
        >
          {expanded ? 'Show fewer combos' : `Show all ${rows.length} combos`}
        </button>
      ) : null}
    </section>
  );
}

/**
 * Strategy view: one table per action at the current node, GTO-Wizard
 * style. Frequencies and weights are the node's own strategy rows; EV is
 * the combo's whole-solve EV from the payload's *_evs lists. The engine
 * payload carries no per-action EVs, so EV Diff (vs the best action) is
 * shown as an em dash rather than estimated — see SHIP1-NOTES.md.
 */
export function StrategyTables({ data, node, aggregates, selectedCombo, onSelectCombo }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('freq');
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs text-ink-dim">
        <span className="font-semibold uppercase tracking-wide text-ink-faint">Sort by</span>
        {(
          [
            { key: 'freq', label: 'Frequency' },
            { key: 'ev', label: 'EV' },
          ] as { key: SortKey; label: string }[]
        ).map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => setSortKey(o.key)}
            aria-pressed={sortKey === o.key}
            className={`rounded-full px-2.5 py-1 ${
              sortKey === o.key
                ? 'bg-navy-800 font-semibold text-ink ring-1 ring-accent'
                : 'text-ink-dim hover:bg-navy-800 hover:text-ink'
            }`}
          >
            {o.label}
          </button>
        ))}
        <span className="ml-auto hidden text-ink-faint sm:inline">
          Click a row for full hand detail.
        </span>
      </div>

      {node.actions.map((label, i) => (
        <ActionTable
          key={`${node.history}-${label}`}
          data={data}
          node={node}
          actionIdx={i}
          aggregate={aggregates[i] ?? 0}
          sortKey={sortKey}
          selectedCombo={selectedCombo}
          onSelectCombo={onSelectCombo}
        />
      ))}

      <p className="text-xs text-ink-faint">
        EV is each combo's whole-solve EV (the engine reports per-combo EV for the whole tree, not
        per action or per node), so the EV Diff column shows — instead of an estimate.
      </p>
    </div>
  );
}
