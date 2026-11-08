//! `plo-eval` — Fast 5-card evaluator, Pot Limit Omaha 60-combo best-hand evaluator,
//! and exact / Monte Carlo heads-up and multiway equity engine.

pub mod equity;
pub mod eval5;
pub mod multiway;
pub mod omaha;
pub mod rng;

pub use equity::{
    compute_hand_vs_hand_auto, compute_hand_vs_hand_equity, compute_hand_vs_range_auto,
    compute_hand_vs_range_equity, default_mode_for_board, enumerate_runouts, EquityError,
    EquityMode, EquityResult, PloRange, WeightedCombo, DEFAULT_MC_SEED, DEFAULT_PREFLOP_MC_SAMPLES,
};
pub use eval5::{eval_5cards, eval_5cards_mask, HandCategory, HandRank};
pub use multiway::{
    binom_u128, compute_multiway_equity, compute_multiway_equity_auto, estimate_multiway_showdowns,
    select_multiway_mode, ComboEquity, HeroInput, HeroRangeDistribution, MultiwayEquityResult,
    PlayerEquity, DEFAULT_MULTIWAY_MC_SAMPLES, DEFAULT_MULTIWAY_MC_SEED, EXACT_MAX_SHOWDOWNS,
    MAX_DECILE_COMBOS, MAX_MULTIWAY_OPPONENTS,
};
pub use omaha::{
    compare_omaha, eval_omaha, eval_omaha_mask, eval_omaha_pairs_triples, extract_board_triples,
    extract_hole_pairs, ShowdownOutcome,
};
pub use rng::DeterministicRng;
