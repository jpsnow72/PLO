//! Validation suite for per-action EV output (issue #8).
//!
//! The evaluation pass (`plo_solve::action_ev`) is anchored three ways:
//! 1. **Checker anchor (root identity).** At the root of every game, the
//!    strategy-weighted average of a combo's action EVs must equal its
//!    stored whole-solve EV — which the solvers take verbatim from the
//!    independent best-response checker (`br.rs`). The naive evaluator
//!    below is itself anchored the same way for BOTH players at the root.
//! 2. **Naive cross-validation.** A from-scratch evaluator (forward reach
//!    propagation + naive per-pair terminal enumeration, sharing only the
//!    E1 evaluator and the data definitions) recomputes every node's
//!    action EVs for the river and turn spots; all values must agree.
//! 3. **Per-node identity + ordering.** At every node of every game:
//!    `sum_a freq(i, a) * ev(i, a) == node_evs[i]`, and the node value lies
//!    between the combo's worst and best action EVs.
//!
//! Flop subtrees are cross-checked against the (naive-validated) turn
//! pass run standalone on each subtree game, shifted by the subtree's
//! flop commitment — the seam correction in conditional terms. The
//! comparison is restricted to records whose flop-profile normaliser
//! `Z(i)` is positive (recomputed below by forward reach propagation):
//! at `Z(i) == 0` the conditional value is undefined and both passes
//! record `0.0` by convention, so a shifted comparison there would test
//! the convention, not the seam (gate finding, EV-OUTPUT-NOTES.md).
//! Counted witnesses keep the restricted check non-vacuous.
//!
//! The identities are algebraic in the solved profile, so the spots run
//! few iterations: they hold for any average strategy, converged or not.

use std::cmp::Ordering;

use plo_cards::Card;
use plo_eval::{eval_omaha, HandRank, PloRange};
use plo_solve::{
    compute_action_evs_turn, expand_bucket_strategies, format_flop_solve_result_json,
    format_solve_result_json, format_turn_solve_result_json, parse_flop_spot_json, solve_flop,
    solve_river, solve_turn, ComboEv, DcfrConfig, FlopChild, FlopGame, FlopNode, JsonValue,
    Node, NodeActionEvs,
    NodeLock, NodeStrategy, Player, RiverGame, RiverSpot, TerminalNode, TreeConfig, TurnGame,
    TurnNode, TurnSpot, RIVER_DEAL_PROB,
};

const TOL: f64 = 1e-6;
const IDENTITY_TOL: f64 = 1e-9;
/// Domain threshold for the flop seam cross-check: a subtree record is
/// compared only when the flop pass's normaliser `Z(i)` at its node —
/// the opponent reach mass live against the combo — exceeds this. At
/// `Z == 0` the conditional EV is undefined and both passes record
/// `0.0` by convention; genuinely reached records in this spot carry
/// `Z` many orders of magnitude above the threshold (range weights are
/// 1.0 and at most a handful of frequency factors lie on any path).
const SEAM_Z_MIN: f64 = 1e-9;
/// Non-vacuity witnesses for the seam cross-check: the spot carries
/// ~147 live subtrees x ~196 decision nodes x ~3 combos (~78k records),
/// and subtrees 49..=57 (commitment 75) passed the *unrestricted* check
/// at the gate — possible only if essentially all of their ~4.7k
/// records were genuinely compared, since any `Z == 0` record there
/// would have failed as `0 != 0 - 75`. The minima sit far below that.
const MIN_SEAM_COMPARED: usize = 1_000;
const MIN_SEAM_SHIFTED_COMPARED: usize = 500;
/// Serialized values are rounded to 3 decimals: |parsed - exact| <= 0.0005.
const ROUND_TOL: f64 = 5.1e-4;

fn pidx(p: Player) -> usize {
    match p {
        Player::Oop => 0,
        Player::Ip => 1,
    }
}

fn popp(p: Player) -> Player {
    match p {
        Player::Oop => Player::Ip,
        Player::Ip => Player::Oop,
    }
}

fn assert_close(actual: f64, expected: f64, tol: f64, what: &str) {
    assert!(
        (actual - expected).abs() <= tol,
        "{what}: expected {expected}, got {actual} (tol {tol})"
    );
}

/// Per-node identity (brief item b), ordering (item c), and shape checks
/// for one game's records against its (combo-level) strategies.
fn check_identities(strategies: &[NodeStrategy], records: &[NodeActionEvs], ctx: &str) {
    assert_eq!(
        strategies.len(),
        records.len(),
        "{ctx}: one record per decision node"
    );
    for (ns, rec) in strategies.iter().zip(records.iter()) {
        assert_eq!(rec.decision_id, ns.decision_id, "{ctx}: decision_id alignment");
        assert_eq!(rec.player, ns.player, "{ctx}: player alignment");
        assert_eq!(rec.actions, ns.actions, "{ctx}: actions alignment");
        assert_eq!(
            rec.evs.len(),
            ns.num_combos * ns.actions.len(),
            "{ctx}: evs shape at {}",
            ns.history
        );
        assert_eq!(rec.node_evs.len(), ns.num_combos, "{ctx}: node_evs shape");
        for i in 0..ns.num_combos {
            let row = rec.combo_action_evs(i);
            assert!(
                row.iter().all(|v| v.is_finite()),
                "{ctx}: non-finite action EV at {} combo {i}",
                ns.history
            );
            let weighted: f64 = row
                .iter()
                .zip(ns.combo_strategy(i).iter())
                .map(|(e, f)| e * f)
                .sum();
            assert_close(
                weighted,
                rec.node_evs[i],
                IDENTITY_TOL,
                &format!("{ctx}: freq-weighted identity at {} combo {i}", ns.history),
            );
            let max = row.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            let min = row.iter().cloned().fold(f64::INFINITY, f64::min);
            assert!(
                rec.node_evs[i] <= max + IDENTITY_TOL && rec.node_evs[i] >= min - IDENTITY_TOL,
                "{ctx}: node value {} outside action range [{min}, {max}] at {} combo {i}",
                rec.node_evs[i],
                ns.history
            );
        }
    }
}

/// Root identity (brief item a): the root record's node values equal the
/// stored whole-solve EVs of the root player's combos.
fn check_root_identity(records: &[NodeActionEvs], stored_evs: &[ComboEv], ctx: &str) {
    let root = &records[0];
    assert_eq!(root.decision_id, 0, "{ctx}: first record is the root");
    assert_eq!(root.node_evs.len(), stored_evs.len(), "{ctx}: root combo count");
    for (i, ce) in stored_evs.iter().enumerate() {
        assert_close(
            root.node_evs[i],
            ce.ev,
            TOL,
            &format!("{ctx}: root identity combo {i}"),
        );
    }
}

// ============================================================================
// Test spots.
// ============================================================================

fn river_test_game() -> RiverGame {
    let board = Card::parse_n::<5>("Kd Qd 9c 6s 2h").unwrap();
    let oop_range = PloRange::from_str_specs(&[
        ("As Ac 3h 4h", 1.0),
        ("Js Ts 8c 7c", 0.6),
        ("5d 4d 3s 2d", 0.35),
    ])
    .unwrap();
    let ip_range = PloRange::from_str_specs(&[
        ("Ah Kh 5c 6c", 0.8),
        ("Jc Tc 8h 7h", 1.0),
        ("9d 8d 5h 4s", 0.5),
    ])
    .unwrap();
    RiverGame::new(RiverSpot {
        board,
        oop_range,
        ip_range,
        starting_pot: 100.0,
        effective_stack: 150.0,
        tree_config: TreeConfig::default(),
    })
    .unwrap()
}

fn reduced_config() -> TreeConfig {
    TreeConfig {
        bet_sizes: vec![1.0],
        include_all_in_bet: false,
        raise_sizes: vec![],
        include_all_in_raise: false,
        max_raises: 0,
    }
}

fn turn_test_game() -> TurnGame {
    let board = Card::parse_n::<4>("As Ks Qs 2d").unwrap();
    let oop_range = PloRange::from_str_specs(&[
        ("Ts Js 3c 4c", 1.0),
        ("9s 8s 5h 6h", 0.7),
        ("Ac Ad 3h 3d", 0.5),
    ])
    .unwrap();
    let ip_range = PloRange::from_str_specs(&[
        ("9h 8h 3s 4s", 0.9),
        ("Kc Kd 7h 7s", 0.6),
        ("Qc Jc 9d 8d", 1.0),
    ])
    .unwrap();
    TurnGame::new(TurnSpot {
        board,
        oop_range,
        ip_range,
        starting_pot: 100.0,
        effective_stack: 100.0,
        turn_config: reduced_config(),
        river_config: reduced_config(),
    })
    .unwrap()
}

fn fast_cfg() -> DcfrConfig {
    DcfrConfig {
        max_iterations: 300,
        target_exploitability_pct: 0.0,
        check_interval: 0,
        ..DcfrConfig::default()
    }
}

// ============================================================================
// Naive river evaluator (independent code path; per-pair terminal loops).
// ============================================================================

fn river_ranks(game: &RiverGame) -> [Vec<HandRank>; 2] {
    [
        game.combos[0]
            .iter()
            .map(|c| eval_omaha(c.cards, game.board))
            .collect(),
        game.combos[1]
            .iter()
            .map(|c| eval_omaha(c.cards, game.board))
            .collect(),
    ]
}

fn river_forward_reach(
    game: &RiverGame,
    strategies: &[NodeStrategy],
) -> Vec<[Vec<f64>; 2]> {
    fn fill(
        game: &RiverGame,
        strategies: &[NodeStrategy],
        node_id: usize,
        cur: [Vec<f64>; 2],
        reach: &mut Vec<[Vec<f64>; 2]>,
    ) {
        reach[node_id] = cur.clone();
        if let Node::Decision(d) = &game.nodes[node_id] {
            let ns = &strategies[d.decision_id];
            let p = pidx(d.player);
            for (a, &child) in d.children.iter().enumerate() {
                let mut next = cur.clone();
                for (i, v) in next[p].iter_mut().enumerate() {
                    *v *= ns.freq(i, a);
                }
                fill(game, strategies, child, next, reach);
            }
        }
    }
    let init = [
        game.combos[0].iter().map(|c| c.weight).collect::<Vec<f64>>(),
        game.combos[1].iter().map(|c| c.weight).collect::<Vec<f64>>(),
    ];
    let mut reach = vec![[Vec::new(), Vec::new()]; game.nodes.len()];
    fill(game, strategies, 0, init, &mut reach);
    reach
}

fn river_naive_cfv(
    game: &RiverGame,
    strategies: &[NodeStrategy],
    ranks: &[Vec<HandRank>; 2],
    node_id: usize,
    hero: Player,
    opp_reach: &[f64],
) -> Vec<f64> {
    let p = pidx(hero);
    let q = pidx(popp(hero));
    let my = &game.combos[p];
    let opp = &game.combos[q];
    match &game.nodes[node_id] {
        Node::Terminal(term) => {
            let mut out = vec![0.0f64; my.len()];
            match *term {
                TerminalNode::Fold { folder, committed } => {
                    let payoff = if folder == hero {
                        -committed[p]
                    } else {
                        game.starting_pot + committed[q]
                    };
                    for (i, mc) in my.iter().enumerate() {
                        let mut s = 0.0;
                        for (j, oc) in opp.iter().enumerate() {
                            if !mc.mask.overlaps(oc.mask) {
                                s += opp_reach[j];
                            }
                        }
                        out[i] = s * payoff;
                    }
                }
                TerminalNode::Showdown { committed } => {
                    for (i, mc) in my.iter().enumerate() {
                        let mut s = 0.0;
                        for (j, oc) in opp.iter().enumerate() {
                            if opp_reach[j] == 0.0 || mc.mask.overlaps(oc.mask) {
                                continue;
                            }
                            let u = match ranks[p][i].cmp(&ranks[q][j]) {
                                Ordering::Greater => game.starting_pot + committed[q],
                                Ordering::Equal => 0.5 * game.starting_pot,
                                Ordering::Less => -committed[p],
                            };
                            s += opp_reach[j] * u;
                        }
                        out[i] = s;
                    }
                }
            }
            out
        }
        Node::Decision(d) => {
            let ns = &strategies[d.decision_id];
            let mut out = vec![0.0f64; my.len()];
            if d.player == hero {
                for (a, &child) in d.children.iter().enumerate() {
                    let child_cfv =
                        river_naive_cfv(game, strategies, ranks, child, hero, opp_reach);
                    for i in 0..my.len() {
                        out[i] += ns.freq(i, a) * child_cfv[i];
                    }
                }
            } else {
                for (a, &child) in d.children.iter().enumerate() {
                    let next: Vec<f64> = (0..opp.len())
                        .map(|j| opp_reach[j] * ns.freq(j, a))
                        .collect();
                    let child_cfv =
                        river_naive_cfv(game, strategies, ranks, child, hero, &next);
                    for i in 0..my.len() {
                        out[i] += child_cfv[i];
                    }
                }
            }
            out
        }
    }
}

/// Naive per-action EVs for every river decision node: `[did][combo][action]`.
fn river_naive_action_evs(
    game: &RiverGame,
    strategies: &[NodeStrategy],
) -> Vec<Vec<Vec<f64>>> {
    let ranks = river_ranks(game);
    let reach = river_forward_reach(game, strategies);
    let mut out = Vec::with_capacity(game.num_decision_nodes());
    for did in 0..game.num_decision_nodes() {
        let d = game.decision_node(did);
        let p = d.player;
        let q = popp(p);
        let opp_reach = &reach[d.node_id][pidx(q)];
        let mut per_combo = Vec::with_capacity(game.combos[pidx(p)].len());
        for (i, mc) in game.combos[pidx(p)].iter().enumerate() {
            let z: f64 = game.combos[pidx(q)]
                .iter()
                .enumerate()
                .filter(|(_, oc)| !mc.mask.overlaps(oc.mask))
                .map(|(j, _)| opp_reach[j])
                .sum();
            let mut row = Vec::with_capacity(d.actions.len());
            for &child in &d.children {
                let cfv = river_naive_cfv(game, strategies, &ranks, child, p, opp_reach);
                row.push(if z > 0.0 { cfv[i] / z } else { 0.0 });
            }
            per_combo.push(row);
        }
        out.push(per_combo);
    }
    out
}

/// Naive root combo EVs for both players (checker anchor for the naive
/// evaluator itself).
fn river_naive_root_evs(game: &RiverGame, strategies: &[NodeStrategy]) -> [Vec<f64>; 2] {
    let ranks = river_ranks(game);
    let mut out: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
    for p in [Player::Oop, Player::Ip] {
        let q = popp(p);
        let opp_init: Vec<f64> = game.combos[pidx(q)].iter().map(|c| c.weight).collect();
        let cfv = river_naive_cfv(game, strategies, &ranks, 0, p, &opp_init);
        out[pidx(p)] = game.combos[pidx(p)]
            .iter()
            .enumerate()
            .map(|(i, mc)| {
                let z: f64 = game.combos[pidx(q)]
                    .iter()
                    .enumerate()
                    .filter(|(_, oc)| !mc.mask.overlaps(oc.mask))
                    .map(|(j, _)| opp_init[j])
                    .sum();
                if z > 0.0 {
                    cfv[i] / z
                } else {
                    0.0
                }
            })
            .collect();
    }
    out
}

// ============================================================================
// Naive turn evaluator.
// ============================================================================

fn turn_ranks(game: &TurnGame) -> Vec<[Vec<HandRank>; 2]> {
    let mut ranks = Vec::with_capacity(game.river_cards.len());
    for &rc in &game.river_cards {
        let board5 = [game.board[0], game.board[1], game.board[2], game.board[3], rc];
        let mut per_player: [Vec<HandRank>; 2] = [Vec::new(), Vec::new()];
        for p in 0..2 {
            per_player[p] = game.combos[p]
                .iter()
                .map(|c| {
                    if c.mask.contains(rc) {
                        HandRank(0)
                    } else {
                        eval_omaha(c.cards, board5)
                    }
                })
                .collect();
        }
        ranks.push(per_player);
    }
    ranks
}

fn turn_forward_reach(game: &TurnGame, strategies: &[NodeStrategy]) -> Vec<[Vec<f64>; 2]> {
    let init = [
        game.combos[0].iter().map(|c| c.weight).collect::<Vec<f64>>(),
        game.combos[1].iter().map(|c| c.weight).collect::<Vec<f64>>(),
    ];
    turn_forward_reach_from(game, strategies, init)
}

/// Forward reach propagation through a turn game from caller-supplied
/// root reaches (the standalone evaluator starts from the range
/// weights; the flop seam check starts from the flop-derived reach
/// mapped into the subtree). Chance nodes pass reach through
/// unchanged — deal probabilities multiply values, never reaches.
fn turn_forward_reach_from(
    game: &TurnGame,
    strategies: &[NodeStrategy],
    init: [Vec<f64>; 2],
) -> Vec<[Vec<f64>; 2]> {
    fn fill(
        game: &TurnGame,
        strategies: &[NodeStrategy],
        node_id: usize,
        cur: [Vec<f64>; 2],
        reach: &mut Vec<[Vec<f64>; 2]>,
    ) {
        reach[node_id] = cur.clone();
        match &game.nodes[node_id] {
            TurnNode::Decision(d) => {
                let ns = &strategies[d.decision_id];
                let p = pidx(d.player);
                for (a, &child) in d.children.iter().enumerate() {
                    let mut next = cur.clone();
                    for (i, v) in next[p].iter_mut().enumerate() {
                        *v *= ns.freq(i, a);
                    }
                    fill(game, strategies, child, next, reach);
                }
            }
            TurnNode::Chance(c) => {
                for &child in &c.children {
                    fill(game, strategies, child, cur.clone(), reach);
                }
            }
            TurnNode::Terminal(_) => {}
        }
    }
    let mut reach = vec![[Vec::new(), Vec::new()]; game.nodes.len()];
    fill(game, strategies, 0, init, &mut reach);
    reach
}

/// Forward reach propagation over the flop tree (combo-level
/// `strategies`, i.e. the expanded profile), returning the reach
/// entering each subtree group: the reach at the decision node whose
/// action closed the street, with the closing action's frequency
/// applied to the acting player's component. The turn-card deal is not
/// applied — deal probabilities multiply values, never reaches.
fn flop_group_entry_reach(game: &FlopGame, strategies: &[NodeStrategy]) -> Vec<[Vec<f64>; 2]> {
    fn fill(
        game: &FlopGame,
        strategies: &[NodeStrategy],
        node_id: usize,
        cur: [Vec<f64>; 2],
        groups: &mut [[Vec<f64>; 2]],
    ) {
        if let FlopNode::Decision(d) = &game.nodes[node_id] {
            let ns = &strategies[d.decision_id];
            let p = pidx(d.player);
            for (a, &child) in d.children.iter().enumerate() {
                let mut next = cur.clone();
                for (i, v) in next[p].iter_mut().enumerate() {
                    *v *= ns.freq(i, a);
                }
                match child {
                    FlopChild::Node(child_id) => fill(game, strategies, child_id, next, groups),
                    FlopChild::Subtrees(g) => groups[g] = next,
                }
            }
        }
    }
    let init = [
        game.combos[0].iter().map(|c| c.weight).collect::<Vec<f64>>(),
        game.combos[1].iter().map(|c| c.weight).collect::<Vec<f64>>(),
    ];
    let mut groups = vec![[Vec::new(), Vec::new()]; game.subtree_groups.len()];
    fill(game, strategies, 0, init, &mut groups);
    groups
}

/// The flop pass's normaliser `Z(i)` for one subtree record,
/// recomputed by forward reach propagation: the opponent reach mass
/// live at the record's node against combo `i` — opponent combos that
/// neither overlap combo `i` nor contain the node's river card. This
/// mirrors `reach_mass` in the pass exactly; the pass's `opp_reach`
/// inside a subtree starts from the flop reach mapped in, which is
/// what `sub_reach` propagates. `Z == 0` marks the records whose
/// conditional value is undefined (the pass records `0.0` there by
/// convention), which the seam comparison must exclude.
fn seam_z(
    sub_game: &TurnGame,
    sub_reach: &[[Vec<f64>; 2]],
    rec: &NodeActionEvs,
    combo_idx: usize,
) -> f64 {
    let d = sub_game.decision_node(rec.decision_id);
    let p = rec.player;
    let q = popp(p);
    let opp_reach = &sub_reach[d.node_id][pidx(q)];
    let my_mask = sub_game.combos[pidx(p)][combo_idx].mask;
    let mut z = 0.0f64;
    for (j, oc) in sub_game.combos[pidx(q)].iter().enumerate() {
        if opp_reach[j] == 0.0 || my_mask.overlaps(oc.mask) {
            continue;
        }
        if let Some(rc) = d.river_card {
            if oc.mask.contains(rc) {
                continue;
            }
        }
        z += opp_reach[j];
    }
    z
}

#[allow(clippy::too_many_arguments)]
fn turn_naive_cfv(
    game: &TurnGame,
    strategies: &[NodeStrategy],
    ranks: &[[Vec<HandRank>; 2]],
    node_id: usize,
    hero: Player,
    runout: Option<usize>,
    opp_reach: &[f64],
) -> Vec<f64> {
    let p = pidx(hero);
    let q = pidx(popp(hero));
    let my = &game.combos[p];
    let opp = &game.combos[q];
    match &game.nodes[node_id] {
        TurnNode::Terminal(term) => {
            let mut out = vec![0.0f64; my.len()];
            let river_card = runout.map(|r| game.river_cards[r]);
            match *term {
                TerminalNode::Fold { folder, committed } => {
                    let payoff = if folder == hero {
                        -committed[p]
                    } else {
                        game.starting_pot + committed[q]
                    };
                    for (i, mc) in my.iter().enumerate() {
                        if river_card.map(|rc| mc.mask.contains(rc)).unwrap_or(false) {
                            continue;
                        }
                        let mut s = 0.0;
                        for (j, oc) in opp.iter().enumerate() {
                            if river_card.map(|rc| oc.mask.contains(rc)).unwrap_or(false) {
                                continue;
                            }
                            if !mc.mask.overlaps(oc.mask) {
                                s += opp_reach[j];
                            }
                        }
                        out[i] = s * payoff;
                    }
                }
                TerminalNode::Showdown { committed } => {
                    let r = runout.expect("showdown under a chance node");
                    let rc = game.river_cards[r];
                    for (i, mc) in my.iter().enumerate() {
                        if mc.mask.contains(rc) {
                            continue;
                        }
                        let mut s = 0.0;
                        for (j, oc) in opp.iter().enumerate() {
                            if opp_reach[j] == 0.0
                                || oc.mask.contains(rc)
                                || mc.mask.overlaps(oc.mask)
                            {
                                continue;
                            }
                            let u = match ranks[r][p][i].cmp(&ranks[r][q][j]) {
                                Ordering::Greater => game.starting_pot + committed[q],
                                Ordering::Equal => 0.5 * game.starting_pot,
                                Ordering::Less => -committed[p],
                            };
                            s += opp_reach[j] * u;
                        }
                        out[i] = s;
                    }
                }
            }
            out
        }
        TurnNode::Chance(c) => {
            let mut out = vec![0.0f64; my.len()];
            for (r, &child) in c.children.iter().enumerate() {
                let child_cfv =
                    turn_naive_cfv(game, strategies, ranks, child, hero, Some(r), opp_reach);
                for i in 0..my.len() {
                    out[i] += RIVER_DEAL_PROB * child_cfv[i];
                }
            }
            out
        }
        TurnNode::Decision(d) => {
            let ns = &strategies[d.decision_id];
            let mut out = vec![0.0f64; my.len()];
            if d.player == hero {
                for (a, &child) in d.children.iter().enumerate() {
                    let child_cfv =
                        turn_naive_cfv(game, strategies, ranks, child, hero, runout, opp_reach);
                    for i in 0..my.len() {
                        out[i] += ns.freq(i, a) * child_cfv[i];
                    }
                }
            } else {
                for (a, &child) in d.children.iter().enumerate() {
                    let next: Vec<f64> = (0..opp.len())
                        .map(|j| opp_reach[j] * ns.freq(j, a))
                        .collect();
                    let child_cfv =
                        turn_naive_cfv(game, strategies, ranks, child, hero, runout, &next);
                    for i in 0..my.len() {
                        out[i] += child_cfv[i];
                    }
                }
            }
            out
        }
    }
}

/// Naive per-action EVs for every turn decision node: `[did][combo][action]`.
fn turn_naive_action_evs(game: &TurnGame, strategies: &[NodeStrategy]) -> Vec<Vec<Vec<f64>>> {
    let ranks = turn_ranks(game);
    let reach = turn_forward_reach(game, strategies);
    let mut out = Vec::with_capacity(game.num_decision_nodes());
    for did in 0..game.num_decision_nodes() {
        let d = game.decision_node(did);
        let p = d.player;
        let q = popp(p);
        let opp_reach = &reach[d.node_id][pidx(q)];
        let dead = d.river_card;
        let mut per_combo = Vec::with_capacity(game.combos[pidx(p)].len());
        for (i, mc) in game.combos[pidx(p)].iter().enumerate() {
            let z: f64 = game.combos[pidx(q)]
                .iter()
                .enumerate()
                .filter(|(_, oc)| {
                    !mc.mask.overlaps(oc.mask)
                        && !dead.map(|rc| oc.mask.contains(rc)).unwrap_or(false)
                })
                .map(|(j, _)| opp_reach[j])
                .sum();
            let mut row = Vec::with_capacity(d.actions.len());
            for &child in &d.children {
                let cfv = turn_naive_cfv(
                    game,
                    strategies,
                    &ranks,
                    child,
                    p,
                    d.runout,
                    opp_reach,
                );
                row.push(if z > 0.0 { cfv[i] / z } else { 0.0 });
            }
            per_combo.push(row);
        }
        out.push(per_combo);
    }
    out
}

fn turn_naive_root_evs(game: &TurnGame, strategies: &[NodeStrategy]) -> [Vec<f64>; 2] {
    let ranks = turn_ranks(game);
    let mut out: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
    for p in [Player::Oop, Player::Ip] {
        let q = popp(p);
        let opp_init: Vec<f64> = game.combos[pidx(q)].iter().map(|c| c.weight).collect();
        let cfv = turn_naive_cfv(game, strategies, &ranks, 0, p, None, &opp_init);
        out[pidx(p)] = game.combos[pidx(p)]
            .iter()
            .enumerate()
            .map(|(i, mc)| {
                let z: f64 = game.combos[pidx(q)]
                    .iter()
                    .enumerate()
                    .filter(|(_, oc)| !mc.mask.overlaps(oc.mask))
                    .map(|(j, _)| opp_init[j])
                    .sum();
                if z > 0.0 {
                    cfv[i] / z
                } else {
                    0.0
                }
            })
            .collect();
    }
    out
}

fn compare_with_naive(
    records: &[NodeActionEvs],
    naive: &[Vec<Vec<f64>>],
    ctx: &str,
) {
    assert_eq!(records.len(), naive.len(), "{ctx}: naive node count");
    for (rec, naive_node) in records.iter().zip(naive.iter()) {
        assert_eq!(rec.num_combos, naive_node.len(), "{ctx}: naive combo count");
        for (i, naive_row) in naive_node.iter().enumerate() {
            let row = rec.combo_action_evs(i);
            assert_eq!(row.len(), naive_row.len(), "{ctx}: naive action count");
            for (a, &expected) in naive_row.iter().enumerate() {
                assert_close(
                    row[a],
                    expected,
                    TOL,
                    &format!("{ctx}: naive mismatch at {} combo {i} action {a}", rec.history),
                );
            }
        }
    }
}

// ============================================================================
// Tests.
// ============================================================================

#[test]
fn river_action_evs_match_naive_and_checker() {
    let game = river_test_game();
    let res = solve_river(&game, &fast_cfg());

    check_identities(&res.strategies, &res.action_evs, "river");
    check_root_identity(&res.action_evs, &res.oop_evs, "river");

    // The naive evaluator is anchored to the checker for BOTH players…
    let naive_root = river_naive_root_evs(&game, &res.strategies);
    for (i, ce) in res.oop_evs.iter().enumerate() {
        assert_close(naive_root[0][i], ce.ev, TOL, "river naive root OOP");
    }
    for (i, ce) in res.ip_evs.iter().enumerate() {
        assert_close(naive_root[1][i], ce.ev, TOL, "river naive root IP");
    }
    // …and then compared against the pass at every node.
    let naive = river_naive_action_evs(&game, &res.strategies);
    compare_with_naive(&res.action_evs, &naive, "river");
}

#[test]
fn river_action_evs_price_locked_profile() {
    let game = river_test_game();
    let root_actions = game.decision_node(0).actions.len();
    let mut lock_freqs = vec![0.0; root_actions];
    lock_freqs[0] = 1.0; // pure check (first root action)
    let cfg = DcfrConfig {
        locks: vec![NodeLock {
            history: "root".to_string(),
            player: Player::Oop,
            frequencies: lock_freqs.clone(),
        }],
        ..fast_cfg()
    };
    let res = solve_river(&game, &cfg);
    assert_eq!(res.locks.len(), 1, "the lock must be engaged");

    // The root strategy IS the lock…
    let root_strat = &res.strategies[0];
    for i in 0..root_strat.num_combos {
        for (a, &f) in root_strat.combo_strategy(i).iter().enumerate() {
            assert_close(f, lock_freqs[a], TOL, "locked root strategy");
        }
    }
    // …and the pass prices that locked profile: identities hold against
    // the checker's locked-profile EVs, and each root combo's node value
    // is exactly its check-action EV.
    check_identities(&res.strategies, &res.action_evs, "river-locked");
    check_root_identity(&res.action_evs, &res.oop_evs, "river-locked");
    let root = &res.action_evs[0];
    for i in 0..root.num_combos {
        assert_close(
            root.node_evs[i],
            root.action_ev(i, 0),
            IDENTITY_TOL,
            "locked root node value = check EV",
        );
    }
}

#[test]
fn turn_action_evs_match_naive_and_checker() {
    let game = turn_test_game();
    let res = solve_turn(&game, &fast_cfg());

    check_identities(&res.strategies, &res.action_evs, "turn");
    check_root_identity(&res.action_evs, &res.oop_evs, "turn");

    let naive_root = turn_naive_root_evs(&game, &res.strategies);
    for (i, ce) in res.oop_evs.iter().enumerate() {
        assert_close(naive_root[0][i], ce.ev, TOL, "turn naive root OOP");
    }
    for (i, ce) in res.ip_evs.iter().enumerate() {
        assert_close(naive_root[1][i], ce.ev, TOL, "turn naive root IP");
    }
    let naive = turn_naive_action_evs(&game, &res.strategies);
    compare_with_naive(&res.action_evs, &naive, "turn");
}

#[test]
fn flop_action_evs_identities_and_subtree_consistency() {
    // The small exact-bucket spot from the flop validation suite.
    let spot_json = r#"{
        "board": "9c 8d 3h",
        "oop_range": ["As Ah Kd Qc:1.0", "Ts Js Qh Kh:1.0", "7s 6s 5d 4d:1.0"],
        "ip_range": ["Ks Kh Qd Jc:1.0", "Th Jh Qs Ks:1.0", "7h 6h 5s 4s:1.0"],
        "pot": 100.0,
        "stacks": 150.0,
        "flop_bet_sizes": [0.75],
        "turn_bet_sizes": [0.75],
        "river_bet_sizes": [0.75],
        "flop_raise_sizes": [],
        "turn_raise_sizes": [],
        "river_raise_sizes": [],
        "include_all_in": false,
        "max_iterations": 20,
        "target_exploitability_pct": 0.0
    }"#;
    let (spot, dcfr_cfg) = parse_flop_spot_json(spot_json).unwrap();
    let game = FlopGame::new(spot).unwrap();
    let res = solve_flop(&game, &dcfr_cfg);

    // Flop street: records are combo-level, so identities run against the
    // expanded profile (the same expansion the checker evaluates).
    let expanded = expand_bucket_strategies(&game, &res.flop_strategies);
    assert_eq!(res.action_evs.flop.len(), expanded.len());
    check_identities(&expanded, &res.action_evs.flop, "flop");
    check_root_identity(&res.action_evs.flop, &res.oop_evs, "flop");

    // Subtrees: identities, plus the seam cross-check — every subtree
    // record equals the standalone turn pass on that subtree game shifted
    // by the subtree's flop commitment. The comparison is restricted to
    // records with flop-profile `Z(i) > SEAM_Z_MIN`: at `Z == 0` the
    // conditional value is undefined, both passes record `0.0` by
    // convention, and `0.0 != 0.0 - committed` would indict the seam for
    // a convention (gate finding, EV-OUTPUT-NOTES.md). The per-node
    // identities above are NOT restricted — they hold for convention
    // zeros too (`sum_a freq * 0 == 0`).
    assert_eq!(res.action_evs.subtrees.len(), res.subtree_strategies.len());
    let group_reach = flop_group_entry_reach(&game, &expanded);
    let mut group_of = vec![usize::MAX; game.subtrees.len()];
    for (g, group) in game.subtree_groups.iter().enumerate() {
        for &k in &group.subtrees {
            group_of[k] = g;
        }
    }
    let mut seam_compared = 0usize;
    let mut seam_shifted_compared = 0usize;
    let mut seam_excluded = 0usize;
    for (k, sub) in game.subtrees.iter().enumerate() {
        let Some(sub_game) = &sub.game else {
            assert!(res.action_evs.subtrees[k].is_empty(), "dead subtree {k} has no records");
            continue;
        };
        let records = &res.action_evs.subtrees[k];
        check_identities(&res.subtree_strategies[k], records, "flop-subtree");
        let standalone = compute_action_evs_turn(sub_game, &res.subtree_strategies[k]);
        assert_eq!(records.len(), standalone.len(), "subtree {k} record count");
        // Propagate this subtree's reach from the flop profile: group
        // entry reach, mapped through the subtree's combo maps.
        let entry = &group_reach[group_of[k]];
        let mut init: [Vec<f64>; 2] = [Vec::new(), Vec::new()];
        for p in [Player::Oop, Player::Ip] {
            let mut v = vec![0.0f64; sub_game.combos[pidx(p)].len()];
            for (j, m) in sub.map_for(p).iter().enumerate() {
                if let Some(sj) = m {
                    v[*sj] = entry[pidx(p)][j];
                }
            }
            init[pidx(p)] = v;
        }
        let sub_reach = turn_forward_reach_from(sub_game, &res.subtree_strategies[k], init);
        for (rec, solo) in records.iter().zip(standalone.iter()) {
            assert_eq!(rec.decision_id, solo.decision_id);
            for i in 0..rec.num_combos {
                if seam_z(sub_game, &sub_reach, rec, i) <= SEAM_Z_MIN {
                    seam_excluded += 1;
                    continue;
                }
                seam_compared += 1;
                if sub.committed != 0.0 {
                    seam_shifted_compared += 1;
                }
                assert_close(
                    rec.node_evs[i],
                    solo.node_evs[i] - sub.committed,
                    TOL,
                    &format!("subtree {k} seam shift at {} combo {i}", rec.history),
                );
                for a in 0..rec.actions.len() {
                    assert_close(
                        rec.action_ev(i, a),
                        solo.action_ev(i, a) - sub.committed,
                        TOL,
                        &format!("subtree {k} seam shift at {} combo {i} action {a}", rec.history),
                    );
                }
            }
        }
    }
    // Non-vacuity witnesses: the restricted comparison must actually
    // cover a substantial record set, including records where the seam
    // shift is nonzero (a shift of 0 would let a missing correction
    // pass unnoticed). The exclusion must also have engaged at least
    // once — the gate-finding record (subtree 58, `X/X|r:4d/X`,
    // Ks Kh Qd Jc) is a `Z == 0` record by construction.
    assert!(
        seam_compared >= MIN_SEAM_COMPARED,
        "seam cross-check compared only {seam_compared} records with Z > {SEAM_Z_MIN} \
         (minimum {MIN_SEAM_COMPARED}); the check must not pass vacuously"
    );
    assert!(
        seam_shifted_compared >= MIN_SEAM_SHIFTED_COMPARED,
        "seam cross-check compared only {seam_shifted_compared} records in \
         nonzero-commitment subtrees (minimum {MIN_SEAM_SHIFTED_COMPARED})"
    );
    assert!(
        seam_excluded >= 1,
        "seam cross-check excluded no Z == 0 records; the domain restriction did not engage"
    );

    // Payload: the formatted flop output parses, and every emitted node
    // (flop street + all subtrees) carries combo_action_evs with one row
    // per strategy row and one value per action.
    let json = format_flop_solve_result_json(&game, &res);
    let parsed = JsonValue::parse(&json).unwrap();
    let nodes = parsed.get("nodes").unwrap().as_array().unwrap();
    let expected_nodes = game.num_decision_nodes()
        + game
            .subtrees
            .iter()
            .filter_map(|s| s.game.as_ref())
            .map(|g| g.num_decision_nodes())
            .sum::<usize>();
    assert_eq!(nodes.len(), expected_nodes, "flop payload node count");
    for node in nodes {
        let history = node.get("history").unwrap().as_str().unwrap();
        let strat_rows = match node.get("strategy").unwrap() {
            JsonValue::Object(entries) => entries.len(),
            _ => panic!("flop payload: strategy must be an object at {history}"),
        };
        let ev_rows = match node
            .get("combo_action_evs")
            .unwrap_or_else(|| panic!("flop payload: missing combo_action_evs at {history}"))
        {
            JsonValue::Object(entries) => entries,
            _ => panic!("flop payload: combo_action_evs must be an object at {history}"),
        };
        assert_eq!(ev_rows.len(), strat_rows, "flop payload rows at {history}");
        let n_actions = node.get("actions").unwrap().as_array().unwrap().len();
        for (_, row) in ev_rows {
            assert_eq!(
                row.as_array().unwrap().len(),
                n_actions,
                "flop payload row length at {history}"
            );
        }
    }
}

/// Payload shape (brief item d, forward direction): every node of every
/// game's formatted output carries `combo_action_evs` aligned with its
/// `strategy` rows and `actions`; the root's serialized values match the
/// engine records within the 3-decimal rounding.
fn check_payload_nodes(json: &str, records: &[NodeActionEvs], ctx: &str) {
    let parsed = JsonValue::parse(json).unwrap();
    let nodes = parsed.get("nodes").unwrap().as_array().unwrap();
    assert_eq!(nodes.len(), records.len(), "{ctx}: payload node count");
    for (node, rec) in nodes.iter().zip(records.iter()) {
        let strategy_obj = node.get("strategy").unwrap();
        let evs_obj = node
            .get("combo_action_evs")
            .unwrap_or_else(|| panic!("{ctx}: node {} missing combo_action_evs", rec.history));
        let actions = node.get("actions").unwrap().as_array().unwrap();
        assert_eq!(actions.len(), rec.actions.len(), "{ctx}: payload actions");
        // Row-for-row alignment with the strategy map.
        let strat_map = match strategy_obj {
            JsonValue::Object(entries) => entries,
            _ => panic!("{ctx}: strategy must be an object"),
        };
        let ev_map = match evs_obj {
            JsonValue::Object(entries) => entries,
            _ => panic!("{ctx}: combo_action_evs must be an object"),
        };
        assert_eq!(strat_map.len(), ev_map.len(), "{ctx}: row count at {}", rec.history);
        for ((s_key, _), (e_key, e_row)) in strat_map.iter().zip(ev_map.iter()) {
            assert_eq!(s_key, e_key, "{ctx}: row key alignment at {}", rec.history);
            let row = e_row.as_array().unwrap();
            assert_eq!(row.len(), actions.len(), "{ctx}: row length at {}", rec.history);
            assert!(
                row.iter().all(|v| v.as_f64().map(|x| x.is_finite()).unwrap_or(false)),
                "{ctx}: finite serialized EVs at {}",
                rec.history
            );
        }
    }
    // Root values survive serialization within rounding.
    let root_node = &nodes[0];
    let rec = &records[0];
    let ev_map = match root_node.get("combo_action_evs").unwrap() {
        JsonValue::Object(entries) => entries,
        _ => unreachable!(),
    };
    for (i, (_key, row_val)) in ev_map.iter().enumerate() {
        let row = row_val.as_array().unwrap();
        for (a, v) in row.iter().enumerate() {
            assert_close(
                v.as_f64().unwrap(),
                rec.action_ev(i, a),
                ROUND_TOL,
                &format!("{ctx}: serialized root EV combo {i} action {a}"),
            );
        }
    }
}

#[test]
fn action_ev_payload_shape_and_legacy_compat() {
    // River payload.
    let game = river_test_game();
    let res = solve_river(&game, &fast_cfg());
    let json = format_solve_result_json(&game, &res);
    check_payload_nodes(&json, &res.action_evs, "river-payload");

    // Turn payload (records are already in output order).
    let tgame = turn_test_game();
    let tres = solve_turn(&tgame, &fast_cfg());
    let tjson = format_turn_solve_result_json(&tgame, &tres);
    check_payload_nodes(&tjson, &tres.action_evs, "turn-payload");

    // Legacy payload (brief item d, backward direction): the pre-#8 node
    // shape has no `combo_action_evs`; it must still parse, with the
    // field simply absent — the state consumers treat as "not available".
    let legacy = r#"{
      "board": "Kd Qd 9c 6s 2h",
      "starting_pot": 100.000000,
      "effective_stack": 150.000000,
      "iterations": 300,
      "locked": false,
      "locks": [],
      "oop_evs": [{"combo": "As Ac 3h 4h", "weight": 1.000000, "ev": 12.345678}],
      "ip_evs": [],
      "nodes": [
        {
          "decision_id": 0,
          "node_id": 0,
          "player": "oop",
          "history": "root",
          "pot": 100.000000,
          "to_call": 0.000000,
          "actions": ["check", "bet"],
          "strategy": {
            "As Ac 3h 4h": [0.500000, 0.500000]
          }
        }
      ]
    }"#;
    let parsed = JsonValue::parse(legacy).unwrap();
    let nodes = parsed.get("nodes").unwrap().as_array().unwrap();
    assert_eq!(nodes.len(), 1);
    assert!(nodes[0].get("strategy").is_some(), "legacy strategy present");
    assert!(
        nodes[0].get("combo_action_evs").is_none(),
        "legacy payload: combo_action_evs absent (not available), not an error"
    );

    // The bundled sample solve (ui/public/sample-river-solve.json) is a
    // legacy payload too; its exact bytes are covered by the UI, and the
    // shape above is byte-faithful to the pre-#8 formatter's node shape.
}
