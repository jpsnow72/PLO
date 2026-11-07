//! Turn solver (Ticket E3): heads-up PLO two-street game (turn + river) with chance nodes.
//!
//! Extends the E2 river solver ([`crate::game`], [`crate::cfr`], [`crate::br`]) to a game
//! that starts on the turn: players bet on the turn, a chance node deals every possible
//! river card with exact per-combo-pair card removal, and each runout continues into a
//! river betting subtree that reuses the E2 pot-limit legality machinery
//! ([`legal_bet_sizes`] / [`legal_raise_sizes`]) and the E1 Omaha evaluator.
//!
//! Chance semantics (exact): for any valid (disjoint) combo pair `(i, j)` on a 4-card
//! board, the number of dealable river cards is always `52 - 4 (board) - 4 - 4 (holes)
//! = 40`, each with probability `1/40`. A combo's value at a chance node is therefore
//! `(1/40) * sum_r child_value_r`, where the runout-`r` child contributes exactly `0`
//! for pairs blocked by `r` (enforced by per-runout kernels whose opponent lists exclude
//! every combo containing `r`, for showdown *and* fold terminals alike).
//!
//! The solver is the same vectorised Discounted CFR as E2 (same [`DcfrConfig`], same
//! discount factors, alternating updates), generalised to the two-street tree. The
//! independent best-response checker for this game lives in
//! [`crate::br::compute_exploitability_turn`].

use std::rc::Rc;

use plo_cards::{Card, HandMask};
use plo_eval::{eval_omaha_pairs_triples, extract_board_triples, HandRank, PloRange, WeightedCombo};

use crate::br::{compute_exploitability_turn, ExploitabilityReport};
use crate::cfr::{ComboEv, DcfrConfig, NodeStrategy};
use crate::game::{
    legal_bet_sizes, legal_raise_sizes, Action, NodeId, Player, SolveError, TerminalNode,
    TreeConfig, CHIP_EPS,
};

/// Probability of each individual river card for a valid combo pair (`1/40`).
pub const RIVER_DEAL_PROB: f64 = 1.0 / 40.0;

/// Street identifier in the two-street turn game.
#[repr(u8)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum Street {
    /// The turn (4-card board, river not yet dealt).
    Turn = 0,
    /// The river (5-card board, inside one runout subtree).
    River = 1,
}

impl Street {
    /// Returns `"turn"` or `"river"`.
    #[inline]
    pub const fn as_str(self) -> &'static str {
        match self {
            Street::Turn => "turn",
            Street::River => "river",
        }
    }
}

/// Input specification for a heads-up turn spot.
#[derive(Clone, Debug)]
pub struct TurnSpot {
    /// Fixed 4-card turn board.
    pub board: [Card; 4],
    /// Out-of-position player's weighted 4-card range.
    pub oop_range: PloRange,
    /// In-position player's weighted 4-card range.
    pub ip_range: PloRange,
    /// Pot size at the start of the turn (must be `> 0.0`).
    pub starting_pot: f64,
    /// Effective stack size behind at the start of the turn (must be `>= 0.0`).
    pub effective_stack: f64,
    /// Action tree configuration for the turn street.
    pub turn_config: TreeConfig,
    /// Action tree configuration for the river street.
    pub river_config: TreeConfig,
}

/// Decision node in the two-street action tree.
#[derive(Clone, Debug)]
pub struct TurnDecisionNode {
    /// Index of this node in `TurnGame::nodes`.
    pub node_id: NodeId,
    /// Sequential index (`0..num_decision_nodes`) among decision nodes only.
    pub decision_id: usize,
    /// Acting player.
    pub player: Player,
    /// Street this decision belongs to.
    pub street: Street,
    /// Runout index into `TurnGame::river_cards` for river nodes (`None` on the turn).
    pub runout: Option<usize>,
    /// The river card for river nodes (`None` on the turn).
    pub river_card: Option<Card>,
    /// Action history string reaching this node (e.g. `"root"`, `"X/X|r:As"`,
    /// `"X/X|r:As/B(75)"`).
    pub history: String,
    /// Total chips committed by `[OOP, IP]` across both streets prior to this decision.
    pub committed: [f64; 2],
    /// Chips committed by `[OOP, IP]` on the current street only.
    pub street_committed: [f64; 2],
    /// Total pot prior to this decision (`starting_pot + committed[0] + committed[1]`).
    pub current_pot: f64,
    /// Chips required for `player` to call (`0.0` if no bet facing).
    pub to_call: f64,
    /// Number of raises made so far on the current street.
    pub raises_so_far: usize,
    /// Legal actions available at this node.
    pub actions: Vec<Action>,
    /// Child `NodeId` corresponding to each action in `actions`.
    pub children: Vec<NodeId>,
}

/// Chance node: deals the river card. `children[r]` is the root of the river subtree
/// (a decision node, or a showdown terminal when no stack remains) for
/// `TurnGame::river_cards[r]`.
#[derive(Clone, Debug)]
pub struct ChanceNode {
    /// Index of this node in `TurnGame::nodes`.
    pub node_id: NodeId,
    /// Action history string of the closed turn sequence (e.g. `"X/X"`, `"B(75)/C"`).
    pub history: String,
    /// Total chips committed by `[OOP, IP]` when the turn closed (always equal).
    pub committed: [f64; 2],
    /// One child per river card, aligned with `TurnGame::river_cards`.
    pub children: Vec<NodeId>,
}

/// A node in the two-street game tree.
#[derive(Clone, Debug)]
pub enum TurnNode {
    Decision(TurnDecisionNode),
    Chance(ChanceNode),
    Terminal(TerminalNode),
}

/// Compiled, validated heads-up turn game ready for solving and exploitability checking.
#[derive(Clone, Debug)]
pub struct TurnGame {
    /// Fixed 4-card turn board.
    pub board: [Card; 4],
    /// `HandMask` of the 4-card board.
    pub board_mask: HandMask,
    /// Starting pot at the beginning of the turn.
    pub starting_pot: f64,
    /// Effective stack size at the beginning of the turn.
    pub effective_stack: f64,
    /// Tree configuration used for the turn street.
    pub turn_config: TreeConfig,
    /// Tree configuration used for the river street.
    pub river_config: TreeConfig,
    /// Active (board-unblocked) weighted combos for `[OOP, IP]`.
    pub combos: [Vec<WeightedCombo>; 2],
    /// Every card that can be dealt as the river (all cards not on the board), in deck order.
    pub river_cards: Vec<Card>,
    /// `river_ranks[r][p][i]` = Omaha `HandRank` of combo `i` of player `p` on
    /// `board + river_cards[r]`. (Ranks for combos containing the river card are computed
    /// but never used: those pairs are excluded by card removal.)
    pub river_ranks: Vec<[Vec<HandRank>; 2]>,
    /// For each combo `i` of player `p`, the sum of unblocked opponent combo weights.
    pub unblocked_opp_weight: [Vec<f64>; 2],
    /// Total valid deal weight across all non-overlapping `(i, j)` pairs.
    pub total_valid_weight: f64,
    /// All nodes in the two-street tree; `nodes[0]` is the turn root.
    pub nodes: Vec<TurnNode>,
    /// Indices into `nodes` for each `decision_id` in `0..num_decision_nodes`.
    pub decision_node_ids: Vec<NodeId>,
    /// Indices into `nodes` for all chance nodes.
    pub chance_node_ids: Vec<NodeId>,
}

impl TurnGame {
    /// Validates a [`TurnSpot`], filters board-blocked combos, precomputes per-runout
    /// hand ranks, and builds the two-street tree (turn decisions, chance nodes, and one
    /// river subtree per river card per chance node).
    pub fn new(spot: TurnSpot) -> Result<Self, SolveError> {
        let board_mask = HandMask::from_cards(&spot.board);
        if board_mask.count() != 4 {
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
        let combos = [oop_combos, ip_combos];

        let mut oop_unblocked_weight = vec![0.0f64; combos[0].len()];
        let mut ip_unblocked_weight = vec![0.0f64; combos[1].len()];
        let mut total_valid_weight = 0.0f64;
        for (i, oop_c) in combos[0].iter().enumerate() {
            for (j, ip_c) in combos[1].iter().enumerate() {
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

        let river_cards: Vec<Card> = (HandMask::FULL_DECK - board_mask).iter().collect();
        debug_assert_eq!(river_cards.len(), 48);

        let mut river_ranks: Vec<[Vec<HandRank>; 2]> = Vec::with_capacity(river_cards.len());
        for &rc in &river_cards {
            let board5_mask = board_mask.with(rc);
            let triples = extract_board_triples(board5_mask);
            let ranks_for = |cs: &Vec<WeightedCombo>| -> Vec<HandRank> {
                cs.iter()
                    .map(|c| {
                        if c.mask.contains(rc) {
                            // Blocked on this runout: a hole pair and a board triple
                            // would share the river card, so no valid 5-card hand
                            // exists. The rank is never used (kernels and checker
                            // exclude these combos); store a dummy instead of
                            // evaluating an illegal 4-card mask.
                            HandRank(0)
                        } else {
                            eval_omaha_pairs_triples(&c.hole_pairs, &triples)
                        }
                    })
                    .collect()
            };
            river_ranks.push([ranks_for(&combos[0]), ranks_for(&combos[1])]);
        }

        let (nodes, decision_node_ids, chance_node_ids) = {
            let mut builder = TreeBuilder {
                starting_pot: spot.starting_pot,
                effective_stack: spot.effective_stack,
                turn_config: &spot.turn_config,
                river_config: &spot.river_config,
                river_cards: &river_cards,
                nodes: Vec::new(),
                decision_node_ids: Vec::new(),
                chance_node_ids: Vec::new(),
            };
            builder.build_decision(
                Street::Turn,
                None,
                Player::Oop,
                [0.0, 0.0],
                [0.0, 0.0],
                0.0,
                0,
                false,
                "root".to_string(),
            );
            (
                builder.nodes,
                builder.decision_node_ids,
                builder.chance_node_ids,
            )
        };

        Ok(Self {
            board: spot.board,
            board_mask,
            starting_pot: spot.starting_pot,
            effective_stack: spot.effective_stack,
            turn_config: spot.turn_config,
            river_config: spot.river_config,
            combos,
            river_cards,
            river_ranks,
            unblocked_opp_weight: [oop_unblocked_weight, ip_unblocked_weight],
            total_valid_weight,
            nodes,
            decision_node_ids,
            chance_node_ids,
        })
    }

    /// Total number of nodes (decision + chance + terminal) in the tree.
    #[inline]
    pub fn num_nodes(&self) -> usize {
        self.nodes.len()
    }

    /// Number of decision nodes in the tree.
    #[inline]
    pub fn num_decision_nodes(&self) -> usize {
        self.decision_node_ids.len()
    }

    /// Number of chance nodes in the tree.
    #[inline]
    pub fn num_chance_nodes(&self) -> usize {
        self.chance_node_ids.len()
    }

    /// Returns the [`TurnDecisionNode`] with the given `decision_id`.
    #[inline]
    pub fn decision_node(&self, decision_id: usize) -> &TurnDecisionNode {
        match &self.nodes[self.decision_node_ids[decision_id]] {
            TurnNode::Decision(d) => d,
            _ => unreachable!("decision_node_ids only indexes Decision nodes"),
        }
    }

    /// Returns the active combos for `player`.
    #[inline]
    pub fn player_combos(&self, player: Player) -> &[WeightedCombo] {
        &self.combos[player.index()]
    }

    /// Total number of (decision node, combo) information sets in the unabstracted game:
    /// `sum over decision nodes of the acting player's combo count`.
    pub fn num_infosets(&self) -> usize {
        self.decision_node_ids
            .iter()
            .map(|&nid| match &self.nodes[nid] {
                TurnNode::Decision(d) => self.combos[d.player.index()].len(),
                _ => 0,
            })
            .sum()
    }

    /// Effective range weight of combo `combo_idx` of `player` on runout `runout`:
    /// exactly `0.0` when the combo contains the river card (it can never be dealt
    /// against that river), otherwise the combo's range weight.
    pub fn river_combo_weight(&self, runout: usize, player: Player, combo_idx: usize) -> f64 {
        let combo = &self.combos[player.index()][combo_idx];
        if combo.mask.contains(self.river_cards[runout]) {
            0.0
        } else {
            combo.weight
        }
    }

    /// Number of river cards dealable to the pair `(oop_idx, ip_idx)`:
    /// `52 - |board ∪ hole_oop ∪ hole_ip|` (= 40 for every disjoint pair).
    pub fn pair_runout_count(&self, oop_idx: usize, ip_idx: usize) -> usize {
        let used = self
            .board_mask
            .union(self.combos[0][oop_idx].mask)
            .union(self.combos[1][ip_idx].mask);
        (HandMask::FULL_DECK - used).count() as usize
    }
}

struct TreeBuilder<'a> {
    starting_pot: f64,
    effective_stack: f64,
    turn_config: &'a TreeConfig,
    river_config: &'a TreeConfig,
    river_cards: &'a [Card],
    nodes: Vec<TurnNode>,
    decision_node_ids: Vec<NodeId>,
    chance_node_ids: Vec<NodeId>,
}

impl<'a> TreeBuilder<'a> {
    fn config(&self, street: Street) -> &'a TreeConfig {
        match street {
            Street::Turn => self.turn_config,
            Street::River => self.river_config,
        }
    }

    /// Builds a decision node (and subtree) for `player` on `street`.
    ///
    /// Invariants: `total = street_base_total + street_committed` componentwise, and
    /// `street_base_total[0] == street_base_total[1]` (streets always start with equal
    /// total commitments), so the street-start stack is
    /// `effective_stack - street_base_total[0]` for both players.
    #[allow(clippy::too_many_arguments)]
    fn build_decision(
        &mut self,
        street: Street,
        runout: Option<usize>,
        player: Player,
        street_base_total: [f64; 2],
        street_committed: [f64; 2],
        last_bet_or_raise_delta: f64,
        raises_so_far: usize,
        oop_checked: bool,
        history: String,
    ) -> NodeId {
        let config = self.config(street);
        let p_idx = player.index();
        let q_idx = player.opponent().index();
        let total = [
            street_base_total[0] + street_committed[0],
            street_base_total[1] + street_committed[1],
        ];
        let actor_committed = street_committed[p_idx];
        let opp_committed = street_committed[q_idx];
        let to_call = (opp_committed - actor_committed).max(0.0);
        let current_pot = self.starting_pot + total[0] + total[1];
        // Pot and stack as of the start of this street (what the E2 legality
        // functions expect): pot before any street action, stack behind then.
        let street_start_pot = self.starting_pot + street_base_total[0] + street_base_total[1];
        let street_start_stack = self.effective_stack - street_base_total[0];

        let mut actions = Vec::new();
        if to_call <= CHIP_EPS {
            actions.push(Action::Check);
            for (to, is_all_in) in legal_bet_sizes(street_start_pot, street_start_stack, config) {
                actions.push(Action::Bet { to, is_all_in });
            }
        } else {
            actions.push(Action::Fold);
            actions.push(Action::Call {
                to: opp_committed,
                call_amount: to_call,
            });
            let raises = legal_raise_sizes(
                street_start_pot,
                street_start_stack,
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

        let node_id = self.nodes.len();
        let decision_id = self.decision_node_ids.len();
        self.decision_node_ids.push(node_id);
        self.nodes.push(TurnNode::Decision(TurnDecisionNode {
            node_id,
            decision_id,
            player,
            street,
            runout,
            river_card: runout.map(|r| self.river_cards[r]),
            history: history.clone(),
            committed: total,
            street_committed,
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
                        self.build_decision(
                            street,
                            runout,
                            Player::Ip,
                            street_base_total,
                            street_committed,
                            0.0,
                            0,
                            true,
                            child_history,
                        )
                    } else {
                        self.close_street(street, total, child_history)
                    }
                }
                Action::Fold => {
                    let cid = self.nodes.len();
                    self.nodes.push(TurnNode::Terminal(TerminalNode::Fold {
                        folder: player,
                        committed: total,
                    }));
                    cid
                }
                Action::Call { to, .. } => {
                    let mut next_street_committed = street_committed;
                    next_street_committed[p_idx] = to;
                    let next_total = [
                        street_base_total[0] + next_street_committed[0],
                        street_base_total[1] + next_street_committed[1],
                    ];
                    self.close_street(street, next_total, child_history)
                }
                Action::Bet { to, .. } => {
                    let mut next_street_committed = street_committed;
                    next_street_committed[p_idx] = to;
                    let delta = to - actor_committed;
                    self.build_decision(
                        street,
                        runout,
                        player.opponent(),
                        street_base_total,
                        next_street_committed,
                        delta,
                        0,
                        false,
                        child_history,
                    )
                }
                Action::Raise { to, raise_by, .. } => {
                    let mut next_street_committed = street_committed;
                    next_street_committed[p_idx] = to;
                    self.build_decision(
                        street,
                        runout,
                        player.opponent(),
                        street_base_total,
                        next_street_committed,
                        raise_by,
                        raises_so_far + 1,
                        false,
                        child_history,
                    )
                }
            };
            children.push(child_id);
        }

        if let TurnNode::Decision(ref mut d) = self.nodes[node_id] {
            d.children = children;
        }
        node_id
    }

    /// Closes a street whose action sequence has ended with `total` committed.
    /// Turn -> chance node; river -> showdown terminal.
    fn close_street(&mut self, street: Street, total: [f64; 2], history: String) -> NodeId {
        match street {
            Street::River => {
                let cid = self.nodes.len();
                self.nodes.push(TurnNode::Terminal(TerminalNode::Showdown {
                    committed: total,
                }));
                cid
            }
            Street::Turn => {
                let node_id = self.nodes.len();
                self.chance_node_ids.push(node_id);
                self.nodes.push(TurnNode::Chance(ChanceNode {
                    node_id,
                    history: history.clone(),
                    committed: total,
                    children: Vec::new(),
                }));

                let remaining_stack = self.effective_stack - total[0];
                let mut children = Vec::with_capacity(self.river_cards.len());
                for r in 0..self.river_cards.len() {
                    let child_history =
                        format!("{}|r:{}", history, plo_cards::format_cards(&[self.river_cards[r]]));
                    let child_id = if remaining_stack <= CHIP_EPS {
                        // Both players are all-in (or stacks were zero): no river betting.
                        let cid = self.nodes.len();
                        self.nodes.push(TurnNode::Terminal(TerminalNode::Showdown {
                            committed: total,
                        }));
                        cid
                    } else {
                        self.build_decision(
                            Street::River,
                            Some(r),
                            Player::Oop,
                            total,
                            [0.0, 0.0],
                            0.0,
                            0,
                            false,
                            child_history,
                        )
                    };
                    children.push(child_id);
                }

                if let TurnNode::Chance(ref mut c) = self.nodes[node_id] {
                    c.children = children;
                }
                node_id
            }
        }
    }
}

/// Complete output of solving a turn spot with Discounted CFR.
#[derive(Clone, Debug)]
pub struct TurnSolveResult {
    /// Average strategy per decision node (`0..game.num_decision_nodes()`), spanning
    /// both streets; river nodes carry their runout in the game tree.
    pub strategies: Vec<NodeStrategy>,
    /// Per-combo expected values for OOP at the start of the turn.
    pub oop_evs: Vec<ComboEv>,
    /// Per-combo expected values for IP at the start of the turn.
    pub ip_evs: Vec<ComboEv>,
    /// Overall expected value in chips for OOP at the start of the turn.
    pub oop_game_ev: f64,
    /// Overall expected value in chips for IP at the start of the turn.
    pub ip_game_ev: f64,
    /// Total number of DCFR iterations executed.
    pub iterations: usize,
    /// Exact exploitability report measured by the independent checker
    /// ([`compute_exploitability_turn`]).
    pub exploitability: ExploitabilityReport,
}

/// CSR lookup table of unblocked opponent combo indices partitioned into
/// `(wins, ties, losses)` for fast vectorised terminal evaluation.
///
/// When built for a specific runout `r`, opponent combos containing `r` are excluded
/// entirely and rows for combos containing `r` are empty, so *both* showdown and fold
/// evaluations return exactly `0` for pairs that `r` blocks.
struct TurnKernel {
    offsets: Vec<[u32; 4]>,
    opp_indices: Vec<u32>,
}

impl TurnKernel {
    fn build(
        my_combos: &[WeightedCombo],
        opp_combos: &[WeightedCombo],
        my_ranks: &[HandRank],
        opp_ranks: &[HandRank],
        runout_card: Option<Card>,
    ) -> Self {
        let mut offsets = Vec::with_capacity(my_combos.len());
        let mut opp_indices = Vec::with_capacity(my_combos.len() * opp_combos.len());
        let mut wins_buf = Vec::with_capacity(opp_combos.len());
        let mut ties_buf = Vec::with_capacity(opp_combos.len());
        let mut losses_buf = Vec::with_capacity(opp_combos.len());

        for (i, mc) in my_combos.iter().enumerate() {
            wins_buf.clear();
            ties_buf.clear();
            losses_buf.clear();
            let blocked_by_runout = runout_card.map(|rc| mc.mask.contains(rc)).unwrap_or(false);
            if !blocked_by_runout {
                let r_my = my_ranks[i];
                for (j, oc) in opp_combos.iter().enumerate() {
                    if runout_card.map(|rc| oc.mask.contains(rc)).unwrap_or(false) {
                        continue;
                    }
                    if !mc.mask.overlaps(oc.mask) {
                        match r_my.cmp(&opp_ranks[j]) {
                            std::cmp::Ordering::Greater => wins_buf.push(j as u32),
                            std::cmp::Ordering::Equal => ties_buf.push(j as u32),
                            std::cmp::Ordering::Less => losses_buf.push(j as u32),
                        }
                    }
                }
            }
            let s0 = opp_indices.len() as u32;
            opp_indices.extend_from_slice(&wins_buf);
            let s1 = opp_indices.len() as u32;
            opp_indices.extend_from_slice(&ties_buf);
            let s2 = opp_indices.len() as u32;
            opp_indices.extend_from_slice(&losses_buf);
            let s3 = opp_indices.len() as u32;
            offsets.push([s0, s1, s2, s3]);
        }

        Self {
            offsets,
            opp_indices,
        }
    }

    /// Heap memory held by this kernel's CSR tables (offsets + opponent indices).
    pub fn memory_bytes(&self) -> usize {
        self.offsets.len() * std::mem::size_of::<[u32; 4]>()
            + self.opp_indices.len() * std::mem::size_of::<u32>()
    }

    #[inline]
    fn eval_fold(&self, opp_reach: &[f64], payoff: f64, out: &mut [f64]) {
        if payoff == 0.0 {
            out.fill(0.0);
            return;
        }
        for (i, &[s0, _, _, s3]) in self.offsets.iter().enumerate() {
            let mut sum = 0.0f64;
            for &j in &self.opp_indices[s0 as usize..s3 as usize] {
                sum += unsafe { *opp_reach.get_unchecked(j as usize) };
            }
            out[i] = sum * payoff;
        }
    }

    #[inline]
    fn eval_showdown(
        &self,
        opp_reach: &[f64],
        win_payoff: f64,
        tie_payoff: f64,
        loss_payoff: f64,
        out: &mut [f64],
    ) {
        for (i, &[s0, s1, s2, s3]) in self.offsets.iter().enumerate() {
            let mut win_sum = 0.0f64;
            for &j in &self.opp_indices[s0 as usize..s1 as usize] {
                win_sum += unsafe { *opp_reach.get_unchecked(j as usize) };
            }
            let mut tie_sum = 0.0f64;
            for &j in &self.opp_indices[s1 as usize..s2 as usize] {
                tie_sum += unsafe { *opp_reach.get_unchecked(j as usize) };
            }
            let mut loss_sum = 0.0f64;
            for &j in &self.opp_indices[s2 as usize..s3 as usize] {
                loss_sum += unsafe { *opp_reach.get_unchecked(j as usize) };
            }
            out[i] = win_payoff * win_sum + tie_payoff * tie_sum + loss_payoff * loss_sum;
        }
    }
}

/// Mutable per-decision-node buffers used during DCFR iterations (turn tree).
struct TurnNodeBuffer {
    player: Player,
    num_actions: usize,
    num_combos: usize,
    regrets: Vec<f64>,
    cum_strategy: Vec<f64>,
    current_strategy: Vec<f64>,
}

impl TurnNodeBuffer {
    fn new(player: Player, num_actions: usize, num_combos: usize) -> Self {
        let len = num_actions * num_combos;
        let uniform = if num_actions > 0 {
            1.0 / (num_actions as f64)
        } else {
            0.0
        };
        Self {
            player,
            num_actions,
            num_combos,
            regrets: vec![0.0; len],
            cum_strategy: vec![0.0; len],
            current_strategy: vec![uniform; len],
        }
    }

    #[inline]
    fn recompute_current_strategy(&mut self) {
        let num_actions = self.num_actions;
        let uniform = 1.0 / (num_actions as f64);
        for i in 0..self.num_combos {
            let base = i * num_actions;
            let reg_slice = &self.regrets[base..base + num_actions];
            let strat_slice = &mut self.current_strategy[base..base + num_actions];
            let mut pos_sum = 0.0f64;
            for &r in reg_slice {
                if r > 0.0 {
                    pos_sum += r;
                }
            }
            if pos_sum > 0.0 {
                let inv = 1.0 / pos_sum;
                for a in 0..num_actions {
                    let r = reg_slice[a];
                    strat_slice[a] = if r > 0.0 { r * inv } else { 0.0 };
                }
            } else {
                strat_slice.fill(uniform);
            }
        }
    }

    fn to_node_strategy(&self, game: &TurnGame, decision_id: usize) -> NodeStrategy {
        let d = game.decision_node(decision_id);
        let num_actions = self.num_actions;
        let uniform = 1.0 / (num_actions as f64);
        let mut frequencies = vec![0.0f64; num_actions * self.num_combos];
        for i in 0..self.num_combos {
            let base = i * num_actions;
            let cum_slice = &self.cum_strategy[base..base + num_actions];
            let out_slice = &mut frequencies[base..base + num_actions];
            let sum: f64 = cum_slice.iter().sum();
            if sum > 0.0 {
                let inv = 1.0 / sum;
                for a in 0..num_actions {
                    out_slice[a] = cum_slice[a] * inv;
                }
            } else {
                let cur_slice = &self.current_strategy[base..base + num_actions];
                let cur_sum: f64 = cur_slice.iter().sum();
                if cur_sum > 0.0 {
                    let inv = 1.0 / cur_sum;
                    for a in 0..num_actions {
                        out_slice[a] = cur_slice[a] * inv;
                    }
                } else {
                    out_slice.fill(uniform);
                }
            }
        }
        NodeStrategy {
            decision_id,
            node_id: d.node_id,
            player: d.player,
            history: d.history.clone(),
            actions: d.actions.clone(),
            num_combos: self.num_combos,
            frequencies,
        }
    }
}

/// Kernels for one player perspective: turn-street folds plus one kernel per runout.
struct PlayerKernels {
    /// Fold evaluation before the river is dealt (opponent lists exclude only
    /// hole-card overlaps).
    turn_fold: TurnKernel,
    /// Per-runout kernels used for both folds and showdowns inside a river subtree.
    runouts: Vec<TurnKernel>,
}

fn build_player_kernels(game: &TurnGame, player: Player) -> PlayerKernels {
    let p_idx = player.index();
    let q_idx = player.opponent().index();
    let my = &game.combos[p_idx];
    let opp = &game.combos[q_idx];
    let turn_fold = TurnKernel::build(
        my,
        opp,
        &game.river_ranks[0][p_idx],
        &game.river_ranks[0][q_idx],
        None,
    );
    let runouts = (0..game.river_cards.len())
        .map(|r| {
            TurnKernel::build(
                my,
                opp,
                &game.river_ranks[r][p_idx],
                &game.river_ranks[r][q_idx],
                Some(game.river_cards[r]),
            )
        })
        .collect();
    PlayerKernels { turn_fold, runouts }
}

impl PlayerKernels {
    /// Heap memory held by all kernels of this perspective (fold + per-runout).
    pub fn memory_bytes(&self) -> usize {
        self.turn_fold.memory_bytes()
            + self.runouts.iter().map(|k| k.memory_bytes()).sum::<usize>()
    }
}

/// Precomputed terminal-evaluation kernels for both player perspectives of a
/// [`TurnGame`]. Kernels depend only on the game's combos and per-runout ranks,
/// so games with identical combos/ranks (e.g. the flop solver's per-turn-card
/// subtrees, which differ only in pot/stack/tree) can share one instance via
/// [`Rc`]; see [`TurnSolverState::with_kernels`].
pub struct TurnKernels {
    per_player: [PlayerKernels; 2],
}

impl TurnKernels {
    /// Builds the kernels for both perspectives of `game`.
    pub fn new(game: &TurnGame) -> Self {
        Self {
            per_player: [
                build_player_kernels(game, Player::Oop),
                build_player_kernels(game, Player::Ip),
            ],
        }
    }

    /// Total heap memory held by both perspectives' kernels.
    pub fn memory_bytes(&self) -> usize {
        self.per_player[0].memory_bytes() + self.per_player[1].memory_bytes()
    }
}

/// Persistent Discounted-CFR state for one [`TurnGame`]: shared kernels plus the
/// per-decision-node regret / cumulative-strategy / current-strategy buffers.
///
/// This is the reusable form of the solver loop in [`solve_turn`]: the flop
/// solver (Ticket E4) drives one `TurnSolverState` per (flop history, turn card)
/// subtree, feeding root reaches down from flop play and reading root
/// counterfactual values back. A half-iteration is
/// [`begin_update`](Self::begin_update) + [`traverse_root`](Self::traverse_root).
pub struct TurnSolverState {
    kernels: Rc<TurnKernels>,
    buffers: Vec<TurnNodeBuffer>,
}

impl TurnSolverState {
    /// Creates a state with freshly built kernels for `game`.
    pub fn new(game: &TurnGame) -> Self {
        Self::with_kernels(game, Rc::new(TurnKernels::new(game)))
    }

    /// Creates a state reusing `kernels` (which must have been built for a game
    /// with identical combos and per-runout ranks as `game`).
    pub fn with_kernels(game: &TurnGame, kernels: Rc<TurnKernels>) -> Self {
        let buffers: Vec<TurnNodeBuffer> = (0..game.num_decision_nodes())
            .map(|did| {
                let d = game.decision_node(did);
                let num_combos = game.player_combos(d.player).len();
                TurnNodeBuffer::new(d.player, d.actions.len(), num_combos)
            })
            .collect();
        Self { kernels, buffers }
    }

    /// The kernels this state traverses with.
    pub fn kernels(&self) -> &TurnKernels {
        &self.kernels
    }

    /// Recomputes the current (regret-matching) strategy for all of
    /// `traverser`'s decision nodes. Call once per half-iteration, before
    /// [`traverse_root`](Self::traverse_root).
    pub fn begin_update(&mut self, traverser: Player) {
        for buf in &mut self.buffers {
            if buf.player == traverser {
                buf.recompute_current_strategy();
            }
        }
    }

    /// Runs one DCFR traversal from the root for `traverser`, updating
    /// `traverser`'s regrets and cumulative strategies, and returns the
    /// traverser's root counterfactual values (per combo of `traverser`,
    /// unnormalised: summed against `opp_reach`).
    #[allow(clippy::too_many_arguments)]
    pub fn traverse_root(
        &mut self,
        game: &TurnGame,
        traverser: Player,
        my_reach: &[f64],
        opp_reach: &[f64],
        pos_discount: f64,
        neg_discount: f64,
        strat_weight: f64,
    ) -> Vec<f64> {
        turn_traverse(
            game,
            &self.kernels.per_player[traverser.index()],
            &mut self.buffers,
            0,
            traverser,
            None,
            my_reach,
            opp_reach,
            pos_discount,
            neg_discount,
            strat_weight,
        )
    }

    /// Extracts the average (cumulative) strategy at every decision node.
    pub fn average_strategies(&self, game: &TurnGame) -> Vec<NodeStrategy> {
        (0..game.num_decision_nodes())
            .map(|did| self.buffers[did].to_node_strategy(game, did))
            .collect()
    }

    /// Total (decision node × combo) information sets covered by the buffers.
    pub fn num_infosets(&self) -> usize {
        self.buffers.iter().map(|b| b.num_combos).sum()
    }

    /// Total strategy slots: `sum over decision nodes of combos × actions`.
    pub fn action_slots(&self) -> usize {
        self.buffers.iter().map(|b| b.num_combos * b.num_actions).sum()
    }

    /// Working memory of the three `f64` buffer arrays (regret + cumulative +
    /// current strategy) in bytes. Excludes kernels (see [`TurnKernels`]).
    pub fn buffer_bytes(&self) -> usize {
        self.action_slots() * 3 * std::mem::size_of::<f64>()
    }
}

/// Solves a [`TurnGame`] using vectorised Discounted CFR (same parameters and
/// alternating-update scheme as the E2 river solver, see [`crate::cfr`]).
pub fn solve_turn(game: &TurnGame, config: &DcfrConfig) -> TurnSolveResult {
    let mut state = TurnSolverState::new(game);

    let init_oop_reach: Vec<f64> = game.combos[0].iter().map(|c| c.weight).collect();
    let init_ip_reach: Vec<f64> = game.combos[1].iter().map(|c| c.weight).collect();

    let mut iterations_done = 0usize;
    let mut final_report: Option<ExploitabilityReport> = None;

    for iter in 1..=config.max_iterations {
        iterations_done = iter;
        let t = iter as f64;
        let t_alpha = t.powf(config.alpha);
        let pos_discount = t_alpha / (t_alpha + 1.0);
        let t_beta = if config.beta == 0.0 {
            1.0
        } else {
            t.powf(config.beta)
        };
        let neg_discount = t_beta / (t_beta + 1.0);
        let strat_weight = t.powf(config.gamma);

        state.begin_update(Player::Oop);
        state.traverse_root(
            game,
            Player::Oop,
            &init_oop_reach,
            &init_ip_reach,
            pos_discount,
            neg_discount,
            strat_weight,
        );

        state.begin_update(Player::Ip);
        state.traverse_root(
            game,
            Player::Ip,
            &init_ip_reach,
            &init_oop_reach,
            pos_discount,
            neg_discount,
            strat_weight,
        );

        if config.target_exploitability_pct > 0.0
            && config.check_interval > 0
            && (iter % config.check_interval == 0 || iter == config.max_iterations)
        {
            let strategies: Vec<NodeStrategy> = state.average_strategies(game);
            let report = compute_exploitability_turn(game, &strategies);
            if report.nash_distance_pct <= config.target_exploitability_pct {
                final_report = Some(report);
                break;
            }
            if iter == config.max_iterations {
                final_report = Some(report);
            }
        }
    }

    let strategies: Vec<NodeStrategy> = state.average_strategies(game);

    let exploitability =
        final_report.unwrap_or_else(|| compute_exploitability_turn(game, &strategies));

    let oop_evs: Vec<ComboEv> = game.combos[0]
        .iter()
        .copied()
        .zip(exploitability.oop_strategy_combo_evs.iter().copied())
        .map(|(combo, ev)| ComboEv { combo, ev })
        .collect();
    let ip_evs: Vec<ComboEv> = game.combos[1]
        .iter()
        .copied()
        .zip(exploitability.ip_strategy_combo_evs.iter().copied())
        .map(|(combo, ev)| ComboEv { combo, ev })
        .collect();

    TurnSolveResult {
        strategies,
        oop_evs,
        ip_evs,
        oop_game_ev: exploitability.oop_strategy_ev,
        ip_game_ev: exploitability.ip_strategy_ev,
        iterations: iterations_done,
        exploitability,
    }
}

#[allow(clippy::too_many_arguments)]
fn turn_traverse(
    game: &TurnGame,
    kernels: &PlayerKernels,
    buffers: &mut [TurnNodeBuffer],
    node_id: NodeId,
    traverser: Player,
    runout: Option<usize>,
    my_reach: &[f64],
    opp_reach: &[f64],
    pos_discount: f64,
    neg_discount: f64,
    strat_weight: f64,
) -> Vec<f64> {
    let p_idx = traverser.index();
    let q_idx = traverser.opponent().index();
    let num_my = game.combos[p_idx].len();
    let num_opp = game.combos[q_idx].len();

    match &game.nodes[node_id] {
        TurnNode::Terminal(term) => {
            let mut out = vec![0.0f64; num_my];
            match *term {
                TerminalNode::Fold { folder, committed } => {
                    let payoff = if folder == traverser {
                        -committed[p_idx]
                    } else {
                        game.starting_pot + committed[q_idx]
                    };
                    let kernel = match runout {
                        Some(r) => &kernels.runouts[r],
                        None => &kernels.turn_fold,
                    };
                    kernel.eval_fold(opp_reach, payoff, &mut out);
                }
                TerminalNode::Showdown { committed } => {
                    let r = runout.expect("showdown terminals only occur under a chance node");
                    let win_payoff = game.starting_pot + committed[q_idx];
                    let tie_payoff = 0.5 * game.starting_pot;
                    let loss_payoff = -committed[p_idx];
                    kernels.runouts[r].eval_showdown(
                        opp_reach,
                        win_payoff,
                        tie_payoff,
                        loss_payoff,
                        &mut out,
                    );
                }
            }
            out
        }
        TurnNode::Chance(chance) => {
            let mut node_cfv = vec![0.0f64; num_my];
            for (r, &child_id) in chance.children.iter().enumerate() {
                let child_cfv = turn_traverse(
                    game,
                    kernels,
                    buffers,
                    child_id,
                    traverser,
                    Some(r),
                    my_reach,
                    opp_reach,
                    pos_discount,
                    neg_discount,
                    strat_weight,
                );
                for i in 0..num_my {
                    node_cfv[i] += RIVER_DEAL_PROB * child_cfv[i];
                }
            }
            node_cfv
        }
        TurnNode::Decision(d) => {
            let decision_id = d.decision_id;
            let num_actions = d.actions.len();

            if d.player == traverser {
                let cur_strat = buffers[decision_id].current_strategy.clone();

                {
                    let cum_strat = &mut buffers[decision_id].cum_strategy;
                    for i in 0..num_my {
                        let w = strat_weight * my_reach[i];
                        if w > 0.0 {
                            let base = i * num_actions;
                            for a in 0..num_actions {
                                cum_strat[base + a] += w * cur_strat[base + a];
                            }
                        }
                    }
                }

                let mut action_cfvs: Vec<Vec<f64>> = Vec::with_capacity(num_actions);
                let mut node_cfv = vec![0.0f64; num_my];
                let mut next_my_reach = vec![0.0f64; num_my];

                for a in 0..num_actions {
                    let child_id = d.children[a];
                    for i in 0..num_my {
                        next_my_reach[i] = my_reach[i] * cur_strat[i * num_actions + a];
                    }
                    let child_cfv = turn_traverse(
                        game,
                        kernels,
                        buffers,
                        child_id,
                        traverser,
                        runout,
                        &next_my_reach,
                        opp_reach,
                        pos_discount,
                        neg_discount,
                        strat_weight,
                    );
                    for i in 0..num_my {
                        node_cfv[i] += cur_strat[i * num_actions + a] * child_cfv[i];
                    }
                    action_cfvs.push(child_cfv);
                }

                let regrets = &mut buffers[decision_id].regrets;
                for i in 0..num_my {
                    let base = i * num_actions;
                    let ev_i = node_cfv[i];
                    for a in 0..num_actions {
                        let inst_regret = action_cfvs[a][i] - ev_i;
                        let updated = regrets[base + a] + inst_regret;
                        regrets[base + a] = if updated >= 0.0 {
                            updated * pos_discount
                        } else {
                            updated * neg_discount
                        };
                    }
                }

                node_cfv
            } else {
                let opp_strat = buffers[decision_id].current_strategy.clone();
                let mut node_cfv = vec![0.0f64; num_my];
                let mut next_opp_reach = vec![0.0f64; num_opp];

                for a in 0..num_actions {
                    let child_id = d.children[a];
                    let mut any_opp = false;
                    for j in 0..num_opp {
                        let r = opp_reach[j] * opp_strat[j * num_actions + a];
                        next_opp_reach[j] = r;
                        if r > 0.0 {
                            any_opp = true;
                        }
                    }
                    if !any_opp {
                        continue;
                    }
                    let child_cfv = turn_traverse(
                        game,
                        kernels,
                        buffers,
                        child_id,
                        traverser,
                        runout,
                        my_reach,
                        &next_opp_reach,
                        pos_discount,
                        neg_discount,
                        strat_weight,
                    );
                    for i in 0..num_my {
                        node_cfv[i] += child_cfv[i];
                    }
                }

                node_cfv
            }
        }
    }
}
