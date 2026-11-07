//! River game definition, pot-limit legality rules, and action-tree construction.

use std::fmt;

use plo_cards::{Card, CardParseError, HandMask};
use plo_eval::{eval_omaha_pairs_triples, extract_board_triples, EquityError, HandRank, PloRange, WeightedCombo};

/// Tolerance for floating-point comparisons in chip and pot-limit calculations.
pub const CHIP_EPS: f64 = 1e-6;

/// Player identifier in a heads-up river game.
#[repr(u8)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum Player {
    /// Out-of-position player (acts first on the river).
    Oop = 0,
    /// In-position player (acts second on the river).
    Ip = 1,
}

impl Player {
    /// Returns `0` for `Oop` and `1` for `Ip`.
    #[inline]
    pub const fn index(self) -> usize {
        self as usize
    }

    /// Returns the opposing player.
    #[inline]
    pub const fn opponent(self) -> Self {
        match self {
            Player::Oop => Player::Ip,
            Player::Ip => Player::Oop,
        }
    }

    /// Returns `"OOP"` or `"IP"`.
    #[inline]
    pub const fn as_str(self) -> &'static str {
        match self {
            Player::Oop => "OOP",
            Player::Ip => "IP",
        }
    }
}

impl fmt::Display for Player {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Configuration for building the river betting action tree.
#[derive(Clone, Debug, PartialEq)]
pub struct TreeConfig {
    /// Bet size menu as fractions of the pot when facing no bet (default: `[0.33, 0.75, 1.0]`).
    pub bet_sizes: Vec<f64>,
    /// Whether to include an all-in bet when legal under pot-limit rules (default: `true`).
    pub include_all_in_bet: bool,
    /// Raise size menu as fractions of `pot_after_call` (default: `[1.0]`, i.e., pot-sized raise).
    pub raise_sizes: Vec<f64>,
    /// Whether to include an all-in raise when legal under pot-limit rules (default: `true`).
    pub include_all_in_raise: bool,
    /// Maximum number of raises allowed on the street after the initial bet (default: `2`).
    pub max_raises: usize,
}

impl Default for TreeConfig {
    fn default() -> Self {
        Self {
            bet_sizes: vec![0.33, 0.75, 1.0],
            include_all_in_bet: true,
            raise_sizes: vec![1.0],
            include_all_in_raise: true,
            max_raises: 2,
        }
    }
}

/// Exact pot-limit betting/raising bounds at a river decision state.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct PotLimitBounds {
    /// Chips needed by the acting player to match the opponent's river commitment (`opp_committed - actor_committed`).
    pub to_call: f64,
    /// Total pot before the acting player acts (`starting_pot + actor_committed + opp_committed`).
    pub current_pot: f64,
    /// Total pot after the acting player calls (`current_pot + to_call = starting_pot + 2 * opp_committed`).
    pub pot_after_call: f64,
    /// Remaining stack behind for the acting player (`effective_stack - actor_committed`).
    pub remaining_stack: f64,
    /// Maximum raise increment above `opp_committed` allowed by the pot-limit rule (`pot_after_call`), before stack cap.
    pub pot_limit_max_raise_by: f64,
    /// Maximum total street commitment allowed by the pot-limit rule (`opp_committed + pot_after_call`), before stack cap.
    pub pot_limit_max_to: f64,
    /// Full minimum raise target (`opp_committed + last_bet_or_raise_delta`) before clamping to `effective_stack`.
    pub unclamped_min_to: f64,
    /// Minimum legal total street commitment (`min(effective_stack, unclamped_min_to)`).
    pub min_legal_to: f64,
    /// Maximum legal total street commitment (`min(effective_stack, pot_limit_max_to)`).
    pub max_legal_to: f64,
    /// Maximum legal raise increment above `opp_committed` (`max_legal_to - opp_committed`).
    pub max_legal_raise_by: f64,
    /// Whether the acting player is allowed to make a bet (when `to_call == 0`) or a raise (when `to_call > 0`).
    pub can_bet_or_raise: bool,
    /// Whether going all-in (`to = effective_stack`) is legal under pot-limit and raise-cap rules.
    pub can_all_in: bool,
}

/// Computes exact Pot-Limit legality bounds for a decision state on the river.
///
/// Rules enforced:
/// 1. When `to_call == 0` (opening action):
///    - `pot_after_call = starting_pot`.
///    - Pot-limit max bet is `pot_limit_max_to = starting_pot`.
///    - Effective max legal bet is `min(effective_stack, starting_pot)`.
///    - All-in (`effective_stack`) is legal iff `0 < effective_stack <= starting_pot`.
/// 2. When `to_call > 0` (facing a bet or raise to `opp_committed`):
///    - Calling puts `to_call = opp_committed - actor_committed` into the pot, making
///      `pot_after_call = starting_pot + 2 * opp_committed`.
///    - Pot-limit max raise *by* (above `opp_committed`) is `pot_after_call`, so
///      `pot_limit_max_to = opp_committed + pot_after_call = starting_pot + 3 * opp_committed`.
///    - Min-raise rule: a non-all-in raise must increase the commitment by at least
///      `last_bet_or_raise_delta` (the size of the previous bet or raise), giving
///      `unclamped_min_to = opp_committed + last_bet_or_raise_delta`.
///    - Stack cap: a raise may not exceed `effective_stack`. If `opp_committed < effective_stack < unclamped_min_to`,
///      the player cannot make a standard raise but may still go all-in (`min_legal_to = effective_stack`).
///    - All-in (`effective_stack`) is legal iff `raises_so_far < max_raises`,
///      `effective_stack > opp_committed`, and `effective_stack <= pot_limit_max_to`.
pub fn compute_pot_limit_bounds(
    starting_pot: f64,
    effective_stack: f64,
    actor_committed: f64,
    opp_committed: f64,
    last_bet_or_raise_delta: f64,
    raises_so_far: usize,
    max_raises: usize,
) -> PotLimitBounds {
    let to_call = (opp_committed - actor_committed).max(0.0);
    let current_pot = starting_pot + actor_committed + opp_committed;
    let pot_after_call = current_pot + to_call;
    let remaining_stack = (effective_stack - actor_committed).max(0.0);
    let pot_limit_max_raise_by = pot_after_call;
    let pot_limit_max_to = opp_committed + pot_after_call;
    let max_legal_to = effective_stack.min(pot_limit_max_to);
    let max_legal_raise_by = (max_legal_to - opp_committed).max(0.0);

    if to_call <= CHIP_EPS {
        // Opening bet situation (no bet facing)
        let can_bet = effective_stack > opp_committed + CHIP_EPS && max_legal_to > CHIP_EPS;
        let can_all_in = can_bet && effective_stack <= pot_limit_max_to + CHIP_EPS;
        PotLimitBounds {
            to_call: 0.0,
            current_pot,
            pot_after_call,
            remaining_stack,
            pot_limit_max_raise_by,
            pot_limit_max_to,
            unclamped_min_to: 0.0,
            min_legal_to: 0.0,
            max_legal_to,
            max_legal_raise_by,
            can_bet_or_raise: can_bet,
            can_all_in,
        }
    } else {
        // Facing a bet or raise
        let min_delta = last_bet_or_raise_delta.max(to_call);
        let unclamped_min_to = opp_committed + min_delta;
        let can_raise = raises_so_far < max_raises
            && effective_stack > opp_committed + CHIP_EPS
            && max_legal_to > opp_committed + CHIP_EPS;
        let min_legal_to = if can_raise {
            effective_stack.min(unclamped_min_to).min(max_legal_to)
        } else {
            max_legal_to
        };
        let can_all_in = can_raise && effective_stack <= pot_limit_max_to + CHIP_EPS;
        PotLimitBounds {
            to_call,
            current_pot,
            pot_after_call,
            remaining_stack,
            pot_limit_max_raise_by,
            pot_limit_max_to,
            unclamped_min_to,
            min_legal_to,
            max_legal_to,
            max_legal_raise_by,
            can_bet_or_raise: can_raise,
            can_all_in,
        }
    }
}

/// Computes the sorted, deduplicated list of legal `(bet_to, is_all_in)` sizes when opening the betting.
pub fn legal_bet_sizes(
    starting_pot: f64,
    effective_stack: f64,
    config: &TreeConfig,
) -> Vec<(f64, bool)> {
    let bounds = compute_pot_limit_bounds(
        starting_pot,
        effective_stack,
        0.0,
        0.0,
        0.0,
        0,
        config.max_raises,
    );
    if !bounds.can_bet_or_raise {
        return Vec::new();
    }

    let mut raw: Vec<f64> = Vec::new();
    for &frac in &config.bet_sizes {
        if !frac.is_finite() || frac <= 0.0 {
            continue;
        }
        let target_to = frac * bounds.pot_after_call;
        // Enforce pot-limit cap and stack cap strictly:
        if target_to <= bounds.pot_limit_max_to + CHIP_EPS
            && target_to <= effective_stack + CHIP_EPS
            && target_to > CHIP_EPS
        {
            raw.push(target_to.min(bounds.max_legal_to));
        }
    }

    if config.include_all_in_bet && bounds.can_all_in {
        raw.push(effective_stack);
    }

    dedup_and_tag_all_in(raw, effective_stack)
}

/// Computes the sorted, deduplicated list of legal `(raise_to, is_all_in)` total street commitments
/// when facing a bet or raise.
pub fn legal_raise_sizes(
    starting_pot: f64,
    effective_stack: f64,
    actor_committed: f64,
    opp_committed: f64,
    last_bet_or_raise_delta: f64,
    raises_so_far: usize,
    config: &TreeConfig,
) -> Vec<(f64, bool)> {
    let bounds = compute_pot_limit_bounds(
        starting_pot,
        effective_stack,
        actor_committed,
        opp_committed,
        last_bet_or_raise_delta,
        raises_so_far,
        config.max_raises,
    );
    if !bounds.can_bet_or_raise {
        return Vec::new();
    }

    let mut raw: Vec<f64> = Vec::new();
    for &frac in &config.raise_sizes {
        if !frac.is_finite() || frac <= 0.0 {
            continue;
        }
        let raise_by = frac * bounds.pot_after_call;
        let target_to = opp_committed + raise_by;
        // Must not exceed pot-limit max, must not exceed stack, and must satisfy min-raise rule:
        if target_to <= bounds.pot_limit_max_to + CHIP_EPS
            && target_to <= effective_stack + CHIP_EPS
            && target_to + CHIP_EPS >= bounds.unclamped_min_to
        {
            raw.push(target_to.min(bounds.max_legal_to));
        }
    }

    if config.include_all_in_raise && bounds.can_all_in {
        raw.push(effective_stack);
    }

    dedup_and_tag_all_in(raw, effective_stack)
}

fn dedup_and_tag_all_in(mut sizes: Vec<f64>, effective_stack: f64) -> Vec<(f64, bool)> {
    sizes.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut out: Vec<(f64, bool)> = Vec::with_capacity(sizes.len());
    for s in sizes {
        let is_all_in = (s - effective_stack).abs() <= CHIP_EPS;
        let clamped = if is_all_in { effective_stack } else { s };
        if let Some((last_s, last_ai)) = out.last_mut() {
            if (clamped - *last_s).abs() <= 1e-5 {
                if is_all_in {
                    *last_s = effective_stack;
                    *last_ai = true;
                }
                continue;
            }
        }
        out.push((clamped, is_all_in));
    }
    out
}

/// A player action at a decision node on the river.
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum Action {
    /// Check (when `to_call == 0`).
    Check,
    /// Bet to `to` chips on the river (when `to_call == 0`).
    Bet { to: f64, is_all_in: bool },
    /// Fold (when `to_call > 0`).
    Fold,
    /// Call `call_amount` chips to match `to = opp_committed` (when `to_call > 0`).
    Call { to: f64, call_amount: f64 },
    /// Raise to `to` total chips committed on the river, adding `raise_by` above `opp_committed`.
    Raise {
        to: f64,
        raise_by: f64,
        is_all_in: bool,
    },
}

impl Action {
    /// Short human-readable label for this action (e.g., `"Check"`, `"Bet(75.00)"`, `"RaiseAllIn(200.00)"`).
    pub fn label(&self) -> String {
        match *self {
            Action::Check => "Check".to_string(),
            Action::Bet { to, is_all_in } => {
                if is_all_in {
                    format!("BetAllIn({})", format_chip(to))
                } else {
                    format!("Bet({})", format_chip(to))
                }
            }
            Action::Fold => "Fold".to_string(),
            Action::Call { .. } => "Call".to_string(),
            Action::Raise { to, is_all_in, .. } => {
                if is_all_in {
                    format!("RaiseAllIn({})", format_chip(to))
                } else {
                    format!("Raise({})", format_chip(to))
                }
            }
        }
    }

    /// Short history token used in node history strings.
    pub fn history_token(&self) -> String {
        match *self {
            Action::Check => "X".to_string(),
            Action::Bet { to, is_all_in } => {
                if is_all_in {
                    format!("BAI({})", format_chip(to))
                } else {
                    format!("B({})", format_chip(to))
                }
            }
            Action::Fold => "F".to_string(),
            Action::Call { .. } => "C".to_string(),
            Action::Raise { to, is_all_in, .. } => {
                if is_all_in {
                    format!("RAI({})", format_chip(to))
                } else {
                    format!("R({})", format_chip(to))
                }
            }
        }
    }
}

impl fmt::Display for Action {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.label())
    }
}

fn format_chip(val: f64) -> String {
    if (val - val.round()).abs() <= 1e-6 {
        format!("{:.0}", val.round())
    } else {
        format!("{:.2}", val)
    }
}

/// Identifier of a node in the river game tree (`0` is always the root node).
pub type NodeId = usize;

/// Decision node in the river action tree.
#[derive(Clone, Debug)]
pub struct DecisionNode {
    /// Index of this node in `RiverGame::nodes`.
    pub node_id: NodeId,
    /// Sequential index (`0..num_decision_nodes`) among decision nodes only.
    pub decision_id: usize,
    /// Acting player (`Player::Oop` or `Player::Ip`).
    pub player: Player,
    /// Action history string reaching this node (e.g., `"root"`, `"X"`, `"B(75)"`).
    pub history: String,
    /// River chips committed by `[OOP, IP]` prior to this decision.
    pub committed: [f64; 2],
    /// Total pot prior to this decision (`starting_pot + committed[0] + committed[1]`).
    pub current_pot: f64,
    /// Chips required for `player` to call (`0.0` if no bet facing).
    pub to_call: f64,
    /// Number of raises made so far on the street.
    pub raises_so_far: usize,
    /// Legal actions available at this node.
    pub actions: Vec<Action>,
    /// Child `NodeId` corresponding to each action in `actions`.
    pub children: Vec<NodeId>,
}

/// Terminal leaf node in the river action tree.
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum TerminalNode {
    /// One player folded; the opponent wins the pot without showdown.
    Fold {
        /// Player who folded.
        folder: Player,
        /// River chips committed by `[OOP, IP]` when the fold occurred.
        committed: [f64; 2],
    },
    /// Showdown reached (either check-check, bet-call, raise-call, or all-in runout).
    Showdown {
        /// River chips committed by `[OOP, IP]` at showdown (`committed[0] == committed[1]`).
        committed: [f64; 2],
    },
}

/// A node in the river game tree.
#[derive(Clone, Debug)]
pub enum Node {
    Decision(DecisionNode),
    Terminal(TerminalNode),
}

/// Input specification for a heads-up river spot.
#[derive(Clone, Debug)]
pub struct RiverSpot {
    /// Fixed 5-card river board.
    pub board: [Card; 5],
    /// Out-of-position player's weighted 4-card range.
    pub oop_range: PloRange,
    /// In-position player's weighted 4-card range.
    pub ip_range: PloRange,
    /// Pot size at the start of the river (must be `> 0.0`).
    pub starting_pot: f64,
    /// Effective stack size behind at the start of the river (must be `>= 0.0`).
    pub effective_stack: f64,
    /// Action tree configuration (bet sizes, raise sizes, max raises).
    pub tree_config: TreeConfig,
}

/// Errors that can occur when constructing or solving a [`RiverGame`].
#[derive(Clone, Debug, PartialEq)]
pub enum SolveError {
    CardParse(CardParseError),
    Equity(EquityError),
    DuplicateBoardCards,
    InvalidStartingPot(f64),
    InvalidEffectiveStack(f64),
    EmptyUnblockedRange(Player),
    AllComboPairsBlocked,
    JsonError(String),
}

impl fmt::Display for SolveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SolveError::CardParse(e) => write!(f, "card parse error: {e}"),
            SolveError::Equity(e) => write!(f, "range error: {e}"),
            SolveError::DuplicateBoardCards => write!(f, "river board must contain 5 distinct cards"),
            SolveError::InvalidStartingPot(p) => write!(f, "starting pot must be positive, got {p}"),
            SolveError::InvalidEffectiveStack(s) => {
                write!(f, "effective stack must be non-negative, got {s}")
            }
            SolveError::EmptyUnblockedRange(p) => {
                write!(f, "{p} range has no combos unblocked by the 5-card board")
            }
            SolveError::AllComboPairsBlocked => {
                write!(f, "all (OOP, IP) combo pairs collide with each other")
            }
            SolveError::JsonError(msg) => write!(f, "JSON error: {msg}"),
        }
    }
}

impl std::error::Error for SolveError {}

impl From<CardParseError> for SolveError {
    fn from(e: CardParseError) -> Self {
        SolveError::CardParse(e)
    }
}

impl From<EquityError> for SolveError {
    fn from(e: EquityError) -> Self {
        SolveError::Equity(e)
    }
}

/// Compiled, validated heads-up river game ready for solving and exploitability checking.
#[derive(Clone, Debug)]
pub struct RiverGame {
    /// Fixed 5-card board.
    pub board: [Card; 5],
    /// 5-bit `HandMask` of the board.
    pub board_mask: HandMask,
    /// Starting pot at the beginning of the river.
    pub starting_pot: f64,
    /// Effective stack size at the beginning of the river.
    pub effective_stack: f64,
    /// Tree configuration used to build the action tree.
    pub tree_config: TreeConfig,
    /// Active (board-unblocked) weighted combos for `[OOP, IP]`.
    pub combos: [Vec<WeightedCombo>; 2],
    /// Pre-evaluated Omaha `HandRank` on `board` for each active combo in `combos[0]` and `combos[1]`.
    pub hand_ranks: [Vec<HandRank>; 2],
    /// For each combo `i` of player `p`, the sum of unblocked opponent combo weights:
    /// `unblocked_opp_weight[p][i] = sum_{j: disjoint(i, j)} combos[1-p][j].weight`.
    pub unblocked_opp_weight: [Vec<f64>; 2],
    /// Total valid deal weight across all non-overlapping `(i, j)` pairs:
    /// `total_valid_weight = sum_{i, j: disjoint(i, j)} w_oop[i] * w_ip[j]`.
    pub total_valid_weight: f64,
    /// All nodes (both decision and terminal) in the river game tree; `nodes[0]` is the root.
    pub nodes: Vec<Node>,
    /// Indices into `nodes` for each `decision_id` in `0..num_decision_nodes`.
    pub decision_node_ids: Vec<NodeId>,
}

impl RiverGame {
    /// Validates a [`RiverSpot`], filters out board-blocked combos, builds the pot-limit action tree,
    /// and precomputes river hand ranks and card-removal weights.
    pub fn new(spot: RiverSpot) -> Result<Self, SolveError> {
        let board_mask = HandMask::from_cards(&spot.board);
        if board_mask.count() != 5 {
            return Err(SolveError::DuplicateBoardCards);
        }
        if !spot.starting_pot.is_finite() || spot.starting_pot <= 0.0 {
            return Err(SolveError::InvalidStartingPot(spot.starting_pot));
        }
        if !spot.effective_stack.is_finite() || spot.effective_stack < 0.0 {
            return Err(SolveError::InvalidEffectiveStack(spot.effective_stack));
        }

        let oop_combos: Vec<WeightedCombo> = spot
            .oop_range
            .combos()
            .iter()
            .copied()
            .filter(|c| !c.mask.overlaps(board_mask))
            .collect();
        if oop_combos.is_empty() {
            return Err(SolveError::EmptyUnblockedRange(Player::Oop));
        }

        let ip_combos: Vec<WeightedCombo> = spot
            .ip_range
            .combos()
            .iter()
            .copied()
            .filter(|c| !c.mask.overlaps(board_mask))
            .collect();
        if ip_combos.is_empty() {
            return Err(SolveError::EmptyUnblockedRange(Player::Ip));
        }

        let board_triples = extract_board_triples(board_mask);
        let oop_ranks: Vec<HandRank> = oop_combos
            .iter()
            .map(|c| eval_omaha_pairs_triples(&c.hole_pairs, &board_triples))
            .collect();
        let ip_ranks: Vec<HandRank> = ip_combos
            .iter()
            .map(|c| eval_omaha_pairs_triples(&c.hole_pairs, &board_triples))
            .collect();

        let mut oop_unblocked_weight = vec![0.0f64; oop_combos.len()];
        let mut ip_unblocked_weight = vec![0.0f64; ip_combos.len()];
        let mut total_valid_weight = 0.0f64;

        for (i, oop_c) in oop_combos.iter().enumerate() {
            for (j, ip_c) in ip_combos.iter().enumerate() {
                if !oop_c.mask.overlaps(ip_c.mask) {
                    oop_unblocked_weight[i] += ip_c.weight;
                    ip_unblocked_weight[j] += oop_c.weight;
                    total_valid_weight += oop_c.weight * ip_c.weight;
                }
            }
        }

        if total_valid_weight <= 0.0 {
            return Err(SolveError::AllComboPairsBlocked);
        }

        let mut nodes = Vec::new();
        let mut decision_node_ids = Vec::new();
        build_tree_recursive(
            &mut nodes,
            &mut decision_node_ids,
            spot.starting_pot,
            spot.effective_stack,
            &spot.tree_config,
            Player::Oop,
            [0.0, 0.0],
            0.0,
            0,
            false,
            "root".to_string(),
        );

        Ok(Self {
            board: spot.board,
            board_mask,
            starting_pot: spot.starting_pot,
            effective_stack: spot.effective_stack,
            tree_config: spot.tree_config,
            combos: [oop_combos, ip_combos],
            hand_ranks: [oop_ranks, ip_ranks],
            unblocked_opp_weight: [oop_unblocked_weight, ip_unblocked_weight],
            total_valid_weight,
            nodes,
            decision_node_ids,
        })
    }

    /// Returns the number of decision nodes in the action tree.
    #[inline]
    pub fn num_decision_nodes(&self) -> usize {
        self.decision_node_ids.len()
    }

    /// Returns a reference to the [`DecisionNode`] with the given `decision_id`.
    #[inline]
    pub fn decision_node(&self, decision_id: usize) -> &DecisionNode {
        match &self.nodes[self.decision_node_ids[decision_id]] {
            Node::Decision(d) => d,
            Node::Terminal(_) => unreachable!("decision_node_ids only indexes Decision nodes"),
        }
    }

    /// Returns the active (board-unblocked) combos for `player`.
    #[inline]
    pub fn player_combos(&self, player: Player) -> &[WeightedCombo] {
        &self.combos[player.index()]
    }
}

#[allow(clippy::too_many_arguments)]
fn build_tree_recursive(
    nodes: &mut Vec<Node>,
    decision_node_ids: &mut Vec<NodeId>,
    starting_pot: f64,
    effective_stack: f64,
    config: &TreeConfig,
    player: Player,
    committed: [f64; 2],
    last_bet_or_raise_delta: f64,
    raises_so_far: usize,
    oop_checked: bool,
    history: String,
) -> NodeId {
    let p_idx = player.index();
    let q_idx = player.opponent().index();
    let actor_committed = committed[p_idx];
    let opp_committed = committed[q_idx];
    let to_call = (opp_committed - actor_committed).max(0.0);
    let current_pot = starting_pot + committed[0] + committed[1];

    // Build list of legal actions at this decision node.
    let mut actions = Vec::new();
    if to_call <= CHIP_EPS {
        actions.push(Action::Check);
        let bets = legal_bet_sizes(starting_pot, effective_stack, config);
        for (to, is_all_in) in bets {
            actions.push(Action::Bet { to, is_all_in });
        }
    } else {
        actions.push(Action::Fold);
        actions.push(Action::Call {
            to: opp_committed,
            call_amount: to_call,
        });
        let raises = legal_raise_sizes(
            starting_pot,
            effective_stack,
            actor_committed,
            opp_committed,
            last_bet_or_raise_delta,
            raises_so_far,
            config,
        );
        for (to, is_all_in) in raises {
            actions.push(Action::Raise {
                to,
                raise_by: to - opp_committed,
                is_all_in,
            });
        }
    }

    let node_id = nodes.len();
    let decision_id = decision_node_ids.len();
    decision_node_ids.push(node_id);

    // Push placeholder before recursing so `node_id` is pre-order.
    nodes.push(Node::Decision(DecisionNode {
        node_id,
        decision_id,
        player,
        history: history.clone(),
        committed,
        current_pot,
        to_call,
        raises_so_far,
        actions: actions.clone(),
        children: Vec::new(),
    }));

    let mut children = Vec::with_capacity(actions.len());
    for action in &actions {
        let child_history = if history == "root" {
            action.history_token()
        } else {
            format!("{}/{}", history, action.history_token())
        };

        let child_id = match *action {
            Action::Check => {
                if player == Player::Oop && !oop_checked {
                    build_tree_recursive(
                        nodes,
                        decision_node_ids,
                        starting_pot,
                        effective_stack,
                        config,
                        Player::Ip,
                        committed,
                        0.0,
                        0,
                        true,
                        child_history,
                    )
                } else {
                    // Check-check reaches showdown.
                    let cid = nodes.len();
                    nodes.push(Node::Terminal(TerminalNode::Showdown { committed }));
                    cid
                }
            }
            Action::Fold => {
                let cid = nodes.len();
                nodes.push(Node::Terminal(TerminalNode::Fold {
                    folder: player,
                    committed,
                }));
                cid
            }
            Action::Call { to, .. } => {
                let mut next_committed = committed;
                next_committed[p_idx] = to;
                let cid = nodes.len();
                nodes.push(Node::Terminal(TerminalNode::Showdown {
                    committed: next_committed,
                }));
                cid
            }
            Action::Bet { to, .. } => {
                let mut next_committed = committed;
                next_committed[p_idx] = to;
                let delta = to - actor_committed;
                build_tree_recursive(
                    nodes,
                    decision_node_ids,
                    starting_pot,
                    effective_stack,
                    config,
                    player.opponent(),
                    next_committed,
                    delta,
                    0,
                    false,
                    child_history,
                )
            }
            Action::Raise { to, raise_by, .. } => {
                let mut next_committed = committed;
                next_committed[p_idx] = to;
                build_tree_recursive(
                    nodes,
                    decision_node_ids,
                    starting_pot,
                    effective_stack,
                    config,
                    player.opponent(),
                    next_committed,
                    raise_by,
                    raises_so_far + 1,
                    false,
                    child_history,
                )
            }
        };
        children.push(child_id);
    }

    if let Node::Decision(ref mut d) = nodes[node_id] {
        d.children = children;
    }

    node_id
}
