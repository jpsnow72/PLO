//! Independent Best-Response Exploitability Checker (`br.rs`).
//!
//! Computes exact best-response exploitability (Nash Distance, in `%` of starting pot) of a
//! strategy profile by an independent recursive tree traversal that shares ONLY the E1 Omaha
//! evaluator (`plo_eval::eval_omaha`) and the game/strategy data definitions.

use std::cmp::Ordering;

use plo_eval::{eval_omaha, HandRank};

use crate::cfr::NodeStrategy;
use crate::flop::{expand_bucket_strategies, FlopChild, FlopGame, FlopNode, TURN_CARD_DEAL_PROB};
use crate::game::{Node, NodeId, Player, RiverGame, TerminalNode};
use crate::turn::{TurnGame, TurnNode, RIVER_DEAL_PROB};

/// Complete exploitability and best-response report for a river strategy profile.
#[derive(Clone, Debug, PartialEq)]
pub struct ExploitabilityReport {
    /// Total Nash Distance ($\epsilon_{\text{OOP}} + \epsilon_{\text{IP}} = BR_{\text{OOP}} + BR_{\text{IP}} - P_0$)
    /// expressed as a percentage of `starting_pot` (`100.0 * nash_distance_chips / starting_pot`).
    pub nash_distance_pct: f64,
    /// Total Nash Distance in chips ($\epsilon_{\text{OOP}} + \epsilon_{\text{IP}}$).
    pub nash_distance_chips: f64,
    /// Per-player average exploitability ($\frac{1}{2}(\epsilon_{\text{OOP}} + \epsilon_{\text{IP}})$)
    /// expressed as a percentage of `starting_pot`.
    pub mean_exploitability_pct: f64,
    /// Per-player average exploitability in chips ($\frac{1}{2}(\epsilon_{\text{OOP}} + \epsilon_{\text{IP}})$).
    pub mean_exploitability_chips: f64,
    /// OOP's best-response gain in chips ($BR_{\text{OOP}} - EV_{\text{OOP}}$).
    pub oop_exploitability_chips: f64,
    /// IP's best-response gain in chips ($BR_{\text{IP}} - EV_{\text{IP}}$).
    pub ip_exploitability_chips: f64,
    /// OOP's expected value in chips when playing an exact best response against IP's strategy.
    pub oop_br_ev: f64,
    /// IP's expected value in chips when playing an exact best response against OOP's strategy.
    pub ip_br_ev: f64,
    /// OOP's expected value in chips under the evaluated strategy profile.
    pub oop_strategy_ev: f64,
    /// IP's expected value in chips under the evaluated strategy profile.
    pub ip_strategy_ev: f64,
    /// Per-combo best-response conditional EVs (in chips) for OOP.
    pub oop_br_combo_evs: Vec<f64>,
    /// Per-combo best-response conditional EVs (in chips) for IP.
    pub ip_br_combo_evs: Vec<f64>,
    /// Per-combo strategy conditional EVs (in chips) for OOP.
    pub oop_strategy_combo_evs: Vec<f64>,
    /// Per-combo strategy conditional EVs (in chips) for IP.
    pub ip_strategy_combo_evs: Vec<f64>,
}

/// Independently evaluates exact best-response exploitability (Nash Distance) of `strategies`
/// on `game`.
pub fn compute_exploitability(
    game: &RiverGame,
    strategies: &[NodeStrategy],
) -> ExploitabilityReport {
    let oop_combos = &game.combos[Player::Oop.index()];
    let ip_combos = &game.combos[Player::Ip.index()];

    // Independently evaluate Omaha hand ranks on the 5-card board via E1's `eval_omaha`.
    let oop_ranks: Vec<HandRank> = oop_combos
        .iter()
        .map(|c| eval_omaha(c.cards, game.board))
        .collect();
    let ip_ranks: Vec<HandRank> = ip_combos
        .iter()
        .map(|c| eval_omaha(c.cards, game.board))
        .collect();
    let ranks = [oop_ranks, ip_ranks];

    // Independently compute card-removal normalizing weights.
    let mut oop_norm = vec![0.0f64; oop_combos.len()];
    let mut ip_norm = vec![0.0f64; ip_combos.len()];
    let mut total_valid_weight = 0.0f64;

    for (i, oc) in oop_combos.iter().enumerate() {
        for (j, ic) in ip_combos.iter().enumerate() {
            if !oc.mask.overlaps(ic.mask) {
                oop_norm[i] += ic.weight;
                ip_norm[j] += oc.weight;
                total_valid_weight += oc.weight * ic.weight;
            }
        }
    }

    let init_oop_reach: Vec<f64> = oop_combos.iter().map(|c| c.weight).collect();
    let init_ip_reach: Vec<f64> = ip_combos.iter().map(|c| c.weight).collect();

    // 1. Best response for OOP against IP's fixed strategy (root opponent reach = init_ip_reach)
    let oop_br_cfv = br_traverse_node(
        game,
        strategies,
        &ranks,
        0,
        Player::Oop,
        &init_ip_reach,
        true,
    );

    // 2. Best response for IP against OOP's fixed strategy (root opponent reach = init_oop_reach)
    let ip_br_cfv = br_traverse_node(
        game,
        strategies,
        &ranks,
        0,
        Player::Ip,
        &init_oop_reach,
        true,
    );

    // 3. Strategy evaluation for OOP and IP under the given strategy profile
    let oop_strat_cfv = br_traverse_node(
        game,
        strategies,
        &ranks,
        0,
        Player::Oop,
        &init_ip_reach,
        false,
    );
    let ip_strat_cfv = br_traverse_node(
        game,
        strategies,
        &ranks,
        0,
        Player::Ip,
        &init_oop_reach,
        false,
    );

    let oop_br_ev: f64 = oop_combos
        .iter()
        .zip(oop_br_cfv.iter())
        .map(|(c, &cfv)| c.weight * cfv)
        .sum::<f64>()
        / total_valid_weight;

    let ip_br_ev: f64 = ip_combos
        .iter()
        .zip(ip_br_cfv.iter())
        .map(|(c, &cfv)| c.weight * cfv)
        .sum::<f64>()
        / total_valid_weight;

    let oop_strategy_ev: f64 = oop_combos
        .iter()
        .zip(oop_strat_cfv.iter())
        .map(|(c, &cfv)| c.weight * cfv)
        .sum::<f64>()
        / total_valid_weight;

    let ip_strategy_ev: f64 = ip_combos
        .iter()
        .zip(ip_strat_cfv.iter())
        .map(|(c, &cfv)| c.weight * cfv)
        .sum::<f64>()
        / total_valid_weight;

    let oop_br_combo_evs: Vec<f64> = oop_br_cfv
        .iter()
        .zip(oop_norm.iter())
        .map(|(&cfv, &z)| if z > 0.0 { cfv / z } else { 0.0 })
        .collect();

    let ip_br_combo_evs: Vec<f64> = ip_br_cfv
        .iter()
        .zip(ip_norm.iter())
        .map(|(&cfv, &z)| if z > 0.0 { cfv / z } else { 0.0 })
        .collect();

    let oop_strategy_combo_evs: Vec<f64> = oop_strat_cfv
        .iter()
        .zip(oop_norm.iter())
        .map(|(&cfv, &z)| if z > 0.0 { cfv / z } else { 0.0 })
        .collect();

    let ip_strategy_combo_evs: Vec<f64> = ip_strat_cfv
        .iter()
        .zip(ip_norm.iter())
        .map(|(&cfv, &z)| if z > 0.0 { cfv / z } else { 0.0 })
        .collect();

    let oop_exploitability_chips = (oop_br_ev - oop_strategy_ev).max(0.0);
    let ip_exploitability_chips = (ip_br_ev - ip_strategy_ev).max(0.0);
    let nash_distance_chips = oop_exploitability_chips + ip_exploitability_chips;
    let mean_exploitability_chips = 0.5 * nash_distance_chips;
    let nash_distance_pct = 100.0 * nash_distance_chips / game.starting_pot;
    let mean_exploitability_pct = 100.0 * mean_exploitability_chips / game.starting_pot;

    ExploitabilityReport {
        nash_distance_pct,
        nash_distance_chips,
        mean_exploitability_pct,
        mean_exploitability_chips,
        oop_exploitability_chips,
        ip_exploitability_chips,
        oop_br_ev,
        ip_br_ev,
        oop_strategy_ev,
        ip_strategy_ev,
        oop_br_combo_evs,
        ip_br_combo_evs,
        oop_strategy_combo_evs,
        ip_strategy_combo_evs,
    }
}

fn br_traverse_node(
    game: &RiverGame,
    strategies: &[NodeStrategy],
    ranks: &[Vec<HandRank>; 2],
    node_id: NodeId,
    traverser: Player,
    opp_reach: &[f64],
    maximize_traverser: bool,
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
            let num_actions = d.actions.len();
            let node_strat = &strategies[d.decision_id];

            if d.player == traverser {
                // Traverser's decision node: opponent reach does not change across actions.
                if maximize_traverser {
                    let mut best = vec![f64::NEG_INFINITY; num_my];
                    for &child_id in &d.children {
                        let child_cfv = br_traverse_node(
                            game,
                            strategies,
                            ranks,
                            child_id,
                            traverser,
                            opp_reach,
                            maximize_traverser,
                        );
                        for i in 0..num_my {
                            if child_cfv[i] > best[i] {
                                best[i] = child_cfv[i];
                            }
                        }
                    }
                    best
                } else {
                    let mut weighted = vec![0.0f64; num_my];
                    for (a_idx, &child_id) in d.children.iter().enumerate() {
                        let child_cfv = br_traverse_node(
                            game,
                            strategies,
                            ranks,
                            child_id,
                            traverser,
                            opp_reach,
                            maximize_traverser,
                        );
                        for i in 0..num_my {
                            let prob = node_strat.freq(i, a_idx);
                            weighted[i] += prob * child_cfv[i];
                        }
                    }
                    weighted
                }
            } else {
                // Opponent's decision node: propagate opponent reach weighted by opponent's strategy.
                let mut total = vec![0.0f64; num_my];
                let mut next_opp_reach = vec![0.0f64; num_opp];

                for a_idx in 0..num_actions {
                    let child_id = d.children[a_idx];
                    let mut any_reach = false;
                    for j in 0..num_opp {
                        let r = opp_reach[j] * node_strat.freq(j, a_idx);
                        next_opp_reach[j] = r;
                        if r > 0.0 {
                            any_reach = true;
                        }
                    }
                    if !any_reach {
                        continue;
                    }
                    let child_cfv = br_traverse_node(
                        game,
                        strategies,
                        ranks,
                        child_id,
                        traverser,
                        &next_opp_reach,
                        maximize_traverser,
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
// Turn game (Ticket E3): independent best-response checker for the two-street
// tree. This traversal is written independently of the turn CFR traversal in
// `turn.rs`: it shares only the E1 evaluator (`eval_omaha`, called directly on
// 5-card boards here) and the game/strategy data definitions. Hand ranks are
// recomputed here per runout rather than read from `TurnGame::river_ranks`,
// and card removal at chance nodes is applied by explicit pair filtering
// (a pair contributes on runout `r` only if neither combo contains `r`).
// ============================================================================

/// Independently evaluates Omaha hand ranks for every runout of a [`TurnGame`]
/// via E1's `eval_omaha`. Combos containing the river card are impossible on
/// that runout; their ranks are never read (pairs are filtered explicitly by
/// the traversals), so they are filled with a dummy instead of evaluating an
/// illegal duplicated-card hand.
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

/// Independently evaluates exact best-response exploitability (Nash Distance) of
/// `strategies` on the two-street [`TurnGame`].
pub fn compute_exploitability_turn(
    game: &TurnGame,
    strategies: &[NodeStrategy],
) -> ExploitabilityReport {
    let oop_combos = &game.combos[Player::Oop.index()];
    let ip_combos = &game.combos[Player::Ip.index()];

    // Independently evaluate Omaha hand ranks for every runout via E1's `eval_omaha`.
    let ranks = compute_turn_ranks(game);

    // Independently compute card-removal normalizing weights.
    let mut oop_norm = vec![0.0f64; oop_combos.len()];
    let mut ip_norm = vec![0.0f64; ip_combos.len()];
    let mut total_valid_weight = 0.0f64;
    for (i, oc) in oop_combos.iter().enumerate() {
        for (j, ic) in ip_combos.iter().enumerate() {
            if !oc.mask.overlaps(ic.mask) {
                oop_norm[i] += ic.weight;
                ip_norm[j] += oc.weight;
                total_valid_weight += oc.weight * ic.weight;
            }
        }
    }

    let init_oop_reach: Vec<f64> = oop_combos.iter().map(|c| c.weight).collect();
    let init_ip_reach: Vec<f64> = ip_combos.iter().map(|c| c.weight).collect();

    let oop_br_cfv = br_traverse_turn_node(
        game,
        strategies,
        &ranks,
        0,
        Player::Oop,
        None,
        &init_ip_reach,
        true,
    );
    let ip_br_cfv = br_traverse_turn_node(
        game,
        strategies,
        &ranks,
        0,
        Player::Ip,
        None,
        &init_oop_reach,
        true,
    );
    let oop_strat_cfv = br_traverse_turn_node(
        game,
        strategies,
        &ranks,
        0,
        Player::Oop,
        None,
        &init_ip_reach,
        false,
    );
    let ip_strat_cfv = br_traverse_turn_node(
        game,
        strategies,
        &ranks,
        0,
        Player::Ip,
        None,
        &init_oop_reach,
        false,
    );

    let oop_br_ev: f64 = oop_combos
        .iter()
        .zip(oop_br_cfv.iter())
        .map(|(c, &cfv)| c.weight * cfv)
        .sum::<f64>()
        / total_valid_weight;
    let ip_br_ev: f64 = ip_combos
        .iter()
        .zip(ip_br_cfv.iter())
        .map(|(c, &cfv)| c.weight * cfv)
        .sum::<f64>()
        / total_valid_weight;
    let oop_strategy_ev: f64 = oop_combos
        .iter()
        .zip(oop_strat_cfv.iter())
        .map(|(c, &cfv)| c.weight * cfv)
        .sum::<f64>()
        / total_valid_weight;
    let ip_strategy_ev: f64 = ip_combos
        .iter()
        .zip(ip_strat_cfv.iter())
        .map(|(c, &cfv)| c.weight * cfv)
        .sum::<f64>()
        / total_valid_weight;

    let oop_br_combo_evs: Vec<f64> = oop_br_cfv
        .iter()
        .zip(oop_norm.iter())
        .map(|(&cfv, &z)| if z > 0.0 { cfv / z } else { 0.0 })
        .collect();
    let ip_br_combo_evs: Vec<f64> = ip_br_cfv
        .iter()
        .zip(ip_norm.iter())
        .map(|(&cfv, &z)| if z > 0.0 { cfv / z } else { 0.0 })
        .collect();
    let oop_strategy_combo_evs: Vec<f64> = oop_strat_cfv
        .iter()
        .zip(oop_norm.iter())
        .map(|(&cfv, &z)| if z > 0.0 { cfv / z } else { 0.0 })
        .collect();
    let ip_strategy_combo_evs: Vec<f64> = ip_strat_cfv
        .iter()
        .zip(ip_norm.iter())
        .map(|(&cfv, &z)| if z > 0.0 { cfv / z } else { 0.0 })
        .collect();

    let oop_exploitability_chips = (oop_br_ev - oop_strategy_ev).max(0.0);
    let ip_exploitability_chips = (ip_br_ev - ip_strategy_ev).max(0.0);
    let nash_distance_chips = oop_exploitability_chips + ip_exploitability_chips;
    let mean_exploitability_chips = 0.5 * nash_distance_chips;
    let nash_distance_pct = 100.0 * nash_distance_chips / game.starting_pot;
    let mean_exploitability_pct = 100.0 * mean_exploitability_chips / game.starting_pot;

    ExploitabilityReport {
        nash_distance_pct,
        nash_distance_chips,
        mean_exploitability_pct,
        mean_exploitability_chips,
        oop_exploitability_chips,
        ip_exploitability_chips,
        oop_br_ev,
        ip_br_ev,
        oop_strategy_ev,
        ip_strategy_ev,
        oop_br_combo_evs,
        ip_br_combo_evs,
        oop_strategy_combo_evs,
        ip_strategy_combo_evs,
    }
}

#[allow(clippy::too_many_arguments)]
fn br_traverse_turn_node(
    game: &TurnGame,
    strategies: &[NodeStrategy],
    ranks: &[[Vec<HandRank>; 2]],
    node_id: NodeId,
    traverser: Player,
    runout: Option<usize>,
    opp_reach: &[f64],
    maximize_traverser: bool,
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
            // On a runout, pairs involving a combo that contains the river card
            // are impossible and contribute exactly 0.
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
                let child_cfv = br_traverse_turn_node(
                    game,
                    strategies,
                    ranks,
                    child_id,
                    traverser,
                    Some(r),
                    opp_reach,
                    maximize_traverser,
                );
                for i in 0..num_my {
                    total[i] += RIVER_DEAL_PROB * child_cfv[i];
                }
            }
            total
        }
        TurnNode::Decision(d) => {
            let num_actions = d.actions.len();
            let node_strat = &strategies[d.decision_id];

            if d.player == traverser {
                if maximize_traverser {
                    let mut best = vec![f64::NEG_INFINITY; num_my];
                    for &child_id in &d.children {
                        let child_cfv = br_traverse_turn_node(
                            game,
                            strategies,
                            ranks,
                            child_id,
                            traverser,
                            runout,
                            opp_reach,
                            maximize_traverser,
                        );
                        for i in 0..num_my {
                            if child_cfv[i] > best[i] {
                                best[i] = child_cfv[i];
                            }
                        }
                    }
                    best
                } else {
                    let mut weighted = vec![0.0f64; num_my];
                    for (a_idx, &child_id) in d.children.iter().enumerate() {
                        let child_cfv = br_traverse_turn_node(
                            game,
                            strategies,
                            ranks,
                            child_id,
                            traverser,
                            runout,
                            opp_reach,
                            maximize_traverser,
                        );
                        for i in 0..num_my {
                            weighted[i] += node_strat.freq(i, a_idx) * child_cfv[i];
                        }
                    }
                    weighted
                }
            } else {
                let mut total = vec![0.0f64; num_my];
                let mut next_opp_reach = vec![0.0f64; num_opp];
                for a_idx in 0..num_actions {
                    let child_id = d.children[a_idx];
                    let mut any_reach = false;
                    for j in 0..num_opp {
                        let r = opp_reach[j] * node_strat.freq(j, a_idx);
                        next_opp_reach[j] = r;
                        if r > 0.0 {
                            any_reach = true;
                        }
                    }
                    if !any_reach {
                        continue;
                    }
                    let child_cfv = br_traverse_turn_node(
                        game,
                        strategies,
                        ranks,
                        child_id,
                        traverser,
                        runout,
                        &next_opp_reach,
                        maximize_traverser,
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
// Flop game (Ticket E4): independent best-response checker for the
// three-street tree with a *bucketed* flop street. The bucketed flop
// strategies are expanded to combo level, and the traversal below plays an
// exact combo-level best response against that profile in the UNABSTRACTED
// game — flop decisions are maximised per individual combo, and the
// turn/river subtrees are checked with the E3 traversal
// (`br_traverse_turn_node`), which is itself independent of the solver.
// The resulting Nash distance therefore includes the full abstraction loss
// of the bucketing. This is the only exploitability number reported for
// flop solves.
// ============================================================================

/// Independently evaluates exact best-response exploitability (Nash Distance)
/// of a flop solve — bucket-level `flop_strategies` plus per-subtree
/// `subtree_strategies` (aligned with `FlopGame::subtrees`) — in the
/// unabstracted game.
pub fn compute_exploitability_flop(
    game: &FlopGame,
    flop_strategies: &[NodeStrategy],
    subtree_strategies: &[Vec<NodeStrategy>],
) -> ExploitabilityReport {
    let expanded = expand_bucket_strategies(game, flop_strategies);

    // Independently evaluate Omaha hand ranks for every subtree runout.
    let subtree_ranks: Vec<Option<Vec<[Vec<HandRank>; 2]>>> = game
        .subtrees
        .iter()
        .map(|s| s.game.as_ref().map(|g| compute_turn_ranks(g)))
        .collect();

    let oop_combos = &game.combos[Player::Oop.index()];
    let ip_combos = &game.combos[Player::Ip.index()];

    // Card-removal normalizing weights over flop pairs.
    let mut oop_norm = vec![0.0f64; oop_combos.len()];
    let mut ip_norm = vec![0.0f64; ip_combos.len()];
    let mut total_valid_weight = 0.0f64;
    for (i, oc) in oop_combos.iter().enumerate() {
        for (j, ic) in ip_combos.iter().enumerate() {
            if !oc.mask.overlaps(ic.mask) {
                oop_norm[i] += ic.weight;
                ip_norm[j] += oc.weight;
                total_valid_weight += oc.weight * ic.weight;
            }
        }
    }

    let init_oop_reach: Vec<f64> = oop_combos.iter().map(|c| c.weight).collect();
    let init_ip_reach: Vec<f64> = ip_combos.iter().map(|c| c.weight).collect();

    let oop_br_cfv = br_traverse_flop_node(
        game,
        &expanded,
        subtree_strategies,
        &subtree_ranks,
        0,
        Player::Oop,
        &init_ip_reach,
        true,
    );
    let ip_br_cfv = br_traverse_flop_node(
        game,
        &expanded,
        subtree_strategies,
        &subtree_ranks,
        0,
        Player::Ip,
        &init_oop_reach,
        true,
    );
    let oop_strat_cfv = br_traverse_flop_node(
        game,
        &expanded,
        subtree_strategies,
        &subtree_ranks,
        0,
        Player::Oop,
        &init_ip_reach,
        false,
    );
    let ip_strat_cfv = br_traverse_flop_node(
        game,
        &expanded,
        subtree_strategies,
        &subtree_ranks,
        0,
        Player::Ip,
        &init_oop_reach,
        false,
    );

    let oop_br_ev: f64 = oop_combos
        .iter()
        .zip(oop_br_cfv.iter())
        .map(|(c, &cfv)| c.weight * cfv)
        .sum::<f64>()
        / total_valid_weight;
    let ip_br_ev: f64 = ip_combos
        .iter()
        .zip(ip_br_cfv.iter())
        .map(|(c, &cfv)| c.weight * cfv)
        .sum::<f64>()
        / total_valid_weight;
    let oop_strategy_ev: f64 = oop_combos
        .iter()
        .zip(oop_strat_cfv.iter())
        .map(|(c, &cfv)| c.weight * cfv)
        .sum::<f64>()
        / total_valid_weight;
    let ip_strategy_ev: f64 = ip_combos
        .iter()
        .zip(ip_strat_cfv.iter())
        .map(|(c, &cfv)| c.weight * cfv)
        .sum::<f64>()
        / total_valid_weight;

    let oop_br_combo_evs: Vec<f64> = oop_br_cfv
        .iter()
        .zip(oop_norm.iter())
        .map(|(&cfv, &z)| if z > 0.0 { cfv / z } else { 0.0 })
        .collect();
    let ip_br_combo_evs: Vec<f64> = ip_br_cfv
        .iter()
        .zip(ip_norm.iter())
        .map(|(&cfv, &z)| if z > 0.0 { cfv / z } else { 0.0 })
        .collect();
    let oop_strategy_combo_evs: Vec<f64> = oop_strat_cfv
        .iter()
        .zip(oop_norm.iter())
        .map(|(&cfv, &z)| if z > 0.0 { cfv / z } else { 0.0 })
        .collect();
    let ip_strategy_combo_evs: Vec<f64> = ip_strat_cfv
        .iter()
        .zip(ip_norm.iter())
        .map(|(&cfv, &z)| if z > 0.0 { cfv / z } else { 0.0 })
        .collect();

    let oop_exploitability_chips = (oop_br_ev - oop_strategy_ev).max(0.0);
    let ip_exploitability_chips = (ip_br_ev - ip_strategy_ev).max(0.0);
    let nash_distance_chips = oop_exploitability_chips + ip_exploitability_chips;
    let mean_exploitability_chips = 0.5 * nash_distance_chips;
    let nash_distance_pct = 100.0 * nash_distance_chips / game.starting_pot;
    let mean_exploitability_pct = 100.0 * mean_exploitability_chips / game.starting_pot;

    ExploitabilityReport {
        nash_distance_pct,
        nash_distance_chips,
        mean_exploitability_pct,
        mean_exploitability_chips,
        oop_exploitability_chips,
        ip_exploitability_chips,
        oop_br_ev,
        ip_br_ev,
        oop_strategy_ev,
        ip_strategy_ev,
        oop_br_combo_evs,
        ip_br_combo_evs,
        oop_strategy_combo_evs,
        ip_strategy_combo_evs,
    }
}

#[allow(clippy::too_many_arguments)]
fn br_traverse_flop_node(
    game: &FlopGame,
    expanded_strategies: &[NodeStrategy],
    subtree_strategies: &[Vec<NodeStrategy>],
    subtree_ranks: &[Option<Vec<[Vec<HandRank>; 2]>>],
    node_id: NodeId,
    traverser: Player,
    opp_reach: &[f64],
    maximize_traverser: bool,
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
            let num_actions = d.actions.len();
            let node_strat = &expanded_strategies[d.decision_id];

            if d.player == traverser {
                if maximize_traverser {
                    // Exact best response at COMBO level, even though the
                    // evaluated profile only distinguishes buckets.
                    let mut best = vec![f64::NEG_INFINITY; num_my];
                    for &child in &d.children {
                        let child_cfv = br_eval_flop_child(
                            game,
                            expanded_strategies,
                            subtree_strategies,
                            subtree_ranks,
                            child,
                            traverser,
                            opp_reach,
                            maximize_traverser,
                        );
                        for i in 0..num_my {
                            if child_cfv[i] > best[i] {
                                best[i] = child_cfv[i];
                            }
                        }
                    }
                    best
                } else {
                    let mut weighted = vec![0.0f64; num_my];
                    for (a_idx, &child) in d.children.iter().enumerate() {
                        let child_cfv = br_eval_flop_child(
                            game,
                            expanded_strategies,
                            subtree_strategies,
                            subtree_ranks,
                            child,
                            traverser,
                            opp_reach,
                            maximize_traverser,
                        );
                        for i in 0..num_my {
                            weighted[i] += node_strat.freq(i, a_idx) * child_cfv[i];
                        }
                    }
                    weighted
                }
            } else {
                let mut total = vec![0.0f64; num_my];
                let mut next_opp_reach = vec![0.0f64; num_opp];
                for a_idx in 0..num_actions {
                    let child = d.children[a_idx];
                    let mut any_reach = false;
                    for j in 0..num_opp {
                        let r = opp_reach[j] * node_strat.freq(j, a_idx);
                        next_opp_reach[j] = r;
                        if r > 0.0 {
                            any_reach = true;
                        }
                    }
                    if !any_reach {
                        continue;
                    }
                    let child_cfv = br_eval_flop_child(
                        game,
                        expanded_strategies,
                        subtree_strategies,
                        subtree_ranks,
                        child,
                        traverser,
                        &next_opp_reach,
                        maximize_traverser,
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
fn br_eval_flop_child(
    game: &FlopGame,
    expanded_strategies: &[NodeStrategy],
    subtree_strategies: &[Vec<NodeStrategy>],
    subtree_ranks: &[Option<Vec<[Vec<HandRank>; 2]>>],
    child: FlopChild,
    traverser: Player,
    opp_reach: &[f64],
    maximize_traverser: bool,
) -> Vec<f64> {
    match child {
        FlopChild::Node(child_id) => br_traverse_flop_node(
            game,
            expanded_strategies,
            subtree_strategies,
            subtree_ranks,
            child_id,
            traverser,
            opp_reach,
            maximize_traverser,
        ),
        FlopChild::Subtrees(group_idx) => {
            let num_my = game.combos[traverser.index()].len();
            let mut out = vec![0.0f64; num_my];
            for &sub_idx in &game.subtree_groups[group_idx].subtrees {
                let sub_cfv = br_eval_flop_subtree(
                    game,
                    subtree_strategies,
                    subtree_ranks,
                    sub_idx,
                    traverser,
                    opp_reach,
                    maximize_traverser,
                );
                for i in 0..num_my {
                    out[i] += TURN_CARD_DEAL_PROB * sub_cfv[i];
                }
            }
            out
        }
    }
}

/// Evaluates one turn-card subtree for the flop checker: maps the opponent
/// reach into the subtree, runs the independent E3 turn traversal there, and
/// maps the traverser's values back to flop combo indexing.
#[allow(clippy::too_many_arguments)]
fn br_eval_flop_subtree(
    game: &FlopGame,
    subtree_strategies: &[Vec<NodeStrategy>],
    subtree_ranks: &[Option<Vec<[Vec<HandRank>; 2]>>],
    sub_idx: usize,
    traverser: Player,
    opp_reach: &[f64],
    maximize_traverser: bool,
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
    let cfv_sub = br_traverse_turn_node(
        sub_game,
        &subtree_strategies[sub_idx],
        ranks,
        0,
        traverser,
        None,
        &opp_sub,
        maximize_traverser,
    );
    // Seam correction (must mirror the solver exactly): the turn traversal's
    // values are net of turn/river contributions only — the subtree pot,
    // which already contains both players' flop commitments, is dead money
    // inside the subtree. The traverser's full-hand net value must also
    // charge the chips it committed on the flop to reach this subtree:
    // subtract `committed * (valid opponent reach mass for the combo)`,
    // valid meaning the opponent combo shares no card with the traverser's.
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
