import { create } from 'zustand';
import { fetchSampleSolve } from '../lib/api';
import {
  parseSolve,
  resolveStep,
  type RunoutOption,
  type SolveData,
  type SolveNode,
} from '../lib/solveTree';
import type { JobRecord } from '../lib/types';

export interface PathStep {
  nodeHistory: string;
  label: string;
  kind: 'root' | 'action' | 'runout';
}

export type SolveSource = 'sample' | 'library' | 'job';

interface AppState {
  // Local placeholder auth (no real accounts in this slice).
  user: string | null;
  signIn: (name: string) => void;
  signOut: () => void;

  // Engine connectivity (null = not probed yet).
  apiOnline: boolean | null;
  setApiOnline: (online: boolean) => void;

  // Loaded solve + tree navigation.
  solve: SolveData | null;
  solveName: string;
  solveSource: SolveSource | null;
  loadStatus: 'idle' | 'loading' | 'ready' | 'error';
  loadError: string | null;
  path: PathStep[];
  pendingRunout: RunoutOption[] | null;
  terminalAction: string | null;
  loadSample: () => Promise<void>;
  loadRawSolve: (raw: unknown, name: string, source: SolveSource) => boolean;
  chooseAction: (actionLabel: string) => void;
  chooseRunout: (card: string) => void;
  dismissRunout: () => void;
  goToStep: (index: number) => void;
  resetPath: () => void;

  // Jobs submitted from the wizard this session.
  sessionJobs: JobRecord[];
  upsertJob: (job: JobRecord) => void;
}

const ROOT_STEP: PathStep = { nodeHistory: 'root', label: 'Start of hand', kind: 'root' };

export function currentNodeOf(solve: SolveData | null, path: PathStep[]): SolveNode | null {
  if (!solve || path.length === 0) return null;
  const last = path[path.length - 1];
  if (!last) return null;
  return solve.nodesByHistory.get(last.nodeHistory) ?? null;
}

export const useStore = create<AppState>((set, get) => ({
  user: typeof localStorage !== 'undefined' ? localStorage.getItem('plo-user') : null,
  signIn: (name) => {
    localStorage.setItem('plo-user', name);
    set({ user: name });
  },
  signOut: () => {
    localStorage.removeItem('plo-user');
    set({ user: null });
  },

  apiOnline: null,
  setApiOnline: (online) => set({ apiOnline: online }),

  solve: null,
  solveName: '',
  solveSource: null,
  loadStatus: 'idle',
  loadError: null,
  path: [ROOT_STEP],
  pendingRunout: null,
  terminalAction: null,

  loadSample: async () => {
    set({ loadStatus: 'loading', loadError: null });
    try {
      const raw = await fetchSampleSolve();
      const ok = get().loadRawSolve(raw, 'Sample river solve (bundled)', 'sample');
      if (!ok) set({ loadStatus: 'error', loadError: 'Sample solve failed to parse' });
    } catch (err) {
      set({
        loadStatus: 'error',
        loadError: err instanceof Error ? err.message : 'Failed to load sample solve',
      });
    }
  },

  loadRawSolve: (raw, name, source) => {
    const data = parseSolve(raw);
    if (!data) {
      set({ loadStatus: 'error', loadError: `"${name}" is not a valid engine solve` });
      return false;
    }
    set({
      solve: data,
      solveName: name,
      solveSource: source,
      loadStatus: 'ready',
      loadError: null,
      path: [ROOT_STEP],
      pendingRunout: null,
      terminalAction: null,
    });
    return true;
  },

  chooseAction: (actionLabel) => {
    const { solve, path } = get();
    const node = currentNodeOf(solve, path);
    if (!solve || !node) return;
    const step = resolveStep(solve, node, actionLabel);
    if (step.type === 'node') {
      set({
        path: [
          ...path,
          {
            nodeHistory: step.node.history,
            label: `${node.player} · ${actionLabel}`,
            kind: 'action',
          },
        ],
        pendingRunout: null,
        terminalAction: null,
      });
    } else if (step.type === 'runout') {
      set({ pendingRunout: step.options, terminalAction: null });
    } else {
      set({ terminalAction: step.actionLabel, pendingRunout: null });
    }
  },

  chooseRunout: (card) => {
    const { pendingRunout, path } = get();
    if (!pendingRunout) return;
    const option = pendingRunout.find((o) => o.card === card);
    if (!option) return;
    set({
      path: [
        ...path,
        {
          nodeHistory: option.node.history,
          label: `${option.street === 'turn' ? 'Turn' : 'River'} card · ${card}`,
          kind: 'runout',
        },
      ],
      pendingRunout: null,
      terminalAction: null,
    });
  },

  dismissRunout: () => set({ pendingRunout: null }),

  goToStep: (index) => {
    const { path } = get();
    if (index < 0 || index >= path.length) return;
    set({ path: path.slice(0, index + 1), pendingRunout: null, terminalAction: null });
  },

  resetPath: () => set({ path: [ROOT_STEP], pendingRunout: null, terminalAction: null }),

  sessionJobs: [],
  upsertJob: (job) =>
    set((s) => {
      const idx = s.sessionJobs.findIndex((j) => j.id === job.id);
      if (idx === -1) return { sessionJobs: [job, ...s.sessionJobs] };
      const next = [...s.sessionJobs];
      next[idx] = job;
      return { sessionJobs: next };
    }),
}));
