import { useMemo } from 'react';
import { parseCombo, type Card } from '../lib/cards';
import { classifyOmahaHand, HAND_CATEGORIES, type HandCategory } from '../lib/handCategories';
import { liveRange, type SolveData, type SolveNode } from '../lib/solveTree';
import type { Player } from '../lib/types';
import type { PathStep } from '../store/useStore';
import { actionColor, prettyAction } from './actionStyle';
import { FrequencyBar, pctText, SplitBar, type SplitSegment } from './FrequencyBar';

// Right-rail summary sections for the Explorer (rebrand slice 5,
// issue #17), in the pattern of the captured reference's rail tabs
// (f23 Categories, f30 EV Buckets) but as rail sections, following
// this rail's own section conventions. Both sections re-derive from
// the payload on every node walk, exactly like the other rail
// sections: a player's range at a node is their starting range
// reach-weighted down the line taken (liveRange in solveTree.ts),
// and categories are the shared Omaha made-hand classifier
// (handCategories.ts — the same one the Ranges tab uses, so the rail
// and the tab can never disagree).

interface RailProps {
  data: SolveData;
  node: SolveNode;
  path: PathStep[];
  /** Board cards dealt at the current node (flop + any runouts taken). */
  boardCards: Card[];
}

const PLAYER_COLOR: Record<Player, string> = {
  OOP: '#2E9E6B', // table green — the Ranges EV chart's OOP colour
  IP: '#F5A623', // amber accent — the Ranges EV chart's IP colour
};

const SECTION_CLASS = 'rounded-lg border border-navy-700 bg-navy-900 p-3 shadow-panel';
const HEADING_CLASS = 'mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint';

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

interface CategoryShare {
  category: HandCategory;
  /** Reach-weighted share of the player's live range, 0..1. */
  share: number;
  combos: number;
  /**
   * The acting player's action split inside the category (fractions
   * summing to ~1), or null for the other player, who has no strategy
   * at this node.
   */
  split: number[] | null;
}

interface PlayerCategories {
  player: Player;
  isActor: boolean;
  liveCombos: number;
  rows: CategoryShare[];
}

function playerCategories(
  data: SolveData,
  path: PathStep[],
  node: SolveNode,
  boardCards: Card[],
  player: Player,
): PlayerCategories {
  const live = liveRange(data, path, player);
  const totalReach = live.reduce((a, c) => a + c.reach, 0);
  const isActor = node.player === player;

  const byCategory = new Map<
    HandCategory,
    { reach: number; combos: number; splitWeighted: number[]; splitWeight: number }
  >();
  for (const c of live) {
    const cards = parseCombo(c.combo);
    if (!cards) continue;
    const cat = classifyOmahaHand(cards, boardCards);
    const agg = byCategory.get(cat) ?? {
      reach: 0,
      combos: 0,
      splitWeighted: node.actions.map(() => 0),
      splitWeight: 0,
    };
    agg.reach += c.reach;
    agg.combos += 1;
    if (isActor) {
      // The Matrix convention (as in the Ranges tab): a category's
      // strategy split is its combos' frequencies summed over
      // starting range weights.
      const freqs = node.strategy[c.combo] ?? [];
      agg.splitWeight += c.weight;
      freqs.forEach((f, i) => {
        agg.splitWeighted[i] = (agg.splitWeighted[i] ?? 0) + c.weight * f;
      });
    }
    byCategory.set(cat, agg);
  }

  const rows: CategoryShare[] = [];
  for (const cat of HAND_CATEGORIES) {
    const agg = byCategory.get(cat);
    if (!agg || agg.reach <= 0) continue;
    rows.push({
      category: cat,
      share: totalReach === 0 ? 0 : agg.reach / totalReach,
      combos: agg.combos,
      split:
        isActor && agg.splitWeight > 0
          ? agg.splitWeighted.map((w) => w / agg.splitWeight)
          : null,
    });
  }
  return { player, isActor, liveCombos: live.length, rows };
}

function splitSummary(actions: string[], splits: number[]): string {
  return actions
    .map((label, i) => `${prettyAction(label)} ${pctText(splits[i] ?? 0)}`)
    .join(', ');
}

function CategoryBar({
  row,
  node,
  player,
}: {
  row: CategoryShare;
  node: SolveNode;
  player: Player;
}) {
  // One bar per category whose total width is the whole live range:
  // the filled part is the category's reach-weighted share, and for
  // the acting player the fill itself is split by their strategy
  // inside the category (the f23 segmented-bar pattern).
  const segments: SplitSegment[] | null = row.split
    ? node.actions.map((label, i) => ({
        label: prettyAction(label),
        fraction: row.split?.[i] ?? 0,
        color: actionColor(label),
      }))
    : null;
  const aria =
    `${row.category}: ${pctText(row.share)} of the live range` +
    (segments && row.split
      ? `; strategy in this category: ${splitSummary(node.actions, row.split)}`
      : '');
  return (
    <div
      className="h-2.5 w-full overflow-hidden rounded-full bg-navy-800"
      role="img"
      aria-label={aria}
      title={aria}
    >
      <div className="h-full" style={{ width: `${row.share * 100}%` }}>
        {segments ? (
          <SplitBar segments={segments} height="h-full" />
        ) : (
          <div
            className="h-full w-full"
            style={{ backgroundColor: PLAYER_COLOR[player] }}
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  );
}

export function CategoriesRail({ data, node, path, boardCards }: RailProps) {
  const actor = node.player;
  const other: Player = actor === 'OOP' ? 'IP' : 'OOP';
  const models = useMemo(
    () => [actor, other].map((p) => playerCategories(data, path, node, boardCards, p)),
    [data, path, node, boardCards, actor, other],
  );
  return (
    <section aria-label="Hand categories at this node" className={SECTION_CLASS}>
      <h2 className={HEADING_CLASS}>Categories</h2>
      <div className="flex flex-col gap-3">
        {models.map((m) => (
          <div key={m.player}>
            <div className="mb-1.5 flex items-center gap-2">
              <h3 className="text-xs font-bold text-ink">{m.player}</h3>
              {m.isActor ? (
                <span className="rounded-full bg-table px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                  To act
                </span>
              ) : null}
              <span className="num ml-auto font-mono text-[11px] text-ink-faint">
                {m.liveCombos} live combos
              </span>
            </div>
            {m.rows.length === 0 ? (
              <p className="text-xs text-ink-faint">No live combos at this node.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {m.rows.map((row) => (
                  <div key={row.category}>
                    <div className="mb-0.5 flex items-baseline justify-between gap-2">
                      <span className="text-xs text-ink">{row.category}</span>
                      <span className="num font-mono text-xs text-ink-dim">
                        {pctText(row.share)}{' '}
                        <span className="text-ink-faint">· {row.combos}</span>
                      </span>
                    </div>
                    <CategoryBar row={row} node={node} player={m.player} />
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="mt-2 text-xs leading-relaxed text-ink-faint">
        Made-hand categories under Omaha rules — exactly two hole cards — reach-weighted at this
        node. The acting player's bars are split by their strategy in the category. The full
        breakdown is in the Ranges tab.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// EV Buckets
// ---------------------------------------------------------------------------

const BUCKETS = [
  { key: 'best', label: 'Best', color: '#3FBF82' },
  { key: 'good', label: 'Good', color: '#2E9E6B' },
  { key: 'weak', label: 'Weak', color: '#F5A623' },
  { key: 'trash', label: 'Trash', color: '#B4463F' },
] as const;

interface BucketModel {
  kind: 'ok' | 'no-live' | 'no-ev' | 'degenerate';
  /** Reach-weighted share per bucket (BUCKETS order), over combos carrying an EV. */
  shares: number[];
  /** Reach-weighted mean whole-solve EV of the live combos carrying an EV. */
  mean: number;
  /** Lower EV bound of the Best / Good / Weak bands. */
  cuts: { best: number; good: number; weak: number } | null;
  /** What the cuts are fractions of: the live range's mean EV, or its best EV. */
  basis: 'mean' | 'max';
  /** Share of the live range's reach that carries a stored EV, 0..1. */
  coverage: number;
}

/**
 * The band rule (also written up in RAIL-NOTES.md): the reference
 * shows Best / Good / Weak / Trash shares that vary from spot to
 * spot, so the cuts cannot be fixed percentiles — a percentile cut
 * would force near-identical shares everywhere. Instead the cuts are
 * fractions of the range's own reach-weighted mean whole-solve EV
 * (μ): Best ≥ μ, Good ≥ 0.75μ, Weak ≥ 0.25μ, Trash below 0.25μ — a
 * hand is "Best" when it is worth at least the average hand in the
 * range. When μ is not positive the same shape is taken from the
 * best live EV instead (0.75 / 0.5 / 0.25 of it); when even that is
 * not positive the range cannot be separated and we say so.
 */
function bucketModel(data: SolveData, path: PathStep[], player: Player): BucketModel {
  const empty: BucketModel = {
    kind: 'no-live',
    shares: [0, 0, 0, 0],
    mean: 0,
    cuts: null,
    basis: 'mean',
    coverage: 0,
  };
  const live = liveRange(data, path, player);
  if (live.length === 0) return empty;

  const totalReach = live.reduce((a, c) => a + c.reach, 0);
  const withEv = live.filter((c) => c.ev !== null);
  const evReach = withEv.reduce((a, c) => a + c.reach, 0);
  if (withEv.length === 0 || evReach === 0) {
    return { ...empty, kind: 'no-ev' };
  }
  const coverage = totalReach === 0 ? 0 : evReach / totalReach;
  const mean = withEv.reduce((a, c) => a + c.reach * (c.ev ?? 0), 0) / evReach;

  let cuts: { best: number; good: number; weak: number };
  let basis: 'mean' | 'max';
  if (mean > 0) {
    cuts = { best: mean, good: 0.75 * mean, weak: 0.25 * mean };
    basis = 'mean';
  } else {
    let max = -Infinity;
    for (const c of withEv) {
      const ev = c.ev ?? -Infinity;
      if (ev > max) max = ev;
    }
    if (!(max > 0)) return { ...empty, kind: 'degenerate', mean, coverage };
    cuts = { best: 0.75 * max, good: 0.5 * max, weak: 0.25 * max };
    basis = 'max';
  }

  const reachByBucket = [0, 0, 0, 0];
  for (const c of withEv) {
    const ev = c.ev ?? 0;
    const idx = ev >= cuts.best ? 0 : ev >= cuts.good ? 1 : ev >= cuts.weak ? 2 : 3;
    reachByBucket[idx] = (reachByBucket[idx] ?? 0) + c.reach;
  }
  return {
    kind: 'ok',
    shares: reachByBucket.map((r) => r / evReach),
    mean,
    cuts,
    basis,
    coverage,
  };
}

export function EvBucketsRail({ data, node, path }: Omit<RailProps, 'boardCards'>) {
  const actor = node.player;
  const model = useMemo(() => bucketModel(data, path, actor), [data, path, actor]);
  return (
    <section aria-label="EV buckets at this node" className={SECTION_CLASS}>
      <h2 className={HEADING_CLASS}>EV Buckets</h2>
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded-full bg-table px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
          {actor} to act
        </span>
        <span className="text-xs text-ink-faint">live range by whole-solve EV</span>
      </div>
      {model.kind === 'no-live' ? (
        <p className="text-xs leading-relaxed text-ink-dim">
          No combos of {actor}'s range are still live at this node.
        </p>
      ) : model.kind === 'no-ev' ? (
        <p className="text-xs leading-relaxed text-ink-dim">
          This solve carries no per-combo EVs, so there are no EV buckets to show — the buckets
          are built from the whole-solve EV stored for each combo.
        </p>
      ) : model.kind === 'degenerate' || !model.cuts ? (
        <p className="text-xs leading-relaxed text-ink-dim">
          Every live combo's whole-solve EV is zero or less, so EV buckets would not separate
          this range.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            {BUCKETS.map((b, i) => {
              const share = model.shares[i] ?? 0;
              return (
                <div key={b.key}>
                  <div className="mb-0.5 flex items-baseline justify-between gap-2">
                    <span className="text-xs text-ink">{b.label}</span>
                    <span className="num font-mono text-xs text-ink-dim">{pctText(share)}</span>
                  </div>
                  <FrequencyBar fraction={share} color={b.color} height="h-2.5" />
                </div>
              );
            })}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-ink-faint">
            Whole-solve EV of the combos still live at this node — the same "EV (solve)" as the
            Strategy tables, not a per-node EV; per-node buckets arrive with per-action EVs
            (issue #8). Bands are set from this range's own distribution:{' '}
            {model.basis === 'mean' ? (
              <>
                Best ≥ {model.cuts.best.toFixed(1)}, Good ≥ {model.cuts.good.toFixed(1)}, Weak ≥{' '}
                {model.cuts.weak.toFixed(1)}, Trash below — 1× / 0.75× / 0.25× the reach-weighted
                mean EV ({model.mean.toFixed(1)}).
              </>
            ) : (
              <>
                Best ≥ {model.cuts.best.toFixed(1)}, Good ≥ {model.cuts.good.toFixed(1)}, Weak ≥{' '}
                {model.cuts.weak.toFixed(1)}, Trash below — fractions of the best live EV, since
                the mean EV is not positive.
              </>
            )}
            {model.coverage < 0.999 ? (
              <>
                {' '}
                Combos with no stored EV ({pctText(1 - model.coverage)} of the live range) are
                left unbucketed.
              </>
            ) : null}
          </p>
        </>
      )}
    </section>
  );
}
