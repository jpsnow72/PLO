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

use crate::action_ev::{compute_action_evs_turn, NodeActionEvs};
use crate::br::{compute_exploitability_turn, ExploitabilityReport};
use crate::cfr::{ComboEv, DcfrConfig, NodeStrategy};
use crate::locks::{resolve_locks_turn, NodeLock};
use crate::progress::ProgressReporter;
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
    /// ([`compute_exploitability_turn`]). For a locked solve this prices
    /// the lock (the locked profile's true exploitability).
    pub exploitability: ExploitabilityReport,
    /// The nodelocks this solve ran under (empty = unlocked). A locked
    /// profile is not an equilibrium; consumers must badge it LOCKED.
    pub locks: Vec<NodeLock>,
    /// Per-action conditional EVs at every decision node under the final
    /// average profile (issue #8; see [`crate::action_ev`]). For a locked
    /// solve these price the locked profile as-is.
    pub action_evs: Vec<NodeActionEvs>,
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
    /// Nodelock vector for this node (see `NodeBuffer` in `cfr.rs` for the
    /// semantics: pinned strategy, no regret updates, no cumulative
    /// accumulation, verbatim output).
    lock: Option<Vec<f64>>,
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
            lock: None,
        }
    }

    /// Pins this node's strategy to `frequencies` for the whole solve.
    fn set_lock(&mut self, frequencies: &[f64]) {
        debug_assert_eq!(frequencies.len(), self.num_actions);
        for i in 0..self.num_combos {
            let base = i * self.num_actions;
            self.current_strategy[base..base + self.num_actions].copy_from_slice(frequencies);
        }
        self.lock = Some(frequencies.to_vec());
    }

    /// Whether this node's strategy is locked.
    #[inline]
    fn is_locked(&self) -> bool {
        self.lock.is_some()
    }

    #[inline]
    fn recompute_current_strategy(&mut self) {
        if self.is_locked() {
            return;
        }
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
        if let Some(lock) = &self.lock {
            // Locked: the output strategy is the lock vector verbatim for
            // every combo (nothing was accumulated to normalize).
            let mut frequencies = vec![0.0f64; num_actions * self.num_combos];
            for i in 0..self.num_combos {
                let base = i * num_actions;
                frequencies[base..base + num_actions].copy_from_slice(lock);
            }
            return NodeStrategy {
                decision_id,
                node_id: d.node_id,
                player: d.player,
                history: d.history.clone(),
                actions: d.actions.clone(),
                num_combos: self.num_combos,
                frequencies,
            };
        }
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

/// Precomputed node-subtree spans used by the parallel chance fork
/// (Ticket E5a).
///
/// `TreeBuilder` creates nodes in DFS pre-order and numbers decision nodes in
/// creation order, so the decision nodes of any subtree form one contiguous
/// range of decision ids. The prefix tables turn "the buffers owned by the
/// subtree rooted at node `n`" into an O(1) range lookup:
/// `decision_prefix[n]..decision_prefix[n + node_subtree_len[n]]`, with
/// `slot_prefix` the same prefix summed over action slots
/// (`combos x actions` per decision node) instead of node counts.
#[derive(Clone, Debug)]
struct ForkTables {
    /// `node_subtree_len[n]` = number of nodes in the subtree rooted at `n`
    /// (including `n`). Children always have larger node ids than their
    /// parent, so a reverse sweep computes this exactly.
    node_subtree_len: Vec<usize>,
    /// `decision_prefix[n]` = number of decision nodes among `nodes[0..n]`.
    decision_prefix: Vec<usize>,
    /// `slot_prefix[n]` = action slots of decision nodes among `nodes[0..n]`.
    slot_prefix: Vec<usize>,
}

impl ForkTables {
    fn build(game: &TurnGame) -> Self {
        let n = game.nodes.len();
        let mut decision_prefix = vec![0usize; n + 1];
        let mut slot_prefix = vec![0usize; n + 1];
        for (i, node) in game.nodes.iter().enumerate() {
            let (is_decision, slots) = match node {
                TurnNode::Decision(d) => (
                    1usize,
                    game.combos[d.player.index()].len() * d.actions.len(),
                ),
                _ => (0, 0),
            };
            decision_prefix[i + 1] = decision_prefix[i] + is_decision;
            slot_prefix[i + 1] = slot_prefix[i] + slots;
        }
        let mut node_subtree_len = vec![1usize; n];
        for i in (0..n).rev() {
            let children: &[NodeId] = match &game.nodes[i] {
                TurnNode::Decision(d) => &d.children,
                TurnNode::Chance(c) => &c.children,
                TurnNode::Terminal(_) => &[],
            };
            node_subtree_len[i] = 1 + children.iter().map(|&c| node_subtree_len[c]).sum::<usize>();
        }
        Self {
            node_subtree_len,
            decision_prefix,
            slot_prefix,
        }
    }

    /// The buffer range owned by the subtree rooted at `node_id`:
    /// `(first_decision_id, one_past_last_decision_id, total_action_slots)`.
    #[inline]
    fn subtree_span(&self, node_id: NodeId) -> (usize, usize, usize) {
        let end_node = node_id + self.node_subtree_len[node_id];
        (
            self.decision_prefix[node_id],
            self.decision_prefix[end_node],
            self.slot_prefix[end_node] - self.slot_prefix[node_id],
        )
    }
}

/// One contiguous group of chance children assigned to a single worker
/// thread, with the buffer range the group owns. Groups are ordered,
/// non-overlapping, and together cover every child exactly once; their
/// buffer ranges are disjoint and ascending (children of a chance node are
/// built back-to-back, so sibling subtree ranges are adjacent — and the
/// planner only relies on each child's range lying inside its group's
/// range, which holds by construction of the prefix tables).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
struct ChanceGroup {
    /// First child index (into `ChanceNode::children`) of the group.
    child_start: usize,
    /// One past the last child index of the group.
    child_end: usize,
    /// First decision id owned by the group.
    buf_lo: usize,
    /// One past the last decision id owned by the group.
    buf_hi: usize,
}

/// Partitions chance children into at most `threads` contiguous groups,
/// greedily balancing total action slots: children accumulate into the
/// current group until its slot count reaches the fair share
/// `ceil(total / threads)`, then a new group starts. The final group takes
/// the remainder, so the group count never exceeds `threads`.
fn plan_chance_groups(spans: &[(usize, usize, usize)], threads: usize) -> Vec<ChanceGroup> {
    debug_assert!(threads >= 1);
    debug_assert!(!spans.is_empty());
    let total: usize = spans.iter().map(|s| s.2).sum();
    let target = total.div_ceil(threads).max(1);
    let mut groups = Vec::new();
    let mut start = 0usize;
    let mut acc = 0usize;
    for (i, span) in spans.iter().enumerate() {
        acc += span.2;
        if acc >= target && i + 1 < spans.len() {
            groups.push(ChanceGroup {
                child_start: start,
                child_end: i + 1,
                buf_lo: spans[start].0,
                buf_hi: span.1,
            });
            start = i + 1;
            acc = 0;
        }
    }
    groups.push(ChanceGroup {
        child_start: start,
        child_end: spans.len(),
        buf_lo: spans[start].0,
        buf_hi: spans[spans.len() - 1].1,
    });
    groups
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
    /// Worker threads used by the chance-node fork in
    /// [`traverse_root`](Self::traverse_root) (Ticket E5a). Resolved from
    /// `PLO_SOLVER_THREADS` at construction; `1` disables forking.
    threads: usize,
    /// Node-subtree spans for buffer partitioning (Ticket E5a).
    fork_tables: ForkTables,
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
        Self {
            kernels,
            buffers,
            threads: crate::parallel::solver_threads(),
            fork_tables: ForkTables::build(game),
        }
    }

    /// The kernels this state traverses with.
    pub fn kernels(&self) -> &TurnKernels {
        &self.kernels
    }

    /// Overrides the worker-thread count used by the chance-node fork
    /// (values `< 1` are clamped to `1`). [`solve_turn`] and [`solve_flop`]
    /// resolve this from `PLO_SOLVER_THREADS`; the `*_with_threads` entry
    /// points and embedders that manage their own pool sizing use this.
    pub fn set_threads(&mut self, threads: usize) {
        self.threads = threads.max(1);
    }

    /// The worker-thread count currently configured for this state.
    pub fn threads(&self) -> usize {
        self.threads
    }

    /// Applies resolved nodelocks (per decision id, `None` = unlocked;
    /// produced by [`crate::locks::resolve_locks_turn`] or the flop
    /// resolver for this subtree's game) by pinning the locked buffers.
    /// Call before the first traversal: a lock is a constraint on the game
    /// from iteration 0.
    pub fn apply_locks(&mut self, resolved: &[Option<Vec<f64>>]) {
        debug_assert_eq!(resolved.len(), self.buffers.len());
        for (did, slot) in resolved.iter().enumerate() {
            if let Some(frequencies) = slot {
                self.buffers[did].set_lock(frequencies);
            }
        }
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
            &self.fork_tables,
            self.threads,
            0,
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
/// Chance-node subtrees are evaluated in parallel on
/// [`crate::parallel::solver_threads`] worker threads (from
/// `PLO_SOLVER_THREADS`; `1` = the pre-E5a single-thread behaviour, with
/// bit-identical results — see [`turn_traverse`]).
pub fn solve_turn(game: &TurnGame, config: &DcfrConfig) -> TurnSolveResult {
    solve_turn_impl(game, config, TurnSolverState::new(game))
}

/// Like [`solve_turn`], with an explicit worker-thread count for the
/// chance-node fork (`1` = single-threaded), ignoring `PLO_SOLVER_THREADS`.
pub fn solve_turn_with_threads(
    game: &TurnGame,
    config: &DcfrConfig,
    threads: usize,
) -> TurnSolveResult {
    let mut state = TurnSolverState::new(game);
    state.set_threads(threads);
    solve_turn_impl(game, config, state)
}

fn solve_turn_impl(
    game: &TurnGame,
    config: &DcfrConfig,
    mut state: TurnSolverState,
) -> TurnSolveResult {
    // Pin nodelocks before iteration 0 (invalid locks are a caller bug;
    // validate_locks_turn exposes the error as a value beforehand).
    let resolved_locks = resolve_locks_turn(game, &config.locks)
        .expect("invalid node lock in DcfrConfig (validate locks before solving)");
    state.apply_locks(&resolved_locks);

    let init_oop_reach: Vec<f64> = game.combos[0].iter().map(|c| c.weight).collect();
    let init_ip_reach: Vec<f64> = game.combos[1].iter().map(|c| c.weight).collect();

    let mut iterations_done = 0usize;
    let mut final_report: Option<ExploitabilityReport> = None;
    let progress = ProgressReporter::new();

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

        // Progress reporting (issue #48): price the current average
        // strategy with the same checker the final number uses, on the
        // same snapshot extraction. Read-only — see progress.rs.
        if progress.due(iter) {
            let strategies: Vec<NodeStrategy> = state.average_strategies(game);
            let report = compute_exploitability_turn(game, &strategies);
            progress.report(iter, report.nash_distance_pct);
        }

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

    let action_evs = compute_action_evs_turn(game, &strategies);

    TurnSolveResult {
        strategies,
        oop_evs,
        ip_evs,
        oop_game_ev: exploitability.oop_strategy_ev,
        ip_game_ev: exploitability.ip_strategy_ev,
        iterations: iterations_done,
        exploitability,
        locks: config.locks.clone(),
        action_evs,
    }
}

/// One DCFR traversal of the two-street tree.
///
/// Parallelism (Ticket E5a): at a chance node the runout subtrees may be
/// evaluated on scoped worker threads. The argument rests on three facts:
/// (1) within a half-iteration, `current_strategy` is fixed (recomputed only
/// by `begin_update`, between traversals) and every decision node is visited
/// exactly once, so each node's regret / cumulative-strategy update is
/// computed by exactly one worker with exactly the sequential operation
/// order; (2) the subtree rooted at any node owns the contiguous buffer
/// range given by [`ForkTables`], and sibling ranges are disjoint, so
/// workers write to disjoint `buffers` partitions; (3) this frame combines
/// the returned child counterfactual values in ascending runout order, the
/// same order the sequential loop adds them. The multithreaded traversal
/// therefore performs the identical floating-point operations as the
/// single-threaded one and produces bit-identical results at any thread
/// count (verified by `tests/e5_threading.rs`).
///
/// `buffers` is the partition this call may touch: `buffers[i]` holds
/// decision id `buf_base + i`. Non-forking recursion passes both through
/// unchanged; a chance fork hands each worker its group's sub-slice with
/// `buf_base` set to the group's first decision id.
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
    fork: &ForkTables,
    threads: usize,
    buf_base: usize,
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
            // Total action slots of the runout subtrees, from the
            // precomputed prefix tables (the fork decision).
            let total_slots: usize = chance
                .children
                .iter()
                .map(|&child_id| fork.subtree_span(child_id).2)
                .sum();

            if !crate::parallel::should_fork(threads, total_slots) {
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
                        fork,
                        threads,
                        buf_base,
                    );
                    for i in 0..num_my {
                        node_cfv[i] += RIVER_DEAL_PROB * child_cfv[i];
                    }
                }
                return node_cfv;
            }

            // Fork: partition the children into contiguous slot-balanced
            // groups, carve the matching disjoint partitions out of
            // `buffers`, and evaluate each group on a scoped thread. The
            // gap slices before/between groups belong to subtrees outside
            // this chance node and stay untouched until the scope joins.
            crate::parallel::note_fork_event();
            let spans: Vec<(usize, usize, usize)> = chance
                .children
                .iter()
                .map(|&child_id| fork.subtree_span(child_id))
                .collect();
            let groups = plan_chance_groups(&spans, threads);
            let mut group_slices: Vec<&mut [TurnNodeBuffer]> = Vec::with_capacity(groups.len());
            {
                let mut rest: &mut [TurnNodeBuffer] = buffers;
                let mut rest_base = buf_base;
                for group in &groups {
                    let skip = group.buf_lo - rest_base;
                    let cur = std::mem::replace(&mut rest, &mut []);
                    let (_gap, after) = cur.split_at_mut(skip);
                    let (slice, new_rest) = after.split_at_mut(group.buf_hi - group.buf_lo);
                    group_slices.push(slice);
                    rest = new_rest;
                    rest_base = group.buf_hi;
                }
            }
            std::thread::scope(|scope| {
                let mut handles = Vec::with_capacity(groups.len());
                for (group, slice) in groups.iter().copied().zip(group_slices) {
                    handles.push(scope.spawn(move || {
                        let mut slice = slice;
                        let mut cfvs = Vec::with_capacity(group.child_end - group.child_start);
                        for r in group.child_start..group.child_end {
                            cfvs.push(turn_traverse(
                                game,
                                kernels,
                                &mut *slice,
                                chance.children[r],
                                traverser,
                                Some(r),
                                my_reach,
                                opp_reach,
                                pos_discount,
                                neg_discount,
                                strat_weight,
                                fork,
                                threads,
                                group.buf_lo,
                            ));
                        }
                        cfvs
                    }));
                }
                // Join in spawn order and combine in ascending runout
                // order — the identical summation order to the sequential
                // loop above.
                for handle in handles {
                    let cfvs = handle.join().expect("chance-fork worker panicked");
                    for child_cfv in &cfvs {
                        for i in 0..num_my {
                            node_cfv[i] += RIVER_DEAL_PROB * child_cfv[i];
                        }
                    }
                }
            });
            node_cfv
        }
        TurnNode::Decision(d) => {
            let decision_id = d.decision_id;
            // Index into this call's buffer partition (see the fn docs).
            let buf_idx = decision_id - buf_base;
            let num_actions = d.actions.len();

            if d.player == traverser {
                let cur_strat = buffers[buf_idx].current_strategy.clone();
                let locked = buffers[buf_idx].is_locked();

                // Locked nodes accumulate no average strategy (their output
                // is the lock vector itself).
                if !locked {
                    let cum_strat = &mut buffers[buf_idx].cum_strategy;
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
                        fork,
                        threads,
                        buf_base,
                    );
                    for i in 0..num_my {
                        node_cfv[i] += cur_strat[i * num_actions + a] * child_cfv[i];
                    }
                    action_cfvs.push(child_cfv);
                }

                // Locked nodes update no regrets (their strategy is the
                // lock vector, not regret matching); the node CFV above is
                // still computed under the locked strategy.
                if !locked {
                    let regrets = &mut buffers[buf_idx].regrets;
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
                }

                node_cfv
            } else {
                let opp_strat = buffers[buf_idx].current_strategy.clone();
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
                        fork,
                        threads,
                        buf_base,
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

#[cfg(test)]
mod e5_fork_tests {
    use super::*;

    /// Fabricates spans for `n` children with the given per-child slot
    /// counts, laid out as adjacent buffer ranges starting at `base`.
    fn spans_from_slots(slots: &[usize], base: usize) -> Vec<(usize, usize, usize)> {
        let mut out = Vec::with_capacity(slots.len());
        let mut lo = base;
        for (k, &s) in slots.iter().enumerate() {
            // Give child k a distinct non-empty decision range unless it
            // models an all-in terminal child (0 slots -> empty range).
            let width = if s == 0 { 0 } else { 1 + k };
            out.push((lo, lo + width, s));
            lo += width;
        }
        out
    }

    fn assert_partition(spans: &[(usize, usize, usize)], groups: &[ChanceGroup], threads: usize) {
        assert!(!groups.is_empty());
        assert!(groups.len() <= threads.max(1));
        // Children covered exactly once, in order.
        assert_eq!(groups[0].child_start, 0);
        assert_eq!(groups[groups.len() - 1].child_end, spans.len());
        for w in groups.windows(2) {
            assert_eq!(w[0].child_end, w[1].child_start);
        }
        for g in groups {
            assert!(g.child_start < g.child_end);
            // The group's buffer range contains every child's range.
            assert_eq!(g.buf_lo, spans[g.child_start].0);
            assert_eq!(g.buf_hi, spans[g.child_end - 1].1);
            // Groups are disjoint and ascending in buffer space.
            assert!(g.buf_lo < g.buf_hi || spans[g.child_start].2 == 0);
        }
        for w in groups.windows(2) {
            assert!(w[0].buf_hi <= w[1].buf_lo);
        }
    }

    #[test]
    fn planner_partitions_48_equal_children() {
        let spans = spans_from_slots(&[100usize; 48], 7);
        for threads in [2usize, 3, 4, 6, 8, 48, 64] {
            let groups = plan_chance_groups(&spans, threads);
            assert_partition(&spans, &groups, threads);
        }
    }

    #[test]
    fn planner_handles_skewed_and_empty_children() {
        // One heavy child, several all-in terminal children (0 slots).
        let mut slots = vec![0usize; 48];
        slots[0] = 5_000;
        slots[10] = 300;
        slots[47] = 100;
        let spans = spans_from_slots(&slots, 0);
        for threads in [2usize, 4, 8] {
            let groups = plan_chance_groups(&spans, threads);
            assert_partition(&spans, &groups, threads);
            // The heavy child must not be merged with everything else:
            // the planner closes a group as soon as the fair share is met.
            assert!(groups[0].child_end < spans.len());
        }
    }

    #[test]
    fn planner_single_thread_is_one_group() {
        let spans = spans_from_slots(&[50usize; 48], 3);
        let groups = plan_chance_groups(&spans, 1);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].child_start, 0);
        assert_eq!(groups[0].child_end, 48);
        assert_eq!(groups[0].buf_lo, spans[0].0);
        assert_eq!(groups[0].buf_hi, spans[47].1);
    }

    #[test]
    fn fork_tables_spans_are_contiguous_and_cover_all_decisions() {
        // Small real game: build a TurnGame and verify the span of the
        // root covers every decision node, and the spans of a chance
        // node's children are adjacent (the fork's partitioning premise).
        let spot = TurnSpot {
            board: Card::parse_n::<4>("As Ks Qs 7d").unwrap(),
            oop_range: PloRange::from_str_specs(&[
                ("Kc 9c 3d 4d", 1.0),
                ("Ah Ad 5h 6h", 0.7),
                ("Ts 9s 8c 9d", 1.0),
            ])
            .unwrap(),
            ip_range: PloRange::from_str_specs(&[
                ("Jh Th 8h 9h", 1.0),
                ("2c 3c 4h 5d", 0.5),
            ])
            .unwrap(),
            starting_pot: 100.0,
            effective_stack: 100.0,
            turn_config: TreeConfig {
                bet_sizes: vec![1.0],
                include_all_in_bet: false,
                raise_sizes: vec![],
                include_all_in_raise: false,
                max_raises: 0,
            },
            river_config: TreeConfig {
                bet_sizes: vec![1.0],
                include_all_in_bet: false,
                raise_sizes: vec![],
                include_all_in_raise: false,
                max_raises: 0,
            },
        };
        let game = TurnGame::new(spot).unwrap();
        let tables = ForkTables::build(&game);

        let (lo, hi, slots) = tables.subtree_span(0);
        assert_eq!(lo, 0);
        assert_eq!(hi, game.num_decision_nodes());
        let expected_slots: usize = (0..game.num_decision_nodes())
            .map(|did| {
                let d = game.decision_node(did);
                game.combos[d.player.index()].len() * d.actions.len()
            })
            .sum();
        assert_eq!(slots, expected_slots);

        assert!(!game.chance_node_ids.is_empty());
        for &cn in &game.chance_node_ids {
            let chance = match &game.nodes[cn] {
                TurnNode::Chance(c) => c,
                _ => unreachable!(),
            };
            let child_spans: Vec<_> = chance
                .children
                .iter()
                .map(|&cid| tables.subtree_span(cid))
                .collect();
            for w in child_spans.windows(2) {
                assert_eq!(w[0].1, w[1].0, "sibling subtree ranges must be adjacent");
            }
            // Sum of child decision counts = chance subtree decision count.
            let (clo, chi, _) = tables.subtree_span(cn);
            let child_total: usize = child_spans.iter().map(|s| s.1 - s.0).sum();
            assert_eq!(chi - clo, child_total);
        }
    }
}
