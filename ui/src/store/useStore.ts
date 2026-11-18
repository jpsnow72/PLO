import { create } from 'zustand';
import { fetchAuthMe, fetchSampleSolve } from '../lib/api';
import type { TrainerFocus } from '../lib/drills';
import { DRAW_COLORS, DRAW_WIDTHS, type DrawStroke, type DrawTool } from '../lib/drawing';
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

  // Admin session (null = not probed yet). Probed once on app load;
  // write endpoints require it when the server has auth enabled.
  isAdmin: boolean | null;
  authEnabled: boolean | null;
  probeAdmin: () => Promise<void>;
  setAdmin: (admin: boolean, authEnabled: boolean | null) => void;

  // Loaded solve + tree navigation.
  solve: SolveData | null;
  solveName: string;
  solveSource: SolveSource | null;
  /**
   * Library item id / job id of the loaded solve, when it has one (the
   * bundled sample has none). The Explorer's "link to heuristic"
   * affordance records this id in a heuristic's linked_spot_ids.
   */
  solveId: string | null;
  loadStatus: 'idle' | 'loading' | 'ready' | 'error';
  loadError: string | null;
  path: PathStep[];
  pendingRunout: RunoutOption[] | null;
  terminalAction: string | null;
  loadSample: () => Promise<void>;
  loadRawSolve: (raw: unknown, name: string, source: SolveSource, id?: string | null) => boolean;
  chooseAction: (actionLabel: string) => void;
  chooseRunout: (card: string) => void;
  dismissRunout: () => void;
  goToStep: (index: number) => void;
  resetPath: () => void;
  /**
   * Replace the navigation path wholesale (deep-linking into a loaded
   * solve, e.g. the Quiz Trainer's "Open in Explorer"). Callers must
   * build the steps from the loaded solve's own tree so every step's
   * nodeHistory resolves; the first step must be the root step.
   */
  setPath: (steps: PathStep[]) => void;

  // Jobs submitted from the wizard this session.
  sessionJobs: JobRecord[];
  upsertJob: (job: JobRecord) => void;

  // Trainer hand-offs (issue #22). One-shot navigation state, in the
  // same spirit as setPath: a page sets the focus, navigates, and the
  // Quiz consumes (and clears) it on load. Nothing is persisted — a
  // focus that survives a reload would be a stale promise.
  trainerFocus: TrainerFocus | null;
  setTrainerFocus: (focus: TrainerFocus | null) => void;
  /**
   * Range-set id the Starting Hands drill should open preselected
   * (set by the Quiz's preflop drill entries); consumed and cleared
   * by the Starting Hands page once its option list resolves it.
   */
  preflopDrillSetId: string | null;
  setPreflopDrillSetId: (id: string | null) => void;

  // Drawing annotations over the Explorer's table (issue #20).
  // Session-local: strokes belong to the loaded solve, survive
  // walking its tree, and are cleared by loadRawSolve when another
  // solve loads. Nothing is persisted or sent to the API. The state
  // lives here (not in the Table view) because the Explorer remounts
  // that view per node.
  drawingActive: boolean;
  drawingTool: DrawTool;
  drawingColor: string;
  drawingWidth: number;
  drawingStrokes: DrawStroke[];
  setDrawingActive: (active: boolean) => void;
  setDrawingTool: (tool: DrawTool) => void;
  setDrawingColor: (hex: string) => void;
  setDrawingWidth: (width: number) => void;
  addDrawingStroke: (stroke: DrawStroke) => void;
  /** Remove the strokes at the given indexes (the eraser). */
  removeDrawingStrokes: (indexes: number[]) => void;
  undoDrawingStroke: () => void;
  clearDrawingStrokes: () => void;
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

  isAdmin: null,
  authEnabled: null,
  probeAdmin: async () => {
    if (get().isAdmin !== null) return; // probe once per app load
    try {
      const state = await fetchAuthMe();
      set({ isAdmin: state.admin, authEnabled: state.authEnabled });
    } catch {
      // API unreachable (sample mode): not admin, auth state unknown.
      set({ isAdmin: false, authEnabled: null });
    }
  },
  setAdmin: (admin, authEnabled) => set({ isAdmin: admin, authEnabled }),

  solve: null,
  solveName: '',
  solveSource: null,
  solveId: null,
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

  loadRawSolve: (raw, name, source, id) => {
    const data = parseSolve(raw);
    if (!data) {
      set({ loadStatus: 'error', loadError: `"${name}" is not a valid engine solve` });
      return false;
    }
    set({
      solve: data,
      solveName: name,
      solveSource: source,
      solveId: id ?? null,
      loadStatus: 'ready',
      loadError: null,
      path: [ROOT_STEP],
      pendingRunout: null,
      terminalAction: null,
      // Annotations annotate one solve's line — a new solve starts clean.
      drawingStrokes: [],
      drawingActive: false,
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

  setPath: (steps) => {
    if (steps.length === 0 || steps[0]?.nodeHistory !== 'root') return;
    const { solve } = get();
    if (!solve) return;
    // Refuse a path whose steps do not resolve in the loaded solve.
    if (steps.some((s) => !solve.nodesByHistory.has(s.nodeHistory))) return;
    set({ path: steps, pendingRunout: null, terminalAction: null });
  },

  sessionJobs: [],

  trainerFocus: null,
  setTrainerFocus: (focus) => set({ trainerFocus: focus }),
  preflopDrillSetId: null,
  setPreflopDrillSetId: (id) => set({ preflopDrillSetId: id }),

  upsertJob: (job) =>
    set((s) => {
      const idx = s.sessionJobs.findIndex((j) => j.id === job.id);
      if (idx === -1) return { sessionJobs: [job, ...s.sessionJobs] };
      const next = [...s.sessionJobs];
      next[idx] = job;
      return { sessionJobs: next };
    }),

  drawingActive: false,
  drawingTool: 'pen',
  drawingColor: DRAW_COLORS[0]!.hex,
  drawingWidth: DRAW_WIDTHS[1]!.value,
  drawingStrokes: [],
  setDrawingActive: (active) => set({ drawingActive: active }),
  setDrawingTool: (tool) => set({ drawingTool: tool }),
  setDrawingColor: (hex) => set({ drawingColor: hex, drawingTool: 'pen' }),
  setDrawingWidth: (width) => set({ drawingWidth: width }),
  addDrawingStroke: (stroke) =>
    set((s) => ({ drawingStrokes: [...s.drawingStrokes, stroke] })),
  removeDrawingStrokes: (indexes) =>
    set((s) => {
      if (indexes.length === 0) return s;
      const drop = new Set(indexes);
      return { drawingStrokes: s.drawingStrokes.filter((_, i) => !drop.has(i)) };
    }),
  undoDrawingStroke: () => set((s) => ({ drawingStrokes: s.drawingStrokes.slice(0, -1) })),
  clearDrawingStrokes: () => set({ drawingStrokes: [] }),
}));
