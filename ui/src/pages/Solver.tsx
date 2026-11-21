import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApproximationBadge } from '../components/AccuracyBadge';
import { CardRow } from '../components/CardChip';
import { CardPicker } from '../components/CardPicker';
import { pctText } from '../components/FrequencyBar';
import { parseCardList, RANKS_DESC } from '../lib/cards';
import {
  ApiError,
  fetchJob,
  fetchJobResult,
  fetchPreflopClassTable,
  fetchPreflopIndex,
  fetchPreflopSet,
  submitSolve,
} from '../lib/api';
import {
  actionTotals,
  combosInAction,
  isSolveCompatible,
  setLabel,
  solveActionForContext,
  type PreflopClass,
  type PreflopIndex,
  type PreflopSetDoc,
  type PreflopSetIndexEntry,
} from '../lib/preflop';
import {
  buildSpot,
  defaultWizardForm,
  parseRangeText,
  targetPctFor,
  TIER_LABEL,
  type AccuracyTier,
  type StreetSizes,
  type WizardForm,
} from '../lib/spot';
import type { JobRecord } from '../lib/types';
import { useStore } from '../store/useStore';

const SIZE_OPTIONS: { label: string; value: number }[] = [
  { label: '25%', value: 0.25 },
  { label: '33%', value: 0.33 },
  { label: '50%', value: 0.5 },
  { label: '75%', value: 0.75 },
  { label: '100% (pot)', value: 1.0 },
  { label: '125%', value: 1.25 },
  { label: '150%', value: 1.5 },
];

function SizeSlots({
  label,
  sizes,
  onChange,
}: {
  label: string;
  sizes: number[];
  onChange: (sizes: number[]) => void;
}) {
  const slots: (number | null)[] = [sizes[0] ?? null, sizes[1] ?? null, sizes[2] ?? null];
  const setSlot = (idx: number, value: number | null) => {
    const next = [...slots];
    next[idx] = value;
    const cleaned = next.filter((v): v is number => v !== null);
    onChange([...new Set(cleaned)].sort((a, b) => a - b));
  };
  return (
    <div>
      <span className="mb-1 block text-xs text-ink-dim">{label} (up to 3, % of pot)</span>
      <div className="flex gap-1.5">
        {slots.map((slot, i) => (
          <select
            key={i}
            value={slot === null ? '' : String(slot)}
            onChange={(e) => setSlot(i, e.target.value === '' ? null : Number(e.target.value))}
            className="w-full rounded-md border border-navy-700 bg-navy-850 px-2 py-1.5 text-sm text-ink"
            aria-label={`${label} slot ${i + 1}`}
          >
            <option value="">— none —</option>
            {SIZE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ))}
      </div>
    </div>
  );
}

function StreetEditor({
  title,
  value,
  onChange,
}: {
  title: string;
  value: StreetSizes;
  onChange: (next: StreetSizes) => void;
}) {
  return (
    <fieldset className="rounded-lg border border-navy-700 bg-navy-900 p-3">
      <legend className="px-1 text-sm font-semibold text-ink">{title}</legend>
      <div className="flex flex-col gap-3">
        <SizeSlots
          label="Bet sizes"
          sizes={value.betSizes}
          onChange={(betSizes) => onChange({ ...value, betSizes })}
        />
        <SizeSlots
          label="Raise sizes"
          sizes={value.raiseSizes}
          onChange={(raiseSizes) => onChange({ ...value, raiseSizes })}
        />
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2 text-sm text-ink-dim">
            <input
              type="checkbox"
              checked={value.allIn}
              onChange={(e) => onChange({ ...value, allIn: e.target.checked })}
              className="h-4 w-4 accent-[#2E9E6B]"
            />
            Include all-in
          </label>
          <label className="text-xs text-ink-dim">
            Max raises
            <input
              type="number"
              min={0}
              max={4}
              value={value.maxRaises}
              onChange={(e) =>
                onChange({ ...value, maxRaises: Math.max(0, Math.min(4, Number(e.target.value) || 0)) })
              }
              className="ml-2 w-16 rounded-md border border-navy-700 bg-navy-850 px-2 py-1 text-sm text-ink"
            />
          </label>
        </div>
      </div>
    </fieldset>
  );
}

/** Stats for a chosen preflop set, computed from the set document itself. */
function SetModeStats({
  setId,
  entry,
  classByHand,
}: {
  setId: string;
  entry: PreflopSetIndexEntry;
  classByHand: Map<string, PreflopClass> | null;
}) {
  const [doc, setDoc] = useState<PreflopSetDoc | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setFailed(false);
    void (async () => {
      try {
        const loaded = await fetchPreflopSet(setId);
        if (!cancelled) setDoc(loaded);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setId]);

  const action = solveActionForContext(entry.context);
  const stats = useMemo(() => {
    if (!doc || !action) return null;
    const totals = actionTotals(doc, classByHand);
    return {
      total: totals[action] ?? 0,
      combos: combosInAction(doc, action, classByHand),
    };
  }, [doc, action, classByHand]);

  return (
    <div className="mt-1 flex flex-col gap-1">
      <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
        {setLabel(entry)}
        <ApproximationBadge label="CONSTRUCTED" />
      </p>
      {failed ? (
        <p className="text-xs text-red-300">Could not load that set's details from the job service.</p>
      ) : !doc || !stats || !action ? (
        <p className="text-xs text-ink-faint">Loading set details…</p>
      ) : (
        <p className="text-xs text-ink-dim">
          {action === 'raise' ? 'Raise' : 'Call'} range: {pctText(stats.total)} of all combos ·{' '}
          {stats.combos.toLocaleString()} concrete combos. The set is a constructed range (not
          solver output); the API expands it to per-combo entries when the solve is submitted.
        </p>
      )}
    </div>
  );
}

/**
 * One side's range input: either the manual textarea or "set mode" fed by
 * the preflop library. Only solve-compatible sets are offered (RFI sets and
 * vs-RFI call sets — the same rule the API enforces).
 */
function RangeField({
  label,
  placeholder,
  text,
  setId,
  sets,
  classByHand,
  onText,
  onSet,
}: {
  label: string;
  placeholder: string;
  text: string;
  setId: string | null;
  sets: PreflopSetIndexEntry[];
  classByHand: Map<string, PreflopClass> | null;
  onText: (value: string) => void;
  onSet: (id: string | null) => void;
}) {
  const entry = setId ? (sets.find((s) => s.id === setId) ?? null) : null;
  // Live parse of the manual text (including PPT "@percent" entries) so a
  // bad entry is flagged inline the moment it is typed or pasted — never
  // silently dropped, and not only discovered on submit.
  const liveParse = useMemo(
    () => (!setId && text.trim().length > 0 ? parseRangeText(text) : null),
    [setId, text],
  );
  return (
    <div className="mt-2 first:mt-0">
      <span className="text-xs text-ink-dim">{label}</span>
      {setId ? (
        <div className="mt-1 rounded-md border border-accent/50 bg-navy-850 px-3 py-2">
          {entry ? (
            <SetModeStats setId={setId} entry={entry} classByHand={classByHand} />
          ) : (
            <p className="text-sm text-ink">{setId}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              value={setId}
              onChange={(e) => onSet(e.target.value)}
              className="rounded-md border border-navy-700 bg-navy-900 px-2 py-1 text-xs text-ink"
              aria-label={`${label} — choose a different preflop set`}
            >
              {sets.map((s) => (
                <option key={s.id} value={s.id}>
                  {setLabel(s)} ({s.context === 'rfi' ? 'raise range' : 'call range'})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => onSet(null)}
              className="rounded-md bg-navy-800 px-2.5 py-1 text-xs text-ink-dim hover:text-ink"
            >
              Switch back to manual
            </button>
          </div>
        </div>
      ) : (
        <>
          <textarea
            value={text}
            onChange={(e) => onText(e.target.value)}
            rows={3}
            className="mt-1 w-full rounded-md border border-navy-700 bg-navy-850 px-2 py-2 font-mono text-xs text-ink"
            placeholder={placeholder}
            aria-invalid={liveParse !== null && liveParse.errors.length > 0}
          />
          {liveParse && liveParse.errors.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-0.5 text-xs text-red-300" role="alert">
              {liveParse.errors.slice(0, 3).map((err) => (
                <li key={err}>{err}</li>
              ))}
              {liveParse.errors.length > 3 ? (
                <li>…and {liveParse.errors.length - 3} more problem entries</li>
              ) : null}
            </ul>
          ) : liveParse ? (
            <p className="mt-1 text-xs text-ink-faint">
              {liveParse.entries.length} combos parsed
            </p>
          ) : null}
          {sets.length > 0 ? (
            <label className="mt-1 block text-xs text-ink-faint">
              …or load from the preflop library
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) onSet(e.target.value);
                }}
                className="ml-2 rounded-md border border-navy-700 bg-navy-850 px-2 py-1 text-xs text-ink"
                aria-label={`${label} — load from preflop library`}
              >
                <option value="">Choose a set…</option>
                {sets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {setLabel(s)} ({s.context === 'rfi' ? 'raise range' : 'call range'})
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </>
      )}
    </div>
  );
}

const BOARD_SHORTCUTS: { label: string; board: string }[] = [
  { label: 'Monotone river', board: 'As Ks Qs 7d 2c' },
  { label: 'Paired river', board: 'Kh Kd 9s 8s 3c' },
  { label: 'Wet turn', board: 'Ts 9s 8h 7d' },
  { label: 'Paired turn', board: 'Kh Kd 7c 2s' },
  { label: 'Dry flop', board: 'As 7d 2c' },
];

interface QuickSetup {
  id: string;
  title: string;
  blurb: string;
  patch: Partial<WizardForm>;
}

/**
 * One-click spot templates. Set ids are the constructed preflop sets the
 * API can expand into a custom solve (RFI raise ranges and vs-RFI call
 * ranges — the only contexts the uncapped expansion loads).
 *
 * - Single-raised pot is exact: BB's call range vs a BTN open (OOP) and
 *   BTN's raise-first-in range (IP).
 * - 3-bet / 4-bet pots have no dedicated solve-compatible sets: the true
 *   3-bet ranges live in the v1.1 vs_three_bet continuation sets, which
 *   the API only expands through its capped path (not emitted by this
 *   wizard). These cards load the closest solve-compatible constructed
 *   sets — the opener's RFI range and the responder's vs-RFI range —
 *   with the template's pot/stack geometry. See SHIP1-NOTES.md.
 */
const QUICK_SETUPS: QuickSetup[] = [
  {
    id: 'srp-btn-bb',
    title: 'Single-raised pot',
    blurb: 'BTN vs BB · pot 7.5 · stacks 100',
    patch: {
      oopRangeSet: 'constructed-v1-6max-bb-vs-btn',
      ipRangeSet: 'constructed-v1-6max-btn-rfi',
      pot: 7.5,
      stacks: 100,
    },
  },
  {
    id: '3bet-co-btn',
    title: '3-bet pot',
    blurb: 'CO vs BTN · pot 22 · stacks 100',
    patch: {
      oopRangeSet: 'constructed-v1-6max-co-rfi',
      ipRangeSet: 'constructed-v1-6max-btn-vs-co',
      pot: 22,
      stacks: 100,
    },
  },
  {
    id: '4bet-btn-bb',
    title: '4-bet pot',
    blurb: 'BTN vs BB · pot 48 · stacks 100',
    patch: {
      oopRangeSet: 'constructed-v1-6max-bb-vs-btn',
      ipRangeSet: 'constructed-v1-6max-btn-rfi',
      pot: 48,
      stacks: 100,
    },
  },
];

function QuickSetupCards({
  form,
  onApply,
}: {
  form: WizardForm;
  onApply: (patch: Partial<WizardForm>) => void;
}) {
  const isActive = (s: QuickSetup) =>
    form.oopRangeSet === s.patch.oopRangeSet &&
    form.ipRangeSet === s.patch.ipRangeSet &&
    form.pot === s.patch.pot &&
    form.stacks === s.patch.stacks;
  const customActive = form.oopRangeSet === null && form.ipRangeSet === null;
  const cardClass = (active: boolean) =>
    `rounded-lg border p-3 text-left shadow-panel transition-colors ${
      active
        ? 'border-table bg-navy-800 ring-1 ring-table'
        : 'border-navy-700 bg-navy-900 hover:border-navy-600 hover:bg-navy-800'
    }`;
  return (
    <section aria-label="Quick setups">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Quick setup
      </h2>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {QUICK_SETUPS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => onApply(s.patch)}
            aria-pressed={isActive(s)}
            className={cardClass(isActive(s))}
          >
            <span className="block text-sm font-semibold text-ink">{s.title}</span>
            <span className="mt-0.5 block text-xs text-ink-dim">{s.blurb}</span>
            <span className="mt-1 block text-[11px] text-ink-faint">
              Loads constructed preflop sets for both ranges.
            </span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => onApply({ oopRangeSet: null, ipRangeSet: null, pot: 100, stacks: 100 })}
          aria-pressed={customActive}
          className={cardClass(customActive)}
        >
          <span className="block text-sm font-semibold text-ink">Heads-up custom</span>
          <span className="mt-0.5 block text-xs text-ink-dim">Manual ranges · pot 100 · stacks 100</span>
          <span className="mt-1 block text-[11px] text-ink-faint">
            Clears both sides back to manual range entry.
          </span>
        </button>
      </div>
    </section>
  );
}

const RANGE_PRESETS: { label: string; oop: string; ip: string }[] = [
  {
    label: 'Engine sample ranges',
    oop: 'Ts 9s 3c 4c, Jd Td 8h 9h, 3d 4d 5c 6c',
    ip: '8s 6s 3h 4h, Jh Th 8d 9d, 3s 4s 5d 6d:0.5',
  },
  {
    label: 'Nut-heavy vs draws',
    oop: 'As Ah Kd Qc, Js Ts 9s 8s',
    ip: 'Qh Jh Th 9h, 7s 6s 5c 4c',
  },
];

export function SolverPage() {
  const navigate = useNavigate();
  const upsertJob = useStore((s) => s.upsertJob);
  const sessionJobs = useStore((s) => s.sessionJobs);
  const setApiOnline = useStore((s) => s.setApiOnline);
  const loadRawSolve = useStore((s) => s.loadRawSolve);
  const loadSample = useStore((s) => s.loadSample);

  const [form, setForm] = useState<WizardForm>(defaultWizardForm);
  const [preflopIndex, setPreflopIndex] = useState<PreflopIndex | null>(null);
  const [classByHand, setClassByHand] = useState<Map<string, PreflopClass> | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [offline, setOffline] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [boardPickerOpen, setBoardPickerOpen] = useState(false);
  const [boardPick, setBoardPick] = useState<string[]>([]);

  const activeJob = sessionJobs.find((j) => j.id === activeJobId) ?? null;

  // Stack-to-pot ratio, derived live from the two money inputs so the
  // geometry of the spot is visible before solving (the reference setup
  // shows Pot and Effective Stack side by side the same way).
  const spr = form.pot > 0 && form.stacks > 0 ? form.stacks / form.pot : null;

  // Preflop library for the range pickers. Soft-fail: without the index
  // the wizard is manual-only, exactly as before.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const idx = await fetchPreflopIndex();
        if (!cancelled) setPreflopIndex(idx);
      } catch {
        // Manual mode remains available.
      }
      try {
        const table = await fetchPreflopClassTable();
        if (!cancelled) setClassByHand(new Map(table.classes.map((c) => [c.hand, c])));
      } catch {
        // Stats fall back to computing multiplicities from the class keys.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const compatibleSets = useMemo(
    () => (preflopIndex ? preflopIndex.rangesets.filter(isSolveCompatible) : []),
    [preflopIndex],
  );

  // Poll the active job until it finishes.
  useEffect(() => {
    if (!activeJobId) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const job = await fetchJob(activeJobId);
        if (cancelled) return;
        upsertJob(job);
        if (job.status === 'done' || job.status === 'error') {
          setActiveJobId(null);
        }
      } catch {
        if (!cancelled) setActiveJobId(null);
      }
    };
    const handle = setInterval(() => void tick(), 2000);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [activeJobId, upsertJob]);

  const patch = (partial: Partial<WizardForm>) => setForm((f) => ({ ...f, ...partial }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setNotice(null);
    setNeedsLogin(false);
    const built = buildSpot(form);
    if (!built.spot) {
      setErrors(built.errors);
      return;
    }
    setErrors([]);
    try {
      const job = await submitSolve(built.spot);
      setApiOnline(true);
      setOffline(false);
      upsertJob(job);
      setActiveJobId(job.id);
      setNotice(`Solve queued (job ${job.id}). It runs on the engine host — this page updates automatically.`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // The server is reachable but adding solves is admin-only.
        setApiOnline(true);
        setOffline(false);
        setNeedsLogin(true);
      } else if (err instanceof ApiError) {
        setApiOnline(true);
        setErrors([err.message]);
      } else {
        setApiOnline(false);
        setOffline(true);
      }
    }
  };

  const openJobResult = async (job: JobRecord) => {
    setOpening(true);
    try {
      const raw = await fetchJobResult(job.id);
      if (loadRawSolve(raw, `Custom solve · ${job.board}`, 'job', job.id, job.range_expansion)) {
        navigate('/explorer');
      } else {
        setErrors(['The finished solve could not be parsed by the UI.']);
      }
    } catch {
      setErrors(['Could not fetch the finished solve from the job service.']);
    } finally {
      setOpening(false);
    }
  };

  const exploreSample = async () => {
    await loadSample();
    navigate('/explorer');
  };

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-bold text-ink">Solver</h1>
        <p className="text-sm text-ink-dim">
          Define a spot — two ranges, a board, and bet sizes per street — and the engine solves it.
          Finished solves land in your library with their measured accuracy.
        </p>
      </header>

      {offline ? (
        <div className="rounded-lg border border-accent/60 bg-navy-900 p-4" role="alert">
          <h2 className="font-semibold text-ink">Engine offline — showing sample</h2>
          <p className="mt-1 text-sm text-ink-dim">
            The job service isn't reachable from here, so new solves can't be submitted. You can
            still explore the bundled, verified sample solve.
          </p>
          <button
            type="button"
            onClick={() => void exploreSample()}
            className="mt-3 rounded-md bg-table px-3 py-2 text-sm font-semibold text-white hover:bg-table-dark"
          >
            Explore the sample solve
          </button>
        </div>
      ) : null}

      <QuickSetupCards form={form} onApply={patch} />

      <form onSubmit={(e) => void onSubmit(e)} className="flex flex-col gap-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <fieldset className="rounded-lg border border-navy-700 bg-navy-900 p-3">
            <legend className="px-1 text-sm font-semibold text-ink">Board</legend>
            <div className="flex gap-2">
              <input
                type="text"
                value={form.board}
                onChange={(e) => patch({ board: e.target.value })}
                className="w-full rounded-md border border-navy-700 bg-navy-850 px-2 py-2 font-mono text-sm text-ink"
                aria-label="Board cards"
                placeholder="As Ks Qs 7d 2c"
              />
              <button
                type="button"
                onClick={() => {
                  setBoardPick((parseCardList(form.board) ?? []).map((c) => c.label));
                  setBoardPickerOpen(true);
                }}
                className="shrink-0 rounded-md bg-navy-800 px-3 py-2 text-sm font-semibold text-ink-dim hover:text-ink"
              >
                Pick cards
              </button>
            </div>
            {/* Graphical preview of the board as typed (rendering only —
                the text input above stays the source of truth). */}
            {(() => {
              const cards = parseCardList(form.board);
              return cards && cards.length >= 3 && cards.length <= 5 ? (
                <div className="mt-2">
                  <CardRow cards={cards} size="sm" />
                </div>
              ) : null;
            })()}
            {/* Street chips: the street follows the board (3/4/5 cards). */}
            <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Street">
              {(['Flop', 'Turn', 'River'] as const).map((streetName, i) => {
                const cards = parseCardList(form.board);
                const activeStreet = cards
                  ? cards.length === 3
                    ? 'Flop'
                    : cards.length === 4
                      ? 'Turn'
                      : cards.length === 5
                        ? 'River'
                        : null
                  : null;
                const isActive = activeStreet === streetName;
                return (
                  <span
                    key={streetName}
                    className={`rounded-full px-2.5 py-1 text-xs ${
                      isActive
                        ? 'bg-navy-800 font-semibold text-ink ring-1 ring-table'
                        : 'text-ink-faint ring-1 ring-navy-700'
                    }`}
                    aria-current={isActive ? 'true' : undefined}
                    title={`${3 + i} cards`}
                  >
                    {streetName}
                  </span>
                );
              })}
              <span className="text-[11px] text-ink-faint">Street follows the board — 3, 4 or 5 cards.</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {BOARD_SHORTCUTS.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => patch({ board: s.board })}
                  aria-pressed={form.board === s.board}
                  className={`rounded-full px-2 py-1 text-xs ${
                    form.board === s.board
                      ? 'bg-navy-800 font-semibold text-ink ring-1 ring-accent'
                      : 'bg-navy-800 text-ink-dim hover:text-ink'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="text-xs text-ink-dim">
                Pot
                <input
                  type="number"
                  min={1}
                  value={form.pot}
                  onChange={(e) => patch({ pot: Number(e.target.value) })}
                  className="mt-1 w-full rounded-md border border-navy-700 bg-navy-850 px-2 py-1.5 text-sm text-ink"
                />
              </label>
              <label className="text-xs text-ink-dim">
                Effective stacks
                <input
                  type="number"
                  min={1}
                  value={form.stacks}
                  onChange={(e) => patch({ stacks: Number(e.target.value) })}
                  className="mt-1 w-full rounded-md border border-navy-700 bg-navy-850 px-2 py-1.5 text-sm text-ink"
                />
              </label>
            </div>
            <p className="mt-2 text-xs text-ink-dim">
              Stack-to-pot ratio (SPR):{' '}
              <span className="font-mono text-sm font-semibold text-ink">
                {spr === null ? '—' : spr.toFixed(1)}
              </span>{' '}
              <span className="text-ink-faint">(effective stacks ÷ pot)</span>
            </p>
            <fieldset className="mt-3">
              <legend className="text-xs text-ink-dim">Accuracy tier</legend>
              <div className="mt-1 flex flex-col gap-1.5">
                {(Object.keys(TIER_LABEL) as AccuracyTier[]).map((tier) => (
                  <label key={tier} className="flex items-center gap-2 text-sm text-ink-dim">
                    <input
                      type="radio"
                      name="tier"
                      checked={form.tier === tier}
                      onChange={() => patch({ tier, targetPctOverride: null })}
                      className="h-4 w-4 accent-[#2E9E6B]"
                    />
                    {TIER_LABEL[tier]}
                  </label>
                ))}
              </div>
              {/* The contract takes numbers, not tier names: both fields
                  below are emitted verbatim (target_exploitability_pct /
                  max_iterations). Editing the target overrides the preset. */}
              <div className="mt-2 grid grid-cols-2 gap-3">
                <label className="text-xs text-ink-dim">
                  Target Nash distance (% of pot)
                  <input
                    type="number"
                    min={0.01}
                    max={5}
                    step={0.05}
                    value={targetPctFor(form)}
                    onChange={(e) => patch({ targetPctOverride: Number(e.target.value) })}
                    className="mt-1 w-full rounded-md border border-navy-700 bg-navy-850 px-2 py-1.5 text-sm text-ink"
                  />
                </label>
                <label className="text-xs text-ink-dim">
                  Max iterations
                  <input
                    type="number"
                    min={1}
                    step={1000}
                    value={form.maxIterations}
                    onChange={(e) => patch({ maxIterations: Number(e.target.value) })}
                    className="mt-1 w-full rounded-md border border-navy-700 bg-navy-850 px-2 py-1.5 text-sm text-ink"
                  />
                </label>
              </div>
              {form.targetPctOverride !== null ? (
                <p className="mt-1 text-xs text-ink-faint">
                  Custom target — it overrides the tier preset.{' '}
                  <button
                    type="button"
                    onClick={() => patch({ targetPctOverride: null })}
                    className="font-semibold text-table-light underline"
                  >
                    Back to the {form.tier} preset
                  </button>
                </p>
              ) : null}
              <p className="mt-1 text-xs text-ink-faint">
                The solver stops at whichever comes first: the measured Nash distance reaching
                the target, or the iteration cap. Every finished solve reports its measured
                accuracy either way — a solve that misses its target is labelled DRAFT, never
                certified.
              </p>
            </fieldset>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="text-xs text-ink-dim">
                Rake % <span className="rounded bg-navy-800 px-1 text-[10px] font-semibold text-accent">V2</span>
                <input
                  type="number"
                  disabled
                  placeholder="0"
                  className="mt-1 w-full cursor-not-allowed rounded-md border border-navy-700 bg-navy-900 px-2 py-1.5 text-sm text-ink-faint"
                />
              </label>
              <label className="text-xs text-ink-dim">
                Rake cap <span className="rounded bg-navy-800 px-1 text-[10px] font-semibold text-accent">V2</span>
                <input
                  type="number"
                  disabled
                  placeholder="0"
                  className="mt-1 w-full cursor-not-allowed rounded-md border border-navy-700 bg-navy-900 px-2 py-1.5 text-sm text-ink-faint"
                />
              </label>
            </div>
            <p className="mt-1 text-xs text-ink-faint">
              All solves currently run with no rake. Rake-aware solves arrive in V2 (with the
              low-stakes library configs).
            </p>
          </fieldset>

          <fieldset className="rounded-lg border border-navy-700 bg-navy-900 p-3">
            <legend className="px-1 text-sm font-semibold text-ink">Ranges</legend>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {RANGE_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() =>
                    patch({ oopRange: p.oop, ipRange: p.ip, oopRangeSet: null, ipRangeSet: null })
                  }
                  className="rounded-full bg-navy-800 px-2 py-1 text-xs text-ink-dim hover:text-ink"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <RangeField
              label="OOP range (out of position)"
              placeholder="Ts 9s 3c 4c, Jd Td 8h 9h:0.5, ..."
              text={form.oopRange}
              setId={form.oopRangeSet}
              sets={compatibleSets}
              classByHand={classByHand}
              onText={(oopRange) => patch({ oopRange })}
              onSet={(oopRangeSet) => patch({ oopRangeSet })}
            />
            <RangeField
              label="IP range (in position)"
              placeholder="8s 6s 3h 4h, Jh Th 8d 9d, ..."
              text={form.ipRange}
              setId={form.ipRangeSet}
              sets={compatibleSets}
              classByHand={classByHand}
              onText={(ipRange) => patch({ ipRange })}
              onSet={(ipRangeSet) => patch({ ipRangeSet })}
            />
            <p className="mt-1 text-xs text-ink-faint">
              Manual ranges: one combo per entry, comma or newline separated; add{' '}
              <span className="font-mono">:weight</span> to weight a combo (default 1), or paste
              PPT format — <span className="font-mono">AsKsQsTh@100, AsKsQsJh@52</span> — where @
              is a weight percent. Bad entries are flagged inline under the field, never silently
              dropped. Library sets are constructed preflop ranges — RFI sets load their raise
              range, vs-RFI sets load their call range.
            </p>
          </fieldset>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Bet sizes per street
          </span>
          <button
            type="button"
            onClick={() => patch({ turn: { ...form.flop }, river: { ...form.flop } })}
            className="rounded-md bg-navy-800 px-2.5 py-1 text-xs text-ink-dim hover:text-ink"
          >
            Copy flop sizes to turn &amp; river
          </button>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <StreetEditor title="Flop sizes" value={form.flop} onChange={(flop) => patch({ flop })} />
          <StreetEditor title="Turn sizes" value={form.turn} onChange={(turn) => patch({ turn })} />
          <StreetEditor title="River sizes" value={form.river} onChange={(river) => patch({ river })} />
        </div>
        <p className="text-xs text-ink-faint">
          Sizes are defined per street. The engine solves river spots (5-card board), turn spots
          (4-card board, turn + river sizes), and flop spots (3-card board, flop + turn + river
          sizes). Flop solves are exact unless a spot requests bucketing, and wide flop ranges
          can take a long time — they run as background jobs and land in the library when done.
        </p>

        {/* Node locks: the engine + API accept them today (spot JSON
            "locks"), but the visual editor is issue #9 — the honest
            maximum here is a disabled affordance that says exactly that,
            never a control that silently drops the user's intent. */}
        <fieldset disabled className="rounded-lg border border-navy-700 bg-navy-900 p-3">
          <legend className="px-1 text-sm font-semibold text-ink">Node locks</legend>
          <label className="flex items-center gap-2 text-sm text-ink-faint">
            <input type="checkbox" disabled className="h-4 w-4" />
            Attach node locks to this solve
          </label>
          <p className="mt-1 text-xs text-ink-faint">
            The engine and API already accept locks — fix one player&apos;s action frequencies
            at a decision node and re-solve the rest of the tree around them; locked results are
            badged LOCKED, never GTO. The visual editor (pick a node in the Explorer and set its
            frequencies) is issue #9 and is not built yet, so locks can&apos;t be attached from
            this form today — for now they can only be supplied in the spot JSON sent to the
            API.
          </p>
        </fieldset>

        {errors.length > 0 ? (
          <div className="rounded-lg border border-red-900 bg-navy-900 p-3" role="alert">
            <ul className="list-inside list-disc text-sm text-red-300">
              {errors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {notice ? <p className="text-sm text-table-light">{notice}</p> : null}
        {needsLogin ? (
          <div className="rounded-lg border border-accent/60 bg-navy-900 p-3 text-sm" role="alert">
            <span className="font-semibold text-ink">Adding solves is admin-only.</span>{' '}
            <span className="text-ink-dim">
              Log in with the admin password and submit again — your spot stays filled in.
            </span>{' '}
            <Link
              to="/login"
              state={{ from: '/solver' }}
              className="font-semibold text-table-light underline"
            >
              Log in to add solves
            </Link>
          </div>
        ) : null}

        <div>
          <button
            type="submit"
            className="rounded-md bg-table px-4 py-2.5 font-semibold text-white hover:bg-table-dark"
          >
            Solve this spot
          </button>
        </div>
      </form>

      {sessionJobs.length > 0 ? (
        <section aria-label="Your solve jobs" className="rounded-lg border border-navy-700 bg-navy-900 p-3">
          <h2 className="mb-2 text-sm font-semibold text-ink">Jobs this session</h2>
          <ul className="flex flex-col gap-2">
            {sessionJobs.map((job) => (
              <li
                key={job.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-navy-850 px-3 py-2 text-sm"
              >
                <span className="font-mono text-ink">{job.board}</span>
                <span className="capitalize text-ink-dim">{job.kind}</span>
                <span
                  className={
                    job.status === 'done'
                      ? 'text-table-light'
                      : job.status === 'error'
                        ? 'text-red-300'
                        : 'text-accent'
                  }
                >
                  {job.status}
                  {job.id === activeJobId ? '…' : ''}
                </span>
                {job.oop_range_set ? (
                  <span className="text-xs text-ink-faint">OOP set: {job.oop_range_set}</span>
                ) : null}
                {job.ip_range_set ? (
                  <span className="text-xs text-ink-faint">IP set: {job.ip_range_set}</span>
                ) : null}
                {job.status === 'done' && job.nash_distance_pct !== null ? (
                  <span className="font-mono text-xs text-ink-dim">
                    Nash {job.nash_distance_pct.toFixed(3)}% pot
                  </span>
                ) : null}
                {job.status === 'error' && job.error ? (
                  <span className="text-xs text-red-300">{job.error}</span>
                ) : null}
                {job.status === 'done' ? (
                  <button
                    type="button"
                    disabled={opening}
                    onClick={() => void openJobResult(job)}
                    className="ml-auto rounded-md bg-table px-2.5 py-1 text-xs font-semibold text-white hover:bg-table-dark disabled:opacity-50"
                  >
                    Open in Explorer
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {boardPickerOpen ? (
        <CardPicker
          title="Pick the board"
          caption="Choose 3 cards (flop), 4 (turn) or 5 (river). Click a chosen card again to remove it."
          selected={boardPick}
          onPick={(label) =>
            setBoardPick((prev) =>
              prev.includes(label)
                ? prev.filter((c) => c !== label)
                : prev.length < 5
                  ? [...prev, label]
                  : prev,
            )
          }
          onClear={() => setBoardPick([])}
          onRandom={() => {
            const deck: string[] = [];
            for (const suit of ['s', 'h', 'd', 'c'] as const) {
              for (const rank of RANKS_DESC) deck.push(`${rank}${suit}`);
            }
            const shuffled = [...deck].sort(() => Math.random() - 0.5);
            setBoardPick(shuffled.slice(0, 5));
          }}
          applyLabel={`Use this board (${boardPick.length} cards)`}
          applyDisabled={boardPick.length < 3 || boardPick.length > 5}
          onApply={() => {
            patch({ board: boardPick.join(' ') });
            setBoardPickerOpen(false);
          }}
          onClose={() => setBoardPickerOpen(false)}
        />
      ) : null}
    </div>
  );
}
