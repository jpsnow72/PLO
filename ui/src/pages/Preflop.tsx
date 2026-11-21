import { Fragment, useEffect, useMemo, useState } from 'react';
import { ApproximationBadge } from '../components/AccuracyBadge';
import { CardRow } from '../components/CardChip';
import { FrequencyBar, pctText, SplitBar } from '../components/FrequencyBar';
import { ApiError, fetchPreflopClassTable, fetchPreflopIndex, fetchPreflopSet } from '../lib/api';
import { parseCombo } from '../lib/cards';
import {
  actionTotals,
  classCombos,
  combosInAction,
  DEFAULT_STACK_BB,
  featureTags,
  frequencyBreakdown,
  isSolveCompatible,
  MATRIX_RANKS,
  matrixCells,
  matrixClasses,
  matrixFilteredTotal,
  multiplicityOf,
  pairRankSummary,
  RAKE_LABEL,
  RAKE_VARIANTS,
  rakeOf,
  rankLabel,
  resolveStack,
  selectGroupSets,
  setLabel,
  setTotalCombos,
  solveActionForContext,
  sortPositions,
  stackOf,
  stacksIn,
  suitednessSummary,
  SUITEDNESS_FILTERS,
  threeBettorOf,
  type MatrixCell,
  type PreflopClass,
  type PreflopIndex,
  type PreflopSetDoc,
  type PreflopSetIndexEntry,
  type RakeVariant,
  type SetContext,
  type SuitednessFilter,
  type TableSize,
} from '../lib/preflop';
import { useStore } from '../store/useStore';

// Preflop Ranges screen. Every number on this page comes from the API:
// the set index, the selected set document (16,432 classes with per-action
// frequencies) and the class table (multiplicities, equities, features).
// The sets are CONSTRUCTED ranges — the amber CONSTRUCTED badge and the
// provenance block are always shown; the green certified-GTO badge is
// never used here.

type ContextGroup = 'first-in' | 'vs-rfi' | 'vs-3bet';

const GROUP_CONTEXTS: Record<ContextGroup, SetContext[]> = {
  // SB first-in sets use the sb_play context; they are first-in decisions.
  'first-in': ['rfi', 'sb_play'],
  'vs-rfi': ['vs_rfi'],
  // The v1.1 continuation sets: the opener faces a 3-bet and continues.
  'vs-3bet': ['vs_three_bet'],
};

const GROUP_LABEL: Record<ContextGroup, string> = {
  'first-in': 'RFI / first-in',
  'vs-rfi': 'vs RFI',
  'vs-3bet': 'vs 3-bet',
};

const ACTION_COLOR: Record<string, string> = {
  raise: '#f5a623',
  three_bet: '#d96c4f',
  four_bet: '#9d5fd0',
  call: '#2aa198',
  fold: '#8a4b57',
};

const ACTION_LABEL: Record<string, string> = {
  raise: 'Raise',
  three_bet: '3-bet',
  four_bet: '4-bet',
  call: 'Call',
  fold: 'Fold',
};

/**
 * Strategy-column header colours (issue #40): the theme's own action
 * tokens from index.css — fold slate (--action-fold), call green
 * (--accent-green, the card-table green), the raise family muted red
 * (--action-raise). Header tints only; the bars elsewhere on the page
 * keep ACTION_COLOR. An action the map does not name (a set's own
 * recorded key, e.g. an SB-play variant) falls back to the fold slate.
 */
const COLUMN_COLOR: Record<string, string> = {
  fold: 'var(--action-fold)',
  call: 'var(--accent-green)',
  raise: 'var(--action-raise)',
  three_bet: 'var(--action-raise)',
  four_bet: 'var(--action-raise)',
};
const COLUMN_COLOR_FALLBACK = 'var(--action-fold)';

/** Display order for a set's action menu. */
const ACTION_ORDER = ['raise', 'three_bet', 'four_bet', 'call', 'fold'];

/** Classes listed per action column on the Strategy tab. */
const COLUMN_ROW_CAP = 200;
const MATRIX_ROW_CAP = 100;
/** Classes listed per action on the Ranges tab (Strategy holds the columns). */
const RANGE_CLASS_CAP = 50;

type RangeView = 'strategy' | 'matrix' | 'ranges' | 'breakdown' | 'compare';

/** A totals map's actions in display order (menu order, then any extras A–Z). */
function orderedActions(totalsMap: Record<string, number>): string[] {
  return ACTION_ORDER.filter((a) => a in totalsMap).concat(
    Object.keys(totalsMap)
      .filter((a) => !ACTION_ORDER.includes(a))
      .sort(),
  );
}

function hexToRgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  if (Number.isNaN(n)) return hex;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

interface ClassRow {
  key: string;
  actions: Record<string, number>;
  cls: PreflopClass | null;
  multiplicity: number;
}

function Pill({
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
 * Per-class detail: the full picture for one hand class in the loaded
 * set — graphical cards, the complete action split (not just the
 * currently displayed action), its concrete combos, and everything the
 * class table carries (equities, construction score and its components,
 * feature tags). Without the class table only the split and combos can
 * be shown, and the panel says so.
 */
function ClassDetail({
  classKey,
  actions,
  cls,
  multiplicity,
  onClose,
}: {
  classKey: string;
  actions: Record<string, number>;
  cls: PreflopClass | null;
  multiplicity: number;
  onClose: () => void;
}) {
  const cards = parseCombo(classKey);
  const combos = classCombos(classKey);
  const split = ACTION_ORDER.filter((a) => a in actions).concat(
    Object.keys(actions).filter((a) => !ACTION_ORDER.includes(a)),
  );
  const components = cls
    ? [
        { label: 'Pair', value: cls.features.pair_component },
        { label: 'Suitedness', value: cls.features.suitedness_component },
        { label: 'Connectedness', value: cls.features.connectedness_component },
        { label: 'High card', value: cls.features.high_card_component },
      ]
    : [];
  return (
    <div className="rounded-lg border border-navy-700 bg-navy-850 p-3">
      <div className="flex flex-wrap items-center gap-3">
        {cards ? <CardRow cards={cards} size="sm" /> : null}
        <span className="font-mono text-sm text-ink">{classKey}</span>
        <span className="text-xs text-ink-dim">
          {multiplicity} concrete combo{multiplicity === 1 ? '' : 's'}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-full bg-navy-900 px-2.5 py-1 text-xs text-ink-dim hover:text-ink"
        >
          Clear selection
        </button>
      </div>

      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Action split in this set
          </h4>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {split.map((a) => (
              <div key={a} className="flex items-center gap-2 text-xs">
                <span className="w-12 text-ink-dim">{ACTION_LABEL[a] ?? a}</span>
                <div className="flex-1">
                  <FrequencyBar
                    fraction={actions[a] ?? 0}
                    color={ACTION_COLOR[a] ?? '#7a8aa0'}
                    height="h-2"
                  />
                </div>
                <span className="w-14 text-right font-mono text-ink-dim">
                  {pctText(actions[a] ?? 0)}
                </span>
              </div>
            ))}
          </div>
          <h4 className="mt-3 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Concrete combos
          </h4>
          <p className="mt-1.5 flex flex-wrap gap-1">
            {combos.map((c) => (
              <span
                key={c}
                className="rounded bg-navy-900 px-1.5 py-0.5 font-mono text-[11px] text-ink-dim"
              >
                {c}
              </span>
            ))}
          </p>
        </div>

        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Class features
          </h4>
          {cls ? (
            <>
              <p className="mt-1.5 text-xs text-ink-dim">{featureTags(cls).join(' · ')}</p>
              <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
                <div>
                  <dt className="text-[11px] text-ink-faint">Equity vs random</dt>
                  <dd className="font-mono text-sm text-ink">{pctText(cls.equity_vs_random)}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-ink-faint">Equity vs reference</dt>
                  <dd className="font-mono text-sm text-ink">{pctText(cls.equity_vs_reference)}</dd>
                </div>
                <div>
                  <dt className="text-[11px] text-ink-faint">Construction score</dt>
                  <dd className="font-mono text-sm text-ink">{cls.score.toFixed(3)}</dd>
                </div>
              </dl>
              <div className="mt-2 flex flex-col gap-1.5">
                {components.map((c) => (
                  <div key={c.label} className="flex items-center gap-2 text-xs">
                    <span className="w-28 text-ink-dim">{c.label}</span>
                    <div className="flex-1">
                      <FrequencyBar fraction={c.value} color="#7a8aa0" height="h-2" />
                    </div>
                    <span className="w-10 text-right font-mono text-ink-dim">
                      {c.value.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
                Equities and features are the class table's recorded values for this class; the
                score and its components are the construction model's inputs, not solver output.
              </p>
            </>
          ) : (
            <p className="mt-1.5 text-xs text-ink-dim">
              The class table is not loaded, so equities and features are unavailable for this
              class. The action split and combos above come from the set document alone.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function PreflopPage() {
  const setApiOnline = useStore((s) => s.setApiOnline);

  const [index, setIndex] = useState<PreflopIndex | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [classByHand, setClassByHand] = useState<Map<string, PreflopClass> | null>(null);
  const [classTableMissing, setClassTableMissing] = useState(false);

  const [tableSize, setTableSize] = useState<TableSize>('6max');
  const [rake, setRake] = useState<RakeVariant>('raked');
  const [stack, setStack] = useState<number>(DEFAULT_STACK_BB);
  const [group, setGroup] = useState<ContextGroup>('first-in');
  const [position, setPosition] = useState<string | null>(null);
  const [opener, setOpener] = useState<string | null>(null);
  const [bettor, setBettor] = useState<string | null>(null);
  const [selClass, setSelClass] = useState<string | null>(null);

  // Scenario-family data: per-position totals for every set in the
  // current scenario family (one document per position), fetched when
  // the family changes. It feeds both the position strip (each card's
  // headline split) and the Compare tab.
  const [familyData, setFamilyData] = useState<Map<
    string,
    { totals: Record<string, number>; totalCombos: number }
  > | null>(null);
  const [familyLoading, setFamilyLoading] = useState(false);

  const [setDoc, setSetDoc] = useState<PreflopSetDoc | null>(null);
  const [setLoading, setSetLoading] = useState(false);
  const [setError, setSetError] = useState<string | null>(null);

  const [action, setAction] = useState<string>('raise');
  const [filter, setFilter] = useState('');

  const [view, setView] = useState<RangeView>('strategy');
  const [suitFilter, setSuitFilter] = useState<SuitednessFilter>('any');
  const [selCell, setSelCell] = useState<{ hi: number; lo: number }>({ hi: 14, lo: 14 });

  // Load the index and the class table independently: the class table is
  // an enhancement (equities/features); the page works without it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const idx = await fetchPreflopIndex();
        if (cancelled) return;
        setIndex(idx);
        setApiOnline(true);
      } catch (err) {
        if (cancelled) return;
        setIndexError(
          err instanceof ApiError && err.status !== 0
            ? err.message
            : 'The job service is unreachable, so the preflop library cannot be loaded.',
        );
        setApiOnline(false);
      }
      try {
        const table = await fetchPreflopClassTable();
        if (cancelled) return;
        setClassByHand(new Map(table.classes.map((c) => [c.hand, c])));
      } catch {
        if (!cancelled) setClassTableMissing(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setApiOnline]);

  // Stack options exist per (table, rake): 200bb sets exist only for
  // 6-max no-rake today, so the pill row offers exactly the depths the
  // current table+rake selection actually has sets at.
  const stackBaseSets = useMemo(
    () =>
      index
        ? index.rangesets.filter((e) => e.table_size === tableSize && rakeOf(e) === rake)
        : [],
    [index, tableSize, rake],
  );
  const stackOptions = useMemo(() => stacksIn(stackBaseSets), [stackBaseSets]);

  // Keep the stack selection valid for the current table+rake: when
  // the chosen stack has no sets there, fall back to an available
  // stack rather than showing an empty page — the keep-valid rule
  // every other selector on this page follows.
  useEffect(() => {
    const resolved = resolveStack(stackBaseSets, stack);
    if (resolved !== null && resolved !== stack) setStack(resolved);
  }, [stackBaseSets, stack]);

  const groupSets = useMemo<PreflopSetIndexEntry[]>(
    () =>
      index
        ? selectGroupSets(index, {
            tableSize,
            rake,
            stack,
            contexts: GROUP_CONTEXTS[group],
          })
        : [],
    [index, tableSize, rake, stack, group],
  );

  const positions = useMemo(
    () => sortPositions([...new Set(groupSets.map((e) => e.position))], tableSize),
    [groupSets, tableSize],
  );

  // Keep the selected position valid for the current controls.
  useEffect(() => {
    if (positions.length === 0) {
      if (position !== null) setPosition(null);
    } else if (position === null || !positions.includes(position)) {
      setPosition(positions[0]);
    }
  }, [positions, position]);

  const positionSets = useMemo(
    () => groupSets.filter((e) => e.position === position),
    [groupSets, position],
  );

  const openers = useMemo(() => {
    if (group !== 'vs-rfi') return [];
    const found = new Set<string>();
    for (const e of positionSets) {
      // Index entries carry no context_detail; the opener is encoded in
      // the id slug ("...-sb-vs-btn") — parse the trailing segment.
      const m = /-vs-([a-z0-9+]+)$/.exec(e.id);
      if (m) found.add(m[1].toUpperCase().replace('UTGPLUS', 'UTG+'));
    }
    return sortPositions([...found], tableSize);
  }, [positionSets, group, tableSize]);

  useEffect(() => {
    if (group !== 'vs-rfi') {
      if (opener !== null) setOpener(null);
    } else if (openers.length === 0) {
      if (opener !== null) setOpener(null);
    } else if (opener === null || !openers.includes(opener)) {
      setOpener(openers[0]);
    }
  }, [group, openers, opener]);

  const bettors = useMemo(() => {
    if (group !== 'vs-3bet') return [];
    const found = new Set<string>();
    for (const e of positionSets) {
      const b = threeBettorOf(e);
      if (b) found.add(b);
    }
    return sortPositions([...found], tableSize);
  }, [positionSets, group, tableSize]);

  useEffect(() => {
    if (group !== 'vs-3bet') {
      if (bettor !== null) setBettor(null);
    } else if (bettors.length === 0) {
      if (bettor !== null) setBettor(null);
    } else if (bettor === null || !bettors.includes(bettor)) {
      setBettor(bettors[0]);
    }
  }, [group, bettors, bettor]);

  const selectedEntry = useMemo<PreflopSetIndexEntry | null>(() => {
    if (positionSets.length === 0) return null;
    if (group === 'vs-rfi') {
      if (!opener) return null;
      const slug = opener.toLowerCase().replace('utg+', 'utgplus');
      return positionSets.find((e) => e.id.endsWith(`-vs-${slug}`)) ?? null;
    }
    if (group === 'vs-3bet') {
      if (!bettor) return null;
      const slug = bettor.toLowerCase().replace('utg+', 'utgplus');
      return positionSets.find((e) => e.id.endsWith(`-vs-${slug}-3bet`)) ?? null;
    }
    return positionSets[0] ?? null;
  }, [positionSets, group, opener, bettor]);

  // Fetch the selected set document.
  useEffect(() => {
    if (!selectedEntry) {
      setSetDoc(null);
      return;
    }
    let cancelled = false;
    setSetLoading(true);
    setSetError(null);
    void (async () => {
      try {
        const doc = await fetchPreflopSet(selectedEntry.id);
        if (cancelled) return;
        setSetDoc(doc);
        setSelClass(null);
        // Default the displayed action to the set's headline action.
        const headline =
          doc.context === 'vs_rfi' || doc.context === 'vs_three_bet'
            ? 'call'
            : doc.context === 'three_bet'
              ? 'call'
              : 'raise';
        setAction(headline);
      } catch (err) {
        if (!cancelled) {
          setSetDoc(null);
          setSetError(err instanceof ApiError ? err.message : 'Could not load that range set.');
        }
      } finally {
        if (!cancelled) setSetLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedEntry]);

  const totals = useMemo(
    () => (setDoc ? actionTotals(setDoc, classByHand) : {}),
    [setDoc, classByHand],
  );
  const totalCombos = useMemo(
    () => (setDoc ? setTotalCombos(setDoc, classByHand) : 0),
    [setDoc, classByHand],
  );
  const headlineAction = setDoc
    ? setDoc.context === 'vs_rfi' || setDoc.context === 'vs_three_bet'
      ? 'call'
      : setDoc.context === 'three_bet'
        ? 'call'
        : 'raise'
    : 'raise';
  const combosInHeadline = useMemo(
    () => (setDoc ? combosInAction(setDoc, headlineAction, classByHand) : 0),
    [setDoc, headlineAction, classByHand],
  );

  const summary = useMemo(() => {
    if (!setDoc || !classByHand) return [];
    return pairRankSummary(setDoc, action, classByHand, totalCombos);
  }, [setDoc, action, classByHand, totalCombos]);

  const breakdown = useMemo(
    () => (setDoc ? frequencyBreakdown(setDoc, action, classByHand) : []),
    [setDoc, action, classByHand],
  );

  const suitSummary = useMemo(() => {
    if (!setDoc || !classByHand) return [];
    return suitednessSummary(setDoc, action, classByHand, totalCombos);
  }, [setDoc, action, classByHand, totalCombos]);

  const selClassRow = useMemo<ClassRow | null>(() => {
    if (!setDoc || !selClass) return null;
    const actions = setDoc.hands[selClass];
    if (!actions) return null;
    return {
      key: selClass,
      actions,
      cls: classByHand?.get(selClass) ?? null,
      multiplicity: multiplicityOf(selClass, classByHand),
    };
  }, [setDoc, selClass, classByHand]);

  // ----- Scenario family -----
  // The family is every set in the current scenario: every position
  // in the group (for vs-RFI, every defender against the chosen opener;
  // for vs-3bet, every opener continuing against the chosen 3-bettor).
  // The position strip and the Compare tab both read this family.
  const compareEntries = useMemo<PreflopSetIndexEntry[]>(() => {
    if (group === 'first-in') return groupSets;
    if (group === 'vs-rfi') {
      if (!opener) return [];
      const slug = opener.toLowerCase().replace('utg+', 'utgplus');
      return groupSets.filter((e) => e.id.endsWith(`-vs-${slug}`));
    }
    if (!bettor) return [];
    const slug = bettor.toLowerCase().replace('utg+', 'utgplus');
    return groupSets.filter((e) => e.id.endsWith(`-vs-${slug}-3bet`));
  }, [groupSets, group, opener, bettor]);

  useEffect(() => {
    if (compareEntries.length === 0) {
      setFamilyData(null);
      setFamilyLoading(false);
      return;
    }
    let cancelled = false;
    setFamilyLoading(true);
    void (async () => {
      const out = new Map<string, { totals: Record<string, number>; totalCombos: number }>();
      await Promise.all(
        compareEntries.map(async (e) => {
          try {
            const doc = await fetchPreflopSet(e.id);
            out.set(e.id, {
              totals: actionTotals(doc, classByHand),
              totalCombos: setTotalCombos(doc, classByHand),
            });
          } catch {
            // A position whose document fails to load simply has no
            // column; the rest of the comparison stays honest.
          }
        }),
      );
      if (cancelled) return;
      setFamilyData(out);
      setFamilyLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [compareEntries, classByHand]);

  const compareActions = useMemo(() => {
    if (!familyData) return [];
    const present = new Set<string>();
    for (const v of familyData.values()) {
      for (const a of Object.keys(v.totals)) present.add(a);
    }
    return ACTION_ORDER.filter((a) => present.has(a)).concat(
      [...present].filter((a) => !ACTION_ORDER.includes(a)).sort(),
    );
  }, [familyData]);

  const compareCombined = useMemo(() => {
    if (!familyData || familyData.size === 0) return null;
    let denom = 0;
    const weighted: Record<string, number> = {};
    for (const v of familyData.values()) {
      denom += v.totalCombos;
      for (const [a, frac] of Object.entries(v.totals)) {
        weighted[a] = (weighted[a] ?? 0) + frac * v.totalCombos;
      }
    }
    if (denom === 0) return null;
    const totals: Record<string, number> = {};
    for (const [a, w] of Object.entries(weighted)) totals[a] = w / denom;
    return totals;
  }, [familyData]);

  // ----- Position strip -----
  // One card per position in the family, in seat order. The entry kept
  // per position is the one the selection logic below would open for
  // that position (first-in keeps the first set listed for the seat;
  // the vs-* families are already filtered to the chosen other actor).
  const stripEntries = useMemo<PreflopSetIndexEntry[]>(() => {
    const byPosition = new Map<string, PreflopSetIndexEntry>();
    for (const e of compareEntries) {
      if (!byPosition.has(e.position)) byPosition.set(e.position, e);
    }
    return sortPositions([...byPosition.keys()], tableSize).map(
      (p) => byPosition.get(p) as PreflopSetIndexEntry,
    );
  }, [compareEntries, tableSize]);

  // The family's headline action: first-in sets lead with Raise, the
  // vs-* families with Call (the same rule the set header applies).
  const familyHeadline = group === 'first-in' ? 'raise' : 'call';

  // ----- Strategy columns (issue #40) -----
  // One column per action the set itself records, in the reference's
  // shape: a header carrying the action's combo-weighted total and its
  // combo-weighted combo count, then every class that takes the action
  // at some frequency, densest first (frequency, then combo
  // multiplicity, then key). A mixed class appears in each column it
  // participates in, at that action's frequency — the set document's
  // per-class action map is the data model, nothing is re-derived.
  // The column list comes from the set's own totals (orderedActions),
  // never hardcoded per context: RFI sets yield Fold/Raise, vs-RFI
  // sets Fold/Call/3-bet, continuations Fold/Call/4-bet, SB-play sets
  // whatever actions they record. The header's combo count is computed
  // over the unfiltered classes so it always matches the header %.
  const strategyColumns = useMemo(() => {
    if (!setDoc) return [];
    const needle = filter.trim().toLowerCase().replace(/\s+/g, ' ');
    return orderedActions(totals).map((a) => {
      let weightedCombos = 0;
      const colRows: { key: string; freq: number; multiplicity: number }[] = [];
      for (const [key, actions] of Object.entries(setDoc.hands)) {
        const freq = actions[a] ?? 0;
        if (freq <= 0) continue;
        const multiplicity = multiplicityOf(key, classByHand);
        weightedCombos += multiplicity * freq;
        if (needle && !key.toLowerCase().replace(/\s+/g, ' ').includes(needle)) continue;
        colRows.push({ key, freq, multiplicity });
      }
      colRows.sort(
        (x, y) =>
          y.freq - x.freq || y.multiplicity - x.multiplicity || x.key.localeCompare(y.key),
      );
      return {
        action: a,
        total: totals[a] ?? 0,
        weightedCombos,
        classCount: colRows.length,
        rows: colRows.slice(0, COLUMN_ROW_CAP),
      };
    });
  }, [setDoc, totals, classByHand, filter]);

  // ----- Matrix drill-down -----
  // Suitedness filtering reads the class table's exact features, so the
  // chips are disabled (and the filter ignored) when the table is not
  // loaded — the grid itself only needs ranks + multiplicities and
  // always works from the set document.
  const suitFiltersEnabled = classByHand !== null;
  const suitFeature = useMemo(() => {
    if (!suitFiltersEnabled) return null;
    return SUITEDNESS_FILTERS.find((f) => f.id === suitFilter)?.feature ?? null;
  }, [suitFiltersEnabled, suitFilter]);
  const suitFilterLabel =
    SUITEDNESS_FILTERS.find((f) => f.id === suitFilter)?.label ?? 'Any suits';

  const cells = useMemo<Map<string, MatrixCell>>(
    () => (setDoc ? matrixCells(setDoc, action, classByHand, suitFeature) : new Map()),
    [setDoc, action, classByHand, suitFeature],
  );
  const matrixTotal = useMemo(
    () => (setDoc ? matrixFilteredTotal(setDoc, classByHand, suitFeature) : 0),
    [setDoc, classByHand, suitFeature],
  );
  const selCellData = cells.get(`${selCell.hi}-${selCell.lo}`);
  const drillRows = useMemo(
    () =>
      setDoc
        ? matrixClasses(setDoc, action, classByHand, selCell.hi, selCell.lo, suitFeature)
        : [],
    [setDoc, action, classByHand, selCell, suitFeature],
  );
  const selPairLabel =
    selCell.hi === selCell.lo
      ? `${rankLabel(selCell.hi)}${rankLabel(selCell.hi)}`
      : `${rankLabel(selCell.hi)}${rankLabel(selCell.lo)}`;

  const actionsInSet = useMemo(() => {
    if (!setDoc) return [];
    const present = new Set<string>();
    for (const actions of Object.values(setDoc.hands)) {
      for (const a of Object.keys(actions)) present.add(a);
    }
    return ACTION_ORDER.filter((a) => present.has(a));
  }, [setDoc]);

  // ----- Ranges tab -----
  // The set as ranges: for each action, the classes that take it,
  // strongest frequency first, capped per action (the Strategy tab's
  // class table holds the full list). Every figure is read from the
  // set document — a constructed set carries no other range data.
  const actionRanges = useMemo(() => {
    if (!setDoc) return [];
    return actionsInSet.map((a) => {
      const inRange = Object.entries(setDoc.hands)
        .map(([key, actions]) => ({
          key,
          freq: actions[a] ?? 0,
          multiplicity: multiplicityOf(key, classByHand),
        }))
        .filter((r) => r.freq > 0)
        .sort((x, y) => y.freq - x.freq || x.key.localeCompare(y.key));
      return {
        action: a,
        total: totals[a] ?? 0,
        combosWithFreq: combosInAction(setDoc, a, classByHand),
        classCount: inRange.length,
        rows: inRange.slice(0, RANGE_CLASS_CAP),
      };
    });
  }, [setDoc, actionsInSet, classByHand, totals]);

  const provenance = setDoc?.provenance;
  const solveCompat = selectedEntry ? isSolveCompatible(selectedEntry) : false;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-bold text-ink">Preflop Ranges</h1>
        <p className="text-sm text-ink-dim">
          Starting ranges for 6-max, 8-max and 9-max. These are <strong>constructed</strong> ranges —
          built from exact card features and seeded Monte Carlo equities, cross-checked against
          published solver totals. They are not solver output.
        </p>
      </header>

      {indexError ? (
        <div className="rounded-lg border border-accent/60 bg-navy-900 p-4" role="alert">
          <h2 className="font-semibold text-ink">Preflop library unavailable</h2>
          <p className="mt-1 text-sm text-ink-dim">{indexError}</p>
        </div>
      ) : index === null ? (
        <p className="text-sm text-ink-dim">Loading the preflop library…</p>
      ) : (
        <>
          <section
            aria-label="Range selection"
            className="flex flex-col gap-3 rounded-lg border border-navy-700 bg-navy-900 p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-24 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Table
              </span>
              {(['6max', '8max', '9max'] as TableSize[]).map((t) => (
                <Pill key={t} active={tableSize === t} onClick={() => setTableSize(t)}>
                  {t === '6max' ? '6-max' : t === '8max' ? '8-max' : '9-max'}
                </Pill>
              ))}
              <span className="ml-auto text-xs text-ink-faint">
                {index.rangesets.filter((e) => e.table_size === tableSize).length} sets at this
                table size
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-24 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Stack
              </span>
              {stackOptions.map((s) => (
                <Pill key={s} active={stack === s} onClick={() => setStack(s)}>
                  {`${s}bb`}
                </Pill>
              ))}
              <span className="text-xs text-ink-faint">
                {stackOptions.length > 1
                  ? 'Deep-stack (200bb) sets exist at this table and rake variant; switching stack switches the whole scenario.'
                  : 'Every set at this table and rake variant is 100bb — no other stack exists to select.'}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-24 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Rake
              </span>
              {RAKE_VARIANTS.map((r) => (
                <Pill key={r} active={rake === r} onClick={() => setRake(r)}>
                  {RAKE_LABEL[r]}
                </Pill>
              ))}
              <span className="text-xs text-ink-faint">
                {rake === 'no-rake'
                  ? 'Targets anchored on no-rake (cEV) totals (8-max: derived from the 6-max anchors by seat mapping)'
                  : 'Targets anchored on raked-game totals (8-max: derived from the 6-max targets by seat mapping)'}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-24 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Context
              </span>
              {(Object.keys(GROUP_LABEL) as ContextGroup[]).map((g) => (
                <Pill key={g} active={group === g} onClick={() => setGroup(g)}>
                  {GROUP_LABEL[g]}
                </Pill>
              ))}
            </div>
            {group === 'vs-rfi' ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-24 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                  Opener
                </span>
                {openers.map((o) => (
                  <Pill key={o} active={opener === o} onClick={() => setOpener(o)}>
                    {o}
                  </Pill>
                ))}
              </div>
            ) : null}
            {group === 'vs-3bet' ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-24 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                  3-bettor
                </span>
                {bettors.map((b) => (
                  <Pill key={b} active={bettor === b} onClick={() => setBettor(b)}>
                    {b}
                  </Pill>
                ))}
                <span className="text-xs text-ink-faint">
                  Continuation sets exist at 6-max and 8-max only; the opener's own RFI set is the
                  base range.
                </span>
              </div>
            ) : null}
          </section>

          <section aria-label="Positions in this scenario" className="flex flex-col gap-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Positions — {GROUP_LABEL[group]}
                {group === 'vs-rfi' && opener ? ` vs ${opener} open` : ''}
                {group === 'vs-3bet' && bettor ? ` vs ${bettor} 3-bet` : ''}
              </h2>
              <span className="text-xs text-ink-faint">
                Each card is that position's set in this scenario, with its headline split. Pick a
                position to open its set below.
              </span>
            </div>
            {stripEntries.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {stripEntries.map((e) => {
                  const data =
                    setDoc && setDoc.id === e.id
                      ? { totals, totalCombos }
                      : familyData?.get(e.id);
                  const active = position === e.position;
                  return (
                    <button
                      key={e.id}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        setPosition(e.position);
                        if (view === 'compare') setView('strategy');
                      }}
                      className={`min-w-[9.5rem] flex-1 rounded-lg border p-2.5 text-left ${
                        active
                          ? 'border-navy-700 bg-navy-800 ring-1 ring-table'
                          : 'border-navy-700 bg-navy-900 hover:ring-1 hover:ring-ink-faint'
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-sm font-semibold text-ink">{e.position}</span>
                        <span className="font-mono text-sm text-ink">
                          {data ? pctText(data.totals[familyHeadline] ?? 0) : '—'}
                        </span>
                      </div>
                      <p className="text-[11px] text-ink-faint">
                        {ACTION_LABEL[familyHeadline] ?? familyHeadline}
                        {data ? ` · ${data.totalCombos.toLocaleString()} combos` : ''}
                      </p>
                      {data ? (
                        <>
                          <div className="mt-2 h-2">
                            <SplitBar
                              segments={orderedActions(data.totals).map((a) => ({
                                fraction: data.totals[a] ?? 0,
                                color: ACTION_COLOR[a] ?? '#7a8aa0',
                                label: ACTION_LABEL[a] ?? a,
                              }))}
                            />
                          </div>
                          <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
                            {orderedActions(data.totals)
                              .map(
                                (a) => `${ACTION_LABEL[a] ?? a} ${pctText(data.totals[a] ?? 0)}`,
                              )
                              .join(' · ')}
                          </p>
                        </>
                      ) : (
                        <p className="mt-2 text-[11px] text-ink-faint">
                          {familyLoading ? 'Loading split…' : 'Set document unavailable.'}
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-ink-dim">
                No positions in this scenario at this table size and rake variant.
              </p>
            )}
          </section>

          {setLoading ? <p className="text-sm text-ink-dim">Loading range set…</p> : null}
          {setError ? (
            <p className="rounded-lg border border-red-900 bg-navy-900 p-3 text-sm text-red-300" role="alert">
              {setError}
            </p>
          ) : null}

          {setDoc && selectedEntry ? (
            <>
              <section
                aria-label="Range summary"
                className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <h2 className="text-base font-semibold text-ink">
                    {setLabel({ ...selectedEntry, context_detail: setDoc.context_detail })}
                  </h2>
                  <ApproximationBadge label="CONSTRUCTED" />
                  <span className="text-xs text-ink-faint">
                    {stackOf(setDoc)}bb · {setDoc.id}
                  </span>
                  {solveCompat ? (
                    <span className="ml-auto text-xs text-ink-dim">
                      Can feed the Solver wizard ({ACTION_LABEL[solveActionForContext(setDoc.context) ?? ''] ?? ''}{' '}
                      range)
                    </span>
                  ) : (
                    <span className="ml-auto text-xs text-ink-faint">
                      Not loadable into solves (v1 supports RFI + vs-RFI call sets)
                    </span>
                  )}
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div>
                    <dt className="text-xs text-ink-faint">
                      {ACTION_LABEL[headlineAction] ?? headlineAction} frequency
                    </dt>
                    <dd className="font-mono text-lg text-ink">
                      {totals[headlineAction] !== undefined ? pctText(totals[headlineAction]) : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-faint">Combos in {ACTION_LABEL[headlineAction] ?? headlineAction} range</dt>
                    <dd className="font-mono text-lg text-ink">{combosInHeadline.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-faint">Hand classes</dt>
                    <dd className="font-mono text-lg text-ink">
                      {Object.keys(setDoc.hands).length.toLocaleString()}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-ink-faint">Total combos covered</dt>
                    <dd className="font-mono text-lg text-ink">{totalCombos.toLocaleString()}</dd>
                  </div>
                </dl>

                <div className="mt-3 flex flex-col gap-1.5">
                  {Object.entries(totals)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([a, frac]) => (
                      <div key={a} className="flex items-center gap-2 text-xs">
                        <span className="w-12 text-ink-dim">{ACTION_LABEL[a] ?? a}</span>
                        <div className="flex-1">
                          <FrequencyBar fraction={frac} color={ACTION_COLOR[a] ?? '#7a8aa0'} />
                        </div>
                        <span className="w-14 text-right font-mono text-ink-dim">{pctText(frac)}</span>
                      </div>
                    ))}
                </div>

                {setDoc.notes ? (
                  <p className="mt-3 text-xs leading-relaxed text-ink-faint">{setDoc.notes}</p>
                ) : null}
                <p className="mt-1 text-xs leading-relaxed text-ink-faint">{setDoc.rake_note}</p>

                <div className="mt-3 border-t border-navy-700 pt-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                    Provenance
                  </h3>
                  {provenance ? (
                    <div className="mt-1 flex flex-col gap-1 text-xs text-ink-dim">
                      <p>
                        Method <span className="font-mono text-ink">{provenance.method}</span>
                        {provenance.tool ? (
                          <>
                            {' '}· built by {provenance.tool}
                            {provenance.tool_version ? ` v${provenance.tool_version}` : ''}
                          </>
                        ) : null}
                        {provenance.config_version ? (
                          <>
                            {' '}· config <span className="font-mono">{provenance.config_version}</span>
                          </>
                        ) : null}
                        {provenance.config_hash ? (
                          <>
                            {' '}· <span className="font-mono">{provenance.config_hash}</span>
                          </>
                        ) : null}
                      </p>
                      {provenance.sources.length > 0 ? (
                        <ul className="flex flex-col gap-1">
                          {provenance.sources.map((s) => (
                            <li key={s.name}>
                              Cross-check source:{' '}
                              {s.url ? (
                                <a
                                  href={s.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-table-light underline"
                                >
                                  {s.name}
                                </a>
                              ) : (
                                <span className="text-ink">{s.name}</span>
                              )}{' '}
                              <span className="text-ink-faint">
                                — {s.licence} (retrieved {s.retrieved})
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {provenance.derivation ? (
                        <p>
                          Derivation: <span className="text-ink">{provenance.derivation}</span>
                        </p>
                      ) : null}
                    </div>
                  ) : setDoc.source ? (
                    <p className="mt-1 text-xs text-ink-dim">
                      Source:{' '}
                      {setDoc.source.url ? (
                        <a
                          href={setDoc.source.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-table-light underline"
                        >
                          {setDoc.source.name}
                        </a>
                      ) : (
                        setDoc.source.name
                      )}{' '}
                      <span className="text-ink-faint">
                        — {setDoc.source.licence} (retrieved {setDoc.source.retrieved})
                      </span>
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-ink-faint">No provenance recorded for this set.</p>
                  )}
                </div>
              </section>

              <div
                className="flex flex-wrap items-center gap-2"
                role="tablist"
                aria-label="Range view"
              >
                <Pill active={view === 'strategy'} onClick={() => setView('strategy')}>
                  Strategy
                </Pill>
                <Pill active={view === 'matrix'} onClick={() => setView('matrix')}>
                  Matrix
                </Pill>
                <Pill active={view === 'ranges'} onClick={() => setView('ranges')}>
                  Ranges
                </Pill>
                <Pill active={view === 'breakdown'} onClick={() => setView('breakdown')}>
                  Breakdown
                </Pill>
                <Pill active={view === 'compare'} onClick={() => setView('compare')}>
                  Compare
                </Pill>
                <span className="text-xs text-ink-faint">
                  {view === 'strategy'
                    ? 'One column per action: every hand in this set under each action it takes.'
                    : view === 'matrix'
                      ? 'Pick a rank pair to drill into the classes that contain both ranks.'
                      : view === 'ranges'
                        ? 'This set as ranges: the classes behind each action, strongest first.'
                        : view === 'breakdown'
                          ? 'Pair-rank and suitedness aggregates, and how the selected action is mixed across the set.'
                          : 'Every position in this scenario side by side, plus the combined range.'}
                </span>
              </div>



              {view === 'breakdown' ? (
              <section
                aria-label="Breakdown"
                className="rounded-lg border border-navy-700 bg-navy-900 p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-ink">
                    Breakdown — how the {ACTION_LABEL[action] ?? action} range is mixed
                  </h2>
                  <div className="ml-auto flex flex-wrap gap-1.5">
                    {actionsInSet.map((a) => (
                      <Pill key={a} active={action === a} onClick={() => setAction(a)}>
                        {ACTION_LABEL[a] ?? a}
                      </Pill>
                    ))}
                  </div>
                </div>
                <p className="mt-1 text-xs text-ink-faint">
                  Each bar is the share of all combos in this set whose class takes{' '}
                  {ACTION_LABEL[action] ?? action} at that frequency. Constructed sets carry no
                  per-combo EV, so the breakdown is over frequencies — never an EV histogram.
                </p>
                <div className="mt-3 flex items-end gap-2" role="img" aria-label="Frequency mix histogram">
                  {breakdown.map((b) => (
                    <div key={b.key} className="flex flex-1 flex-col items-center gap-1">
                      <span className="font-mono text-[11px] text-ink-dim">
                        {pctText(b.fraction)}
                      </span>
                      <div className="flex h-24 w-full items-end rounded bg-navy-850">
                        <div
                          className="w-full rounded"
                          style={{
                            height: `${Math.max(1.5, b.fraction * 100)}%`,
                            backgroundColor: ACTION_COLOR[action] ?? '#7a8aa0',
                          }}
                        />
                      </div>
                      <span className="text-center text-[11px] leading-tight text-ink-faint">
                        {b.label}
                      </span>
                      <span className="font-mono text-[11px] text-ink-faint">
                        {b.combos.toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>

                {classByHand ? (
                  <>
                    <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                      {ACTION_LABEL[action] ?? action} frequency by suitedness
                    </h3>
                    <ul className="mt-2 grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
                      {suitSummary.map((b) => (
                        <li key={b.key} className="flex items-center gap-2 text-xs">
                          <span className="w-32 shrink-0 text-ink-dim">{b.label}</span>
                          <div className="flex-1">
                            <FrequencyBar
                              fraction={b.fraction}
                              color={ACTION_COLOR[action] ?? '#7a8aa0'}
                              height="h-2"
                            />
                          </div>
                          <span className="w-14 text-right font-mono text-ink-dim">
                            {pctText(b.fraction)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {classByHand ? (
                  <>
                    <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                      {ACTION_LABEL[action] ?? action} frequency by pair rank
                    </h3>
                    <ul className="mt-2 grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
                      {summary.map((b) => (
                        <li key={b.key} className="flex items-center gap-2 text-xs">
                          <span className="w-40 shrink-0 text-ink-dim">{b.label}</span>
                          <div className="flex-1">
                            <FrequencyBar fraction={b.fraction} color={ACTION_COLOR[action] ?? '#7a8aa0'} height="h-2" />
                          </div>
                          <span className="w-14 text-right font-mono text-ink-dim">{pctText(b.fraction)}</span>
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="mt-3 text-xs text-ink-dim">
                    {classTableMissing
                      ? 'The class table has not been generated on a host yet, so pair-rank aggregates and hand features are unavailable. Frequencies above are computed from the set document alone.'
                      : 'Loading class features…'}
                  </p>
                )}
              </section>
              ) : null}

              {view === 'strategy' ? (
                <>
              <section
                aria-label="Strategy by action"
                className="rounded-lg border border-navy-700 bg-navy-900 p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-ink">
                    Strategy — hands by action{' '}
                    <span className="font-normal text-ink-faint">
                      ({Object.keys(setDoc.hands).length.toLocaleString()} classes in this set)
                    </span>
                  </h2>
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    <label className="text-xs text-ink-dim">
                      Filter
                      <input
                        type="text"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                        placeholder="As Ah …"
                        className="ml-2 w-32 rounded-md border border-navy-700 bg-navy-850 px-2 py-1 font-mono text-xs text-ink"
                      />
                    </label>
                  </div>
                </div>
                <p className="mt-1 text-xs text-ink-faint">
                  One column per action this set records. Each column lists every class that
                  takes the action, densest first; a class that mixes appears in each column
                  it plays, at that action's frequency. Freq is the class's frequency for the
                  action in this set; Weight is the class's concrete combo count (its
                  multiplicity — the same count the class detail panel shows). Constructed
                  ranges carry no per-hand EV, so no EV columns are shown. Click a class for
                  its full action split, combos and features.
                </p>
                {selClassRow ? (
                  <div className="mt-3">
                    <ClassDetail
                      classKey={selClassRow.key}
                      actions={selClassRow.actions}
                      cls={selClassRow.cls}
                      multiplicity={selClassRow.multiplicity}
                      onClose={() => setSelClass(null)}
                    />
                  </div>
                ) : null}
                <div className="mt-3 grid items-start gap-3 lg:grid-cols-[repeat(auto-fit,minmax(290px,1fr))]">
                  {strategyColumns.map((col) => (
                    <div
                      key={col.action}
                      className="overflow-hidden rounded-lg border border-navy-700 bg-navy-850"
                    >
                      <div className="relative px-3 py-2.5">
                        <div
                          className="absolute inset-0 opacity-25"
                          style={{
                            backgroundColor: COLUMN_COLOR[col.action] ?? COLUMN_COLOR_FALLBACK,
                          }}
                          aria-hidden="true"
                        />
                        <div className="relative flex items-baseline justify-between gap-2">
                          <h3
                            className="text-sm font-semibold"
                            style={{
                              color: COLUMN_COLOR[col.action] ?? COLUMN_COLOR_FALLBACK,
                            }}
                          >
                            {ACTION_LABEL[col.action] ?? col.action}
                          </h3>
                          <span className="font-mono text-[11px] text-ink-dim">
                            {Math.round(col.weightedCombos).toLocaleString()} combos
                          </span>
                        </div>
                        <div className="relative mt-0.5 font-mono text-xl font-bold text-ink">
                          {pctText(col.total)}
                        </div>
                      </div>
                      <div className="max-h-[540px] overflow-y-auto">
                        <table className="w-full text-left text-sm">
                          <thead>
                            <tr className="border-b border-navy-700 text-xs uppercase tracking-wide text-ink-faint">
                              <th className="py-1.5 pl-3 pr-2 font-medium">Hand</th>
                              <th className="py-1.5 pr-2 font-medium">Freq</th>
                              <th
                                className="py-1.5 pr-3 text-right font-medium"
                                title="Concrete combos in the class (multiplicity)"
                              >
                                Weight
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {col.rows.map((r) => {
                              const cards = parseCombo(r.key);
                              return (
                                <tr
                                  key={r.key}
                                  onClick={() => setSelClass(r.key)}
                                  aria-selected={selClass === r.key}
                                  className={`cursor-pointer border-b border-navy-800 hover:bg-navy-900 ${
                                    selClass === r.key ? 'bg-navy-900' : ''
                                  }`}
                                >
                                  <td className="py-1.5 pl-3 pr-2">
                                    {cards ? (
                                      <CardRow cards={cards} size="xs" />
                                    ) : (
                                      <span className="font-mono text-xs text-ink">{r.key}</span>
                                    )}
                                  </td>
                                  <td className="w-32 py-1.5 pr-2">
                                    <div className="flex items-center gap-2">
                                      <div className="w-14">
                                        <FrequencyBar
                                          fraction={r.freq}
                                          color={ACTION_COLOR[col.action] ?? '#7a8aa0'}
                                          height="h-2"
                                        />
                                      </div>
                                      <span className="font-mono text-xs text-ink-dim">
                                        {pctText(r.freq)}
                                      </span>
                                    </div>
                                  </td>
                                  <td
                                    className="py-1.5 pr-3 text-right font-mono text-xs text-ink-dim"
                                    title={`${r.multiplicity.toLocaleString()} concrete combos — ${totalCombos > 0 ? ((r.multiplicity / totalCombos) * 100).toFixed(2) : '0.00'}% of this set`}
                                  >
                                    {r.multiplicity}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        {col.rows.length === 0 ? (
                          <p className="px-3 py-2 text-xs text-ink-faint">
                            No classes match the filter.
                          </p>
                        ) : null}
                      </div>
                      {col.classCount > col.rows.length ? (
                        <p className="border-t border-navy-700 px-3 py-1.5 text-[11px] text-ink-faint">
                          Densest {col.rows.length.toLocaleString()} of{' '}
                          {col.classCount.toLocaleString()} classes — filter to narrow.
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
                </>
              ) : view === 'matrix' ? (
              <section
                aria-label="Rank-pair matrix"
                className="rounded-lg border border-navy-700 bg-navy-900 p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-ink">
                    Matrix — pick a rank pair to drill into combos
                  </h2>
                  <div className="ml-auto flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-ink-faint">Action</span>
                    {actionsInSet.map((a) => (
                      <Pill key={a} active={action === a} onClick={() => setAction(a)}>
                        {ACTION_LABEL[a] ?? a}
                      </Pill>
                    ))}
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                    Suitedness
                  </span>
                  {SUITEDNESS_FILTERS.map((f) =>
                    suitFiltersEnabled ? (
                      <Pill
                        key={f.id}
                        active={suitFilter === f.id}
                        onClick={() => setSuitFilter(f.id)}
                      >
                        {f.label}
                      </Pill>
                    ) : (
                      <span
                        key={f.id}
                        aria-disabled="true"
                        className="rounded-full bg-navy-850 px-2.5 py-1 text-xs text-ink-faint opacity-50"
                      >
                        {f.label}
                      </span>
                    ),
                  )}
                  {!suitFiltersEnabled ? (
                    <span className="text-xs text-ink-faint">
                      Suitedness filters need the class table, which is not loaded — showing all
                      suits.
                    </span>
                  ) : null}
                </div>

                <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
                  <div className="overflow-x-auto">
                    <div
                      className="grid min-w-[430px]"
                      style={{
                        gridTemplateColumns: `1.4rem repeat(${MATRIX_RANKS.length}, minmax(0, 1fr))`,
                      }}
                      role="grid"
                      aria-label="Rank pair matrix"
                    >
                      <span />
                      {MATRIX_RANKS.map((r) => (
                        <span
                          key={`col-${r}`}
                          className="pb-1 text-center text-[11px] font-semibold text-ink-faint"
                        >
                          {r}
                        </span>
                      ))}
                      {MATRIX_RANKS.map((rowRank, ri) => {
                        const rowVal = 14 - ri;
                        return (
                          <Fragment key={`row-${rowRank}`}>
                            <span className="flex items-center justify-center pr-1 text-[11px] font-semibold text-ink-faint">
                              {rowRank}
                            </span>
                            {MATRIX_RANKS.map((colRank, ci) => {
                              const colVal = 14 - ci;
                              const hi = Math.max(rowVal, colVal);
                              const lo = Math.min(rowVal, colVal);
                              const cell = cells.get(`${hi}-${lo}`);
                              const frac = cell?.fraction ?? 0;
                              const selected = selCell.hi === hi && selCell.lo === lo;
                              const pairName = `${rankLabel(hi)}${rankLabel(lo)}`;
                              return (
                                <button
                                  key={`${rowRank}-${colRank}`}
                                  type="button"
                                  role="gridcell"
                                  aria-pressed={selected}
                                  aria-label={`${pairName}: ${cell ? cell.combos.toLocaleString() : 0} combos, ${ACTION_LABEL[action] ?? action} ${pctText(frac)}`}
                                  title={`${pairName} · ${cell ? cell.combos.toLocaleString() : 0} combos · ${ACTION_LABEL[action] ?? action} ${pctText(frac)}`}
                                  onClick={() => setSelCell({ hi, lo })}
                                  className={`aspect-square border border-navy-950/60 ${
                                    selected
                                      ? 'z-10 ring-2 ring-accent'
                                      : 'hover:ring-1 hover:ring-ink-faint'
                                  }`}
                                  style={{
                                    backgroundColor: cell
                                      ? hexToRgba(
                                          ACTION_COLOR[action] ?? '#7a8aa0',
                                          0.1 + 0.85 * frac,
                                        )
                                      : undefined,
                                  }}
                                />
                              );
                            })}
                          </Fragment>
                        );
                      })}
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-ink-faint">
                      Cell colour is the combo-weighted {ACTION_LABEL[action] ?? action}{' '}
                      frequency of every class containing both ranks (the diagonal is pairs and
                      better of that rank). Suitedness filters reshape the grid; the grid is a
                      drill-down, never a 270K-combo wall.
                    </p>
                  </div>

                  <aside aria-label="Matrix selection" className="flex flex-col gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-ink">
                        {selPairLabel} selected →{' '}
                        {(selCellData?.combos ?? 0).toLocaleString()} combos ·{' '}
                        {ACTION_LABEL[action] ?? action} {pctText(selCellData?.fraction ?? 0)}
                      </h3>
                      <p className="mt-1 text-xs text-ink-dim">
                        {matrixTotal > 0
                          ? `${pctText((selCellData?.combos ?? 0) / matrixTotal)} of the ${matrixTotal.toLocaleString()} combos in this set${suitFeature ? ` with suitedness: ${suitFilterLabel.toLowerCase()}` : ''}. Frequency is combo-weighted within the selection.`
                          : 'No combos in this set match the current filter.'}
                      </p>
                    </div>
                    {drillRows.length > 0 ? (
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead>
                            <tr className="border-b border-navy-700 text-xs uppercase tracking-wide text-ink-faint">
                              <th className="py-1.5 pr-3 font-medium">Class</th>
                              <th className="py-1.5 pr-3 font-medium">Combos</th>
                              <th className="py-1.5 font-medium">
                                {ACTION_LABEL[action] ?? action}
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {drillRows.slice(0, MATRIX_ROW_CAP).map((r) => (
                              <tr
                                key={r.key}
                                onClick={() => setSelClass(r.key)}
                                aria-selected={selClass === r.key}
                                className={`cursor-pointer border-b border-navy-800 hover:bg-navy-850 ${
                                  selClass === r.key ? 'bg-navy-850' : ''
                                }`}
                              >
                                <td className="py-1.5 pr-3 font-mono text-xs text-ink">
                                  {r.key}
                                  {r.cls ? (
                                    <span className="block font-sans text-[11px] text-ink-faint">
                                      {featureTags(r.cls).join(' · ')}
                                    </span>
                                  ) : null}
                                </td>
                                <td className="py-1.5 pr-3 font-mono text-xs text-ink-dim">
                                  {r.multiplicity}
                                </td>
                                <td className="w-32 py-1.5">
                                  <div className="flex items-center gap-2">
                                    <div className="w-14">
                                      <FrequencyBar
                                        fraction={r.actions[action] ?? 0}
                                        color={ACTION_COLOR[action] ?? '#7a8aa0'}
                                        height="h-2"
                                      />
                                    </div>
                                    <span className="font-mono text-xs text-ink-dim">
                                      {pctText(r.actions[action] ?? 0)}
                                    </span>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {drillRows.length > MATRIX_ROW_CAP ? (
                          <p className="mt-1.5 text-xs text-ink-faint">
                            Showing the first {MATRIX_ROW_CAP} of{' '}
                            {drillRows.length.toLocaleString()} classes, strongest{' '}
                            {ACTION_LABEL[action] ?? action} frequency first.
                          </p>
                        ) : null}
                      </div>
                    ) : (
                      <p className="text-sm text-ink-dim">
                        No classes in this set contain{' '}
                        {selCell.hi === selCell.lo
                          ? `a pair or better of ${rankLabel(selCell.hi)}s`
                          : `both ${rankLabel(selCell.hi)} and ${rankLabel(selCell.lo)}`}
                        {suitFeature ? ` with suitedness: ${suitFilterLabel.toLowerCase()}` : ''}.
                      </p>
                    )}
                    {selClassRow ? (
                      <ClassDetail
                        classKey={selClassRow.key}
                        actions={selClassRow.actions}
                        cls={selClassRow.cls}
                        multiplicity={selClassRow.multiplicity}
                        onClose={() => setSelClass(null)}
                      />
                    ) : (
                      <p className="text-xs text-ink-faint">
                        Click a class in the list for its full action split, combos and features.
                      </p>
                    )}
                  </aside>
                </div>
              </section>
              ) : view === 'ranges' ? (
              <section
                aria-label="Ranges by action"
                className="rounded-lg border border-navy-700 bg-navy-900 p-4"
              >
                <h2 className="text-sm font-semibold text-ink">Ranges — this set by action</h2>
                <p className="mt-1 text-xs text-ink-faint">
                  In the reference, the preflop Ranges tab is a postflop-only prompt — there is no
                  postflop range behind a preflop set. Here the tab shows what a preflop set
                  actually is: one range per action. Every figure comes from this set document;
                  the frequencies are constructed-range frequencies, not solver output.
                </p>

                <div className="mt-3 h-3">
                  <SplitBar
                    segments={orderedActions(totals).map((a) => ({
                      fraction: totals[a] ?? 0,
                      color: ACTION_COLOR[a] ?? '#7a8aa0',
                      label: ACTION_LABEL[a] ?? a,
                    }))}
                  />
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-dim">
                  {orderedActions(totals).map((a) => (
                    <span key={a}>
                      <span
                        className="mr-1 inline-block h-2 w-2 rounded-sm"
                        style={{ backgroundColor: ACTION_COLOR[a] ?? '#7a8aa0' }}
                      />
                      {ACTION_LABEL[a] ?? a} {pctText(totals[a] ?? 0)}
                    </span>
                  ))}
                </div>

                {selClassRow ? (
                  <div className="mt-3">
                    <ClassDetail
                      classKey={selClassRow.key}
                      actions={selClassRow.actions}
                      cls={selClassRow.cls}
                      multiplicity={selClassRow.multiplicity}
                      onClose={() => setSelClass(null)}
                    />
                  </div>
                ) : null}

                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  {actionRanges.map((r) => (
                    <div
                      key={r.action}
                      className="rounded-lg border border-navy-700 bg-navy-850 p-3"
                    >
                      <div className="flex flex-wrap items-baseline gap-2">
                        <h3 className="text-sm font-semibold text-ink">
                          {ACTION_LABEL[r.action] ?? r.action} range
                        </h3>
                        <span className="font-mono text-sm text-ink">{pctText(r.total)}</span>
                        <span className="text-[11px] text-ink-faint">
                          {r.combosWithFreq.toLocaleString()} combos take it at some frequency ·{' '}
                          {r.classCount.toLocaleString()} classes
                        </span>
                      </div>
                      <div className="mt-2">
                        <FrequencyBar
                          fraction={r.total}
                          color={ACTION_COLOR[r.action] ?? '#7a8aa0'}
                        />
                      </div>
                      <div className="mt-2 overflow-x-auto">
                        <table className="w-full text-left text-sm">
                          <thead>
                            <tr className="border-b border-navy-700 text-xs uppercase tracking-wide text-ink-faint">
                              <th className="py-1.5 pr-3 font-medium">Class</th>
                              <th className="py-1.5 pr-3 font-medium">Combos</th>
                              <th className="py-1.5 font-medium">
                                {ACTION_LABEL[r.action] ?? r.action}
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {r.rows.map((row) => (
                              <tr
                                key={row.key}
                                onClick={() => setSelClass(row.key)}
                                aria-selected={selClass === row.key}
                                className={`cursor-pointer border-b border-navy-800 hover:bg-navy-900 ${
                                  selClass === row.key ? 'bg-navy-900' : ''
                                }`}
                              >
                                <td className="py-1.5 pr-3 font-mono text-xs text-ink">{row.key}</td>
                                <td className="py-1.5 pr-3 font-mono text-xs text-ink-dim">
                                  {row.multiplicity}
                                </td>
                                <td className="w-36 py-1.5">
                                  <div className="flex items-center gap-2">
                                    <div className="w-16">
                                      <FrequencyBar
                                        fraction={row.freq}
                                        color={ACTION_COLOR[r.action] ?? '#7a8aa0'}
                                        height="h-2"
                                      />
                                    </div>
                                    <span className="font-mono text-xs text-ink-dim">
                                      {pctText(row.freq)}
                                    </span>
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {r.classCount > r.rows.length ? (
                        <p className="mt-1.5 text-xs text-ink-faint">
                          Strongest {r.rows.length} classes shown — the Strategy tab lists
                          every class per action.
                        </p>
                      ) : null}
                    </div>
                  ))}
                </div>
              </section>
              ) : (
              <section
                aria-label="Compare positions"
                className="rounded-lg border border-navy-700 bg-navy-900 p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-ink">
                    Compare — {GROUP_LABEL[group]} · {RAKE_LABEL[rake]}
                    {group === 'vs-rfi' && opener ? ` · vs ${opener} open` : ''}
                    {group === 'vs-3bet' && bettor ? ` · vs ${bettor} 3-bet` : ''}
                  </h2>
                  <span className="ml-auto text-xs text-ink-faint">
                    Click a position to open its set.
                  </span>
                </div>
                {familyLoading ? (
                  <p className="mt-3 text-sm text-ink-dim">Loading the sets in this scenario…</p>
                ) : familyData && compareEntries.length > 0 ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {compareEntries.map((e) => {
                      const data = familyData.get(e.id);
                      return (
                        <button
                          key={e.id}
                          type="button"
                          disabled={!data}
                          onClick={() => {
                            setPosition(e.position);
                            setView('strategy');
                          }}
                          className="rounded-lg border border-navy-700 bg-navy-850 p-3 text-left hover:ring-1 hover:ring-ink-faint disabled:opacity-50"
                        >
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="text-sm font-semibold text-ink">{e.position}</span>
                            <span className="font-mono text-lg text-ink">
                              {data ? pctText(data.totals[headlineAction] ?? 0) : '—'}
                            </span>
                          </div>
                          <p className="text-[11px] text-ink-faint">
                            {ACTION_LABEL[headlineAction] ?? headlineAction} · {e.table_size} ·{' '}
                            {RAKE_LABEL[rakeOf(e)]}
                          </p>
                          {data ? (
                            <div className="mt-2 flex flex-col gap-1.5">
                              {compareActions.map((a) => (
                                <div key={a} className="flex items-center gap-2 text-xs">
                                  <span className="w-12 text-ink-dim">
                                    {ACTION_LABEL[a] ?? a}
                                  </span>
                                  <div className="flex-1">
                                    <FrequencyBar
                                      fraction={data.totals[a] ?? 0}
                                      color={ACTION_COLOR[a] ?? '#7a8aa0'}
                                      height="h-2"
                                    />
                                  </div>
                                  <span className="w-14 text-right font-mono text-ink-dim">
                                    {pctText(data.totals[a] ?? 0)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="mt-2 text-xs text-ink-faint">
                              Set document unavailable.
                            </p>
                          )}
                        </button>
                      );
                    })}
                    {compareCombined ? (
                      <div className="rounded-lg border border-dashed border-navy-700 bg-navy-900 p-3">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-sm font-semibold text-ink">Combined</span>
                          <span className="font-mono text-lg text-ink">
                            {pctText(compareCombined[headlineAction] ?? 0)}
                          </span>
                        </div>
                        <p className="text-[11px] text-ink-faint">
                          {ACTION_LABEL[headlineAction] ?? headlineAction} · all positions in this
                          scenario, weighted by combo count
                        </p>
                        <div className="mt-2 flex flex-col gap-1.5">
                          {compareActions.map((a) => (
                            <div key={a} className="flex items-center gap-2 text-xs">
                              <span className="w-12 text-ink-dim">{ACTION_LABEL[a] ?? a}</span>
                              <div className="flex-1">
                                <FrequencyBar
                                  fraction={compareCombined[a] ?? 0}
                                  color={ACTION_COLOR[a] ?? '#7a8aa0'}
                                  height="h-2"
                                />
                              </div>
                              <span className="w-14 text-right font-mono text-ink-dim">
                                {pctText(compareCombined[a] ?? 0)}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-ink-dim">
                    No sets in this scenario to compare.
                  </p>
                )}
                <p className="mt-3 text-xs leading-relaxed text-ink-faint">
                  Totals are combo-weighted within each set. Every figure is a constructed-range
                  frequency, not solver output.
                </p>
              </section>
              )}
            </>
          ) : !setLoading && !setError ? (
            <p className="text-sm text-ink-dim">No range set matches the current selection.</p>
          ) : null}
        </>
      )}
    </div>
  );
}
