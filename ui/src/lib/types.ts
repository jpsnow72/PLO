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
  /**
   * Per-action EVs (issue #8): combo string -> EV of each action at this
   * node, aligned with `actions`, in chips (whole-hand net). Absent in
   * payloads produced before the engine emitted it — readers must treat
   * a missing or malformed table as "not available", never estimate.
   */
  combo_action_evs?: Record<string, number[]>;
}

/** One nodelock as the engine echoes it in solve output (see NODELOCK-NOTES.md). */
export interface NodeLock {
  history: string;
  player: Player;
  frequencies: number[];
}

export interface RawSolve {
  board: string;
  starting_pot: number;
  effective_stack: number;
  iterations: number;
  /** Nodelock badge fields (always emitted by the engine since the
   *  nodelock ship; absent in older payloads — treat as unlocked). */
  locked?: boolean;
  locks?: NodeLock[];
  exploitability: Exploitability;
  oop_evs: ComboEv[];
  ip_evs: ComboEv[];
  nodes: RawSolveNode[];
  /**
   * Split-solve marker (issue #57): present when this doc is only the
   * header of a flop solve stored in pieces — `nodes` then carries
   * ONLY the flop-street nodes, and each turn card's subtree (that
   * card's turn + river decision nodes) is fetched separately from
   * GET /api/solves/:id/turn/<card>. Absent on ordinary solves, whose
   * `nodes` are the whole tree. See lib/splitSolve.ts.
   */
  split?: { format: number; turn_cards: string[] };
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
  /** Range-trimming record when capped range sets fed this solve. */
  range_expansion?: RangeExpansion | null;
  /** True when the job's spot carried node locks (badged LOCKED, never GTO). */
  locked?: boolean;
  created_at: string;
  finished_at: string | null;
  nash_distance_pct: number | null;
  iterations: number | null;
  error: string | null;
}

/** One side's range-trimming record, as stored in a solve's meta. */
export interface RangeExpansionSide {
  set?: string | null;
  action?: string | null;
  cap?: number | null;
  /** 'sample' (weighted draw) or 'top' (highest-weight slice). */
  mode?: string | null;
  seed?: number | null;
  kept_combos?: number | null;
  total_combos?: number | null;
  /** Percent of the side's total range weight kept after the cap (0–100). */
  coverage_pct?: number | null;
  base_set?: string | null;
  base_action?: string | null;
}

/**
 * How a solve's preflop ranges were trimmed to their per-side caps before
 * solving. Present only when capped range sets fed the solve; absent/null
 * for hand-entered ranges and the bundled sample. See lib/sampled.ts.
 */
export interface RangeExpansion {
  oop?: RangeExpansionSide | null;
  ip?: RangeExpansionSide | null;
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
  /** Range-trimming record from the solve's meta; null when uncapped. */
  range_expansion?: RangeExpansion | null;
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
  /**
   * Signed-in identity when the session carries one (Google sign-in
   * sessions record the account email + provider "google"). Password
   * sessions carry neither — both stay null.
   */
  email?: string | null;
  provider?: string | null;
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
