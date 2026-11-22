//! Independent best-response checker for the Hold'em river solver.

use std::cmp::Ordering;

use plo_eval::{eval_holdem, HandRank};

use crate::br::ExploitabilityReport;
use crate::cfr::NodeStrategy;
use crate::game::{Node, NodeId, Player, TerminalNode};
use crate::holdem::HoldemGame;

pub fn compute_holdem_exploitability(
    game: &HoldemGame,
    strategies: &[NodeStrategy],
) -> ExploitabilityReport {
    let ranks = [
        game.combos[0]
            .iter()
            .map(|combo| eval_holdem(combo.cards, game.board))
            .collect::<Vec<_>>(),
        game.combos[1]
            .iter()
            .map(|combo| eval_holdem(combo.cards, game.board))
            .collect::<Vec<_>>(),
    ];
    let mut oop_norm = vec![0.0; game.combos[0].len()];
    let mut ip_norm = vec![0.0; game.combos[1].len()];
    let mut total_valid_weight = 0.0;
    for (i, oop) in game.combos[0].iter().enumerate() {
        for (j, ip) in game.combos[1].iter().enumerate() {
            if !oop.mask.overlaps(ip.mask) {
                oop_norm[i] += ip.weight;
                ip_norm[j] += oop.weight;
                total_valid_weight += oop.weight * ip.weight;
            }
        }
    }

    let oop_reach: Vec<_> = game.combos[0].iter().map(|combo| combo.weight).collect();
    let ip_reach: Vec<_> = game.combos[1].iter().map(|combo| combo.weight).collect();
    let oop_br = traverse(game, strategies, &ranks, 0, Player::Oop, &ip_reach, true);
    let ip_br = traverse(game, strategies, &ranks, 0, Player::Ip, &oop_reach, true);
    let oop_strategy = traverse(game, strategies, &ranks, 0, Player::Oop, &ip_reach, false);
    let ip_strategy = traverse(game, strategies, &ranks, 0, Player::Ip, &oop_reach, false);

    let weighted_ev = |player: Player, values: &[f64]| {
        game.combos[player.index()]
            .iter()
            .zip(values)
            .map(|(combo, value)| combo.weight * value)
            .sum::<f64>()
            / total_valid_weight
    };
    let combo_evs = |values: &[f64], norms: &[f64]| {
        values
            .iter()
            .zip(norms)
            .map(|(value, norm)| if *norm > 0.0 { value / norm } else { 0.0 })
            .collect::<Vec<_>>()
    };
    let oop_br_ev = weighted_ev(Player::Oop, &oop_br);
    let ip_br_ev = weighted_ev(Player::Ip, &ip_br);
    let oop_strategy_ev = weighted_ev(Player::Oop, &oop_strategy);
    let ip_strategy_ev = weighted_ev(Player::Ip, &ip_strategy);
    let oop_exploitability_chips = (oop_br_ev - oop_strategy_ev).max(0.0);
    let ip_exploitability_chips = (ip_br_ev - ip_strategy_ev).max(0.0);
    let nash_distance_chips = oop_exploitability_chips + ip_exploitability_chips;
    let mean_exploitability_chips = 0.5 * nash_distance_chips;

    ExploitabilityReport {
        nash_distance_pct: 100.0 * nash_distance_chips / game.starting_pot,
        nash_distance_chips,
        mean_exploitability_pct: 100.0 * mean_exploitability_chips / game.starting_pot,
        mean_exploitability_chips,
        oop_exploitability_chips,
        ip_exploitability_chips,
        oop_br_ev,
        ip_br_ev,
        oop_strategy_ev,
        ip_strategy_ev,
        oop_br_combo_evs: combo_evs(&oop_br, &oop_norm),
        ip_br_combo_evs: combo_evs(&ip_br, &ip_norm),
        oop_strategy_combo_evs: combo_evs(&oop_strategy, &oop_norm),
        ip_strategy_combo_evs: combo_evs(&ip_strategy, &ip_norm),
    }
}

fn traverse(
    game: &HoldemGame,
    strategies: &[NodeStrategy],
    ranks: &[Vec<HandRank>; 2],
    node_id: NodeId,
    traverser: Player,
    opp_reach: &[f64],
    maximize: bool,
) -> Vec<f64> {
    let p = traverser.index();
    let q = traverser.opponent().index();
    match &game.nodes[node_id] {
        Node::Terminal(terminal) => {
            let mut values = vec![0.0; game.combos[p].len()];
            match *terminal {
                TerminalNode::Fold { folder, committed } => {
                    let payoff = if folder == traverser {
                        -committed[p]
                    } else {
                        game.starting_pot + committed[q]
                    };
                    for (i, own) in game.combos[p].iter().enumerate() {
                        values[i] = game.combos[q]
                            .iter()
                            .enumerate()
                            .filter(|(_, other)| !own.mask.overlaps(other.mask))
                            .map(|(j, _)| opp_reach[j])
                            .sum::<f64>()
                            * payoff;
                    }
                }
                TerminalNode::Showdown { committed } => {
                    for (i, own) in game.combos[p].iter().enumerate() {
                        for (j, other) in game.combos[q].iter().enumerate() {
                            if own.mask.overlaps(other.mask) {
                                continue;
                            }
                            let payoff = match ranks[p][i].cmp(&ranks[q][j]) {
                                Ordering::Greater => game.starting_pot + committed[q],
                                Ordering::Equal => game.starting_pot * 0.5,
                                Ordering::Less => -committed[p],
                            };
                            values[i] += opp_reach[j] * payoff;
                        }
                    }
                }
            }
            values
        }
        Node::Decision(decision) => {
            let strategy = &strategies[decision.decision_id];
            if decision.player == traverser {
                let mut values = if maximize {
                    vec![f64::NEG_INFINITY; game.combos[p].len()]
                } else {
                    vec![0.0; game.combos[p].len()]
                };
                for (action, &child) in decision.children.iter().enumerate() {
                    let child_values = traverse(
                        game, strategies, ranks, child, traverser, opp_reach, maximize,
                    );
                    for i in 0..values.len() {
                        if maximize {
                            values[i] = values[i].max(child_values[i]);
                        } else {
                            values[i] += strategy.freq(i, action) * child_values[i];
                        }
                    }
                }
                values
            } else {
                let mut values = vec![0.0; game.combos[p].len()];
                let mut next_reach = vec![0.0; game.combos[q].len()];
                for (action, &child) in decision.children.iter().enumerate() {
                    let mut any_reach = false;
                    for j in 0..next_reach.len() {
                        next_reach[j] = opp_reach[j] * strategy.freq(j, action);
                        any_reach |= next_reach[j] > 0.0;
                    }
                    if any_reach {
                        let child_values = traverse(
                            game,
                            strategies,
                            ranks,
                            child,
                            traverser,
                            &next_reach,
                            maximize,
                        );
                        for i in 0..values.len() {
                            values[i] += child_values[i];
                        }
                    }
                }
                values
            }
        }
    }
}
