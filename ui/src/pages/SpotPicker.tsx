import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AccuracyBadge } from '../components/AccuracyBadge';
import { CardRow } from '../components/CardChip';
import { fetchCatalog, fetchLibrary, fetchLibrarySolve, fetchSampleSolve } from '../lib/api';
import { parseCardList } from '../lib/cards';
import {
  ACCURACY_BAND_LABEL,
  applyLibraryFilters,
  activeFilterCount,
  DEFAULT_LIBRARY_FILTERS,
  libraryRow,
  potTypeLabel,
  presentValues,
  sampleRow,
  sortLibraryRows,
  sprOf,
  SPR_BAND_LABEL,
  type AccuracyBand,
  type LibraryFilters,
  type LibraryRow,
  type LibraryRowSource,
  type SprBand,
  type Street,
} from '../lib/library';
import type { CatalogEntry } from '../lib/runner';
import { parseSolve } from '../lib/solveTree';
import { FAMILY_LABEL, type TextureFamily } from '../lib/texture';
import type { LibraryItem } from '../lib/types';
import { useStore } from '../store/useStore';

// The Explore landing page: GTO Wizard's Solution Library + Custom
// Solutions as one list (their f14/f83 selector + f15 custom list).
// Finished jobs publish into the same library as catalog solves, so the
// two lists are one here, told apart by the Source chip/filter. Every
// filter binds to a field the row actually carries — see
// lib/library.ts for the field-by-field provenance, and
// LIBRARY-PARITY-NOTES.md for what the reference has that we omit.

const FAMILIES: TextureFamily[] = ['flush-heavy', 'paired', 'connected', 'dry'];
const STREETS: Street[] = ['flop', 'turn', 'river'];
const SOURCES: LibraryRowSource[] = ['library', 'custom', 'sample'];
const SOURCE_LABEL: Record<LibraryRowSource, string> = {
  library: 'Library',
  custom: 'Custom',
  sample: 'Sample',
};

const selectClass =
  'w-full rounded-md border border-navy-600 bg-navy-850 px-2 py-2 text-sm text-ink';
const labelClass =
  'mb-1 block text-xs font-semibold uppercase tracking-wide text-ink-faint';

function RailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <span className={labelClass}>{title}</span>
      {children}
    </div>
  );
}

function Chips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={
            value === o.value
              ? 'rounded-full border border-table bg-table px-2.5 py-1 text-xs font-semibold text-white'
              : 'rounded-full border border-navy-600 px-2.5 py-1 text-xs text-ink-dim hover:bg-navy-800 hover:text-ink'
          }
        >
          {o.label}
          {o.count !== undefined ? <span className="opacity-70"> · {o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

function rowSubline(row: LibraryRow): string {
  const parts: string[] = [row.street.charAt(0).toUpperCase() + row.street.slice(1)];
  const spr = sprOf(row);
  if (row.startingPot !== null && row.effectiveStack !== null && spr !== null) {
    parts.push(`Pot ${row.startingPot} · Stack ${row.effectiveStack} · SPR ${spr.toFixed(1)}`);
  }
  if (row.catalog) {
    parts.push(`${row.catalog.group} · ${row.catalog.matchup}`);
  }
  if (row.finishedAt) {
    const d = new Date(row.finishedAt);
    if (Number.isFinite(d.getTime())) parts.push(`Finished ${d.toLocaleDateString()}`);
  }
  return parts.join(' · ');
}

export function SpotPickerPage() {
  const navigate = useNavigate();
  const loadRawSolve = useStore((s) => s.loadRawSolve);
  const loadSample = useStore((s) => s.loadSample);
  const setApiOnline = useStore((s) => s.setApiOnline);

  const [rows, setRows] = useState<LibraryRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [libraryFailed, setLibraryFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<LibraryFilters>(DEFAULT_LIBRARY_FILTERS);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // The catalog join is best-effort: without it, library rows lose
      // their setup fields (and the setup filters) but stay listed.
      let catalogBySpotId = new Map<string, CatalogEntry>();
      try {
        const catalog = await fetchCatalog();
        catalogBySpotId = new Map(catalog.entries.map((e) => [e.id, e]));
      } catch {
        // Picker still works unjoined.
      }
      const available: LibraryRow[] = [];
      // The bundled sample is always available.
      try {
        const raw = await fetchSampleSolve();
        const parsed = parseSolve(raw);
        if (parsed) available.push(sampleRow(parsed));
      } catch {
        // Explorer will surface the problem; keep going.
      }
      try {
        const lib: LibraryItem[] = await fetchLibrary();
        if (!cancelled) setApiOnline(true);
        for (const item of lib) available.push(libraryRow(item, catalogBySpotId));
      } catch {
        if (!cancelled) {
          setApiOnline(false);
          setLibraryFailed(true);
        }
      }
      if (!cancelled) {
        setRows(available);
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setApiOnline]);

  const visible = useMemo(
    () => sortLibraryRows(applyLibraryFilters(rows, filters), filters.sort),
    [rows, filters],
  );

  const potTypes = useMemo(
    () => presentValues(rows.map((r) => r.catalog?.pot_type)),
    [rows],
  );
  const groups = useMemo(() => presentValues(rows.map((r) => r.catalog?.group)), [rows]);
  const tableSizes = useMemo(
    () => presentValues(rows.map((r) => r.catalog?.table_size)),
    [rows],
  );
  const counts = useMemo(() => {
    const by = (pred: (r: LibraryRow) => boolean) => rows.filter(pred).length;
    return {
      library: by((r) => r.source === 'library'),
      custom: by((r) => r.source === 'custom'),
      sample: by((r) => r.source === 'sample'),
      street: (s: Street) => by((r) => r.street === s),
      family: (f: TextureFamily) => by((r) => r.families.includes(f)),
      source: (s: LibraryRowSource) => by((r) => r.source === s),
    };
  }, [rows]);

  const active = activeFilterCount(filters);
  const set = <K extends keyof LibraryFilters>(key: K, value: LibraryFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const open = async (row: LibraryRow) => {
    if (row.source === 'sample') {
      await loadSample();
      navigate('/explorer');
      return;
    }
    if (!row.libraryId) return;
    try {
      const raw = await fetchLibrarySolve(row.libraryId);
      if (loadRawSolve(raw, row.name, 'library', row.libraryId)) navigate('/explorer');
      else setError(`"${row.name}" could not be parsed by the UI.`);
    } catch {
      setError('Could not fetch that solve from the job service.');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-bold text-ink">Explore</h1>
        <p className="text-sm text-ink-dim">
          Every solve here is a full tree — walk any line, any runout, no re-solving. The
          pre-run library and your own finished custom solves live in one list; the Source
          filter tells them apart.
        </p>
        {loaded ? (
          <p className="mt-1 text-xs text-ink-faint">
            {rows.length} {rows.length === 1 ? 'solve' : 'solves'} available
            {counts.library > 0 ? ` · ${counts.library} from the pre-run library` : ''}
            {counts.custom > 0 ? ` · ${counts.custom} custom` : ''}
            {counts.sample > 0 ? ` · ${counts.sample} bundled sample` : ''}
            {libraryFailed ? ' · job service offline — library solves unavailable' : ''}
          </p>
        ) : null}
      </header>

      {error ? (
        <p className="rounded-lg border border-red-900 bg-navy-900 p-3 text-sm text-red-300" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-4 lg:flex-row">
        <aside
          aria-label="Library filters"
          className="w-full shrink-0 rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel lg:w-72"
        >
          <div className="flex flex-col gap-4">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold text-ink">Filters</h2>
              <span className="text-xs text-ink-faint">
                {visible.length} of {rows.length} shown
              </span>
            </div>

            <RailSection title="Search">
              <input
                type="search"
                value={filters.search}
                onChange={(e) => set('search', e.target.value)}
                placeholder="Name, board, matchup…"
                className={selectClass}
              />
            </RailSection>

            <RailSection title="Sort by">
              <select
                value={filters.sort}
                onChange={(e) => set('sort', e.target.value as LibraryFilters['sort'])}
                className={selectClass}
              >
                <option value="newest">Newest first</option>
                <option value="accuracy">Best accuracy (lowest Nash)</option>
                <option value="name">Name</option>
              </select>
            </RailSection>

            <RailSection title="Street">
              <Chips
                value={filters.street}
                onChange={(v) => set('street', v)}
                options={[
                  { value: 'all' as const, label: 'All', count: rows.length },
                  ...STREETS.map((s) => ({
                    value: s as 'all' | Street,
                    label: s.charAt(0).toUpperCase() + s.slice(1),
                    count: counts.street(s),
                  })),
                ]}
              />
            </RailSection>

            <RailSection title="Board texture">
              <Chips
                value={filters.family}
                onChange={(v) => set('family', v)}
                options={[
                  { value: 'all' as const, label: 'All' },
                  ...FAMILIES.map((f) => ({
                    value: f as 'all' | TextureFamily,
                    label: FAMILY_LABEL[f],
                    count: counts.family(f),
                  })),
                ]}
              />
            </RailSection>

            <RailSection title="Source">
              <Chips
                value={filters.source}
                onChange={(v) => set('source', v)}
                options={[
                  { value: 'all' as const, label: 'All' },
                  ...SOURCES.map((s) => ({
                    value: s as 'all' | LibraryRowSource,
                    label: SOURCE_LABEL[s],
                    count: counts.source(s),
                  })),
                ]}
              />
            </RailSection>

            {potTypes.length > 0 ? (
              <RailSection title="Pot type">
                <select
                  value={filters.potType}
                  onChange={(e) => set('potType', e.target.value)}
                  className={selectClass}
                >
                  <option value="all">All pot types</option>
                  {potTypes.map((p) => (
                    <option key={p} value={p}>
                      {potTypeLabel(p)}
                    </option>
                  ))}
                </select>
              </RailSection>
            ) : null}

            {groups.length > 0 ? (
              <RailSection title="Setup">
                <select
                  value={filters.group}
                  onChange={(e) => set('group', e.target.value)}
                  className={selectClass}
                >
                  <option value="all">All setups</option>
                  {groups.map((g) => (
                    <option key={g} value={g}>
                      {g}
                    </option>
                  ))}
                </select>
              </RailSection>
            ) : null}

            {tableSizes.length > 1 ? (
              <RailSection title="Table size">
                <select
                  value={filters.tableSize}
                  onChange={(e) => set('tableSize', e.target.value)}
                  className={selectClass}
                >
                  <option value="all">All table sizes</option>
                  {tableSizes.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </RailSection>
            ) : null}

            <RailSection title="Stack depth">
              <select
                value={filters.sprBand}
                onChange={(e) => set('sprBand', e.target.value as LibraryFilters['sprBand'])}
                className={selectClass}
              >
                <option value="all">Any depth</option>
                {(Object.keys(SPR_BAND_LABEL) as SprBand[]).map((b) => (
                  <option key={b} value={b}>
                    {SPR_BAND_LABEL[b]}
                  </option>
                ))}
              </select>
            </RailSection>

            <RailSection title="Accuracy">
              <select
                value={filters.accuracy}
                onChange={(e) => set('accuracy', e.target.value as LibraryFilters['accuracy'])}
                className={selectClass}
              >
                <option value="all">Any accuracy</option>
                {(Object.keys(ACCURACY_BAND_LABEL) as AccuracyBand[]).map((b) => (
                  <option key={b} value={b}>
                    {ACCURACY_BAND_LABEL[b]}
                  </option>
                ))}
              </select>
            </RailSection>

            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink-dim">
              <input
                type="checkbox"
                checked={filters.lockedOnly}
                onChange={(e) => set('lockedOnly', e.target.checked)}
                className="h-4 w-4"
              />
              Nodelocked solves only
            </label>

            {active > 0 ? (
              <button
                type="button"
                onClick={() => setFilters(DEFAULT_LIBRARY_FILTERS)}
                className="rounded-md border border-navy-600 px-3 py-2 text-sm text-ink hover:bg-navy-800"
              >
                Clear all filters ({active} active)
              </button>
            ) : null}
          </div>
        </aside>

        <section aria-label="Solves" className="min-w-0 flex-1">
          {!loaded ? (
            <p className="text-sm text-ink-faint">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="rounded-lg border border-navy-700 bg-navy-900 p-4 text-sm text-ink-dim">
              No solves are available right now. The pre-run library is still being built —
              the Dashboard tracks coverage of the ~300 planned catalog spots.
            </p>
          ) : visible.length === 0 ? (
            <div className="rounded-lg border border-navy-700 bg-navy-900 p-4">
              <p className="text-sm text-ink-dim">No solves match these filters.</p>
              <button
                type="button"
                onClick={() => setFilters(DEFAULT_LIBRARY_FILTERS)}
                className="mt-2 text-sm text-table-light underline"
              >
                Clear all filters
              </button>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {visible.map((row) => {
                const boardCards = parseCardList(row.board);
                return (
                  <li key={row.key}>
                    <button
                      type="button"
                      onClick={() => void open(row)}
                      className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-navy-850 px-3 py-2 text-left hover:bg-navy-800"
                    >
                      {boardCards ? (
                        <CardRow cards={boardCards} size="sm" />
                      ) : (
                        <span className="font-mono text-sm text-ink">{row.board}</span>
                      )}
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-ink">
                          {row.name}
                        </span>
                        <span className="block text-xs text-ink-dim">
                          {rowSubline(row)}
                        </span>
                      </span>
                      <span className="rounded-full border border-navy-600 px-2 py-0.5 text-[11px] uppercase tracking-wide text-ink-dim">
                        {SOURCE_LABEL[row.source]}
                      </span>
                      {row.locked ? (
                        <span
                          className="rounded-full border border-accent px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent"
                          title="This solve was nodelocked — its strategy is priced as played, not an equilibrium."
                        >
                          Locked
                        </span>
                      ) : null}
                      <span className="ml-auto">
                        {row.locked ? (
                          row.nashPct !== null ? (
                            <span className="text-xs text-ink-dim">
                              Nash {row.nashPct.toFixed(3)}% pot
                            </span>
                          ) : null
                        ) : row.nashPct !== null ? (
                          <AccuracyBadge nashPct={row.nashPct} />
                        ) : (
                          <span className="text-xs text-ink-faint">No Nash measurement</span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {loaded && rows.length > 0 && counts.library === 0 && !libraryFailed ? (
            <p className="mt-3 text-xs text-ink-faint">
              The pre-run library (~300 catalog spots across SRP, 3-bet and blind-battle
              configurations) is still being built — the Dashboard tracks its coverage.{' '}
              <Link to="/solver" className="text-table-light underline">
                Solve a spot yourself
              </Link>{' '}
              and it will appear here as a custom solve.
            </p>
          ) : null}
        </section>
      </div>

      <p className="text-xs text-ink-faint">
        Pot type, setup and table-size filters read from the spot catalog entry a solve was
        produced for, so they cover library solves; custom solves carry no catalog setup and
        match only when those filters are off. Stack depth and accuracy read from each
        solve's own stored numbers.
      </p>
    </div>
  );
}
