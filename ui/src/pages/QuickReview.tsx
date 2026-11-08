import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { actionColor, prettyAction } from '../components/actionStyle';
import { CardRow } from '../components/CardChip';
import { FrequencyBar, pctText } from '../components/FrequencyBar';
import {
  ApiError,
  fetchLibrary,
  fetchLibrarySolve,
  fetchSampleSolve,
  fetchStudyProgress,
  postReviewEvents,
} from '../lib/api';
import { parseSolve } from '../lib/solveTree';
import {
  buildReviewCards,
  shuffle,
  type ReviewCard,
  type ReviewEventInput,
  type StudyProgress,
} from '../lib/study';

const SESSION_SIZE = 10;
const MAX_LIBRARY_SOLVES = 3;

type Phase =
  | { kind: 'loading' }
  | { kind: 'empty'; reason: string }
  | { kind: 'session' }
  | { kind: 'done' };

type SaveState = 'idle' | 'saving' | 'saved' | 'needs-login' | 'failed';

function newSessionId(): string {
  return `qr-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function formatClock(ms: number): string {
  const secs = Math.floor(ms / 1000);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

/**
 * Build a deck of flash cards from real solves only:
 *  1. the newest library solves (fetched from the job service), or
 *  2. the bundled sample solve, clearly labelled as such.
 * If neither yields cards the page shows the honest empty state — cards
 * are never fabricated.
 */
async function buildDeck(): Promise<{ cards: ReviewCard[]; fromSample: boolean } | null> {
  try {
    const library = await fetchLibrary();
    const cards: ReviewCard[] = [];
    for (const item of library.slice(0, MAX_LIBRARY_SOLVES)) {
      if (cards.length >= SESSION_SIZE) break;
      try {
        const raw = await fetchLibrarySolve(item.id);
        const parsed = parseSolve(raw);
        if (!parsed) continue;
        cards.push(
          ...buildReviewCards(parsed, {
            solveId: item.id,
            solveName: item.name,
            source: 'library',
          }),
        );
      } catch {
        // One unreadable solve must not sink the session; try the next.
      }
    }
    if (cards.length > 0) return { cards, fromSample: false };
  } catch {
    // Service unreachable — fall through to the bundled sample.
  }
  try {
    const raw = await fetchSampleSolve();
    const parsed = parseSolve(raw);
    if (parsed) {
      const cards = buildReviewCards(parsed, {
        solveId: null,
        solveName: 'Bundled sample river solve',
        source: 'sample',
      });
      if (cards.length > 0) return { cards, fromSample: true };
    }
  } catch {
    // Sample missing too — the caller renders the empty state.
  }
  return null;
}

export function QuickReviewPage() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [deck, setDeck] = useState<ReviewCard[]>([]);
  const [fromSample, setFromSample] = useState(false);
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [events, setEvents] = useState<ReviewEventInput[]>([]);
  const [progress, setProgress] = useState<StudyProgress | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const sessionIdRef = useRef<string>(newSessionId());
  const startedAtRef = useRef<number>(Date.now());

  const startSession = async () => {
    setPhase({ kind: 'loading' });
    setSaveState('idle');
    const built = await buildDeck();
    if (!built) {
      setPhase({
        kind: 'empty',
        reason:
          'No solved spots are available to review: the library is empty and the bundled sample could not be loaded.',
      });
      return;
    }
    sessionIdRef.current = newSessionId();
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    setEvents([]);
    setDeck(shuffle(built.cards).slice(0, SESSION_SIZE));
    setFromSample(built.fromSample);
    setIndex(0);
    setRevealed(false);
    setPhase({ kind: 'session' });
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // All-time progress is decorative here: show it when the session
      // allows, stay silent otherwise (offline / logged out).
      try {
        const p = await fetchStudyProgress();
        if (!cancelled) setProgress(p);
      } catch {
        if (!cancelled) setProgress(null);
      }
      if (!cancelled) await startSession();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Session clock.
  useEffect(() => {
    if (phase.kind !== 'session') return;
    const t = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 500);
    return () => clearInterval(t);
  }, [phase.kind]);

  const finishSession = async (finalEvents: ReviewEventInput[]) => {
    setElapsedMs(Date.now() - startedAtRef.current);
    setPhase({ kind: 'done' });
    if (finalEvents.length === 0) return;
    setSaveState('saving');
    try {
      await postReviewEvents(finalEvents);
      setSaveState('saved');
      try {
        setProgress(await fetchStudyProgress());
      } catch {
        // Summary refresh is best-effort.
      }
    } catch (err) {
      setSaveState(err instanceof ApiError && err.status === 401 ? 'needs-login' : 'failed');
    }
  };

  const card = deck[index];
  const grade = (g: 'got' | 'missed') => {
    if (!card) return;
    const ev: ReviewEventInput = {
      session_id: sessionIdRef.current,
      spot_id: card.solveId,
      source: card.source,
      board: card.boardLabel,
      street: card.street,
      player: card.player,
      node_history: card.nodeHistory,
      hero_combo: card.heroCombo,
      grade: g,
    };
    const next = [...events, ev];
    setEvents(next);
    if (index + 1 >= deck.length) {
      void finishSession(next);
    } else {
      setIndex(index + 1);
      setRevealed(false);
    }
  };

  const missedCards = useMemo(() => {
    const missedKeys = new Set(
      events.filter((e) => e.grade === 'missed').map((e) => `${e.node_history}:${e.hero_combo}`),
    );
    return deck.filter((c) => missedKeys.has(`${c.nodeHistory}:${c.heroCombo}`));
  }, [events, deck]);

  const gotCount = events.filter((e) => e.grade === 'got').length;

  return (
    <div className="mx-auto flex w-full max-w-[430px] flex-col gap-4">
      <header>
        <h1 className="text-xl font-bold text-ink">Quick Review</h1>
        <p className="text-sm text-ink-dim">
          Flash review of real solver spots — under two minutes. See the spot, call the solver's
          play, then grade yourself honestly.
        </p>
        {progress && progress.total_events > 0 ? (
          <p className="mt-1 text-xs text-ink-faint">
            All time: {progress.total_events} cards · {progress.got} got it (
            {Math.round((progress.got / Math.max(1, progress.total_events)) * 100)}%) ·{' '}
            {progress.sessions} session{progress.sessions === 1 ? '' : 's'}
            {progress.last_session_at
              ? ` · last ${new Date(progress.last_session_at).toLocaleDateString()}`
              : ''}
          </p>
        ) : null}
      </header>

      {phase.kind === 'loading' ? (
        <p className="text-sm text-ink-dim">Building your deck from the library…</p>
      ) : phase.kind === 'empty' ? (
        <div className="rounded-lg border border-dashed border-navy-600 bg-navy-900 p-4">
          <p className="text-sm text-ink">Nothing to review yet.</p>
          <p className="mt-1 text-sm text-ink-dim">{phase.reason}</p>
          <p className="mt-2 text-sm text-ink-dim">
            <Link to="/solver" className="text-table-light underline">
              Run a solve in the Solver
            </Link>{' '}
            or queue catalog spots in the{' '}
            <Link to="/admin/runner" className="text-table-light underline">
              local Runner
            </Link>{' '}
            — finished solves become review cards here automatically.
          </p>
        </div>
      ) : phase.kind === 'done' ? (
        <section aria-label="Session summary" className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel">
          <h2 className="text-sm font-semibold text-ink">Session complete</h2>
          <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-md bg-navy-850 px-2 py-2">
              <dt className="text-[11px] uppercase tracking-wide text-ink-faint">Cards</dt>
              <dd className="font-mono text-lg text-ink">{events.length}</dd>
            </div>
            <div className="rounded-md bg-navy-850 px-2 py-2">
              <dt className="text-[11px] uppercase tracking-wide text-ink-faint">Got it</dt>
              <dd className="font-mono text-lg text-table-light">
                {gotCount}
                <span className="text-xs text-ink-dim">
                  {' '}
                  / {events.length}
                </span>
              </dd>
            </div>
            <div className="rounded-md bg-navy-850 px-2 py-2">
              <dt className="text-[11px] uppercase tracking-wide text-ink-faint">Time</dt>
              <dd className="font-mono text-lg text-ink">{formatClock(elapsedMs)}</dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-ink-faint" role="status">
            {saveState === 'saved'
              ? 'Results saved to your study progress.'
              : saveState === 'saving'
                ? 'Saving results…'
                : saveState === 'needs-login'
                  ? 'Results were not saved — log in to keep your review history.'
                  : saveState === 'failed'
                    ? 'Results were not saved — the job service could not be reached.'
                    : ''}
          </p>
          {missedCards.length > 0 ? (
            <div className="mt-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Worth another look
              </h3>
              <ul className="mt-2 flex flex-col gap-2">
                {missedCards.map((c) => {
                  const topIdx = c.heroFreqs.indexOf(Math.max(...c.heroFreqs));
                  return (
                    <li key={c.key} className="rounded-md bg-navy-850 px-3 py-2 text-xs">
                      <span className="font-mono text-ink">{c.boardLabel}</span>{' '}
                      <span className="text-ink-dim">
                        · you held <span className="font-mono">{c.heroCombo}</span> ({c.player},{' '}
                        {c.street})
                      </span>
                      <br />
                      <span className="text-ink-dim">
                        Solver's main play:{' '}
                        <span className="font-semibold text-ink">
                          {prettyAction(c.actions[topIdx] ?? '')} {pctText(c.heroFreqs[topIdx] ?? 0)}
                        </span>{' '}
                        — {c.why}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : events.length > 0 ? (
            <p className="mt-3 text-sm text-table-light">Clean sweep — nothing missed.</p>
          ) : null}
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => void startSession()}
              className="flex-1 rounded-md bg-table px-3 py-2.5 text-sm font-semibold text-white hover:bg-table-dark"
            >
              Review again
            </button>
            <Link
              to="/explorer"
              className="flex-1 rounded-md px-3 py-2.5 text-center text-sm font-semibold text-ink ring-1 ring-navy-600 hover:bg-navy-800"
            >
              Deep study
            </Link>
          </div>
        </section>
      ) : card ? (
        <>
          <div className="flex items-center gap-3 text-xs text-ink-dim">
            <span>
              Card {index + 1} of {deck.length}
            </span>
            <div className="flex-1">
              <FrequencyBar fraction={(index + (revealed ? 1 : 0)) / deck.length} color="var(--action-call)" height="h-1.5" />
            </div>
            <span className="font-mono">{formatClock(elapsedMs)}</span>
          </div>

          <section
            aria-label="Review card"
            className="flex flex-col gap-4 rounded-xl border border-navy-600 bg-navy-900 p-4 shadow-panel"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-navy-800 px-2 py-0.5 text-[11px] font-semibold capitalize text-ink ring-1 ring-navy-600">
                {card.street} · {card.player} to act
              </span>
              <span className="rounded-full bg-navy-800 px-2 py-0.5 text-[11px] text-ink-dim ring-1 ring-navy-600">
                Pot {card.pot.toFixed(0)} · to call {card.toCall.toFixed(0)}
              </span>
              <span className="ml-auto text-[11px] text-ink-faint">
                {fromSample ? 'Bundled sample solve' : card.solveName}
              </span>
            </div>

            <div>
              <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                Board
              </h2>
              <CardRow cards={card.boardCards} size="lg" />
            </div>

            <div>
              <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                You hold
              </h2>
              <CardRow cards={card.heroCards} size="lg" />
            </div>

            {!revealed ? (
              <>
                <p className="text-sm text-ink">
                  How does the solver play this hand? Commit to an answer, then reveal.
                </p>
                <button
                  type="button"
                  onClick={() => setRevealed(true)}
                  className="rounded-md bg-table px-3 py-3 text-sm font-semibold text-white hover:bg-table-dark"
                >
                  Reveal solver answer
                </button>
              </>
            ) : (
              <>
                <div>
                  <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                    Solver's mix for this hand
                  </h2>
                  <ul className="flex flex-col gap-2">
                    {card.actions.map((label, i) => {
                      const f = card.heroFreqs[i] ?? 0;
                      return (
                        <li key={label}>
                          <div className="flex items-baseline justify-between text-xs">
                            <span className="text-ink-dim">{prettyAction(label)}</span>
                            <span className="font-mono text-ink">{pctText(f)}</span>
                          </div>
                          <FrequencyBar fraction={f} color={actionColor(label)} height="h-2" />
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-2 text-xs text-ink-faint">
                    Range overall at this node:{' '}
                    {card.actions
                      .map((label, i) => ({ label, f: card.aggregateFreqs[i] ?? 0 }))
                      .sort((a, b) => b.f - a.f)
                      .slice(0, 2)
                      .map((a) => `${prettyAction(a.label)} ${pctText(a.f)}`)
                      .join(' · ')}
                    {card.heroEv !== null
                      ? ` · this combo's EV over the whole solve: ${card.heroEv >= 0 ? '+' : ''}${card.heroEv.toFixed(2)}`
                      : ''}
                  </p>
                </div>

                <p className="rounded-lg border border-accent/50 bg-navy-850 px-3 py-2.5 text-sm text-ink">
                  <span className="font-semibold text-accent">Why: </span>
                  {card.why}
                </p>

                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => grade('got')}
                    className="rounded-md bg-table px-3 py-3 text-sm font-semibold text-white hover:bg-table-dark"
                  >
                    Got it
                  </button>
                  <button
                    type="button"
                    onClick={() => grade('missed')}
                    className="rounded-md px-3 py-3 text-sm font-semibold text-accent ring-1 ring-accent hover:bg-navy-800"
                  >
                    Missed it
                  </button>
                </div>
              </>
            )}
          </section>

          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => void finishSession(events)}
              className="text-xs text-ink-dim underline hover:text-ink"
            >
              End session early
            </button>
            <span className="text-xs text-ink-faint">
              {fromSample
                ? 'Cards from the bundled sample — solve real spots and they appear here.'
                : 'Cards from your solved library.'}
            </span>
          </div>
        </>
      ) : null}
    </div>
  );
}
