import { useEffect, useMemo, useState } from 'react';
import { ApproximationBadge } from '../components/AccuracyBadge';
import { FrequencyBar, pctText } from '../components/FrequencyBar';
import { ApiError, fetchPreflopClassTable, fetchPreflopIndex, fetchPreflopSet } from '../lib/api';
import {
  actionTotals,
  combosInAction,
  featureTags,
  isSolveCompatible,
  multiplicityOf,
  pairRankSummary,
  setLabel,
  setTotalCombos,
  solveActionForContext,
  sortPositions,
  type PreflopClass,
  type PreflopIndex,
  type PreflopSetDoc,
  type PreflopSetIndexEntry,
  type SetContext,
  type TableSize,
} from '../lib/preflop';
import { useStore } from '../store/useStore';

// Preflop Ranges screen. Every number on this page comes from the API:
// the set index, the selected set document (16,432 classes with per-action
// frequencies) and the class table (multiplicities, equities, features).
// The sets are CONSTRUCTED ranges — the amber CONSTRUCTED badge and the
// provenance block are always shown; the green certified-GTO badge is
// never used here.

type ContextGroup = 'first-in' | 'vs-rfi';

const GROUP_CONTEXTS: Record<ContextGroup, SetContext[]> = {
  // SB first-in sets use the sb_play context; they are first-in decisions.
  'first-in': ['rfi', 'sb_play'],
  'vs-rfi': ['vs_rfi'],
};

const GROUP_LABEL: Record<ContextGroup, string> = {
  'first-in': 'RFI / first-in',
  'vs-rfi': 'vs RFI',
};

const ACTION_COLOR: Record<string, string> = {
  raise: '#f5a623',
  three_bet: '#d96c4f',
  call: '#2aa198',
  fold: '#8a4b57',
};

const ACTION_LABEL: Record<string, string> = {
  raise: 'Raise',
  three_bet: '3-bet',
  call: 'Call',
  fold: 'Fold',
};

const ROW_CAP = 200;

type SortKey = 'frequency' | 'equity' | 'score' | 'hand';

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

export function PreflopPage() {
  const setApiOnline = useStore((s) => s.setApiOnline);

  const [index, setIndex] = useState<PreflopIndex | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [classByHand, setClassByHand] = useState<Map<string, PreflopClass> | null>(null);
  const [classTableMissing, setClassTableMissing] = useState(false);

  const [tableSize, setTableSize] = useState<TableSize>('6max');
  const [group, setGroup] = useState<ContextGroup>('first-in');
  const [position, setPosition] = useState<string | null>(null);
  const [opener, setOpener] = useState<string | null>(null);

  const [setDoc, setSetDoc] = useState<PreflopSetDoc | null>(null);
  const [setLoading, setSetLoading] = useState(false);
  const [setError, setSetError] = useState<string | null>(null);

  const [action, setAction] = useState<string>('raise');
  const [sortKey, setSortKey] = useState<SortKey>('frequency');
  const [filter, setFilter] = useState('');

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

  const groupSets = useMemo<PreflopSetIndexEntry[]>(() => {
    if (!index) return [];
    return index.rangesets.filter(
      (e) => e.table_size === tableSize && GROUP_CONTEXTS[group].includes(e.context),
    );
  }, [index, tableSize, group]);

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

  const selectedEntry = useMemo<PreflopSetIndexEntry | null>(() => {
    if (positionSets.length === 0) return null;
    if (group !== 'vs-rfi') return positionSets[0] ?? null;
    if (!opener) return null;
    const slug = opener.toLowerCase().replace('utg+', 'utgplus');
    return positionSets.find((e) => e.id.endsWith(`-vs-${slug}`)) ?? null;
  }, [positionSets, group, opener]);

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
        // Default the displayed action to the set's headline action.
        const headline =
          doc.context === 'vs_rfi' ? 'call' : doc.context === 'three_bet' ? 'call' : 'raise';
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
    ? setDoc.context === 'vs_rfi'
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

  const rows = useMemo<ClassRow[]>(() => {
    if (!setDoc) return [];
    const all: ClassRow[] = Object.entries(setDoc.hands).map(([key, actions]) => ({
      key,
      actions,
      cls: classByHand?.get(key) ?? null,
      multiplicity: multiplicityOf(key, classByHand),
    }));
    const needle = filter.trim().toLowerCase().replace(/\s+/g, ' ');
    const filtered = needle
      ? all.filter((r) => r.key.toLowerCase().replace(/\s+/g, ' ').includes(needle))
      : all;
    const byKey = (a: ClassRow, b: ClassRow) => a.key.localeCompare(b.key);
    switch (sortKey) {
      case 'frequency':
        filtered.sort((a, b) => (b.actions[action] ?? 0) - (a.actions[action] ?? 0) || byKey(a, b));
        break;
      case 'equity':
        filtered.sort(
          (a, b) => (b.cls?.equity_vs_random ?? -1) - (a.cls?.equity_vs_random ?? -1) || byKey(a, b),
        );
        break;
      case 'score':
        filtered.sort((a, b) => (b.cls?.score ?? -1) - (a.cls?.score ?? -1) || byKey(a, b));
        break;
      case 'hand':
        filtered.sort(byKey);
        break;
    }
    return filtered;
  }, [setDoc, classByHand, filter, sortKey, action]);

  const actionsInSet = useMemo(() => {
    if (!setDoc) return [];
    const present = new Set<string>();
    for (const actions of Object.values(setDoc.hands)) {
      for (const a of Object.keys(actions)) present.add(a);
    }
    return ['raise', 'three_bet', 'call', 'fold'].filter((a) => present.has(a));
  }, [setDoc]);

  const provenance = setDoc?.provenance;
  const solveCompat = selectedEntry ? isSolveCompatible(selectedEntry) : false;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-bold text-ink">Preflop Ranges</h1>
        <p className="text-sm text-ink-dim">
          Starting ranges for 6-max and 9-max. These are <strong>constructed</strong> ranges —
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
              {(['6max', '9max'] as TableSize[]).map((t) => (
                <Pill key={t} active={tableSize === t} onClick={() => setTableSize(t)}>
                  {t === '6max' ? '6-max' : '9-max'}
                </Pill>
              ))}
              <span className="ml-auto text-xs text-ink-faint">
                {index.rangesets.filter((e) => e.table_size === tableSize).length} sets at this
                table size
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
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-24 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Position
              </span>
              {positions.map((p) => (
                <Pill key={p} active={position === p} onClick={() => setPosition(p)}>
                  {p}
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
                    {setDoc.stack_bb}bb · {setDoc.id}
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

              <section
                aria-label="Pair rank summary"
                className="rounded-lg border border-navy-700 bg-navy-900 p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-ink">
                    {ACTION_LABEL[action] ?? action} frequency by pair rank
                  </h2>
                  <div className="ml-auto flex flex-wrap gap-1.5">
                    {actionsInSet.map((a) => (
                      <Pill key={a} active={action === a} onClick={() => setAction(a)}>
                        {ACTION_LABEL[a] ?? a}
                      </Pill>
                    ))}
                  </div>
                </div>
                {classByHand ? (
                  <ul className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
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
                ) : (
                  <p className="mt-2 text-sm text-ink-dim">
                    {classTableMissing
                      ? 'The class table has not been generated on a host yet, so pair-rank aggregates and hand features are unavailable. Frequencies above are computed from the set document alone.'
                      : 'Loading class features…'}
                  </p>
                )}
              </section>

              <section
                aria-label="Hand classes"
                className="rounded-lg border border-navy-700 bg-navy-900 p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold text-ink">
                    Hand classes{' '}
                    <span className="font-normal text-ink-faint">
                      ({rows.length.toLocaleString()} in this set)
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
                    <label className="text-xs text-ink-dim">
                      Sort
                      <select
                        value={sortKey}
                        onChange={(e) => setSortKey(e.target.value as SortKey)}
                        className="ml-2 rounded-md border border-navy-700 bg-navy-850 px-2 py-1 text-xs text-ink"
                      >
                        <option value="frequency">{ACTION_LABEL[action] ?? action} frequency</option>
                        <option value="equity" disabled={!classByHand}>
                          Equity vs random
                        </option>
                        <option value="score" disabled={!classByHand}>
                          Construction score
                        </option>
                        <option value="hand">Hand A–Z</option>
                      </select>
                    </label>
                  </div>
                </div>
                <p className="mt-1 text-xs text-ink-faint">
                  Showing the first {Math.min(ROW_CAP, rows.length).toLocaleString()} of{' '}
                  {rows.length.toLocaleString()} classes — filter to narrow the list. Frequencies
                  are per class; combos counts weight each class by its concrete combo count.
                </p>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-navy-700 text-xs uppercase tracking-wide text-ink-faint">
                        <th className="py-1.5 pr-3 font-medium">Class</th>
                        <th className="py-1.5 pr-3 font-medium">Combos</th>
                        <th className="py-1.5 pr-3 font-medium">
                          {ACTION_LABEL[action] ?? action}
                        </th>
                        <th className="py-1.5 pr-3 font-medium">All actions</th>
                        <th className="py-1.5 pr-3 font-medium">Equity vs random</th>
                        <th className="py-1.5 font-medium">Features</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, ROW_CAP).map((r) => (
                        <tr key={r.key} className="border-b border-navy-800">
                          <td className="py-1.5 pr-3 font-mono text-xs text-ink">{r.key}</td>
                          <td className="py-1.5 pr-3 font-mono text-xs text-ink-dim">
                            {r.multiplicity}
                          </td>
                          <td className="w-48 py-1.5 pr-3">
                            <div className="flex items-center gap-2">
                              <div className="w-24">
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
                          <td className="py-1.5 pr-3 text-xs text-ink-dim">
                            {Object.entries(r.actions)
                              .map(([a, f]) => `${ACTION_LABEL[a] ?? a} ${pctText(f)}`)
                              .join(' · ')}
                          </td>
                          <td className="py-1.5 pr-3 font-mono text-xs text-ink-dim">
                            {r.cls ? pctText(r.cls.equity_vs_random) : '—'}
                          </td>
                          <td className="py-1.5 text-xs text-ink-dim">
                            {r.cls ? featureTags(r.cls).join(' · ') : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          ) : !setLoading && !setError ? (
            <p className="text-sm text-ink-dim">No range set matches the current selection.</p>
          ) : null}
        </>
      )}
    </div>
  );
}
