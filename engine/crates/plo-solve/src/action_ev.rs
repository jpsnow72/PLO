//! Per-action EV evaluation pass (issue #8).
//!
//! After a solve converges, this pass prices every action of every combo at
//! every decision node under the final average strategy profile: for a combo
//! `i` of the player to act at node `n`, the action EV is the exact
//! conditional expected value (in chips, net of the whole hand — the same
//! convention as [`crate::cfr::ComboEv`], where folding at the root is worth
//! `0.0`) of taking that action at `n` and following the profile afterwards.
//!
//! The pass is a deterministic tree evaluation, not more CFR: it runs the
//! checker's strategy-evaluation traversal (`br.rs`, `maximize = false`)
//! once per player and records, at each of the traverser's own decision
//! nodes, the per-action counterfactual values before they are mixed by the
//! traverser's frequencies. It shares the checker's conventions exactly —
//! terminal payoffs, card removal, chance-node deal probabilities
//! ([`RIVER_DEAL_PROB`] / [`TURN_CARD_DEAL_PROB`] multiply values, never
//! reaches), and the flop-subtree seam correction — so the root identity
//!
//! ```text
//! sum_a freq(i, a) * action_ev(i, a) == stored whole-solve EV of combo i
//! ```
//!
//! holds to float precision at the root of every game (the stored EVs are
//! the checker's own strategy combo EVs), and the same identity holds
//! against `node_evs` at every non-root node. The validation suite
//! (`tests/action_ev_validation.rs`) anchors the root against the checker
//! and every node against an independent naive evaluator.
//!
//! Conditional values: the traversals carry counterfactual values (CFV)
//! linear in the opponent's reach. At a decision node, combo `i`'s
//! conditional action EV is `CFV(i, a) / Z(i)`, where `Z(i)` is the
//! opponent reach mass live at the node against combo `i` — opponent combos
//! that neither overlap `i` nor contain a card dealt on the path to the
//! node. Chance probabilities cancel between numerator and denominator
//! (they multiply every surviving combo's reach equally), so conditional
//! EVs at runout nodes are exact. When `Z(i) == 0` (the node is unreachable
//! against this combo under the profile, or the combo itself is blocked by
//! a dealt card) the conditional value is undefined; the pass records `0.0`
//! by convention, matching the checker's treatment of impossible pairs.
//!
//! Flop subtrees: values inside a subtree are first computed in the
//! subtree's own terms (its pot already contains both players' flop
//! commitments), then shifted by `- committed` — the per-player flop
//! commitment — so every recorded value is net of the whole hand, exactly
//! the checker's seam correction divided through by `Z(i)` (the correction
//! is `committed * Z(i)` in CFV terms). Nodelocked solves are priced as-is:
//! the pass reads only the final average strategies, which already carry
//! the locked frequencies at locked nodes.

use std::cmp::Ordering;

use plo_cards::HandMask;
use plo_eval::{eval_omaha, HandRank, WeightedCombo};

use crate::cfr::NodeStrategy;
use crate::flop::{expand_bucket_strategies, FlopChild, FlopGame, FlopNode, TURN_CARD_DEAL_PROB};
use crate::game::{Action, Node, NodeId, Player, RiverGame, TerminalNode};
use crate::turn::{TurnGame, TurnNode, RIVER_DEAL_PROB};

/// Per-action conditional EVs at one decision node, for every combo of the
/// player to act. Aligned with the node's [`NodeStrategy`]: same
/// `decision_id`, same actions, same combo order.
#[derive(Clone, Debug, PartialEq)]
pub struct NodeActionEvs {
    /// Sequential decision node index within the owning game (for flop
    /// subtree nodes: within the subtree's own `TurnGame`).
    pub decision_id: usize,
    /// Node index in the owning game's node list.
    pub node_id: NodeId,
    /// Acting player at this decision node.
    pub player: Player,
    /// Action history string reaching this node (the owning game's local
    /// history; the flop formatter joins subtree histories exactly as it
    /// does for strategies).
    pub history: String,
    /// Legal actions at this decision node (aligned with the strategy's).
    pub actions: Vec<Action>,
    /// Number of combos for `player` in the owning game.
    pub num_combos: usize,
    /// Per-action conditional EVs in chips, combo-major:
    /// `evs[combo_idx * actions.len() + action_idx]`.
    pub evs: Vec<f64>,
    /// Per-combo value of the node itself under the profile (chips):
    /// `node_evs[i] = sum_a freq(i, a) * evs(i, a)`. At a game root this
    /// equals the stored whole-solve EV of the combo.
    pub node_evs: Vec<f64>,
}

impl NodeActionEvs {
    /// Returns the conditional EV (chips) of `action_idx` for `combo_idx`.
    #[inline]
    pub fn action_ev(&self, combo_idx: usize, action_idx: usize) -> f64 {
        self.evs[combo_idx * self.actions.len() + action_idx]
    }

    /// Returns the per-action conditional EVs (length `actions.len()`) for
    /// `combo_idx`, aligned with the node's strategy row.
    #[inline]
    pub fn combo_action_evs(&self, combo_idx: usize) -> &[f64] {
        let num_actions = self.actions.len();
        let start = combo_idx * num_actions;
        &self.evs[start..start + num_actions]
    }
}

/// Per-action EVs for a whole flop solve, mirroring the strategy layout of
/// [`crate::flop::FlopSolveResult`].
#[derive(Clone, Debug, PartialEq)]
pub struct FlopActionEvs {
    /// Flop-street nodes at combo level, aligned with
    /// [`expand_bucket_strategies`]' output (and with the formatter's
    /// expanded flop strategies).
    pub flop: Vec<NodeActionEvs>,
    /// Nodes inside each turn-card subtree, aligned with
    /// `FlopGame::subtrees` and `FlopSolveResult::subtree_strategies`
    /// (empty for dead subtrees). Combo indices are the subtree game's.
    pub subtrees: Vec<Vec<NodeActionEvs>>,
}

/// Opponent reach mass live against `my_mask` at a node: the sum of
/// `opp_reach[j]` over opponent combos that do not overlap `my_mask` and do
/// not contain `dead` (a card dealt on the path to the node, if any). This
/// is the normaliser that turns counterfactual values into conditional EVs.
fn reach_mass(
    my_mask: HandMask,
    opp_combos: &[WeightedCombo],
    opp_reach: &[f64],
    dead: Option<plo_cards::Card>,
) -> f64 {
    let mut sum = 0.0f64;
    for (j, oc) in opp_combos.iter().enumerate() {
        if opp_reach[j] == 0.0 || my_mask.overlaps(oc.mask) {
            continue;
        }
        if let Some(card) = dead {
            if oc.mask.contains(card) {
                continue;
            }
        }
        sum += opp_reach[j];
    }
    sum
}

/// Builds a record for one decision node from its per-action CFVs and the
/// per-combo normalisers, applying the constant `offset` shift (the flop
/// seam correction; `0.0` outside flop subtrees).
fn build_record(
    ns: &NodeStrategy,
    my_combos: &[WeightedCombo],
    opp_combos: &[WeightedCombo],
    opp_reach: &[f64],
    dead: Option<plo_cards::Card>,
    action_cfvs: &[Vec<f64>],
    offset: f64,
) -> NodeActionEvs {
    let num_actions = ns.actions.len();
    let num_combos = ns.num_combos;
    let mut evs = vec![0.0f64; num_combos * num_actions];
    let mut node_evs = vec![0.0f64; num_combos];
    for i in 0..num_combos {
        let z = reach_mass(my_combos[i].mask, opp_combos, opp_reach, dead);
        if z <= 0.0 {
            continue; // undefined conditional value: 0.0 by convention
        }
        let mut node_cfv = 0.0f64;
        for a in 0..num_actions {
            let ev = action_cfvs[a][i] / z - offset;
            evs[i * num_actions + a] = ev;
            node_cfv += ns.freq(i, a) * action_cfvs[a][i];
        }
        node_evs[i] = node_cfv / z - offset;
    }
    NodeActionEvs {
        decision_id: ns.decision_id,
        node_id: ns.node_id,
        player: ns.player,
        history: ns.history.clone(),
        actions: ns.actions.clone(),
        num_combos,
        evs,
        node_evs,
    }
}

/// Finalises a recorder (one slot per decision node, filled by the owning
/// player's traversal). Every decision node is visited by exactly one
/// traversal; a slot left empty (impossible unless the traversals change)
/// is filled with a zero record shaped like the node's strategy rather
/// than panicking inside a solve.
fn finalise_records(
    rec: Vec<Option<NodeActionEvs>>,
    strategies: &[NodeStrategy],
) -> Vec<NodeActionEvs> {
    rec.into_iter()
        .enumerate()
        .map(|(idx, slot)| {
            slot.unwrap_or_else(|| {
                let ns = &strategies[idx];
                NodeActionEvs {
                    decision_id: ns.decision_id,
                    node_id: ns.node_id,
                    player: ns.player,
                    history: ns.history.clone(),
                    actions: ns.actions.clone(),
                    num_combos: ns.num_combos,
                    evs: vec![0.0; ns.num_combos * ns.actions.len()],
                    node_evs: vec![0.0; ns.num_combos],
                }
            })
        })
        .collect()
}

// ============================================================================
// River game.
// ============================================================================

/// Computes per-action EVs for every decision node of a solved river game
/// under the final average `strategies`.
pub fn compute_action_evs_river(
    game: &RiverGame,
    strategies: &[NodeStrategy],
) -> Vec<NodeActionEvs> {
    let ranks: [Vec<HandRank>; 2] = [
        game.combos[0]
            .iter()
            .map(|c| eval_omaha(c.cards, game.board))
            .collect(),
        game.combos[1]
            .iter()
            .map(|c| eval_omaha(c.cards, game.board))
            .collect(),
    ];

    let mut rec: Vec<Option<NodeActionEvs>> =
        (0..strategies.len()).map(|_| None).collect();
    for traverser in [Player::Oop, Player::Ip] {
        let init_opp_reach: Vec<f64> = game.combos[traverser.opponent().index()]
            .iter()
            .map(|c| c.weight)
            .collect();
        eval_river_node(
            game,
            strategies,
            &ranks,
            0,
            traverser,
            &init_opp_reach,
            &mut rec,
        );
    }
    finalise_records(rec, strategies)
}

/// Strategy-evaluation traversal mirroring `br::br_traverse_node` with
/// `maximize_traverser = false`, additionally recording per-action values
/// at the traverser's own decision nodes. Returns the traverser's CFVs.
/// Unlike the checker, opponent-action children are never skipped: every
/// decision node must be visited so it can be recorded (zero-reach
/// children simply contribute zero CFVs).
#[allow(clippy::too_many_arguments)]
fn eval_river_node(
    game: &RiverGame,
    strategies: &[NodeStrategy],
    ranks: &[Vec<HandRank>; 2],
    node_id: NodeId,
    traverser: Player,
    opp_reach: &[f64],
    rec: &mut [Option<NodeActionEvs>],
) -> Vec<f64> {
    let p_idx = traverser.index();
    let q_idx = traverser.opponent().index();
    let my_combos = &game.combos[p_idx];
    let opp_combos = &game.combos[q_idx];
    let my_ranks = &ranks[p_idx];
    let opp_ranks = &ranks[q_idx];
    let num_my = my_combos.len();
    let num_opp = opp_combos.len();

    match &game.nodes[node_id] {
        Node::Terminal(term) => {
            let mut out = vec![0.0f64; num_my];
            match *term {
                TerminalNode::Fold { folder, committed } => {
                    let payoff = if folder == traverser {
                        -committed[p_idx]
                    } else {
                        game.starting_pot + committed[q_idx]
                    };
                    if payoff == 0.0 {
                        return out;
                    }
                    for (i, mc) in my_combos.iter().enumerate() {
                        let mut sum_reach = 0.0f64;
                        for (j, oc) in opp_combos.iter().enumerate() {
                            if !mc.mask.overlaps(oc.mask) {
                                sum_reach += opp_reach[j];
                            }
                        }
                        out[i] = sum_reach * payoff;
                    }
                }
                TerminalNode::Showdown { committed } => {
                    let win_payoff = game.starting_pot + committed[q_idx];
                    let tie_payoff = 0.5 * game.starting_pot;
                    let loss_payoff = -committed[p_idx];
                    for (i, mc) in my_combos.iter().enumerate() {
                        let r_my = my_ranks[i];
                        let mut ev_sum = 0.0f64;
                        for (j, oc) in opp_combos.iter().enumerate() {
                            let r_opp_reach = opp_reach[j];
                            if r_opp_reach == 0.0 || mc.mask.overlaps(oc.mask) {
                                continue;
                            }
                            let u = match r_my.cmp(&opp_ranks[j]) {
                                Ordering::Greater => win_payoff,
                                Ordering::Equal => tie_payoff,
                                Ordering::Less => loss_payoff,
                            };
                            ev_sum += r_opp_reach * u;
                        }
                        out[i] = ev_sum;
                    }
                }
            }
            out
        }
        Node::Decision(d) => {
            let node_strat = &strategies[d.decision_id];
            if d.player == traverser {
                let mut action_cfvs: Vec<Vec<f64>> = Vec::with_capacity(d.children.len());
                let mut weighted = vec![0.0f64; num_my];
                for (a_idx, &child_id) in d.children.iter().enumerate() {
                    let child_cfv = eval_river_node(
                        game,
                        strategies,
                        ranks,
                        child_id,
                        traverser,
                        opp_reach,
                        rec,
                    );
                    for i in 0..num_my {
                        weighted[i] += node_strat.freq(i, a_idx) * child_cfv[i];
                    }
                    action_cfvs.push(child_cfv);
                }
                rec[d.decision_id] = Some(build_record(
                    node_strat,
                    my_combos,
                    opp_combos,
                    opp_reach,
                    None,
                    &action_cfvs,
                    0.0,
                ));
                weighted
            } else {
                let mut total = vec![0.0f64; num_my];
                let mut next_opp_reach = vec![0.0f64; num_opp];
                for a_idx in 0..d.actions.len() {
                    let child_id = d.children[a_idx];
                    for j in 0..num_opp {
                        next_opp_reach[j] = opp_reach[j] * node_strat.freq(j, a_idx);
                    }
                    let child_cfv = eval_river_node(
                        game,
                        strategies,
                        ranks,
                        child_id,
                        traverser,
                        &next_opp_reach,
                        rec,
                    );
                    for i in 0..num_my {
                        total[i] += child_cfv[i];
                    }
                }
                total
            }
        }
    }
}

// ============================================================================
// Turn game (also used for flop subtrees, with `offset = committed`).
// ============================================================================

/// Independently evaluates Omaha hand ranks for every runout of a
/// [`TurnGame`] via E1's `eval_omaha` (the checker's `compute_turn_ranks`
/// convention: combos containing the river card get a dummy rank and are
/// filtered explicitly by the traversals).
fn compute_turn_ranks(game: &TurnGame) -> Vec<[Vec<HandRank>; 2]> {
    let oop_combos = &game.combos[Player::Oop.index()];
    let ip_combos = &game.combos[Player::Ip.index()];
    let mut ranks: Vec<[Vec<HandRank>; 2]> = Vec::with_capacity(game.river_cards.len());
    for &rc in &game.river_cards {
        let board5 = [game.board[0], game.board[1], game.board[2], game.board[3], rc];
        let oop_ranks: Vec<HandRank> = oop_combos
            .iter()
            .map(|c| {
                if c.mask.contains(rc) {
                    HandRank(0)
                } else {
                    eval_omaha(c.cards, board5)
                }
            })
            .collect();
        let ip_ranks: Vec<HandRank> = ip_combos
            .iter()
            .map(|c| {
                if c.mask.contains(rc) {
                    HandRank(0)
                } else {
                    eval_omaha(c.cards, board5)
                }
            })
            .collect();
        ranks.push([oop_ranks, ip_ranks]);
    }
    ranks
}

/// Computes per-action EVs for every decision node of a solved turn game
/// under the final average `strategies`.
pub fn compute_action_evs_turn(
    game: &TurnGame,
    strategies: &[NodeStrategy],
) -> Vec<NodeActionEvs> {
    let ranks = compute_turn_ranks(game);
    let mut rec: Vec<Option<NodeActionEvs>> =
        (0..strategies.len()).map(|_| None).collect();
    compute_action_evs_turn_into(game, strategies, &ranks, 0.0, &mut rec);
    finalise_records(rec, strategies)
}

/// Runs both traverser traversals of a turn game into a caller-provided
/// recorder, shifting recorded values by `-offset` (the flop seam
/// correction when this game is a flop subtree; `0.0` standalone).
fn compute_action_evs_turn_into(
    game: &TurnGame,
    strategies: &[NodeStrategy],
    ranks: &[[Vec<HandRank>; 2]],
    offset: f64,
    rec: &mut [Option<NodeActionEvs>],
) {
    for traverser in [Player::Oop, Player::Ip] {
        let init_opp_reach: Vec<f64> = game.combos[traverser.opponent().index()]
            .iter()
            .map(|c| c.weight)
            .collect();
        eval_turn_node(
            game,
            strategies,
            ranks,
            0,
            traverser,
            None,
            &init_opp_reach,
            offset,
            rec,
        );
    }
}

/// Strategy-evaluation traversal mirroring `br::br_traverse_turn_node`
/// with `maximize_traverser = false`, additionally recording per-action
/// values at the traverser's own decision nodes (shifted by `-offset`).
/// Returns the traverser's CFVs in the game's own (unshifted) terms.
#[allow(clippy::too_many_arguments)]
fn eval_turn_node(
    game: &TurnGame,
    strategies: &[NodeStrategy],
    ranks: &[[Vec<HandRank>; 2]],
    node_id: NodeId,
    traverser: Player,
    runout: Option<usize>,
    opp_reach: &[f64],
    offset: f64,
    rec: &mut [Option<NodeActionEvs>],
) -> Vec<f64> {
    let p_idx = traverser.index();
    let q_idx = traverser.opponent().index();
    let my_combos = &game.combos[p_idx];
    let opp_combos = &game.combos[q_idx];
    let num_my = my_combos.len();
    let num_opp = opp_combos.len();

    match &game.nodes[node_id] {
        TurnNode::Terminal(term) => {
            let mut out = vec![0.0f64; num_my];
            // On a runout, pairs involving a combo that contains the river
            // card are impossible and contribute exactly 0.
            let river_card = runout.map(|r| game.river_cards[r]);
            match *term {
                TerminalNode::Fold { folder, committed } => {
                    let payoff = if folder == traverser {
                        -committed[p_idx]
                    } else {
                        game.starting_pot + committed[q_idx]
                    };
                    if payoff == 0.0 {
                        return out;
                    }
                    for (i, mc) in my_combos.iter().enumerate() {
                        if river_card.map(|rc| mc.mask.contains(rc)).unwrap_or(false) {
                            continue;
                        }
                        let mut sum_reach = 0.0f64;
                        for (j, oc) in opp_combos.iter().enumerate() {
                            if river_card.map(|rc| oc.mask.contains(rc)).unwrap_or(false) {
                                continue;
                            }
                            if !mc.mask.overlaps(oc.mask) {
                                sum_reach += opp_reach[j];
                            }
                        }
                        out[i] = sum_reach * payoff;
                    }
                }
                TerminalNode::Showdown { committed } => {
                    let r = runout.expect("showdown terminals only occur under a chance node");
                    let rc = game.river_cards[r];
                    let my_ranks = &ranks[r][p_idx];
                    let opp_ranks = &ranks[r][q_idx];
                    let win_payoff = game.starting_pot + committed[q_idx];
                    let tie_payoff = 0.5 * game.starting_pot;
                    let loss_payoff = -committed[p_idx];
                    for (i, mc) in my_combos.iter().enumerate() {
                        if mc.mask.contains(rc) {
                            continue;
                        }
                        let r_my = my_ranks[i];
                        let mut ev_sum = 0.0f64;
                        for (j, oc) in opp_combos.iter().enumerate() {
                            let r_opp_reach = opp_reach[j];
                            if r_opp_reach == 0.0
                                || oc.mask.contains(rc)
                                || mc.mask.overlaps(oc.mask)
                            {
                                continue;
                            }
                            let u = match r_my.cmp(&opp_ranks[j]) {
                                Ordering::Greater => win_payoff,
                                Ordering::Equal => tie_payoff,
                                Ordering::Less => loss_payoff,
                            };
                            ev_sum += r_opp_reach * u;
                        }
                        out[i] = ev_sum;
                    }
                }
            }
            out
        }
        TurnNode::Chance(chance) => {
            let mut total = vec![0.0f64; num_my];
            for (r, &child_id) in chance.children.iter().enumerate() {
                let child_cfv = eval_turn_node(
                    game,
                    strategies,
                    ranks,
                    child_id,
                    traverser,
                    Some(r),
                    opp_reach,
                    offset,
                    rec,
                );
                for i in 0..num_my {
                    total[i] += RIVER_DEAL_PROB * child_cfv[i];
                }
            }
            total
        }
        TurnNode::Decision(d) => {
            let node_strat = &strategies[d.decision_id];
            let dead = runout.map(|r| game.river_cards[r]);
            if d.player == traverser {
                let mut action_cfvs: Vec<Vec<f64>> = Vec::with_capacity(d.children.len());
                let mut weighted = vec![0.0f64; num_my];
                for (a_idx, &child_id) in d.children.iter().enumerate() {
                    let child_cfv = eval_turn_node(
                        game,
                        strategies,
                        ranks,
                        child_id,
                        traverser,
                        runout,
                        opp_reach,
                        offset,
                        rec,
                    );
                    for i in 0..num_my {
                        weighted[i] += node_strat.freq(i, a_idx) * child_cfv[i];
                    }
                    action_cfvs.push(child_cfv);
                }
                rec[d.decision_id] = Some(build_record(
                    node_strat,
                    my_combos,
                    opp_combos,
                    opp_reach,
                    dead,
                    &action_cfvs,
                    offset,
                ));
                weighted
            } else {
                let mut total = vec![0.0f64; num_my];
                let mut next_opp_reach = vec![0.0f64; num_opp];
                for a_idx in 0..d.actions.len() {
                    let child_id = d.children[a_idx];
                    for j in 0..num_opp {
                        next_opp_reach[j] = opp_reach[j] * node_strat.freq(j, a_idx);
                    }
                    let child_cfv = eval_turn_node(
                        game,
                        strategies,
                        ranks,
                        child_id,
                        traverser,
                        runout,
                        &next_opp_reach,
                        offset,
                        rec,
                    );
                    for i in 0..num_my {
                        total[i] += child_cfv[i];
                    }
                }
                total
            }
        }
    }
}

// ============================================================================
// Flop game: flop-street traversal over the expanded (combo-level) profile,
// delegating closed streets to the turn traversal inside each subtree.
// ============================================================================

/// Computes per-action EVs for every decision node of a solved flop game —
/// flop street plus every turn-card subtree — under the final average
/// strategies (`flop_strategies` at bucket level, as stored in
/// [`crate::flop::FlopSolveResult`]; they are expanded to combo level
/// exactly as the checker expands them).
pub fn compute_action_evs_flop(
    game: &FlopGame,
    flop_strategies: &[NodeStrategy],
    subtree_strategies: &[Vec<NodeStrategy>],
) -> FlopActionEvs {
    let expanded = expand_bucket_strategies(game, flop_strategies);

    // Hand ranks for every subtree runout, computed once (checker style).
    let subtree_ranks: Vec<Option<Vec<[Vec<HandRank>; 2]>>> = game
        .subtrees
        .iter()
        .map(|s| s.game.as_ref().map(|g| compute_turn_ranks(g)))
        .collect();

    let mut flop_rec: Vec<Option<NodeActionEvs>> =
        (0..expanded.len()).map(|_| None).collect();
    let mut sub_recs: Vec<Vec<Option<NodeActionEvs>>> = game
        .subtrees
        .iter()
        .zip(subtree_strategies.iter())
        .map(|(sub, strategies)| match sub.game {
            Some(_) => (0..strategies.len()).map(|_| None).collect(),
            None => Vec::new(),
        })
        .collect();

    for traverser in [Player::Oop, Player::Ip] {
        let init_opp_reach: Vec<f64> = game.combos[traverser.opponent().index()]
            .iter()
            .map(|c| c.weight)
            .collect();
        eval_flop_node(
            game,
            &expanded,
            subtree_strategies,
            &subtree_ranks,
            0,
            traverser,
            &init_opp_reach,
            &mut flop_rec,
            &mut sub_recs,
        );
    }

    FlopActionEvs {
        flop: finalise_records(flop_rec, &expanded),
        subtrees: sub_recs
            .into_iter()
            .zip(subtree_strategies.iter())
            .map(|(rec, strategies)| finalise_records(rec, strategies))
            .collect(),
    }
}

/// Strategy-evaluation traversal mirroring `br::br_traverse_flop_node`
/// with `maximize_traverser = false` over the expanded profile,
/// additionally recording per-action values at the traverser's own flop
/// decision nodes (and, via [`eval_flop_subtree`], inside subtrees).
/// Returns the traverser's CFVs in flop combo indexing.
#[allow(clippy::too_many_arguments)]
fn eval_flop_node(
    game: &FlopGame,
    expanded_strategies: &[NodeStrategy],
    subtree_strategies: &[Vec<NodeStrategy>],
    subtree_ranks: &[Option<Vec<[Vec<HandRank>; 2]>>],
    node_id: NodeId,
    traverser: Player,
    opp_reach: &[f64],
    flop_rec: &mut [Option<NodeActionEvs>],
    sub_recs: &mut [Vec<Option<NodeActionEvs>>],
) -> Vec<f64> {
    let p_idx = traverser.index();
    let q_idx = traverser.opponent().index();
    let my_combos = &game.combos[p_idx];
    let opp_combos = &game.combos[q_idx];
    let num_my = my_combos.len();
    let num_opp = opp_combos.len();

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
                    if payoff == 0.0 {
                        return out;
                    }
                    for (i, mc) in my_combos.iter().enumerate() {
                        let mut sum_reach = 0.0f64;
                        for (j, oc) in opp_combos.iter().enumerate() {
                            if !mc.mask.overlaps(oc.mask) {
                                sum_reach += opp_reach[j];
                            }
                        }
                        out[i] = sum_reach * payoff;
                    }
                }
                TerminalNode::Showdown { .. } => {
                    unreachable!("flop showdowns occur only inside subtrees")
                }
            }
            out
        }
        FlopNode::Decision(d) => {
            let node_strat = &expanded_strategies[d.decision_id];
            if d.player == traverser {
                let mut action_cfvs: Vec<Vec<f64>> = Vec::with_capacity(d.children.len());
                let mut weighted = vec![0.0f64; num_my];
                for (a_idx, &child) in d.children.iter().enumerate() {
                    let child_cfv = eval_flop_child(
                        game,
                        expanded_strategies,
                        subtree_strategies,
                        subtree_ranks,
                        child,
                        traverser,
                        opp_reach,
                        flop_rec,
                        sub_recs,
                    );
                    for i in 0..num_my {
                        weighted[i] += node_strat.freq(i, a_idx) * child_cfv[i];
                    }
                    action_cfvs.push(child_cfv);
                }
                flop_rec[d.decision_id] = Some(build_record(
                    node_strat,
                    my_combos,
                    opp_combos,
                    opp_reach,
                    None,
                    &action_cfvs,
                    0.0,
                ));
                weighted
            } else {
                let mut total = vec![0.0f64; num_my];
                let mut next_opp_reach = vec![0.0f64; num_opp];
                for a_idx in 0..d.actions.len() {
                    let child = d.children[a_idx];
                    for j in 0..num_opp {
                        next_opp_reach[j] = opp_reach[j] * node_strat.freq(j, a_idx);
                    }
                    let child_cfv = eval_flop_child(
                        game,
                        expanded_strategies,
                        subtree_strategies,
                        subtree_ranks,
                        child,
                        traverser,
                        &next_opp_reach,
                        flop_rec,
                        sub_recs,
                    );
                    for i in 0..num_my {
                        total[i] += child_cfv[i];
                    }
                }
                total
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn eval_flop_child(
    game: &FlopGame,
    expanded_strategies: &[NodeStrategy],
    subtree_strategies: &[Vec<NodeStrategy>],
    subtree_ranks: &[Option<Vec<[Vec<HandRank>; 2]>>],
    child: FlopChild,
    traverser: Player,
    opp_reach: &[f64],
    flop_rec: &mut [Option<NodeActionEvs>],
    sub_recs: &mut [Vec<Option<NodeActionEvs>>],
) -> Vec<f64> {
    match child {
        FlopChild::Node(child_id) => eval_flop_node(
            game,
            expanded_strategies,
            subtree_strategies,
            subtree_ranks,
            child_id,
            traverser,
            opp_reach,
            flop_rec,
            sub_recs,
        ),
        FlopChild::Subtrees(group_idx) => {
            let num_my = game.combos[traverser.index()].len();
            let mut out = vec![0.0f64; num_my];
            for &sub_idx in &game.subtree_groups[group_idx].subtrees {
                let sub_cfv = eval_flop_subtree(
                    game,
                    subtree_strategies,
                    subtree_ranks,
                    sub_idx,
                    traverser,
                    opp_reach,
                    &mut sub_recs[sub_idx],
                );
                for i in 0..num_my {
                    out[i] += TURN_CARD_DEAL_PROB * sub_cfv[i];
                }
            }
            out
        }
    }
}

/// Evaluates one turn-card subtree for the pass: maps the opponent reach
/// into the subtree, runs the turn recording traversal there (records
/// shifted by the seam offset), and maps the traverser's values back to
/// flop combo indexing with the checker's seam correction applied to the
/// returned CFVs (the traverser's flop commitment is charged against the
/// valid opponent reach mass, exactly as in `br::br_eval_flop_subtree`).
#[allow(clippy::too_many_arguments)]
fn eval_flop_subtree(
    game: &FlopGame,
    subtree_strategies: &[Vec<NodeStrategy>],
    subtree_ranks: &[Option<Vec<[Vec<HandRank>; 2]>>],
    sub_idx: usize,
    traverser: Player,
    opp_reach: &[f64],
    sub_rec: &mut [Option<NodeActionEvs>],
) -> Vec<f64> {
    let p_idx = traverser.index();
    let q_idx = traverser.opponent().index();
    let num_my = game.combos[p_idx].len();
    let mut out = vec![0.0f64; num_my];
    let sub = &game.subtrees[sub_idx];
    let (Some(sub_game), Some(ranks)) = (sub.game.as_ref(), subtree_ranks[sub_idx].as_ref())
    else {
        return out;
    };
    let opp_map = sub.map_for(traverser.opponent());
    let mut opp_sub = vec![0.0f64; sub_game.combos[q_idx].len()];
    for (j, m) in opp_map.iter().enumerate() {
        if let Some(sj) = m {
            opp_sub[*sj] = opp_reach[j];
        }
    }
    // Record this traverser's nodes inside the subtree (the other
    // traverser's traversal records its own), with values shifted to
    // whole-hand terms by the seam offset.
    let cfv_sub = eval_turn_node(
        sub_game,
        &subtree_strategies[sub_idx],
        ranks,
        0,
        traverser,
        None,
        &opp_sub,
        sub.committed,
        sub_rec,
    );
    // Seam correction (must mirror the checker exactly): the turn
    // traversal's values are net of turn/river contributions only — the
    // subtree pot, which already contains both players' flop commitments,
    // is dead money inside the subtree. The traverser's full-hand net
    // value must also charge the chips it committed on the flop to reach
    // this subtree: subtract `committed * (valid opponent reach mass for
    // the combo)`, valid meaning the opponent combo shares no card with
    // the traverser's.
    let committed = sub.committed;
    let my_map = sub.map_for(traverser);
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
                out[i] = cfv_sub[*si] - committed * mass;
            }
        }
    } else {
        for (i, m) in my_map.iter().enumerate() {
            if let Some(si) = m {
                out[i] = cfv_sub[*si];
            }
        }
    }
    out
}
