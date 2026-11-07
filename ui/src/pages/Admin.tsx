import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchAuthMe, fetchLibrary, logout } from '../lib/api';
import type { LibraryItem } from '../lib/types';
import { useStore } from '../store/useStore';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Admin area: adding solves is admin-only. Shows the session state, real
 * library stats from the job service, and the entry point to the local
 * solve runner (/admin/runner).
 */
export function AdminPage() {
  const navigate = useNavigate();
  const isAdmin = useStore((s) => s.isAdmin);
  const authEnabled = useStore((s) => s.authEnabled);
  const setAdmin = useStore((s) => s.setAdmin);

  const [library, setLibrary] = useState<LibraryItem[] | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);

  // Refresh the session state on arrival: the app-level probe ran once at
  // load and may predate the server (or a login elsewhere) — this page
  // should never render a stale lock.
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

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    void (async () => {
      try {
        const items = await fetchLibrary();
        if (!cancelled) {
          setLibrary(items);
          setStatsError(null);
        }
      } catch {
        if (!cancelled) setStatsError('Could not reach the job service for library stats.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  const onLogout = async () => {
    try {
      await logout();
    } catch {
      // Even if the call fails, drop the local admin state.
    }
    setAdmin(false, authEnabled);
    navigate('/login');
  };

  if (isAdmin === null) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <header>
          <h1 className="text-xl font-bold text-ink">Admin</h1>
          <p className="text-sm text-ink-dim">Checking your session…</p>
        </header>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <header>
          <h1 className="text-xl font-bold text-ink">Admin</h1>
          <p className="text-sm text-ink-dim">Adding solves is admin-only.</p>
        </header>
        <div className="rounded-lg border border-navy-700 bg-navy-900 p-4">
          <p className="text-sm text-ink-dim">
            You're not signed in as admin, so this area is locked. Reading the library, exploring
            solves and studying stay public — only adding solves needs the admin password.
          </p>
          <Link
            to="/login"
            state={{ from: '/admin' }}
            className="mt-3 inline-block rounded-md bg-table px-3 py-2 text-sm font-semibold text-white hover:bg-table-dark"
          >
            Log in as admin
          </Link>
        </div>
      </div>
    );
  }

  const totalBytes = library?.reduce((sum, item) => sum + (item.size_bytes ?? 0), 0) ?? 0;
  const countBy = (kind: LibraryItem['kind']) => library?.filter((i) => i.kind === kind).length ?? 0;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <header>
        <h1 className="text-xl font-bold text-ink">Admin</h1>
        <p className="text-sm text-ink-dim">Solve management for this library.</p>
      </header>

      <section
        aria-label="Session"
        className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel"
      >
        <h2 className="text-sm font-semibold text-ink">Session</h2>
        <p className="mt-2 text-sm text-ink-dim">Signed in as admin. You can add solves.</p>
        {authEnabled === false ? (
          <p className="mt-2 rounded-md border border-accent/60 p-3 text-sm text-ink" role="alert">
            <span className="font-semibold">Server auth is DISABLED.</span>{' '}
            <span className="text-ink-dim">
              The job service has no ADMIN_PASSWORD_HASH set, so its write endpoints are open to
              anyone who can reach the port (local dev mode). Set a password hash on the server
              before exposing it beyond localhost.
            </span>
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => void onLogout()}
          className="mt-3 rounded-md bg-navy-800 px-3 py-2 text-sm font-semibold text-ink hover:bg-navy-700"
        >
          Log out
        </button>
      </section>

      <section
        aria-label="Library stats"
        className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel"
      >
        <h2 className="text-sm font-semibold text-ink">Library</h2>
        {statsError ? (
          <p className="mt-2 text-sm text-ink-dim">{statsError}</p>
        ) : library === null ? (
          <p className="mt-2 text-sm text-ink-dim">Loading…</p>
        ) : (
          <dl className="mt-2 flex flex-col gap-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-dim">Total solves</dt>
              <dd className="font-mono text-ink">{library.length}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-dim">River / turn / flop</dt>
              <dd className="font-mono text-ink">
                {countBy('river')} / {countBy('turn')} / {countBy('flop')}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-dim">Storage used</dt>
              <dd className="font-mono text-ink">{formatBytes(totalBytes)}</dd>
            </div>
          </dl>
        )}
      </section>

      <section
        aria-label="Local solve runner"
        className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel"
      >
        <h2 className="text-sm font-semibold text-ink">Local solve runner</h2>
        <p className="mt-2 text-sm text-ink-dim">
          Queue catalog spots and let this machine solve them one after another; each finished
          solve joins the local library and is uploaded to the central library when one is
          configured.
        </p>
        <Link
          to="/admin/runner"
          className="mt-3 inline-block rounded-md bg-table px-3 py-2 text-sm font-semibold text-white hover:bg-table-dark"
        >
          Open the solve runner
        </Link>
      </section>
    </div>
  );
}
