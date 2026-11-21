// Library (Spot Picker) data layer: unifies the solves the picker lists
// into one row shape the filter rail and the list render.
//
// Sources, and what each actually carries:
//  - Catalog solves and custom solves both arrive via GET /api/library
//    (finished jobs publish into the library; runner-ingested catalog
//    solves land there too). A row is "library" when its item carries a
//    spot_id that resolves in GET /api/catalog, "custom" when it does
//    not — the catalog entry is also the ONLY source of pot type,
//    matchup/positions, group and table size, so those filters simply
//    do not match custom rows (unknown is not a value).
//  - The bundled sample is parsed locally; its geometry and lock state
//    come from its own payload.
// Geometry (starting pot / effective stack / SPR) comes from the list
// payload itself — listLibrary reads both off the stored solve — never
// from the catalog, so custom solves show real geometry too.
//
// Honesty rules baked in here:
//  - A set filter never matches a row that lacks the field.
//  - Accuracy bands are the Phase-0 bars applied to the MEASURED Nash
//    distance: ≤0.1% pot is the strict bar, ≤0.3% pot the general bar;
//    above that the solve missed the bar it was aimed at (the badge on
//    the row still shows the measured number, never a tier claim).
//  - Locked rows are badged LOCKED and are filterable, never re-labelled.

import type { CatalogEntry } from './runner';
import { sampledInfo, type SampledInfo } from './sampled';
import type { SolveData } from './solveTree';
import { boardFamilies, type TextureFamily } from './texture';
import type { LibraryItem, RangeExpansion } from './types';

export type LibraryRowSource = 'library' | 'custom' | 'sample';
export type Street = 'flop' | 'turn' | 'river';

export interface LibraryRow {
  key: string;
  name: string;
  board: string;
  street: Street;
  source: LibraryRowSource;
  /** Library id for 'library'/'custom' rows; undefined for the sample. */
  libraryId?: string;
  /** Measured Nash distance (% of pot); null when the list lacks it. */
  nashPct: number | null;
  finishedAt: string | null;
  startingPot: number | null;
  effectiveStack: number | null;
  locked: boolean;
  /** Stored range-trimming record; null when the solve was uncapped. */
  rangeExpansion: RangeExpansion | null;
  /** Non-null when the row badges SAMPLED (see lib/sampled.ts). */
  sampled: SampledInfo | null;
  families: TextureFamily[];
  /** Catalog join (by spot_id); null for custom solves and the sample. */
  catalog: CatalogEntry | null;
}

export function sprOf(row: Pick<LibraryRow, 'startingPot' | 'effectiveStack'>): number | null {
  if (row.startingPot === null || row.effectiveStack === null || row.startingPot <= 0) {
    return null;
  }
  return row.effectiveStack / row.startingPot;
}

// ---------- accuracy bands (Phase-0 bars over the measured Nash) ----------

export type AccuracyBand = 'precise' | 'standard' | 'below-bar';

export const ACCURACY_BAND_LABEL: Record<AccuracyBand, string> = {
  precise: 'Nash ≤ 0.1% pot',
  standard: 'Nash 0.1–0.3% pot',
  'below-bar': 'Nash > 0.3% pot',
};

export function accuracyBandOf(nashPct: number | null): AccuracyBand | null {
  if (nashPct === null || !Number.isFinite(nashPct)) return null;
  if (nashPct <= 0.1) return 'precise';
  if (nashPct <= 0.3) return 'standard';
  return 'below-bar';
}

// ---------- SPR bands ----------

export type SprBand = 'shallow' | 'medium' | 'deep';

export const SPR_BAND_LABEL: Record<SprBand, string> = {
  shallow: 'SPR ≤ 2',
  medium: 'SPR 2–5',
  deep: 'SPR > 5',
};

export function sprBandOf(spr: number | null): SprBand | null {
  if (spr === null || !Number.isFinite(spr)) return null;
  if (spr <= 2) return 'shallow';
  if (spr <= 5) return 'medium';
  return 'deep';
}

// ---------- pot type ----------

/** Catalog pot_type values are 'srp' / '3bet'; label them as poker terms. */
export function potTypeLabel(potType: string): string {
  if (potType === 'srp') return 'SRP';
  if (potType === '3bet') return '3-bet pot';
  return potType;
}

// ---------- row construction ----------

export function libraryRow(
  item: LibraryItem,
  catalogBySpotId: Map<string, CatalogEntry>,
): LibraryRow {
  const catalog = item.spot_id ? (catalogBySpotId.get(item.spot_id) ?? null) : null;
  return {
    key: `lib-${item.id}`,
    name: item.name,
    board: item.board,
    street: item.kind,
    source: catalog ? 'library' : 'custom',
    libraryId: item.id,
    nashPct: typeof item.nash_distance_pct === 'number' ? item.nash_distance_pct : null,
    finishedAt: item.finished_at ?? null,
    startingPot: item.starting_pot ?? null,
    effectiveStack: item.effective_stack ?? null,
    locked: item.locked === true,
    rangeExpansion: item.range_expansion ?? null,
    sampled: sampledInfo(item.range_expansion),
    families: boardFamilies(item.board),
    catalog,
  };
}

export function sampleRow(parsed: SolveData): LibraryRow {
  const raw = parsed.raw as unknown as Record<string, unknown>;
  return {
    key: 'sample',
    name: 'Bundled sample river solve',
    board: parsed.raw.board,
    street: parsed.kind,
    source: 'sample',
    nashPct: parsed.raw.exploitability.nash_distance_pct,
    finishedAt: null,
    startingPot: parsed.raw.starting_pot,
    effectiveStack: parsed.raw.effective_stack,
    locked: raw.locked === true,
    rangeExpansion: null,
    sampled: null,
    families: boardFamilies(parsed.raw.board),
    catalog: null,
  };
}

// ---------- filters ----------

export type LibrarySort = 'newest' | 'accuracy' | 'name';

export interface LibraryFilters {
  search: string;
  street: 'all' | Street;
  family: 'all' | TextureFamily;
  /** Catalog pot_type ('srp', '3bet', ...); matches joined rows only. */
  potType: 'all' | string;
  /** Catalog group (e.g. 'SRP BTN vs BB'); matches joined rows only. */
  group: 'all' | string;
  /** Catalog table_size ('6max', '9max'); matches joined rows only. */
  tableSize: 'all' | string;
  sprBand: 'all' | SprBand;
  accuracy: 'all' | AccuracyBand;
  source: 'all' | LibraryRowSource;
  lockedOnly: boolean;
  sort: LibrarySort;
}

export const DEFAULT_LIBRARY_FILTERS: LibraryFilters = {
  search: '',
  street: 'all',
  family: 'all',
  potType: 'all',
  group: 'all',
  tableSize: 'all',
  sprBand: 'all',
  accuracy: 'all',
  source: 'all',
  lockedOnly: false,
  sort: 'newest',
};

/** How many filters differ from the default (sort not counted). */
export function activeFilterCount(f: LibraryFilters): number {
  let n = 0;
  if (f.search.trim() !== '') n += 1;
  if (f.street !== 'all') n += 1;
  if (f.family !== 'all') n += 1;
  if (f.potType !== 'all') n += 1;
  if (f.group !== 'all') n += 1;
  if (f.tableSize !== 'all') n += 1;
  if (f.sprBand !== 'all') n += 1;
  if (f.accuracy !== 'all') n += 1;
  if (f.source !== 'all') n += 1;
  if (f.lockedOnly) n += 1;
  return n;
}

function searchHaystack(row: LibraryRow): string {
  const parts = [row.name, row.board, row.street, row.source];
  if (row.catalog) {
    parts.push(
      row.catalog.group,
      row.catalog.matchup,
      row.catalog.oop_position,
      row.catalog.ip_position,
      row.catalog.table_size,
      potTypeLabel(row.catalog.pot_type),
    );
  }
  return parts.join(' ').toLowerCase();
}

export function applyLibraryFilters(rows: LibraryRow[], f: LibraryFilters): LibraryRow[] {
  const q = f.search.trim().toLowerCase();
  return rows.filter((row) => {
    if (q !== '' && !searchHaystack(row).includes(q)) return false;
    if (f.street !== 'all' && row.street !== f.street) return false;
    if (f.family !== 'all' && !row.families.includes(f.family)) return false;
    if (f.potType !== 'all' && row.catalog?.pot_type !== f.potType) return false;
    if (f.group !== 'all' && row.catalog?.group !== f.group) return false;
    if (f.tableSize !== 'all' && row.catalog?.table_size !== f.tableSize) return false;
    if (f.sprBand !== 'all' && sprBandOf(sprOf(row)) !== f.sprBand) return false;
    if (f.accuracy !== 'all' && accuracyBandOf(row.nashPct) !== f.accuracy) return false;
    if (f.source !== 'all' && row.source !== f.source) return false;
    if (f.lockedOnly && !row.locked) return false;
    return true;
  });
}

export function sortLibraryRows(rows: LibraryRow[], sort: LibrarySort): LibraryRow[] {
  const out = [...rows];
  if (sort === 'name') {
    out.sort((a, b) => a.name.localeCompare(b.name) || a.board.localeCompare(b.board));
  } else if (sort === 'accuracy') {
    out.sort((a, b) => {
      if (a.nashPct === null && b.nashPct === null) return a.name.localeCompare(b.name);
      if (a.nashPct === null) return 1;
      if (b.nashPct === null) return -1;
      return a.nashPct - b.nashPct || a.name.localeCompare(b.name);
    });
  } else {
    // 'newest': finished_at descending, undated rows (the sample) last.
    out.sort((a, b) => {
      if (a.finishedAt === null && b.finishedAt === null) return a.name.localeCompare(b.name);
      if (a.finishedAt === null) return 1;
      if (b.finishedAt === null) return -1;
      return b.finishedAt.localeCompare(a.finishedAt) || a.name.localeCompare(b.name);
    });
  }
  return out;
}

/** Distinct values present in the rows, for building filter options. */
export function presentValues<T extends string>(values: (T | null | undefined)[]): T[] {
  const seen = new Set<T>();
  for (const v of values) if (v) seen.add(v);
  return [...seen].sort((a, b) => a.localeCompare(b));
}
