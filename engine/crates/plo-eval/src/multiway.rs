//! Exact and deterministic Monte Carlo multiway Pot Limit Omaha equity calculator
//! (Hero hand or weighted range against 1 to 4 opposing weighted ranges on flop/turn/river boards).
//!
//! Reuses the E1 60-combo Omaha evaluator ([`eval_omaha_pairs_triples`]) and
//! [`DeterministicRng`] (`Xoshiro256**`).

use std::cmp::Ordering;

use plo_cards::{sort_cards_canonical, Card, HandMask};

use crate::equity::{
    enumerate_runouts, EquityError, EquityMode, PloRange, WeightedCombo, DEFAULT_MC_SEED,
};
use crate::eval5::HandRank;
use crate::omaha::{eval_omaha_pairs_triples, extract_board_triples};
use crate::rng::DeterministicRng;

/// Maximum number of opposing ranges supported in multiway equity calculations.
pub const MAX_MULTIWAY_OPPONENTS: usize = 4;

/// Maximum estimated showdown evaluations (`combo_product * board_runouts`) for which
/// auto-mode selects [`EquityMode::Exact`] instead of [`EquityMode::MonteCarlo`].
///
/// At `250,000`:
/// - Any hand-vs-hand(s) spot on flop ($\le 820$ runouts), turn ($\le 40$ runouts), or river ($1$ runout)
///   is evaluated **exactly**.
/// - Any river hand-vs-range spot with 1 opponent (including a full unblocked random range of
///   $\binom{43}{4} = 123,410$ combos) has $123,410 \le 250,000$ showdowns and is evaluated **exactly**.
/// - Narrow range-vs-range spots on river/turn/flop whose product of unblocked combo counts times
///   runout count is $\le 250,000$ are evaluated **exactly**.
/// - Larger multi-range or multi-street combinations use seeded [`EquityMode::MonteCarlo`].
pub const EXACT_MAX_SHOWDOWNS: u128 = 250_000;

/// Default number of Monte Carlo samples when auto-mode selects [`EquityMode::MonteCarlo`].
pub const DEFAULT_MULTIWAY_MC_SAMPLES: usize = 50_000;

/// Maximum number of combos emitted in each of `top_decile` and `bottom_decile` for a Hero range
/// so JSON payloads remain compact even for very large ranges.
pub const MAX_DECILE_COMBOS: usize = 100;

/// Maximum rejection-sampling attempts per Monte Carlo trial before declaring all combo tuples blocked.
const MAX_REJECTION_ATTEMPTS_PER_SAMPLE: usize = 10_000;

/// Hero input for a multiway equity calculation: either a fixed 4-card hand or a weighted range.
#[derive(Clone, Debug, PartialEq)]
pub enum HeroInput {
    Hand([Card; 4]),
    Range(PloRange),
}

/// Per-player equity breakdown in a multiway pot (`player_index == 0` is Hero, `1..=K` are Opponents).
#[derive(Clone, Debug, PartialEq)]
pub struct PlayerEquity {
    /// Player index (`0` = Hero, `1..=opponents.len()` = Opponents).
    pub player_index: usize,
    /// Player's overall equity share in `[0.0, 1.0]` (`win_prob + tie_equity`).
    pub equity: f64,
    /// Probability of winning the pot outright (`m == 1` winner).
    pub win_prob: f64,
    /// Probability of tying for first place with at least one other player (`m >= 2` winners).
    pub tie_prob: f64,
    /// Equity share contributed by ties (`sum of (1/m) * P(m-way tie for first)`).
    pub tie_equity: f64,
    /// Probability of losing the pot (`1.0 - win_prob - tie_prob`).
    pub loss_prob: f64,
    /// Raw weighted outright win total.
    pub wins: f64,
    /// Raw weighted tie-event total.
    pub ties: f64,
    /// Raw weighted tie-share total (`sum of weight / m` across tied showdowns).
    pub tie_share_total: f64,
    /// Raw weighted loss total.
    pub losses: f64,
    /// Standard error of `equity` (`0.0` for `Exact`, sample SE for `MonteCarlo`).
    pub std_error: f64,
}

/// Per-combo equity entry for a Hero range's top/bottom deciles.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct ComboEquity {
    pub cards: [Card; 4],
    pub weight: f64,
    pub equity: f64,
    pub win_prob: f64,
    pub tie_prob: f64,
}

/// Equity distribution summary and top/bottom decile combos for a Hero range (`HeroInput::Range`).
#[derive(Clone, Debug, PartialEq)]
pub struct HeroRangeDistribution {
    /// Number of unblocked Hero combos with valid showdowns.
    pub combo_count: usize,
    /// Total range weight of evaluated Hero combos.
    pub total_weight: f64,
    /// Weighted mean equity across Hero's range.
    pub mean: f64,
    /// Minimum combo equity (0th percentile).
    pub min: f64,
    /// 25th percentile (first quartile) combo equity.
    pub q25: f64,
    /// 50th percentile (median) combo equity.
    pub median: f64,
    /// 75th percentile (third quartile) combo equity.
    pub q75: f64,
    /// Maximum combo equity (100th percentile).
    pub max: f64,
    /// Quartiles array `[min, q25, median, q75, max]`.
    pub quartiles: [f64; 5],
    /// Top decile of Hero's combos ordered by equity descending (capped at [`MAX_DECILE_COMBOS`]).
    pub top_decile: Vec<ComboEquity>,
    /// Bottom decile of Hero's combos ordered by equity ascending (capped at [`MAX_DECILE_COMBOS`]).
    pub bottom_decile: Vec<ComboEquity>,
}

/// Result of a multiway equity computation (Hero + 1..4 Opponents).
#[derive(Clone, Debug, PartialEq)]
pub struct MultiwayEquityResult {
    /// Hero's overall equity (`players[0].equity`).
    pub hero_equity: f64,
    /// Per-player equity breakdown (`players[0]` = Hero, `players[1..]` = Opponents 1..=K).
    pub players: Vec<PlayerEquity>,
    /// Total weight evaluated (`Exact`) or number of accepted samples (`MonteCarlo`).
    pub total_weight: f64,
    /// Calculation mode (`Exact` or `MonteCarlo { samples, seed }`).
    pub mode: EquityMode,
    /// Combined dead-card mask (board + fixed hero hand if `HeroInput::Hand` + explicit dead cards).
    pub dead_mask: HandMask,
    /// Estimated showdown count that governed mode selection.
    pub estimated_showdowns: u128,
    /// Present when Hero is a `HeroInput::Range`: distribution summary + top/bottom decile combos.
    pub hero_range_distribution: Option<HeroRangeDistribution>,
}

impl MultiwayEquityResult {
    /// Returns `true` if computed via exact enumeration.
    #[inline]
    pub const fn is_exact(&self) -> bool {
        matches!(self.mode, EquityMode::Exact)
    }

    /// Returns `true` if computed via Monte Carlo sampling.
    #[inline]
    pub const fn is_monte_carlo(&self) -> bool {
        matches!(self.mode, EquityMode::MonteCarlo { .. })
    }
}

/// Computes $\binom{n}{k}$ as a `u128`.
#[inline]
pub const fn binom_u128(n: usize, k: usize) -> u128 {
    if k > n {
        return 0;
    }
    if k == 0 || k == n {
        return 1;
    }
    let k = if k > n - k { n - k } else { k };
    let mut res = 1u128;
    let mut i = 1usize;
    while i <= k {
        res = res * ((n + 1 - i) as u128) / (i as u128);
        i += 1;
    }
    res
}

/// Estimates the upper-bound number of showdown evaluations (`combo_product * runouts_per_tuple`)
/// for a board of length `board_len`, `board_plus_dead_count` dead cards (excluding player hands),
/// and active unblocked combo counts `player_combo_counts` (length $P = 1 + K$).
#[inline]
pub fn estimate_multiway_showdowns(
    board_len: usize,
    board_plus_dead_count: usize,
    player_combo_counts: &[usize],
) -> u128 {
    let num_players = player_combo_counts.len();
    let cards_used = board_plus_dead_count + 4 * num_players;
    let needed = 5usize.saturating_sub(board_len);
    if cards_used + needed > 52 {
        return 0;
    }
    let remaining_cards = 52 - cards_used;
    let runouts = binom_u128(remaining_cards, needed);
    let mut prod = 1u128;
    for &c in player_combo_counts {
        prod = prod.saturating_mul(c as u128);
    }
    prod.saturating_mul(runouts)
}

/// Selects [`EquityMode::Exact`] when `board_len >= 3` and the estimated showdown count is at most
/// [`EXACT_MAX_SHOWDOWNS`], or [`EquityMode::MonteCarlo`] otherwise.
#[inline]
pub fn select_multiway_mode(
    board_len: usize,
    board_plus_dead_count: usize,
    player_combo_counts: &[usize],
    mc_samples: usize,
    seed: u64,
) -> EquityMode {
    let est = estimate_multiway_showdowns(board_len, board_plus_dead_count, player_combo_counts);
    if board_len >= 3 && est <= EXACT_MAX_SHOWDOWNS {
        EquityMode::Exact
    } else {
        EquityMode::MonteCarlo {
            samples: mc_samples,
            seed,
        }
    }
}

/// Computes multiway equity for `hero` (hand or range) against `1..=4` `opponents` ranges on a
/// 3-, 4-, or 5-card `board`, automatically selecting [`EquityMode::Exact`] or
/// [`EquityMode::MonteCarlo`] via [`EXACT_MAX_SHOWDOWNS`].
pub fn compute_multiway_equity_auto(
    hero: &HeroInput,
    opponents: &[PloRange],
    board: &[Card],
    dead_cards: &[Card],
    mc_samples: usize,
    seed: u64,
) -> Result<MultiwayEquityResult, EquityError> {
    let validated = validate_and_filter_inputs(hero, opponents, board, dead_cards)?;
    let counts: Vec<usize> = std::iter::once(validated.hero_combos.len())
        .chain(validated.opp_combos.iter().map(|v| v.len()))
        .collect();
    let mode = select_multiway_mode(
        board.len(),
        validated.board_and_extra_dead.count() as usize,
        &counts,
        mc_samples,
        seed,
    );
    compute_multiway_with_validated(validated, board.len(), mode)
}

/// Computes multiway equity for `hero` (hand or range) against `1..=4` `opponents` ranges on a
/// 3-, 4-, or 5-card `board` using the caller-specified [`EquityMode`].
pub fn compute_multiway_equity(
    hero: &HeroInput,
    opponents: &[PloRange],
    board: &[Card],
    dead_cards: &[Card],
    mode: EquityMode,
) -> Result<MultiwayEquityResult, EquityError> {
    let validated = validate_and_filter_inputs(hero, opponents, board, dead_cards)?;
    compute_multiway_with_validated(validated, board.len(), mode)
}

struct ValidatedMultiway {
    board_mask: HandMask,
    board_and_extra_dead: HandMask,
    initial_dead_mask: HandMask,
    hero_is_range: bool,
    hero_combos: Vec<WeightedCombo>,
    opp_combos: Vec<Vec<WeightedCombo>>,
}

fn validate_and_filter_inputs(
    hero: &HeroInput,
    opponents: &[PloRange],
    board: &[Card],
    dead_cards: &[Card],
) -> Result<ValidatedMultiway, EquityError> {
    if board.len() < 3 || board.len() > 5 {
        return Err(EquityError::InvalidBoardCardCount(board.len()));
    }
    if opponents.is_empty() || opponents.len() > MAX_MULTIWAY_OPPONENTS {
        return Err(EquityError::InvalidOpponentCount(opponents.len()));
    }

    let board_mask = HandMask::from_cards(board);
    if board_mask.count() as usize != board.len() {
        return Err(EquityError::CardCollision);
    }

    let extra_dead_mask = HandMask::from_cards(dead_cards);
    if extra_dead_mask.count() as usize != dead_cards.len() {
        return Err(EquityError::CardCollision);
    }
    // `dead_cards` may either repeat board/hero cards or specify additional dead cards;
    // if a caller passes explicit extra dead cards, union them cleanly.
    let board_and_extra_dead = board_mask | extra_dead_mask;

    let (hero_is_range, hero_combos, initial_dead_mask) = match hero {
        HeroInput::Hand(cards) => {
            let hc = WeightedCombo::new(*cards, 1.0)?;
            if hc.mask.overlaps(board_mask) {
                return Err(EquityError::CardCollision);
            }
            // If caller passed non-board dead cards that collide with Hero's fixed hand, reject.
            let extra_only = extra_dead_mask - board_mask - hc.mask;
            if (extra_dead_mask - board_mask).overlaps(hc.mask)
                && extra_dead_mask != (board_mask | hc.mask)
            {
                return Err(EquityError::CardCollision);
            }
            let dead = board_mask | hc.mask | extra_only;
            (false, vec![hc], dead)
        }
        HeroInput::Range(range) => {
            if range.is_empty() {
                return Err(EquityError::EmptyRange);
            }
            let active: Vec<WeightedCombo> = range
                .combos()
                .iter()
                .copied()
                .filter(|c| !c.mask.overlaps(board_and_extra_dead))
                .collect();
            if active.is_empty() {
                return Err(EquityError::AllRangeCombosBlocked);
            }
            (true, active, board_and_extra_dead)
        }
    };

    let mut opp_combos = Vec::with_capacity(opponents.len());
    for opp_range in opponents {
        if opp_range.is_empty() {
            return Err(EquityError::EmptyRange);
        }
        let active: Vec<WeightedCombo> = opp_range
            .combos()
            .iter()
            .copied()
            .filter(|c| !c.mask.overlaps(initial_dead_mask))
            .collect();
        if active.is_empty() {
            return Err(EquityError::AllRangeCombosBlocked);
        }
        opp_combos.push(active);
    }

    // Check that the deck has enough cards for 5 board cards + (1 + K) 4-card hands.
    let num_players = 1 + opp_combos.len();
    let needed_board = 5 - board.len();
    if (board_and_extra_dead.count() as usize) + 4 * num_players + needed_board > 52 {
        return Err(EquityError::AllRangeCombosBlocked);
    }

    Ok(ValidatedMultiway {
        board_mask,
        board_and_extra_dead,
        initial_dead_mask,
        hero_is_range,
        hero_combos,
        opp_combos,
    })
}

fn compute_multiway_with_validated(
    validated: ValidatedMultiway,
    board_len: usize,
    mode: EquityMode,
) -> Result<MultiwayEquityResult, EquityError> {
    let counts: Vec<usize> = std::iter::once(validated.hero_combos.len())
        .chain(validated.opp_combos.iter().map(|v| v.len()))
        .collect();
    let estimated_showdowns = estimate_multiway_showdowns(
        board_len,
        validated.board_and_extra_dead.count() as usize,
        &counts,
    );

    match mode {
        EquityMode::Exact => exact_multiway_inner(&validated, board_len, estimated_showdowns),
        EquityMode::MonteCarlo { samples, seed } => {
            if samples == 0 {
                return Err(EquityError::ZeroMonteCarloSamples);
            }
            mc_multiway_inner(&validated, board_len, samples, seed, estimated_showdowns)
        }
    }
}

#[derive(Copy, Clone)]
struct EvalCombo {
    mask: HandMask,
    weight: f64,
    rank: HandRank,
    orig_idx: usize,
}

fn exact_multiway_inner(
    v: &ValidatedMultiway,
    board_len: usize,
    estimated_showdowns: u128,
) -> Result<MultiwayEquityResult, EquityError> {
    let num_opps = v.opp_combos.len();
    let num_players = 1 + num_opps;
    let needed = 5 - board_len;

    // If any player has only 1 combo, its cards are dead for all other players and the board runout.
    let mut fixed_players_mask = v.board_and_extra_dead;
    if v.hero_combos.len() == 1 {
        fixed_players_mask |= v.hero_combos[0].mask;
    }
    for opp in &v.opp_combos {
        if opp.len() == 1 {
            if fixed_players_mask.overlaps(opp[0].mask) {
                return Err(EquityError::AllRangeCombosBlocked);
            }
            fixed_players_mask |= opp[0].mask;
        }
    }

    let remaining_deck: Vec<Card> = (HandMask::FULL_DECK - fixed_players_mask).iter().collect();
    if remaining_deck.len() < needed {
        return Err(EquityError::AllRangeCombosBlocked);
    }

    let mut player_wins = vec![0.0f64; num_players];
    let mut player_ties = vec![0.0f64; num_players];
    let mut player_tie_shares = vec![0.0f64; num_players];
    let mut player_losses = vec![0.0f64; num_players];
    let mut total_weight = 0.0f64;

    let num_hero = v.hero_combos.len();
    let mut hero_combo_wins = vec![0.0f64; num_hero];
    let mut hero_combo_ties = vec![0.0f64; num_hero];
    let mut hero_combo_eq_w = vec![0.0f64; num_hero];
    let mut hero_combo_total_w = vec![0.0f64; num_hero];

    let mut hero_eval_buf: Vec<EvalCombo> = Vec::with_capacity(num_hero);
    let mut opp_eval_bufs: Vec<Vec<EvalCombo>> =
        v.opp_combos.iter().map(|c| Vec::with_capacity(c.len())).collect();

    enumerate_runouts(&remaining_deck, needed, v.board_mask, &mut |full_board| {
        // Check that every player has at least one combo disjoint from `full_board` before
        // extracting board triples.
        if !v.hero_combos.iter().any(|c| !c.mask.overlaps(full_board)) {
            return;
        }
        for opp in &v.opp_combos {
            if !opp.iter().any(|c| !c.mask.overlaps(full_board)) {
                return;
            }
        }

        let bt = extract_board_triples(full_board);

        hero_eval_buf.clear();
        for (idx, c) in v.hero_combos.iter().enumerate() {
            if !c.mask.overlaps(full_board) {
                hero_eval_buf.push(EvalCombo {
                    mask: c.mask,
                    weight: c.weight,
                    rank: eval_omaha_pairs_triples(&c.hole_pairs, &bt),
                    orig_idx: idx,
                });
            }
        }

        for (opp_idx, opp) in v.opp_combos.iter().enumerate() {
            let buf = &mut opp_eval_bufs[opp_idx];
            buf.clear();
            for (idx, c) in opp.iter().enumerate() {
                if !c.mask.overlaps(full_board) {
                    buf.push(EvalCombo {
                        mask: c.mask,
                        weight: c.weight,
                        rank: eval_omaha_pairs_triples(&c.hole_pairs, &bt),
                        orig_idx: idx,
                    });
                }
            }
        }

        let mut chosen_ranks = [HandRank(0); 5];
        for hc in &hero_eval_buf {
            chosen_ranks[0] = hc.rank;
            #[allow(clippy::too_many_arguments)]
            fn recurse_opps(
                opp_idx: usize,
                opp_bufs: &[Vec<EvalCombo>],
                used_mask: HandMask,
                hero_orig_idx: usize,
                hero_weight: f64,
                opp_weight_prod: f64,
                chosen_ranks: &mut [HandRank; 5],
                num_players: usize,
                player_wins: &mut [f64],
                player_ties: &mut [f64],
                player_tie_shares: &mut [f64],
                player_losses: &mut [f64],
                total_weight: &mut f64,
                hero_combo_wins: &mut [f64],
                hero_combo_ties: &mut [f64],
                hero_combo_eq_w: &mut [f64],
                hero_combo_total_w: &mut [f64],
            ) {
                if opp_idx == opp_bufs.len() {
                    let deal_w = hero_weight * opp_weight_prod;
                    *total_weight += deal_w;

                    let mut max_rank = chosen_ranks[0];
                    for r in &chosen_ranks[1..num_players] {
                        if *r > max_rank {
                            max_rank = *r;
                        }
                    }
                    let mut tie_count = 0usize;
                    for r in &chosen_ranks[0..num_players] {
                        if *r == max_rank {
                            tie_count += 1;
                        }
                    }

                    if tie_count == 1 {
                        for p in 0..num_players {
                            if chosen_ranks[p] == max_rank {
                                player_wins[p] += deal_w;
                            } else {
                                player_losses[p] += deal_w;
                            }
                        }
                    } else {
                        let share = deal_w / (tie_count as f64);
                        for p in 0..num_players {
                            if chosen_ranks[p] == max_rank {
                                player_ties[p] += deal_w;
                                player_tie_shares[p] += share;
                            } else {
                                player_losses[p] += deal_w;
                            }
                        }
                    }

                    // Conditional per-combo accumulation for Hero's combo `hero_orig_idx`
                    hero_combo_total_w[hero_orig_idx] += opp_weight_prod;
                    if chosen_ranks[0] == max_rank {
                        if tie_count == 1 {
                            hero_combo_wins[hero_orig_idx] += opp_weight_prod;
                            hero_combo_eq_w[hero_orig_idx] += opp_weight_prod;
                        } else {
                            hero_combo_ties[hero_orig_idx] += opp_weight_prod;
                            hero_combo_eq_w[hero_orig_idx] += opp_weight_prod / (tie_count as f64);
                        }
                    }
                    return;
                }

                for oc in &opp_bufs[opp_idx] {
                    if used_mask.overlaps(oc.mask) {
                        continue;
                    }
                    chosen_ranks[1 + opp_idx] = oc.rank;
                    recurse_opps(
                        opp_idx + 1,
                        opp_bufs,
                        used_mask | oc.mask,
                        hero_orig_idx,
                        hero_weight,
                        opp_weight_prod * oc.weight,
                        chosen_ranks,
                        num_players,
                        player_wins,
                        player_ties,
                        player_tie_shares,
                        player_losses,
                        total_weight,
                        hero_combo_wins,
                        hero_combo_ties,
                        hero_combo_eq_w,
                        hero_combo_total_w,
                    );
                }
            }

            recurse_opps(
                0,
                &opp_eval_bufs,
                full_board | hc.mask,
                hc.orig_idx,
                hc.weight,
                1.0,
                &mut chosen_ranks,
                num_players,
                &mut player_wins,
                &mut player_ties,
                &mut player_tie_shares,
                &mut player_losses,
                &mut total_weight,
                &mut hero_combo_wins,
                &mut hero_combo_ties,
                &mut hero_combo_eq_w,
                &mut hero_combo_total_w,
            );
        }
    });

    if total_weight <= 0.0 {
        return Err(EquityError::AllRangeCombosBlocked);
    }

    let mut players = Vec::with_capacity(num_players);
    for p in 0..num_players {
        let win_prob = player_wins[p] / total_weight;
        let tie_prob = player_ties[p] / total_weight;
        let tie_equity = player_tie_shares[p] / total_weight;
        let loss_prob = player_losses[p] / total_weight;
        let equity = win_prob + tie_equity;
        players.push(PlayerEquity {
            player_index: p,
            equity,
            win_prob,
            tie_prob,
            tie_equity,
            loss_prob,
            wins: player_wins[p],
            ties: player_ties[p],
            tie_share_total: player_tie_shares[p],
            losses: player_losses[p],
            std_error: 0.0,
        });
    }

    let hero_range_distribution = if v.hero_is_range {
        Some(build_hero_range_distribution(
            &v.hero_combos,
            &hero_combo_wins,
            &hero_combo_ties,
            &hero_combo_eq_w,
            &hero_combo_total_w,
        )?)
    } else {
        None
    };

    Ok(MultiwayEquityResult {
        hero_equity: players[0].equity,
        players,
        total_weight,
        mode: EquityMode::Exact,
        dead_mask: v.initial_dead_mask,
        estimated_showdowns,
        hero_range_distribution,
    })
}

/// Precomputed cumulative weight table for weighted combo sampling.
struct WeightedSampler<'a> {
    combos: &'a [WeightedCombo],
    cum_weights: Vec<f64>,
    total_weight: f64,
    is_uniform: bool,
}

impl<'a> WeightedSampler<'a> {
    fn new(combos: &'a [WeightedCombo]) -> Self {
        let first_w = combos.first().map(|c| c.weight).unwrap_or(1.0);
        let is_uniform = combos
            .iter()
            .all(|c| (c.weight - first_w).abs() <= 1e-12);
        let mut cum_weights = Vec::with_capacity(if is_uniform { 0 } else { combos.len() });
        let mut running = 0.0f64;
        if !is_uniform {
            for c in combos {
                running += c.weight;
                cum_weights.push(running);
            }
        } else {
            running = first_w * (combos.len() as f64);
        }
        Self {
            combos,
            cum_weights,
            total_weight: running,
            is_uniform,
        }
    }

    #[inline]
    fn sample_index(&self, rng: &mut DeterministicRng) -> usize {
        if self.combos.len() == 1 {
            return 0;
        }
        if self.is_uniform {
            return rng.gen_index(self.combos.len());
        }
        let u = rng.next_f64() * self.total_weight;
        match self.cum_weights.binary_search_by(|w| w.partial_cmp(&u).unwrap()) {
            Ok(idx) => idx.min(self.combos.len() - 1),
            Err(idx) => idx.min(self.combos.len() - 1),
        }
    }
}

fn mc_multiway_inner(
    v: &ValidatedMultiway,
    board_len: usize,
    samples: usize,
    seed: u64,
    estimated_showdowns: u128,
) -> Result<MultiwayEquityResult, EquityError> {
    let num_opps = v.opp_combos.len();
    let num_players = 1 + num_opps;
    let needed = 5 - board_len;

    let hero_sampler = WeightedSampler::new(&v.hero_combos);
    let opp_samplers: Vec<WeightedSampler<'_>> =
        v.opp_combos.iter().map(|c| WeightedSampler::new(c)).collect();

    let base_remaining: Vec<Card> = (HandMask::FULL_DECK - v.initial_dead_mask).iter().collect();
    let mut scratch_deck: Vec<Card> = Vec::with_capacity(base_remaining.len());

    let mut rng = DeterministicRng::from_seed(seed);

    let mut player_wins = vec![0.0f64; num_players];
    let mut player_ties = vec![0.0f64; num_players];
    let mut player_tie_shares = vec![0.0f64; num_players];
    let mut player_losses = vec![0.0f64; num_players];
    let mut means = vec![0.0f64; num_players];
    let mut m2s = vec![0.0f64; num_players];

    let num_hero = v.hero_combos.len();
    let mut hero_combo_wins = vec![0.0f64; num_hero];
    let mut hero_combo_ties = vec![0.0f64; num_hero];
    let mut hero_combo_eq_w = vec![0.0f64; num_hero];
    let mut hero_combo_total_w = vec![0.0f64; num_hero];

    let mut chosen_opp_indices = [0usize; MAX_MULTIWAY_OPPONENTS];

    for sample_idx in 1..=samples {
        // Independent weighted draw with collision rejection across Hero and Opponents 1..=K.
        let mut h_idx = 0usize;
        let mut deal_hands_mask = HandMask::EMPTY;
        let mut accepted = false;

        for _attempt in 0..MAX_REJECTION_ATTEMPTS_PER_SAMPLE {
            h_idx = hero_sampler.sample_index(&mut rng);
            let h_mask = v.hero_combos[h_idx].mask;
            let mut acc_mask = h_mask;
            let mut ok = true;

            for k in 0..num_opps {
                let o_idx = opp_samplers[k].sample_index(&mut rng);
                let o_mask = v.opp_combos[k][o_idx].mask;
                if acc_mask.overlaps(o_mask) {
                    ok = false;
                    break;
                }
                acc_mask |= o_mask;
                chosen_opp_indices[k] = o_idx;
            }

            if ok {
                deal_hands_mask = acc_mask;
                accepted = true;
                break;
            }
        }

        if !accepted {
            return Err(EquityError::AllRangeCombosBlocked);
        }

        let mut full_board = v.board_mask;
        if needed > 0 {
            scratch_deck.clear();
            for &c in &base_remaining {
                if !deal_hands_mask.contains(c) {
                    scratch_deck.push(c);
                }
            }
            let drawn = rng.sample_cards(&mut scratch_deck, needed);
            for &c in drawn {
                full_board.insert(c);
            }
        }

        let bt = extract_board_triples(full_board);
        let mut ranks = [HandRank(0); 5];
        ranks[0] = eval_omaha_pairs_triples(&v.hero_combos[h_idx].hole_pairs, &bt);
        for k in 0..num_opps {
            let oc = &v.opp_combos[k][chosen_opp_indices[k]];
            ranks[1 + k] = eval_omaha_pairs_triples(&oc.hole_pairs, &bt);
        }

        let mut max_rank = ranks[0];
        for r in &ranks[1..num_players] {
            if *r > max_rank {
                max_rank = *r;
            }
        }
        let mut tie_count = 0usize;
        for r in &ranks[0..num_players] {
            if *r == max_rank {
                tie_count += 1;
            }
        }

        let sample_f = sample_idx as f64;
        let inv_tie = 1.0 / (tie_count as f64);

        for p in 0..num_players {
            let y = if ranks[p] == max_rank {
                if tie_count == 1 {
                    player_wins[p] += 1.0;
                    1.0
                } else {
                    player_ties[p] += 1.0;
                    player_tie_shares[p] += inv_tie;
                    inv_tie
                }
            } else {
                player_losses[p] += 1.0;
                0.0
            };

            let delta = y - means[p];
            means[p] += delta / sample_f;
            let delta2 = y - means[p];
            m2s[p] += delta * delta2;
        }

        hero_combo_total_w[h_idx] += 1.0;
        if ranks[0] == max_rank {
            if tie_count == 1 {
                hero_combo_wins[h_idx] += 1.0;
                hero_combo_eq_w[h_idx] += 1.0;
            } else {
                hero_combo_ties[h_idx] += 1.0;
                hero_combo_eq_w[h_idx] += inv_tie;
            }
        }
    }

    // When Hero is a range of moderate size (<= 512 combos), ensure every unblocked Hero combo
    // has at least a minimum number of conditional samples for the per-combo distribution
    // without altering the unbiased joint `player_*` estimates above.
    if v.hero_is_range && num_hero <= 512 {
        let min_per_combo = 16usize;
        for h_idx in 0..num_hero {
            let have = hero_combo_total_w[h_idx] as usize;
            if have >= min_per_combo {
                continue;
            }
            let h_mask = v.hero_combos[h_idx].mask;
            let h_hp = &v.hero_combos[h_idx].hole_pairs;
            let extra_needed = min_per_combo - have;
            for _ in 0..extra_needed {
                let mut deal_hands_mask = h_mask;
                let mut accepted = false;
                for _attempt in 0..2_000 {
                    let mut acc_mask = h_mask;
                    let mut ok = true;
                    for k in 0..num_opps {
                        let o_idx = opp_samplers[k].sample_index(&mut rng);
                        let o_mask = v.opp_combos[k][o_idx].mask;
                        if acc_mask.overlaps(o_mask) {
                            ok = false;
                            break;
                        }
                        acc_mask |= o_mask;
                        chosen_opp_indices[k] = o_idx;
                    }
                    if ok {
                        deal_hands_mask = acc_mask;
                        accepted = true;
                        break;
                    }
                }
                if !accepted {
                    break;
                }
                let mut full_board = v.board_mask;
                if needed > 0 {
                    scratch_deck.clear();
                    for &c in &base_remaining {
                        if !deal_hands_mask.contains(c) {
                            scratch_deck.push(c);
                        }
                    }
                    let drawn = rng.sample_cards(&mut scratch_deck, needed);
                    for &c in drawn {
                        full_board.insert(c);
                    }
                }
                let bt = extract_board_triples(full_board);
                let h_rank = eval_omaha_pairs_triples(h_hp, &bt);
                let mut max_rank = h_rank;
                let mut opp_ranks = [HandRank(0); MAX_MULTIWAY_OPPONENTS];
                for k in 0..num_opps {
                    let oc = &v.opp_combos[k][chosen_opp_indices[k]];
                    let r = eval_omaha_pairs_triples(&oc.hole_pairs, &bt);
                    opp_ranks[k] = r;
                    if r > max_rank {
                        max_rank = r;
                    }
                }
                hero_combo_total_w[h_idx] += 1.0;
                if h_rank == max_rank {
                    let mut tie_count = 1usize;
                    for r in &opp_ranks[0..num_opps] {
                        if *r == max_rank {
                            tie_count += 1;
                        }
                    }
                    if tie_count == 1 {
                        hero_combo_wins[h_idx] += 1.0;
                        hero_combo_eq_w[h_idx] += 1.0;
                    } else {
                        hero_combo_ties[h_idx] += 1.0;
                        hero_combo_eq_w[h_idx] += 1.0 / (tie_count as f64);
                    }
                }
            }
        }
    }

    let n = samples as f64;
    let mut players = Vec::with_capacity(num_players);
    for p in 0..num_players {
        let win_prob = player_wins[p] / n;
        let tie_prob = player_ties[p] / n;
        let tie_equity = player_tie_shares[p] / n;
        let loss_prob = player_losses[p] / n;
        let equity = win_prob + tie_equity;
        let std_error = if samples > 1 {
            let sample_var = m2s[p] / ((samples - 1) as f64);
            (sample_var / n).sqrt()
        } else {
            0.0
        };
        players.push(PlayerEquity {
            player_index: p,
            equity,
            win_prob,
            tie_prob,
            tie_equity,
            loss_prob,
            wins: player_wins[p],
            ties: player_ties[p],
            tie_share_total: player_tie_shares[p],
            losses: player_losses[p],
            std_error,
        });
    }

    let hero_range_distribution = if v.hero_is_range {
        Some(build_hero_range_distribution(
            &v.hero_combos,
            &hero_combo_wins,
            &hero_combo_ties,
            &hero_combo_eq_w,
            &hero_combo_total_w,
        )?)
    } else {
        None
    };

    Ok(MultiwayEquityResult {
        hero_equity: players[0].equity,
        players,
        total_weight: n,
        mode: EquityMode::MonteCarlo { samples, seed },
        dead_mask: v.initial_dead_mask,
        estimated_showdowns,
        hero_range_distribution,
    })
}

fn canonical_combo_key(cards: [Card; 4]) -> [u8; 4] {
    let mut sorted = cards;
    sort_cards_canonical(&mut sorted);
    [sorted[0].id(), sorted[1].id(), sorted[2].id(), sorted[3].id()]
}

fn build_hero_range_distribution(
    hero_combos: &[WeightedCombo],
    combo_wins: &[f64],
    combo_ties: &[f64],
    combo_eq_w: &[f64],
    combo_total_w: &[f64],
) -> Result<HeroRangeDistribution, EquityError> {
    let mut entries: Vec<ComboEquity> = Vec::with_capacity(hero_combos.len());
    let mut weighted_eq_sum = 0.0f64;
    let mut total_range_weight = 0.0f64;

    for (i, hc) in hero_combos.iter().enumerate() {
        let tot = combo_total_w[i];
        if tot <= 0.0 {
            continue;
        }
        let eq = combo_eq_w[i] / tot;
        let win_prob = combo_wins[i] / tot;
        let tie_prob = combo_ties[i] / tot;
        weighted_eq_sum += hc.weight * eq;
        total_range_weight += hc.weight;
        entries.push(ComboEquity {
            cards: hc.cards,
            weight: hc.weight,
            equity: eq,
            win_prob,
            tie_prob,
        });
    }

    if entries.is_empty() || total_range_weight <= 0.0 {
        return Err(EquityError::AllRangeCombosBlocked);
    }

    let mean = weighted_eq_sum / total_range_weight;

    // Sort ascending by equity, tie-breaking deterministically by canonical card ids.
    entries.sort_by(|a, b| {
        a.equity
            .partial_cmp(&b.equity)
            .unwrap_or(Ordering::Equal)
            .then_with(|| canonical_combo_key(a.cards).cmp(&canonical_combo_key(b.cards)))
    });

    let min = entries.first().unwrap().equity;
    let max = entries.last().unwrap().equity;
    let q25 = weighted_quantile(&entries, total_range_weight, 0.25);
    let median = weighted_quantile(&entries, total_range_weight, 0.50);
    let q75 = weighted_quantile(&entries, total_range_weight, 0.75);

    let m = entries.len();
    let decile_len = m.div_ceil(10).clamp(1, MAX_DECILE_COMBOS).min(m);

    let bottom_decile: Vec<ComboEquity> = entries[..decile_len].to_vec();
    let mut top_decile: Vec<ComboEquity> = entries[(m - decile_len)..].to_vec();
    top_decile.reverse();

    Ok(HeroRangeDistribution {
        combo_count: m,
        total_weight: total_range_weight,
        mean,
        min,
        q25,
        median,
        q75,
        max,
        quartiles: [min, q25, median, q75, max],
        top_decile,
        bottom_decile,
    })
}

/// Computes the weighted quantile at `p` in `[0.0, 1.0]` over `sorted` (ascending by `equity`)
/// using midpoint cumulative weights with linear interpolation. When all weights are equal,
/// this matches standard linear quantile interpolation across `0..=(n - 1)`.
fn weighted_quantile(sorted: &[ComboEquity], total_weight: f64, p: f64) -> f64 {
    let n = sorted.len();
    if n == 0 {
        return 0.0;
    }
    if n == 1 {
        return sorted[0].equity;
    }
    if p <= 0.0 {
        return sorted[0].equity;
    }
    if p >= 1.0 {
        return sorted[n - 1].equity;
    }

    // Check if uniform weights: use standard index interpolation `p * (n - 1)`
    let first_w = sorted[0].weight;
    if sorted.iter().all(|e| (e.weight - first_w).abs() <= 1e-12) {
        let pos = p * ((n - 1) as f64);
        let lo = pos.floor() as usize;
        let hi = pos.ceil() as usize;
        let frac = pos - (lo as f64);
        return sorted[lo].equity + frac * (sorted[hi].equity - sorted[lo].equity);
    }

    let target = p * total_weight;
    let mut cum = 0.0f64;
    let mut prev_mid = 0.0f64;
    let mut prev_eq = sorted[0].equity;

    for (idx, item) in sorted.iter().enumerate() {
        let mid = cum + 0.5 * item.weight;
        if target <= mid {
            if idx == 0 || (mid - prev_mid).abs() <= 1e-15 {
                return item.equity;
            }
            let t = (target - prev_mid) / (mid - prev_mid);
            return prev_eq + t * (item.equity - prev_eq);
        }
        prev_mid = mid;
        prev_eq = item.equity;
        cum += item.weight;
    }

    sorted[n - 1].equity
}

/// Default RNG seed for multiway Monte Carlo simulation (matches [`DEFAULT_MC_SEED`]).
pub const DEFAULT_MULTIWAY_MC_SEED: u64 = DEFAULT_MC_SEED;
