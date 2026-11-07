import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AccuracyBadge } from '../components/AccuracyBadge';
import { fetchJobs, fetchJobResult, fetchLibrary, fetchLibrarySolve, fetchSampleSolve } from '../lib/api';
import { parseSolve } from '../lib/solveTree';
import type { JobRecord, LibraryItem } from '../lib/types';
import { useStore } from '../store/useStore';

export function DashboardPage() {
  const navigate = useNavigate();
  const setApiOnline = useStore((s) => s.setApiOnline);
  const loadRawSolve = useStore((s) => s.loadRawSolve);
  const user = useStore((s) => s.user);

  const [library, setLibrary] = useState<LibraryItem[] | null>(null);
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [offline, setOffline] = useState(false);
  const [sampleCard, setSampleCard] = useState<{ board: string; nash: number } | null>(null);
  // The bundled sample has its own lifecycle: it is only fetched after the
  // API probe fails, so without an explicit state the Library slot used to
  // flash "Sample unavailable" for the whole fetch window (and forever,
  // silently, if the fetch failed) even though the same file loads fine in
  // the Explorer. Track loading/ready/error honestly instead.
  const [sampleState, setSampleState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [lib, jobList] = await Promise.all([fetchLibrary(), fetchJobs()]);
        if (cancelled) return;
        setLibrary(lib);
        setJobs(jobList);
        setApiOnline(true);
      } catch {
        if (cancelled) return;
        setOffline(true);
        setApiOnline(false);
        // Fixture fallback: describe the bundled sample from its real JSON.
        setSampleState('loading');
        try {
          const raw = await fetchSampleSolve();
          const parsed = parseSolve(raw);
          if (cancelled) return;
          if (parsed) {
            setSampleCard({
              board: parsed.raw.board,
              nash: parsed.raw.exploitability.nash_distance_pct,
            });
            setSampleState('ready');
          } else {
            setSampleError('the bundled sample file did not parse as a solve');
            setSampleState('error');
          }
        } catch (err) {
          if (cancelled) return;
          setSampleError(err instanceof Error ? err.message : 'sample fetch failed');
          setSampleState('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setApiOnline]);

  const openRaw = (raw: unknown, name: string, source: 'library' | 'job') => {
    if (loadRawSolve(raw, name, source)) {
      navigate('/explorer');
    } else {
      setOpenError(`"${name}" could not be parsed by the UI.`);
    }
  };

  const openLibraryItem = async (item: LibraryItem) => {
    try {
      const raw = await fetchLibrarySolve(item.id);
      openRaw(raw, item.name, 'library');
    } catch {
      setOpenError('Could not fetch that solve from the job service.');
    }
  };

  const openJob = async (job: JobRecord) => {
    try {
      const raw = await fetchJobResult(job.id);
      openRaw(raw, `Custom solve · ${job.board}`, 'job');
    } catch {
      setOpenError('Could not fetch that job result.');
    }
  };

  const riverCount = library?.filter((i) => i.kind === 'river').length ?? 0;
  const turnCount = library?.filter((i) => i.kind === 'turn').length ?? 0;
  const flopCount = library?.filter((i) => i.kind === 'flop').length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-bold text-ink">
          {user ? `Welcome back, ${user}` : 'Dashboard'}
        </h1>
        <p className="text-sm text-ink-dim">
          Your solved library, coverage, and solve jobs at a glance.
        </p>
      </header>

      {offline ? (
        <div className="rounded-lg border border-accent/60 bg-navy-900 p-3 text-sm" role="status">
          <span className="font-semibold text-ink">Engine offline.</span>{' '}
          <span className="text-ink-dim">
            The job service isn't reachable, so the library below is just the bundled sample.
            Everything in the Explorer still works.
          </span>
        </div>
      ) : null}
      {openError ? (
        <p className="rounded-lg border border-red-900 bg-navy-900 p-3 text-sm text-red-300" role="alert">
          {openError}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <section
          aria-label="Coverage"
          className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel"
        >
          <h2 className="text-sm font-semibold text-ink">Coverage</h2>
          {offline ? (
            <p className="mt-2 text-sm text-ink-dim">
              1 bundled sample solve. Connect the job service to see your full library.
            </p>
          ) : library === null ? (
            <p className="mt-2 text-sm text-ink-dim">Loading…</p>
          ) : (
            <dl className="mt-2 flex flex-col gap-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-dim">Total solves</dt>
                <dd className="font-mono text-ink">{library.length}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-dim">River solves</dt>
                <dd className="font-mono text-ink">{riverCount}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-dim">Turn solves</dt>
                <dd className="font-mono text-ink">{turnCount}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-dim">Flop solves</dt>
                <dd className="font-mono text-ink">{flopCount}</dd>
              </div>
              <p className="mt-1 text-xs text-ink-faint">
                Flop solves run through the Solver wizard and land here when done — the library
                build-out target is ~300 solves.
              </p>
            </dl>
          )}
          <Link
            to="/explore"
            className="mt-3 inline-block rounded-md bg-table px-3 py-2 text-sm font-semibold text-white hover:bg-table-dark"
          >
            Browse spots
          </Link>
        </section>

        <section
          aria-label="Library"
          className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel lg:col-span-2"
        >
          <h2 className="text-sm font-semibold text-ink">Library</h2>
          {offline ? (
            sampleState === 'ready' && sampleCard ? (
              <button
                type="button"
                onClick={() => navigate('/explorer')}
                className="mt-2 flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-navy-850 px-3 py-2 text-left hover:bg-navy-800"
              >
                <span className="font-mono text-sm text-ink">{sampleCard.board}</span>
                <span className="text-xs text-ink-dim">River · bundled sample</span>
                <span className="ml-auto">
                  <AccuracyBadge nashPct={sampleCard.nash} />
                </span>
              </button>
            ) : sampleState === 'error' ? (
              <p className="mt-2 text-sm text-ink-dim">
                The bundled sample could not be loaded
                {sampleError ? ` (${sampleError})` : ''}. The Explorer loads it on demand and
                will report there if it fails too.
              </p>
            ) : (
              <p className="mt-2 text-sm text-ink-dim">Loading the bundled sample…</p>
            )
          ) : library === null ? (
            <p className="mt-2 text-sm text-ink-dim">Loading…</p>
          ) : library.length === 0 ? (
            <p className="mt-2 text-sm text-ink-dim">
              No finished solves yet.{' '}
              <Link to="/solver" className="text-table-light underline">
                Run your first solve
              </Link>{' '}
              and it will appear here.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {library.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => void openLibraryItem(item)}
                    className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-navy-850 px-3 py-2 text-left hover:bg-navy-800"
                  >
                    <span className="font-mono text-sm text-ink">{item.board}</span>
                    <span className="text-xs capitalize text-ink-dim">{item.kind}</span>
                    <span className="ml-auto">
                      <AccuracyBadge nashPct={item.nash_distance_pct} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section
        aria-label="Jobs"
        className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel"
      >
        <h2 className="text-sm font-semibold text-ink">Solve jobs</h2>
        {offline ? (
          <p className="mt-2 text-sm text-ink-dim">Job service offline — no job data.</p>
        ) : jobs.length === 0 ? (
          <p className="mt-2 text-sm text-ink-dim">
            No jobs yet this service run. Submit a spot in the{' '}
            <Link to="/solver" className="text-table-light underline">
              Solver
            </Link>
            .
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {jobs.map((job) => (
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
                </span>
                {job.nash_distance_pct !== null ? (
                  <span className="font-mono text-xs text-ink-dim">
                    Nash {job.nash_distance_pct.toFixed(3)}% pot
                  </span>
                ) : null}
                {job.status === 'done' ? (
                  <button
                    type="button"
                    onClick={() => void openJob(job)}
                    className="ml-auto rounded-md bg-table px-2.5 py-1 text-xs font-semibold text-white hover:bg-table-dark"
                  >
                    Open in Explorer
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
