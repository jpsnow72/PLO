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
  /** Catalog spot id when this solve was produced for a catalog entry. */
  spot_id?: string | null;
  nash_distance_pct: number;
  iterations: number;
  finished_at: string | null;
  size_bytes: number;
  /** Root geometry from the stored solve; null when the payload lacks it. */
  starting_pot?: number | null;
  effective_stack?: number | null;
  /** True when the solve was nodelocked (badged LOCKED, never GTO). */
  locked?: boolean;
}

/** Admin session state, from GET /api/auth/me. */
export interface AuthState {
  /** True when this browser holds an admin session (or auth is disabled server-side). */
  admin: boolean;
  /**
   * Whether the server has auth enabled at all. False means
   * ADMIN_PASSWORD_HASH is unset on the server and write endpoints are
   * open (local dev mode) — the UI surfaces that loudly in Admin.
   */
  authEnabled: boolean;
}

// ---------- Multiway equity (POST /api/multiway/equity) ----------

export interface MultiwayPlayerEquity {
  player_index: number;
  role: 'hero' | 'opponent';
  label: string;
  equity: number;
  win_prob: number;
  tie_prob: number;
  tie_equity: number;
  loss_prob: number;
  std_error: number;
}

export interface MultiwayComboEquity {
  combo: string;
  weight: number;
  equity: number;
  win_prob: number;
  tie_prob: number;
}

export interface MultiwayHeroRangeDistribution {
  combo_count: number;
  total_weight: number;
  mean: number;
  min: number;
  q25: number;
  median: number;
  q75: number;
  max: number;
  quartiles: [number, number, number, number, number];
  top_decile: MultiwayComboEquity[];
  bottom_decile: MultiwayComboEquity[];
}

export interface MultiwayEquityResponse {
  board: string;
  street: 'flop' | 'turn' | 'river';
  mode: 'exact' | 'monte_carlo';
  badge: 'EXACT' | 'MONTE CARLO';
  is_exact: boolean;
  samples: number | null;
  seed: number | null;
  exact_max_showdowns: number;
  estimated_showdowns: number;
  total_weight: number;
  dead_cards: string[];
  hero_kind: 'hand' | 'range';
  hero_hand: string | null;
  hero_equity: number;
  players: MultiwayPlayerEquity[];
  hero_range_distribution: MultiwayHeroRangeDistribution | null;
}

export interface MultiwayOpponentSpec {
  label?: string;
  range?: string | string[];
  preset?: string;
  range_set?: string;
}

export interface MultiwayEquityRequest {
  board: string | string[];
  hero_hand?: string | string[];
  hero_range?: string | string[];
  opponents: Array<string | string[] | MultiwayOpponentSpec>;
  mode?: 'auto' | 'exact' | 'monte_carlo';
  samples?: number;
  seed?: number;
}
