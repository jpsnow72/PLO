import { useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, fetchAuthMe, login, logout } from '../lib/api';
import { useStore } from '../store/useStore';

function fromPath(state: unknown): string {
  if (state !== null && typeof state === 'object' && 'from' in state) {
    const from = (state as { from: unknown }).from;
    if (typeof from === 'string' && from.startsWith('/') && from !== '/login') return from;
  }
  return '/';
}

/**
 * Two distinct things live on this page:
 *  - Admin login: the real server login (password -> session cookie).
 *    Adding solves requires it whenever the server has auth enabled.
 *  - Local display name: a device-only placeholder used for greetings and
 *    personal state. It grants nothing and never leaves this device.
 */
export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const isAdmin = useStore((s) => s.isAdmin);
  const authEnabled = useStore((s) => s.authEnabled);
  const setAdmin = useStore((s) => s.setAdmin);
  const user = useStore((s) => s.user);
  const signIn = useStore((s) => s.signIn);
  const signOut = useStore((s) => s.signOut);

  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loggingIn, setLoggingIn] = useState(false);
  const [name, setName] = useState('');

  // Refresh the session state on arrival so a stale probe never shows a
  // login form to someone already holding a valid session.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const state = await fetchAuthMe();
        if (!cancelled) setAdmin(state.admin, state.authEnabled);
      } catch {
        // API unreachable: leave the store as-is; the form reports its own error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setAdmin]);

  const onLogin = async (e: FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    setLoggingIn(true);
    try {
      await login(password);
      const state = await fetchAuthMe().catch(() => null);
      setAdmin(true, state ? state.authEnabled : authEnabled);
      setPassword('');
      navigate(fromPath(location.state), { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setLoginError(err.message);
      } else {
        setLoginError('The job service is unreachable, so login is unavailable right now.');
      }
    } finally {
      setLoggingIn(false);
    }
  };

  const onLogout = async () => {
    try {
      await logout();
    } catch {
      // Drop the local admin state even if the call fails.
    }
    setAdmin(false, authEnabled);
  };

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <header>
        <h1 className="text-xl font-bold text-ink">Sign in</h1>
        <p className="text-sm text-ink-dim">
          Admin login unlocks adding solves. Everything else works without it.
        </p>
      </header>

      <section
        aria-label="Admin login"
        className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel"
      >
        <h2 className="text-sm font-semibold text-ink">Admin</h2>
        {isAdmin ? (
          <div className="mt-2 flex flex-col gap-3">
            <p className="text-sm text-ink-dim">
              You're signed in as admin.
              {authEnabled === false
                ? ' Note: the server currently has auth DISABLED (no ADMIN_PASSWORD_HASH), so write endpoints are open — this session is nominal.'
                : ''}
            </p>
            <div className="flex gap-2">
              <Link
                to="/admin"
                className="rounded-md bg-table px-3 py-2 text-sm font-semibold text-white hover:bg-table-dark"
              >
                Open Admin
              </Link>
              <button
                type="button"
                onClick={() => void onLogout()}
                className="rounded-md bg-navy-800 px-3 py-2 text-sm font-semibold text-ink hover:bg-navy-700"
              >
                Log out
              </button>
            </div>
          </div>
        ) : (
          <form className="mt-2 flex flex-col gap-3" onSubmit={(e) => void onLogin(e)}>
            <label className="text-sm text-ink-dim">
              Admin password
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded-md border border-navy-700 bg-navy-850 px-2 py-2 text-ink"
                autoComplete="current-password"
                required
              />
            </label>
            {loginError ? (
              <p className="text-sm text-red-300" role="alert">
                {loginError}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={loggingIn}
              className="rounded-md bg-table px-3 py-2 font-semibold text-white hover:bg-table-dark disabled:opacity-50"
            >
              {loggingIn ? 'Logging in…' : 'Log in'}
            </button>
            <p className="text-xs text-ink-faint">
              One admin account for now — the password is set on the server, never stored in this
              browser. Sessions last 30 days.
            </p>
          </form>
        )}
      </section>

      <section
        aria-label="Local display name"
        className="rounded-lg border border-navy-700 bg-navy-900 p-4 shadow-panel"
      >
        <h2 className="text-sm font-semibold text-ink">Local display name</h2>
        {user ? (
          <div className="mt-2 flex flex-col gap-3">
            <p className="text-sm text-ink-dim">
              This device shows you as {user}. That's a local placeholder identity — nothing
              leaves this device, and it is separate from the admin login above.
            </p>
            <button
              type="button"
              onClick={signOut}
              className="self-start rounded-md bg-navy-800 px-3 py-2 text-sm font-semibold text-ink hover:bg-navy-700"
            >
              Clear display name
            </button>
          </div>
        ) : (
          <form
            className="mt-2 flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              signIn(name.trim() || 'Local player');
              setName('');
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
              className="self-start rounded-md bg-navy-800 px-3 py-2 text-sm font-semibold text-ink hover:bg-navy-700"
            >
              Save on this device
            </button>
            <p className="text-xs text-ink-faint">
              Used for greetings and personal state on this device only. Real accounts with
              cross-device sync arrive in a later ticket.
            </p>
          </form>
        )}
      </section>
    </div>
  );
}
