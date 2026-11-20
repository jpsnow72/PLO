import { useMemo, useState } from 'react';
import {
  canonicalClass,
  comboSuitedness,
  flushRelation,
  parseCard,
  parseCombo,
  RANK_ORDER,
  RANKS_DESC,
  remainingClass,
  type Card,
  type FlushRelation,
  type SuitednessShape,
} from '../lib/cards';
import { SUITEDNESS_FILTERS, type SuitednessFilter } from '../lib/preflop';
import {
  aggregateFrequencies,
  comboEvDiff,
  comboWeight,
  liveCombos,
  nodeHasActionEvs,
  type SolveData,
  type SolveNode,
} from '../lib/solveTree';
import { actionColor, prettyAction } from './actionStyle';
import { CardRow } from './CardChip';
import { pctText, SplitBar, type SplitSegment } from './FrequencyBar';

interface Props {
  data: SolveData;
  node: SolveNode;
  selectedCombo: string | null;
  onSelectCombo: (combo: string) => void;
}

type FlushFilter = 'any' | FlushRelation;

const FLUSH_FILTERS: { id: FlushFilter; label: string }[] = [
  { id: 'any', label: 'Any' },
  { id: 'flush', label: 'Flush made' },
  { id: 'draw', label: 'Flush draw' },
  { id: 'none', label: 'No flush' },
];

const LIST_CAP = 60;

interface ComboInfo {
  combo: string;
  cards: Card[] | null;
  weight: number;
  /** Per-action frequencies at this node, aligned with node.actions. */
  freqs: number[];
  /** Whole-solve EV of the combo, null when the payload has none. */
  ev: number | null;
  /**
   * EV Diff at this node (main line vs best action, chips), null when
   * the payload carries no per-action EVs for the combo (issue #8).
   */
  diff: number | null;
  classKey: string;
  remainingKey: string | null;
  suitedness: SuitednessShape | null;
  flush: FlushRelation | null;
  passes: boolean;
}

interface SplitAgg {
  /** Weight-summed frequency per action (divide by weight for shares). */
  weighted: number[];
  combos: number;
  weight: number;
}

function emptyAgg(actions: number): SplitAgg {
  return { weighted: new Array<number>(actions).fill(0), combos: 0, weight: 0 };
}

function addToAgg(agg: SplitAgg, info: ComboInfo): void {
  agg.combos += 1;
  agg.weight += info.weight;
  info.freqs.forEach((f, i) => {
    agg.weighted[i] = (agg.weighted[i] ?? 0) + info.weight * f;
  });
}

function aggSplits(agg: SplitAgg): number[] {
  if (agg.weight === 0) return agg.weighted.map(() => 0);
  return agg.weighted.map((w) => w / agg.weight);
}

function splitSegments(actions: string[], splits: number[]): SplitSegment[] {
  return actions.map((label, i) => ({
    label: prettyAction(label),
    fraction: splits[i] ?? 0,
    color: actionColor(label),
  }));
}

function splitSummary(actions: string[], splits: number[]): string {
  return actions
    .map((label, i) => `${prettyAction(label)} ${pctText(splits[i] ?? 0)}`)
    .join(', ');
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-2.5 py-1 text-xs ${
        active
          ? 'bg-navy-800 font-semibold text-ink ring-1 ring-table'
          : 'bg-navy-850 text-ink-dim hover:text-ink'
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Explorer range matrix: PLO combos grouped by canonical class (the
 * combo's two highest ranks — every combo sits in exactly one cell).
 * Each cell's fill is the class's full action split at this node:
 * one segment per action, width = the weight-averaged frequency of
 * that action across the class's combos, in the shared action colours
 * (the preflop matrix's single-action fill is the same language with
 * one segment). Suitedness and flush-relation chips filter combos
 * before aggregation; locking a class opens its combo list beside the
 * grid, with a sub-matrix over the class's remaining two cards.
 * Everything re-aggregates from the payload when the node changes.
 */
export function RangeGrid({ data, node, selectedCombo, onSelectCombo }: Props) {
  const [suitFilter, setSuitFilter] = useState<SuitednessFilter>('any');
  const [flushFilter, setFlushFilter] = useState<FlushFilter>('any');
  const [selectedCell, setSelectedCell] = useState<string | null>(null);
  const [subCell, setSubCell] = useState<string | null>(null);
  const [listExpanded, setListExpanded] = useState(false);

  // The board as it stands at this node (flop + dealt runout cards).
  const boardCards = useMemo(() => {
    const extra: Card[] = [];
    const turn = node.turn_card ? parseCard(node.turn_card) : null;
    const river = node.river_card ? parseCard(node.river_card) : null;
    if (turn) extra.push(turn);
    if (river) extra.push(river);
    return [...data.boardCards, ...extra];
  }, [data, node]);

  // A flush can only be made or drawn when the board holds 2+ cards of
  // some suit; on a rainbow board the relation is 'none' for every
  // combo, so the filter row is omitted rather than offered dead.
  const flushRowAvailable = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of boardCards) counts.set(c.suit, (counts.get(c.suit) ?? 0) + 1);
    return [...counts.values()].some((n) => n >= 2);
  }, [boardCards]);

  const aggregates = useMemo(() => aggregateFrequencies(data, node), [data, node]);

  // Whether this node carries per-action EVs (issue #8): the Diff
  // column goes live and widens to fit values; without the field the
  // column and its footnote render exactly as before.
  const hasActionEvs = useMemo(() => nodeHasActionEvs(node), [node]);
  const diffColClass = hasActionEvs ? 'w-12' : 'w-8';

  const infos = useMemo<ComboInfo[]>(() => {
    const suitFeature = SUITEDNESS_FILTERS.find((f) => f.id === suitFilter)?.feature ?? null;
    return liveCombos(node).map((combo) => {
      const cards = parseCombo(combo);
      const suitedness = cards ? comboSuitedness(cards) : null;
      const flush = cards ? flushRelation(cards, boardCards) : null;
      const passesSuit = suitFeature === null || suitedness === suitFeature;
      const passesFlush = flushFilter === 'any' || flush === flushFilter;
      return {
        combo,
        cards,
        weight: comboWeight(data, node.player, combo),
        freqs: node.strategy[combo] ?? [],
        ev: data.evs[node.player].get(combo) ?? null,
        diff: comboEvDiff(node, combo),
        classKey: canonicalClass(combo),
        remainingKey: remainingClass(combo),
        suitedness,
        flush,
        passes: passesSuit && passesFlush,
      };
    });
  }, [data, node, boardCards, suitFilter, flushFilter]);

  const cells = useMemo(() => {
    const map = new Map<string, SplitAgg>();
    for (const info of infos) {
      if (!info.passes) continue;
      const agg = map.get(info.classKey) ?? emptyAgg(node.actions.length);
      addToAgg(agg, info);
      map.set(info.classKey, agg);
    }
    return map;
  }, [infos, node]);

  const totalWeight = useMemo(() => infos.reduce((a, i) => a + i.weight, 0), [infos]);
  const passing = useMemo(() => infos.filter((i) => i.passes), [infos]);
  const passingWeight = useMemo(() => passing.reduce((a, i) => a + i.weight, 0), [passing]);
  const filtersActive = suitFilter !== 'any' || flushFilter !== 'any';

  const classInfos = useMemo(
    () => (selectedCell ? infos.filter((i) => i.classKey === selectedCell) : []),
    [infos, selectedCell],
  );
  const classPassing = useMemo(() => classInfos.filter((i) => i.passes), [classInfos]);
  const classAgg = useMemo(() => {
    const agg = emptyAgg(node.actions.length);
    for (const info of classPassing) addToAgg(agg, info);
    return agg;
  }, [classPassing, node]);

  const subCells = useMemo(() => {
    const map = new Map<string, SplitAgg>();
    for (const info of classPassing) {
      if (!info.remainingKey) continue;
      const agg = map.get(info.remainingKey) ?? emptyAgg(node.actions.length);
      addToAgg(agg, info);
      map.set(info.remainingKey, agg);
    }
    return map;
  }, [classPassing, node]);

  // A sub-cell chosen before a filter change may no longer exist.
  const effectiveSubCell = subCell && subCells.has(subCell) ? subCell : null;

  const listCombos = useMemo(() => {
    const rows = effectiveSubCell
      ? classPassing.filter((i) => i.remainingKey === effectiveSubCell)
      : [...classPassing];
    rows.sort((a, b) => {
      // Whole-solve EV descending (the locked-panel order in the
      // reference tool), combos without an EV last, then weight.
      if (a.ev === null && b.ev === null) return b.weight - a.weight || a.combo.localeCompare(b.combo);
      if (a.ev === null) return 1;
      if (b.ev === null) return -1;
      return b.ev - a.ev || b.weight - a.weight || a.combo.localeCompare(b.combo);
    });
    return rows;
  }, [classPassing, effectiveSubCell]);

  const visibleCombos = listExpanded ? listCombos : listCombos.slice(0, LIST_CAP);

  const lockCell = (key: string) => {
    setSelectedCell(key);
    setSubCell(null);
    setListExpanded(false);
  };

  return (
    <div>
      {/* Legend: every action at this node with its range aggregate */}
      <div className="flex flex-wrap items-center gap-1.5" aria-label="Actions at this node">
        {node.actions.map((label, i) => (
          <span
            key={label}
            className="inline-flex items-center gap-1.5 rounded-full bg-navy-850 px-2.5 py-1 text-xs text-ink-dim"
          >
            <span
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: actionColor(label) }}
              aria-hidden="true"
            />
            {prettyAction(label)}
            <span className="font-mono text-ink-faint">{pctText(aggregates[i] ?? 0)}</span>
          </span>
        ))}
        <span className="ml-auto text-xs text-ink-faint">
          {filtersActive
            ? `${passing.length} of ${infos.length} combos shown`
            : `${infos.length} combos in range`}
        </span>
      </div>

      {/* Suitedness filter: the combo's own suit shape, same chips and
          vocabulary as the preflop matrix. */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
          Suitedness
        </span>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Suitedness filter">
          {SUITEDNESS_FILTERS.map((f) => (
            <FilterChip key={f.id} active={suitFilter === f.id} onClick={() => setSuitFilter(f.id)}>
              {f.label}
            </FilterChip>
          ))}
        </div>
      </div>

      {/* Flush relation to the board (Omaha: exactly two hole cards). */}
      {flushRowAvailable ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Flush
          </span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Flush relation filter">
            {FLUSH_FILTERS.map((f) => (
              <FilterChip
                key={f.id}
                active={flushFilter === f.id}
                onClick={() => setFlushFilter(f.id)}
              >
                {f.label}
              </FilterChip>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div>
          <div
            className="grid gap-[2px]"
            style={{ gridTemplateColumns: 'repeat(13, minmax(0, 1fr))' }}
            role="grid"
            aria-label={`${node.player} range by hand class at this node`}
          >
            {RANKS_DESC.map((hi) =>
              RANKS_DESC.map((lo) => {
                const key = `${hi}${lo}`;
                if ((RANK_ORDER[hi] ?? 0) < (RANK_ORDER[lo] ?? 0)) {
                  return <div key={key} aria-hidden="true" />;
                }
                const cell = cells.get(key);
                if (!cell || cell.combos === 0) {
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
                const splits = aggSplits(cell);
                const isSelected = selectedCell === key;
                return (
                  <button
                    key={key}
                    type="button"
                    role="gridcell"
                    onClick={() => lockCell(key)}
                    aria-pressed={isSelected}
                    aria-label={`${key}: ${cell.combos} combos — ${splitSummary(node.actions, splits)}`}
                    title={`${key} · ${cell.combos} combos · ${splitSummary(node.actions, splits)}`}
                    className={`relative flex aspect-square items-center justify-center overflow-hidden rounded-[3px] ${
                      isSelected ? 'z-10 ring-2 ring-accent' : 'ring-1 ring-navy-700/60 hover:ring-ink-faint'
                    }`}
                  >
                    <SplitBar
                      segments={splitSegments(node.actions, splits)}
                      className="absolute inset-0"
                    />
                    <span className="relative text-[10px] font-semibold text-white drop-shadow">
                      {key}
                    </span>
                  </button>
                );
              }),
            )}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-faint">
            Cell fill is the class's action split at this node, weighted by range weight. Every
            combo sits in exactly one class — its two highest ranks.
            {filtersActive
              ? ` Filters reshape the grid: showing ${passing.length} of ${infos.length} combos (${pctText(totalWeight === 0 ? 0 : passingWeight / totalWeight)} of the range by weight).`
              : ''}
          </p>
        </div>

        {/* Locked-class panel: sub-matrix + combo list, beside the grid */}
        <aside aria-label="Matrix selection" className="flex flex-col gap-3">
          {selectedCell ? (
            <>
              <div>
                <h4 className="text-sm font-semibold text-ink">
                  Class {selectedCell} · {classPassing.length} combos
                  {filtersActive && classPassing.length !== classInfos.length
                    ? ` (of ${classInfos.length} in class)`
                    : ''}
                </h4>
                <div className="mt-1.5 overflow-hidden rounded-full">
                  <SplitBar
                    segments={splitSegments(node.actions, aggSplits(classAgg))}
                    height="h-3"
                  />
                </div>
                <p className="mt-1.5 text-xs text-ink-dim">
                  {splitSummary(node.actions, aggSplits(classAgg))} ·{' '}
                  {pctText(totalWeight === 0 ? 0 : classAgg.weight / totalWeight)} of the range by
                  weight
                </p>
              </div>

              {classPassing.length === 0 ? (
                <p className="text-sm text-ink-dim">
                  No combos in class {selectedCell} match the current filters.
                </p>
              ) : (
                <>
                  <div>
                    <div className="flex items-center gap-2">
                      <h5 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                        Remaining cards
                      </h5>
                      {effectiveSubCell ? (
                        <button
                          type="button"
                          onClick={() => setSubCell(null)}
                          className="rounded px-1.5 py-0.5 text-xs font-semibold text-table-light hover:bg-navy-800"
                        >
                          {effectiveSubCell} × — show all
                        </button>
                      ) : null}
                    </div>
                    <div
                      className="mt-1.5 grid gap-[2px]"
                      style={{ gridTemplateColumns: 'repeat(13, minmax(0, 1fr))' }}
                      role="grid"
                      aria-label={`Class ${selectedCell} combos by their remaining two cards`}
                    >
                      {RANKS_DESC.map((hi) =>
                        RANKS_DESC.map((lo) => {
                          const key = `${hi}${lo}`;
                          if ((RANK_ORDER[hi] ?? 0) < (RANK_ORDER[lo] ?? 0)) {
                            return <div key={key} aria-hidden="true" />;
                          }
                          const cell = subCells.get(key);
                          if (!cell || cell.combos === 0) {
                            return (
                              <div
                                key={key}
                                className="flex aspect-square items-center justify-center rounded-[2px] bg-navy-900/60 text-[7px] text-ink-faint/40"
                                aria-hidden="true"
                              >
                                {key}
                              </div>
                            );
                          }
                          const splits = aggSplits(cell);
                          const isSel = effectiveSubCell === key;
                          return (
                            <button
                              key={key}
                              type="button"
                              role="gridcell"
                              onClick={() => {
                                setSubCell(isSel ? null : key);
                                setListExpanded(false);
                              }}
                              aria-pressed={isSel}
                              aria-label={`Remaining ${key}: ${cell.combos} combos — ${splitSummary(node.actions, splits)}`}
                              title={`Remaining ${key} · ${cell.combos} combos · ${splitSummary(node.actions, splits)}`}
                              className={`relative flex aspect-square items-center justify-center overflow-hidden rounded-[2px] ${
                                isSel
                                  ? 'z-10 ring-2 ring-accent'
                                  : 'ring-1 ring-navy-700/60 hover:ring-ink-faint'
                              }`}
                            >
                              <SplitBar
                                segments={splitSegments(node.actions, splits)}
                                className="absolute inset-0"
                              />
                              <span className="relative text-[8px] font-semibold text-white drop-shadow">
                                {key}
                              </span>
                            </button>
                          );
                        }),
                      )}
                    </div>
                    <p className="mt-1.5 text-xs text-ink-faint">
                      {effectiveSubCell
                        ? `Listing the combos whose other two cards are ${effectiveSubCell}.`
                        : 'Pick a cell to narrow the list to combos with those remaining cards.'}
                    </p>
                  </div>

                  <div>
                    <div
                      className="flex items-baseline gap-2 px-2 text-[10px] font-semibold uppercase tracking-wide text-ink-faint"
                      aria-hidden="true"
                    >
                      <span className="w-[5.75rem] shrink-0">Hand</span>
                      <span className="flex-1 text-center">Split</span>
                      <span className="w-14 text-right">EV (solve)</span>
                      <span
                        className={`${diffColClass} text-right`}
                        title={
                          hasActionEvs
                            ? "EV of the solver's most-taken action for the combo minus its best action's EV at this node, in chips"
                            : undefined
                        }
                      >
                        Diff
                      </span>
                      <span className="w-10 text-right">Weight</span>
                    </div>
                    <ul className="mt-1 flex flex-col gap-1">
                      {visibleCombos.map((info) => {
                        const isSel = info.combo === selectedCombo;
                        return (
                          <li key={info.combo}>
                            <button
                              type="button"
                              onClick={() => onSelectCombo(info.combo)}
                              aria-pressed={isSel}
                              aria-label={`Combo ${info.combo} — ${splitSummary(node.actions, info.freqs)}`}
                              className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs ${
                                isSel
                                  ? 'bg-navy-800 text-ink ring-1 ring-table'
                                  : 'text-ink-dim hover:bg-navy-800 hover:text-ink'
                              }`}
                            >
                              {info.cards ? (
                                <CardRow cards={info.cards} size="xs" />
                              ) : (
                                <span className="font-mono">{info.combo}</span>
                              )}
                              <span className="min-w-0 flex-1">
                                <SplitBar
                                  segments={splitSegments(node.actions, info.freqs)}
                                  height="h-2.5"
                                  className="rounded-full"
                                />
                              </span>
                              <span
                                className="num w-14 text-right font-mono"
                                title="Whole-solve EV of this combo"
                              >
                                {info.ev === null ? '—' : info.ev.toFixed(2)}
                              </span>
                              {info.diff === null ? (
                                <span
                                  className={`num ${diffColClass} text-right font-mono text-ink-faint`}
                                  title="Per-action EVs are not in the engine payload"
                                >
                                  —
                                </span>
                              ) : (
                                <span
                                  className={`num ${diffColClass} text-right font-mono text-ink-dim`}
                                  title={`Main line vs best action at this node: ${info.diff.toFixed(2)} chips${
                                    node.pot > 0
                                      ? ` (${((info.diff / node.pot) * 100).toFixed(1)}% of pot)`
                                      : ''
                                  }`}
                                >
                                  {info.diff.toFixed(2)}
                                </span>
                              )}
                              <span className="num w-10 text-right font-mono text-ink-dim">
                                {info.weight.toFixed(2)}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    {listCombos.length > LIST_CAP ? (
                      <button
                        type="button"
                        onClick={() => setListExpanded((v) => !v)}
                        className="mt-1 w-full px-2 py-1 text-left text-xs font-semibold text-table-light hover:bg-navy-850"
                      >
                        {listExpanded
                          ? 'Show fewer combos'
                          : `Show all ${listCombos.length} combos`}
                      </button>
                    ) : null}
                    <p className="mt-1.5 text-xs leading-relaxed text-ink-faint">
                      {hasActionEvs ? (
                        <>
                          Sorted by whole-solve EV. Diff is each combo's main-line cost at
                          this node: the EV of the solver's most-taken action for the combo
                          minus its best action's EV, in chips, from the solve's per-action
                          EVs — 0 when the main line is the best action.
                        </>
                      ) : (
                        <>
                          Sorted by whole-solve EV. EV is each combo's EV for the whole tree
                          — the engine reports no per-action EVs, so Diff shows — instead of
                          an estimate.
                        </>
                      )}
                    </p>
                  </div>
                </>
              )}
            </>
          ) : (
            <p className="text-sm text-ink-faint">
              Select a hand class to list its combos, then a combo for full detail.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
