import { useMemo, useState } from 'react';
import { parseCombo, type Card } from '../lib/cards';
import { classifyOmahaHand, HAND_CATEGORIES, type HandCategory } from '../lib/handCategories';
import {
  aggregateFrequencies,
  comboNodeEv,
  liveRange,
  nodeHasActionEvs,
  rangeEv,
  type LiveCombo,
  type SolveData,
  type SolveNode,
} from '../lib/solveTree';
import type { Player } from '../lib/types';
import type { PathStep } from '../store/useStore';
import { actionColor, prettyAction } from './actionStyle';
import { CardRow } from './CardChip';
import { pctText, SplitBar, type SplitSegment } from './FrequencyBar';

interface Props {
  data: SolveData;
  node: SolveNode;
  path: PathStep[];
  /** Board cards dealt at the current node (flop + any runouts taken). */
  boardCards: Card[];
  selectedCombo: string | null;
  onSelectCombo: (combo: string) => void;
}

const PLAYERS: Player[] = ['OOP', 'IP'];
const LIST_CAP = 60;
const EV_BUCKETS = 10;

interface CategoryAgg {
  reach: number;
  combos: number;
  /** Actor's action split inside the category, starting-weight summed
   *  frequencies (the Matrix convention) — divide by splitWeight. */
  splitWeighted: number[];
  splitWeight: number;
}

interface PlayerModel {
  player: Player;
  live: LiveCombo[];
  startCombos: number;
  totalReach: number;
  /** Reach at this node as a share of the starting range's weight. */
  shareOfStart: number;
  /** Whole-solve range EV (rangeEv — starting-weight average). */
  rangeEvWhole: number;
  /** Reach-weighted mean of the live combos' whole-solve EVs. */
  liveEvMean: number | null;
  categories: Map<HandCategory, CategoryAgg>;
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

function buildModel(
  data: SolveData,
  path: PathStep[],
  node: SolveNode,
  boardCards: Card[],
  player: Player,
): PlayerModel {
  const live = liveRange(data, path, player);
  let startWeight = 0;
  for (const w of data.weights[player].values()) startWeight += w;
  const totalReach = live.reduce((a, c) => a + c.reach, 0);

  let evReach = 0;
  let evWeighted = 0;
  for (const c of live) {
    if (c.ev === null) continue;
    evReach += c.reach;
    evWeighted += c.reach * c.ev;
  }

  const isActor = node.player === player;
  const categories = new Map<HandCategory, CategoryAgg>();
  for (const c of live) {
    const cards = parseCombo(c.combo);
    if (!cards) continue;
    const cat = classifyOmahaHand(cards, boardCards);
    const agg = categories.get(cat) ?? {
      reach: 0,
      combos: 0,
      splitWeighted: node.actions.map(() => 0),
      splitWeight: 0,
    };
    agg.reach += c.reach;
    agg.combos += 1;
    if (isActor) {
      const freqs = node.strategy[c.combo] ?? [];
      agg.splitWeight += c.weight;
      freqs.forEach((f, i) => {
        agg.splitWeighted[i] = (agg.splitWeighted[i] ?? 0) + c.weight * f;
      });
    }
    categories.set(cat, agg);
  }

  return {
    player,
    live,
    startCombos: data.weights[player].size,
    totalReach,
    shareOfStart: startWeight === 0 ? 0 : totalReach / startWeight,
    rangeEvWhole: rangeEv(data, player),
    liveEvMean: evReach === 0 ? null : evWeighted / evReach,
    categories,
  };
}

function PlayerPanel({
  data,
  node,
  model,
}: {
  data: SolveData;
  node: SolveNode;
  model: PlayerModel;
}) {
  const isActor = node.player === model.player;
  const split = useMemo(
    () => (isActor ? aggregateFrequencies(data, node) : []),
    [data, node, isActor],
  );
  return (
    <section
      aria-label={`${model.player} range at this node`}
      className="rounded-lg border border-navy-700 bg-navy-850 p-3"
    >
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-bold text-ink">{model.player}</h4>
        {isActor ? (
          <span className="rounded-full bg-table px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
            To act
          </span>
        ) : null}
        <span className="num ml-auto font-mono text-xs text-ink-dim">
          EV (whole solve) {model.rangeEvWhole.toFixed(2)}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="text-ink-faint">Live combos</dt>
          <dd className="num font-mono text-sm text-ink">
            {model.live.length} of {model.startCombos}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint">Share of range</dt>
          <dd className="num font-mono text-sm text-ink">{pctText(model.shareOfStart)}</dd>
        </div>
        <div>
          <dt className="text-ink-faint">Mean EV, live</dt>
          <dd className="num font-mono text-sm text-ink">
            {model.liveEvMean === null ? '—' : model.liveEvMean.toFixed(2)}
          </dd>
        </div>
      </dl>
      {isActor ? (
        <div className="mt-2.5">
          <div className="overflow-hidden rounded-full">
            <SplitBar segments={splitSegments(node.actions, split)} height="h-3" />
          </div>
          <p className="mt-1.5 text-xs text-ink-dim">{splitSummary(node.actions, split)}</p>
        </div>
      ) : (
        <p className="mt-2.5 text-xs leading-relaxed text-ink-faint">
          {model.player} is not to act at this node, so they have no action split here — their
          split appears when the line reaches one of their decision nodes.
        </p>
      )}
    </section>
  );
}

function EvChart({ models }: { models: PlayerModel[] }) {
  const { min, max, bucketsByPlayer, peak } = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const m of models) {
      for (const c of m.live) {
        if (c.ev === null) continue;
        if (c.ev < lo) lo = c.ev;
        if (c.ev > hi) hi = c.ev;
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      return { min: 0, max: 0, bucketsByPlayer: new Map<Player, number[]>(), peak: 0 };
    }
    const span = hi - lo;
    const bucketsByPlayer = new Map<Player, number[]>();
    let peakReach = 0;
    for (const m of models) {
      const buckets = new Array<number>(EV_BUCKETS).fill(0);
      for (const c of m.live) {
        if (c.ev === null) continue;
        const idx =
          span <= 0
            ? 0
            : Math.min(EV_BUCKETS - 1, Math.floor(((c.ev - lo) / span) * EV_BUCKETS));
        const next = (buckets[idx] ?? 0) + c.reach;
        buckets[idx] = next;
        if (next > peakReach) peakReach = next;
      }
      bucketsByPlayer.set(m.player, buckets);
    }
    return { min: lo, max: hi, bucketsByPlayer, peak: peakReach };
  }, [models]);

  if (peak === 0) {
    return (
      <p className="text-sm text-ink-dim">
        The payload carries no per-combo EVs for the live ranges, so there is no EV distribution
        to chart at this node.
      </p>
    );
  }
  const span = max - min;
  return (
    <div className="flex flex-col gap-3">
      {models.map((m) => {
        const buckets = bucketsByPlayer.get(m.player) ?? [];
        return (
          <div key={m.player}>
            <div className="flex items-baseline gap-2 text-xs">
              <span className="font-semibold text-ink">{m.player}</span>
              <span className="text-ink-faint">
                reach-weighted share of live combos per EV band
              </span>
              <span className="num ml-auto font-mono text-ink-dim">
                mean {m.liveEvMean === null ? '—' : m.liveEvMean.toFixed(2)}
              </span>
            </div>
            <div
              className="mt-1 flex h-24 items-end gap-[2px]"
              role="img"
              aria-label={`${m.player} whole-solve EV distribution: bands from ${min.toFixed(1)} to ${max.toFixed(1)} chips, mean ${m.liveEvMean === null ? 'unknown' : m.liveEvMean.toFixed(2)}`}
            >
              {buckets.map((reach, i) => {
                const bandLo = min + (span * i) / EV_BUCKETS;
                const bandHi = min + (span * (i + 1)) / EV_BUCKETS;
                return (
                  <div
                    key={i}
                    className={`min-w-0 flex-1 rounded-t-sm ${
                      m.player === 'OOP' ? 'bg-table' : 'bg-accent'
                    }`}
                    style={{
                      height: reach > 0 ? `${Math.max(2, (reach / peak) * 100)}%` : '0%',
                    }}
                    title={`${bandLo.toFixed(1)} to ${bandHi.toFixed(1)} chips: ${pctText(
                      m.totalReach === 0 ? 0 : reach / m.totalReach,
                    )} of the live range`}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="num flex justify-between font-mono text-[11px] text-ink-faint">
        <span>{min.toFixed(1)}</span>
        <span>Whole-solve EV (chips)</span>
        <span>{max.toFixed(1)}</span>
      </div>
    </div>
  );
}

function HandTable({
  node,
  model,
  selectedCombo,
  onSelectCombo,
}: {
  node: SolveNode;
  model: PlayerModel;
  selectedCombo: string | null;
  onSelectCombo: (combo: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const isActor = node.player === model.player;
  // Per-action EVs (issue #8) exist only for the player to act — their
  // actions are the node's actions — so only the acting player's table
  // gains the EV (node) column, and only when this node carries them.
  const hasActionEvs = useMemo(
    () => isActor && nodeHasActionEvs(node),
    [isActor, node],
  );
  const rows = useMemo(() => {
    const sorted = [...model.live];
    sorted.sort((a, b) => {
      // Whole-solve EV descending, combos without an EV last (the
      // StrategyTables convention), then reach descending.
      if (a.ev === null && b.ev === null) return b.reach - a.reach;
      if (a.ev === null) return 1;
      if (b.ev === null) return -1;
      return b.ev - a.ev || b.reach - a.reach;
    });
    return sorted;
  }, [model]);
  const visible = expanded ? rows : rows.slice(0, LIST_CAP);

  return (
    <section
      aria-label={`${model.player} live combos by whole-solve EV`}
      className="overflow-hidden rounded-lg border border-navy-700 bg-navy-900 shadow-panel"
    >
      <header className="flex items-baseline justify-between gap-2 bg-navy-850 px-3 py-2">
        <h4 className="text-sm font-bold text-ink">{model.player}</h4>
        <span className="num font-mono text-xs text-ink-dim">{rows.length} live combos</span>
      </header>
      {rows.length === 0 ? (
        <p className="px-3 py-2.5 text-sm text-ink-dim">
          No combos of this range are still live at this node.
        </p>
      ) : (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-navy-700 text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th scope="col" className="px-3 py-1.5 font-semibold">
                  Hand
                </th>
                <th scope="col" className="num px-2 py-1.5 text-right font-semibold">
                  EV (solve)
                </th>
                {hasActionEvs ? (
                  <th
                    scope="col"
                    className="num px-2 py-1.5 text-right font-semibold"
                    title="The combo's EV at this node: its per-action EVs weighted by its own frequencies here"
                  >
                    EV (node)
                  </th>
                ) : null}
                <th scope="col" className="num px-2 py-1.5 text-right font-semibold">
                  Weight
                </th>
                <th
                  scope="col"
                  className="num px-2 py-1.5 text-right font-semibold"
                  title="Share of this player's live range arriving at this node (reach-weighted)"
                >
                  Reach
                </th>
                {isActor ? (
                  <th scope="col" className="px-3 py-1.5 text-right font-semibold">
                    Split
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const cards = parseCombo(row.combo);
                const isSel = row.combo === selectedCombo;
                const freqs = isActor ? (node.strategy[row.combo] ?? []) : [];
                const nodeEv = hasActionEvs ? comboNodeEv(node, row.combo) : null;
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
                    <td className="num px-2 py-1.5 text-right font-mono text-ink-dim">
                      {row.ev === null ? '—' : row.ev.toFixed(2)}
                    </td>
                    {hasActionEvs ? (
                      <td className="num px-2 py-1.5 text-right font-mono text-ink-dim">
                        {nodeEv === null ? '—' : nodeEv.toFixed(2)}
                      </td>
                    ) : null}
                    <td className="num px-2 py-1.5 text-right font-mono text-ink-dim">
                      {row.weight.toFixed(2)}
                    </td>
                    <td className="num px-2 py-1.5 text-right font-mono text-ink">
                      {pctText(model.totalReach === 0 ? 0 : row.reach / model.totalReach)}
                    </td>
                    {isActor ? (
                      <td className="px-3 py-1.5">
                        <span className="ml-auto block w-24">
                          <SplitBar
                            segments={splitSegments(node.actions, freqs)}
                            height="h-2.5"
                            className="rounded-full"
                          />
                        </span>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > LIST_CAP ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="w-full px-3 py-1.5 text-xs font-semibold text-table-light hover:bg-navy-850"
            >
              {expanded ? 'Show fewer combos' : `Show all ${rows.length} combos`}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

/**
 * Ranges view (rebrand slice 4, issue #16): both players' ranges at
 * the current node, in the pattern of the captured reference (f23) —
 * a side-by-side Comparison, hand Categories, a range EV chart and
 * hand tables sorted by EV. Everything binds payload data only:
 * a player's range at a node is their starting range reach-weighted
 * down the line taken (see liveRange in solveTree.ts); the acting
 * player's action splits come from the node's own strategy rows;
 * categories are made-hand strength under Omaha rules (exactly two
 * hole cards), computed from the cards themselves. Every EV is
 * labelled by its basis: the chart and the EV (solve) columns are
 * whole-solve EVs, and when the payload carries per-action EVs
 * (issue #8) the acting player's hand table adds an EV (node)
 * column — the combo's own strategy-weighted action EVs at this
 * node. Payloads without the field render exactly as before.
 */
export function RangesView({ data, node, path, boardCards, selectedCombo, onSelectCombo }: Props) {
  const models = useMemo(
    () => PLAYERS.map((p) => buildModel(data, path, node, boardCards, p)),
    [data, path, node, boardCards],
  );
  const actor = node.player;
  const actorHasActionEvs = useMemo(() => nodeHasActionEvs(node), [node]);
  const categoryRows = useMemo(
    () =>
      HAND_CATEGORIES.filter((cat) =>
        models.some((m) => (m.categories.get(cat)?.reach ?? 0) > 0),
      ),
    [models],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Comparison */}
      <div>
        <h3 className="text-sm font-semibold text-ink">Comparison</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          {models.map((m) => (
            <PlayerPanel key={m.player} data={data} node={node} model={m} />
          ))}
        </div>
      </div>

      {/* Categories */}
      <div>
        <h3 className="text-sm font-semibold text-ink">Categories</h3>
        {categoryRows.length === 0 ? (
          <p className="mt-2 text-sm text-ink-dim">No live combos to categorise at this node.</p>
        ) : (
          <div className="mt-2 overflow-hidden rounded-lg border border-navy-700 bg-navy-900 shadow-panel">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-navy-700 text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <th scope="col" className="px-3 py-1.5 font-semibold">
                    Hand type
                  </th>
                  {models.map((m) => (
                    <th
                      key={m.player}
                      scope="col"
                      className="num px-2 py-1.5 text-right font-semibold"
                    >
                      {m.player} weight
                    </th>
                  ))}
                  <th scope="col" className="px-3 py-1.5 text-right font-semibold">
                    {actor} strategy
                  </th>
                </tr>
              </thead>
              <tbody>
                {categoryRows.map((cat) => {
                  const actorAgg = models
                    .find((m) => m.player === actor)
                    ?.categories.get(cat);
                  const actorSplit =
                    actorAgg && actorAgg.splitWeight > 0
                      ? actorAgg.splitWeighted.map((w) => w / actorAgg.splitWeight)
                      : null;
                  return (
                    <tr key={cat} className="border-b border-navy-800 last:border-0">
                      <td className="px-3 py-1.5 font-medium text-ink">{cat}</td>
                      {models.map((m) => {
                        const agg = m.categories.get(cat);
                        return (
                          <td
                            key={m.player}
                            className="num px-2 py-1.5 text-right font-mono text-ink-dim"
                          >
                            {agg
                              ? `${pctText(m.totalReach === 0 ? 0 : agg.reach / m.totalReach)} · ${agg.combos}`
                              : '—'}
                          </td>
                        );
                      })}
                      <td className="px-3 py-1.5">
                        {actorSplit ? (
                          <span
                            className="ml-auto block w-28"
                            title={splitSummary(node.actions, actorSplit)}
                          >
                            <SplitBar
                              segments={splitSegments(node.actions, actorSplit)}
                              height="h-2.5"
                              className="rounded-full"
                            />
                          </span>
                        ) : (
                          <span className="block text-right font-mono text-ink-faint">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-1.5 text-xs leading-relaxed text-ink-faint">
          Weight is the reach-weighted share of each player's live range in the category (share ·
          live combo count). Categories are made-hand strength under Omaha rules — exactly two
          hole cards — so a category is what the combo has made, never a draw; flush draws and
          wraps are in the Matrix tab's filters. "Set" covers all three of a kind.
        </p>
      </div>

      {/* EV chart */}
      <div>
        <h3 className="text-sm font-semibold text-ink">Range EV chart</h3>
        <div className="mt-2 rounded-lg border border-navy-700 bg-navy-900 p-3 shadow-panel">
          <EvChart models={models} />
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-faint">
          Each band is a slice of the whole-solve EV range shared by both players, so the two
          charts are directly comparable. These are whole-solve EVs — the engine reports EV per
          combo for the whole tree, not per node — so this is the distribution of the live
          combos' solve EVs, not a node EV.
        </p>
      </div>

      {/* Hand tables by EV */}
      <div>
        <h3 className="text-sm font-semibold text-ink">Hands by EV</h3>
        <div className="mt-2 flex flex-col gap-3">
          {models.map((m) => (
            <HandTable
              key={m.player}
              node={node}
              model={m}
              selectedCombo={selectedCombo}
              onSelectCombo={onSelectCombo}
            />
          ))}
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-faint">
          Sorted by whole-solve EV, the same "EV (solve)" the Strategy tables show. Reach is a
          combo's share of its player's live range at this node; Weight is its starting range
          weight. Click a row for full hand detail.
          {actorHasActionEvs ? (
            <>
              {' '}
              EV (node), in the {actor} table, is each combo's value at this node — its
              per-action EVs from the solve, weighted by its own strategy here.
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}
