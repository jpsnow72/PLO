//! Validation test suite for nodelocking (Ship 3):
//! 1. Lock-spec validation: unknown node, wrong player, bad sum, wrong
//!    vector length, negative frequency, duplicate lock, chance-node lock
//!    — all hard errors before any solve (brief acceptance criterion 1).
//! 2. Locked frequencies in the output equal the lock vector exactly, on
//!    river, turn (incl. a river node inside a turn game), and flop
//!    (flop-street node + a turn-subtree node via its output history key)
//!    (criterion 2).
//! 3. Equilibrium-lock regression: locking a single-combo node to the
//!    unlocked solve's own average strategy there reproduces the unlocked
//!    root EVs at equal iterations (criterion 3).
//! 4. A deliberately bad lock (always check with a polar range) shows
//!    clearly higher measured exploitability than the unlocked solve, and
//!    the checker prices it exactly as for unlocked solves (criterion 4).
//! 5. JSON: `"locks"` parses into the solver config on all three spot
//!    types, malformed lock specs are JSON errors, and results carry the
//!    `"locked"` / `"locks"` honesty fields.

use plo_cards::Card;
use plo_eval::PloRange;
use plo_solve::{
    format_flop_solve_result_json, format_solve_result_json, parse_flop_spot_json, parse_spot_json,
    parse_turn_spot_json, solve_flop, solve_river, solve_turn, validate_locks_flop,
    validate_locks_river, validate_locks_turn, BucketConfig, DcfrConfig, FlopGame, FlopSpot,
    JsonValue, NodeLock, Player, RiverGame, RiverSpot, SolveError, TreeConfig, TurnGame, TurnSpot,
};

fn lock(history: &str, player: Player, frequencies: Vec<f64>) -> NodeLock {
    NodeLock {
        history: history.to_string(),
        player,
        frequencies,
    }
}

fn fixed_iters(iters: usize, locks: Vec<NodeLock>) -> DcfrConfig {
    DcfrConfig {
        max_iterations: iters,
        target_exploitability_pct: 0.0,
        check_interval: 0,
        locks,
        ..DcfrConfig::default()
    }
}

/// The textbook polarised-vs-bluff-catcher river game from
/// `tests/validation.rs`: board As Ks Qs 7d 2c, pot 100, stack 100.
/// OOP is polar (nuts "Ts 9s 3c 4c" + air "3d 4d 5c 6c", equal weight);
/// IP holds a single bluff-catcher combo ("Jd Td 8h 9h"). Analytic
/// equilibrium: OOP bets pot with the nuts, bluffs it 50% with air; IP
/// calls 50%; game EVs OOP 75 / IP 25.
fn textbook_river_game() -> RiverGame {
    let spot = RiverSpot {
        board: Card::parse_n::<5>("As Ks Qs 7d 2c").unwrap(),
        oop_range: PloRange::from_str_specs(&[("Ts 9s 3c 4c", 1.0), ("3d 4d 5c 6c", 1.0)])
            .unwrap(),
        ip_range: PloRange::from_str_specs(&[("Jd Td 8h 9h", 1.0)]).unwrap(),
        starting_pot: 100.0,
        effective_stack: 100.0,
        tree_config: TreeConfig::default(),
    };
    RiverGame::new(spot).unwrap()
}

/// Small two-street game (the E5 fork-test spot): turn root has exactly
/// two actions (Check, Bet(100)) under these menus.
fn small_turn_game() -> TurnGame {
    let menu = TreeConfig {
        bet_sizes: vec![1.0],
        include_all_in_bet: false,
        raise_sizes: vec![],
        include_all_in_raise: false,
        max_raises: 0,
    };
    let spot = TurnSpot {
        board: Card::parse_n::<4>("As Ks Qs 7d").unwrap(),
        oop_range: PloRange::from_str_specs(&[
            ("Kc 9c 3d 4d", 1.0),
            ("Ah Ad 5h 6h", 0.7),
            ("Ts 9s 8c 9d", 1.0),
        ])
        .unwrap(),
        ip_range: PloRange::from_str_specs(&[("Jh Th 8h 9h", 1.0), ("2c 3c 4h 5d", 0.5)])
            .unwrap(),
        starting_pot: 100.0,
        effective_stack: 100.0,
        turn_config: menu.clone(),
        river_config: menu,
    };
    TurnGame::new(spot).unwrap()
}

/// Small flop game, exact bucketing, no-raise menus on every street.
fn small_flop_game() -> FlopGame {
    let menu = TreeConfig {
        bet_sizes: vec![0.75],
        include_all_in_bet: false,
        raise_sizes: vec![],
        include_all_in_raise: false,
        max_raises: 0,
    };
    let spot = FlopSpot {
        board: Card::parse_n::<3>("Ks 7d 2c").unwrap(),
        oop_range: PloRange::from_str_specs(&[("As Ah Kd Qc", 1.0), ("Ts Js Qh Kh", 1.0)])
            .unwrap(),
        ip_range: PloRange::from_str_specs(&[("Kc Qd Jc 9h", 1.0), ("Th Jh 9s 8s", 0.8)])
            .unwrap(),
        starting_pot: 100.0,
        effective_stack: 100.0,
        flop_config: menu.clone(),
        turn_config: menu.clone(),
        river_config: menu,
        bucket_config: BucketConfig::Exact,
    };
    FlopGame::new(spot).unwrap()
}

/// Extracts the per-combo strategy rows of the node with `history` from a
/// formatted solve result (parsed back through JsonValue).
fn json_node_strategy_rows(result_json: &str, history: &str) -> Vec<Vec<f64>> {
    let root = JsonValue::parse(result_json).unwrap();
    let nodes = root.get("nodes").and_then(|v| v.as_array()).unwrap();
    for node in nodes {
        if node.get("history").and_then(|v| v.as_str()) == Some(history) {
            let strategy = node.get("strategy").unwrap();
            let JsonValue::Object(entries) = strategy else {
                panic!("strategy must be an object");
            };
            return entries
                .iter()
                .map(|(_, freqs)| {
                    freqs
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|f| f.as_f64().unwrap())
                        .collect()
                })
                .collect();
        }
    }
    panic!("no node with history {history} in result JSON");
}

fn assert_rows_approx(rows: &[Vec<f64>], expected: &[f64], tol: f64) {
    assert!(!rows.is_empty(), "expected at least one combo row");
    for row in rows {
        assert_eq!(row.len(), expected.len());
        for (got, want) in row.iter().zip(expected.iter()) {
            assert!(
                (got - want).abs() <= tol,
                "row {row:?} differs from lock {expected:?} by more than {tol}"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Criterion 1: validation is a hard error, before any solve.
// ---------------------------------------------------------------------------

#[test]
fn lock_validation_rejects_bad_specs_river() {
    let game = textbook_river_game();
    let root_actions = game.decision_node(0).actions.len();

    // Unknown node history.
    let err = validate_locks_river(&game, &[lock("B(999)", Player::Oop, vec![1.0])])
        .expect_err("unknown history must be rejected");
    assert!(matches!(err, SolveError::InvalidLock(_)), "got {err:?}");

    // Wrong player: OOP acts at the root, not IP.
    let err = validate_locks_river(
        &game,
        &[lock("root", Player::Ip, vec![1.0; root_actions])],
    )
    .expect_err("wrong player must be rejected");
    assert!(matches!(err, SolveError::InvalidLock(_)), "got {err:?}");

    // Frequencies not summing to 1.
    let mut bad_sum = vec![0.0; root_actions];
    bad_sum[0] = 0.5;
    bad_sum[1] = 0.4;
    let err = validate_locks_river(&game, &[lock("root", Player::Oop, bad_sum)])
        .expect_err("sum != 1 must be rejected");
    assert!(matches!(err, SolveError::InvalidLock(_)), "got {err:?}");

    // Vector length outside the node's action menu.
    let err = validate_locks_river(&game, &[lock("root", Player::Oop, vec![0.5, 0.5])])
        .expect_err("wrong length must be rejected");
    assert!(matches!(err, SolveError::InvalidLock(_)), "got {err:?}");

    // Negative frequency (even though the vector sums to 1).
    let mut negative = vec![0.0; root_actions];
    negative[0] = 1.1;
    negative[1] = -0.1;
    let err = validate_locks_river(&game, &[lock("root", Player::Oop, negative)])
        .expect_err("negative frequency must be rejected");
    assert!(matches!(err, SolveError::InvalidLock(_)), "got {err:?}");

    // Two locks naming the same node.
    let good = lock("root", Player::Oop, {
        let mut v = vec![0.0; root_actions];
        v[0] = 1.0;
        v
    });
    let err = validate_locks_river(&game, &[good.clone(), good])
        .expect_err("duplicate lock must be rejected");
    assert!(matches!(err, SolveError::InvalidLock(_)), "got {err:?}");

    // A well-formed lock validates.
    validate_locks_river(&game, &[lock("root", Player::Oop, {
        let mut v = vec![0.0; root_actions];
        v[0] = 0.25;
        v[1] = 0.75;
        v
    })])
    .expect("well-formed lock must validate");
}

#[test]
fn lock_validation_rejects_bad_specs_turn_and_flop() {
    // Turn: "X/X" is the chance node's history (the closed turn sequence),
    // not a decision node — locking it must fail.
    let turn_game = small_turn_game();
    let err = validate_locks_turn(&turn_game, &[lock("X/X", Player::Oop, vec![1.0])])
        .expect_err("chance-node lock must be rejected");
    assert!(matches!(err, SolveError::InvalidLock(_)), "got {err:?}");
    // Turn: wrong player at the root.
    let err = validate_locks_turn(&turn_game, &[lock("root", Player::Ip, vec![0.5, 0.5])])
        .expect_err("wrong player must be rejected");
    assert!(matches!(err, SolveError::InvalidLock(_)), "got {err:?}");

    // Flop: unknown flop history.
    let flop_game = small_flop_game();
    let err = validate_locks_flop(&flop_game, &[lock("R(200)", Player::Oop, vec![1.0])])
        .expect_err("unknown flop history must be rejected");
    assert!(matches!(err, SolveError::InvalidLock(_)), "got {err:?}");
    // Flop: a subtree key whose flop line closes no street ("B(75)" leaves
    // IP to act; nothing is dealt below it).
    let err = validate_locks_flop(
        &flop_game,
        &[lock("B(75)|t:As", Player::Oop, vec![0.5, 0.5])],
    )
    .expect_err("subtree key below a non-closing flop line must be rejected");
    assert!(matches!(err, SolveError::InvalidLock(_)), "got {err:?}");
}

// ---------------------------------------------------------------------------
// Criterion 2: output at the locked node equals the lock vector exactly.
// ---------------------------------------------------------------------------

#[test]
fn locked_node_output_equals_lock_vector_river() {
    let game = textbook_river_game();
    let root_actions = game.decision_node(0).actions.len();
    // Distinct, non-uniform vectors so a mix-up between nodes or actions
    // would show.
    let root_lock = lock("root", Player::Oop, {
        let mut v = vec![0.0; root_actions];
        v[0] = 0.1;
        v[1] = 0.2;
        v[2] = 0.3;
        v[3] = 0.4;
        v
    });
    // IP's node after OOP checks ("X"): same action-menu shape.
    let ip_node = (0..game.num_decision_nodes())
        .map(|did| game.decision_node(did))
        .find(|d| d.history == "X")
        .expect("IP node after a check exists");
    let ip_lock = lock("X", Player::Ip, {
        let mut v = vec![0.0; ip_node.actions.len()];
        v[0] = 0.7;
        v[1] = 0.3;
        v
    });

    let result = solve_river(
        &game,
        &fixed_iters(200, vec![root_lock.clone(), ip_lock.clone()]),
    );

    assert_eq!(result.locks, vec![root_lock.clone(), ip_lock.clone()]);
    for ns in &result.strategies {
        if ns.history == "root" {
            for i in 0..ns.num_combos {
                assert_eq!(
                    ns.combo_strategy(i),
                    &root_lock.frequencies[..],
                    "root combo {i} must equal the lock vector exactly"
                );
            }
        }
        if ns.history == "X" {
            for i in 0..ns.num_combos {
                assert_eq!(
                    ns.combo_strategy(i),
                    &ip_lock.frequencies[..],
                    "IP-after-check combo {i} must equal the lock vector exactly"
                );
            }
        }
    }

    // The formatted JSON carries the badge and the same locked strategies
    // (up to the output's 6-decimal serialization).
    let json = format_solve_result_json(&game, &result);
    let parsed = JsonValue::parse(&json).unwrap();
    assert_eq!(parsed.get("locked"), Some(&JsonValue::Bool(true)));
    let rows = json_node_strategy_rows(&json, "root");
    assert_rows_approx(&rows, &root_lock.frequencies, 1e-6);
}

#[test]
fn locked_node_output_equals_lock_vector_turn() {
    let game = small_turn_game();

    // Turn root lock.
    let root_lock = lock("root", Player::Oop, vec![0.3, 0.7]);
    let result = solve_turn(&game, &fixed_iters(40, vec![root_lock.clone()]));
    let root_ns = &result.strategies[0];
    assert_eq!(root_ns.history, "root");
    for i in 0..root_ns.num_combos {
        assert_eq!(root_ns.combo_strategy(i), &root_lock.frequencies[..]);
    }

    // River node inside the turn game: take a river node's history from an
    // unlocked solve and lock it to a pure first-action vector.
    let unlocked = solve_turn(&game, &fixed_iters(40, vec![]));
    let river_ns = unlocked
        .strategies
        .iter()
        .find(|ns| ns.history.contains("|r:"))
        .expect("turn game has river decision nodes");
    let river_lock = lock(
        &river_ns.history,
        river_ns.player,
        {
            let mut v = vec![0.0; river_ns.actions.len()];
            v[0] = 1.0;
            v
        },
    );
    let result = solve_turn(&game, &fixed_iters(40, vec![river_lock.clone()]));
    let locked_ns = result
        .strategies
        .iter()
        .find(|ns| ns.history == river_lock.history)
        .expect("locked river node present in output");
    for i in 0..locked_ns.num_combos {
        assert_eq!(
            locked_ns.combo_strategy(i),
            &river_lock.frequencies[..],
            "river combo {i} must equal the lock vector exactly"
        );
    }
}

#[test]
fn locked_node_output_equals_lock_vector_flop() {
    let game = small_flop_game();

    // Learn a turn-subtree node's output history key from an unlocked
    // solve's formatted JSON (the Explorer's navigation contract).
    let unlocked = solve_flop(&game, &fixed_iters(5, vec![]));
    let unlocked_json = format_flop_solve_result_json(&game, &unlocked);
    let parsed = JsonValue::parse(&unlocked_json).unwrap();
    assert_eq!(parsed.get("locked"), Some(&JsonValue::Bool(false)));
    let nodes = parsed.get("nodes").and_then(|v| v.as_array()).unwrap();
    let turn_node = nodes
        .iter()
        .find(|n| n.get("street").and_then(|v| v.as_str()) == Some("turn"))
        .expect("flop solve output has turn-subtree nodes");
    let subtree_key = turn_node
        .get("history")
        .and_then(|v| v.as_str())
        .unwrap()
        .to_string();
    let subtree_player = match turn_node.get("player").and_then(|v| v.as_str()) {
        Some("OOP") => Player::Oop,
        Some("IP") => Player::Ip,
        other => panic!("unexpected player {other:?}"),
    };
    let subtree_actions = turn_node
        .get("actions")
        .and_then(|v| v.as_array())
        .unwrap()
        .len();

    let root_lock = lock("root", Player::Oop, vec![0.35, 0.65]);
    let subtree_lock = lock(&subtree_key, subtree_player, {
        let mut v = vec![0.0; subtree_actions];
        v[0] = 1.0;
        v
    });

    let result = solve_flop(
        &game,
        &fixed_iters(5, vec![root_lock.clone(), subtree_lock.clone()]),
    );
    assert_eq!(result.locks.len(), 2);

    // Flop-street root: bucket-level output (Exact => one bucket per
    // combo) equals the lock vector exactly.
    let root_ns = &result.flop_strategies[0];
    assert_eq!(root_ns.history, "root");
    for i in 0..root_ns.num_combos {
        assert_eq!(root_ns.combo_strategy(i), &root_lock.frequencies[..]);
    }

    // Subtree node: check through the formatted JSON (combo-expanded).
    let json = format_flop_solve_result_json(&game, &result);
    let parsed = JsonValue::parse(&json).unwrap();
    assert_eq!(parsed.get("locked"), Some(&JsonValue::Bool(true)));
    let rows = json_node_strategy_rows(&json, &subtree_key);
    assert_rows_approx(&rows, &subtree_lock.frequencies, 1e-6);
}

// ---------------------------------------------------------------------------
// Criterion 3: locking a node to the unlocked solve's own average strategy
// there reproduces the unlocked root EVs at equal iterations.
// ---------------------------------------------------------------------------

#[test]
fn equilibrium_lock_reproduces_root_evs_river() {
    let game = textbook_river_game();
    let iters = 20_000;

    let unlocked = solve_river(&game, &fixed_iters(iters, vec![]));
    assert!(
        unlocked.exploitability.nash_distance_pct < 0.1,
        "unlocked solve should be near equilibrium, got {}%",
        unlocked.exploitability.nash_distance_pct
    );

    // IP's node facing the pot-sized all-in bet: IP holds a single combo,
    // so its average strategy there IS a single frequency vector — the
    // lockable equilibrium strategy at that node.
    let ip_facing = unlocked
        .strategies
        .iter()
        .find(|ns| ns.player == Player::Ip && ns.history.starts_with("BAI"))
        .expect("IP node facing the all-in bet exists");
    assert_eq!(ip_facing.num_combos, 1);
    let eq_lock = lock(
        &ip_facing.history,
        Player::Ip,
        ip_facing.combo_strategy(0).to_vec(),
    );

    let locked = solve_river(&game, &fixed_iters(iters, vec![eq_lock]));
    assert!(
        (locked.oop_game_ev - unlocked.oop_game_ev).abs() < 0.5,
        "OOP root EV drifted: unlocked {}, locked {}",
        unlocked.oop_game_ev,
        locked.oop_game_ev
    );
    assert!(
        (locked.ip_game_ev - unlocked.ip_game_ev).abs() < 0.5,
        "IP root EV drifted: unlocked {}, locked {}",
        unlocked.ip_game_ev,
        locked.ip_game_ev
    );
    // And the locked profile is still measured near-equilibrium: the lock
    // was (approximately) an equilibrium strategy, so the checker must not
    // suddenly price it as exploitable.
    assert!(
        locked.exploitability.nash_distance_pct < 0.25,
        "equilibrium-locked solve should stay near equilibrium, got {}%",
        locked.exploitability.nash_distance_pct
    );
}

// ---------------------------------------------------------------------------
// Criterion 4: a deliberately bad lock is priced by the checker — clearly
// higher exploitability than the unlocked solve of the same spot.
// ---------------------------------------------------------------------------

#[test]
fn bad_lock_raises_measured_exploitability_river() {
    let game = textbook_river_game();
    let iters = 5_000;

    let unlocked = solve_river(&game, &fixed_iters(iters, vec![]));

    // Always check at the root with a polar range (nuts + air): the nuts
    // never extract bet value. Analytic cost ≈ 25 chips of OOP EV.
    let root_actions = game.decision_node(0).actions.len();
    let mut check_always = vec![0.0; root_actions];
    check_always[0] = 1.0; // Action 0 is Check at the root.
    let locked = solve_river(
        &game,
        &fixed_iters(iters, vec![lock("root", Player::Oop, check_always)]),
    );

    assert!(
        locked.exploitability.nash_distance_pct
            > unlocked.exploitability.nash_distance_pct + 5.0,
        "bad lock must be priced: unlocked {}%, locked {}%",
        unlocked.exploitability.nash_distance_pct,
        locked.exploitability.nash_distance_pct
    );
    assert!(
        locked.oop_game_ev < unlocked.oop_game_ev - 10.0,
        "always-check must cost OOP heavily: unlocked {}, locked {}",
        unlocked.oop_game_ev,
        locked.oop_game_ev
    );
    // The EVs are still reported for the locked profile (comparable
    // against the unlocked solve), and they still sum to the pot.
    assert!(
        (locked.oop_game_ev + locked.ip_game_ev - 100.0).abs() < 0.01,
        "locked EVs must sum to the starting pot: {} + {}",
        locked.oop_game_ev,
        locked.ip_game_ev
    );
}

// ---------------------------------------------------------------------------
// JSON: locks parse on all three spot types; malformed specs are errors;
// unlocked results carry the badge fields too.
// ---------------------------------------------------------------------------

#[test]
fn locks_json_parse_and_shape_errors() {
    // River spot with a lock (root has 4 actions under the default menu).
    let river_json = r#"{
        "board": "As Ks Qs 7d 2c",
        "oop_range": "Ts 9s 3c 4c:1, 3d 4d 5c 6c:1",
        "ip_range": "Jd Td 8h 9h:1",
        "pot": 100,
        "stacks": 100,
        "locks": [{"history": "root", "player": "OOP", "frequencies": [0.1, 0.2, 0.3, 0.4]}]
    }"#;
    let (spot, cfg) = parse_spot_json(river_json).unwrap();
    assert_eq!(cfg.locks.len(), 1);
    assert_eq!(cfg.locks[0].history, "root");
    assert_eq!(cfg.locks[0].player, Player::Oop);
    let game = RiverGame::new(spot).unwrap();
    validate_locks_river(&game, &cfg.locks).unwrap();
    let result = solve_river(&game, &DcfrConfig { max_iterations: 50, target_exploitability_pct: 0.0, check_interval: 0, ..cfg });
    let json = format_solve_result_json(&game, &result);
    let parsed = JsonValue::parse(&json).unwrap();
    assert_eq!(parsed.get("locked"), Some(&JsonValue::Bool(true)));
    let locks_out = parsed.get("locks").and_then(|v| v.as_array()).unwrap();
    assert_eq!(locks_out.len(), 1);
    assert_eq!(
        locks_out[0].get("history").and_then(|v| v.as_str()),
        Some("root")
    );

    // "node" alias + lowercase player are accepted.
    let alias_json = r#"{
        "board": "As Ks Qs 7d 2c",
        "oop_range": "Ts 9s 3c 4c:1",
        "ip_range": "Jd Td 8h 9h:1",
        "pot": 100,
        "stacks": 100,
        "locks": [{"node": "root", "player": "oop", "frequencies": [0.25, 0.25, 0.25, 0.25]}]
    }"#;
    let (_, cfg) = parse_spot_json(alias_json).unwrap();
    assert_eq!(cfg.locks.len(), 1);

    // Malformed lock specs are JSON errors, not silent drops.
    for bad in [
        // Unknown player.
        r#"{"board": "As Ks Qs 7d 2c", "oop_range": "Ts 9s 3c 4c:1", "ip_range": "Jd Td 8h 9h:1", "pot": 100, "stacks": 100, "locks": [{"history": "root", "player": "XX", "frequencies": [1.0]}]}"#,
        // Frequencies not numbers.
        r#"{"board": "As Ks Qs 7d 2c", "oop_range": "Ts 9s 3c 4c:1", "ip_range": "Jd Td 8h 9h:1", "pot": 100, "stacks": 100, "locks": [{"history": "root", "player": "OOP", "frequencies": ["all"]}]}"#,
        // Missing history.
        r#"{"board": "As Ks Qs 7d 2c", "oop_range": "Ts 9s 3c 4c:1", "ip_range": "Jd Td 8h 9h:1", "pot": 100, "stacks": 100, "locks": [{"player": "OOP", "frequencies": [1.0]}]}"#,
        // Locks not an array.
        r#"{"board": "As Ks Qs 7d 2c", "oop_range": "Ts 9s 3c 4c:1", "ip_range": "Jd Td 8h 9h:1", "pot": 100, "stacks": 100, "locks": {"history": "root"}}"#,
    ] {
        let err = parse_spot_json(bad).expect_err("malformed locks must be a JSON error");
        assert!(matches!(err, SolveError::JsonError(_)), "got {err:?}");
    }

    // Turn + flop spot parsers accept locks too.
    let turn_json = r#"{
        "board": "As Ks Qs 7d",
        "oop_range": "Kc 9c 3d 4d:1",
        "ip_range": "Jh Th 8h 9h:1",
        "pot": 100,
        "stacks": 100,
        "locks": [{"history": "root", "player": "OOP", "frequencies": [0.5, 0.5]}]
    }"#;
    let (_, cfg) = parse_turn_spot_json(turn_json).unwrap();
    assert_eq!(cfg.locks.len(), 1);

    let flop_json = r#"{
        "board": "Ks 7d 2c",
        "oop_range": "As Ah Kd Qc:1",
        "ip_range": "Kc Qd Jc 9h:1",
        "pot": 100,
        "stacks": 100,
        "locks": [{"history": "root", "player": "OOP", "frequencies": [0.5, 0.5]}]
    }"#;
    let (_, cfg) = parse_flop_spot_json(flop_json).unwrap();
    assert_eq!(cfg.locks.len(), 1);
}
