import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AccuracyBadge } from '../components/AccuracyBadge';
import { fetchLibrary, fetchLibrarySolve, fetchSampleSolve } from '../lib/api';
import { parseSolve } from '../lib/solveTree';
import { boardFamilies, FAMILY_BLURB, FAMILY_LABEL, type TextureFamily } from '../lib/texture';
import type { LibraryItem } from '../lib/types';
import { useStore } from '../store/useStore';

interface AvailableSolve {
  key: string;
  board: string;
  kind: string;
  nash: number;
  source: 'sample' | 'library';
  libraryId?: string;
  name: string;
}

const FAMILIES: TextureFamily[] = ['flush-heavy', 'paired', 'connected', 'dry'];

export function SpotPickerPage() {
  const navigate = useNavigate();
  const loadRawSolve = useStore((s) => s.loadRawSolve);
  const loadSample = useStore((s) => s.loadSample);
  const setApiOnline = useStore((s) => s.setApiOnline);

  const [solves, setSolves] = useState<AvailableSolve[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const available: AvailableSolve[] = [];
      // The bundled sample is always available.
      try {
        const raw = await fetchSampleSolve();
        const parsed = parseSolve(raw);
        if (parsed) {
          available.push({
            key: 'sample',
            board: parsed.raw.board,
            kind: 'river',
            nash: parsed.raw.exploitability.nash_distance_pct,
            source: 'sample',
            name: 'Bundled sample river solve',
          });
        }
      } catch {
        // Explorer will surface the problem; keep going.
      }
      try {
        const lib: LibraryItem[] = await fetchLibrary();
        if (!cancelled) setApiOnline(true);
        for (const item of lib) {
          available.push({
            key: `lib-${item.id}`,
            board: item.board,
            kind: item.kind,
            nash: item.nash_distance_pct,
            source: 'library',
            libraryId: item.id,
            name: item.name,
          });
        }
      } catch {
        if (!cancelled) setApiOnline(false);
      }
      if (!cancelled) {
        setSolves(available);
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setApiOnline]);

  const byFamily = useMemo(() => {
    const map = new Map<TextureFamily, AvailableSolve[]>();
    for (const s of solves) {
      for (const fam of boardFamilies(s.board)) {
        const list = map.get(fam) ?? [];
        list.push(s);
        map.set(fam, list);
      }
    }
    return map;
  }, [solves]);

  const open = async (s: AvailableSolve) => {
    if (s.source === 'sample') {
      await loadSample();
      navigate('/explorer');
      return;
    }
    if (!s.libraryId) return;
    try {
      const raw = await fetchLibrarySolve(s.libraryId);
      if (loadRawSolve(raw, s.name, 'library')) navigate('/explorer');
      else setError(`"${s.name}" could not be parsed by the UI.`);
    } catch {
      setError('Could not fetch that solve from the job service.');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-bold text-ink">Explore</h1>
        <p className="text-sm text-ink-dim">
          Pick a spot by board texture. Every solve here is a full tree — walk any line, any runout,
          no re-solving.
        </p>
      </header>

      {error ? (
        <p className="rounded-lg border border-red-900 bg-navy-900 p-3 text-sm text-red-300" role="alert">
          {error}
        </p>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {FAMILIES.map((fam) => {
          const list = byFamily.get(fam) ?? [];
          return (
            <section
              key={fam}
              aria-label={FAMILY_LABEL[fam]}
              className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel"
            >
              <h2 className="text-sm font-semibold text-ink">{FAMILY_LABEL[fam]}</h2>
              <p className="mt-1 text-xs text-ink-dim">{FAMILY_BLURB[fam]}</p>
              {!loaded ? (
                <p className="mt-3 text-sm text-ink-faint">Loading…</p>
              ) : list.length === 0 ? (
                <p className="mt-3 text-sm text-ink-faint">
                  No solves in this family yet.{' '}
                  <Link to="/solver" className="text-table-light underline">
                    Solve one
                  </Link>{' '}
                  or wait for the library build-out.
                </p>
              ) : (
                <ul className="mt-3 flex flex-col gap-2">
                  {list.map((s) => (
                    <li key={s.key}>
                      <button
                        type="button"
                        onClick={() => void open(s)}
                        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-navy-850 px-3 py-2 text-left hover:bg-navy-800"
                      >
                        <span className="font-mono text-sm text-ink">{s.board}</span>
                        <span className="text-xs capitalize text-ink-dim">
                          {s.kind}
                          {s.source === 'sample' ? ' · sample' : ''}
                        </span>
                        <span className="ml-auto">
                          <AccuracyBadge nashPct={s.nash} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      <p className="text-xs text-ink-faint">
        Texture families are computed from each solve's board. The full pre-run library (~300
        solves across SRP, 3-bet and blind-battle configurations) arrives in Phase 3.
      </p>
    </div>
  );
}
