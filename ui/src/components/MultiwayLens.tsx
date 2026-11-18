import { useEffect, useState } from 'react';
import { fetchMultiwayEquity } from '../lib/api';
import { formatCards, parseCombo, type Card } from '../lib/cards';
import type {
  MultiwayEquityRequest,
  MultiwayEquityResponse,
} from '../lib/types';
import { ApproximationBadge, MultiwayEquityBadge } from './AccuracyBadge';
import { CardRow } from './CardChip';
import { FrequencyBar, pctText } from './FrequencyBar';

interface OpponentSlot {
  id: number;
  mode: 'random' | 'text';
  text: string;
}

interface Props {
  boardCards: Card[];
  selectedCombo: string | null;
  /** Optional solver range entries at the current node ("Combo:weight" lines) for Hero range mode. */
  nodeRangeText?: string;
}

const MAX_OPPONENTS = 4;
const MIN_OPPONENTS = 1;

export function MultiwayLens({ boardCards, selectedCombo, nodeRangeText }: Props) {
  const [isOpen, setIsOpen] = useState(true);
  const [heroMode, setHeroMode] = useState<'hand' | 'range'>('hand');
  const [heroRangeText, setHeroRangeText] = useState<string>('');
  const [opponents, setOpponents] = useState<OpponentSlot[]>([
    { id: 1, mode: 'random', text: '' },
    { id: 2, mode: 'random', text: '' },
  ]);
  const [nextId, setNextId] = useState(3);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MultiwayEquityResponse | null>(null);

  const boardString = formatCards(boardCards);

  // Clear stale results/errors when board or hero selection changes
  useEffect(() => {
    setResult(null);
    setError(null);
  }, [boardString, selectedCombo, heroMode]);

  function addOpponent() {
    if (opponents.length >= MAX_OPPONENTS) return;
    setOpponents((prev) => [...prev, { id: nextId, mode: 'random', text: '' }]);
    setNextId((n) => n + 1);
    setResult(null);
  }

  function removeOpponent(id: number) {
    if (opponents.length <= MIN_OPPONENTS) return;
    setOpponents((prev) => prev.filter((o) => o.id !== id));
    setResult(null);
  }

  function updateOpponent(id: number, patch: Partial<OpponentSlot>) {
    setOpponents((prev) =>
      prev.map((o) => (o.id === id ? { ...o, ...patch } : o)),
    );
    setResult(null);
  }

  async function handleCompute() {
    setError(null);
    setResult(null);

    if (heroMode === 'hand' && !selectedCombo) {
      setError('Select a Hero hand combo in the range grid before computing equity.');
      return;
    }
    if (heroMode === 'range' && heroRangeText.trim().length === 0) {
      setError('Enter a Hero range (or load the current node range) before computing equity.');
      return;
    }

    const oppSpecs: MultiwayEquityRequest['opponents'] = [];
    for (let i = 0; i < opponents.length; i += 1) {
      const slot = opponents[i];
      const label = `Opponent ${i + 1}`;
      if (slot.mode === 'random') {
        oppSpecs.push({ label, preset: 'random' });
      } else {
        const trimmed = slot.text.trim();
        if (trimmed.length === 0) {
          setError(`${label} range text is empty — enter combos or switch to "random" preset.`);
          return;
        }
        oppSpecs.push({ label, range: trimmed });
      }
    }

    const req: MultiwayEquityRequest = {
      board: boardCards.map((c) => c.label),
      opponents: oppSpecs,
      mode: 'auto',
    };
    if (heroMode === 'hand' && selectedCombo) {
      req.hero_hand = selectedCombo;
    } else {
      req.hero_range = heroRangeText.trim();
    }

    setLoading(true);
    try {
      const res = await fetchMultiwayEquity(req);
      setResult(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Multiway equity request failed.');
    } finally {
      setLoading(false);
    }
  }

  const heroCards = selectedCombo ? parseCombo(selectedCombo) : null;
  const canCompute =
    !loading &&
    boardCards.length >= 3 &&
    boardCards.length <= 5 &&
    opponents.length >= MIN_OPPONENTS &&
    opponents.length <= MAX_OPPONENTS &&
    (heroMode === 'hand' ? Boolean(selectedCombo) : heroRangeText.trim().length > 0);

  return (
    <section
      aria-label="Multiway lens"
      className="rounded-lg border border-navy-700 bg-navy-900 p-3 shadow-panel"
    >
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-ink">Multiway lens</h2>
          <p className="text-xs text-ink-faint">
            Multiway PLO equity (Hero + 1–4 opponents) on current board
          </p>
        </div>
        <button
          type="button"
          onClick={() => setIsOpen((v) => !v)}
          aria-expanded={isOpen}
          className="rounded-md border border-navy-700 bg-navy-850 px-2.5 py-1 text-xs font-medium text-ink-dim hover:bg-navy-800 hover:text-ink"
        >
          {isOpen ? 'Collapse' : 'Expand'}
        </button>
      </div>

      {isOpen ? (
        <div className="mt-3 flex flex-col gap-3 border-t border-navy-700 pt-3">
          {/* Current board summary */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-navy-850 px-2.5 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Board ({boardCards.length} cards)
            </span>
            <CardRow cards={boardCards} size="sm" />
          </div>

          {/* Hero hand / range selector */}
          <div className="rounded-md border border-navy-700 bg-navy-850 p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Hero
              </span>
              <div className="inline-flex rounded-md border border-navy-700 bg-navy-900 p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setHeroMode('hand')}
                  aria-pressed={heroMode === 'hand'}
                  className={`rounded px-2 py-0.5 ${
                    heroMode === 'hand'
                      ? 'bg-table font-semibold text-white'
                      : 'text-ink-dim hover:text-ink'
                  }`}
                >
                  Selected hand
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setHeroMode('range');
                    if (!heroRangeText && nodeRangeText) {
                      setHeroRangeText(nodeRangeText);
                    }
                  }}
                  aria-pressed={heroMode === 'range'}
                  className={`rounded px-2 py-0.5 ${
                    heroMode === 'range'
                      ? 'bg-table font-semibold text-white'
                      : 'text-ink-dim hover:text-ink'
                  }`}
                >
                  Range
                </button>
              </div>
            </div>

            {heroMode === 'hand' ? (
              <div className="mt-2">
                {selectedCombo && heroCards ? (
                  <div className="flex items-center justify-between gap-2">
                    <CardRow cards={heroCards} size="sm" />
                    <span className="font-mono text-xs text-ink-dim">{selectedCombo}</span>
                  </div>
                ) : (
                  <p className="text-xs text-amber-300">
                    Pick a combo in the range grid above to set Hero&apos;s 4-card hand.
                  </p>
                )}
              </div>
            ) : (
              <div className="mt-2 flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <label
                    htmlFor="mw-hero-range"
                    className="text-xs text-ink-dim"
                  >
                    Hero weighted combos (Solver format or &quot;random&quot;)
                  </label>
                  {nodeRangeText ? (
                    <button
                      type="button"
                      onClick={() => setHeroRangeText(nodeRangeText)}
                      className="text-xs text-table-light underline hover:text-table"
                    >
                      Use node range
                    </button>
                  ) : null}
                </div>
                <textarea
                  id="mw-hero-range"
                  rows={2}
                  value={heroRangeText}
                  onChange={(e) => {
                    setHeroRangeText(e.target.value);
                    setResult(null);
                  }}
                  placeholder="AsKsQsJs:1.0&#10;AhAdKhKd:0.5"
                  className="w-full rounded border border-navy-700 bg-navy-900 px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-faint"
                />
              </div>
            )}
          </div>

          {/* Opponent ranges (1..4) */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Opponents ({opponents.length} of {MAX_OPPONENTS})
              </span>
              <button
                type="button"
                onClick={addOpponent}
                disabled={opponents.length >= MAX_OPPONENTS}
                className="rounded border border-navy-700 bg-navy-850 px-2 py-0.5 text-xs font-medium text-ink-dim hover:bg-navy-800 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              >
                + Add opponent
              </button>
            </div>

            {opponents.map((opp, idx) => {
              const label = `Opponent ${idx + 1}`;
              return (
                <div
                  key={opp.id}
                  className="rounded-md border border-navy-700 bg-navy-850 p-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-ink">{label}</span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => updateOpponent(opp.id, { mode: 'random' })}
                        aria-pressed={opp.mode === 'random'}
                        className={`rounded px-2 py-0.5 text-xs ${
                          opp.mode === 'random'
                            ? 'bg-table font-semibold text-white'
                            : 'bg-navy-900 text-ink-dim hover:text-ink'
                        }`}
                      >
                        random
                      </button>
                      <button
                        type="button"
                        onClick={() => updateOpponent(opp.id, { mode: 'text' })}
                        aria-pressed={opp.mode === 'text'}
                        className={`rounded px-2 py-0.5 text-xs ${
                          opp.mode === 'text'
                            ? 'bg-table font-semibold text-white'
                            : 'bg-navy-900 text-ink-dim hover:text-ink'
                        }`}
                      >
                        Range text
                      </button>
                      {opponents.length > MIN_OPPONENTS ? (
                        <button
                          type="button"
                          onClick={() => removeOpponent(opp.id)}
                          aria-label={`Remove ${label}`}
                          className="ml-1 rounded px-1.5 py-0.5 text-xs text-ink-faint hover:bg-navy-900 hover:text-red-300"
                        >
                          ✕
                        </button>
                      ) : null}
                    </div>
                  </div>

                  {opp.mode === 'random' ? (
                    <p className="mt-1.5 text-xs text-ink-dim">
                      Preset: <code className="font-mono text-ink">random</code> (all unblocked 4-card PLO hands, uniform weight)
                    </p>
                  ) : (
                    <div className="mt-2">
                      <label htmlFor={`mw-opp-${opp.id}`} className="sr-only">
                        {label} range text
                      </label>
                      <textarea
                        id={`mw-opp-${opp.id}`}
                        rows={2}
                        value={opp.text}
                        onChange={(e) => updateOpponent(opp.id, { text: e.target.value })}
                        placeholder="AhAdKhKd:1.0, QhQdJhJd:0.5 or random"
                        className="w-full rounded border border-navy-700 bg-navy-900 px-2 py-1.5 font-mono text-xs text-ink placeholder:text-ink-faint"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Compute button */}
          <button
            type="button"
            onClick={() => void handleCompute()}
            disabled={!canCompute}
            className="w-full rounded-md bg-table px-3 py-2 text-xs font-semibold text-white hover:bg-table-dark disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? 'Computing multiway equity…' : 'Compute multiway equity'}
          </button>

          {/* Error display — no fake/default equities */}
          {error ? (
            <div
              role="alert"
              className="rounded-md border border-red-700/70 bg-red-950/50 px-3 py-2 text-xs text-red-200"
            >
              {error}
            </div>
          ) : null}

          {/* Results display */}
          {result ? (
            <div className="flex flex-col gap-3 rounded-md border border-navy-700 bg-navy-850 p-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                  Per-player equities ({result.players.length}-way)
                </span>
                <MultiwayEquityBadge
                  mode={result.mode}
                  samples={result.samples}
                  estimatedShowdowns={result.estimated_showdowns}
                />
              </div>

              <ul className="flex flex-col gap-2.5">
                {result.players.map((p) => {
                  const isHero = p.role === 'hero';
                  const barColor = isHero ? '#1f7a4c' : '#3b82f6';
                  return (
                    <li key={p.player_index} className="flex flex-col gap-1">
                      <div className="flex items-baseline justify-between text-xs">
                        <span className={isHero ? 'font-semibold text-ink' : 'text-ink-dim'}>
                          {p.label}
                        </span>
                        <span className="font-mono text-ink">
                          {pctText(p.equity)}
                          {result.mode === 'monte_carlo' && p.std_error > 0
                            ? ` ± ${(p.std_error * 100).toFixed(2)}%`
                            : ''}
                        </span>
                      </div>
                      <FrequencyBar fraction={p.equity} color={barColor} height="h-2" />
                      <div className="flex justify-between text-[11px] text-ink-faint font-mono">
                        <span>Win {(p.win_prob * 100).toFixed(1)}%</span>
                        <span>Tie {(p.tie_prob * 100).toFixed(1)}% (eq {(p.tie_equity * 100).toFixed(1)}%)</span>
                        <span>Loss {(p.loss_prob * 100).toFixed(1)}%</span>
                      </div>
                    </li>
                  );
                })}
              </ul>

              {result.hero_range_distribution ? (
                <div className="border-t border-navy-700 pt-2.5 text-xs">
                  <h4 className="font-semibold uppercase tracking-wide text-ink-faint">
                    Hero range distribution ({result.hero_range_distribution.combo_count} combos)
                  </h4>
                  <dl className="mt-1.5 grid grid-cols-3 gap-1.5 font-mono text-xs">
                    <div className="rounded bg-navy-900 px-2 py-1">
                      <dt className="text-[10px] text-ink-faint">Mean</dt>
                      <dd className="text-ink">
                        {(result.hero_range_distribution.mean * 100).toFixed(1)}%
                      </dd>
                    </div>
                    <div className="rounded bg-navy-900 px-2 py-1">
                      <dt className="text-[10px] text-ink-faint">Median (Q50)</dt>
                      <dd className="text-ink">
                        {(result.hero_range_distribution.median * 100).toFixed(1)}%
                      </dd>
                    </div>
                    <div className="rounded bg-navy-900 px-2 py-1">
                      <dt className="text-[10px] text-ink-faint">IQR (Q25–Q75)</dt>
                      <dd className="text-ink">
                        {(result.hero_range_distribution.q25 * 100).toFixed(1)}–
                        {(result.hero_range_distribution.q75 * 100).toFixed(1)}%
                      </dd>
                    </div>
                  </dl>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <div className="rounded bg-navy-900 p-2">
                      <div className="mb-1 text-[10px] font-semibold uppercase text-ink-faint">
                        Top decile ({result.hero_range_distribution.top_decile.length})
                      </div>
                      <ul className="max-h-24 overflow-y-auto text-[11px] text-ink-dim">
                        {result.hero_range_distribution.top_decile.slice(0, 10).map((c) => {
                          const cards = parseCombo(c.combo);
                          return (
                            <li key={c.combo} className="flex items-center justify-between py-0.5">
                              {cards ? (
                                <CardRow cards={cards} size="xs" />
                              ) : (
                                <span className="font-mono">{c.combo}</span>
                              )}
                              <span className="font-mono text-ink">
                                {(c.equity * 100).toFixed(1)}%
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                    <div className="rounded bg-navy-900 p-2">
                      <div className="mb-1 text-[10px] font-semibold uppercase text-ink-faint">
                        Bottom decile ({result.hero_range_distribution.bottom_decile.length})
                      </div>
                      <ul className="max-h-24 overflow-y-auto text-[11px] text-ink-dim">
                        {result.hero_range_distribution.bottom_decile.slice(0, 10).map((c) => {
                          const cards = parseCombo(c.combo);
                          return (
                            <li key={c.combo} className="flex items-center justify-between py-0.5">
                              {cards ? (
                                <CardRow cards={cards} size="xs" />
                              ) : (
                                <span className="font-mono">{c.combo}</span>
                              )}
                              <span className="font-mono text-ink">
                                {(c.equity * 100).toFixed(1)}%
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Empty adjustment guide slot required by MW-1 */}
          <div className="rounded-md border border-dashed border-navy-700 bg-navy-850/60 px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-ink-dim">
                Adjustment guide — coming in a later ticket (approximation)
              </span>
              <ApproximationBadge />
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
