//! Ticket E5a validation: multithreaded DCFR traversal.
//!
//! Coverage:
//! - Thread-count invariance: the same turn spot and the same flop spot
//!   solved with 1 vs 4 worker threads (explicit `*_with_threads` entry
//!   points, fixed iteration budgets) must produce strategies and EVs that
//!   agree to within 1e-9. The E5a design (disjoint buffer partitions +
//!   fixed-order combination at chance nodes) performs the identical
//!   floating-point operations in both modes, so the expected difference is
//!   exactly 0.0; the tolerance only guards against platform float quirks.
//! - Reproducibility: two 4-thread solves of the same spot must agree
//!   exactly (diff == 0.0).
//! - Fork engagement: the process-wide fork counter
//!   (`parallel::parallel_fork_events`) must not move for a 1-thread solve
//!   and must increase for a 4-thread solve of a spot above the fork
//!   threshold, proving the parallel path really ran.
//! - Zero-sum identity under threading: the flop solve with 4 threads must
//!   still satisfy the dead-money invariant `oop_ev + ip_ev == pot` that
//!   the E4 suite asserts for the sequential solver.
//!
//! The two tests share the process-wide fork counter, so they serialise on
//! a mutex (each integration-test file is its own process; nothing else in
//! this file reads the counter).

use std::sync::Mutex;

use plo_cards::{Card, HandMask};
use plo_eval::{DeterministicRng, PloRange};
use plo_solve::{
    parallel::parallel_fork_events, solve_flop_with_threads, solve_turn_with_threads, BucketConfig,
    DcfrConfig, FlopGame, FlopSolveResult, FlopSpot, NodeStrategy, TreeConfig, TurnGame, TurnSpot,
    TurnSolveResult,
};

static COUNTER_LOCK: Mutex<()> = Mutex::new(());

fn fixed_iters(iters: usize) -> DcfrConfig {
    DcfrConfig {
        max_iterations: iters,
        target_exploitability_pct: 0.0,
        check_interval: 0,
        ..DcfrConfig::default()
    }
}

/// Max |a-b| over all action frequencies of two strategy tables that must
/// describe the same nodes in the same order.
fn max_strategy_diff(a: &[NodeStrategy], b: &[NodeStrategy]) -> f64 {
    assert_eq!(a.len(), b.len(), "strategy table lengths differ");
    let mut max = 0.0f64;
    for (sa, sb) in a.iter().zip(b.iter()) {
        assert_eq!(sa.history, sb.history);
        assert_eq!(sa.num_combos, sb.num_combos);
        assert_eq!(sa.frequencies.len(), sb.frequencies.len());
        for (x, y) in sa.frequencies.iter().zip(sb.frequencies.iter()) {
            max = max.max((x - y).abs());
        }
    }
    max
}

/// Deterministically samples `count` distinct 4-card combos off a 4-card
/// board (same helper shape as the E3 validation suite).
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

fn pot_bet_menu() -> TreeConfig {
    TreeConfig {
        bet_sizes: vec![1.0],
        include_all_in_bet: false,
        raise_sizes: vec![],
        include_all_in_raise: false,
        max_raises: 0,
    }
}

fn turn_spot() -> TurnSpot {
    let board = Card::parse_n::<4>("Js Ts 7d 2c").unwrap();
    TurnSpot {
        board,
        oop_range: generate_deterministic_range4(board, 20, 0xE5A0_0001),
        ip_range: generate_deterministic_range4(board, 20, 0xE5A0_0002),
        starting_pot: 100.0,
        effective_stack: 150.0,
        turn_config: pot_bet_menu(),
        river_config: pot_bet_menu(),
    }
}

fn compare_turn_results(a: &TurnSolveResult, b: &TurnSolveResult, tol: f64) {
    assert_eq!(a.iterations, b.iterations);
    let d = max_strategy_diff(&a.strategies, &b.strategies);
    assert!(d <= tol, "turn strategy diff {d} exceeds {tol}");
    assert!((a.oop_game_ev - b.oop_game_ev).abs() <= tol);
    assert!((a.ip_game_ev - b.ip_game_ev).abs() <= tol);
    assert!(
        (a.exploitability.nash_distance_pct - b.exploitability.nash_distance_pct).abs() <= tol,
        "nash distance differs: {} vs {}",
        a.exploitability.nash_distance_pct,
        b.exploitability.nash_distance_pct
    );
    for (x, y) in a.oop_evs.iter().zip(b.oop_evs.iter()) {
        assert!((x.ev - y.ev).abs() <= tol, "oop combo ev differs");
    }
    for (x, y) in a.ip_evs.iter().zip(b.ip_evs.iter()) {
        assert!((x.ev - y.ev).abs() <= tol, "ip combo ev differs");
    }
}

#[test]
fn turn_thread_count_invariance_and_reproducibility() {
    let _guard = COUNTER_LOCK.lock().unwrap();
    let game = TurnGame::new(turn_spot()).unwrap();
    let config = fixed_iters(100);

    let before = parallel_fork_events();
    let single = solve_turn_with_threads(&game, &config, 1);
    assert_eq!(
        parallel_fork_events(),
        before,
        "single-threaded solve must never fork"
    );

    let before = parallel_fork_events();
    let multi = solve_turn_with_threads(&game, &config, 4);
    assert!(
        parallel_fork_events() > before,
        "4-thread solve of an above-threshold spot must engage the chance fork"
    );

    compare_turn_results(&single, &multi, 1e-9);

    // Reproducibility at a fixed thread count: exact agreement.
    let multi2 = solve_turn_with_threads(&game, &config, 4);
    let d = max_strategy_diff(&multi.strategies, &multi2.strategies);
    assert_eq!(d, 0.0, "repeated 4-thread solve must be bit-identical");
    assert_eq!(multi.oop_game_ev, multi2.oop_game_ev);
    assert_eq!(multi.ip_game_ev, multi2.ip_game_ev);
}

fn flop_menu() -> TreeConfig {
    TreeConfig {
        bet_sizes: vec![0.75],
        include_all_in_bet: false,
        raise_sizes: vec![],
        include_all_in_raise: false,
        max_raises: 0,
    }
}

/// The E4 smoke spot's shape (board `Ks 7d 2c`, same menus) widened to
/// 12 combos/side so every subtree chance node clears the fork threshold.
fn flop_spot() -> FlopSpot {
    FlopSpot {
        board: Card::parse_n::<3>("Ks 7d 2c").unwrap(),
        oop_range: PloRange::from_str_specs(&[
            ("As Ah Kd Qc", 1.0),
            ("Ts Js Qh Kh", 1.0),
            ("9s 9h Ad Kd", 0.8),
            ("8s 8h As Kc", 0.8),
            ("Ac Kc Qd Jd", 0.9),
            ("3s 3c Ah Kh", 0.7),
            ("Qs Qd 5s 5h", 0.8),
            ("5h 4h 3d 2s", 0.8),
            ("Ad Qd Jd Td", 0.9),
            ("6s 5s 4d 3d", 0.75),
            ("Jh Th 9h 8h", 0.85),
            ("4s 4h Ac Qc", 0.7),
        ])
        .unwrap(),
        ip_range: PloRange::from_str_specs(&[
            ("Kc Kh Qd Jc", 1.0),
            ("Th Jh Qs Kc", 1.0),
            ("9d 9s Ac Kc", 0.8),
            ("8c 8s Ad Kd", 0.8),
            ("As Kc Qh Jh", 0.9),
            ("3d 3s As Kc", 0.7),
            ("Qc Qs 5d 5c", 0.8),
            ("5c 4d 3d 2h", 0.8),
            ("Ah Qh Jh Th", 0.9),
            ("6d 5d 4c 3c", 0.75),
            ("Jd Td 9s 8s", 0.85),
            ("4d 4c As Qs", 0.7),
        ])
        .unwrap(),
        starting_pot: 100.0,
        effective_stack: 150.0,
        flop_config: flop_menu(),
        turn_config: flop_menu(),
        river_config: flop_menu(),
        bucket_config: BucketConfig::Exact,
    }
}

fn assert_zero_sum(result: &FlopSolveResult, starting_pot: f64) {
    let sum = result.oop_game_ev + result.ip_game_ev;
    assert!(
        (sum - starting_pot).abs() < 0.01,
        "EV accounting broken: oop {} + ip {} = {}, expected starting pot {}",
        result.oop_game_ev,
        result.ip_game_ev,
        sum,
        starting_pot
    );
}

#[test]
fn flop_thread_count_invariance_and_zero_sum() {
    let _guard = COUNTER_LOCK.lock().unwrap();
    let game = FlopGame::new(flop_spot()).unwrap();
    let config = fixed_iters(60);

    let before = parallel_fork_events();
    let single = solve_flop_with_threads(&game, &config, 1);
    assert_eq!(
        parallel_fork_events(),
        before,
        "single-threaded flop solve must never fork"
    );
    assert_zero_sum(&single, 100.0);

    let before = parallel_fork_events();
    let multi = solve_flop_with_threads(&game, &config, 4);
    assert!(
        parallel_fork_events() > before,
        "4-thread flop solve must engage the subtree chance forks"
    );
    assert_zero_sum(&multi, 100.0);

    let d = max_strategy_diff(&single.flop_strategies, &multi.flop_strategies);
    assert!(d <= 1e-9, "flop strategy diff {d} exceeds 1e-9");
    assert_eq!(single.subtree_strategies.len(), multi.subtree_strategies.len());
    for (sa, sb) in single
        .subtree_strategies
        .iter()
        .zip(multi.subtree_strategies.iter())
    {
        let d = max_strategy_diff(sa, sb);
        assert!(d <= 1e-9, "subtree strategy diff {d} exceeds 1e-9");
    }
    assert!((single.oop_game_ev - multi.oop_game_ev).abs() <= 1e-9);
    assert!((single.ip_game_ev - multi.ip_game_ev).abs() <= 1e-9);
    assert!(
        (single.exploitability.nash_distance_pct - multi.exploitability.nash_distance_pct).abs()
            <= 1e-9,
        "nash distance differs: {} vs {}",
        single.exploitability.nash_distance_pct,
        multi.exploitability.nash_distance_pct
    );
}
