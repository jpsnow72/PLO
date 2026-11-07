import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ApiError,
  enqueueSpots,
  fetchAuthMe,
  fetchCatalog,
  fetchQueue,
  fetchRunnerStatus,
  queueControl,
} from '../lib/api';
import {
  formatCoverage,
  formatDuration,
  formatElapsed,
  formatEstHours,
  spotDisplayStatus,
  SPOT_STATUS_LABEL,
  type CatalogEntry,
  type QueueItem,
  type QueueResponse,
  type RunnerStatus,
  type SpotDisplayStatus,
} from '../lib/runner';
import { useStore } from '../store/useStore';

const POLL_MS = 2000;

function SpotStatusChip({ status }: { status: SpotDisplayStatus }) {
  const styles: Record<SpotDisplayStatus, string> = {
    'in-library': 'bg-table text-white',
    running: 'border border-accent font-semibold text-accent',
    queued: 'bg-navy-700 text-ink',
    done: 'border border-table text-table-light',
    failed: 'border border-accent text-accent',
    'not-queued': 'text-ink-faint',
  };
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs ${styles[status]}`}
    >
      {status === 'failed' ? '⚠ ' : ''}
      {SPOT_STATUS_LABEL[status]}
    </span>
  );
}

function UploadChip({ item }: { item: QueueItem }) {
  if (item.state !== 'done') return null;
  if (item.upload_status === 'uploaded') {
    return (
      <span className="inline-flex items-center whitespace-nowrap rounded-full bg-table px-2 py-0.5 text-xs font-semibold text-white">
        Uploaded{item.upload_detail ? ` · ${item.upload_detail}` : ''}
      </span>
    );
  }
  if (item.upload_status === 'pending') {
    return (
      <span className="inline-flex items-center whitespace-nowrap rounded-full bg-navy-700 px-2 py-0.5 text-xs text-ink">
        Upload pending
      </span>
    );
  }
  if (item.upload_status === 'skipped') {
    return (
      <span
        className="inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs text-ink-dim"
        title="No central library is configured on this runner, so the finished solve stays in the local library only."
      >
        Upload skipped (offline)
      </span>
    );
  }
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-full border border-accent px-2 py-0.5 text-xs font-semibold text-accent">
      ⚠ Upload failed
    </span>
  );
}

/**
 * Admin → Solve runner: browse the 300-spot catalog, enqueue spots, and
 * watch the local queue solve them. All state comes from the job service
 * (RUN-1 endpoints); the page polls the queue every 2 s while open.
 * A running solve shows elapsed time only — the service reports Nash and
 * iterations when a solve finishes, and this page invents nothing before
 * then (no fake progress bars).
 */
export function RunnerPage() {
  const isAdmin = useStore((s) => s.isAdmin);
  const authEnabled = useStore((s) => s.authEnabled);
  const setAdmin = useStore((s) => s.setAdmin);

  const [entries, setEntries] = useState<CatalogEntry[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueResponse | null>(null);
  const [runnerStatus, setRunnerStatus] = useState<RunnerStatus | null>(null);
  const [pollFailed, setPollFailed] = useState(false);

  const [groupFilter, setGroupFilter] = useState('all');
  const [tableFilter, setTableFilter] = useState('all');
  const [streetFilter, setStreetFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Session probe on arrival (same pattern as the Admin page).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const state = await fetchAuthMe();
        if (!cancelled) setAdmin(state.admin, state.authEnabled);
      } catch {
        if (!cancelled) setAdmin(false, null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setAdmin]);

  const loadCatalog = useCallback(async () => {
    try {
      const catalog = await fetchCatalog();
      setEntries(catalog.entries);
      setCatalogError(null);
    } catch (err) {
      setCatalogError(
        err instanceof ApiError && err.status !== 0
          ? err.message
          : 'Could not reach the job service for the spot catalog.',
      );
    }
  }, []);

  const pollQueue = useCallback(async () => {
    try {
      const [q, status] = await Promise.all([fetchQueue(), fetchRunnerStatus()]);
      setQueue(q);
      setRunnerStatus(status);
      setPollFailed(false);
    } catch {
      setPollFailed(true);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    void loadCatalog();
    void pollQueue();
    const timer = setInterval(() => void pollQueue(), POLL_MS);
    return () => clearInterval(timer);
  }, [isAdmin, loadCatalog, pollQueue]);

  // 1 s clock so running-solve elapsed times tick between polls.
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const groups = useMemo(
    () => [...new Set((entries ?? []).map((e) => e.group))].sort(),
    [entries],
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (entries ?? []).filter((e) => {
      if (groupFilter !== 'all' && e.group !== groupFilter) return false;
      if (tableFilter !== 'all' && e.table_size !== tableFilter) return false;
      if (streetFilter !== 'all' && e.street !== streetFilter) return false;
      if (statusFilter !== 'all' && spotDisplayStatus(e) !== statusFilter) return false;
      if (needle) {
        const hay = `${e.id} ${e.matchup} ${e.board} ${e.board_family}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [entries, groupFilter, tableFilter, streetFilter, statusFilter, search]);

  const counts = useMemo(() => {
    const c: Record<SpotDisplayStatus, number> = {
      'in-library': 0,
      queued: 0,
      running: 0,
      done: 0,
      failed: 0,
      'not-queued': 0,
    };
    for (const e of entries ?? []) c[spotDisplayStatus(e)] += 1;
    return c;
  }, [entries]);

  const handleActionError = useCallback((err: unknown, fallback: string) => {
    if (err instanceof ApiError && err.status === 401) {
      setNeedsLogin(true);
      setActionError(null);
    } else if (err instanceof ApiError && err.status !== 0) {
      setActionError(err.message);
    } else {
      setActionError(fallback);
    }
  }, []);

  const runControl = useCallback(
    async (action: Parameters<typeof queueControl>[0], failMessage: string) => {
      setBusy(true);
      try {
        const next = await queueControl(action);
        setQueue(next);
        setNeedsLogin(false);
        setActionError(null);
        return true;
      } catch (err) {
        handleActionError(err, failMessage);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [handleActionError],
  );

  const onAddSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBusy(true);
    try {
      const result = await enqueueSpots(ids);
      setNeedsLogin(false);
      setActionError(null);
      const skippedText =
        result.skipped.length > 0
          ? ` Skipped ${result.skipped.length}: ${result.skipped
              .map((s) => `${s.spot_id} (${s.reason})`)
              .join('; ')}`
          : '';
      setNotice(`Added ${result.added.length} spot(s) to the queue.${skippedText}`);
      setSelected(new Set());
      await Promise.all([pollQueue(), loadCatalog()]);
    } catch (err) {
      handleActionError(err, 'Could not reach the job service to update the queue.');
    } finally {
      setBusy(false);
    }
  };

  const onRemoveItem = async (spotId: string) => {
    const ok = await runControl(
      { action: 'remove', spot_id: spotId },
      'Could not reach the job service to update the queue.',
    );
    if (ok) {
      setNotice(`Removed ${spotId} from the queue.`);
      void loadCatalog();
    }
  };

  const onClearFinished = async () => {
    const done = (queue?.items ?? []).filter((i) => i.state === 'done');
    if (done.length === 0) return;
    setBusy(true);
    let removed = 0;
    try {
      for (const item of done) {
        const next = await queueControl({ action: 'remove', spot_id: item.spot_id });
        setQueue(next);
        removed += 1;
      }
      setNeedsLogin(false);
      setActionError(null);
      setNotice(`Cleared ${removed} finished item(s) from the queue list.`);
      void loadCatalog();
    } catch (err) {
      handleActionError(err, 'Could not reach the job service to update the queue.');
    } finally {
      setBusy(false);
    }
  };

  const toggleSelected = (id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const selectAllFiltered = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const e of filtered) {
        if (e.status === 'ready') next.add(e.id);
      }
      return next;
    });
  };

  if (isAdmin === null) {
    return (
      <div className="flex flex-col gap-4">
        <header>
          <h1 className="text-xl font-bold text-ink">Solve runner</h1>
          <p className="text-sm text-ink-dim">Checking your session…</p>
        </header>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex flex-col gap-4">
        <header>
          <h1 className="text-xl font-bold text-ink">Solve runner</h1>
          <p className="text-sm text-ink-dim">Queueing solves is admin-only.</p>
        </header>
        <div className="rounded-lg border border-navy-700 bg-navy-900 p-4">
          <p className="text-sm text-ink-dim">
            You're not signed in as admin, so the runner is locked. Browsing the catalog and the
            library stays public — running solves on this machine needs the admin password.
          </p>
          <Link
            to="/login"
            state={{ from: '/admin/runner' }}
            className="mt-3 inline-block rounded-md bg-table px-3 py-2 text-sm font-semibold text-white hover:bg-table-dark"
          >
            Log in as admin
          </Link>{' '}
          <Link to="/admin" className="mt-3 inline-block px-3 py-2 text-sm text-ink-dim underline">
            Back to Admin
          </Link>
        </div>
      </div>
    );
  }

  const doneCount = (queue?.items ?? []).filter((i) => i.state === 'done').length;
  const runningCount = (queue?.items ?? []).filter((i) => i.state === 'running').length;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-bold text-ink">Solve runner</h1>
          <p className="text-sm text-ink-dim">
            Pick spots from the catalog; this machine solves them in order and uploads each
            finished solve to the central library.
          </p>
        </div>
        <Link to="/admin" className="text-sm text-ink-dim underline hover:text-ink">
          Back to Admin
        </Link>
      </header>

      {needsLogin ? (
        <div className="rounded-lg border border-accent/60 bg-navy-900 p-3 text-sm" role="alert">
          <span className="font-semibold text-ink">Queue changes are admin-only.</span>{' '}
          <span className="text-ink-dim">
            Your session is not an admin session right now — log in and try again.
          </span>{' '}
          <Link
            to="/login"
            state={{ from: '/admin/runner' }}
            className="font-semibold text-table-light underline"
          >
            Log in as admin
          </Link>
        </div>
      ) : null}

      {actionError ? (
        <div className="rounded-lg border border-accent/60 bg-navy-900 p-3 text-sm" role="alert">
          <span className="font-semibold text-ink">Queue update failed.</span>{' '}
          <span className="text-ink-dim">{actionError}</span>
        </div>
      ) : null}

      {notice ? (
        <div className="rounded-lg border border-table/60 bg-navy-900 p-3 text-sm" role="status">
          <span className="text-ink">{notice}</span>
        </div>
      ) : null}

      {/* ---------- Runner status strip ---------- */}
      <section
        aria-label="Runner status"
        className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel"
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span>
            <span className="text-ink-dim">Queue worker: </span>
            {runnerStatus ? (
              runnerStatus.queue_enabled ? (
                <span className="font-semibold text-table-light">Enabled</span>
              ) : (
                <span className="font-semibold text-accent">Disabled</span>
              )
            ) : (
              <span className="text-ink-dim">unknown</span>
            )}
          </span>
          <span>
            <span className="text-ink-dim">Concurrency: </span>
            <span className="font-mono text-ink">
              {runnerStatus?.concurrency ?? queue?.concurrency ?? '—'}
            </span>
          </span>
          <span>
            <span className="text-ink-dim">State: </span>
            <span className="text-ink">
              {(runnerStatus?.paused ?? queue?.paused) ? 'Paused' : 'Running'}
            </span>
          </span>
          <span>
            <span className="text-ink-dim">Uploads: </span>
            {runnerStatus ? (
              runnerStatus.upload_configured ? (
                <span className="text-ink">
                  Configured · {runnerStatus.central_url ?? 'central library'}
                </span>
              ) : (
                <span className="text-ink">
                  Not configured — finished solves stay in the local library
                </span>
              )
            ) : (
              <span className="text-ink-dim">unknown</span>
            )}
          </span>
          {pollFailed ? (
            <span className="font-semibold text-accent">
              ⚠ Connection to the job service lost — showing the last known state.
            </span>
          ) : null}
        </div>
        {runnerStatus && !runnerStatus.queue_enabled ? (
          <p className="mt-2 text-sm text-ink-dim" role="note">
            The queue worker is off on this server (it was started without QUEUE_ENABLED=1). Spots
            can be added to the list, but nothing will solve until the server is restarted with
            the queue enabled — the packaged start script does that for you.
          </p>
        ) : null}
        {authEnabled === false ? (
          <p className="mt-2 text-sm text-ink-dim" role="note">
            Server auth is DISABLED (no ADMIN_PASSWORD_HASH), so queue changes are open to anyone
            who can reach this port — local dev mode only.
          </p>
        ) : null}
      </section>

      {/* ---------- Queue panel ---------- */}
      <section
        aria-label="Solve queue"
        className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">
            Queue{' '}
            <span className="font-normal text-ink-dim">
              ({queue?.items.length ?? 0} item(s)
              {runningCount > 0 ? `, ${runningCount} solving` : ''})
            </span>
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 text-sm">
              <span className="text-ink-dim">At once:</span>
              <button
                type="button"
                disabled={busy || !queue || queue.concurrency <= 1}
                onClick={() =>
                  void runControl(
                    { action: 'set_concurrency', value: (queue?.concurrency ?? 1) - 1 },
                    'Could not reach the job service to change concurrency.',
                  )
                }
                className="rounded-md bg-navy-800 px-2 py-1 font-mono text-ink hover:bg-navy-700 disabled:opacity-40"
                aria-label="Decrease concurrency"
              >
                −
              </button>
              <span className="min-w-6 text-center font-mono text-ink">
                {queue?.concurrency ?? '—'}
              </span>
              <button
                type="button"
                disabled={busy || !queue || queue.concurrency >= 8}
                onClick={() =>
                  void runControl(
                    { action: 'set_concurrency', value: (queue?.concurrency ?? 1) + 1 },
                    'Could not reach the job service to change concurrency.',
                  )
                }
                className="rounded-md bg-navy-800 px-2 py-1 font-mono text-ink hover:bg-navy-700 disabled:opacity-40"
                aria-label="Increase concurrency"
              >
                +
              </button>
            </div>
            {queue?.paused ? (
              <button
                type="button"
                disabled={busy || !queue}
                onClick={() =>
                  void runControl({ action: 'resume' }, 'Could not reach the job service.')
                }
                className="rounded-md bg-table px-3 py-1.5 text-sm font-semibold text-white hover:bg-table-dark disabled:opacity-40"
              >
                Resume
              </button>
            ) : (
              <button
                type="button"
                disabled={busy || !queue}
                onClick={() =>
                  void runControl({ action: 'pause' }, 'Could not reach the job service.')
                }
                className="rounded-md bg-navy-800 px-3 py-1.5 text-sm font-semibold text-ink hover:bg-navy-700 disabled:opacity-40"
              >
                Pause
              </button>
            )}
            <button
              type="button"
              disabled={busy || doneCount === 0}
              onClick={() => void onClearFinished()}
              className="rounded-md bg-navy-800 px-3 py-1.5 text-sm font-semibold text-ink hover:bg-navy-700 disabled:opacity-40"
              title="Remove all finished items from the queue list (their solves stay in the library)"
            >
              Clear finished
            </button>
          </div>
        </div>

        {queue === null ? (
          <p className="mt-3 text-sm text-ink-dim">
            {pollFailed
              ? 'The job service is not reachable, so the queue cannot be shown.'
              : 'Loading the queue…'}
          </p>
        ) : queue.items.length === 0 ? (
          <p className="mt-3 text-sm text-ink-dim">
            The queue is empty. Tick spots in the catalog below and add them.
          </p>
        ) : (
          <ol className="mt-3 flex flex-col gap-2">
            {queue.items.map((item, idx) => (
              <li
                key={item.spot_id}
                className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-navy-700 bg-navy-850 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm text-ink">
                    <span className="mr-2 font-mono text-ink-faint">{idx + 1}.</span>
                    <span className="font-mono">{item.spot_id}</span>
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-dim">
                    <span className="capitalize">{item.state}</span>
                    {item.state === 'running' ? (
                      <span>solving… · elapsed {formatElapsed(item.started_at, nowMs)}</span>
                    ) : null}
                    {item.state === 'done' ? (
                      <>
                        <span>took {formatDuration(item.started_at, item.finished_at)}</span>
                        {item.nash_distance_pct !== null ? (
                          <span>
                            Nash {item.nash_distance_pct.toFixed(3)}% pot
                          </span>
                        ) : null}
                        {item.iterations !== null ? (
                          <span>{item.iterations.toLocaleString()} iterations</span>
                        ) : null}
                        <UploadChip item={item} />
                      </>
                    ) : null}
                    {item.state === 'queued' ? (
                      <span>added {new Date(item.added_at).toLocaleTimeString()}</span>
                    ) : null}
                  </p>
                  {item.state === 'failed' && item.error ? (
                    <p className="mt-1 text-xs text-accent">{item.error}</p>
                  ) : null}
                  {item.state === 'done' &&
                  item.upload_status === 'failed' &&
                  item.upload_error ? (
                    <p className="mt-1 text-xs text-accent">{item.upload_error}</p>
                  ) : null}
                </div>
                {item.state !== 'running' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onRemoveItem(item.spot_id)}
                    className="rounded-md bg-navy-800 px-2 py-1 text-xs font-semibold text-ink hover:bg-navy-700 disabled:opacity-40"
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* ---------- Catalog browser ---------- */}
      <section
        aria-label="Spot catalog"
        className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">
            Spot catalog{' '}
            <span className="font-normal text-ink-dim">
              ({entries?.length ?? '…'} spots · {counts['in-library']} in library ·{' '}
              {counts.running} running · {counts.queued} queued)
            </span>
          </h2>
          <button
            type="button"
            onClick={() => void loadCatalog()}
            className="rounded-md bg-navy-800 px-3 py-1.5 text-sm font-semibold text-ink hover:bg-navy-700"
          >
            Refresh
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-1.5">
            <span className="text-ink-dim">Group</span>
            <select
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
              className="rounded-md border border-navy-700 bg-navy-850 px-2 py-1.5 text-ink"
            >
              <option value="all">All groups</option>
              {groups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-ink-dim">Table</span>
            <select
              value={tableFilter}
              onChange={(e) => setTableFilter(e.target.value)}
              className="rounded-md border border-navy-700 bg-navy-850 px-2 py-1.5 text-ink"
            >
              <option value="all">All</option>
              <option value="6max">6-max</option>
              <option value="9max">9-max</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-ink-dim">Street</span>
            <select
              value={streetFilter}
              onChange={(e) => setStreetFilter(e.target.value)}
              className="rounded-md border border-navy-700 bg-navy-850 px-2 py-1.5 text-ink"
            >
              <option value="all">All</option>
              <option value="flop">Flop</option>
              <option value="turn">Turn</option>
              <option value="river">River</option>
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-ink-dim">Status</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-md border border-navy-700 bg-navy-850 px-2 py-1.5 text-ink"
            >
              <option value="all">All</option>
              <option value="in-library">In library</option>
              <option value="queued">Queued</option>
              <option value="running">Running</option>
              <option value="done">Done</option>
              <option value="failed">Failed</option>
              <option value="not-queued">Not queued</option>
            </select>
          </label>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search id, matchup, board…"
            className="min-w-52 flex-1 rounded-md border border-navy-700 bg-navy-850 px-2 py-1.5 text-ink placeholder:text-ink-faint"
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <button
            type="button"
            onClick={selectAllFiltered}
            disabled={filtered.length === 0}
            className="rounded-md bg-navy-800 px-3 py-1.5 font-semibold text-ink hover:bg-navy-700 disabled:opacity-40"
          >
            Select all {filtered.length} filtered
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            disabled={selected.size === 0}
            className="rounded-md bg-navy-800 px-3 py-1.5 font-semibold text-ink hover:bg-navy-700 disabled:opacity-40"
          >
            Clear selection
          </button>
          <button
            type="button"
            onClick={() => void onAddSelected()}
            disabled={busy || selected.size === 0}
            className="rounded-md bg-table px-3 py-1.5 font-semibold text-white hover:bg-table-dark disabled:opacity-40"
          >
            Add selected to queue ({selected.size})
          </button>
          <span className="text-ink-dim">
            Showing {filtered.length} of {entries?.length ?? 0} spots
          </span>
        </div>

        {catalogError ? (
          <p className="mt-3 text-sm text-ink-dim" role="alert">
            {catalogError}
          </p>
        ) : entries === null ? (
          <p className="mt-3 text-sm text-ink-dim">Loading the catalog…</p>
        ) : filtered.length === 0 ? (
          <p className="mt-3 text-sm text-ink-dim">No spots match the current filters.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[880px] text-left text-sm">
              <thead>
                <tr className="border-b border-navy-700 text-xs uppercase tracking-wide text-ink-faint">
                  <th className="px-2 py-2" scope="col">
                    <span className="sr-only">Select</span>
                  </th>
                  <th className="px-2 py-2" scope="col">
                    Spot
                  </th>
                  <th className="px-2 py-2" scope="col">
                    Group
                  </th>
                  <th className="px-2 py-2" scope="col">
                    Table
                  </th>
                  <th className="px-2 py-2" scope="col">
                    Street
                  </th>
                  <th className="px-2 py-2" scope="col">
                    Tier
                  </th>
                  <th className="px-2 py-2" scope="col">
                    Coverage OOP / IP
                  </th>
                  <th className="px-2 py-2" scope="col">
                    Est.
                  </th>
                  <th className="px-2 py-2" scope="col">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((entry) => {
                  const display = spotDisplayStatus(entry);
                  const selectable = entry.status === 'ready';
                  return (
                    <tr key={entry.id} className="border-b border-navy-800 hover:bg-navy-850">
                      <td className="px-2 py-2 align-top">
                        <input
                          type="checkbox"
                          checked={selected.has(entry.id)}
                          disabled={!selectable}
                          onChange={(e) => toggleSelected(entry.id, e.target.checked)}
                          aria-label={`Select ${entry.id}`}
                        />
                      </td>
                      <td className="px-2 py-2 align-top">
                        <p className="font-medium text-ink">
                          {entry.matchup} · <span className="font-mono">{entry.board}</span>
                        </p>
                        <p className="font-mono text-xs text-ink-faint">{entry.id}</p>
                        <p className="text-xs text-ink-dim">
                          {entry.board_family}
                          {entry.line ? ` · line: ${entry.line}` : ''}
                        </p>
                        {!selectable ? (
                          <p className="text-xs text-accent">
                            Not ready{entry.status_reason ? `: ${entry.status_reason}` : ''}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-2 py-2 align-top text-ink-dim">{entry.group}</td>
                      <td className="px-2 py-2 align-top text-ink-dim">{entry.table_size}</td>
                      <td className="px-2 py-2 align-top text-ink-dim capitalize">{entry.street}</td>
                      <td className="px-2 py-2 align-top text-ink-dim capitalize">{entry.tier}</td>
                      <td className="px-2 py-2 align-top font-mono text-xs text-ink-dim">
                        {formatCoverage(entry.coverage_oop_pct)} /{' '}
                        {formatCoverage(entry.coverage_ip_pct)}
                      </td>
                      <td className="px-2 py-2 align-top text-ink-dim">
                        {formatEstHours(entry.est_core_hours)}
                      </td>
                      <td className="px-2 py-2 align-top">
                        <SpotStatusChip status={display} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
