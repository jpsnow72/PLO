import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store/useStore';

/**
 * Local-only placeholder login. There is no server auth in this slice:
 * the name is stored in localStorage and used for greetings/personal
 * state. Real accounts arrive with the sync ticket.
 */
export function LoginPage() {
  const user = useStore((s) => s.user);
  const signIn = useStore((s) => s.signIn);
  const signOut = useStore((s) => s.signOut);
  const navigate = useNavigate();
  const [name, setName] = useState('');

  if (user) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <header>
          <h1 className="text-xl font-bold text-ink">Account</h1>
          <p className="text-sm text-ink-dim">Signed in locally as {user}.</p>
        </header>
        <div className="rounded-lg border border-navy-700 bg-navy-900 p-4">
          <p className="text-sm text-ink-dim">
            This is a local placeholder identity — nothing leaves this device. Real accounts with
            cross-device sync (heuristics log, saved spots, streaks) arrive in a later ticket.
          </p>
          <button
            type="button"
            onClick={signOut}
            className="mt-3 rounded-md bg-navy-800 px-3 py-2 text-sm font-semibold text-ink hover:bg-navy-700"
          >
            Sign out (local)
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <header>
        <h1 className="text-xl font-bold text-ink">Sign in</h1>
        <p className="text-sm text-ink-dim">Local placeholder — no password, no server.</p>
      </header>
      <form
        className="flex flex-col gap-3 rounded-lg border border-navy-700 bg-navy-900 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          signIn(name.trim() || 'Local player');
          navigate('/');
        }}
      >
        <label className="text-sm text-ink-dim">
          Display name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-md border border-navy-700 bg-navy-850 px-2 py-2 text-ink"
            placeholder="e.g. Justin"
            autoComplete="nickname"
          />
        </label>
        <button
          type="submit"
          className="rounded-md bg-table px-3 py-2 font-semibold text-white hover:bg-table-dark"
        >
          Continue locally
        </button>
        <p className="text-xs text-ink-faint">
          Real login (with sync for your heuristics log and saved spots) is a later ticket. For now
          everything works without an account.
        </p>
      </form>
    </div>
  );
}
