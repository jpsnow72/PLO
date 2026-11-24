//! Issue #56: flop target early stop.
//!
//! Before #56, `solve_flop` ran exactly `max_iterations` iterations and
//! ignored `target_exploitability_pct`, so a catalog flop spot
//! (max_iterations 2,000,000, target 0.3/0.5) could never finish. The
//! solver now prices the average strategy every
//! [`STOP_CHECK_EVERY`] iterations and stops at the first checkpoint at
//! or below a positive target, falling through to the ordinary final
//! extraction + pricing.
//!
//! Coverage:
//! - (a) A small spot with a loose 5% target stops at the first
//!   checkpoint: `iterations < max_iterations`, exactly on cadence, and
//!   the final (authoritative) Nash is at or below the target.
//! - (b) The same spot with target 0 runs the full course — including
//!   across a checkpoint — with the standard full-course invariants;
//!   and a positive target whose run ends before the first checkpoint
//!   is bit-identical to the target-0 run of the same length.
//! - (c) Progress reporting disabled via `PLO_PROGRESS_EVERY=0` does
//!   not change the stopping behaviour in (a): the stop cadence is a
//!   constant, not the reporter's cadence.

use std::sync::Mutex;

use plo_cards::Card;
use plo_eval::PloRange;
use plo_solve::{
    solve_flop, BucketConfig, DcfrConfig, FlopGame, FlopSolveResult, FlopSpot, TreeConfig,
    STOP_CHECK_EVERY,
};

/// Serialises the env-mutating test against the other solves in this
/// binary (the reporter parses `PLO_PROGRESS_EVERY` once per process).
static ENV_LOCK: Mutex<()> = Mutex::new(());

fn no_raise_menu() -> TreeConfig {
    TreeConfig {
        bet_sizes: vec![0.75],
        include_all_in_bet: false,
        raise_sizes: vec![],
        include_all_in_raise: false,
        max_raises: 0,
    }
}

/// A small spot in the family of `flop_validation`'s measured loss
/// spot (same board, menus, and range heads): the 18-combo version
/// reaches ~0.001% checker Nash at 4000 iterations, so this 4-combo
/// version crosses a loose 5% target at the first checkpoint (1000)
/// with wide margin.
fn stop_spot() -> FlopSpot {
    FlopSpot {
        board: Card::parse_n::<3>("9c 8d 3h").unwrap(),
        oop_range: PloRange::from_str_specs(&[
            ("As Ah Kd Qc", 1.0),
            ("Ts Js Qh Kh", 1.0),
            ("7s 6s 5d 4d", 1.0),
            ("9s 9h Ad Kd", 0.8),
        ])
        .unwrap(),
        ip_range: PloRange::from_str_specs(&[
            ("Ks Kh Qd Jc", 1.0),
            ("Th Jh Qs Ks", 1.0),
            ("7h 6h 5s 4s", 1.0),
            ("9d 9s Ac Kc", 0.8),
        ])
        .unwrap(),
        starting_pot: 100.0,
        effective_stack: 150.0,
        flop_config: no_raise_menu(),
        turn_config: no_raise_menu(),
        river_config: no_raise_menu(),
        bucket_config: BucketConfig::Exact,
    }
}

const TARGET_PCT: f64 = 5.0;
const MAX_ITERS: usize = 4000;

fn stop_config() -> DcfrConfig {
    DcfrConfig {
        max_iterations: MAX_ITERS,
        target_exploitability_pct: TARGET_PCT,
        // The flop stop cadence is STOP_CHECK_EVERY, not check_interval
        // (that field serves the turn/river solvers); pin it off here
        // as the other flop fixtures do.
        check_interval: 0,
        ..DcfrConfig::default()
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

/// The stop predicates shared by (a) and (c): stopped early, exactly at
/// the first checkpoint, final Nash at or below the target, and the
/// stopped result still satisfies the accounting invariant (it went
/// through the real final extraction + pricing).
fn assert_stopped_at_first_checkpoint(result: &FlopSolveResult) {
    assert!(
        result.iterations < MAX_ITERS,
        "solve must stop early, ran {} of {} iterations",
        result.iterations,
        MAX_ITERS
    );
    assert_eq!(
        result.iterations, STOP_CHECK_EVERY,
        "this spot crosses {TARGET_PCT}% at the first checkpoint"
    );
    let nash = result.exploitability.nash_distance_pct;
    assert!(nash.is_finite() && nash >= 0.0, "Nash must be finite, got {nash}");
    assert!(
        nash <= TARGET_PCT,
        "final Nash {nash}% exceeds the {TARGET_PCT}% target the solve stopped on"
    );
    assert_zero_sum(result, 100.0);
}

#[test]
fn flop_stops_at_first_checkpoint_on_loose_target() {
    let game = FlopGame::new(stop_spot()).unwrap();
    let result = solve_flop(&game, &stop_config());
    assert_stopped_at_first_checkpoint(&result);
}

#[test]
fn flop_target_zero_runs_full_course() {
    let game = FlopGame::new(stop_spot()).unwrap();

    // Full course across a checkpoint boundary: 1200 iterations crosses
    // the 1000-iteration checkpoint, and with target 0 nothing may stop
    // or otherwise disturb the run.
    let full = solve_flop(
        &game,
        &DcfrConfig {
            max_iterations: 1200,
            target_exploitability_pct: 0.0,
            check_interval: 0,
            ..DcfrConfig::default()
        },
    );
    assert_eq!(full.iterations, 1200);
    assert_zero_sum(&full, 100.0);
    for strat in &full.flop_strategies {
        let n_actions = strat.actions.len();
        assert_eq!(strat.frequencies.len(), strat.num_combos * n_actions);
        for c in 0..strat.num_combos {
            let sum: f64 = (0..n_actions)
                .map(|a| strat.frequencies[c * n_actions + a])
                .sum();
            assert!(
                (sum - 1.0).abs() < 1e-9,
                "strategy at {} combo {c} sums to {sum}",
                strat.history
            );
        }
    }
    let nash = full.exploitability.nash_distance_pct;
    assert!(nash.is_finite() && nash >= 0.0, "Nash must be finite, got {nash}");

    // A positive target on a run that ends before the first checkpoint
    // can never fire: the result must be bit-identical to the target-0
    // run of the same length (this is the in-test half of the
    // byte-identity guarantee; the gate checks target-0 against the
    // pre-change code itself).
    let short_cfg = |target: f64| DcfrConfig {
        max_iterations: 500,
        target_exploitability_pct: target,
        check_interval: 0,
        ..DcfrConfig::default()
    };
    let untargeted = solve_flop(&game, &short_cfg(0.0));
    let targeted = solve_flop(&game, &short_cfg(TARGET_PCT));
    assert_eq!(targeted.iterations, 500);
    assert_eq!(untargeted.iterations, targeted.iterations);
    for (a, b) in untargeted
        .flop_strategies
        .iter()
        .zip(targeted.flop_strategies.iter())
    {
        assert_eq!(a.frequencies, b.frequencies, "flop strategies must be identical");
    }
    for (sa, sb) in untargeted
        .subtree_strategies
        .iter()
        .zip(targeted.subtree_strategies.iter())
    {
        for (a, b) in sa.iter().zip(sb.iter()) {
            assert_eq!(a.frequencies, b.frequencies, "subtree strategies must be identical");
        }
    }
    assert_eq!(untargeted.oop_game_ev, targeted.oop_game_ev);
    assert_eq!(untargeted.ip_game_ev, targeted.ip_game_ev);
    assert_eq!(
        untargeted.exploitability.nash_distance_pct,
        targeted.exploitability.nash_distance_pct
    );
}

#[test]
fn flop_stop_does_not_depend_on_progress_reporting() {
    let _guard = ENV_LOCK.lock().unwrap();
    // Disable progress reporting for this process. Note the reporter's
    // interval is parsed once per process (progress.rs), so if another
    // test in this binary already latched it, this set_var may not take
    // effect internally — the assertions below hold in every
    // interleaving precisely because the stop never reads the
    // reporter's cadence; in the interleaving where this test latches
    // the parse first, reporting is genuinely off and the stop must
    // still fire identically.
    std::env::set_var("PLO_PROGRESS_EVERY", "0");
    let game = FlopGame::new(stop_spot()).unwrap();
    let result = solve_flop(&game, &stop_config());
    std::env::remove_var("PLO_PROGRESS_EVERY");
    assert_stopped_at_first_checkpoint(&result);
}
