//! `plo-solve` — Heads-up Pot Limit Omaha river solver (E2), turn solver with chance
//! nodes (E3, [`turn`]), and flop solver with flop-street card bucketing (E4,
//! [`buckets`] + [`flop`]), all using Discounted CFR, plus independent
//! best-response exploitability checkers (`br.rs`).

pub mod br;
pub mod buckets;
pub mod cfr;
pub mod flop;
pub mod game;
pub mod json;
pub mod turn;

pub use br::{
    compute_exploitability, compute_exploitability_flop, compute_exploitability_turn,
    ExploitabilityReport,
};
pub use buckets::{
    assign_buckets, assign_buckets_both, combo_features, BucketAssignment, ComboFeatures,
    FEATURE_DIMS,
};
pub use cfr::{solve_river, ComboEv, DcfrConfig, NodeStrategy, SolveResult};
pub use flop::{
    expand_bucket_strategies, solve_flop, BucketConfig, FlopChild, FlopDecisionNode, FlopGame,
    FlopNode, FlopSolveResult, FlopSpot, FlopSubtree, FlopSubtreeGroup, TURN_CARD_DEAL_PROB,
};
pub use game::{
    compute_pot_limit_bounds, legal_bet_sizes, legal_raise_sizes, Action, DecisionNode, Node,
    NodeId, Player, PotLimitBounds, RiverGame, RiverSpot, SolveError, TerminalNode, TreeConfig,
    CHIP_EPS,
};
pub use json::{
    format_solve_result_json, format_turn_solve_result_json, parse_spot_json,
    parse_turn_spot_json, JsonValue,
};
pub use turn::{
    solve_turn, ChanceNode, Street, TurnDecisionNode, TurnGame, TurnNode, TurnSolveResult,
    TurnSpot, RIVER_DEAL_PROB,
};
