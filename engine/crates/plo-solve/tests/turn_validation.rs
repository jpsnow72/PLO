//! Validation test suite for the turn solver (Ticket E3):
//! 1. Card-removal correctness: a combo containing the river card has exactly zero
//!    weight on that runout; every disjoint pair has exactly 40 dealable river cards.
//! 2. Degenerate turn spot: one range holds the nuts on every runout (royal-flush
//!    structure) and must win the whole pot with near-zero exploitability.
//! 3. Turn-vs-river consistency: with turn betting disabled (forced check-check), the
//!    river subtrees of the turn solve must reproduce a direct E2 river solve of the
//!    same 5-card spot, for at least 3 different river cards. (Release only: the
//!    two-street solve is too slow in debug.)
//! 4/5. Two non-trivial turn convergence spots (wet/connected and paired boards,
//!    120 combos/player) solved to <= 0.3% pot by the independent checker, each in
//!    under 10 minutes. (Release only, marked with `#[cfg(not(debug_assertions))]`
//!    because debug-mode wall time for ~48-runout trees is impractical; the light
//!    tests above still run in debug.)
//! 6. JSON roundtrip for `solve-turn`: strategies sum to 1 at every node and river
//!    nodes are keyed by their river card.

use std::collections::HashMap;
use std::time::Instant;

use plo_cards::{Card, HandMask};
use plo_eval::{DeterministicRng, PloRange};
use plo_solve::{
    compute_exploitability_turn, format_turn_solve_result_json, parse_turn_spot_json, solve_river,
    solve_turn, DcfrConfig, JsonValue, Player, RiverGame, RiverSpot, Street, TreeConfig, TurnGame,
    TurnSpot,
};

/// Deterministically samples `count` distinct 4-card combos from the 48 cards not on
/// the 4-card `board`, with weights in {0.25, 0.50, 0.75, 1.00}.
fn generate_deterministic_range4(board: [Card; 4], count: usize, seed: u64) -> PloRange {
    let board_mask = HandMask::from_cards(&board);
    let mut deck: Vec<Card> = (HandMask::FULL_DECK - board_mask).iter().collect();
    let mut rng = DeterministicRng::from_seed(seed);
    let mut seen_masks = Vec::with_capacity(count);
    let mut range = PloRange::new();

    while range.len() < count {
        let drawn = rng.sample_cards(&mut deck, 4);
        let cards = [drawn[0], drawn[1], drawn[2], drawn[3]];
        let mask = HandMask::from_cards(&cards);
        if seen_masks.contains(&mask) {
            continue;
        }
        seen_masks.push(mask);
        let w = (((rng.next_u64() % 4) as usize + 1) as f64) * 0.25;
        range.push(cards, w).unwrap();
    }
    range
}

/// Small betting menu used by the light tests: check / pot bet / fold / call only.
fn reduced_config() -> TreeConfig {
    TreeConfig {
        bet_sizes: vec![1.0],
        include_all_in_bet: false,
        raise_sizes: vec![],
        include_all_in_raise: false,
        max_raises: 0,
    }
}

#[test]
fn test_turn_card_removal_exact_weights() {
    let board = Card::parse_n::<4>("As Ks Qs 7d").unwrap();
    let oop_range = PloRange::from_str_specs(&[
        ("Kc 9c 3d 4d", 1.0), // contains Kc
        ("Ah Ad 5h 6h", 0.7),
        ("Ts 9s 8c 9d", 1.0),
    ])
    .unwrap();
    let ip_range = PloRange::from_str_specs(&[("Jh Th 8h 9h", 1.0), ("2c 3c 4h 5d", 0.5)]).unwrap();

    let game = TurnGame::new(TurnSpot {
        board,
        oop_range,
        ip_range,
        starting_pot: 100.0,
        effective_stack: 100.0,
        turn_config: reduced_config(),
        river_config: reduced_config(),
    })
    .unwrap();

    // 48 possible river cards, each exactly once, none on the board.
    assert_eq!(game.river_cards.len(), 48);
    let mut seen = std::collections::HashSet::new();
    for &rc in &game.river_cards {
        assert!(seen.insert(rc.id()));
        assert!(!game.board_mask.contains(rc));
    }

    let kc = Card::parse_n::<1>("Kc").unwrap()[0];
    let kc_runout = game
        .river_cards
        .iter()
        .position(|&c| c == kc)
        .expect("Kc must be a possible river card");

    // OOP combo 0 ("Kc 9c 3d 4d") has exactly zero weight on the runouts of its own
    // four cards (Kc, 9c, 3d, 4d) and its full weight on the other 44 runouts.
    let combo0_mask = game.combos[0][0].mask;
    let mut positive_runouts = 0;
    for r in 0..game.river_cards.len() {
        let w = game.river_combo_weight(r, Player::Oop, 0);
        if combo0_mask.contains(game.river_cards[r]) {
            assert_eq!(w, 0.0, "combo containing the river card must have weight 0");
        } else {
            assert_eq!(w, 1.0);
            positive_runouts += 1;
        }
    }
    assert_eq!(positive_runouts, 44);
    assert_eq!(game.river_combo_weight(kc_runout, Player::Oop, 0), 0.0);

    // A combo not containing Kc keeps its weight on the Kc runout.
    assert_eq!(game.river_combo_weight(kc_runout, Player::Oop, 1), 0.7);

    // Every disjoint (OOP, IP) pair has exactly 40 dealable river cards.
    for i in 0..game.combos[0].len() {
        for j in 0..game.combos[1].len() {
            if !game.combos[0][i].mask.overlaps(game.combos[1][j].mask) {
                assert_eq!(game.pair_runout_count(i, j), 40);
            }
        }
    }
}

#[test]
fn test_turn_degenerate_all_nuts_every_runout() {
    // Board As Ks Qs 2d. Every OOP combo holds Ts Js, so on EVERY river card OOP's
    // best hand is the royal flush (Ts Js + As Ks Qs, exactly 2 hole + 3 board).
    // IP can never win or tie (a royal needs Ts and Js, both blocked by OOP's combos).
    // Equilibrium: OOP wins the entire starting pot; IP's best response is to fold
    // everything; exploitability must be near zero.
    let board = Card::parse_n::<4>("As Ks Qs 2d").unwrap();
    let oop_range = PloRange::from_str_specs(&[
        ("Ts Js 3c 4c", 1.0),
        ("Ts Js 5h 6h", 1.0),
        ("Ts Js 8c 9d", 1.0),
    ])
    .unwrap();
    let ip_range = PloRange::from_str_specs(&[
        ("9s 8s 3d 4d", 1.0),
        ("Ah Ad Kh Kd", 1.0),
        ("7h 7s 2h 2c", 1.0),
    ])
    .unwrap();

    let game = TurnGame::new(TurnSpot {
        board,
        oop_range,
        ip_range,
        starting_pot: 100.0,
        effective_stack: 100.0,
        turn_config: reduced_config(),
        river_config: reduced_config(),
    })
    .unwrap();

    let res = solve_turn(
        &game,
        &DcfrConfig {
            max_iterations: 800,
            target_exploitability_pct: 0.02,
            check_interval: 25,
            ..DcfrConfig::default()
        },
    );

    assert!(
        res.exploitability.nash_distance_pct <= 0.05,
        "all-nuts turn spot must solve to near-zero exploitability, got {:.6}%",
        res.exploitability.nash_distance_pct
    );
    assert!(
        (res.oop_game_ev - 100.0).abs() < 0.75,
        "OOP must win the whole pot, got OOP EV {}",
        res.oop_game_ev
    );
    assert!(
        res.ip_game_ev.abs() < 0.75,
        "IP must net zero by folding, got IP EV {}",
        res.ip_game_ev
    );
}

#[cfg(not(debug_assertions))]
#[test]
fn test_turn_vs_river_consistency_forced_checkdown() {
    // Turn betting disabled -> the turn is a forced check-check, so each river
    // subtree of the turn game is exactly the E2 river game on board + river card
    // with the same ranges, pot and stacks. The solved river strategies from both
    // solvers must agree closely.
    let board4 = Card::parse_n::<4>("As Ks Qs 7d").unwrap();
    let oop_range = generate_deterministic_range4(board4, 40, 0x2026_E300_0000_0001);
    let ip_range = generate_deterministic_range4(board4, 40, 0x2026_E300_0000_0002);

    let no_bet_config = TreeConfig {
        bet_sizes: vec![],
        include_all_in_bet: false,
        raise_sizes: vec![],
        include_all_in_raise: false,
        max_raises: 0,
    };

    let turn_game = TurnGame::new(TurnSpot {
        board: board4,
        oop_range: oop_range.clone(),
        ip_range: ip_range.clone(),
        starting_pot: 100.0,
        effective_stack: 100.0,
        turn_config: no_bet_config,
        river_config: TreeConfig::default(),
    })
    .unwrap();

    let turn_res = solve_turn(
        &turn_game,
        &DcfrConfig {
            max_iterations: 30000,
            target_exploitability_pct: 0.0,
            check_interval: 0,
            ..DcfrConfig::default()
        },
    );
    assert!(turn_res.exploitability.nash_distance_pct <= 0.5);

    // Index turn river strategies by (runout, action-sequence key).
    // Turn history: "X/X|r:2c" (river root, key ""), "X/X|r:2c/X" (key "X"),
    // "X/X|r:2c/B(75)" (key "B(75)"), ... River-game histories use the same tokens
    // with "root" for the empty sequence.
    let turn_key = |history: &str| -> String {
        let after = history.split('|').nth(1).expect("river node history has |r:");
        // after = "r:2c" or "r:2c/X/B(75)"
        let mut parts = after.splitn(2, '/');
        let _card_token = parts.next();
        parts.next().unwrap_or("").to_string()
    };

    let mut checked_runouts = 0usize;
    let mut max_delta = 0.0f64;

    for river_card_str in ["2c", "Jh", "9s"] {
        let rc = Card::parse_n::<1>(river_card_str).unwrap()[0];
        let r_idx = turn_game
            .river_cards
            .iter()
            .position(|&c| c == rc)
            .expect("river card must be dealable");

        let board5 = [board4[0], board4[1], board4[2], board4[3], rc];
        let river_game = RiverGame::new(RiverSpot {
            board: board5,
            oop_range: oop_range.clone(),
            ip_range: ip_range.clone(),
            starting_pot: 100.0,
            effective_stack: 100.0,
            tree_config: TreeConfig::default(),
        })
        .unwrap();
        let river_res = solve_river(
            &river_game,
            &DcfrConfig {
                max_iterations: 50000,
                target_exploitability_pct: 0.0,
                check_interval: 0,
                ..DcfrConfig::default()
            },
        );
        assert!(river_res.exploitability.nash_distance_pct <= 0.1);

        // River-game strategies by action-sequence key.
        let mut river_by_key: HashMap<String, usize> = HashMap::new();
        for ns in &river_res.strategies {
            let d = river_game.decision_node(ns.decision_id);
            let key = if d.history == "root" {
                String::new()
            } else {
                d.history.clone()
            };
            river_by_key.insert(key, ns.decision_id);
        }

        // Combo index mappings between the two games, per player, by mask.
        let mut river_idx_by_mask: [HashMap<u64, usize>; 2] = [HashMap::new(), HashMap::new()];
        let mut turn_idx_by_mask: [HashMap<u64, usize>; 2] = [HashMap::new(), HashMap::new()];
        for p in 0..2 {
            for (ri, c) in river_game.combos[p].iter().enumerate() {
                river_idx_by_mask[p].insert(c.mask.bits(), ri);
            }
            for (ti, c) in turn_game.combos[p].iter().enumerate() {
                turn_idx_by_mask[p].insert(c.mask.bits(), ti);
            }
        }

        // Turn river strategies for this runout, by action-sequence key.
        let mut turn_by_key: HashMap<String, usize> = HashMap::new();
        for ns in &turn_res.strategies {
            let d = turn_game.decision_node(ns.decision_id);
            if d.street == Street::River && d.runout == Some(r_idx) {
                turn_by_key.insert(turn_key(&d.history), ns.decision_id);
            }
        }

        // (a) Value consistency: transplant the turn solve's river strategies into
        // the river game (remapping combo and action indices) and measure their
        // exploitability with the E2 checker. If the two solvers agree on the
        // subgame, the transplanted profile must be near-equilibrium there too.
        // (Value-based, so indifferent-action frequency splits don't false-fail.)
        let mut transplanted: Vec<plo_solve::NodeStrategy> =
            Vec::with_capacity(river_game.num_decision_nodes());
        let mut matched_nodes = 0usize;
        for river_ns in &river_res.strategies {
            let d = river_game.decision_node(river_ns.decision_id);
            let key = if d.history == "root" {
                String::new()
            } else {
                d.history.clone()
            };
            let turn_did = turn_by_key
                .get(&key)
                .unwrap_or_else(|| panic!("no turn river node for key '{key}'"));
            let turn_ns = &turn_res.strategies[*turn_did];
            assert_eq!(turn_ns.player, river_ns.player);
            let p = river_ns.player.index();
            let num_river_actions = river_ns.actions.len();
            let mut frequencies =
                vec![0.0f64; num_river_actions * river_game.combos[p].len()];
            for (ri, rc) in river_game.combos[p].iter().enumerate() {
                let ti = turn_idx_by_mask[p][&rc.mask.bits()];
                for (ra, ract) in river_ns.actions.iter().enumerate() {
                    let ta = turn_ns
                        .actions
                        .iter()
                        .position(|a| a.label() == ract.label())
                        .unwrap_or_else(|| panic!("action {} missing in turn node", ract.label()));
                    frequencies[ri * num_river_actions + ra] = turn_ns.freq(ti, ta);
                }
            }
            transplanted.push(plo_solve::NodeStrategy {
                decision_id: river_ns.decision_id,
                node_id: river_ns.node_id,
                player: river_ns.player,
                history: river_ns.history.clone(),
                actions: river_ns.actions.clone(),
                num_combos: river_game.combos[p].len(),
                frequencies,
            });
            matched_nodes += 1;
        }
        assert!(
            matched_nodes >= 10,
            "expected at least 10 matched river nodes per runout, got {matched_nodes}"
        );
        let transplant_report = plo_solve::compute_exploitability(&river_game, &transplanted);
        assert!(
            transplant_report.nash_distance_pct <= 0.35,
            "turn-solve river strategies transplanted into the river game on runout \
             {river_card_str} must be near-equilibrium there, got Nash {:.4}%",
            transplant_report.nash_distance_pct
        );

        // (b) Frequency consistency at the river root (the most-visited and
        // best-converged node of the subgame).
        let turn_root = &turn_res.strategies[turn_by_key[""]];
        let river_root = &river_res.strategies[river_by_key[""]];
        let p = 0usize; // river root is OOP's decision
        assert_eq!(turn_root.player, Player::Oop);
        for (ri, rc) in river_game.combos[p].iter().enumerate() {
            let ti = turn_idx_by_mask[p][&rc.mask.bits()];
            for (ra, ract) in river_root.actions.iter().enumerate() {
                let ta = turn_root
                    .actions
                    .iter()
                    .position(|a| a.label() == ract.label())
                    .expect("root action missing in turn node");
                let delta = (turn_root.freq(ti, ta) - river_root.freq(ri, ra)).abs();
                if delta > max_delta {
                    max_delta = delta;
                }
                assert!(
                    delta < 0.08,
                    "river root strategy mismatch on runout {river_card_str} action {}: turn={:.4} river={:.4}",
                    ract.label(),
                    turn_root.freq(ti, ta),
                    river_root.freq(ri, ra)
                );
            }
        }
        let _ = river_idx_by_mask;
        checked_runouts += 1;
    }

    assert_eq!(checked_runouts, 3);
    println!(
        "[turn-vs-river consistency] 3 runouts checked, max strategy delta = {max_delta:.4}"
    );
}

/// Turn spot menus for the convergence tests: turn has a pot-sized raise available;
/// river betting is check / 75% pot / all-in with calls and folds (no river raises,
/// to keep the 48-runout tree inside the time guardrail at 120 combos/player).
fn convergence_turn_config() -> TreeConfig {
    TreeConfig {
        bet_sizes: vec![0.75],
        include_all_in_bet: true,
        raise_sizes: vec![1.0],
        include_all_in_raise: true,
        max_raises: 1,
    }
}

fn convergence_river_config() -> TreeConfig {
    TreeConfig {
        bet_sizes: vec![0.75],
        include_all_in_bet: true,
        raise_sizes: vec![],
        include_all_in_raise: false,
        max_raises: 0,
    }
}

fn run_turn_convergence_spot(
    name: &str,
    board_str: &str,
    seed_oop: u64,
    seed_ip: u64,
) -> (f64, usize, f64, usize, usize, usize, usize, f64) {
    let board = Card::parse_n::<4>(board_str).unwrap();
    let oop_range = generate_deterministic_range4(board, 120, seed_oop);
    let ip_range = generate_deterministic_range4(board, 120, seed_ip);

    let game = TurnGame::new(TurnSpot {
        board,
        oop_range,
        ip_range,
        starting_pot: 100.0,
        effective_stack: 100.0,
        turn_config: convergence_turn_config(),
        river_config: convergence_river_config(),
    })
    .unwrap();

    // Peak-memory estimate: 3 f64 buffers (regrets + cumulative + current strategy)
    // per (decision node, combo, action), plus per-runout kernels for both players
    // (offsets 16B/combo + ~4B per unblocked pair entry).
    let buffer_floats: usize = (0..game.num_decision_nodes())
        .map(|did| {
            let d = game.decision_node(did);
            d.actions.len() * game.player_combos(d.player).len()
        })
        .sum();
    let kernel_bytes = 2 * (game.river_cards.len() + 1) * (120 * 16 + 120 * 120 * 4);
    let peak_mem_mb = (3 * buffer_floats * 8 + kernel_bytes) as f64 / 1_000_000.0;

    let start = Instant::now();
    let result = solve_turn(
        &game,
        &DcfrConfig {
            max_iterations: 6000,
            target_exploitability_pct: 0.25,
            check_interval: 250,
            ..DcfrConfig::default()
        },
    );
    let elapsed = start.elapsed().as_secs_f64();

    // Independent verification via the checker in br.rs.
    let independent_check = compute_exploitability_turn(&game, &result.strategies);
    assert!(
        (independent_check.nash_distance_pct - result.exploitability.nash_distance_pct).abs()
            < 1e-9
    );

    println!(
        "[{name}] iters={} | wall_time={:.1}s | checker NashDistance={:.4}% pot | \
         nodes={} decision_nodes={} chance_nodes={} infosets={} | peak_mem_est={:.0} MB",
        result.iterations,
        elapsed,
        independent_check.nash_distance_pct,
        game.num_nodes(),
        game.num_decision_nodes(),
        game.num_chance_nodes(),
        game.num_infosets(),
        peak_mem_mb,
    );

    assert!(
        independent_check.nash_distance_pct <= 0.3,
        "{name} Nash Distance must be <= 0.3% of pot, got {:.4}%",
        independent_check.nash_distance_pct
    );
    assert!(
        elapsed < 600.0,
        "{name} must solve in under 10 minutes, took {elapsed:.1}s"
    );

    (
        independent_check.nash_distance_pct,
        result.iterations,
        elapsed,
        game.num_nodes(),
        game.num_decision_nodes(),
        game.num_chance_nodes(),
        game.num_infosets(),
        peak_mem_mb,
    )
}

#[cfg(not(debug_assertions))]
#[test]
fn test_turn_convergence_spot1_wet_board() {
    // Wet/connected turn board: Ts 9s 8h 7d (straight + flush draws everywhere).
    run_turn_convergence_spot(
        "Turn Spot 1 — Wet Board Ts 9s 8h 7d (120x120 combos)",
        "Ts 9s 8h 7d",
        0x2026_E301_AAAA_0001,
        0x2026_E301_AAAA_0002,
    );
}

#[cfg(not(debug_assertions))]
#[test]
fn test_turn_convergence_spot2_paired_board() {
    // Paired turn board: Kh Kd 7c 2s.
    run_turn_convergence_spot(
        "Turn Spot 2 — Paired Board Kh Kd 7c 2s (120x120 combos)",
        "Kh Kd 7c 2s",
        0x2026_E302_BBBB_0001,
        0x2026_E302_BBBB_0002,
    );
}

#[test]
fn test_turn_json_roundtrip_and_strategy_frequencies_sum_to_one() {
    let spot_json = r#"{
        "board": "As Ks Qs 7d",
        "oop_range": ["Ts 9s 3c 4c:1.0", "Jd Td 8h 9h:1.0", "3d 4d 5c 6c:1.0"],
        "ip_range": ["8s 6s 3h 4h:1.0", "Jh Th 8d 9d:1.0", "3s 4s 5d 6d:0.5"],
        "pot": 100.0,
        "stacks": 100.0,
        "turn_bet_sizes": [0.75],
        "river_bet_sizes": [0.75],
        "max_raises": 1,
        "max_iterations": 200,
        "target_exploitability_pct": 0.0
    }"#;

    let (spot, dcfr_cfg) = parse_turn_spot_json(spot_json).unwrap();
    let game = TurnGame::new(spot).unwrap();
    let result = solve_turn(&game, &dcfr_cfg);
    let out_json = format_turn_solve_result_json(&game, &result);

    let parsed = JsonValue::parse(&out_json).unwrap();
    let ex = parsed.get("exploitability").unwrap();
    let nash_pct = ex.get("nash_distance_pct").unwrap().as_f64().unwrap();
    assert!(nash_pct.is_finite() && nash_pct >= 0.0);

    let nodes = parsed.get("nodes").unwrap().as_array().unwrap();
    assert_eq!(nodes.len(), game.num_decision_nodes());

    let mut saw_river_node_with_card = false;
    for node_val in nodes {
        let street = node_val.get("street").unwrap().as_str().unwrap();
        if street == "river" {
            let rc = node_val.get("river_card").unwrap();
            assert!(rc.as_str().is_some(), "river nodes must carry a river_card");
            saw_river_node_with_card = true;
        } else {
            assert_eq!(street, "turn");
            assert!(matches!(
                node_val.get("river_card").unwrap(),
                JsonValue::Null
            ));
        }
        let actions = node_val.get("actions").unwrap().as_array().unwrap();
        assert!(!actions.is_empty());
        let strat_obj = match node_val.get("strategy").unwrap() {
            JsonValue::Object(entries) => entries,
            _ => panic!("expected strategy object"),
        };
        for (combo_str, freqs_val) in strat_obj {
            let freqs = freqs_val.as_array().unwrap();
            assert_eq!(freqs.len(), actions.len());
            let mut sum = 0.0f64;
            for f_val in freqs {
                sum += f_val.as_f64().unwrap();
            }
            assert!(
                (sum - 1.0).abs() < 1e-5,
                "frequencies for {combo_str} do not sum to 1.0: sum={sum}"
            );
        }
    }
    assert!(saw_river_node_with_card);
}
