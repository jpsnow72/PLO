import { useEffect } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { AdminPage } from './pages/Admin';
import { DashboardPage } from './pages/Dashboard';
import { ExplorerPage } from './pages/Explorer';
import { LoginPage } from './pages/Login';
import { PreflopPage } from './pages/Preflop';
import { SolverPage } from './pages/Solver';
import { SpotPickerPage } from './pages/SpotPicker';
import {
  HeuristicsPage,
  QuickReviewPage,
  QuizPage,
  SettingsPage,
} from './pages/Stubs';
import { useStore } from './store/useStore';

const NAV: { to: string; label: string; end?: boolean }[] = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/explore', label: 'Explore' },
  { to: '/explorer', label: 'Tree Explorer' },
  { to: '/solver', label: 'Solver' },
  { to: '/preflop', label: 'Preflop' },
  { to: '/quick-review', label: 'Quick Review' },
  { to: '/quiz', label: 'Quiz' },
  { to: '/heuristics', label: 'Heuristics' },
  { to: '/settings', label: 'Settings' },
];

export function App() {
  const user = useStore((s) => s.user);
  const apiOnline = useStore((s) => s.apiOnline);
  const isAdmin = useStore((s) => s.isAdmin);
  const probeAdmin = useStore((s) => s.probeAdmin);

  // One-shot admin-session probe: decides whether the Admin nav item shows.
  useEffect(() => {
    void probeAdmin();
  }, [probeAdmin]);

  return (
    <div className="flex min-h-screen bg-navy-950 font-sans text-ink">
      {/* Left nav */}
      <aside className="sticky top-0 flex h-screen w-52 shrink-0 flex-col border-r border-navy-700 bg-navy-900">
        <div className="border-b border-navy-700 px-4 py-4">
          <p className="text-base font-bold leading-tight text-ink">
            PLO <span className="text-table-light">GTO</span> Study
          </p>
          <p className="text-xs text-ink-faint">Solver-backed Omaha study</p>
        </div>
        <nav aria-label="Primary" className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-navy-800 font-semibold text-ink ring-1 ring-table'
                    : 'text-ink-dim hover:bg-navy-800 hover:text-ink'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
          {isAdmin ? (
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                `rounded-md px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-navy-800 font-semibold text-ink ring-1 ring-table'
                    : 'text-ink-dim hover:bg-navy-800 hover:text-ink'
                }`
              }
            >
              Admin
            </NavLink>
          ) : null}
        </nav>
        <div className="border-t border-navy-700 p-3 text-xs">
          <p className="flex items-center gap-2 text-ink-dim">
            <span
              aria-hidden="true"
              className={`h-2 w-2 rounded-full ${
                apiOnline === null ? 'bg-ink-faint' : apiOnline ? 'bg-table' : 'bg-accent'
              }`}
            />
            {apiOnline === null
              ? 'Engine: not checked yet'
              : apiOnline
                ? 'Engine: connected'
                : 'Engine: offline (sample mode)'}
          </p>
          <NavLink to="/login" className="mt-2 block text-ink-dim underline hover:text-ink">
            {isAdmin ? 'Admin · signed in' : user ? `Account · ${user}` : 'Sign in'}
          </NavLink>
        </div>
      </aside>

      {/* Main column */}
      <main className="min-w-0 flex-1 px-5 py-5">
        <div className="mx-auto max-w-7xl">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/explore" element={<SpotPickerPage />} />
            <Route path="/explorer" element={<ExplorerPage />} />
            <Route path="/solver" element={<SolverPage />} />
            <Route path="/preflop" element={<PreflopPage />} />
            <Route path="/quick-review" element={<QuickReviewPage />} />
            <Route path="/quiz" element={<QuizPage />} />
            <Route path="/heuristics" element={<HeuristicsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/admin" element={<AdminPage />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
