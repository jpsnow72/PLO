//! CLI binary `measure-flop`: the Ticket E4 measurement harness.
//!
//! Modes:
//! - `measure-flop` — estimate-only table for every (board, K) row: infosets,
//!   strategy+regret GB (f32/f16), solver working-set GB. No solving.
//! - `measure-flop solve <canonical|paired|monotone> <exact|200|100|50> [iters]`
//!   — build one configuration, solve it for exactly `iters` DCFR iterations
//!   (default 120), and print wall time, time per 1k iterations, and the
//!   checker-measured true Nash distance (unabstracted game, % of pot).
//! - `measure-flop loss [iters]` — the small-spot abstraction-loss measurement:
//!   one narrow flop spot solved exactly and bucketed at K=9 and K=5, with all
//!   three checker numbers printed side by side.
//!
//! Canonical spot (documented construction):
//! - Boards: canonical `Ks 7d 2c` (dry rainbow), paired `Ks Kh 7d`,
//!   monotone `Ks 9s 4s`.
//! - Ranges: OOP = BB defending range, IP = BTN opening range, each a
//!   deterministic seeded sample of 200 weighted combos drawn from the
//!   "playable" subset of all off-board 4-card combos (see `playable`).
//!   Weights are seeded draws from {0.5, 0.75, 1.0}.
//! - Pot 12bb at the flop, 94bb behind (100bb effective total).
//! - Bet menus — flop: bet 75% pot or all-in, pot raise / all-in raise,
//!   max 1 raise; turn: bet 75% pot or all-in, no raises; river: bet 75%
//!   pot or all-in, no raises.

use std::time::Instant;

use plo_cards::{Card, HandMask, Rank};
use plo_eval::{DeterministicRng, PloRange};
use plo_solve::{
    solve_flop, BucketConfig, DcfrConfig, FlopGame, FlopSpot, TreeConfig,
};

const CANONICAL_COMBOS: usize = 200;
const OOP_SEED: u64 = 0xE4_0000_0000_0001;
const IP_SEED: u64 = 0xE4_0000_0000_0002;
const DEFAULT_ITERS: usize = 120;
/// Solver working-set ceiling for actually running a configuration on the
/// measurement host (the host has ~8 GB RAM; leave generous headroom).
const RUN_FOOTPRINT_LIMIT: f64 = 4.5;

fn flop_menu() -> TreeConfig {
    TreeConfig {
        bet_sizes: vec![0.75],
        include_all_in_bet: true,
        raise_sizes: vec![1.0],
        include_all_in_raise: true,
        max_raises: 1,
    }
}

fn turn_menu() -> TreeConfig {
    TreeConfig {
        bet_sizes: vec![0.75],
        include_all_in_bet: true,
        raise_sizes: vec![],
        include_all_in_raise: false,
        max_raises: 0,
    }
}

fn river_menu() -> TreeConfig {
    turn_menu()
}

fn board_by_name(name: &str) -> [Card; 3] {
    match name {
        "canonical" => Card::parse_n::<3>("Ks 7d 2c").unwrap(),
        "paired" => Card::parse_n::<3>("Ks Kh 7d").unwrap(),
        "monotone" => Card::parse_n::<3>("Ks 9s 4s").unwrap(),
        other => panic!("unknown board name: {other}"),
    }
}

/// "Playable" filter approximating an SRP continuing/opening range: a pair or
/// better, three high cards, a double-suited hand with a high card, or a
/// rundown with two high cards.
fn playable(cards: &[Card; 4]) -> bool {
    let mut rank_count = [0u32; 13];
    let mut suit_count = [0u32; 4];
    for &c in cards {
        rank_count[c.rank().index() as usize] += 1;
        suit_count[c.suit().index() as usize] += 1;
    }
    let has_pair = rank_count.iter().any(|&n| n >= 2);
    let high_cards = cards
        .iter()
        .filter(|c| c.rank().index() >= Rank::Ten.index())
        .count();
    let double_suited = {
        let mut sc: Vec<u32> = suit_count.iter().copied().filter(|&n| n > 0).collect();
        sc.sort_unstable();
        sc == vec![2, 2]
    };
    let mut distinct: Vec<i32> = Vec::new();
    for (r, &n) in rank_count.iter().enumerate() {
        if n > 0 {
            distinct.push(r as i32);
        }
    }
    let rundown = distinct.len() >= 3 && {
        let span = distinct[distinct.len() - 1] - distinct[0];
        let wheel_span = {
            // Ace-low window: treat Ace (12) as -1.
            let mut d2: Vec<i32> = distinct
                .iter()
                .map(|&r| if r == 12 { -1 } else { r })
                .collect();
            d2.sort_unstable();
            d2[d2.len() - 1] - d2[0]
        };
        span <= 4 || wheel_span <= 4
    };
    has_pair || high_cards >= 3 || (double_suited && high_cards >= 1) || (rundown && high_cards >= 2)
}

/// Deterministic seeded sample of `count` playable combos off `board`.
fn build_range(board: [Card; 3], count: usize, seed: u64) -> PloRange {
    let board_mask = HandMask::from_cards(&board);
    let deck: Vec<Card> = (HandMask::FULL_DECK - board_mask).iter().collect();
    let mut candidates: Vec<[Card; 4]> = Vec::new();
    for a in 0..deck.len() {
        for b in (a + 1)..deck.len() {
            for c in (b + 1)..deck.len() {
                for d in (c + 1)..deck.len() {
                    let cards = [deck[a], deck[b], deck[c], deck[d]];
                    if playable(&cards) {
                        candidates.push(cards);
                    }
                }
            }
        }
    }
    // Seeded Fisher-Yates shuffle, then take the first `count`.
    let mut rng = DeterministicRng::from_seed(seed);
    let n = candidates.len();
    for i in (1..n).rev() {
        let j = (rng.next_u64() % ((i + 1) as u64)) as usize;
        candidates.swap(i, j);
    }
    let mut range = PloRange::new();
    for cards in candidates.iter().take(count) {
        let w = 0.5 + 0.25 * ((rng.next_u64() % 3) as f64);
        range.push(*cards, w).unwrap();
    }
    range
}

fn canonical_spot(board_name: &str, bucket_config: BucketConfig) -> FlopSpot {
    let board = board_by_name(board_name);
    FlopSpot {
        board,
        oop_range: build_range(board, CANONICAL_COMBOS, OOP_SEED),
        ip_range: build_range(board, CANONICAL_COMBOS, IP_SEED),
        starting_pot: 12.0,
        effective_stack: 94.0,
        flop_config: flop_menu(),
        turn_config: turn_menu(),
        river_config: river_menu(),
        bucket_config,
    }
}

fn gb(bytes: usize) -> f64 {
    bytes as f64 / 1_000_000_000.0
}

fn print_estimate_row(board_name: &str, k_label: &str, game: &FlopGame) {
    println!(
        "{board_name:>10} | {k_label:>5} | flop_infosets={:>7} | total_infosets={:>10} | strat+regret f32={:>6.3} GB f16={:>6.3} GB | solver_working={:>6.3} GB | subtrees={} (live {})",
        game.flop_infosets(),
        game.num_infosets(),
        gb(game.strategy_regret_bytes(4)),
        gb(game.strategy_regret_bytes(2)),
        gb(game.solver_working_bytes()),
        game.subtrees.len(),
        game.subtrees.iter().filter(|s| s.game.is_some()).count(),
    );
}

fn estimates() {
    println!("== measure-flop: estimate-only table (no solving) ==");
    for board_name in ["canonical", "paired", "monotone"] {
        for (label, cfg) in [
            ("exact", BucketConfig::Exact),
            ("200", BucketConfig::K(200)),
            ("100", BucketConfig::K(100)),
            ("50", BucketConfig::K(50)),
        ] {
            let game = FlopGame::new(canonical_spot(board_name, cfg)).unwrap();
            print_estimate_row(board_name, label, &game);
        }
    }
}

fn solve_one(board_name: &str, k_label: &str, iters: usize) {
    let cfg = match k_label {
        "exact" => BucketConfig::Exact,
        "200" => BucketConfig::K(200),
        "100" => BucketConfig::K(100),
        "50" => BucketConfig::K(50),
        other => panic!("unknown K label: {other}"),
    };
    let t0 = Instant::now();
    let game = FlopGame::new(canonical_spot(board_name, cfg)).unwrap();
    let build_secs = t0.elapsed().as_secs_f64();
    print_estimate_row(board_name, k_label, &game);
    let working = gb(game.solver_working_bytes());
    if working > RUN_FOOTPRINT_LIMIT {
        println!(
            "NOT RUN: solver working set {working:.2} GB exceeds the {RUN_FOOTPRINT_LIMIT} GB measurement-host limit"
        );
        return;
    }
    println!("solving {board_name} K={k_label} for {iters} iterations (build took {build_secs:.1}s)...");
    let t1 = Instant::now();
    let result = solve_flop(
        &game,
        &DcfrConfig {
            max_iterations: iters,
            target_exploitability_pct: 0.0,
            check_interval: 0,
            ..DcfrConfig::default()
        },
    );
    let secs = t1.elapsed().as_secs_f64();
    println!(
        "RESULT {board_name} K={k_label} iters={} wall={:.1}s per_1k_iters={:.1}s checker_nash={:.4}% of pot (oop_ev={:.3}, ip_ev={:.3})",
        result.iterations,
        secs,
        secs * 1000.0 / (result.iterations as f64),
        result.exploitability.nash_distance_pct,
        result.oop_game_ev,
        result.ip_game_ev,
    );
}

/// The small-spot abstraction-loss measurement spot: narrow ranges (18
/// combos/side) on a connected board, small trees, solvable exactly.
fn loss_spot(bucket_config: BucketConfig) -> FlopSpot {
    let small_menu = TreeConfig {
        bet_sizes: vec![0.75],
        include_all_in_bet: false,
        raise_sizes: vec![],
        include_all_in_raise: false,
        max_raises: 0,
    };
    FlopSpot {
        board: Card::parse_n::<3>("9c 8d 3h").unwrap(),
        oop_range: PloRange::from_str_specs(&[
            ("As Ah Kd Qc", 1.0),
            ("Ts Js Qh Kh", 1.0),
            ("7s 6s 5d 4d", 1.0),
            ("9s 9h Ad Kd", 0.8),
            ("8s 8h As Ks", 0.8),
            ("Ts Td Jh Qh", 1.0),
            ("Js Ts 7h 6h", 1.0),
            ("Ac Kc Qd Jd", 0.9),
            ("3s 3c Ah Kh", 0.7),
            ("7d 6d 5c 4c", 0.9),
            ("Qs Qd 5s 5h", 0.8),
            ("Ks Qs Js Ts", 1.0),
            ("Ad Qd 8c 7c", 0.6),
            ("6s 5s 4h 3d", 0.7),
            ("Kh Qh Th 9h", 0.5), // contains 9h: blocked vs board? no (board 9c) — fine
            ("2s 2d Ac Qc", 0.6),
            ("Ts 9d Jh 7s", 0.9), // contains 9d/8? no 8; 9d ok, Ts ok
            ("5h 4h 3s 2c", 0.8),
        ])
        .unwrap(),
        ip_range: PloRange::from_str_specs(&[
            ("Ks Kh Qd Jc", 1.0),
            ("Th Jh Qs Ks", 1.0),
            ("7h 6h 5s 4s", 1.0),
            ("9d 9s Ac Kc", 0.8),
            ("8c 8s Ad Kd", 0.8),
            ("Tc Td Jd Qd", 1.0),
            ("Jd Td 7c 6c", 1.0),
            ("As Ks Qh Jh", 0.9),
            ("3d 3s As Ks", 0.7),
            ("7s 6s 5h 4h", 0.9),
            ("Qc Qs 5d 5c", 0.8),
            ("Kh Qh Jc Tc", 1.0),
            ("Ah Qc 8s 7d", 0.6),
            ("6d 5d 4c 3c", 0.7),
            ("Kd Qd Td 9s", 0.5),
            ("2h 2c Ad Qd", 0.6),
            ("Th 9c Jc 7h", 0.9), // 9c is on the board -> filtered out at game build
            ("5c 4d 3d 2s", 0.8),
        ])
        .unwrap(),
        starting_pot: 100.0,
        effective_stack: 150.0,
        flop_config: small_menu.clone(),
        turn_config: small_menu.clone(),
        river_config: small_menu,
        bucket_config,
    }
}

fn loss(iters: usize) {
    println!("== measure-flop: small-spot abstraction loss (board 9c 8d 3h, 18x17 combos after board filtering) ==");
    for (label, cfg) in [
        ("exact", BucketConfig::Exact),
        ("9", BucketConfig::K(9)),
        ("5", BucketConfig::K(5)),
    ] {
        let game = FlopGame::new(loss_spot(cfg)).unwrap();
        let t = Instant::now();
        let result = solve_flop(
            &game,
            &DcfrConfig {
                max_iterations: iters,
                target_exploitability_pct: 0.0,
                check_interval: 0,
                ..DcfrConfig::default()
            },
        );
        println!(
            "LOSS {label:>5} | flop_infosets={:>4} | total_infosets={:>7} | iters={} wall={:.1}s | checker_nash={:.4}% of pot",
            game.flop_infosets(),
            game.num_infosets(),
            result.iterations,
            t.elapsed().as_secs_f64(),
            result.exploitability.nash_distance_pct,
        );
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(|s| s.as_str()) {
        None => estimates(),
        Some("solve") => {
            let board = args.get(1).map(|s| s.as_str()).unwrap_or("canonical");
            let k = args.get(2).map(|s| s.as_str()).unwrap_or("100");
            let iters: usize = args
                .get(3)
                .map(|s| s.parse().expect("iters must be a number"))
                .unwrap_or(DEFAULT_ITERS);
            solve_one(board, k, iters);
        }
        Some("loss") => {
            let iters: usize = args
                .get(1)
                .map(|s| s.parse().expect("iters must be a number"))
                .unwrap_or(4000);
            loss(iters);
        }
        Some(other) => {
            eprintln!("unknown mode: {other} (expected: solve | loss | no args for estimates)");
            std::process::exit(2);
        }
    }
}
