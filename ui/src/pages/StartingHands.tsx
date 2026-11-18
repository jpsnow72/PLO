import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ApiError,
  createHeuristic,
  fetchHeuristics,
  fetchPreflopClassTable,
  fetchPreflopIndex,
  fetchPreflopSet,
  fetchQuizProgress,
  recordQuizAnswer,
} from '../lib/api';
import { canonicalClass, formatCards } from '../lib/cards';
import {
  actionTotals,
  featureTags,
  openerOf,
  setLabel,
  setTotalCombos,
  sortPositions,
  type PreflopClass,
  type PreflopIndex,
  type PreflopSetDoc,
  type TableSize,
} from '../lib/preflop';
import {
  buildDrillPool,
  classTableByHand,
  drawWeighted,
  gradePreflopAnswer,
  personalForSpot,
  preflopActionColor,
  preflopActionLabel,
  preflopTopic,
  preflopTopicKey,
  saveTagsFor,
  seededHeuristics,
  studySetOptions,
  variantOfSet,
  VARIANT_LABEL,
  SPOT_LABEL,
  type PreflopDrillCard,
  type RakeVariant,
  type SeededHeuristic,
  type SpotKind,
  type StudySetOption,
} from '../lib/preflopStudy';
import {
  dueItemKeys,
  type GradeResult,
  type QuizProgress,
  type QuizTopicStats,
} from '../lib/quiz';
import type { Heuristic } from '../lib/study';
import { ApproximationBadge } from '../components/ApproximationBadge';
import { CardRow } from '../components/CardChip';
import { FrequencyBar, pctText } from '../components/FrequencyBar';

// Starting Hands: a preflop drill over the constructed range sets,
// built around Justin's heuristics. Presentation mirrors the Quiz
// trainer (stage, instant-feedback banner, session rail with streak
// and per-position accuracy, history). Grading is frequency match
// against the constructed range — named as such everywhere; these
// ranges are CONSTRUCTED data, never solver output, and carry the
// CONSTRUCTED badge wherever they appear.
//
// Progress persists through the quiz progress store (item kind
// "preflop", topic texture "preflop", street = position), so
// per-position accuracy and spaced repetition survive across
// sessions and devices. Misses are also re-queued once inside the
// session, like the Quiz trainer.

const SESSION_TARGET = 12;

type Phase = 'setup' | 'drill' | 'summary';
type SyncState = 'checking' | 'synced' | 'local';
type HeuristicsState = 'checking' | 'available' | 'locked' | 'unavailable';

interface AnsweredCard {
  card: PreflopDrillCard;
  pickedIdx: number;
  grade: GradeResult;
  repeated: boolean;
}

interface Session {
  option: StudySetOption;
  doc: PreflopSetDoc;
  pool: PreflopDrillCard[];
}

// The class table is a static 5.7 MB document; fetch it once per page
// load and share the promise (same pattern as the Preflop page).
let classTablePromise: Promise<Map<string, PreflopClass> | null> | null = null;
function loadClassTable(): Promise<Map<string, PreflopClass> | null> {
  if (!classTablePromise) {
    classTablePromise = fetchPreflopClassTable()
      .then((t) => classTableByHand(t))
      .catch(() => null);
  }
  return classTablePromise;
}

function Pill({
  active,
  disabled,
  onClick,
  children,
  title,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
        disabled
          ? 'cursor-not-allowed bg-navy-800/50 text-slate-600'
          : active
            ? 'bg-teal text-white'
            : 'bg-navy-800 text-slate-300 hover:bg-navy-700'
      }`}
    >
      {children}
    </button>
  );
}

function PickerRow({
  label,
  children,
  note,
}: {
  label: string;
  children: ReactNode;
  note?: string;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
      {note ? <p className="mt-1.5 text-xs text-slate-500">{note}</p> : null}
    </div>
  );
}

function bandGlyph(band: GradeResult['band']): string {
  return band === 'solid' ? '✓' : band === 'partial' ? '≈' : '✗';
}

function bandClasses(band: GradeResult['band']): string {
  return band === 'solid'
    ? 'border-felt bg-felt/15 text-emerald-200'
    : band === 'partial'
      ? 'border-amber bg-amber/10 text-amber-100'
      : 'border-red-400/60 bg-red-500/10 text-red-200';
}

export function StartingHandsPage() {
  // ---- library data ----
  const [index, setIndex] = useState<PreflopIndex | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const options = useMemo(() => (index ? studySetOptions(index) : []), [index]);

  // ---- setup selections ----
  const [size, setSize] = useState<TableSize | ''>('');
  const [variant, setVariant] = useState<RakeVariant | ''>('');
  const [spot, setSpot] = useState<SpotKind | ''>('');
  const [position, setPosition] = useState('');
  const [openerSel, setOpenerSel] = useState('');

  const sizes = useMemo(() => {
    const seen: TableSize[] = [];
    for (const o of options) if (!seen.includes(o.entry.table_size)) seen.push(o.entry.table_size);
    return seen.sort();
  }, [options]);
  const variantsForSize = useMemo(
    () =>
      [...new Set(options.filter((o) => o.entry.table_size === size).map((o) => o.variant))].sort(
        (a, b) => ['raked', 'no-rake', 'unknown'].indexOf(a) - ['raked', 'no-rake', 'unknown'].indexOf(b),
      ),
    [options, size],
  );
  const spotsFor = useMemo(
    () =>
      [
        ...new Set(
          options
            .filter((o) => o.entry.table_size === size && o.variant === variant)
            .map((o) => o.spot),
        ),
      ].sort(
        (a, b) =>
          (['first-in', 'defense'] as SpotKind[]).indexOf(a) -
          (['first-in', 'defense'] as SpotKind[]).indexOf(b),
      ),
    [options, size, variant],
  );
  const positionsFor = useMemo(
    () =>
      sortPositions(
        [
          ...new Set(
            options
              .filter(
                (o) => o.entry.table_size === size && o.variant === variant && o.spot === spot,
              )
              .map((o) => o.entry.position),
          ),
        ],
        (size || '6max') as TableSize,
      ),
    [options, size, variant, spot],
  );
  const openersFor = useMemo(
    () =>
      spot === 'defense'
        ? [
            ...new Set(
              options
                .filter(
                  (o) =>
                    o.entry.table_size === size &&
                    o.variant === variant &&
                    o.spot === spot &&
                    o.entry.position === position,
                )
                .map((o) => o.opener ?? ''),
            ),
          ].sort()
        : [],
    [options, size, variant, spot, position],
  );
  const chosenOption = useMemo(
    () =>
      options.find(
        (o) =>
          o.entry.table_size === size &&
          o.variant === variant &&
          o.spot === spot &&
          o.entry.position === position &&
          (spot !== 'defense' || (o.opener ?? '') === openerSel),
      ) ?? null,
    [options, size, variant, spot, position, openerSel],
  );

  // Keep every selection valid as the option lists change.
  useEffect(() => {
    if (sizes.length > 0 && !sizes.includes(size as TableSize)) setSize(sizes[0] ?? '');
  }, [sizes, size]);
  useEffect(() => {
    if (variantsForSize.length > 0 && !variantsForSize.includes(variant as RakeVariant)) {
      setVariant(variantsForSize[0] ?? '');
    }
  }, [variantsForSize, variant]);
  useEffect(() => {
    if (spotsFor.length > 0 && !spotsFor.includes(spot as SpotKind)) {
      setSpot(spotsFor[0] ?? '');
    }
  }, [spotsFor, spot]);
  useEffect(() => {
    if (positionsFor.length > 0 && !positionsFor.includes(position)) {
      setPosition(positionsFor[0] ?? '');
    }
  }, [positionsFor, position]);
  useEffect(() => {
    if (spot === 'defense' && openersFor.length > 0 && !openersFor.includes(openerSel)) {
      setOpenerSel(openersFor[0] ?? '');
    }
  }, [spot, openersFor, openerSel]);

  // ---- the chosen set's document + class table ----
  const [doc, setDoc] = useState<PreflopSetDoc | null>(null);
  const [docState, setDocState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [tableByHand, setTableByHand] = useState<Map<string, PreflopClass> | null>(null);
  const chosenId = chosenOption?.entry.id ?? null;
  useEffect(() => {
    if (!chosenId || !index) {
      setDoc(null);
      setDocState('idle');
      return;
    }
    const entry = index.rangesets.find((e) => e.id === chosenId);
    if (!entry) return;
    let cancelled = false;
    setDocState('loading');
    Promise.all([fetchPreflopSet(entry.id), loadClassTable()])
      .then(([loaded, table]) => {
        if (cancelled) return;
        setDoc(loaded);
        setTableByHand(table);
        setDocState('ready');
      })
      .catch(() => {
        if (!cancelled) setDocState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [chosenId, index]);

  // ---- heuristics log + quiz progress ----
  const [heuristics, setHeuristics] = useState<Heuristic[]>([]);
  const [heuristicsState, setHeuristicsState] = useState<HeuristicsState>('checking');
  const [progress, setProgress] = useState<QuizProgress | null>(null);
  const [syncState, setSyncState] = useState<SyncState>('checking');
  const [saveStates, setSaveStates] = useState<Record<string, 'saving' | 'saved' | 'error'>>({});

  useEffect(() => {
    let cancelled = false;
    fetchPreflopIndex()
      .then((idx) => {
        if (!cancelled) setIndex(idx);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setIndexError(
            e instanceof ApiError && e.status === 0
              ? 'The API is not reachable, so the range-set library cannot load.'
              : 'The range-set index could not be loaded.',
          );
        }
      });
    fetchHeuristics()
      .then((list) => {
        if (cancelled) return;
        setHeuristics(list);
        setHeuristicsState('available');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setHeuristicsState(e instanceof ApiError && e.status === 401 ? 'locked' : 'unavailable');
      });
    fetchQuizProgress()
      .then((p) => {
        if (cancelled) return;
        setProgress(p);
        setSyncState('synced');
      })
      .catch(() => {
        if (!cancelled) setSyncState('local');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- session ----
  const [phase, setPhase] = useState<Phase>('setup');
  const [session, setSession] = useState<Session | null>(null);
  const [queue, setQueue] = useState<PreflopDrillCard[]>([]);
  const [index0, setIndex0] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const [grade, setGrade] = useState<GradeResult | null>(null);
  const [answered, setAnswered] = useState<AnsweredCard[]>([]);
  const [localTopics, setLocalTopics] = useState<Record<string, QuizTopicStats>>({});
  const repeatedRef = useRef<Set<string>>(new Set());

  const card = queue[index0] ?? null;
  const sessionDoc = session?.doc ?? null;
  const sessionSpot: SpotKind = session ? session.option.spot : 'first-in';
  const sessionPosition = sessionDoc?.position ?? position;
  const docVariant: RakeVariant | null =
    chosenOption && doc ? variantOfSet(chosenOption.entry, doc) : null;

  const totals = useMemo(
    () => (doc ? actionTotals(doc, tableByHand) : null),
    [doc, tableByHand],
  );
  const totalCombos = useMemo(
    () => (doc ? setTotalCombos(doc, tableByHand) : 0),
    [doc, tableByHand],
  );
  const seeded = useMemo(
    () => (doc ? seededHeuristics(doc, tableByHand, totalCombos) : []),
    [doc, tableByHand, totalCombos],
  );
  const setupPersonal = useMemo(
    () =>
      spot && position ? personalForSpot(heuristics, position, spot as SpotKind) : [],
    [heuristics, position, spot],
  );
  const sessionPersonal = useMemo(
    () => personalForSpot(heuristics, sessionPosition, sessionSpot),
    [heuristics, sessionPosition, sessionSpot],
  );
  const sessionSeeded = useMemo(
    () =>
      sessionDoc
        ? seededHeuristics(sessionDoc, tableByHand, setTotalCombos(sessionDoc, tableByHand))
        : [],
    [sessionDoc, tableByHand],
  );

  const meanScore =
    answered.length > 0
      ? answered.reduce((sum, a) => sum + a.grade.score, 0) / answered.length
      : null;
  const streak = useMemo(() => {
    let n = 0;
    for (let i = answered.length - 1; i >= 0; i -= 1) {
      if (answered[i]?.grade.band === 'solid') n += 1;
      else break;
    }
    return n;
  }, [answered]);

  // Per-position accuracy: persisted quiz-store topics when synced,
  // session-local records otherwise (local records are merged over
  // the persisted ones so the bars move immediately).
  const positionRows = useMemo(() => {
    const merged = new Map<string, QuizTopicStats>();
    if (progress) {
      for (const [key, stats] of Object.entries(progress.topics)) {
        if (key.startsWith('preflop|')) merged.set(key, stats);
      }
    }
    for (const [key, stats] of Object.entries(localTopics)) merged.set(key, stats);
    const rows = [...merged.entries()].map(([key, stats]) => {
      const parts = key.split('|');
      return {
        key,
        pos: parts[1] ?? '',
        spotType: parts[2] ?? '',
        stats,
        // QuizTopicStats stores attempts + score_sum; the mean is
        // derived (the same ratio lib/quiz.ts's weakTopics computes).
        mean: stats.attempts > 0 ? stats.score_sum / stats.attempts : 0,
      };
    });
    const order = ['UTG', 'UTG+1', 'UTG+2', 'MP', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
    rows.sort(
      (a, b) =>
        order.indexOf(a.pos) - order.indexOf(b.pos) || a.spotType.localeCompare(b.spotType),
    );
    return rows;
  }, [progress, localTopics]);

  function startSession() {
    if (!chosenOption || !doc || docState !== 'ready') return;
    const pool = buildDrillPool(doc, tableByHand);
    if (pool.length === 0) return;
    const dueKeys = new Set(progress ? dueItemKeys(progress, new Date()) : []);
    const dueCards = pool.filter((c) => dueKeys.has(c.itemKey));
    // Light shuffle so due cards do not arrive in pool order.
    for (let i = dueCards.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = dueCards[i];
      dueCards[i] = dueCards[j] as PreflopDrillCard;
      dueCards[j] = tmp as PreflopDrillCard;
    }
    const lead = dueCards.slice(0, SESSION_TARGET);
    const rest = drawWeighted(
      pool,
      SESSION_TARGET - lead.length,
      new Set(lead.map((c) => c.itemKey)),
    );
    repeatedRef.current = new Set();
    setSession({ option: chosenOption, doc, pool });
    setQueue([...lead, ...rest]);
    setIndex0(0);
    setPicked(null);
    setGrade(null);
    setAnswered([]);
    setPhase('drill');
  }

  function answer(idx: number) {
    if (!card || picked !== null || !sessionDoc) return;
    const g = gradePreflopAnswer(card, idx);
    setPicked(idx);
    setGrade(g);
    setAnswered((prev) => [
      ...prev,
      { card, pickedIdx: idx, grade: g, repeated: repeatedRef.current.has(card.itemKey) },
    ]);
    const key = preflopTopicKey(sessionPosition, sessionSpot);
    setLocalTopics((prev) => {
      const cur = prev[key] ?? { attempts: 0, score_sum: 0, last_at: null };
      return {
        ...prev,
        [key]: {
          attempts: cur.attempts + 1,
          score_sum: cur.score_sum + g.score,
          last_at: new Date().toISOString(),
        },
      };
    });
    if (syncState === 'synced') {
      recordQuizAnswer({
        item_key: card.itemKey,
        kind: 'preflop',
        topic: preflopTopic(sessionPosition, sessionSpot),
        score: g.score,
        grading: 'frequency',
        ev_lost_pct: null,
      })
        .then((p) => {
          if (p) setProgress(p);
        })
        .catch(() => setSyncState('local'));
    }
  }

  function next() {
    if (!card || !grade) return;
    let nextQueue = queue;
    if (grade.band === 'miss' && !repeatedRef.current.has(card.itemKey)) {
      // Spaced-repetition lite: a missed class comes back once more
      // before the session ends (in addition to its SRS record).
      repeatedRef.current.add(card.itemKey);
      nextQueue = [...queue, card];
      setQueue(nextQueue);
    }
    setPicked(null);
    setGrade(null);
    if (index0 + 1 >= nextQueue.length) {
      setPhase('summary');
    } else {
      setIndex0(index0 + 1);
    }
  }

  async function saveSeeded(s: SeededHeuristic, forPosition: string, forSpot: SpotKind) {
    setSaveStates((prev) => ({ ...prev, [s.id]: 'saving' }));
    try {
      const created = await createHeuristic({
        text: s.text,
        source: 'manual',
        tags: saveTagsFor(forPosition, forSpot),
        linked_spot_ids: [],
        status: 'active',
      });
      setHeuristics((prev) => [created, ...prev.filter((h) => h.id !== created.id)]);
      setHeuristicsState('available');
      setSaveStates((prev) => ({ ...prev, [s.id]: 'saved' }));
    } catch (e) {
      setSaveStates((prev) => ({ ...prev, [s.id]: 'error' }));
      if (e instanceof ApiError && e.status === 401) setHeuristicsState('locked');
    }
  }

  // ------------------------------ render helpers ------------------------------

  function heuristicCard(
    s: SeededHeuristic,
    forPosition: string,
    forSpot: SpotKind,
  ) {
    const state = saveStates[s.id];
    return (
      <div key={s.id} className="rounded-lg bg-navy-800 p-3">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-200">{s.title}</span>
          <span className="rounded bg-amber/15 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-amber">
            SEEDED STARTER · FROM THIS SET
          </span>
        </div>
        <p className="text-sm text-slate-300">{s.text}</p>
        <div className="mt-2">
          {state === 'saved' ? (
            <span className="text-xs font-medium text-emerald-300">Saved to your heuristics log ✓</span>
          ) : heuristicsState === 'available' ? (
            <button
              type="button"
              disabled={state === 'saving'}
              onClick={() => void saveSeeded(s, forPosition, forSpot)}
              className="rounded bg-teal px-2.5 py-1 text-xs font-medium text-white hover:bg-teal/85 disabled:opacity-50"
            >
              {state === 'saving' ? 'Saving…' : state === 'error' ? 'Retry save' : 'Save to my heuristics'}
            </button>
          ) : heuristicsState === 'locked' ? (
            <span className="text-xs text-slate-500">Sign in (admin) to save this to your log.</span>
          ) : (
            <span className="text-xs text-slate-500">
              Heuristics log unavailable right now — saving is off.
            </span>
          )}
        </div>
      </div>
    );
  }

  function personalCard(h: Heuristic) {
    return (
      <div key={h.id} className="rounded-lg bg-navy-800 p-3">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="rounded bg-teal/20 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-teal">
            FROM YOUR LOG
          </span>
          <span className="text-[11px] text-slate-500">
            {h.tags.spot_type ?? h.tags.texture ?? 'starting hands'}
          </span>
        </div>
        <p className="text-sm text-slate-200">{h.text}</p>
      </div>
    );
  }

  function heuristicPanel(
    seededList: SeededHeuristic[],
    personalList: Heuristic[],
    forPosition: string,
    forSpot: SpotKind,
  ) {
    return (
      <section className="rounded-xl border border-navy-700 bg-navy-850 p-4">
        <h2 className="mb-1 text-sm font-semibold text-slate-200">
          Heuristics for this spot
        </h2>
        <p className="mb-3 text-xs text-slate-500">
          Seeded starters are generated from this range's own numbers. Your saved
          starting-hands heuristics surface here when they match the position and spot.
        </p>
        <div className="space-y-2">
          {personalList.map((h) => personalCard(h))}
          {seededList.map((s) => heuristicCard(s, forPosition, forSpot))}
          {personalList.length === 0 && seededList.length === 0 ? (
            <p className="text-sm text-slate-500">No heuristic cards for this spot yet.</p>
          ) : null}
        </div>
      </section>
    );
  }

  // ------------------------------ setup ------------------------------

  if (phase === 'setup') {
    const absentVariants = (['raked', 'no-rake'] as RakeVariant[]).filter(
      (v) => size !== '' && !variantsForSize.includes(v),
    );
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        <header>
          <h1 className="text-2xl font-bold text-white">Starting Hands</h1>
          <p className="mt-1 text-sm text-slate-400">
            Drill preflop decisions against the constructed starting-hand ranges, with your
            heuristics at the centre. Every answer is graded by{' '}
            <span className="text-slate-200">frequency match</span>: your score is how often
            the range itself takes your pick with that hand. These ranges are{' '}
            <span className="text-slate-200">constructed</span> from hand features and
            equities — not solver output — so grades carry no EV figure and no GTO claim.
          </p>
        </header>

        {indexError ? (
          <section className="rounded-xl border border-red-400/40 bg-red-500/10 p-4 text-sm text-red-200">
            {indexError}
          </section>
        ) : !index ? (
          <p className="text-sm text-slate-400">Loading range sets…</p>
        ) : options.length === 0 ? (
          <section className="rounded-xl border border-navy-700 bg-navy-850 p-4 text-sm text-slate-300">
            The library has no first-in or vs-open range sets yet, so there is nothing to
            drill. Sets appear here as soon as the preflop library includes them.
          </section>
        ) : (
          <>
            <section className="space-y-4 rounded-xl border border-navy-700 bg-navy-850 p-4">
              <PickerRow label="Table size">
                {sizes.map((s) => (
                  <Pill key={s} active={size === s} onClick={() => setSize(s)}>
                    {s === '6max' ? '6-max' : s === '9max' ? '9-max' : s}
                  </Pill>
                ))}
              </PickerRow>
              <PickerRow
                label="Variant"
                note={
                  absentVariants.length > 0
                    ? `${absentVariants.map((v) => VARIANT_LABEL[v]).join(' and ')} sets are not in the library yet — the picker only offers variants that actually exist.`
                    : undefined
                }
              >
                {variantsForSize.map((v) => (
                  <Pill key={v} active={variant === v} onClick={() => setVariant(v)}>
                    {VARIANT_LABEL[v]}
                  </Pill>
                ))}
                {absentVariants.map((v) => (
                  <Pill key={v} active={false} disabled onClick={() => undefined} title="Not in the library yet">
                    {VARIANT_LABEL[v]} · none yet
                  </Pill>
                ))}
              </PickerRow>
              <PickerRow label="Spot">
                {spotsFor.map((s) => (
                  <Pill key={s} active={spot === s} onClick={() => setSpot(s)}>
                    {SPOT_LABEL[s]}
                  </Pill>
                ))}
              </PickerRow>
              <PickerRow label="Position">
                {positionsFor.map((p) => (
                  <Pill key={p} active={position === p} onClick={() => setPosition(p)}>
                    {p}
                  </Pill>
                ))}
              </PickerRow>
              {spot === 'defense' ? (
                <PickerRow label="Opener">
                  {openersFor.map((o) => (
                    <Pill key={o || 'unknown'} active={openerSel === o} onClick={() => setOpenerSel(o)}>
                      {o || 'Opener ?'}
                    </Pill>
                  ))}
                </PickerRow>
              ) : null}
            </section>

            {chosenOption ? (
              <section className="rounded-xl border border-navy-700 bg-navy-850 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold text-white">
                    {setLabel(chosenOption.entry)}
                  </h2>
                  <ApproximationBadge label="CONSTRUCTED" />
                </div>
                {docState === 'loading' ? (
                  <p className="mt-2 text-sm text-slate-400">Loading range…</p>
                ) : docState === 'error' ? (
                  <p className="mt-2 text-sm text-red-300">
                    This range set failed to load, so it cannot be drilled right now.
                  </p>
                ) : doc && totals ? (
                  <>
                    <div className="mt-3 space-y-1.5">
                      {Object.entries(totals)
                        .sort((a, b) => b[1] - a[1])
                        .map(([action, fraction]) => (
                          <div key={action} className="flex items-center gap-2 text-xs">
                            <span className="w-12 shrink-0 text-slate-300">
                              {preflopActionLabel(action)}
                            </span>
                            <div className="flex-1">
                              <FrequencyBar
                                fraction={fraction}
                                color={preflopActionColor(action)}
                                height="h-2"
                              />
                            </div>
                            <span className="w-12 shrink-0 text-right text-slate-400">
                              {pctText(fraction)}
                            </span>
                          </div>
                        ))}
                    </div>
                    <p className="mt-3 text-xs text-slate-500">
                      Combo-weighted totals across the whole range · {doc.stack_bb}bb stacks
                      {docVariant
                        ? ` · Rake: ${VARIANT_LABEL[docVariant].toLowerCase()}${
                            docVariant !== chosenOption.variant
                              ? ' (from the set document — the index does not carry this yet)'
                              : ''
                          }`
                        : ''}
                      {tableByHand
                        ? ''
                        : ' · Class table unavailable: feature tags and within-group stats are off for this set.'}
                    </p>
                    <p className="mt-1 text-xs text-slate-600">{doc.rake_note}</p>
                  </>
                ) : null}
                <button
                  type="button"
                  disabled={docState !== 'ready'}
                  onClick={startSession}
                  className="mt-4 w-full rounded-lg bg-felt px-4 py-3 text-sm font-semibold text-white transition-colors hover:bg-felt/85 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
                >
                  Start session · {SESSION_TARGET} hands
                </button>
                <p className="mt-2 text-xs text-slate-500">
                  {syncState === 'synced'
                    ? 'Progress syncs to your account: per-position accuracy and spaced repetition carry across sessions.'
                    : syncState === 'checking'
                      ? 'Checking for saved progress…'
                      : 'Playing locally: sign in (admin) to sync per-position accuracy and spaced repetition across devices.'}{' '}
                  Hands you miss come back once more before the session ends.
                </p>
              </section>
            ) : null}

            {spot && position
              ? heuristicPanel(seeded, setupPersonal, position, spot as SpotKind)
              : null}
          </>
        )}
      </div>
    );
  }

  // ------------------------------ summary ------------------------------

  if (phase === 'summary' || !session || !sessionDoc || !card) {
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        <header>
          <h1 className="text-2xl font-bold text-white">Session complete</h1>
          <p className="mt-1 text-sm text-slate-400">
            {session && sessionDoc ? `${setLabel(session.option.entry)} · ` : ''}
            {answered.length} hands · average frequency-match score{' '}
            {meanScore !== null ? pctText(meanScore) : '—'} (constructed range — not an EV
            figure).
          </p>
        </header>
        <section className="space-y-2">
          {answered.map((a, i) => (
            <div
              key={`${a.card.itemKey}-${i}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-navy-700 bg-navy-850 px-3 py-2 text-sm"
            >
              <span aria-hidden>{bandGlyph(a.grade.band)}</span>
              <span className="font-medium text-slate-100">{canonicalClass(formatCards(a.card.heroCards))}</span>
              <span className="text-slate-400">
                you picked {preflopActionLabel(a.card.actions[a.pickedIdx] ?? '')} · range takes
                it {pctText(a.grade.score)}
              </span>
              {a.repeated ? <span className="text-xs text-slate-500">(repeat)</span> : null}
              <span className="ml-auto text-xs text-slate-500">
                frequency match · constructed range
              </span>
            </div>
          ))}
        </section>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={startSession}
            className="rounded-lg bg-felt px-4 py-2.5 text-sm font-semibold text-white hover:bg-felt/85"
          >
            Another session on this range
          </button>
          <button
            type="button"
            onClick={() => setPhase('setup')}
            className="rounded-lg bg-navy-800 px-4 py-2.5 text-sm font-medium text-slate-200 hover:bg-navy-700"
          >
            Change range
          </button>
        </div>
      </div>
    );
  }

  // ------------------------------ drill ------------------------------

  const opener = openerOf(sessionDoc);
  const contextLine =
    sessionSpot === 'defense'
      ? `${sessionPosition} — facing a ${opener ?? openerSel ?? ''} open`
      : sessionDoc.context === 'sb_play'
        ? `${sessionPosition} — first in from the small blind`
        : `${sessionPosition} — folded to you`;
  // After a miss, surface the heuristic for this spot: Justin's own
  // matching log entry first, else the seeded starter card.
  const isMiss = grade !== null && grade.band === 'miss';
  const missPersonal = isMiss ? (sessionPersonal[0] ?? null) : null;
  const missSeeded = isMiss && !missPersonal ? (sessionSeeded[0] ?? null) : null;
  const willRepeat = isMiss && !repeatedRef.current.has(card.itemKey);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold text-white">Starting Hands</h1>
        <span className="text-sm text-slate-400">
          Hand {Math.min(index0 + 1, queue.length)} of {queue.length} ·{' '}
          {setLabel(session.option.entry)}
        </span>
        <ApproximationBadge label="CONSTRUCTED" />
        <button
          type="button"
          onClick={() => setPhase('summary')}
          className="ml-auto rounded bg-navy-800 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-navy-700"
        >
          End session
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          {/* Stage */}
          <section className="rounded-xl border border-felt/50 bg-[#123B2A] p-4 sm:p-5">
            <div className="text-lg font-semibold text-white">{contextLine}</div>
            <div className="mt-1 flex flex-wrap gap-1.5 text-[11px] text-emerald-100/80">
              <span className="rounded bg-black/25 px-1.5 py-0.5">
                {sessionDoc.table_size === '6max' ? '6-max' : '9-max'}
              </span>
              <span className="rounded bg-black/25 px-1.5 py-0.5">
                {VARIANT_LABEL[variantOfSet(session.option.entry, sessionDoc)]}
              </span>
              <span className="rounded bg-black/25 px-1.5 py-0.5">{sessionDoc.stack_bb}bb</span>
              <span className="rounded bg-black/25 px-1.5 py-0.5">constructed range</span>
            </div>
            <div className="mt-4">
              <div className="mb-1 text-[11px] font-semibold tracking-wide text-emerald-100/70 uppercase">
                Your hand
              </div>
              <CardRow cards={card.heroCards} size="lg" />
            </div>
            {card.cls ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {featureTags(card.cls).map((t) => (
                  <span
                    key={t}
                    className="rounded bg-black/25 px-1.5 py-0.5 text-[11px] text-emerald-50/90"
                  >
                    {t}
                  </span>
                ))}
              </div>
            ) : null}
          </section>

          {/* Actions */}
          <section className="space-y-2">
            {card.actions.map((action, idx) => {
              const freq = card.frequencies[idx] ?? 0;
              const isPick = picked === idx;
              const isBest = grade !== null && grade.bestActionIdx === idx;
              return (
                <button
                  key={action}
                  type="button"
                  disabled={picked !== null}
                  onClick={() => answer(idx)}
                  className={`w-full rounded-lg border px-4 py-3 text-left transition-colors ${
                    picked === null
                      ? 'border-navy-600 bg-navy-800 hover:border-teal hover:bg-navy-700'
                      : isPick
                        ? 'border-teal bg-navy-800'
                        : 'border-navy-700 bg-navy-850 opacity-80'
                  }`}
                >
                  <span className="flex items-baseline gap-2">
                    <span className="text-base font-semibold text-white">
                      {preflopActionLabel(action)}
                    </span>
                    {grade ? (
                      <span className="text-sm text-slate-300">
                        this range: {pctText(freq)}
                      </span>
                    ) : null}
                    {isPick ? <span className="text-xs text-teal">your pick</span> : null}
                    {isBest ? (
                      <span className="text-xs text-amber">range's main line</span>
                    ) : null}
                  </span>
                  {grade ? (
                    <span className="mt-2 block">
                      <FrequencyBar fraction={freq} color={preflopActionColor(action)} />
                    </span>
                  ) : null}
                </button>
              );
            })}
          </section>

          {/* Feedback */}
          {grade ? (
            <section className={`rounded-xl border p-4 ${bandClasses(grade.band)}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-semibold">
                  {bandGlyph(grade.band)}{' '}
                  {preflopActionLabel(card.actions[picked ?? 0] ?? '')} — this range takes it{' '}
                  {pctText(grade.score)} with this hand
                </span>
                <span className="rounded bg-black/25 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide">
                  FREQUENCY MATCH · CONSTRUCTED RANGE
                </span>
              </div>
              <p className="mt-1.5 text-sm opacity-90">
                Full split for this hand:{' '}
                {card.actions
                  .map((a, i) => `${preflopActionLabel(a)} ${pctText(card.frequencies[i] ?? 0)}`)
                  .join(' / ')}{' '}
                in this range.
              </p>
              <p className="mt-1 text-sm opacity-80">{grade.headline}. {grade.detail}</p>
              {missPersonal || missSeeded ? (
                <div className="mt-3 rounded-lg bg-black/20 p-3">
                  <div className="text-[11px] font-semibold tracking-wide uppercase opacity-80">
                    Heuristic for this spot
                    {missSeeded ? ' · seeded starter' : ' · from your log'}
                  </div>
                  <p className="mt-1 text-sm">{(missPersonal ?? missSeeded)?.text}</p>
                  {missSeeded && saveStates[missSeeded.id] !== 'saved' && heuristicsState === 'available' ? (
                    <button
                      type="button"
                      onClick={() => void saveSeeded(missSeeded, sessionPosition, sessionSpot)}
                      className="mt-2 rounded bg-teal px-2.5 py-1 text-xs font-medium text-white hover:bg-teal/85"
                    >
                      Save to my heuristics
                    </button>
                  ) : null}
                </div>
              ) : null}
              <button
                type="button"
                onClick={next}
                className="mt-3 w-full rounded-lg bg-felt px-4 py-3 text-sm font-semibold text-white hover:bg-felt/85 sm:w-auto"
              >
                {index0 + 1 >= queue.length && !willRepeat
                  ? 'See session summary'
                  : 'Next hand'}
              </button>
            </section>
          ) : null}
        </div>

        {/* Rail */}
        <div className="space-y-4">
          <section className="rounded-xl border border-navy-700 bg-navy-850 p-4">
            <h2 className="mb-3 text-sm font-semibold text-slate-200">Session</h2>
            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg bg-navy-800 px-2 py-2.5">
                <div className="text-lg font-bold text-white">{answered.length}</div>
                <div className="text-[10px] tracking-wide text-slate-400 uppercase">hands</div>
              </div>
              <div className="rounded-lg bg-navy-800 px-2 py-2.5">
                <div className="text-lg font-bold text-white">
                  {meanScore !== null ? pctText(meanScore) : '—'}
                </div>
                <div className="text-[10px] tracking-wide text-slate-400 uppercase">
                  avg frequency-match score
                </div>
              </div>
              <div className="rounded-lg bg-navy-800 px-2 py-2.5">
                <div className="text-lg font-bold text-white">{streak}</div>
                <div className="text-[10px] tracking-wide text-slate-400 uppercase">
                  solid streak
                </div>
              </div>
            </div>
            {positionRows.length > 0 ? (
              <div className="mt-4">
                <div className="mb-1 text-[11px] font-semibold tracking-wide text-slate-400 uppercase">
                  Accuracy by position
                </div>
                <p className="mb-2 text-[11px] text-slate-500">
                  {progress
                    ? 'From your synced quiz-store topics (all sessions).'
                    : 'This device only — sign in to sync.'}
                </p>
                <div className="space-y-1.5">
                  {positionRows.map((row) => (
                    <div key={row.key} className="flex items-center gap-2 text-xs">
                      <span className="w-24 shrink-0 text-slate-300">
                        {row.pos} · {row.spotType === 'first-in' ? 'First-in' : 'vs open'}
                      </span>
                      <div className="flex-1">
                        <FrequencyBar fraction={row.mean} color="#2E9E6B" height="h-2" />
                      </div>
                      <span className="w-16 shrink-0 text-right text-slate-400">
                        {pctText(row.mean)} · {row.stats.attempts}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </section>

          {heuristicPanel(sessionSeeded, sessionPersonal, sessionPosition, sessionSpot)}

          <section className="rounded-xl border border-navy-700 bg-navy-850 p-4">
            <h2 className="mb-2 text-sm font-semibold text-slate-200">History</h2>
            {answered.length === 0 ? (
              <p className="text-sm text-slate-500">No hands answered yet.</p>
            ) : (
              <div className="space-y-1.5">
                {[...answered].reverse().map((a, i) => (
                  <div
                    key={`${a.card.itemKey}-${answered.length - i}`}
                    className="flex items-center gap-2 text-xs text-slate-300"
                  >
                    <span aria-hidden>{bandGlyph(a.grade.band)}</span>
                    <span className="font-medium text-slate-100">
                      {canonicalClass(formatCards(a.card.heroCards))}
                    </span>
                    <span className="text-slate-500">
                      {preflopActionLabel(a.card.actions[a.pickedIdx] ?? '')} ·{' '}
                      {pctText(a.grade.score)}
                    </span>
                    {a.repeated ? <span className="text-slate-600">(repeat)</span> : null}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
