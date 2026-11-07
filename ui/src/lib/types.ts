// Types for the engine solve JSON (produced by plo-solve's `solve-river`,
// `solve-turn` and `solve-flop` binaries) and for the thin job-service API.
//
// The raw interfaces mirror the JSON exactly as the engine emits it.
// River solves have no `street` / `river_card` fields; turn solves add them;
// flop solves add `turn_card` as well (the dealt turn card of the subtree a
// node lives in).

export type Player = 'OOP' | 'IP';

export interface Exploitability {
  /** Measured Nash distance, percent of starting pot. The accuracy number. */
  nash_distance_pct: number;
  nash_distance_chips: number;
  mean_exploitability_pct: number;
  mean_exploitability_chips: number;
  oop_exploitability_chips: number;
  ip_exploitability_chips: number;
  oop_br_ev: number;
  ip_br_ev: number;
  oop_strategy_ev: number;
  ip_strategy_ev: number;
}

export interface ComboEv {
  combo: string;
  weight: number;
  ev: number;
}

export interface RawSolveNode {
  decision_id: number;
  node_id: number;
  player: Player;
  /** Turn/flop solves only: "flop" | "turn" | "river". Absent in river solves. */
  street?: string;
  /** Flop solves only: the turn card of the subtree this node lives in, else null. Absent in river/turn solves. */
  turn_card?: string | null;
  /** Turn/flop solves only: the runout card for river nodes, else null. Absent in river solves. */
  river_card?: string | null;
  history: string;
  pot: number;
  to_call: number;
  actions: string[];
  /** combo string -> frequencies aligned with `actions`. */
  strategy: Record<string, number[]>;
}

export interface RawSolve {
  board: string;
  starting_pot: number;
  effective_stack: number;
  iterations: number;
  exploitability: Exploitability;
  oop_evs: ComboEv[];
  ip_evs: ComboEv[];
  nodes: RawSolveNode[];
}

// ---------- Job service API shapes (see api/README.md) ----------

export type JobStatus = 'queued' | 'running' | 'done' | 'error';

export interface JobRecord {
  id: string;
  status: JobStatus;
  kind: 'river' | 'turn' | 'flop';
  board: string;
  /** Preflop range-set ids loaded for this solve, when set-mode was used. */
  oop_range_set?: string | null;
  ip_range_set?: string | null;
  created_at: string;
  finished_at: string | null;
  nash_distance_pct: number | null;
  iterations: number | null;
  error: string | null;
}

export interface LibraryItem {
  id: string;
  name: string;
  kind: 'river' | 'turn' | 'flop';
  board: string;
  oop_range_set?: string | null;
  ip_range_set?: string | null;
  nash_distance_pct: number;
  iterations: number;
  finished_at: string | null;
  size_bytes: number;
}
