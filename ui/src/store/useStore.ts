import { create } from 'zustand';
import { fetchAuthMe, fetchSampleSolve } from '../lib/api';
import type { TrainerFocus } from '../lib/drills';
import type { LockDraft } from '../lib/nodelocks';
import { DRAW_COLORS, DRAW_WIDTHS, type DrawStroke, type DrawTool } from '../lib/drawing';
import {
  parseSolve,
  resolveStep,
  type RunoutOption,
  type SolveData,
  type SolveNode,
} from '../lib/solveTree';
import { turnCardLoader } from '../lib/splitSolve';
import type { JobRecord, RangeExpansion } from '../lib/types';

export interface PathStep {
  nodeHistory: string;
  label: string;
  kind: 'root' | 'action' | 'runout';
}

export type SolveSource = 'sample' | 'library' | 'job';

/**
 * Explorer -> Solver hand-off for a locked re-solve (issue #9): the
 * loaded solve's spot geometry (board, both full ranges as
 * combo:weight text, pot, stacks) plus the locks built in the Edit
 * Node editor. One-shot, like trainerFocus: the Solver consumes and
 * clears it on mount. Bet-size menus are NOT carried — a solve
 * payload does not record them — so the wizard's current menus apply;
 * the Explorer's editor copy says so before the hand-off happens.
 */
export interface LockHandoff {
  board: string;
  oopRange: string;
  ipRange: string;
  pot: number;
  stacks: number;
  locks: LockDraft[];
}

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
  /**
   * Identity of the current session when it carries one (Google
   * sign-in: the account email + provider "google"). Password sessions
   * and signed-out state leave both null.
   */
  authEmail: string | null;
  authProvider: string | null;
  probeAdmin: () => Promise<void>;
  setAdmin: (
    admin: boolean,
    authEnabled: boolean | null,
    identity?: { email?: string | null; provider?: string | null } | null,
  ) => void;

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
  /**
   * The loaded solve's stored range-trimming record, when the opening
   * surface had it (Library/Dashboard/Heuristics rows, Solver jobs).
   * The engine payload itself does not carry it — it lives in the
   * solve's meta — so surfaces that open a solve by id alone leave it
   * null and the Explorer simply shows no SAMPLED chip.
   */
  solveRangeExpansion: RangeExpansion | null;
  loadStatus: 'idle' | 'loading' | 'ready' | 'error';
  loadError: string | null;
  path: PathStep[];
  pendingRunout: RunoutOption[] | null;
  /**
   * Split solves (issue #57): at a flop-close chance node, the turn
   * cards whose subtrees are NOT loaded yet, offered alongside any
   * loaded `pendingRunout` options for the same base history. Picking
   * one fetches + grafts it (chooseSplitRunout) instead of navigating
   * immediately. Null whenever no split chance node is outstanding.
   */
  pendingTurnCards: { baseHistory: string; cards: string[] } | null;
  /**
   * The in-flight (or failed) turn-card load for the pending chance
   * node. The Explorer renders it as an inline banner on the chance
   * branch — loading text, or a retryable error — never a blank view.
   */
  turnCardLoad: { card: string; status: 'loading' | 'error'; error: string | null } | null;
  terminalAction: string | null;
  loadSample: () => Promise<void>;
  loadRawSolve: (
    raw: unknown,
    name: string,
    source: SolveSource,
    id?: string | null,
    rangeExpansion?: RangeExpansion | null,
  ) => boolean;
  chooseAction: (actionLabel: string) => void;
  chooseRunout: (card: string) => void;
  /**
   * Pick an UNLOADED turn card at the pending split chance node:
   * fetch + graft its subtree (one fetch per card, deduped by the
   * loader), then advance the line into it. On failure the load state
   * carries a retryable error and the line does not move.
   */
  chooseSplitRunout: (card: string) => Promise<void>;
  /** Clear a finished/failed turn-card load banner (back to the picker). */
  dismissTurnCardLoad: () => void;
  /**
   * Quietly ensure a turn card is grafted into the loaded solve (no
   * navigation) — for programmatic callers that are about to point
   * the path into that card (the Quiz's Open in Explorer). Resolves
   * false for non-split solves, a missing id, or a failed fetch.
   */
  loadTurnCard: (card: string) => Promise<boolean>;
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
  lockHandoff: LockHandoff | null;
  setLockHandoff: (handoff: LockHandoff | null) => void;
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
  authEmail: null,
  authProvider: null,
  probeAdmin: async () => {
    if (get().isAdmin !== null) return; // probe once per app load
    try {
      const state = await fetchAuthMe();
      set({
        isAdmin: state.admin,
        authEnabled: state.authEnabled,
        authEmail: state.admin ? (state.email ?? null) : null,
        authProvider: state.admin ? (state.provider ?? null) : null,
      });
    } catch {
      // API unreachable (sample mode): not admin, auth state unknown.
      set({ isAdmin: false, authEnabled: null, authEmail: null, authProvider: null });
    }
  },
  setAdmin: (admin, authEnabled, identity) =>
    set({
      isAdmin: admin,
      authEnabled,
      // Signing out (or a session without identity) clears the identity;
      // callers that probed /api/auth/me pass the state through so a
      // Google session's email survives page-level refreshes.
      authEmail: admin ? (identity?.email ?? null) : null,
      authProvider: admin ? (identity?.provider ?? null) : null,
    }),

  solve: null,
  solveName: '',
  solveSource: null,
  solveId: null,
  solveRangeExpansion: null,
  loadStatus: 'idle',
  loadError: null,
  path: [ROOT_STEP],
  pendingRunout: null,
  pendingTurnCards: null,
  turnCardLoad: null,
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

  loadRawSolve: (raw, name, source, id, rangeExpansion) => {
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
      solveRangeExpansion: rangeExpansion ?? null,
      loadStatus: 'ready',
      loadError: null,
      path: [ROOT_STEP],
      pendingRunout: null,
      pendingTurnCards: null,
      turnCardLoad: null,
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
        pendingTurnCards: null,
        turnCardLoad: null,
        terminalAction: null,
      });
    } else if (step.type === 'runout') {
      // Split solves: at a turn chance node, cards whose subtrees are
      // not loaded yet ride alongside the loaded options — picking
      // one loads it first (chooseSplitRunout).
      let pendingTurnCards: AppState['pendingTurnCards'] = null;
      if (step.options[0]?.street === 'turn' && solve.split) {
        const offered = new Set(step.options.map((o) => o.card));
        const unloaded = solve.split.turnCards.filter(
          (c) => !solve.split!.loadedCards.has(c) && !offered.has(c),
        );
        if (unloaded.length > 0) {
          pendingTurnCards = { baseHistory: step.baseHistory, cards: unloaded };
        }
      }
      set({ pendingRunout: step.options, pendingTurnCards, turnCardLoad: null, terminalAction: null });
    } else if (step.type === 'split-runout') {
      set({
        pendingRunout: null,
        pendingTurnCards: { baseHistory: step.baseHistory, cards: step.cards },
        turnCardLoad: null,
        terminalAction: null,
      });
    } else {
      set({
        terminalAction: step.actionLabel,
        pendingRunout: null,
        pendingTurnCards: null,
        turnCardLoad: null,
      });
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
      pendingTurnCards: null,
      turnCardLoad: null,
      terminalAction: null,
    });
  },

  chooseSplitRunout: async (card) => {
    const { solve, solveId, pendingTurnCards, path } = get();
    if (!solve || !solve.split || !pendingTurnCards) return;
    if (!pendingTurnCards.cards.includes(card)) return;
    set({ turnCardLoad: { card, status: 'loading', error: null } });
    const ok = solveId ? await turnCardLoader.ensureCard(solve, solveId, card) : false;
    // The solve may have been replaced while the fetch was in flight;
    // a stale completion must not move the new solve's line.
    if (get().solve !== solve) return;
    if (!ok) {
      set({
        turnCardLoad: {
          card,
          status: 'error',
          error: `The ${card} turn could not be loaded. Check your connection and retry — nothing was changed.`,
        },
      });
      return;
    }
    const rootNode = solve.nodesByHistory.get(`${pendingTurnCards.baseHistory}|t:${card}`);
    if (!rootNode) {
      // The card's payload loaded, but this line has no subtree under
      // it (an all-in close deals the card with no decisions left).
      set({
        solve: { ...solve },
        pendingRunout: null,
        pendingTurnCards: null,
        turnCardLoad: null,
        terminalAction: 'All-in runout',
      });
      return;
    }
    set({
      solve: { ...solve },
      path: [
        ...path,
        { nodeHistory: rootNode.history, label: `Turn card · ${card}`, kind: 'runout' },
      ],
      pendingRunout: null,
      pendingTurnCards: null,
      turnCardLoad: null,
      terminalAction: null,
    });
  },

  dismissTurnCardLoad: () => set({ turnCardLoad: null }),

  loadTurnCard: async (card) => {
    const { solve, solveId } = get();
    if (!solve || !solve.split || !solveId) return false;
    const ok = await turnCardLoader.ensureCard(solve, solveId, card);
    if (ok && get().solve === solve) set({ solve: { ...solve } });
    return ok;
  },

  dismissRunout: () => set({ pendingRunout: null, pendingTurnCards: null }),

  goToStep: (index) => {
    const { path } = get();
    if (index < 0 || index >= path.length) return;
    set({
      path: path.slice(0, index + 1),
      pendingRunout: null,
      pendingTurnCards: null,
      turnCardLoad: null,
      terminalAction: null,
    });
  },

  resetPath: () =>
    set({
      path: [ROOT_STEP],
      pendingRunout: null,
      pendingTurnCards: null,
      turnCardLoad: null,
      terminalAction: null,
    }),

  setPath: (steps) => {
    if (steps.length === 0 || steps[0]?.nodeHistory !== 'root') return;
    const { solve } = get();
    if (!solve) return;
    // Refuse a path whose steps do not resolve in the loaded solve.
    if (steps.some((s) => !solve.nodesByHistory.has(s.nodeHistory))) return;
    set({
      path: steps,
      pendingRunout: null,
      pendingTurnCards: null,
      turnCardLoad: null,
      terminalAction: null,
    });
  },

  sessionJobs: [],

  trainerFocus: null,
  setTrainerFocus: (focus) => set({ trainerFocus: focus }),
  lockHandoff: null,
  setLockHandoff: (handoff) => set({ lockHandoff: handoff }),
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
