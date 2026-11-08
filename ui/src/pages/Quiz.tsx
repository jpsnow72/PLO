import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AccuracyBadge } from '../components/AccuracyBadge';
import { actionColor, prettyAction } from '../components/actionStyle';
import { CardRow } from '../components/CardChip';
import { FrequencyBar, pctText } from '../components/FrequencyBar';
import {
  ApiError,
  fetchHeuristics,
  fetchLibrary,
  fetchLibrarySolve,
  fetchQuizProgress,
  fetchSampleSolve,
  recordQuizAnswer,
} from '../lib/api';
import { parseCard, type Card } from '../lib/cards';
import type { Heuristic } from '../lib/heuristics';
import {
  buildHeuristicQuestions,
  collectSpotQuestions,
  dueItemKeys,
  gradeHeuristicAnswer,
  gradeSpotAnswer,
  shuffle,
  topicKey,
  topicLabel,
  weakTopics,
  type GradeResult,
  type HeuristicQuestion,
  type QuizProgress,
  type QuizTopicStats,
  type SpotQuestion,
} from '../lib/quiz';
import { parseSolve } from '../lib/solveTree';

type SyncState = 'checking' | 'synced' | 'locked' | 'offline';
type HeuristicsState = 'checking' | 'available' | 'unavailable' | 'locked';
type Phase = 'loading' | 'home' | 'question' | 'summary';

type SessionEntry =
  | { type: 'spot'; q: SpotQuestion }
  | { type: 'heuristic'; q: HeuristicQuestion };

interface AnsweredEntry {
  entry: SessionEntry;
  grade: GradeResult;
}

const MAX_LIBRARY_SOURCES = 12;
const SESSION_SPOT_TARGET = 9;
const SESSION_HEURISTIC_TARGET = 3;

function cardsOf(labels: string[]): Card[] {
  const out: Card[] = [];
  for (const label of labels) {
    const c = parseCard(label);
    if (c) out.push(c);
  }
  return out;
}

function topicStatsChips(
  topics: Record<string, QuizTopicStats>,
): { key: string; accuracy: number; attempts: number }[] {
  return weakTopics(topics, 1);
}

export function QuizPage() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [syncState, setSyncState] = useState<SyncState>('checking');
  const [progress, setProgress] = useState<QuizProgress | null>(null);
  const [heuristicsState, setHeuristicsState] = useState<HeuristicsState>('checking');
  const [spotQuestions, setSpotQuestions] = useState<SpotQuestion[]>([]);
  const [heuristicQuestions, setHeuristicQuestions] = useState<HeuristicQuestion[]>([]);
  const [sourceNames, setSourceNames] = useState<string[]>([]);
  const [sourcesFailed, setSourcesFailed] = useState(false);

  const [session, setSession] = useState<SessionEntry[]>([]);
  const [index, setIndex] = useState(0);
  const [pickedAction, setPickedAction] = useState<number | null>(null);
  const [pickedHeuristic, setPickedHeuristic] = useState<string | null>(null);
  const [grade, setGrade] = useState<GradeResult | null>(null);
  const [answered, setAnswered] = useState<AnsweredEntry[]>([]);
  const [localTopics, setLocalTopics] = useState<Record<string, QuizTopicStats>>({});
  const repeatedRef = useRef<Set<string>>(new Set());

  // ----- Load progress, question sources and heuristics (once) -----
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Progress (SRS state). 401 = signed out: quiz still runs, but
      // answers stay in this session only.
      try {
        const p = await fetchQuizProgress();
        if (!cancelled) {
          setProgress(p);
          setSyncState('synced');
        }
      } catch (err) {
        if (!cancelled) {
          setSyncState(err instanceof ApiError && err.status === 401 ? 'locked' : 'offline');
        }
      }

      // Question sources: library solves first, bundled sample as the
      // always-available fallback. Every question is generated from a
      // real parsed solve — if none parse, the quiz has no questions
      // and says so (see the empty state on the home view).
      const questions: SpotQuestion[] = [];
      const names: string[] = [];
      let anySource = false;
      try {
        const lib = await fetchLibrary();
        for (const item of lib.slice(0, MAX_LIBRARY_SOURCES)) {
          try {
            const raw = await fetchLibrarySolve(item.id);
            const data = parseSolve(raw);
            if (!data) continue;
            anySource = true;
            names.push(item.name);
            questions.push(
              ...collectSpotQuestions({ id: item.id, name: item.name, source: 'library', data }),
            );
          } catch {
            // Skip an unloadable solve rather than failing the quiz.
          }
        }
      } catch {
        // API offline: sample-only mode below.
      }
      try {
        const raw = await fetchSampleSolve();
        const data = parseSolve(raw);
        if (data) {
          anySource = true;
          names.push('Bundled sample river solve');
          questions.push(
            ...collectSpotQuestions({
              id: 'sample',
              name: 'Bundled sample river solve',
              source: 'sample',
              data,
            }),
          );
        }
      } catch {
        // Sample missing too — the empty state reports it.
      }
      if (cancelled) return;
      setSpotQuestions(questions);
      setSourceNames(names);
      setSourcesFailed(!anySource);

      // Heuristics (parallel lane's endpoint; fully defensive).
      try {
        const list: Heuristic[] = await fetchHeuristics();
        if (cancelled) return;
        setHeuristicsState('available');
        setHeuristicQuestions(buildHeuristicQuestions(list, questions));
      } catch (err) {
        if (cancelled) return;
        setHeuristicsState(
          err instanceof ApiError && err.status === 401 ? 'locked' : 'unavailable',
        );
        setHeuristicQuestions([]);
      }

      if (!cancelled) setPhase('home');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dueCount = useMemo(() => {
    if (!progress) return 0;
    const due = dueItemKeys(progress, new Date());
    let n = 0;
    for (const q of spotQuestions) if (due.has(q.itemKey)) n += 1;
    for (const q of heuristicQuestions) if (due.has(q.itemKey)) n += 1;
    return n;
  }, [progress, spotQuestions, heuristicQuestions]);

  const chips = useMemo(() => {
    const merged: Record<string, QuizTopicStats> = {};
    const from = syncState === 'synced' && progress ? progress.topics : localTopics;
    for (const [key, s] of Object.entries(from)) merged[key] = s;
    return topicStatsChips(merged);
  }, [syncState, progress, localTopics]);

  const startSession = useCallback(() => {
    const due = progress ? dueItemKeys(progress, new Date()) : new Set<string>();
    const dueSpots = shuffle(spotQuestions.filter((q) => due.has(q.itemKey)));
    const freshSpots = shuffle(spotQuestions.filter((q) => !due.has(q.itemKey)));
    const spots = [...dueSpots, ...freshSpots].slice(0, SESSION_SPOT_TARGET);
    const dueHeur = heuristicQuestions.filter((q) => due.has(q.itemKey));
    const freshHeur = shuffle(heuristicQuestions.filter((q) => !due.has(q.itemKey)));
    const heurs = [...dueHeur, ...freshHeur].slice(0, SESSION_HEURISTIC_TARGET);

    const entries: SessionEntry[] = spots.map((q) => ({ type: 'spot' as const, q }));
    // Interleave heuristic questions through the session.
    heurs.forEach((q, i) => {
      const at = Math.min(entries.length, 2 + i * 3);
      entries.splice(at, 0, { type: 'heuristic' as const, q });
    });

    repeatedRef.current = new Set();
    setSession(entries);
    setAnswered([]);
    setIndex(0);
    setPickedAction(null);
    setPickedHeuristic(null);
    setGrade(null);
    setPhase('question');
  }, [progress, spotQuestions, heuristicQuestions]);

  const recordLocal = useCallback((topic: { texture: string; street: string; spot_type: string }, score: number) => {
    const key = topicKey(topic);
    setLocalTopics((prev) => {
      const cur = prev[key] ?? { attempts: 0, score_sum: 0, last_at: null };
      return {
        ...prev,
        [key]: {
          attempts: cur.attempts + 1,
          score_sum: cur.score_sum + score,
          last_at: new Date().toISOString(),
        },
      };
    });
  }, []);

  const persist = useCallback(
    async (entry: SessionEntry, result: GradeResult) => {
      const isSpot = entry.type === 'spot';
      const topic = entry.q.topic;
      recordLocal(topic, result.score);
      if (syncState !== 'synced') return;
      try {
        const updated = await recordQuizAnswer({
          item_key: entry.q.itemKey,
          kind: isSpot ? 'spot' : 'heuristic',
          topic,
          score: result.score,
          grading: result.grading,
          ev_lost_pct:
            isSpot && result.evLostChips !== null
              ? (result.evLostChips / (entry.q as SpotQuestion).pot) * 100
              : null,
        });
        if (updated) setProgress(updated);
      } catch {
        // Persistence is best-effort in-session; the answer still counts
        // locally and the home view keeps the sync state visible.
      }
    },
    [syncState, recordLocal],
  );

  const current = session[index];

  const submit = useCallback(async () => {
    if (!current || grade) return;
    let result: GradeResult;
    if (current.type === 'spot') {
      if (pickedAction === null) return;
      result = gradeSpotAnswer(current.q, pickedAction);
    } else {
      if (pickedHeuristic === null) return;
      result = gradeHeuristicAnswer(current.q, pickedHeuristic);
    }
    setGrade(result);
    setAnswered((prev) => [...prev, { entry: current, grade: result }]);
    await persist(current, result);
    // Missed items resurface sooner: re-ask once at the end of this
    // session (the server also has them due immediately for next time).
    if (result.band === 'miss' && !repeatedRef.current.has(current.q.itemKey)) {
      repeatedRef.current.add(current.q.itemKey);
      setSession((prev) => [...prev, current]);
    }
  }, [current, grade, pickedAction, pickedHeuristic, persist]);

  const next = useCallback(() => {
    setPickedAction(null);
    setPickedHeuristic(null);
    setGrade(null);
    if (index + 1 >= session.length) setPhase('summary');
    else setIndex(index + 1);
  }, [index, session.length]);

  // ---------- Views ----------

  if (phase === 'loading') {
    return <p className="text-ink-dim">Loading quiz sources…</p>;
  }

  if (phase === 'home') {
    const noQuestions = spotQuestions.length === 0 && heuristicQuestions.length === 0;
    return (
      <div className="flex flex-col gap-4">
        <header>
          <h1 className="text-xl font-bold text-ink">Quiz Trainer</h1>
          <p className="text-sm text-ink-dim">
            Self-testing built from your solved spots and your own heuristics — graded against
            the solver, with spaced repetition so misses come back sooner.
          </p>
        </header>

        <section className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-navy-700 bg-navy-900 p-3 shadow-panel">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Spot questions
            </h2>
            <p className="mt-1 font-mono text-lg text-ink">{spotQuestions.length}</p>
            <p className="text-xs text-ink-dim">
              {sourceNames.length > 0
                ? `Generated from: ${sourceNames.join(' · ')}`
                : 'No solves could be loaded.'}
            </p>
          </div>
          <div className="rounded-lg border border-navy-700 bg-navy-900 p-3 shadow-panel">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Due for review
            </h2>
            <p className="mt-1 font-mono text-lg text-ink">
              {syncState === 'synced' ? dueCount : '—'}
            </p>
            <p className="text-xs text-ink-dim">
              {syncState === 'synced'
                ? 'Items the spaced-repetition ladder says are due now; they lead the next session.'
                : syncState === 'locked'
                  ? 'Sign in (admin) to sync quiz progress and get spaced repetition across devices.'
                  : 'The job service is unreachable, so review scheduling is unavailable this visit.'}
            </p>
          </div>
          <div className="rounded-lg border border-navy-700 bg-navy-900 p-3 shadow-panel">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Heuristic questions
            </h2>
            <p className="mt-1 font-mono text-lg text-ink">{heuristicQuestions.length}</p>
            <p className="text-xs text-ink-dim">
              {heuristicsState === 'available'
                ? 'Built from the active entries in your heuristics log.'
                : heuristicsState === 'locked'
                  ? 'Heuristics quizzes are unavailable: the log needs an admin sign-in.'
                  : 'Heuristics quizzes are unavailable: the heuristics service is not running on this server yet. The quiz runs on solver spots only.'}
            </p>
          </div>
        </section>

        <section className="rounded-lg border border-navy-700 bg-navy-900 p-3 text-xs leading-relaxed text-ink-dim shadow-panel">
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            How grading works — honestly
          </h2>
          <p>
            The engine stores each hand’s action <em>frequencies</em> at every node, plus one
            whole-solve EV per hand. It does not store per-action EVs, so an “EV lost” figure for
            a node decision cannot be computed from today’s solves — and none is shown. Spot
            answers are graded by <strong className="text-ink">frequency match</strong>: your
            score is how often the solver takes your pick with that exact hand. If a future
            solve carries per-action EVs, the grader switches to true EV-lost grading and says
            so on the result. Heuristic questions are graded by recall (right rule for the spot
            type, or not).
          </p>
          <p className="mt-1.5">
            Repetition ladder: a miss is due again immediately (and is re-asked once at the end
            of the session); a solid answer pushes the next review out — 1 day, then 2, 4, 7, 15,
            up to 30 days.
          </p>
        </section>

        {chips.length > 0 ? (
          <section>
            <h2 className="mb-2 text-sm font-semibold text-ink">
              Topic accuracy {syncState === 'synced' ? '(synced)' : '(this session)'}
            </h2>
            <div className="flex flex-wrap gap-1.5">
              {chips.map((chip) => {
                const [texture = '', street = '', spotType = ''] = chip.key.split('|');
                const label = topicLabel({ texture, street, spot_type: spotType });
                const weak = chip.accuracy < 0.7;
                return (
                  <span
                    key={chip.key}
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${
                      weak
                        ? 'border border-accent font-semibold text-accent'
                        : 'bg-navy-800 text-ink-dim'
                    }`}
                    title={`${chip.attempts} attempts`}
                  >
                    {label} · {(chip.accuracy * 100).toFixed(0)}%
                  </span>
                );
              })}
            </div>
            <p className="mt-1.5 text-xs text-ink-faint">
              Weakest first; amber chips are below 70% — those topics’ questions keep resurfacing
              through the ladder.
            </p>
          </section>
        ) : null}

        {noQuestions ? (
          <section className="rounded-lg border border-navy-700 bg-navy-900 p-4">
            <h2 className="text-sm font-semibold text-ink">No questions available yet</h2>
            <p className="mt-1 text-sm text-ink-dim">
              {sourcesFailed
                ? 'No solved spot could be loaded — the library is unreachable and the bundled sample solve failed to load, so there is nothing honest to quiz you on.'
                : 'Your library has no solved spots with a real decision in them yet, and no active heuristics to quiz. Solve a spot first, then come back.'}{' '}
              <Link to="/solver" className="text-table-light underline hover:text-table">
                Open the Solver
              </Link>{' '}
              or{' '}
              <Link to="/explore" className="text-table-light underline hover:text-table">
                browse the library
              </Link>
              .
            </p>
          </section>
        ) : (
          <div>
            <button
              type="button"
              onClick={startSession}
              className="rounded-md bg-table px-4 py-2 text-sm font-semibold text-white hover:bg-table-dark"
            >
              Start session
              {dueCount > 0 && syncState === 'synced' ? ` (${dueCount} due first)` : ''}
            </button>
          </div>
        )}
      </div>
    );
  }

  if (phase === 'summary') {
    const avg =
      answered.length > 0
        ? answered.reduce((a, r) => a + r.grade.score, 0) / answered.length
        : 0;
    return (
      <div className="flex flex-col gap-4">
        <header>
          <h1 className="text-xl font-bold text-ink">Session done</h1>
          <p className="text-sm text-ink-dim">
            Average score {(avg * 100).toFixed(0)}% over {answered.length} graded answers
            {syncState === 'synced'
              ? ' — progress saved, misses are due again right away.'
              : ' — progress was not synced (this session only).'}
          </p>
        </header>
        <ul className="flex flex-col gap-2">
          {answered.map((r, i) => (
            <li
              key={i}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-navy-700 bg-navy-900 px-3 py-2.5 text-sm shadow-panel"
            >
              <span
                className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${
                  r.grade.band === 'solid'
                    ? 'bg-table text-white'
                    : r.grade.band === 'partial'
                      ? 'bg-navy-800 text-ink'
                      : 'border border-accent text-accent'
                }`}
              >
                {(r.grade.score * 100).toFixed(0)}%
              </span>
              <span className="text-ink">{r.grade.headline}</span>
              <span className="ml-auto text-xs text-ink-faint">
                {r.grade.grading === 'ev'
                  ? 'EV-lost grading'
                  : r.grade.grading === 'frequency'
                    ? 'frequency-match grading'
                    : 'recall grading'}
                {' · '}
                {topicLabel(r.entry.q.topic)}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setPhase('home')}
            className="rounded-md bg-navy-800 px-4 py-2 text-sm font-semibold text-ink ring-1 ring-navy-600 hover:bg-navy-700"
          >
            Back to quiz home
          </button>
          <button
            type="button"
            onClick={startSession}
            className="rounded-md bg-table px-4 py-2 text-sm font-semibold text-white hover:bg-table-dark"
          >
            Another session
          </button>
        </div>
      </div>
    );
  }

  // ----- Question view -----
  if (!current) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-ink-dim">This session has no questions.</p>
        <button
          type="button"
          onClick={() => setPhase('home')}
          className="self-start rounded-md bg-navy-800 px-3 py-2 text-sm font-semibold text-ink ring-1 ring-navy-600"
        >
          Back to quiz home
        </button>
      </div>
    );
  }

  const progressText = `Question ${index + 1} of ${session.length}`;

  if (current.type === 'heuristic') {
    const q = current.q;
    return (
      <div className="flex flex-col gap-4">
        <p className="text-xs text-ink-faint">{progressText} · from your heuristics log</p>
        <section className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel">
          <h1 className="text-lg font-semibold text-ink">Which heuristic applies here?</h1>
          <div className="mt-3 flex flex-col gap-2">
            {q.contextBoard ? (
              <CardRow cards={cardsOf(q.contextBoard)} size="lg" />
            ) : null}
            <p className="text-sm text-ink-dim">{q.contextText}</p>
            <p className="text-xs text-ink-faint">Topic: {topicLabel(q.topic)}</p>
          </div>
          <div className="mt-4 flex flex-col gap-2" role="radiogroup" aria-label="Heuristic options">
            {q.options.map((h) => {
              const picked = pickedHeuristic === h.id;
              const isCorrect = grade !== null && h.id === q.correctId;
              const isWrongPick = grade !== null && picked && h.id !== q.correctId;
              return (
                <button
                  key={h.id}
                  type="button"
                  role="radio"
                  aria-checked={picked}
                  disabled={grade !== null}
                  onClick={() => setPickedHeuristic(h.id)}
                  className={`rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                    isCorrect
                      ? 'border-table bg-navy-800 text-ink'
                      : isWrongPick
                        ? 'border-accent bg-navy-800 text-ink'
                        : picked
                          ? 'border-accent bg-navy-800 text-ink'
                          : 'border-navy-700 bg-navy-900 text-ink-dim hover:border-table hover:text-ink'
                  }`}
                >
                  {h.text}
                </button>
              );
            })}
          </div>
          {grade ? (
            <GradePanel grade={grade} onNext={next} isLast={index + 1 >= session.length} />
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={pickedHeuristic === null}
              className="mt-4 rounded-md bg-table px-4 py-2 text-sm font-semibold text-white hover:bg-table-dark disabled:cursor-not-allowed disabled:opacity-60"
            >
              Check answer
            </button>
          )}
        </section>
      </div>
    );
  }

  const q = current.q;
  return (
    <div className="flex flex-col gap-4">
      <p className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
        {progressText} · {q.solveName}
        {q.solveSource === 'sample' ? ' · bundled sample' : ''}
        <span className="ml-auto">
          <AccuracyBadge nashPct={q.nashPct} />
        </span>
      </p>
      <section className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel">
        <div className="flex flex-wrap items-start gap-4">
          <div>
            <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Board · {q.street}
            </h2>
            <CardRow cards={cardsOf(q.board)} size="lg" />
          </div>
          <div>
            <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
              You hold · {q.player} to act
            </h2>
            <CardRow cards={cardsOf(q.heroCards)} size="lg" />
          </div>
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-md bg-navy-850 px-2 py-1.5">
              <dt className="text-ink-faint">Pot</dt>
              <dd className="font-mono text-sm text-ink">{q.pot.toFixed(0)}</dd>
            </div>
            <div className="rounded-md bg-navy-850 px-2 py-1.5">
              <dt className="text-ink-faint">To call</dt>
              <dd className="font-mono text-sm text-ink">{q.toCall.toFixed(0)}</dd>
            </div>
          </dl>
        </div>

        {q.line.length > 0 ? (
          <p className="mt-3 text-xs text-ink-dim">
            Line so far: {q.line.join(' → ')}
          </p>
        ) : (
          <p className="mt-3 text-xs text-ink-dim">First decision of the hand.</p>
        )}
        <p className="mt-1 text-xs text-ink-faint">Topic: {topicLabel(q.topic)}</p>

        <h1 className="mt-4 text-base font-semibold text-ink">
          What does the solver do with this hand?
        </h1>
        <div className="mt-2 flex flex-col gap-2">
          {q.actions.map((label, i) => {
            const picked = pickedAction === i;
            const isBest = grade !== null && i === grade.bestActionIdx;
            const isPick = grade !== null && picked;
            return (
              <div key={label}>
                <button
                  type="button"
                  disabled={grade !== null}
                  onClick={() => setPickedAction(i)}
                  aria-pressed={picked}
                  className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${
                    isBest
                      ? 'border-table bg-navy-800'
                      : isPick
                        ? 'border-accent bg-navy-800'
                        : picked
                          ? 'border-accent bg-navy-800'
                          : 'border-navy-700 bg-navy-900 hover:border-table'
                  }`}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold text-ink">{prettyAction(label)}</span>
                    {grade ? (
                      <span className="font-mono text-sm text-ink-dim">
                        solver {pctText(q.frequencies[i] ?? 0)}
                        {isPick ? ' · your pick' : ''}
                        {isBest ? ' · solver’s main line' : ''}
                      </span>
                    ) : null}
                  </span>
                  {grade ? (
                    <span className="mt-1.5 block">
                      <FrequencyBar fraction={q.frequencies[i] ?? 0} color={actionColor(label)} />
                    </span>
                  ) : null}
                </button>
              </div>
            );
          })}
        </div>

        {grade ? (
          <GradePanel grade={grade} onNext={next} isLast={index + 1 >= session.length} />
        ) : (
          <button
            type="button"
            onClick={() => void submit()}
            disabled={pickedAction === null}
            className="mt-4 rounded-md bg-table px-4 py-2 text-sm font-semibold text-white hover:bg-table-dark disabled:cursor-not-allowed disabled:opacity-60"
          >
            Check answer
          </button>
        )}
      </section>
    </div>
  );
}

function GradePanel({
  grade,
  onNext,
  isLast,
}: {
  grade: GradeResult;
  onNext: () => void;
  isLast: boolean;
}) {
  return (
    <div className="mt-4 rounded-lg bg-navy-850 px-3 py-3" role="status">
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-ink">{grade.headline}</span>
        <span className="font-mono text-sm text-ink-dim">
          score {(grade.score * 100).toFixed(0)}%
        </span>
        <span className="ml-auto rounded-full border border-navy-600 px-2 py-0.5 text-xs text-ink-dim">
          {grade.grading === 'ev'
            ? 'Graded by EV lost'
            : grade.grading === 'frequency'
              ? 'Graded by frequency match'
              : 'Graded by recall'}
        </span>
      </p>
      <p className="mt-1 text-xs leading-relaxed text-ink-dim">{grade.detail}</p>
      {grade.band === 'miss' ? (
        <p className="mt-1 text-xs text-ink-faint">
          Missed items are due again immediately — this one will be re-asked at the end of the
          session.
        </p>
      ) : null}
      <button
        type="button"
        onClick={onNext}
        className="mt-3 rounded-md bg-table px-4 py-2 text-sm font-semibold text-white hover:bg-table-dark"
      >
        {isLast ? 'See results' : 'Next question'}
      </button>
    </div>
  );
}
