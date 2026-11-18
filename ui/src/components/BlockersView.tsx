import { useMemo, useState } from 'react';
import { parseCard, RANKS_DESC, SUIT_SYMBOL, type Card, type Suit } from '../lib/cards';
import { analyseHand, buildBlockerModel, type CardImpact } from '../lib/blockers';
import type { SolveData, SolveNode } from '../lib/solveTree';
import type { PathStep } from '../store/useStore';
import { actionColor, prettyAction } from './actionStyle';
import { CardPicker } from './CardPicker';
import { CardChip, CardRow, SUIT_COLOR } from './CardChip';
import { FrequencyBar, pctText, SplitBar, type SplitSegment } from './FrequencyBar';

interface Props {
  data: SolveData;
  node: SolveNode;
  path: PathStep[];
  /** Board cards dealt at the current node (flop + any runouts taken). */
  boardCards: Card[];
}

const RANK_CAP = 15;
const HEAT = '#F5A623'; // amber accent — the heat hue for bars and the deck map
const SUIT_ROWS: Suit[] = ['s', 'h', 'd', 'c'];

function splitSegments(actions: string[], split: number[]): SplitSegment[] {
  return actions.map((label, i) => ({
    label: prettyAction(label),
    fraction: split[i] ?? 0,
    color: actionColor(label),
  }));
}

function splitText(actions: string[], split: number[]): string {
  return actions
    .map((label, i) => `${prettyAction(label)} ${pctText(split[i] ?? 0)}`)
    .join(' · ');
}

/** One labelled action-split bar (villain's range, before or after removal). */
function SplitRow({
  label,
  actions,
  split,
}: {
  label: string;
  actions: string[];
  split: number[] | null;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-ink">{label}</span>
        <span className="text-xs text-ink-dim">
          {split ? splitText(actions, split) : 'No combos survive'}
        </span>
      </div>
      {split ? (
        <div className="h-3 overflow-hidden rounded bg-navy-800">
          <SplitBar segments={splitSegments(actions, split)} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Blockers tab (rebrand slice 6, issue #18): pick your hand as the
 * player NOT to act and see what it does to the range of the player
 * who IS — how much of their live range your cards remove, and how
 * their strategy at this node shifts over the combos that survive.
 * All of it is card-removal arithmetic over the stored solve (see
 * lib/blockers.ts); nothing is re-solved and nothing is estimated.
 */
export function BlockersView({ data, node, path, boardCards }: Props) {
  const [heroHand, setHeroHand] = useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [handFull, setHandFull] = useState(false);

  const model = useMemo(
    () => buildBlockerModel(data, path, node, boardCards),
    [data, path, node, boardCards],
  );
  const removal = useMemo(
    () => (heroHand.length > 0 ? analyseHand(model, heroHand) : null),
    [model, heroHand],
  );

  const boardLabels = useMemo(() => new Set(boardCards.map((c) => c.label)), [boardCards]);
  const heroCards = heroHand
    .map((label) => parseCard(label))
    .filter((c): c is Card => c !== null);
  const impactByLabel = useMemo(
    () => new Map(model.impacts.map((im) => [im.card.label, im])),
    [model.impacts],
  );

  const toggleCard = (label: string) => {
    if (heroHand.includes(label)) {
      setHandFull(false);
      setHeroHand(heroHand.filter((l) => l !== label));
    } else if (heroHand.length >= 4) {
      setHandFull(true);
    } else {
      setHandFull(false);
      setHeroHand([...heroHand, label]);
    }
  };

  const ranked = showAll ? model.impacts : model.impacts.slice(0, RANK_CAP);

  const deltas =
    removal?.splitAfter != null
      ? node.actions
          .map((label, i) => ({
            label,
            before: model.splitBefore[i] ?? 0,
            after: removal.splitAfter?.[i] ?? 0,
          }))
          .filter((d) => Math.abs(d.after - d.before) >= 0.005)
      : [];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-dim">
        You are <span className="font-semibold text-ink">{model.hero}</span> —{' '}
        <span className="font-semibold text-ink">{model.villain}</span> is to act with{' '}
        {model.live.length.toLocaleString()} live combos at this node. Pick your hand and every{' '}
        {model.villain} combo holding one of your cards is impossible: see how much of their range
        that removes, and how their strategy shifts over what survives.
      </p>

      {/* Your hand */}
      <section aria-label="Your hand" className="rounded-lg border border-navy-700 bg-navy-850 p-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="text-sm font-semibold text-ink">Your hand ({model.hero})</h3>
          <div className="flex items-center gap-1" aria-label="Picked cards">
            {heroCards.length > 0 ? <CardRow cards={heroCards} size="md" /> : null}
            {Array.from({ length: 4 - heroCards.length }).map((_, i) => (
              <span
                key={i}
                aria-hidden="true"
                className="inline-flex h-11 w-9 items-center justify-center rounded-md border border-dashed border-navy-600 text-sm text-ink-faint"
              >
                +
              </span>
            ))}
          </div>
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="rounded-md bg-table px-3 py-1.5 text-xs font-semibold text-white hover:bg-table-dark"
            >
              {heroCards.length > 0 ? 'Edit hand' : 'Pick your hand'}
            </button>
            {heroCards.length > 0 ? (
              <button
                type="button"
                onClick={() => setHeroHand([])}
                className="rounded-md bg-navy-800 px-3 py-1.5 text-xs font-semibold text-ink-dim hover:text-ink"
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>
        {handFull ? (
          <p className="mt-2 text-xs text-accent">
            Your hand is full — remove a card (click it in the deck map or the picker) before
            adding another.
          </p>
        ) : null}

        {removal ? (
          <div className="mt-3 flex flex-col gap-3 border-t border-navy-700 pt-3">
            <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <div className="rounded-md bg-navy-900 px-2 py-1.5">
                <dt className="text-ink-faint">Combos removed</dt>
                <dd className="num font-mono text-sm text-ink">
                  {removal.removedCombos.toLocaleString()} of {model.live.length.toLocaleString()}
                </dd>
              </div>
              <div className="rounded-md bg-navy-900 px-2 py-1.5">
                <dt className="text-ink-faint">Range removed (by reach)</dt>
                <dd className="num font-mono text-sm text-ink">{pctText(removal.removedShare)}</dd>
              </div>
              <div className="rounded-md bg-navy-900 px-2 py-1.5">
                <dt className="text-ink-faint">Combos surviving</dt>
                <dd className="num font-mono text-sm text-ink">
                  {removal.survivingCombos.toLocaleString()}
                </dd>
              </div>
              <div className="rounded-md bg-navy-900 px-2 py-1.5">
                <dt className="text-ink-faint">Range surviving (by reach)</dt>
                <dd className="num font-mono text-sm text-ink">
                  {pctText(removal.survivingShare)}
                </dd>
              </div>
            </dl>

            <SplitRow
              label={`${model.villain} split — full live range`}
              actions={node.actions}
              split={model.splitBefore}
            />
            <SplitRow
              label={`${model.villain} split — holding your hand`}
              actions={node.actions}
              split={removal.splitAfter}
            />
            <p className="text-xs text-ink-dim">
              {deltas.length > 0
                ? `How the split moves: ${deltas
                    .map(
                      (d) =>
                        `${prettyAction(d.label)} ${pctText(d.before)} → ${pctText(d.after)}`,
                    )
                    .join(' · ')}`
                : 'No action share moves by half a point or more.'}
            </p>

            {removal.perCard.length > 0 ? (
              <div>
                <h4 className="mb-1.5 text-xs font-semibold text-ink">
                  Card by card (each card on its own)
                </h4>
                <ul className="flex flex-col gap-1.5">
                  {removal.perCard.map((im: CardImpact) => (
                    <li key={im.card.label} className="flex items-center gap-2">
                      <CardChip card={im.card} size="sm" />
                      <span className="num w-16 font-mono text-xs text-ink">
                        {pctText(im.removedShare)}
                      </span>
                      <span className="text-xs text-ink-dim">
                        removes {im.removedCombos.toLocaleString()} combos
                      </span>
                      <span className="block flex-1">
                        <FrequencyBar fraction={im.removedShare} color={HEAT} height="h-2" />
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1.5 text-xs text-ink-faint">
                  Per-card figures overlap: a {model.villain} combo holding two of your cards
                  counts under each of them. The totals above are the union — each combo removed
                  once.
                </p>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="mt-3 border-t border-navy-700 pt-3 text-sm text-ink-dim">
            No hand picked yet. Pick your 4 cards — or click cards in the deck heatmap below — to
            see exactly what your hand removes from {model.villain}&rsquo;s range. The ranked list
            and the heatmap work either way: they are per-card.
          </p>
        )}
      </section>

      {/* Ranked list */}
      <section aria-label="Cards ranked by blocker effect" className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-ink">
          Ranked blockers — single card vs {model.villain}&rsquo;s live range
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-navy-700 text-ink-faint">
                <th scope="col" className="py-1 pr-2 font-medium">#</th>
                <th scope="col" className="py-1 pr-2 font-medium">Card</th>
                <th scope="col" className="py-1 pr-2 font-medium">Range removed</th>
                <th scope="col" className="py-1 pr-2 font-medium">Combos</th>
                <th scope="col" className="py-1 font-medium">
                  {model.villain} split over what survives
                </th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((im, idx) => {
                const inHand = heroHand.includes(im.card.label);
                return (
                  <tr key={im.card.label} className="border-b border-navy-800 align-middle">
                    <td className="num py-1.5 pr-2 font-mono text-ink-faint">{idx + 1}</td>
                    <td className="py-1.5 pr-2">
                      <span className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => toggleCard(im.card.label)}
                          aria-pressed={inHand}
                          aria-label={`${inHand ? 'Remove' : 'Add'} ${im.card.label} ${
                            inHand ? 'from' : 'to'
                          } your hand`}
                          className={`flex rounded-md ${inHand ? 'ring-2 ring-accent' : 'hover:scale-105'}`}
                        >
                          <CardChip card={im.card} size="sm" className="pointer-events-none" />
                        </button>
                        {inHand ? (
                          <span className="rounded-full bg-navy-800 px-2 py-0.5 text-[10px] font-semibold text-accent">
                            in your hand
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td className="py-1.5 pr-2">
                      <span className="flex items-center gap-2">
                        <span className="num w-12 font-mono text-ink">
                          {pctText(im.removedShare)}
                        </span>
                        <span className="block w-20">
                          <FrequencyBar fraction={im.removedShare} color={HEAT} height="h-2" />
                        </span>
                      </span>
                    </td>
                    <td className="num py-1.5 pr-2 font-mono text-ink-dim">
                      {im.removedCombos.toLocaleString()}
                    </td>
                    <td className="py-1.5">
                      {im.continuingSplit ? (
                        <div className="h-2.5 w-44 overflow-hidden rounded bg-navy-800">
                          <SplitBar
                            segments={splitSegments(node.actions, im.continuingSplit)}
                          />
                        </div>
                      ) : (
                        <span className="text-ink-faint">no combos survive</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {model.impacts.length > RANK_CAP ? (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="self-start rounded px-1.5 py-0.5 text-xs text-ink-dim hover:bg-navy-800 hover:text-ink"
          >
            {showAll
              ? `Show top ${RANK_CAP} only`
              : `Show all ${model.impacts.length} cards`}
          </button>
        ) : null}
      </section>

      {/* Deck heatmap */}
      <section aria-label="Deck heatmap" className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-ink">
          Deck heatmap — click a card to add or remove it from your hand
        </h3>
        <div className="flex flex-col gap-1.5">
          {SUIT_ROWS.map((suit) => (
            <div key={suit} className="flex items-center gap-1.5">
              <span
                className="w-5 shrink-0 text-center text-sm"
                style={{ color: SUIT_COLOR[suit] }}
                aria-hidden="true"
              >
                {SUIT_SYMBOL[suit]}
              </span>
              <div
                className="grid flex-1 gap-1"
                style={{ gridTemplateColumns: 'repeat(13, minmax(0, 1fr))' }}
              >
                {RANKS_DESC.map((rank) => {
                  const label = `${rank}${suit}`;
                  const card: Card = { rank, suit, label };
                  if (boardLabels.has(label)) {
                    return (
                      <span
                        key={label}
                        title={`${label} — on the board`}
                        className="flex h-10 items-center justify-center rounded-md border border-navy-800 text-[10px] font-semibold text-ink-faint opacity-35"
                      >
                        {rank}
                        {SUIT_SYMBOL[suit]}
                      </span>
                    );
                  }
                  const im = impactByLabel.get(label);
                  const share = im?.removedShare ?? 0;
                  const heat =
                    model.maxShare > 0 ? 0.06 + 0.84 * (share / model.maxShare) : 0.06;
                  const inHand = heroHand.includes(label);
                  return (
                    <button
                      key={label}
                      type="button"
                      onClick={() => toggleCard(label)}
                      aria-pressed={inHand}
                      aria-label={`${label}: removes ${pctText(share)} of ${model.villain}'s live range${
                        inHand ? ' — in your hand, click to remove' : ' — click to add to your hand'
                      }`}
                      title={`${label} — removes ${pctText(share)} (${im?.removedCombos.toLocaleString() ?? 0} combos)`}
                      className={`flex h-10 flex-col items-center justify-center rounded-md border border-black/30 leading-none transition-transform ${
                        inHand ? 'ring-2 ring-accent' : 'hover:scale-105'
                      }`}
                      style={{
                        backgroundColor: `rgba(245, 166, 35, ${heat.toFixed(3)})`,
                        color: heat > 0.5 ? '#0A1628' : undefined,
                      }}
                    >
                      <span className="text-[11px] font-bold">
                        {rank}
                        {SUIT_SYMBOL[suit]}
                      </span>
                      <span className="num mt-0.5 font-mono text-[9px]">
                        {(share * 100).toFixed(1)}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-ink-faint">
          Cell number = % of {model.villain}&rsquo;s live range that single card removes; shading
          is scaled to the strongest card at this node. Board cards are dead for every combo and
          are shown dimmed.
        </p>
      </section>

      <p className="text-xs text-ink-faint">
        Ranked by the reach-weighted share of {model.villain}&rsquo;s live range each card removes
        at this node — reach is each combo&rsquo;s stored weight times how often it takes the
        actions on the line you walked. Removal is exact from the loaded solve: no re-solving, no
        estimates. An EV-weighted ranking (&ldquo;which blocker is worth the most&rdquo;) needs
        per-action EVs, which the solve file does not carry yet — that is issue #8, so it is not
        shown rather than faked.
      </p>

      {pickerOpen ? (
        <CardPicker
          title={`Your hand — you are ${model.hero}`}
          caption={`Pick up to 4 cards. Board cards are dimmed: they are already dead for every ${model.villain} combo. Picks apply immediately; click a picked card again to remove it.`}
          deadCards={boardCards.map((c) => c.label)}
          selected={heroHand}
          onPick={toggleCard}
          onClear={() => setHeroHand([])}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}
