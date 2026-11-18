import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AccuracyBadge } from '../components/AccuracyBadge';
import { actionColor, prettyAction } from '../components/actionStyle';
import { CardRow } from '../components/CardChip';
import { FrequencyBar, pctText } from '../components/FrequencyBar';
import {
  ApiError,
  fetchHeuristics,
  fetchJobResult,
  fetchLibrary,
  fetchLibrarySolve,
  fetchPreflopIndex,
  fetchQuizProgress,
  fetchSampleSolve,
  recordQuizAnswer,
} from '../lib/api';
import { parseCard, parseCombo, type Card } from '../lib/cards';
import {
  addSavedDrill,
  focusLabel,
  focusMatches,
  loadSavedDrills,
  preflopDrillGroups,
  removeSavedDrill,
  spotTypeDrillEntries,
  streetDrillEntries,
  topicDrillEntries,
  type DrillEntry,
  type PreflopDrillGroup,
  type SavedDrill,
  type TrainerFocus,
} from '../lib/drills';
import type { PreflopIndex } from '../lib/preflop';
import type { Heuristic } from '../lib/heuristics';
import {
  buildHeuristicQuestions,
  collectSpotQuestions,
  dueItemKeys,
  explorerPathFor,
  gradeHeuristicAnswer,
  gradeSpotAnswer,
  nodeHistoryOf,
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
import { useStore } from '../store/useStore';

type SyncState = 'checking' | 'synced' | 'locked' | 'offline';
type HeuristicsState = 'checking' | 'available' | 'unavailable' | 'locked';
type Phase = 'loading' | 'home' | 'question' | 'summary';
type HomeTab = 'train' | 'drills' | 'history' | 'stats';

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
/** A spot drill cycles its node's questions up to this many hands. */
const SPOT_DRILL_TARGET = 10;

/**
 * Generate every question one solve supports, loading it by source.
 * Used for Practice This Spot and saved spot drills, whose solve may
 * not be among the trainer's general sources (job solves, or a library
 * solve past the general source cap).
 */
async function questionsForSolve(
  solveId: string,
  solveName: string,
  source: 'library' | 'sample' | 'job',
): Promise<SpotQuestion[]> {
  const raw =
    source === 'library'
      ? await fetchLibrarySolve(solveId)
      : source === 'job'
        ? await fetchJobResult(solveId)
        : await fetchSampleSolve();
  const data = parseSolve(raw);
  if (!data) return [];
  return collectSpotQuestions({ id: solveId, name: solveName, source, data });
}

function solveSourceLabel(source: SpotQuestion['solveSource']): string {
  return source === 'library'
    ? 'library solve'
    : source === 'job'
      ? 'your solve (job)'
      : 'bundled sample solve';
}

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

/** Trailing run of "solid" grades (score >= 0.85) — the session streak. */
function currentStreak(answered: AnsweredEntry[]): number {
  let streak = 0;
  for (let i = answered.length - 1; i >= 0; i -= 1) {
    if (answered[i]?.grade.band === 'solid') streak += 1;
    else break;
  }
  return streak;
}

function bandIcon(band: GradeResult['band']): string {
  return band === 'solid' ? '✓' : band === 'partial' ? '◐' : '✗';
}

function bandTextClass(band: GradeResult['band']): string {
  return band === 'solid'
    ? 'text-table-light'
    : band === 'partial'
      ? 'text-accent'
      : 'text-red-400';
}

/** "Bet 75" -> "bets", "Check" -> "checks", for the feedback banner. */
function actionVerb(label: string): string {
  const p = prettyAction(label).toLowerCase();
  if (p.startsWith('check')) return 'checks';
  if (p.startsWith('fold')) return 'folds';
  if (p.startsWith('call')) return 'calls';
  if (p.startsWith('bet')) return 'bets';
  if (p.startsWith('raise')) return 'raises';
  return 'takes this action';
}

interface TopicChip {
  key: string;
  accuracy: number;
  attempts: number;
}

function TopicBars({ chips, limit }: { chips: TopicChip[]; limit: number }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {chips.slice(0, limit).map((chip) => {
        const [texture = '', street = '', spotType = ''] = chip.key.split('|');
        const label = topicLabel({ texture, street, spot_type: spotType });
        return (
          <li key={chip.key} className="flex items-center gap-2 text-xs">
            <span className="w-40 shrink-0 truncate text-ink-dim" title={label}>
              {label}
            </span>
            <div className="flex-1">
              <FrequencyBar
                fraction={chip.accuracy}
                color={chip.accuracy >= 0.7 ? '#2E9E6B' : '#F5A623'}
                height="h-2"
              />
            </div>
            <span className="w-10 text-right font-mono text-ink-dim">
              {(chip.accuracy * 100).toFixed(0)}%
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The trainer's right rail (Figma frame): live session stats, topic
 * accuracy bars and the session history. Every number derives from
 * this session's graded answers or the synced progress topics — the
 * "Avg EV loss" row only exists once an answer was actually graded in
 * EV mode (per-action EVs present), never in frequency mode.
 */
function SessionRail({
  answered,
  chips,
  dueCount,
  syncState,
  openingKey,
  openError,
  onOpenExplorer,
}: {
  answered: AnsweredEntry[];
  chips: TopicChip[];
  dueCount: number;
  syncState: SyncState;
  openingKey: string | null;
  openError: string | null;
  onOpenExplorer: (q: SpotQuestion) => void;
}) {
  const hands = answered.length;
  const accuracy =
    hands > 0 ? answered.reduce((a, r) => a + r.grade.score, 0) / hands : null;
  const streak = currentStreak(answered);
  const evLossPcts: number[] = [];
  for (const r of answered) {
    if (r.entry.type === 'spot' && r.grade.evLostChips !== null && r.entry.q.pot > 0) {
      evLossPcts.push((r.grade.evLostChips / r.entry.q.pot) * 100);
    }
  }
  const avgEvLossPct =
    evLossPcts.length > 0
      ? evLossPcts.reduce((a, v) => a + v, 0) / evLossPcts.length
      : null;

  const statRow = (label: string, value: string, note?: string) => (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
        {label}
        {note ? <span className="ml-1.5 font-normal normal-case text-ink-faint">{note}</span> : null}
      </dt>
      <dd className="font-mono text-xl text-ink">{value}</dd>
    </div>
  );

  return (
    <aside
      aria-label="Session"
      className="flex h-fit flex-col gap-4 rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel"
    >
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Session</h2>
        <dl className="mt-2 flex flex-col gap-2.5">
          {statRow('Hands', String(hands))}
          {statRow(
            'Accuracy',
            accuracy !== null ? `${(accuracy * 100).toFixed(0)}%` : '—',
            'avg grade score',
          )}
          {avgEvLossPct !== null
            ? statRow('Avg EV loss', `${avgEvLossPct.toFixed(1)}% of pot`, 'EV-graded answers')
            : null}
          {statRow('Streak', streak > 0 ? `🔥 ${streak}` : '—', 'solid answers in a row')}
        </dl>
      </section>

      {chips.length > 0 ? (
        <section>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Accuracy by topic {syncState === 'synced' ? '(synced)' : '(this session)'}
          </h2>
          <TopicBars chips={chips} limit={6} />
        </section>
      ) : null}

      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
          History
        </h2>
        {answered.length === 0 ? (
          <p className="text-xs text-ink-faint">Answers you grade will land here.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {[...answered].reverse().map((r, ri) => {
              const key = `${r.entry.q.itemKey}-${answered.length - 1 - ri}`;
              const spotQ = r.entry.type === 'spot' ? r.entry.q : null;
              const heroCards = spotQ ? parseCombo(spotQ.heroCombo) : null;
              return (
                <li key={key} className="flex items-center gap-2 text-xs">
                  <span className={`font-bold ${bandTextClass(r.grade.band)}`} aria-hidden="true">
                    {bandIcon(r.grade.band)}
                  </span>
                  <span className="flex min-w-0 flex-1 items-center gap-1.5 text-ink-dim">
                    {spotQ ? (
                      <>
                        {heroCards ? (
                          <CardRow cards={heroCards} size="xs" />
                        ) : (
                          <span className="truncate">{spotQ.heroCombo}</span>
                        )}
                        <span className="truncate">· {spotQ.street}</span>
                      </>
                    ) : (
                      <span className="truncate">
                        {`Heuristic · ${topicLabel(r.entry.q.topic)}`}
                      </span>
                    )}
                  </span>
                  <span className="font-mono text-ink-faint">
                    {r.grade.evLostChips !== null
                      ? `−${r.grade.evLostChips.toFixed(1)}`
                      : `${(r.grade.score * 100).toFixed(0)}%`}
                  </span>
                  {spotQ ? (
                    <button
                      type="button"
                      disabled={openingKey !== null}
                      onClick={() => onOpenExplorer(spotQ)}
                      className="shrink-0 text-table-light underline hover:text-table disabled:opacity-50"
                    >
                      {openingKey === spotQ.itemKey ? 'Opening…' : 'Open in Explorer'}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {openError ? (
          <p className="mt-1.5 text-xs text-red-300" role="alert">
            {openError}
          </p>
        ) : null}
      </section>

      {syncState === 'synced' ? (
        <p className="text-xs font-medium text-accent">
          Due for review: {dueCount} card{dueCount === 1 ? '' : 's'} (spaced repetition)
        </p>
      ) : null}
    </aside>
  );
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

  // Trainer parity (issue #22): home tabs, focused drill sessions,
  // saved drills, and the preflop drill catalogue.
  const [homeTab, setHomeTab] = useState<HomeTab>('train');
  const [sessionFocus, setSessionFocus] = useState<TrainerFocus | null>(null);
  const [focusNotice, setFocusNotice] = useState<string | null>(null);
  const [savedDrills, setSavedDrills] = useState<SavedDrill[]>(() => loadSavedDrills());
  const [preflopIndex, setPreflopIndex] = useState<PreflopIndex | null>(null);
  const [drillName, setDrillName] = useState('');
  const [drillSaved, setDrillSaved] = useState(false);

  const navigate = useNavigate();
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  /**
   * "Open in Explorer": reload the question's solve into the shared
   * store, rebuild the path to the exact node the question came from
   * (explorerPathFor; root fallback when a step cannot be resolved),
   * and navigate to the Tree Explorer.
   */
  const openInExplorer = useCallback(
    async (q: SpotQuestion) => {
      setOpeningKey(q.itemKey);
      setOpenError(null);
      try {
        const raw =
          q.solveSource === 'library'
            ? await fetchLibrarySolve(q.solveId)
            : q.solveSource === 'job'
              ? await fetchJobResult(q.solveId)
              : await fetchSampleSolve();
        const ok = useStore
          .getState()
          .loadRawSolve(raw, q.solveName, q.solveSource, q.solveSource === 'sample' ? null : q.solveId);
        if (!ok) {
          setOpenError('That solve could not be loaded into the Explorer.');
          return;
        }
        const data = useStore.getState().solve;
        const history = nodeHistoryOf(q);
        if (data && history !== 'root') {
          const steps = explorerPathFor(data, history);
          if (steps) useStore.getState().setPath(steps);
        }
        navigate('/explorer');
      } catch {
        setOpenError('Could not open that solve — the job service is unreachable.');
      } finally {
        setOpeningKey(null);
      }
    },
    [navigate],
  );

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

  // Preflop drill catalogue (defensive: the Drills tab explains its
  // absence rather than failing the page).
  useEffect(() => {
    let cancelled = false;
    fetchPreflopIndex()
      .then((idx) => {
        if (!cancelled) setPreflopIndex(idx);
      })
      .catch(() => {
        if (!cancelled) setPreflopIndex(null);
      });
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

  /** Reset all per-session state and enter the question phase. */
  const beginSession = useCallback((entries: SessionEntry[], focus: TrainerFocus | null) => {
    repeatedRef.current = new Set();
    setSession(entries);
    setSessionFocus(focus);
    setDrillSaved(false);
    setDrillName('');
    setAnswered([]);
    setIndex(0);
    setPickedAction(null);
    setPickedHeuristic(null);
    setGrade(null);
    setPhase('question');
  }, []);

  /**
   * Start a focused drill session from explicit question pools.
   * Returns false (and changes nothing) when the focus matches no
   * questions — the caller reports that instead of starting an empty
   * session. Grading and persistence are untouched: entries flow
   * through the same submit/persist path as a mixed session.
   */
  const startFocused = useCallback(
    (
      focus: TrainerFocus,
      spots: SpotQuestion[],
      heurs: HeuristicQuestion[],
      due: Set<string>,
    ): boolean => {
      let entries: SessionEntry[] = [];
      if (focus.kind === 'due') {
        const dueSpots = shuffle(spots.filter((q) => due.has(q.itemKey)));
        const dueHeurs = heurs.filter((q) => due.has(q.itemKey));
        entries = dueSpots.map((q) => ({ type: 'spot' as const, q }));
        dueHeurs.forEach((q, i) => {
          const at = Math.min(entries.length, 2 + i * 3);
          entries.splice(at, 0, { type: 'heuristic' as const, q });
        });
      } else if (focus.kind === 'spot') {
        // One exact node: cycle its combos (reshuffled each pass)
        // until the drill target, so a small node still fills a
        // session and a large one is sampled.
        const pool = spots.filter((q) => focusMatches(focus, q));
        const picked: SpotQuestion[] = [];
        while (pool.length > 0 && picked.length < SPOT_DRILL_TARGET) {
          picked.push(...shuffle(pool));
        }
        entries = picked
          .slice(0, SPOT_DRILL_TARGET)
          .map((q) => ({ type: 'spot' as const, q }));
      } else {
        const pool = spots.filter((q) => focusMatches(focus, q));
        const ordered = [
          ...shuffle(pool.filter((q) => due.has(q.itemKey))),
          ...shuffle(pool.filter((q) => !due.has(q.itemKey))),
        ];
        entries = ordered
          .slice(0, SESSION_SPOT_TARGET)
          .map((q) => ({ type: 'spot' as const, q }));
      }
      if (entries.length === 0) return false;
      beginSession(entries, focus);
      return true;
    },
    [beginSession],
  );

  /**
   * Launch a focus from the UI (drill catalogue, saved drills,
   * history). Spot focuses load their own solve first; the rest run
   * over the trainer's already-loaded pools.
   */
  const launchFocus = useCallback(
    async (focus: TrainerFocus) => {
      setFocusNotice(null);
      const due = progress ? dueItemKeys(progress, new Date()) : new Set<string>();
      if (focus.kind === 'spot') {
        try {
          const qs = await questionsForSolve(focus.solveId, focus.solveName, focus.solveSource);
          if (!startFocused(focus, qs, [], due)) {
            setFocusNotice(
              `“${focusLabel(focus)}” has no drillable decision — the node may offer only one action, or the solve changed since the drill was saved.`,
            );
            setHomeTab('drills');
          }
        } catch {
          setFocusNotice(
            `“${focusLabel(focus)}” could not start — that solve is unreachable right now.`,
          );
          setHomeTab('drills');
        }
        return;
      }
      if (!startFocused(focus, spotQuestions, heuristicQuestions, due)) {
        setFocusNotice(
          focus.kind === 'due'
            ? 'Nothing is due for review right now — due items lead every session automatically.'
            : `“${focusLabel(focus)}” matches no questions in the solves the trainer could load.`,
        );
        setHomeTab('drills');
      }
    },
    [progress, spotQuestions, heuristicQuestions, startFocused],
  );

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

    beginSession(entries, null);
  }, [progress, spotQuestions, heuristicQuestions, beginSession]);

  // Consume a trainer focus handed off through the store (Practice
  // This Spot in the Explorer) once the home view is up. One-shot:
  // the ref + clearing the store slot mean a stale focus can never
  // re-fire on later visits home.
  const focusConsumedRef = useRef(false);
  useEffect(() => {
    if (phase !== 'home' || focusConsumedRef.current) return;
    focusConsumedRef.current = true;
    const pending = useStore.getState().trainerFocus;
    if (!pending) return;
    useStore.getState().setTrainerFocus(null);
    void launchFocus(pending);
  }, [phase, launchFocus]);

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
    // Drill catalogue + History/Stats derivations — all from real
    // loaded data (the question pools, the preflop index, and the
    // synced progress snapshot). Nothing is estimated or padded.
    const accuracyByKey = new Map<string, number>();
    const topicSource = syncState === 'synced' && progress ? progress.topics : localTopics;
    for (const [key, s] of Object.entries(topicSource)) {
      if (s.attempts > 0) accuracyByKey.set(key, s.score_sum / s.attempts);
    }
    const streetEntries = streetDrillEntries(spotQuestions);
    const spotTypeEntries = spotTypeDrillEntries(spotQuestions);
    const topicEntries = topicDrillEntries(spotQuestions, accuracyByKey);
    const preflopGroups = preflopIndex ? preflopDrillGroups(preflopIndex) : [];
    const sampleOnly =
      spotQuestions.length > 0 && spotQuestions.every((q) => q.solveSource === 'sample');
    const questionsByKey = new Map(spotQuestions.map((q) => [q.itemKey, q]));
    const heuristicTextById = new Map<string, string>();
    for (const hq of heuristicQuestions) {
      for (const o of hq.options) heuristicTextById.set(o.id, o.text);
    }
    return (
      <div className="flex flex-col gap-4">
        <header>
          <h1 className="text-xl font-bold text-ink">Quiz Trainer</h1>
          <p className="text-sm text-ink-dim">
            Self-testing built from your solved spots and your own heuristics — graded against
            the solver, with spaced repetition so misses come back sooner.
          </p>
        </header>

        {focusNotice ? (
          <p
            className="rounded-lg border border-accent/60 bg-navy-850 px-3 py-2.5 text-sm text-ink"
            role="alert"
          >
            {focusNotice}
          </p>
        ) : null}

        <div
          className="flex gap-1.5 border-b border-navy-700"
          role="tablist"
          aria-label="Trainer views"
        >
          {(
            [
              ['train', 'Train'],
              ['drills', 'Drills'],
              ['history', 'History'],
              ['stats', 'Stats'],
            ] as [HomeTab, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={homeTab === key}
              onClick={() => setHomeTab(key)}
              className={`rounded-t-md px-3 py-1.5 text-sm ${
                homeTab === key
                  ? 'bg-navy-800 font-semibold text-ink ring-1 ring-navy-700'
                  : 'text-ink-dim hover:bg-navy-800 hover:text-ink'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {homeTab === 'train' ? (
          <>
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
            <div className="max-w-xl">
              <TopicBars chips={chips} limit={8} />
            </div>
            <p className="mt-1.5 text-xs text-ink-faint">
              Weakest first; amber bars are below 70% — those topics’ questions keep resurfacing
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
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={startSession}
              className="rounded-md bg-table px-4 py-2 text-sm font-semibold text-white hover:bg-table-dark"
            >
              Start session
              {dueCount > 0 && syncState === 'synced' ? ` (${dueCount} due first)` : ''}
            </button>
            <button
              type="button"
              onClick={() => setHomeTab('drills')}
              className="rounded-md bg-navy-800 px-4 py-2 text-sm font-semibold text-ink ring-1 ring-navy-600 hover:bg-navy-700"
            >
              Browse drills
            </button>
          </div>
        )}
          </>
        ) : null}

        {homeTab === 'drills' ? (
          <DrillsSection
            savedDrills={savedDrills}
            dueCount={dueCount}
            syncState={syncState}
            noQuestions={noQuestions}
            sampleOnly={sampleOnly}
            streetEntries={streetEntries}
            spotTypeEntries={spotTypeEntries}
            topicEntries={topicEntries}
            preflopGroups={preflopGroups}
            preflopLoaded={preflopIndex !== null}
            onMixed={startSession}
            onLaunch={(focus) => void launchFocus(focus)}
            onDeleteSaved={(id) => setSavedDrills(removeSavedDrill(id))}
            onPreflop={(group) => {
              useStore.getState().setPreflopDrillSetId(group.firstSetId);
              navigate('/starting-hands');
            }}
          />
        ) : null}

        {homeTab === 'history' ? (
          syncState === 'synced' && progress ? (
            <HistorySection
              progress={progress}
              questionsByKey={questionsByKey}
              heuristicTextById={heuristicTextById}
              openingKey={openingKey}
              openError={openError}
              onOpenExplorer={(q) => void openInExplorer(q)}
              onPractice={(focus) => void launchFocus(focus)}
              onPreflopAgain={(setId) => {
                useStore.getState().setPreflopDrillSetId(setId);
                navigate('/starting-hands');
              }}
            />
          ) : (
            <section className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel">
              <h2 className="text-sm font-semibold text-ink">History lives with your synced progress</h2>
              <p className="mt-1 text-sm text-ink-dim">
                {syncState === 'locked'
                  ? 'Sign in (admin) to sync quiz progress — your training history is stored with it, per item, across devices.'
                  : syncState === 'checking'
                    ? 'Checking your synced progress…'
                    : 'The job service is unreachable, so your stored history cannot load this visit. Answers from this visit still appear in the session rail while you train.'}
              </p>
            </section>
          )
        ) : null}

        {homeTab === 'stats' ? (
          syncState === 'synced' && progress ? (
            <StatsSection progress={progress} />
          ) : (
            <section className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel">
              <h2 className="text-sm font-semibold text-ink">Stats live with your synced progress</h2>
              <p className="mt-1 text-sm text-ink-dim">
                {syncState === 'locked'
                  ? 'Sign in (admin) to sync quiz progress — volume and accuracy stats are computed from it, across every session and device.'
                  : syncState === 'checking'
                    ? 'Checking your synced progress…'
                    : 'The job service is unreachable, so your stored stats cannot load this visit. This session’s stats are in the rail while you train.'}
              </p>
            </section>
          )
        ) : null}
      </div>
    );
  }

  if (phase === 'summary') {
    const avg =
      answered.length > 0
        ? answered.reduce((a, r) => a + r.grade.score, 0) / answered.length
        : 0;
    const bandCounts = {
      solid: answered.filter((r) => r.grade.band === 'solid').length,
      partial: answered.filter((r) => r.grade.band === 'partial').length,
      miss: answered.filter((r) => r.grade.band === 'miss').length,
    };
    const evLossPcts: number[] = [];
    for (const r of answered) {
      if (r.entry.type === 'spot' && r.grade.evLostChips !== null && r.entry.q.pot > 0) {
        evLossPcts.push((r.grade.evLostChips / r.entry.q.pot) * 100);
      }
    }
    const avgEvLossPct =
      evLossPcts.length > 0
        ? evLossPcts.reduce((a, v) => a + v, 0) / evLossPcts.length
        : null;
    return (
      <div className="flex flex-col gap-4">
        <header>
          <h1 className="text-xl font-bold text-ink">Session done</h1>
          {sessionFocus ? (
            <p className="text-xs font-medium uppercase tracking-wide text-accent">
              Drill · {focusLabel(sessionFocus)}
            </p>
          ) : null}
          <p className="text-sm text-ink-dim">
            {answered.length} hands · accuracy {(avg * 100).toFixed(0)}% · solid{' '}
            {bandCounts.solid} / partial {bandCounts.partial} / missed {bandCounts.miss}
            {avgEvLossPct !== null
              ? ` · avg EV loss ${avgEvLossPct.toFixed(1)}% of pot (EV-graded answers)`
              : ''}
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
              {r.entry.type === 'spot' ? (
                <button
                  type="button"
                  disabled={openingKey !== null}
                  onClick={() => {
                    if (r.entry.type === 'spot') void openInExplorer(r.entry.q);
                  }}
                  className="text-xs text-table-light underline hover:text-table disabled:opacity-50"
                >
                  {openingKey === (r.entry.type === 'spot' ? r.entry.q.itemKey : null)
                    ? 'Opening…'
                    : 'Open in Explorer'}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {openError ? (
          <p className="text-sm text-red-300" role="alert">
            {openError}
          </p>
        ) : null}
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

        {sessionFocus ? (
          <section className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel">
            <h2 className="text-sm font-semibold text-ink">Save as drill</h2>
            <p className="mt-1 text-xs text-ink-dim">
              Keep “{focusLabel(sessionFocus)}” as a named drill on this device. The drill
              stores the setup, not the questions — launching it re-derives questions from the
              solves the trainer can load then.
            </p>
            {drillSaved ? (
              <p className="mt-2 text-sm text-table-light">
                Saved — find it under Drills · Your drills.
              </p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-2">
                <input
                  type="text"
                  value={drillName}
                  onChange={(e) => setDrillName(e.target.value)}
                  placeholder={focusLabel(sessionFocus)}
                  aria-label="Drill name"
                  className="min-w-52 flex-1 rounded-md border border-navy-600 bg-navy-850 px-3 py-2 text-sm text-ink placeholder:text-ink-faint"
                />
                <button
                  type="button"
                  onClick={() => {
                    setSavedDrills(addSavedDrill(drillName, sessionFocus));
                    setDrillSaved(true);
                  }}
                  className="rounded-md bg-navy-800 px-4 py-2 text-sm font-semibold text-ink ring-1 ring-navy-600 hover:bg-navy-700"
                >
                  Save drill
                </button>
              </div>
            )}
          </section>
        ) : null}
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
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex flex-col gap-4">
        <p className="text-xs text-ink-faint">
          {progressText} · from your heuristics log
          {sessionFocus ? (
            <span className="ml-2 font-medium text-accent">Drill · {focusLabel(sessionFocus)}</span>
          ) : null}
        </p>
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
        <SessionRail
          answered={answered}
          chips={chips}
          dueCount={dueCount}
          syncState={syncState}
          openingKey={openingKey}
          openError={openError}
          onOpenExplorer={(sq) => void openInExplorer(sq)}
        />
      </div>
    );
  }

  const q = current.q;
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="flex flex-col gap-4">
        <p className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
          {progressText} · {q.solveName}
          {q.solveSource === 'sample' ? ' · bundled sample' : ''}
          {sessionFocus ? (
            <span className="font-medium text-accent">Drill · {focusLabel(sessionFocus)}</span>
          ) : null}
          <span className="ml-auto font-medium text-accent">Topic: {topicLabel(q.topic)}</span>
        </p>

        {/* Stage (Figma trainer frame): pot, board, the line, hero hand. */}
        <section
          aria-label="Spot"
          className="rounded-xl bg-table-dark px-4 py-5 shadow-panel ring-1 ring-table"
        >
          <p className="text-center text-sm font-bold uppercase tracking-widest text-white">
            Pot {q.pot.toFixed(0)}
            {q.toCall > 0 ? (
              <span className="font-semibold text-white/75"> · {q.toCall.toFixed(0)} to call</span>
            ) : null}
          </p>
          <div className="mt-3 flex justify-center">
            <CardRow cards={cardsOf(q.board)} size="lg" />
          </div>
          <p className="mt-3 text-center text-sm text-white/85">
            {q.line.length > 0 ? q.line.join(' → ') : 'First decision of the hand.'}
          </p>
          <p className="mt-4 text-center text-xs font-semibold uppercase tracking-wide text-white/65">
            You are {q.player} · {q.street} · you hold
          </p>
          <div className="mt-1.5 flex justify-center">
            <CardRow cards={cardsOf(q.heroCards)} size="lg" />
          </div>
        </section>

        {grade ? (
          <FeedbackBanner
            q={q}
            grade={grade}
            pickedAction={pickedAction}
            onNext={next}
            isLast={index + 1 >= session.length}
          />
        ) : null}

        <section
          aria-label="Your answer"
          className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel"
        >
          <h1 className="text-base font-semibold text-ink">
            What does the solver do with this hand?
          </h1>
          <div className="mt-3 flex flex-wrap gap-2">
            {q.actions.map((label, i) => {
              const picked = pickedAction === i;
              const isBest = grade !== null && i === grade.bestActionIdx;
              const isPick = grade !== null && picked;
              return (
                <button
                  key={label}
                  type="button"
                  disabled={grade !== null}
                  onClick={() => setPickedAction(i)}
                  aria-pressed={picked}
                  className={`min-w-[8rem] flex-1 rounded-lg border px-3 py-2.5 text-left transition-colors ${
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
                    <span className="flex items-baseline gap-1.5 font-semibold text-ink">
                      <span
                        className="h-2 w-2 shrink-0 translate-y-[-1px] rounded-full"
                        style={{ backgroundColor: actionColor(label) }}
                        aria-hidden="true"
                      />
                      {prettyAction(label)}
                    </span>
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
              );
            })}
          </div>

          {!grade ? (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={pickedAction === null}
              className="mt-4 rounded-md bg-table px-4 py-2 text-sm font-semibold text-white hover:bg-table-dark disabled:cursor-not-allowed disabled:opacity-60"
            >
              Check answer
            </button>
          ) : null}
        </section>

        <p className="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-wide text-ink-faint">
          Source: {solveSourceLabel(q.solveSource)} · {topicLabel(q.topic)} ·{' '}
          <AccuracyBadge nashPct={q.nashPct} />
        </p>
      </div>

      <SessionRail
        answered={answered}
        chips={chips}
        dueCount={dueCount}
        syncState={syncState}
        openingKey={openingKey}
        openError={openError}
        onOpenExplorer={(sq) => void openInExplorer(sq)}
      />
    </div>
  );
}

// ---------- Home tabs: Drills / History / Stats (issue #22) ----------------
// Every number below derives from the loaded question pools or the
// synced progress snapshot. Where the stored data cannot support a
// surface (the action you picked, EV-loss aggregates, postflop
// position), the section says so instead of estimating it.

type QuizItem = QuizProgress['items'][string];

function DrillEntryCard({
  label,
  count,
  detail,
  actionLabel = 'Start drill',
  disabled = false,
  disabledNote,
  onLaunch,
}: {
  label: string;
  count: number | null;
  detail: string;
  actionLabel?: string;
  disabled?: boolean;
  disabledNote?: string;
  onLaunch: () => void;
}) {
  return (
    <div className="flex flex-col rounded-lg border border-navy-700 bg-navy-900 p-3 shadow-panel">
      <h3 className="text-sm font-semibold text-ink">{label}</h3>
      <p className="mt-0.5 text-xs text-ink-dim">{detail}</p>
      <div className="mt-auto flex items-baseline justify-between gap-2 pt-3">
        <span className="font-mono text-sm text-ink-dim">
          {count !== null ? `${count} questions` : ''}
        </span>
        <button
          type="button"
          disabled={disabled}
          onClick={onLaunch}
          title={disabled ? disabledNote : undefined}
          className="rounded-md bg-navy-800 px-3 py-1.5 text-xs font-semibold text-table-light ring-1 ring-navy-600 hover:bg-navy-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {actionLabel}
        </button>
      </div>
      {disabled && disabledNote ? (
        <p className="mt-1.5 text-xs text-ink-faint">{disabledNote}</p>
      ) : null}
    </div>
  );
}

function DrillsSection({
  savedDrills,
  dueCount,
  syncState,
  noQuestions,
  sampleOnly,
  streetEntries,
  spotTypeEntries,
  topicEntries,
  preflopGroups,
  preflopLoaded,
  onMixed,
  onLaunch,
  onDeleteSaved,
  onPreflop,
}: {
  savedDrills: SavedDrill[];
  dueCount: number;
  syncState: SyncState;
  noQuestions: boolean;
  sampleOnly: boolean;
  streetEntries: DrillEntry[];
  spotTypeEntries: DrillEntry[];
  topicEntries: DrillEntry[];
  preflopGroups: PreflopDrillGroup[];
  preflopLoaded: boolean;
  onMixed: () => void;
  onLaunch: (focus: TrainerFocus) => void;
  onDeleteSaved: (id: string) => void;
  onPreflop: (group: PreflopDrillGroup) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">Your drills</h2>
        {savedDrills.length === 0 ? (
          <p className="rounded-lg border border-navy-700 bg-navy-900 p-3 text-sm text-ink-dim shadow-panel">
            No saved drills. Run any focused session below — or Practice This Spot in the
            Explorer — and save it as a drill from the results screen. Drills are saved on
            this device and store the setup only; the questions are re-derived from your
            solves each time you launch one.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {savedDrills.map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-navy-700 bg-navy-900 px-3 py-2.5 shadow-panel"
              >
                <span className="text-sm font-semibold text-ink">{d.name}</span>
                <span className="text-xs text-ink-faint">{focusLabel(d.focus)}</span>
                <span className="ml-auto flex gap-2">
                  <button
                    type="button"
                    onClick={() => onLaunch(d.focus)}
                    className="rounded-md bg-navy-800 px-3 py-1.5 text-xs font-semibold text-table-light ring-1 ring-navy-600 hover:bg-navy-700"
                  >
                    Start drill
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteSaved(d.id)}
                    className="rounded-md px-2 py-1.5 text-xs text-ink-dim hover:bg-navy-800 hover:text-ink"
                  >
                    Delete
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">Postflop drills</h2>
        {sampleOnly ? (
          <p className="mb-2 rounded-lg border border-accent/60 bg-navy-850 px-3 py-2.5 text-xs leading-relaxed text-ink-dim">
            These drills are drawn from the solves the trainer could load — right now that
            is only the bundled sample solve, because the 300-spot library has not been
            solved yet. The list is short by reality, not by omission: every finished
            library solve adds its decisions here automatically.
          </p>
        ) : null}
        {noQuestions ? (
          <p className="text-sm text-ink-dim">
            No postflop questions could be generated from the loaded solves, so there is
            nothing honest to drill yet.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <DrillEntryCard
              label="Mixed session"
              count={null}
              detail="Spots and heuristics mixed, due reviews first — the standard session."
              actionLabel="Start session"
              onLaunch={onMixed}
            />
            <DrillEntryCard
              label="Due for review"
              count={syncState === 'synced' ? dueCount : null}
              detail="Only the items the spaced-repetition ladder says are due now."
              disabled={syncState !== 'synced' || dueCount === 0}
              disabledNote={
                syncState !== 'synced'
                  ? 'Due reviews need synced progress (sign in).'
                  : 'Nothing is due right now.'
              }
              onLaunch={() => onLaunch({ kind: 'due' })}
            />
            {streetEntries.map((e) => (
              <DrillEntryCard
                key={e.label}
                label={e.label}
                count={e.count}
                detail={e.detail}
                onLaunch={() => onLaunch(e.focus)}
              />
            ))}
            {spotTypeEntries.map((e) => (
              <DrillEntryCard
                key={e.label}
                label={e.label}
                count={e.count}
                detail={e.detail}
                onLaunch={() => onLaunch(e.focus)}
              />
            ))}
          </div>
        )}

        {topicEntries.length > 0 ? (
          <>
            <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-ink-faint">
              By topic — weakest first
            </h3>
            <ul className="flex flex-col gap-1.5">
              {topicEntries.map((e) => (
                <li
                  key={e.label}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-navy-700 bg-navy-900 px-3 py-2 text-sm shadow-panel"
                >
                  <span className="min-w-0 flex-1 truncate text-ink" title={e.label}>
                    {e.label}
                  </span>
                  <span className="text-xs text-ink-faint">{e.detail}</span>
                  <span className="font-mono text-xs text-ink-dim">{e.count} questions</span>
                  <button
                    type="button"
                    onClick={() => onLaunch(e.focus)}
                    className="rounded-md bg-navy-800 px-3 py-1.5 text-xs font-semibold text-table-light ring-1 ring-navy-600 hover:bg-navy-700"
                  >
                    Start drill
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink">Preflop drills</h2>
        {!preflopLoaded ? (
          <p className="text-sm text-ink-dim">
            The preflop range-set index could not be loaded, so preflop drills are
            unavailable this visit. The Starting Hands page drills the same sets.
          </p>
        ) : preflopGroups.length === 0 ? (
          <p className="text-sm text-ink-dim">
            The range-set index has no drillable sets yet.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {preflopGroups.map((g) => (
              <DrillEntryCard
                key={g.key}
                label={g.label}
                count={null}
                detail={`${g.detail} ${g.setCount} sets — opens Starting Hands on the first set; every position in the group is one picker step away there.`}
                actionLabel="Open in Starting Hands"
                onLaunch={() => onPreflop(g)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function parseSpotItemKey(
  itemKey: string,
): { solveId: string; history: string; combo: string } | null {
  const first = itemKey.indexOf('|');
  const last = itemKey.lastIndexOf('|');
  if (first <= 0 || last <= first) return null;
  return {
    solveId: itemKey.slice(0, first),
    history: itemKey.slice(first + 1, last),
    combo: itemKey.slice(last + 1),
  };
}

function gradingLabel(g: QuizItem['last_grading']): string {
  return g === 'ev'
    ? 'EV-lost grading'
    : g === 'frequency'
      ? 'frequency-match grading'
      : g === 'match'
        ? 'recall grading'
        : '—';
}

function HistorySection({
  progress,
  questionsByKey,
  heuristicTextById,
  openingKey,
  openError,
  onOpenExplorer,
  onPractice,
  onPreflopAgain,
}: {
  progress: QuizProgress;
  questionsByKey: Map<string, SpotQuestion>;
  heuristicTextById: Map<string, string>;
  openingKey: string | null;
  openError: string | null;
  onOpenExplorer: (q: SpotQuestion) => void;
  onPractice: (focus: TrainerFocus) => void;
  onPreflopAgain: (setId: string) => void;
}) {
  const now = new Date();
  const rows = Object.entries(progress.items)
    .map(([itemKey, item]) => ({ itemKey, item }))
    .sort((a, b) => {
      const at = a.item.last_at ? new Date(a.item.last_at).getTime() : 0;
      const bt = b.item.last_at ? new Date(b.item.last_at).getTime() : 0;
      return bt - at;
    })
    .slice(0, 30);

  return (
    <section className="flex flex-col gap-3">
      <p className="text-xs leading-relaxed text-ink-faint">
        Your most recently graded items, from your synced progress. Each row shows the
        item’s latest grade — the progress store keeps the latest score per item, not the
        action you picked, so rows show the grade rather than the pick. EV loss is not
        stored either; it arrives with per-action EVs (issue #8).
      </p>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-navy-700 bg-navy-900 p-3 text-sm text-ink-dim shadow-panel">
          Nothing graded yet — finish a session and your items will land here.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map(({ itemKey, item }) => {
            const due = new Date(item.due_at).getTime() <= now.getTime();
            const meta = (
              <>
                <span className="font-mono text-ink-dim">
                  {item.last_score !== null
                    ? `${(item.last_score * 100).toFixed(0)}%`
                    : '—'}
                </span>
                <span>{gradingLabel(item.last_grading)}</span>
                <span>
                  {item.attempts} attempt{item.attempts === 1 ? '' : 's'}
                </span>
                {item.last_at ? (
                  <span>{new Date(item.last_at).toLocaleDateString()}</span>
                ) : null}
                {due ? <span className="font-medium text-accent">due now</span> : null}
              </>
            );

            if (item.kind === 'spot') {
              const parsed = parseSpotItemKey(itemKey);
              const loaded = questionsByKey.get(itemKey);
              const cards = parsed ? parseCombo(parsed.combo) : null;
              const focus: TrainerFocus | null = loaded
                ? {
                    kind: 'spot',
                    solveId: loaded.solveId,
                    solveName: loaded.solveName,
                    solveSource: loaded.solveSource,
                    history: nodeHistoryOf(loaded),
                  }
                : parsed
                  ? {
                      kind: 'spot',
                      solveId: parsed.solveId,
                      solveName: parsed.solveId,
                      solveSource: parsed.solveId === 'sample' ? 'sample' : 'library',
                      history: parsed.history,
                    }
                  : null;
              return (
                <li
                  key={itemKey}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-navy-700 bg-navy-900 px-3 py-2.5 text-xs text-ink-faint shadow-panel"
                >
                  {cards ? <CardRow cards={cards} size="xs" /> : null}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">
                      {loaded?.solveName ?? parsed?.solveId ?? itemKey}
                    </span>
                    <span className="block">{topicLabel(item.topic)}</span>
                  </span>
                  {meta}
                  {loaded ? (
                    <button
                      type="button"
                      disabled={openingKey !== null}
                      onClick={() => onOpenExplorer(loaded)}
                      className="text-table-light underline hover:text-table disabled:opacity-50"
                    >
                      {openingKey === itemKey ? 'Opening…' : 'Open in Explorer'}
                    </button>
                  ) : null}
                  {focus ? (
                    <button
                      type="button"
                      onClick={() => onPractice(focus)}
                      className="rounded-md bg-navy-800 px-2.5 py-1 text-xs font-semibold text-table-light ring-1 ring-navy-600 hover:bg-navy-700"
                    >
                      Practice again
                    </button>
                  ) : null}
                </li>
              );
            }

            if (item.kind === 'preflop') {
              const parts = itemKey.split('|');
              const setId = parts[1] ?? '';
              const classKey = parts.slice(2).join('|');
              return (
                <li
                  key={itemKey}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-navy-700 bg-navy-900 px-3 py-2.5 text-xs text-ink-faint shadow-panel"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">
                      Starting hand {classKey || '—'}
                    </span>
                    <span className="block">
                      {topicLabel(item.topic)} · set {setId}
                    </span>
                  </span>
                  {meta}
                  {setId ? (
                    <button
                      type="button"
                      onClick={() => onPreflopAgain(setId)}
                      className="rounded-md bg-navy-800 px-2.5 py-1 text-xs font-semibold text-table-light ring-1 ring-navy-600 hover:bg-navy-700"
                    >
                      Drill this set
                    </button>
                  ) : null}
                </li>
              );
            }

            const heuristicId = itemKey.startsWith('heuristic|')
              ? itemKey.slice('heuristic|'.length)
              : '';
            return (
              <li
                key={itemKey}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-navy-700 bg-navy-900 px-3 py-2.5 text-xs text-ink-faint shadow-panel"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-ink">
                    {heuristicTextById.get(heuristicId) ?? 'Heuristic question'}
                  </span>
                  <span className="block">{topicLabel(item.topic)}</span>
                </span>
                {meta}
              </li>
            );
          })}
        </ul>
      )}
      {openError ? (
        <p className="text-xs text-red-300" role="alert">
          {openError}
        </p>
      ) : null}
    </section>
  );
}

function StatsSection({ progress }: { progress: QuizProgress }) {
  const items = Object.values(progress.items);
  const totalAnswers = items.reduce((a, i) => a + i.attempts, 0);
  const dueNow = dueItemKeys(progress, new Date()).size;
  const topicEntries = Object.entries(progress.topics);
  const topicAttempts = topicEntries.reduce((a, [, s]) => a + s.attempts, 0);
  const topicScore = topicEntries.reduce((a, [, s]) => a + s.score_sum, 0);
  const overall = topicAttempts > 0 ? topicScore / topicAttempts : null;

  const byStreet = new Map<string, { attempts: number; score_sum: number }>();
  const preflopByPosition = new Map<string, { attempts: number; score_sum: number }>();
  for (const [key, s] of topicEntries) {
    const [texture = '', street = ''] = key.split('|');
    const streetLabel =
      texture === 'preflop'
        ? 'Preflop'
        : street.charAt(0).toUpperCase() + street.slice(1);
    const agg = byStreet.get(streetLabel) ?? { attempts: 0, score_sum: 0 };
    agg.attempts += s.attempts;
    agg.score_sum += s.score_sum;
    byStreet.set(streetLabel, agg);
    if (texture === 'preflop') {
      const pos = preflopByPosition.get(street) ?? { attempts: 0, score_sum: 0 };
      pos.attempts += s.attempts;
      pos.score_sum += s.score_sum;
      preflopByPosition.set(street, pos);
    }
  }
  const streetOrder = ['Preflop', 'Flop', 'Turn', 'River'];
  const streetRows = [...byStreet.entries()].sort(
    (a, b) => streetOrder.indexOf(a[0]) - streetOrder.indexOf(b[0]),
  );
  const positionRows = [...preflopByPosition.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  const chips = topicStatsChips(progress.topics);

  const statCard = (label: string, value: string, note: string) => (
    <div className="rounded-lg border border-navy-700 bg-navy-900 p-3 shadow-panel">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{label}</h3>
      <p className="mt-1 font-mono text-lg text-ink">{value}</p>
      <p className="text-xs text-ink-dim">{note}</p>
    </div>
  );
  const tableShell = (
    title: string,
    rows: [string, { attempts: number; score_sum: number }][],
    firstCol: string,
  ) => (
    <section>
      <h3 className="mb-2 text-sm font-semibold text-ink">{title}</h3>
      <table className="w-full max-w-xl text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
            <th className="pb-1 font-semibold">{firstCol}</th>
            <th className="pb-1 font-semibold">Answers</th>
            <th className="pb-1 font-semibold">Accuracy</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, s]) => (
            <tr key={label} className="border-t border-navy-800">
              <td className="py-1.5 text-ink">{label}</td>
              <td className="py-1.5 font-mono text-ink-dim">{s.attempts}</td>
              <td className="py-1.5 font-mono text-ink-dim">
                {s.attempts > 0 ? `${((s.score_sum / s.attempts) * 100).toFixed(0)}%` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );

  return (
    <div className="flex flex-col gap-5">
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {statCard('Graded answers', String(totalAnswers), 'Across every item and session.')}
        {statCard('Items in rotation', String(items.length), 'Distinct spots, heuristics and starting hands you have been graded on.')}
        {statCard('Due now', String(dueNow), 'Items the spaced-repetition ladder wants back.')}
        {statCard(
          'Overall accuracy',
          overall !== null ? `${(overall * 100).toFixed(0)}%` : '—',
          'Mean grade score over all graded answers.',
        )}
      </section>

      {streetRows.length > 0 ? tableShell('Accuracy by street', streetRows, 'Street') : null}
      {positionRows.length > 0
        ? tableShell('Preflop accuracy by position', positionRows, 'Position')
        : null}

      {chips.length > 0 ? (
        <section>
          <h3 className="mb-2 text-sm font-semibold text-ink">Accuracy by topic</h3>
          <div className="max-w-xl">
            <TopicBars chips={chips} limit={12} />
          </div>
        </section>
      ) : null}

      <section className="rounded-lg border border-navy-700 bg-navy-900 p-3 text-xs leading-relaxed text-ink-dim shadow-panel">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
          What these stats cannot show yet
        </h3>
        <p>
          The progress store keeps each item’s latest score and running totals — not a
          per-answer band history — so a Correct / Partial / Miss split exists per session
          (see the results screen and the session rail), not as a standing total. Average
          EV-loss stats wait on per-action EVs (issue #8): no solve carries them yet, and
          no EV figure is estimated in the meantime. Postflop accuracy by position is not
          shown because topics record street and texture, not which seat you played.
        </p>
      </section>
    </div>
  );
}

/**
 * Instant feedback after a spot answer (Figma trainer frame): the
 * verdict on your pick plus the solver's own frequency for that action
 * with this exact hand. The grade's detail copy keeps naming the
 * grading mode — frequency match today, EV lost only when the solve
 * carries per-action EVs.
 */
function FeedbackBanner({
  q,
  grade,
  pickedAction,
  onNext,
  isLast,
}: {
  q: SpotQuestion;
  grade: GradeResult;
  pickedAction: number | null;
  onNext: () => void;
  isLast: boolean;
}) {
  const chosenLabel = pickedAction !== null ? q.actions[pickedAction] : undefined;
  const chosenFreq = pickedAction !== null ? (q.frequencies[pickedAction] ?? 0) : 0;
  const bandClass =
    grade.band === 'solid'
      ? 'border-table bg-table/10'
      : grade.band === 'partial'
        ? 'border-accent/70 bg-accent/10'
        : 'border-red-400/50 bg-red-500/10';
  return (
    <div className={`rounded-lg border px-4 py-3 ${bandClass}`} role="status">
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-base font-bold text-ink">
          <span className={bandTextClass(grade.band)} aria-hidden="true">
            {bandIcon(grade.band)}{' '}
          </span>
          {chosenLabel
            ? `${prettyAction(chosenLabel)} — the solver ${actionVerb(chosenLabel)} ${pctText(chosenFreq)} here`
            : grade.headline}
        </span>
        <span className="ml-auto rounded-full border border-navy-600 px-2 py-0.5 text-xs text-ink-dim">
          {grade.grading === 'ev'
            ? 'Graded by EV lost'
            : grade.grading === 'frequency'
              ? 'Graded by frequency match'
              : 'Graded by recall'}
        </span>
      </p>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-3 text-sm text-ink">
        {grade.headline}
        <span className="font-mono text-sm text-ink-dim">
          score {(grade.score * 100).toFixed(0)}%
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
        {isLast ? 'See results' : 'Next hand'}
      </button>
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
    <div
      className={`mt-4 rounded-lg border px-3 py-3 ${
        grade.band === 'solid'
          ? 'border-table bg-table/10'
          : grade.band === 'partial'
            ? 'border-accent/70 bg-accent/10'
            : 'border-red-400/50 bg-red-500/10'
      }`}
      role="status"
    >
      <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-ink">
          <span className={bandTextClass(grade.band)} aria-hidden="true">
            {bandIcon(grade.band)}{' '}
          </span>
          {grade.headline}
        </span>
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
