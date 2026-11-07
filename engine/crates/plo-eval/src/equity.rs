//! Heads-up Pot Limit Omaha equity calculator supporting both hand-vs-hand and hand-vs-range
//! (weighted 4-card combinations), with exact board runout enumeration (flop/turn/river)
//! and deterministic fixed-seed Monte Carlo simulation (preflop or any street) with standard error.

use std::cmp::Ordering;
use std::fmt;

use plo_cards::{Card, CardParseError, HandMask};

use crate::omaha::{eval_omaha_pairs_triples, extract_board_triples, extract_hole_pairs};
use crate::rng::DeterministicRng;

/// A weighted 4-card PLO hand combination inside a [`PloRange`].
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct WeightedCombo {
    pub cards: [Card; 4],
    pub mask: HandMask,
    pub hole_pairs: [u64; 6],
    pub weight: f64,
}

impl WeightedCombo {
    /// Creates a new [`WeightedCombo`] from 4 distinct cards and a positive weight.
    pub fn new(cards: [Card; 4], weight: f64) -> Result<Self, EquityError> {
        let mask = HandMask::from_cards(&cards);
        if mask.count() != 4 {
            return Err(EquityError::InvalidHandCardCount(mask.count() as usize));
        }
        if !weight.is_finite() || weight <= 0.0 {
            return Err(EquityError::InvalidWeight(weight));
        }
        Ok(Self {
            cards,
            mask,
            hole_pairs: extract_hole_pairs(mask),
            weight,
        })
    }

    /// Parses a [`WeightedCombo`] from a 4-card string (e.g. `"As Ks Qh Jh"`) and a weight.
    pub fn from_str_weight(s: &str, weight: f64) -> Result<Self, EquityError> {
        let cards = Card::parse_n::<4>(s).map_err(EquityError::ParseError)?;
        Self::new(cards, weight)
    }
}

/// A weighted range of 4-card PLO combinations.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PloRange {
    combos: Vec<WeightedCombo>,
}

impl PloRange {
    /// Creates an empty [`PloRange`].
    pub fn new() -> Self {
        Self { combos: Vec::new() }
    }

    /// Creates a [`PloRange`] from a list of `(cards, weight)` pairs.
    pub fn from_weighted_hands(items: &[([Card; 4], f64)]) -> Result<Self, EquityError> {
        let mut combos = Vec::with_capacity(items.len());
        for &(cards, weight) in items {
            combos.push(WeightedCombo::new(cards, weight)?);
        }
        if combos.is_empty() {
            return Err(EquityError::EmptyRange);
        }
        Ok(Self { combos })
    }

    /// Creates a [`PloRange`] from a list of `(hand_str, weight)` pairs.
    pub fn from_str_specs(specs: &[(&str, f64)]) -> Result<Self, EquityError> {
        let mut combos = Vec::with_capacity(specs.len());
        for &(s, weight) in specs {
            combos.push(WeightedCombo::from_str_weight(s, weight)?);
        }
        if combos.is_empty() {
            return Err(EquityError::EmptyRange);
        }
        Ok(Self { combos })
    }

    /// Adds a weighted 4-card hand to the range.
    pub fn push(&mut self, cards: [Card; 4], weight: f64) -> Result<(), EquityError> {
        self.combos.push(WeightedCombo::new(cards, weight)?);
        Ok(())
    }

    /// Returns the combinations in this range.
    #[inline]
    pub fn combos(&self) -> &[WeightedCombo] {
        &self.combos
    }

    /// Returns the number of combinations in this range.
    #[inline]
    pub fn len(&self) -> usize {
        self.combos.len()
    }

    /// Returns `true` if the range has no combinations.
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.combos.is_empty()
    }
}

/// Execution mode for equity calculation.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum EquityMode {
    /// Exact deterministic enumeration of all possible remaining board runouts.
    Exact,
    /// Monte Carlo simulation with a fixed number of random samples and deterministic RNG seed.
    MonteCarlo { samples: usize, seed: u64 },
}

impl fmt::Display for EquityMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EquityMode::Exact => write!(f, "Exact Enumeration"),
            EquityMode::MonteCarlo { samples, seed } => {
                write!(f, "Monte Carlo (samples={samples}, seed=0x{seed:016x})")
            }
        }
    }
}

/// Result of a heads-up equity computation.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct EquityResult {
    /// Hero's overall equity in `[0.0, 1.0]` (`win_prob + 0.5 * tie_prob`).
    pub equity: f64,
    /// Villain's overall equity in `[0.0, 1.0]` (`1.0 - equity`).
    pub villain_equity: f64,
    /// Hero's win probability (`wins / total_weight`).
    pub win_prob: f64,
    /// Split-pot tie probability (`ties / total_weight`).
    pub tie_prob: f64,
    /// Hero's loss probability (`losses / total_weight`).
    pub loss_prob: f64,
    /// Raw weighted win total (exact runout count when weights are 1.0 in `Exact` mode).
    pub wins: f64,
    /// Raw weighted tie total.
    pub ties: f64,
    /// Raw weighted loss total.
    pub losses: f64,
    /// Total weight / runouts evaluated.
    pub total_weight: f64,
    /// Standard error of the `equity` estimate (`0.0` for `Exact`, $\sqrt{s^2 / N}$ for `MonteCarlo`).
    pub std_error: f64,
    /// Calculation mode used (`Exact` or `MonteCarlo`).
    pub mode: EquityMode,
}

impl EquityResult {
    /// Returns `true` if this result was computed via exact enumeration.
    #[inline]
    pub const fn is_exact(&self) -> bool {
        matches!(self.mode, EquityMode::Exact)
    }

    /// Returns `true` if this result was computed via Monte Carlo sampling.
    #[inline]
    pub const fn is_monte_carlo(&self) -> bool {
        matches!(self.mode, EquityMode::MonteCarlo { .. })
    }
}

impl fmt::Display for EquityResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.mode {
            EquityMode::Exact => write!(
                f,
                "[Exact] Hero Eq: {:.4}% (Win: {:.4}%, Tie: {:.4}%, Loss: {:.4}%, Weight: {:.1})",
                self.equity * 100.0,
                self.win_prob * 100.0,
                self.tie_prob * 100.0,
                self.loss_prob * 100.0,
                self.total_weight
            ),
            EquityMode::MonteCarlo { samples, seed } => write!(
                f,
                "[MC N={} seed=0x{:x}] Hero Eq: {:.4}% ± {:.4}% SE (Win: {:.4}%, Tie: {:.4}%, Loss: {:.4}%)",
                samples,
                seed,
                self.equity * 100.0,
                self.std_error * 100.0,
                self.win_prob * 100.0,
                self.tie_prob * 100.0,
                self.loss_prob * 100.0
            ),
        }
    }
}

/// Errors that can occur during equity computation.
#[derive(Clone, Debug, PartialEq)]
pub enum EquityError {
    ParseError(CardParseError),
    InvalidHandCardCount(usize),
    InvalidBoardCardCount(usize),
    CardCollision,
    EmptyRange,
    AllRangeCombosBlocked,
    InvalidWeight(f64),
    ZeroMonteCarloSamples,
}

impl fmt::Display for EquityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EquityError::ParseError(e) => write!(f, "card parse error: {e}"),
            EquityError::InvalidHandCardCount(n) => {
                write!(f, "PLO hand must have 4 distinct cards, got {n}")
            }
            EquityError::InvalidBoardCardCount(n) => {
                write!(f, "board must have between 0 and 5 distinct cards, got {n}")
            }
            EquityError::CardCollision => {
                write!(f, "duplicate/colliding cards between hands and/or board")
            }
            EquityError::EmptyRange => write!(f, "range must contain at least one combo"),
            EquityError::AllRangeCombosBlocked => {
                write!(f, "all combos in villain range are blocked by dead cards")
            }
            EquityError::InvalidWeight(w) => write!(f, "invalid combo weight: {w}"),
            EquityError::ZeroMonteCarloSamples => {
                write!(f, "Monte Carlo samples must be greater than 0")
            }
        }
    }
}

impl std::error::Error for EquityError {}

impl From<CardParseError> for EquityError {
    fn from(e: CardParseError) -> Self {
        EquityError::ParseError(e)
    }
}

/// Default number of Monte Carlo samples when auto-selecting preflop mode.
pub const DEFAULT_PREFLOP_MC_SAMPLES: usize = 100_000;
/// Default RNG seed when auto-selecting preflop mode.
pub const DEFAULT_MC_SEED: u64 = 0x504C_4F5F_4531_5344; // "PLO_E1SD"

/// Selects the standard [`EquityMode`] for a given initial board length:
/// - River (5 cards), Turn (4 cards), Flop (3 cards): [`EquityMode::Exact`]
/// - Preflop (0 cards): [`EquityMode::MonteCarlo`] with `mc_samples` and `seed`.
#[inline]
pub const fn default_mode_for_board(
    board_len: usize,
    mc_samples: usize,
    seed: u64,
) -> EquityMode {
    if board_len >= 3 {
        EquityMode::Exact
    } else {
        EquityMode::MonteCarlo {
            samples: mc_samples,
            seed,
        }
    }
}

/// Computes heads-up hand-vs-hand equity using the specified [`EquityMode`].
///
/// Validates that `hero`, `villain`, and `board` have no overlapping cards.
pub fn compute_hand_vs_hand_equity(
    hero: [Card; 4],
    villain: [Card; 4],
    board: &[Card],
    mode: EquityMode,
) -> Result<EquityResult, EquityError> {
    let hero_mask = HandMask::from_cards(&hero);
    if hero_mask.count() != 4 {
        return Err(EquityError::InvalidHandCardCount(hero_mask.count() as usize));
    }
    let villain_mask = HandMask::from_cards(&villain);
    if villain_mask.count() != 4 {
        return Err(EquityError::InvalidHandCardCount(
            villain_mask.count() as usize,
        ));
    }
    if board.len() > 5 {
        return Err(EquityError::InvalidBoardCardCount(board.len()));
    }
    let board_mask = HandMask::from_cards(board);
    if board_mask.count() as usize != board.len() {
        return Err(EquityError::CardCollision);
    }
    if hero_mask.overlaps(villain_mask)
        || hero_mask.overlaps(board_mask)
        || villain_mask.overlaps(board_mask)
    {
        return Err(EquityError::CardCollision);
    }

    match mode {
        EquityMode::Exact => Ok(exact_hand_vs_hand_inner(
            hero_mask,
            villain_mask,
            board_mask,
            board.len(),
        )),
        EquityMode::MonteCarlo { samples, seed } => {
            if samples == 0 {
                return Err(EquityError::ZeroMonteCarloSamples);
            }
            Ok(mc_hand_vs_hand_inner(
                hero_mask,
                villain_mask,
                board_mask,
                board.len(),
                samples,
                seed,
            ))
        }
    }
}

/// Computes heads-up hand-vs-hand equity, automatically choosing [`EquityMode::Exact`] on
/// flop/turn/river (`board.len() >= 3`) and [`EquityMode::MonteCarlo`] preflop.
pub fn compute_hand_vs_hand_auto(
    hero: [Card; 4],
    villain: [Card; 4],
    board: &[Card],
    mc_samples: usize,
    seed: u64,
) -> Result<EquityResult, EquityError> {
    let mode = default_mode_for_board(board.len(), mc_samples, seed);
    compute_hand_vs_hand_equity(hero, villain, board, mode)
}

/// Computes heads-up hand-vs-range equity using the specified [`EquityMode`],
/// applying full card removal against `hero`, the initial `board`, and all board runout cards.
pub fn compute_hand_vs_range_equity(
    hero: [Card; 4],
    villain_range: &PloRange,
    board: &[Card],
    mode: EquityMode,
) -> Result<EquityResult, EquityError> {
    if villain_range.is_empty() {
        return Err(EquityError::EmptyRange);
    }
    let hero_mask = HandMask::from_cards(&hero);
    if hero_mask.count() != 4 {
        return Err(EquityError::InvalidHandCardCount(hero_mask.count() as usize));
    }
    if board.len() > 5 {
        return Err(EquityError::InvalidBoardCardCount(board.len()));
    }
    let board_mask = HandMask::from_cards(board);
    if board_mask.count() as usize != board.len() {
        return Err(EquityError::CardCollision);
    }
    if hero_mask.overlaps(board_mask) {
        return Err(EquityError::CardCollision);
    }

    // Filter out Villain combos that collide with Hero's hole cards or the known board cards.
    let dead_initial = hero_mask | board_mask;
    let active_combos: Vec<WeightedCombo> = villain_range
        .combos()
        .iter()
        .copied()
        .filter(|c| !c.mask.overlaps(dead_initial))
        .collect();

    if active_combos.is_empty() {
        return Err(EquityError::AllRangeCombosBlocked);
    }

    match mode {
        EquityMode::Exact => Ok(exact_hand_vs_range_inner(
            hero_mask,
            &active_combos,
            board_mask,
            board.len(),
        )),
        EquityMode::MonteCarlo { samples, seed } => {
            if samples == 0 {
                return Err(EquityError::ZeroMonteCarloSamples);
            }
            Ok(mc_hand_vs_range_inner(
                hero_mask,
                &active_combos,
                board_mask,
                board.len(),
                samples,
                seed,
            ))
        }
    }
}

/// Computes heads-up hand-vs-range equity, automatically choosing [`EquityMode::Exact`] on
/// flop/turn/river (`board.len() >= 3`) and [`EquityMode::MonteCarlo`] preflop.
pub fn compute_hand_vs_range_auto(
    hero: [Card; 4],
    villain_range: &PloRange,
    board: &[Card],
    mc_samples: usize,
    seed: u64,
) -> Result<EquityResult, EquityError> {
    let mode = default_mode_for_board(board.len(), mc_samples, seed);
    compute_hand_vs_range_equity(hero, villain_range, board, mode)
}

fn exact_hand_vs_hand_inner(
    hero_mask: HandMask,
    villain_mask: HandMask,
    board_mask: HandMask,
    board_len: usize,
) -> EquityResult {
    let hero_hp = extract_hole_pairs(hero_mask);
    let villain_hp = extract_hole_pairs(villain_mask);
    let dead = hero_mask | villain_mask | board_mask;
    let remaining: Vec<Card> = (HandMask::FULL_DECK - dead).iter().collect();
    let needed = 5 - board_len;

    let mut wins = 0u64;
    let mut ties = 0u64;
    let mut losses = 0u64;

    enumerate_runouts(&remaining, needed, board_mask, &mut |full_board| {
        let bt = extract_board_triples(full_board);
        let h_rank = eval_omaha_pairs_triples(&hero_hp, &bt);
        let v_rank = eval_omaha_pairs_triples(&villain_hp, &bt);
        match h_rank.cmp(&v_rank) {
            Ordering::Greater => wins += 1,
            Ordering::Less => losses += 1,
            Ordering::Equal => ties += 1,
        }
    });

    let total = (wins + ties + losses) as f64;
    let wins_f = wins as f64;
    let ties_f = ties as f64;
    let losses_f = losses as f64;
    let win_prob = wins_f / total;
    let tie_prob = ties_f / total;
    let loss_prob = losses_f / total;
    let equity = (wins_f + 0.5 * ties_f) / total;

    EquityResult {
        equity,
        villain_equity: 1.0 - equity,
        win_prob,
        tie_prob,
        loss_prob,
        wins: wins_f,
        ties: ties_f,
        losses: losses_f,
        total_weight: total,
        std_error: 0.0,
        mode: EquityMode::Exact,
    }
}

fn exact_hand_vs_range_inner(
    hero_mask: HandMask,
    active_combos: &[WeightedCombo],
    board_mask: HandMask,
    board_len: usize,
) -> EquityResult {
    let hero_hp = extract_hole_pairs(hero_mask);
    let dead = hero_mask | board_mask;
    let remaining: Vec<Card> = (HandMask::FULL_DECK - dead).iter().collect();
    let needed = 5 - board_len;

    let mut wins = 0.0f64;
    let mut ties = 0.0f64;
    let mut losses = 0.0f64;

    enumerate_runouts(&remaining, needed, board_mask, &mut |full_board| {
        let bt = extract_board_triples(full_board);
        let h_rank = eval_omaha_pairs_triples(&hero_hp, &bt);

        for combo in active_combos {
            // Card-removal check against the newly dealt runout cards
            if combo.mask.overlaps(full_board) {
                continue;
            }
            let v_rank = eval_omaha_pairs_triples(&combo.hole_pairs, &bt);
            match h_rank.cmp(&v_rank) {
                Ordering::Greater => wins += combo.weight,
                Ordering::Less => losses += combo.weight,
                Ordering::Equal => ties += combo.weight,
            }
        }
    });

    let total = wins + ties + losses;
    let win_prob = wins / total;
    let tie_prob = ties / total;
    let loss_prob = losses / total;
    let equity = (wins + 0.5 * ties) / total;

    EquityResult {
        equity,
        villain_equity: 1.0 - equity,
        win_prob,
        tie_prob,
        loss_prob,
        wins,
        ties,
        losses,
        total_weight: total,
        std_error: 0.0,
        mode: EquityMode::Exact,
    }
}

fn mc_hand_vs_hand_inner(
    hero_mask: HandMask,
    villain_mask: HandMask,
    board_mask: HandMask,
    board_len: usize,
    samples: usize,
    seed: u64,
) -> EquityResult {
    let hero_hp = extract_hole_pairs(hero_mask);
    let villain_hp = extract_hole_pairs(villain_mask);
    let dead = hero_mask | villain_mask | board_mask;
    let mut deck: Vec<Card> = (HandMask::FULL_DECK - dead).iter().collect();
    let needed = 5 - board_len;

    let mut rng = DeterministicRng::from_seed(seed);
    let mut wins = 0u64;
    let mut ties = 0u64;
    let mut losses = 0u64;

    // Welford's online algorithm for sample variance of outcome Y_i in {0.0, 0.5, 1.0}
    let mut mean = 0.0f64;
    let mut m2 = 0.0f64;

    for i in 1..=samples {
        let drawn = rng.sample_cards(&mut deck, needed);
        let mut full_board = board_mask;
        for &c in drawn {
            full_board.insert(c);
        }
        let bt = extract_board_triples(full_board);
        let h_rank = eval_omaha_pairs_triples(&hero_hp, &bt);
        let v_rank = eval_omaha_pairs_triples(&villain_hp, &bt);

        let y = match h_rank.cmp(&v_rank) {
            Ordering::Greater => {
                wins += 1;
                1.0
            }
            Ordering::Less => {
                losses += 1;
                0.0
            }
            Ordering::Equal => {
                ties += 1;
                0.5
            }
        };

        let delta = y - mean;
        mean += delta / (i as f64);
        let delta2 = y - mean;
        m2 += delta * delta2;
    }

    let n = samples as f64;
    let wins_f = wins as f64;
    let ties_f = ties as f64;
    let losses_f = losses as f64;
    let equity = (wins_f + 0.5 * ties_f) / n;
    let std_error = if samples > 1 {
        let sample_var = m2 / ((samples - 1) as f64);
        (sample_var / n).sqrt()
    } else {
        0.0
    };

    EquityResult {
        equity,
        villain_equity: 1.0 - equity,
        win_prob: wins_f / n,
        tie_prob: ties_f / n,
        loss_prob: losses_f / n,
        wins: wins_f,
        ties: ties_f,
        losses: losses_f,
        total_weight: n,
        std_error,
        mode: EquityMode::MonteCarlo { samples, seed },
    }
}

fn mc_hand_vs_range_inner(
    hero_mask: HandMask,
    active_combos: &[WeightedCombo],
    board_mask: HandMask,
    board_len: usize,
    samples: usize,
    seed: u64,
) -> EquityResult {
    let hero_hp = extract_hole_pairs(hero_mask);
    let needed = 5 - board_len;

    // Build cumulative weight distribution over unblocked Villain combos.
    // Because every unblocked Villain combo has the exact same number of valid board runouts
    // C(44 - board_len, 5 - board_len), sampling a combo proportionally to its weight and then
    // sampling `5 - board_len` cards uniformly from the remaining `44 - board_len` cards is
    // an exact, unbiased i.i.d. sampler of the joint (combo, board) distribution.
    let mut cum_weights = Vec::with_capacity(active_combos.len());
    let mut running = 0.0f64;
    for c in active_combos {
        running += c.weight;
        cum_weights.push(running);
    }
    let total_combo_weight = running;

    // Pre-build remaining deck for each active combo (or filter from hero+board deck).
    let base_remaining: Vec<Card> = (HandMask::FULL_DECK - (hero_mask | board_mask))
        .iter()
        .collect();
    let mut scratch_deck = Vec::with_capacity(base_remaining.len());

    let mut rng = DeterministicRng::from_seed(seed);
    let mut wins = 0u64;
    let mut ties = 0u64;
    let mut losses = 0u64;

    let mut mean = 0.0f64;
    let mut m2 = 0.0f64;

    for i in 1..=samples {
        // Sample Villain combo proportionally to weight
        let u = rng.next_f64() * total_combo_weight;
        let combo_idx = match cum_weights.binary_search_by(|w| w.partial_cmp(&u).unwrap()) {
            Ok(idx) => idx.min(active_combos.len() - 1),
            Err(idx) => idx.min(active_combos.len() - 1),
        };
        let combo = &active_combos[combo_idx];

        scratch_deck.clear();
        for &c in &base_remaining {
            if !combo.mask.contains(c) {
                scratch_deck.push(c);
            }
        }

        let drawn = rng.sample_cards(&mut scratch_deck, needed);
        let mut full_board = board_mask;
        for &c in drawn {
            full_board.insert(c);
        }

        let bt = extract_board_triples(full_board);
        let h_rank = eval_omaha_pairs_triples(&hero_hp, &bt);
        let v_rank = eval_omaha_pairs_triples(&combo.hole_pairs, &bt);

        let y = match h_rank.cmp(&v_rank) {
            Ordering::Greater => {
                wins += 1;
                1.0
            }
            Ordering::Less => {
                losses += 1;
                0.0
            }
            Ordering::Equal => {
                ties += 1;
                0.5
            }
        };

        let delta = y - mean;
        mean += delta / (i as f64);
        let delta2 = y - mean;
        m2 += delta * delta2;
    }

    let n = samples as f64;
    let wins_f = wins as f64;
    let ties_f = ties as f64;
    let losses_f = losses as f64;
    let equity = (wins_f + 0.5 * ties_f) / n;
    let std_error = if samples > 1 {
        let sample_var = m2 / ((samples - 1) as f64);
        (sample_var / n).sqrt()
    } else {
        0.0
    };

    EquityResult {
        equity,
        villain_equity: 1.0 - equity,
        win_prob: wins_f / n,
        tie_prob: ties_f / n,
        loss_prob: losses_f / n,
        wins: wins_f,
        ties: ties_f,
        losses: losses_f,
        total_weight: n,
        std_error,
        mode: EquityMode::MonteCarlo { samples, seed },
    }
}

/// Enumerates all $\binom{\text{remaining.len()}}{\text{needed}}$ board runouts and invokes `f(full_board)`.
/// Special-cases `needed == 0`, `1`, and `2` (river, turn, flop) with tight nested loops.
#[inline]
pub fn enumerate_runouts<F>(remaining: &[Card], needed: usize, board_mask: HandMask, f: &mut F)
where
    F: FnMut(HandMask),
{
    let n = remaining.len();
    match needed {
        0 => {
            f(board_mask);
        }
        1 => {
            for i in 0..n {
                f(board_mask.with(remaining[i]));
            }
        }
        2 => {
            for i in 0..n {
                let b1 = board_mask.with(remaining[i]);
                for j in (i + 1)..n {
                    f(b1.with(remaining[j]));
                }
            }
        }
        3 => {
            for i in 0..n {
                let b1 = board_mask.with(remaining[i]);
                for j in (i + 1)..n {
                    let b2 = b1.with(remaining[j]);
                    for k in (j + 1)..n {
                        f(b2.with(remaining[k]));
                    }
                }
            }
        }
        _ => {
            enumerate_recursive(remaining, 0, needed, board_mask, f);
        }
    }
}

fn enumerate_recursive<F>(
    remaining: &[Card],
    start: usize,
    needed: usize,
    current_board: HandMask,
    f: &mut F,
) where
    F: FnMut(HandMask),
{
    if needed == 0 {
        f(current_board);
        return;
    }
    let limit = remaining.len() - needed;
    for i in start..=limit {
        enumerate_recursive(
            remaining,
            i + 1,
            needed - 1,
            current_board.with(remaining[i]),
            f,
        );
    }
}
