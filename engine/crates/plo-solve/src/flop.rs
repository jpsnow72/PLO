//! Flop solver (Ticket E4): heads-up PLO three-street game (flop + turn + river)
//! with **card bucketing on the flop street only** and exact combo-level play on
//! the turn and river.
//!
//! Structure: the flop action tree is built with the E2 pot-limit legality
//! machinery ([`legal_bet_sizes`] / [`legal_raise_sizes`]). Every closed flop
//! history (check-check or a called bet/raise) leads to a *group* of 49 subtrees
//! — one [`TurnGame`] per possible turn card — reusing the E3 two-street solver
//! machinery ([`TurnSolverState`]) below the flop. All-in flop calls are not
//! special-cased: their subtrees simply have zero stack behind and degenerate
//! to check-downs, exactly as in E3.
//!
//! Chance semantics (exact): for any valid (disjoint) combo pair on a 3-card
//! board, the number of dealable turn cards is `52 - 3 (board) - 4 - 4 (holes)
//! = 41`, each with probability [`TURN_CARD_DEAL_PROB`] = `1/41`. Subtrees whose
//! turn card lies in a combo contribute exactly 0 for pairs involving that
//! combo (the combo is absent from that subtree's game).
//!
//! Abstraction: on the flop street, each player acts on *buckets* of combos
//! (see [`crate::buckets`]); a bucket shares one strategy across its combos.
//! Counterfactual regrets at a bucket infoset are the range-weight-summed
//! per-combo counterfactual regrets (per-infoset constant scaling does not
//! change regret matching; the range-weight sum is the relative weighting of
//! combos inside the bucket). Turn/river subtrees are solved exactly per combo.
//!
//! Exploitability of a flop solve is measured by
//! [`crate::br::compute_exploitability_flop`], which plays exact combo-level
//! best response against the bucketed profile in the *unabstracted* game —
//! that number (not any solver-internal estimate) is reported in
//! [`FlopSolveResult`].
//!
//! Early stopping is intentionally not wired into [`solve_flop`]: the checker
//! is the expensive part at flop scale, so the solver runs the configured
//! fixed iteration budget and measures once at the end.

use std::collections::HashMap;
use std::rc::Rc;

use plo_cards::{Card, HandMask};
use plo_eval::{PloRange, WeightedCombo};

use crate::br::{compute_exploitability_flop, ExploitabilityReport};
use crate::buckets::{assign_buckets, BucketAssignment};
use crate::cfr::{ComboEv, DcfrConfig, NodeStrategy};
use crate::game::{
    legal_bet_sizes, legal_raise_sizes, Action, NodeId, Player, SolveError, TerminalNode,
    TreeConfig, CHIP_EPS,
};
use crate::turn::{TurnGame, TurnKernels, TurnSolverState, TurnSpot};

/// Probability of each individual turn card for a valid combo pair (`1/41`).
pub const TURN_CARD_DEAL_PROB: f64 = 1.0 / 41.0;

/// How the flop street is abstracted for a [`FlopGame`].
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum BucketConfig {
    /// No abstraction: every combo is its own bucket.
    Exact,
    /// Bucket each player's range into at most `K` buckets.
    K(usize),
}

/// Input specification for a heads-up flop spot.
#[derive(Clone, Debug)]
pub struct FlopSpot {
    /// Fixed 3-card flop board.
    pub board: [Card; 3],
    /// Out-of-position player's weighted 4-card range.
    pub oop_range: PloRange,
    /// In-position player's weighted 4-card range.
    pub ip_range: PloRange,
    /// Pot size at the start of the flop (must be `> 0.0`).
    pub starting_pot: f64,
    /// Effective stack size behind at the start of the flop (must be `>= 0.0`).
    pub effective_stack: f64,
    /// Action tree configuration for the flop street.
    pub flop_config: TreeConfig,
    /// Action tree configuration for the turn street (inside subtrees).
    pub turn_config: TreeConfig,
    /// Action tree configuration for the river street (inside subtrees).
    pub river_config: TreeConfig,
    /// Flop-street bucketing configuration.
    pub bucket_config: BucketConfig,
}

/// One turn-card subtree below a closed flop history: a full E3 [`TurnGame`]
/// on `board + turn_card`, plus the combo-index maps between the flop ranges
/// and the subtree's (card-filtered) ranges.
///
/// `game` is `None` for a *dead* subtree: a turn card on which one player's
/// filtered range is empty or every pair is blocked (only possible for very
/// narrow ranges). Dead subtrees contribute exactly 0 to every pair.
#[derive(Clone, Debug)]
pub struct FlopSubtree {
    /// The turn card this subtree deals.
    pub turn_card: Card,
    /// Flop action history that closed the street (e.g. `"X/X"`, `"B(75)/C"`).
    pub flop_history: String,
    /// Chips committed per player on the flop when the street closed.
    pub committed: f64,
    /// The two-street game, or `None` for a dead subtree.
    pub game: Option<TurnGame>,
    /// `oop_map[flop_combo_idx] = subtree combo index` (`None` if the combo
    /// contains the turn card). Empty when `game` is `None`.
    pub oop_map: Vec<Option<usize>>,
    /// Same for IP.
    pub ip_map: Vec<Option<usize>>,
}

impl FlopSubtree {
    /// Combo-index map for `player` (flop combo index -> subtree combo index).
    #[inline]
    pub fn map_for(&self, player: Player) -> &[Option<usize>] {
        match player {
            Player::Oop => &self.oop_map,
            Player::Ip => &self.ip_map,
        }
    }
}

/// All turn-card subtrees below one closed flop history, aligned with
/// `FlopGame::turn_cards`.
#[derive(Clone, Debug)]
pub struct FlopSubtreeGroup {
    /// Flop action history that closed the street.
    pub flop_history: String,
    /// Chips committed per player on the flop when the street closed.
    pub committed: [f64; 2],
    /// Indices into `FlopGame::subtrees`, one per turn card.
    pub subtrees: Vec<usize>,
}

/// Child of a flop decision node: another flop node, or a whole group of
/// turn-card subtrees (when the action closes the flop street).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum FlopChild {
    /// A node in `FlopGame::nodes`.
    Node(NodeId),
    /// A group index into `FlopGame::subtree_groups`.
    Subtrees(usize),
}

/// Decision node in the flop action tree (flop street only; turn/river
/// decisions live inside the subtrees' [`TurnGame`]s).
#[derive(Clone, Debug)]
pub struct FlopDecisionNode {
    /// Index of this node in `FlopGame::nodes`.
    pub node_id: NodeId,
    /// Sequential index among flop decision nodes only.
    pub decision_id: usize,
    /// Acting player.
    pub player: Player,
    /// Action history string reaching this node (e.g. `"root"`, `"B(75)"`).
    pub history: String,
    /// Flop chips committed by `[OOP, IP]` prior to this decision.
    pub committed: [f64; 2],
    /// Total pot prior to this decision.
    pub current_pot: f64,
    /// Chips required for `player` to call (`0.0` if no bet facing).
    pub to_call: f64,
    /// Number of raises made so far on the flop.
    pub raises_so_far: usize,
    /// Legal actions available at this node.
    pub actions: Vec<Action>,
    /// Child corresponding to each action in `actions`.
    pub children: Vec<FlopChild>,
}

/// A node in the flop-street tree (decision or fold terminal; showdowns only
/// occur inside subtrees).
#[derive(Clone, Debug)]
pub enum FlopNode {
    Decision(FlopDecisionNode),
    Terminal(TerminalNode),
}

/// Compiled, validated heads-up flop game ready for solving and checking.
#[derive(Clone, Debug)]
pub struct FlopGame {
    /// Fixed 3-card flop board.
    pub board: [Card; 3],
    /// `HandMask` of the 3-card board.
    pub board_mask: HandMask,
    /// Starting pot at the beginning of the flop.
    pub starting_pot: f64,
    /// Effective stack size at the beginning of the flop.
    pub effective_stack: f64,
    /// Tree configuration used for the flop street.
    pub flop_config: TreeConfig,
    /// Tree configuration used for the turn street inside subtrees.
    pub turn_config: TreeConfig,
    /// Tree configuration used for the river street inside subtrees.
    pub river_config: TreeConfig,
    /// Bucketing configuration the game was built with.
    pub bucket_config: BucketConfig,
    /// Active (board-unblocked) weighted combos for `[OOP, IP]`.
    pub combos: [Vec<WeightedCombo>; 2],
    /// Bucket assignment per player on the flop board.
    pub assignments: [BucketAssignment; 2],
    /// Every card that can be dealt as the turn (all cards not on the flop),
    /// in deck order (49 cards).
    pub turn_cards: Vec<Card>,
    /// Flop-street nodes; `nodes[0]` is the root.
    pub nodes: Vec<FlopNode>,
    /// Indices into `nodes` for each flop `decision_id`.
    pub decision_node_ids: Vec<NodeId>,
    /// All turn-card subtrees (grouped by [`FlopSubtreeGroup`]).
    pub subtrees: Vec<FlopSubtree>,
    /// Subtree groups, one per closed flop history.
    pub subtree_groups: Vec<FlopSubtreeGroup>,
}

impl FlopGame {
    /// Validates a [`FlopSpot`], filters board-blocked combos, builds bucket
    /// assignments, the flop action tree, and every turn-card subtree.
    pub fn new(spot: FlopSpot) -> Result<Self, SolveError> {
        let board_mask = HandMask::from_cards(&spot.board);
        if board_mask.count() != 3 {
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

        let assignments = match spot.bucket_config {
            BucketConfig::Exact => [
                BucketAssignment::exact(spot.board, &combos[0]),
                BucketAssignment::exact(spot.board, &combos[1]),
            ],
            BucketConfig::K(k) => [
                assign_buckets(spot.board, &combos[0], k),
                assign_buckets(spot.board, &combos[1], k),
            ],
        };

        let turn_cards: Vec<Card> = (HandMask::FULL_DECK - board_mask).iter().collect();
        debug_assert_eq!(turn_cards.len(), 49);

        let (nodes, decision_node_ids, subtrees, subtree_groups) = {
            let mut builder = FlopTreeBuilder {
                board: spot.board,
                starting_pot: spot.starting_pot,
                effective_stack: spot.effective_stack,
                flop_config: &spot.flop_config,
                turn_config: &spot.turn_config,
                river_config: &spot.river_config,
                combos: &combos,
                turn_cards: &turn_cards,
                nodes: Vec::new(),
                decision_node_ids: Vec::new(),
                subtrees: Vec::new(),
                subtree_groups: Vec::new(),
            };
            builder.build_decision(Player::Oop, [0.0, 0.0], 0.0, 0, false, "root".to_string());
            (
                builder.nodes,
                builder.decision_node_ids,
                builder.subtrees,
                builder.subtree_groups,
            )
        };

        Ok(Self {
            board: spot.board,
            board_mask,
            starting_pot: spot.starting_pot,
            effective_stack: spot.effective_stack,
            flop_config: spot.flop_config,
            turn_config: spot.turn_config,
            river_config: spot.river_config,
            bucket_config: spot.bucket_config,
            combos,
            assignments,
            turn_cards,
            nodes,
            decision_node_ids,
            subtrees,
            subtree_groups,
        })
    }

    /// Number of flop-street decision nodes.
    #[inline]
    pub fn num_decision_nodes(&self) -> usize {
        self.decision_node_ids.len()
    }

    /// Returns the [`FlopDecisionNode`] with the given flop `decision_id`.
    #[inline]
    pub fn decision_node(&self, decision_id: usize) -> &FlopDecisionNode {
        match &self.nodes[self.decision_node_ids[decision_id]] {
            FlopNode::Decision(d) => d,
            FlopNode::Terminal(_) => unreachable!("decision_node_ids only indexes Decision nodes"),
        }
    }

    /// Returns the active combos for `player`.
    #[inline]
    pub fn player_combos(&self, player: Player) -> &[WeightedCombo] {
        &self.combos[player.index()]
    }

    /// Number of buckets used for `player` on the flop street.
    #[inline]
    pub fn num_buckets(&self, player: Player) -> usize {
        self.assignments[player.index()].num_buckets()
    }

    /// Number of turn cards dealable to the pair `(oop_idx, ip_idx)`:
    /// `52 - |board ∪ hole_oop ∪ hole_ip|` (= 41 for every disjoint pair).
    pub fn pair_turn_card_count(&self, oop_idx: usize, ip_idx: usize) -> usize {
        let used = self
            .board_mask
            .union(self.combos[0][oop_idx].mask)
            .union(self.combos[1][ip_idx].mask);
        (HandMask::FULL_DECK - used).count() as usize
    }

    /// Flop-street information sets: `sum over flop decision nodes of the
    /// acting player's bucket count`.
    pub fn flop_infosets(&self) -> usize {
        self.decision_node_ids
            .iter()
            .map(|&nid| match &self.nodes[nid] {
                FlopNode::Decision(d) => self.num_buckets(d.player),
                FlopNode::Terminal(_) => 0,
            })
            .sum()
    }

    /// Flop-street strategy slots: `sum over flop decision nodes of
    /// buckets × actions`.
    pub fn flop_action_slots(&self) -> usize {
        self.decision_node_ids
            .iter()
            .map(|&nid| match &self.nodes[nid] {
                FlopNode::Decision(d) => self.num_buckets(d.player) * d.actions.len(),
                FlopNode::Terminal(_) => 0,
            })
            .sum()
    }

    /// Exact (turn+river) information sets inside all live subtrees.
    pub fn subtree_infosets(&self) -> usize {
        self.subtrees
            .iter()
            .filter_map(|s| s.game.as_ref())
            .map(|g| g.num_infosets())
            .sum()
    }

    /// Exact (turn+river) strategy slots inside all live subtrees:
    /// `sum over subtree decision nodes of combos × actions`.
    pub fn subtree_action_slots(&self) -> usize {
        self.subtrees
            .iter()
            .filter_map(|s| s.game.as_ref())
            .map(|g| turn_action_slots(g))
            .sum()
    }

    /// Total information sets of the whole game (bucketed flop + exact
    /// turn/river). In exact mode this is the unabstracted infoset count.
    pub fn num_infosets(&self) -> usize {
        self.flop_infosets() + self.subtree_infosets()
    }

    /// Total strategy slots of the whole game.
    pub fn action_slots(&self) -> usize {
        self.flop_action_slots() + self.subtree_action_slots()
    }

    /// Strategy + regret storage for the whole game at `bytes_per_float`
    /// (4 for `f32`, 2 for `f16`): two arrays (average strategy, regret) of
    /// one float per action slot.
    pub fn strategy_regret_bytes(&self, bytes_per_float: usize) -> usize {
        2 * self.action_slots() * bytes_per_float
    }

    /// Estimated solver working set in bytes: the three `f64` DCFR arrays
    /// (regret + cumulative + current strategy) over all action slots, plus
    /// the turn kernels shared per turn card, plus the flop fold kernels.
    /// This is the number the Phase 3 RAM-tier decision is based on.
    pub fn solver_working_bytes(&self) -> usize {
        let buffers = 3 * self.action_slots() * std::mem::size_of::<f64>();
        // Shared kernels: one TurnKernels per distinct turn card among live
        // subtrees. Kernel size is combo-count driven; rebuild the size from
        // the first live subtree per card (all subtrees with the same card
        // have identical combos/ranks, hence identical kernel sizes).
        let mut kernel_bytes = 0usize;
        let mut seen_cards: Vec<Card> = Vec::new();
        for sub in &self.subtrees {
            if let Some(g) = &sub.game {
                if !seen_cards.contains(&sub.turn_card) {
                    seen_cards.push(sub.turn_card);
                    kernel_bytes += TurnKernels::new(g).memory_bytes();
                }
            }
        }
        // Flop fold kernels: per player, one u32 index per unblocked opponent
        // combo per combo (upper bound: n_oop * n_ip per player).
        let fold_kernel_bytes = 2
            * self.combos[0].len()
            * self.combos[1].len()
            * std::mem::size_of::<u32>();
        buffers + kernel_bytes + fold_kernel_bytes
    }
}

/// Strategy slots of one [`TurnGame`]: `sum over decision nodes of
/// combos × actions` (mirrors `TurnSolverState::action_slots` without
/// building a solver state).
pub fn turn_action_slots(game: &TurnGame) -> usize {
    game.decision_node_ids
        .iter()
        .map(|&nid| match &game.nodes[nid] {
            crate::turn::TurnNode::Decision(d) => {
                game.combos[d.player.index()].len() * d.actions.len()
            }
            _ => 0,
        })
        .sum()
}

struct FlopTreeBuilder<'a> {
    board: [Card; 3],
    starting_pot: f64,
    effective_stack: f64,
    flop_config: &'a TreeConfig,
    turn_config: &'a TreeConfig,
    river_config: &'a TreeConfig,
    combos: &'a [Vec<WeightedCombo>; 2],
    turn_cards: &'a [Card],
    nodes: Vec<FlopNode>,
    decision_node_ids: Vec<NodeId>,
    subtrees: Vec<FlopSubtree>,
    subtree_groups: Vec<FlopSubtreeGroup>,
}

impl<'a> FlopTreeBuilder<'a> {
    #[allow(clippy::too_many_arguments)]
    fn build_decision(
        &mut self,
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
        let current_pot = self.starting_pot + committed[0] + committed[1];

        let mut actions = Vec::new();
        if to_call <= CHIP_EPS {
            actions.push(Action::Check);
            for (to, is_all_in) in
                legal_bet_sizes(self.starting_pot, self.effective_stack, self.flop_config)
            {
                actions.push(Action::Bet { to, is_all_in });
            }
        } else {
            actions.push(Action::Fold);
            actions.push(Action::Call {
                to: opp_committed,
                call_amount: to_call,
            });
            let raises = legal_raise_sizes(
                self.starting_pot,
                self.effective_stack,
                actor_committed,
                opp_committed,
                last_bet_or_raise_delta,
                raises_so_far,
                self.flop_config,
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
        self.nodes.push(FlopNode::Decision(FlopDecisionNode {
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
            let child = match *action {
                Action::Check => {
                    if player == Player::Oop && !oop_checked {
                        FlopChild::Node(self.build_decision(
                            Player::Ip,
                            committed,
                            0.0,
                            0,
                            true,
                            child_history,
                        ))
                    } else {
                        self.close_street(committed, child_history)
                    }
                }
                Action::Fold => {
                    let cid = self.nodes.len();
                    self.nodes.push(FlopNode::Terminal(TerminalNode::Fold {
                        folder: player,
                        committed,
                    }));
                    FlopChild::Node(cid)
                }
                Action::Call { to, .. } => {
                    let mut next_committed = committed;
                    next_committed[p_idx] = to;
                    self.close_street(next_committed, child_history)
                }
                Action::Bet { to, .. } => {
                    let mut next_committed = committed;
                    next_committed[p_idx] = to;
                    FlopChild::Node(self.build_decision(
                        player.opponent(),
                        next_committed,
                        to - actor_committed,
                        0,
                        false,
                        child_history,
                    ))
                }
                Action::Raise { to, raise_by, .. } => {
                    let mut next_committed = committed;
                    next_committed[p_idx] = to;
                    FlopChild::Node(self.build_decision(
                        player.opponent(),
                        next_committed,
                        raise_by,
                        raises_so_far + 1,
                        false,
                        child_history,
                    ))
                }
            };
            children.push(child);
        }

        if let FlopNode::Decision(ref mut d) = self.nodes[node_id] {
            d.children = children;
        }
        node_id
    }

    /// Closes the flop street with `committed` (always equal): creates one
    /// subtree per turn card and returns the group child.
    fn close_street(&mut self, committed: [f64; 2], history: String) -> FlopChild {
        let group_idx = self.subtree_groups.len();
        let base = self.subtrees.len();
        let remaining_stack = self.effective_stack - committed[0];
        let subtree_pot = self.starting_pot + committed[0] + committed[1];

        for (t_idx, &tc) in self.turn_cards.iter().enumerate() {
            let _ = t_idx;
            let (oop_filtered, oop_map) = filter_range_for_turn_card(&self.combos[0], tc);
            let (ip_filtered, ip_map) = filter_range_for_turn_card(&self.combos[1], tc);
            let game = if oop_filtered.is_empty() || ip_filtered.is_empty() {
                None
            } else {
                let oop_range = range_from_combos(&oop_filtered);
                let ip_range = range_from_combos(&ip_filtered);
                match (oop_range, ip_range) {
                    (Ok(oop_r), Ok(ip_r)) => TurnGame::new(TurnSpot {
                        board: [self.board[0], self.board[1], self.board[2], tc],
                        oop_range: oop_r,
                        ip_range: ip_r,
                        starting_pot: subtree_pot,
                        effective_stack: remaining_stack,
                        turn_config: self.turn_config.clone(),
                        river_config: self.river_config.clone(),
                    })
                    .ok(),
                    _ => None,
                }
            };
            let (oop_map, ip_map) = if game.is_some() {
                (oop_map, ip_map)
            } else {
                (vec![None; self.combos[0].len()], vec![None; self.combos[1].len()])
            };
            self.subtrees.push(FlopSubtree {
                turn_card: tc,
                flop_history: history.clone(),
                committed: committed[0],
                game,
                oop_map,
                ip_map,
            });
        }

        self.subtree_groups.push(FlopSubtreeGroup {
            flop_history: history,
            committed,
            subtrees: (base..self.subtrees.len()).collect(),
        });
        FlopChild::Subtrees(group_idx)
    }
}

/// Filters `combos` to those not containing `turn_card`, returning the kept
/// combos and the index map (old index -> new index).
fn filter_range_for_turn_card(
    combos: &[WeightedCombo],
    turn_card: Card,
) -> (Vec<WeightedCombo>, Vec<Option<usize>>) {
    let mut kept = Vec::with_capacity(combos.len());
    let mut map = Vec::with_capacity(combos.len());
    for c in combos {
        if c.mask.contains(turn_card) {
            map.push(None);
        } else {
            map.push(Some(kept.len()));
            kept.push(*c);
        }
    }
    (kept, map)
}

fn range_from_combos(combos: &[WeightedCombo]) -> Result<PloRange, plo_eval::EquityError> {
    let items: Vec<([Card; 4], f64)> = combos.iter().map(|c| (c.cards, c.weight)).collect();
    PloRange::from_weighted_hands(&items)
}

/// Expands bucket-level flop strategies to combo level: every combo inherits
/// its bucket's action frequencies. Used by the exploitability checker, which
/// must evaluate the bucketed profile inside the unabstracted game.
pub fn expand_bucket_strategies(
    game: &FlopGame,
    bucket_strategies: &[NodeStrategy],
) -> Vec<NodeStrategy> {
    bucket_strategies
        .iter()
        .map(|bs| {
            let p_idx = bs.player.index();
            let num_combos = game.combos[p_idx].len();
            let num_actions = bs.actions.len();
            let bucket_of = &game.assignments[p_idx].bucket_of;
            let mut frequencies = vec![0.0f64; num_combos * num_actions];
            for i in 0..num_combos {
                let b = bucket_of[i] as usize;
                for a in 0..num_actions {
                    frequencies[i * num_actions + a] = bs.freq(b, a);
                }
            }
            NodeStrategy {
                decision_id: bs.decision_id,
                node_id: bs.node_id,
                player: bs.player,
                history: bs.history.clone(),
                actions: bs.actions.clone(),
                num_combos,
                frequencies,
            }
        })
        .collect()
}

/// Complete output of solving a flop spot.
#[derive(Clone, Debug)]
pub struct FlopSolveResult {
    /// Average strategy per flop decision node, at *bucket* level
    /// (`num_combos` = the acting player's bucket count). Use
    /// [`expand_bucket_strategies`] for the combo-level profile.
    pub flop_strategies: Vec<NodeStrategy>,
    /// Average strategies inside each subtree, aligned with
    /// `FlopGame::subtrees` (empty for dead subtrees).
    pub subtree_strategies: Vec<Vec<NodeStrategy>>,
    /// Per-combo expected values for OOP at the start of the flop (from the
    /// checker's strategy evaluation).
    pub oop_evs: Vec<ComboEv>,
    /// Per-combo expected values for IP at the start of the flop.
    pub ip_evs: Vec<ComboEv>,
    /// Overall expected value in chips for OOP at the start of the flop.
    pub oop_game_ev: f64,
    /// Overall expected value in chips for IP at the start of the flop.
    pub ip_game_ev: f64,
    /// Total number of DCFR iterations executed.
    pub iterations: usize,
    /// Exact exploitability of the (bucketed) profile measured in the
    /// unabstracted game by the independent checker.
    pub exploitability: ExploitabilityReport,
}

/// CSR table of unblocked opponent combo indices for flop fold evaluation.
struct FlopFoldKernel {
    offsets: Vec<[u32; 2]>,
    opp_indices: Vec<u32>,
}

impl FlopFoldKernel {
    fn build(game: &FlopGame, player: Player) -> Self {
        let p_idx = player.index();
        let q_idx = player.opponent().index();
        let my = &game.combos[p_idx];
        let opp = &game.combos[q_idx];
        let mut offsets = Vec::with_capacity(my.len());
        let mut opp_indices = Vec::with_capacity(my.len() * opp.len());
        for mc in my {
            let s0 = opp_indices.len() as u32;
            for (j, oc) in opp.iter().enumerate() {
                if !mc.mask.overlaps(oc.mask) {
                    opp_indices.push(j as u32);
                }
            }
            let s1 = opp_indices.len() as u32;
            offsets.push([s0, s1]);
        }
        Self {
            offsets,
            opp_indices,
        }
    }

    #[inline]
    fn eval_fold(&self, opp_reach: &[f64], payoff: f64, out: &mut [f64]) {
        if payoff == 0.0 {
            out.fill(0.0);
            return;
        }
        for (i, &[s0, s1]) in self.offsets.iter().enumerate() {
            let mut sum = 0.0f64;
            for &j in &self.opp_indices[s0 as usize..s1 as usize] {
                sum += unsafe { *opp_reach.get_unchecked(j as usize) };
            }
            out[i] = sum * payoff;
        }
    }
}

/// Per-flop-decision-node DCFR buffers, indexed by bucket instead of combo.
struct FlopNodeBuffer {
    player: Player,
    num_actions: usize,
    num_buckets: usize,
    regrets: Vec<f64>,
    cum_strategy: Vec<f64>,
    current_strategy: Vec<f64>,
}

impl FlopNodeBuffer {
    fn new(player: Player, num_actions: usize, num_buckets: usize) -> Self {
        let len = num_actions * num_buckets;
        let uniform = if num_actions > 0 {
            1.0 / num_actions as f64
        } else {
            0.0
        };
        Self {
            player,
            num_actions,
            num_buckets,
            regrets: vec![0.0; len],
            cum_strategy: vec![0.0; len],
            current_strategy: vec![uniform; len],
        }
    }

    fn recompute_current_strategy(&mut self) {
        let num_actions = self.num_actions;
        let uniform = 1.0 / num_actions as f64;
        for b in 0..self.num_buckets {
            let base = b * num_actions;
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
                    strat_slice[a] = if reg_slice[a] > 0.0 {
                        reg_slice[a] * inv
                    } else {
                        0.0
                    };
                }
            } else {
                strat_slice.fill(uniform);
            }
        }
    }

    fn to_node_strategy(&self, game: &FlopGame, decision_id: usize) -> NodeStrategy {
        let d = game.decision_node(decision_id);
        let num_actions = self.num_actions;
        let uniform = 1.0 / num_actions as f64;
        let mut frequencies = vec![0.0f64; num_actions * self.num_buckets];
        for b in 0..self.num_buckets {
            let base = b * num_actions;
            let cum_slice = &self.cum_strategy[base..base + num_actions];
            let out_slice = &mut frequencies[base..base + num_actions];
            let sum: f64 = cum_slice.iter().sum();
            if sum > 0.0 {
                let inv = 1.0 / sum;
                for a in 0..num_actions {
                    out_slice[a] = cum_slice[a] * inv;
                }
            } else {
                out_slice.fill(uniform);
            }
        }
        NodeStrategy {
            decision_id,
            node_id: d.node_id,
            player: d.player,
            history: d.history.clone(),
            actions: d.actions.clone(),
            num_combos: self.num_buckets,
            frequencies,
        }
    }
}

/// Solves a [`FlopGame`] with vectorised Discounted CFR: bucketed on the flop
/// street, exact in every turn/river subtree. Runs exactly
/// `config.max_iterations` iterations (early stopping is disabled — see the
/// module docs) and measures exploitability once at the end with the
/// independent checker in the unabstracted game.
pub fn solve_flop(game: &FlopGame, config: &DcfrConfig) -> FlopSolveResult {
    // One solver state per live subtree; kernels shared per turn card.
    let mut kernel_cache: HashMap<u8, Rc<TurnKernels>> = HashMap::new();
    let mut states: Vec<Option<TurnSolverState>> = game
        .subtrees
        .iter()
        .map(|sub| {
            sub.game.as_ref().map(|g| {
                let rc = kernel_cache
                    .entry(sub.turn_card.id())
                    .or_insert_with(|| Rc::new(TurnKernels::new(g)))
                    .clone();
                TurnSolverState::with_kernels(g, rc)
            })
        })
        .collect();

    let fold_kernels = [
        FlopFoldKernel::build(game, Player::Oop),
        FlopFoldKernel::build(game, Player::Ip),
    ];

    let mut buffers: Vec<FlopNodeBuffer> = (0..game.num_decision_nodes())
        .map(|did| {
            let d = game.decision_node(did);
            FlopNodeBuffer::new(d.player, d.actions.len(), game.num_buckets(d.player))
        })
        .collect();

    let init_reach: [Vec<f64>; 2] = [
        game.combos[0].iter().map(|c| c.weight).collect(),
        game.combos[1].iter().map(|c| c.weight).collect(),
    ];

    for iter in 1..=config.max_iterations {
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

        for traverser in [Player::Oop, Player::Ip] {
            for buf in &mut buffers {
                if buf.player == traverser {
                    buf.recompute_current_strategy();
                }
            }
            for state in states.iter_mut().flatten() {
                state.begin_update(traverser);
            }
            let mut solver = FlopTraversal {
                game,
                buffers: &mut buffers,
                states: &mut states,
                fold_kernels: &fold_kernels,
                pos_discount,
                neg_discount,
                strat_weight,
            };
            let t_idx = traverser.index();
            let q_idx = traverser.opponent().index();
            solver.traverse(
                0,
                traverser,
                &init_reach[t_idx].clone(),
                &init_reach[q_idx].clone(),
            );
        }
    }

    let flop_strategies: Vec<NodeStrategy> = (0..game.num_decision_nodes())
        .map(|did| buffers[did].to_node_strategy(game, did))
        .collect();
    let subtree_strategies: Vec<Vec<NodeStrategy>> = game
        .subtrees
        .iter()
        .zip(states.iter())
        .map(|(sub, state)| match (sub.game.as_ref(), state.as_ref()) {
            (Some(g), Some(s)) => s.average_strategies(g),
            _ => Vec::new(),
        })
        .collect();

    let exploitability = compute_exploitability_flop(game, &flop_strategies, &subtree_strategies);

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

    FlopSolveResult {
        flop_strategies,
        subtree_strategies,
        oop_evs,
        ip_evs,
        oop_game_ev: exploitability.oop_strategy_ev,
        ip_game_ev: exploitability.ip_strategy_ev,
        iterations: config.max_iterations,
        exploitability,
    }
}

/// Mutable solver context for one DCFR half-iteration traversal of the flop
/// tree (kept as a struct to avoid an argument explosion in the recursion).
struct FlopTraversal<'a> {
    game: &'a FlopGame,
    buffers: &'a mut Vec<FlopNodeBuffer>,
    states: &'a mut Vec<Option<TurnSolverState>>,
    fold_kernels: &'a [FlopFoldKernel; 2],
    pos_discount: f64,
    neg_discount: f64,
    strat_weight: f64,
}

impl<'a> FlopTraversal<'a> {
    /// Returns the traverser's counterfactual values per flop combo at
    /// `node_id` (summed against `opp_reach`, own reach excluded — the same
    /// convention as the E2/E3 traversals).
    fn traverse(
        &mut self,
        node_id: NodeId,
        traverser: Player,
        my_reach: &[f64],
        opp_reach: &[f64],
    ) -> Vec<f64> {
        let game = self.game;
        let p_idx = traverser.index();
        let q_idx = traverser.opponent().index();
        let num_my = game.combos[p_idx].len();
        let num_opp = game.combos[q_idx].len();

        match &game.nodes[node_id] {
            FlopNode::Terminal(term) => {
                let mut out = vec![0.0f64; num_my];
                match *term {
                    TerminalNode::Fold { folder, committed } => {
                        let payoff = if folder == traverser {
                            -committed[p_idx]
                        } else {
                            game.starting_pot + committed[q_idx]
                        };
                        self.fold_kernels[p_idx].eval_fold(opp_reach, payoff, &mut out);
                    }
                    TerminalNode::Showdown { .. } => {
                        unreachable!("flop showdowns occur only inside subtrees")
                    }
                }
                out
            }
            FlopNode::Decision(d) => {
                let decision_id = d.decision_id;
                let num_actions = d.actions.len();

                if d.player == traverser {
                    let cur_strat = self.buffers[decision_id].current_strategy.clone();
                    let bucket_of = &game.assignments[p_idx].bucket_of;
                    let num_buckets = self.buffers[decision_id].num_buckets;

                    // Accumulate average strategy at bucket level, weighted by
                    // the bucket's total reach mass.
                    {
                        let mut bucket_mass = vec![0.0f64; num_buckets];
                        for i in 0..num_my {
                            bucket_mass[bucket_of[i] as usize] += my_reach[i];
                        }
                        let cum = &mut self.buffers[decision_id].cum_strategy;
                        for b in 0..num_buckets {
                            let w = self.strat_weight * bucket_mass[b];
                            if w > 0.0 {
                                let base = b * num_actions;
                                for a in 0..num_actions {
                                    cum[base + a] += w * cur_strat[base + a];
                                }
                            }
                        }
                    }

                    let mut action_cfvs: Vec<Vec<f64>> = Vec::with_capacity(num_actions);
                    let mut node_cfv = vec![0.0f64; num_my];
                    for a in 0..num_actions {
                        let child_cfv = self.eval_child(
                            d.children[a],
                            traverser,
                            my_reach,
                            opp_reach,
                        );
                        for i in 0..num_my {
                            let s = cur_strat[bucket_of[i] as usize * num_actions + a];
                            node_cfv[i] += s * child_cfv[i];
                        }
                        action_cfvs.push(child_cfv);
                    }

                    // Bucket regret update: range-weight-summed per-combo
                    // counterfactual regrets, discounted as in E2/E3.
                    let regrets = &mut self.buffers[decision_id].regrets;
                    for b in 0..num_buckets {
                        let base = b * num_actions;
                        for a in 0..num_actions {
                            let mut inst = 0.0f64;
                            for &i in &game.assignments[p_idx].buckets[b] {
                                inst += game.combos[p_idx][i].weight
                                    * (action_cfvs[a][i] - node_cfv[i]);
                            }
                            let updated = regrets[base + a] + inst;
                            regrets[base + a] = if updated >= 0.0 {
                                updated * self.pos_discount
                            } else {
                                updated * self.neg_discount
                            };
                        }
                    }

                    node_cfv
                } else {
                    let opp_strat = self.buffers[decision_id].current_strategy.clone();
                    let opp_bucket_of = &game.assignments[q_idx].bucket_of;
                    let mut node_cfv = vec![0.0f64; num_my];
                    let mut next_opp_reach = vec![0.0f64; num_opp];

                    for a in 0..num_actions {
                        let mut any_opp = false;
                        for j in 0..num_opp {
                            let r = opp_reach[j]
                                * opp_strat[opp_bucket_of[j] as usize * num_actions + a];
                            next_opp_reach[j] = r;
                            if r > 0.0 {
                                any_opp = true;
                            }
                        }
                        if !any_opp {
                            continue;
                        }
                        let child_cfv =
                            self.eval_child(d.children[a], traverser, my_reach, &next_opp_reach);
                        for i in 0..num_my {
                            node_cfv[i] += child_cfv[i];
                        }
                    }

                    node_cfv
                }
            }
        }
    }

    /// Evaluates a decision node's child for the traverser: recurses into
    /// flop nodes, or runs one DCFR traversal in every turn-card subtree of a
    /// subtree group and averages with [`TURN_CARD_DEAL_PROB`].
    fn eval_child(
        &mut self,
        child: FlopChild,
        traverser: Player,
        my_reach: &[f64],
        opp_reach: &[f64],
    ) -> Vec<f64> {
        match child {
            FlopChild::Node(child_id) => self.traverse(child_id, traverser, my_reach, opp_reach),
            FlopChild::Subtrees(group_idx) => {
                let game = self.game;
                let num_my = game.combos[traverser.index()].len();
                let mut out = vec![0.0f64; num_my];
                let group_subs: Vec<usize> =
                    game.subtree_groups[group_idx].subtrees.clone();
                for sub_idx in group_subs {
                    let sub_cfv =
                        self.eval_subtree(sub_idx, traverser, my_reach, opp_reach);
                    for i in 0..num_my {
                        out[i] += TURN_CARD_DEAL_PROB * sub_cfv[i];
                    }
                }
                out
            }
        }
    }

    /// Runs the subtree's DCFR traversal for the traverser (updating the
    /// subtree's regrets/strategies) and maps the root counterfactual values
    /// back to flop combo indexing (0 for combos blocked by the turn card).
    fn eval_subtree(
        &mut self,
        sub_idx: usize,
        traverser: Player,
        my_reach: &[f64],
        opp_reach: &[f64],
    ) -> Vec<f64> {
        let game = self.game;
        let p_idx = traverser.index();
        let q_idx = traverser.opponent().index();
        let num_my = game.combos[p_idx].len();
        let sub = &game.subtrees[sub_idx];
        let mut out = vec![0.0f64; num_my];
        let (Some(sub_game), Some(state)) = (sub.game.as_ref(), self.states[sub_idx].as_mut())
        else {
            return out;
        };
        let my_map = sub.map_for(traverser);
        let opp_map = sub.map_for(traverser.opponent());
        let mut my_sub = vec![0.0f64; sub_game.combos[p_idx].len()];
        let mut opp_sub = vec![0.0f64; sub_game.combos[q_idx].len()];
        for (i, m) in my_map.iter().enumerate() {
            if let Some(si) = m {
                my_sub[*si] = my_reach[i];
            }
        }
        for (j, m) in opp_map.iter().enumerate() {
            if let Some(sj) = m {
                opp_sub[*sj] = opp_reach[j];
            }
        }
        let root_cfv = state.traverse_root(
            sub_game,
            traverser,
            &my_sub,
            &opp_sub,
            self.pos_discount,
            self.neg_discount,
            self.strat_weight,
        );
        // Seam correction: the subtree's counterfactual values are net of
        // turn/river contributions only — inside the TurnGame the subtree
        // pot (which already contains both players' flop commitments) is
        // dead money. The traverser's full-hand net value must additionally
        // charge the chips it committed on the flop to reach this subtree:
        // subtract `committed * (valid opponent reach mass for the combo)`,
        // where valid means the opponent combo shares no card with the
        // traverser's combo (card removal, matching the subtree kernels).
        let committed = sub.committed;
        if committed != 0.0 {
            let my_sub_combos = &sub_game.combos[p_idx];
            let opp_sub_combos = &sub_game.combos[q_idx];
            for (i, m) in my_map.iter().enumerate() {
                if let Some(si) = m {
                    let my_mask = my_sub_combos[*si].mask;
                    let mut mass = 0.0f64;
                    for (sj, oc) in opp_sub_combos.iter().enumerate() {
                        if opp_sub[sj] > 0.0 && !my_mask.overlaps(oc.mask) {
                            mass += opp_sub[sj];
                        }
                    }
                    out[i] = root_cfv[*si] - committed * mass;
                }
            }
        } else {
            for (i, m) in my_map.iter().enumerate() {
                if let Some(si) = m {
                    out[i] = root_cfv[*si];
                }
            }
        }
        out
    }
}
