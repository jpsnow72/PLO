import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, fetchHeuristics, updateHeuristic } from '../lib/api';
import type { Heuristic } from '../lib/study';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; heuristics: Heuristic[] }
  | { kind: 'needs-login' }
  | { kind: 'offline' };

/**
 * Explorer affordance (ticket S1): attach the currently loaded solve to
 * one of the user's heuristics as a supporting spot. The solve must have
 * a library/job id — the bundled sample has none, and the panel says so
 * instead of inventing an id. All state comes from the real heuristics
 * API; a 401 renders the log-in prompt, matching the Solver's pattern.
 */
export function LinkToHeuristic({ spotId }: { spotId: string | null }) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [selectedId, setSelectedId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!spotId) return;
    let cancelled = false;
    void (async () => {
      try {
        const heuristics = await fetchHeuristics();
        if (cancelled) return;
        setState({ kind: 'ready', heuristics });
        const firstActive = heuristics.find((h) => h.status === 'active');
        if (firstActive) setSelectedId(firstActive.id);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setState({ kind: 'needs-login' });
        } else {
          setState({ kind: 'offline' });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [spotId]);

  if (!spotId) {
    return (
      <p className="text-xs text-ink-faint">
        Open a solve from the library to link it to one of your heuristics — the bundled sample
        has no library id to link.
      </p>
    );
  }

  if (state.kind === 'loading') {
    return <p className="text-xs text-ink-faint">Loading your heuristics…</p>;
  }
  if (state.kind === 'needs-login') {
    return (
      <p className="text-xs text-ink-dim">
        <Link to="/login" className="text-table-light underline hover:text-table">
          Log in
        </Link>{' '}
        to link this solve to a heuristic.
      </p>
    );
  }
  if (state.kind === 'offline') {
    return (
      <p className="text-xs text-ink-faint">
        The job service isn't reachable, so your heuristics can't be loaded right now.
      </p>
    );
  }

  const active = state.heuristics.filter((h) => h.status === 'active');
  if (active.length === 0) {
    return (
      <p className="text-xs text-ink-dim">
        No active heuristics yet.{' '}
        <Link to="/heuristics" className="text-table-light underline hover:text-table">
          Write your first one
        </Link>{' '}
        and you can link this solve to it.
      </p>
    );
  }

  const selected = active.find((h) => h.id === selectedId) ?? active[0];
  const alreadyLinked = selected ? selected.linked_spot_ids.includes(spotId) : false;

  const link = async () => {
    if (!selected || alreadyLinked) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const updated = await updateHeuristic(selected.id, {
        linked_spot_ids: [...selected.linked_spot_ids, spotId],
      });
      setState({
        kind: 'ready',
        heuristics: state.heuristics.map((h) => (h.id === updated.id ? updated : h)),
      });
      setNote('Linked — this solve now supports that heuristic.');
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'Your session expired — log in and try again.'
          : 'Could not save the link. Is the job service still running?',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <label className="sr-only" htmlFor="link-heuristic-select">
          Heuristic
        </label>
        <select
          id="link-heuristic-select"
          value={selected?.id ?? ''}
          onChange={(e) => {
            setSelectedId(e.target.value);
            setNote(null);
            setError(null);
          }}
          className="min-w-0 flex-1 rounded-md border border-navy-600 bg-navy-850 px-2 py-1.5 text-xs text-ink"
        >
          {active.map((h) => (
            <option key={h.id} value={h.id}>
              {h.text.length > 60 ? `${h.text.slice(0, 60)}…` : h.text}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void link()}
          disabled={busy || alreadyLinked}
          className="shrink-0 rounded-md bg-table px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-table-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {alreadyLinked ? 'Linked' : busy ? 'Linking…' : 'Link'}
        </button>
      </div>
      {note ? <p className="text-xs text-table-light">{note}</p> : null}
      {error ? (
        <p className="text-xs text-red-300" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
