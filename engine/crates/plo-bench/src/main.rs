use std::hint::black_box;
use std::time::Instant;

use plo_cards::{Card, HandMask};
use plo_eval::{
    compute_hand_vs_hand_equity, compute_hand_vs_range_equity, eval_5cards_mask, eval_omaha_mask,
    DeterministicRng, EquityMode, PloRange,
};

const BENCH_SEED: u64 = 0xBEEF_CAFE_2026_E101;

fn main() {
    println!("================================================================");
    println!("  plo-bench — PLO Evaluator & Equity Core Benchmark Suite");
    println!("================================================================\n");

    bench_5card_eval();
    println!();
    bench_omaha_eval();
    println!();
    bench_equity_fixed_cases();
}

fn bench_5card_eval() {
    println!("--- [1] 5-Card Hand Evaluator Throughput ---");

    // Part A: Enumerate all C(52, 5) = 2,598,960 distinct 5-card hands
    let mut all_5card_masks = Vec::with_capacity(2_598_960);
    for a in 0..48u64 {
        let ma = 1u64 << a;
        for b in (a + 1)..49 {
            let mab = ma | (1u64 << b);
            for c in (b + 1)..50 {
                let mabc = mab | (1u64 << c);
                for d in (c + 1)..51 {
                    let mabcd = mabc | (1u64 << d);
                    for e in (d + 1)..52 {
                        all_5card_masks.push(HandMask(mabcd | (1u64 << e)));
                    }
                }
            }
        }
    }

    let passes = 20usize;
    let total_evals = all_5card_masks.len() * passes;
    let start = Instant::now();
    let mut checksum = 0u64;
    for _ in 0..passes {
        for &mask in &all_5card_masks {
            checksum = checksum.wrapping_add(eval_5cards_mask(black_box(mask)).raw() as u64);
        }
    }
    let elapsed = start.elapsed();
    let secs = elapsed.as_secs_f64();
    let evals_per_sec = (total_evals as f64) / secs;

    println!(
        "  Exhaustive C(52,5) x {passes} ({total_evals} evals): {:.2} ms ({:.2} M evals/sec) [checksum=0x{checksum:016x}]",
        secs * 1000.0,
        evals_per_sec / 1e6
    );

    // Part B: Randomised 5-card hands (fixed seed)
    let mut rng = DeterministicRng::from_seed(BENCH_SEED);
    let mut deck = Card::ALL;
    let sample_len = 1_000_000usize;
    let mut random_5cards = Vec::with_capacity(sample_len);
    for _ in 0..sample_len {
        let drawn = rng.sample_cards(&mut deck, 5);
        random_5cards.push(HandMask::from_cards(drawn));
    }

    let r_passes = 20usize;
    let r_total = sample_len * r_passes;
    let start_r = Instant::now();
    let mut r_checksum = 0u64;
    for _ in 0..r_passes {
        for &mask in &random_5cards {
            r_checksum = r_checksum.wrapping_add(eval_5cards_mask(black_box(mask)).raw() as u64);
        }
    }
    let r_elapsed = start_r.elapsed();
    let r_secs = r_elapsed.as_secs_f64();
    let r_evals_per_sec = (r_total as f64) / r_secs;

    println!(
        "  Random 5-card buffer ({r_total} evals):         {:.2} ms ({:.2} M evals/sec) [checksum=0x{r_checksum:016x}]",
        r_secs * 1000.0,
        r_evals_per_sec / 1e6
    );
}

fn bench_omaha_eval() {
    println!("--- [2] Omaha Best-Hand (60-combo) Evaluator Throughput ---");

    let mut rng = DeterministicRng::from_seed(BENCH_SEED ^ 0x1234_5678);
    let mut deck = Card::ALL;
    let sample_len = 500_000usize;
    let mut deals: Vec<(HandMask, HandMask)> = Vec::with_capacity(sample_len);
    for _ in 0..sample_len {
        let drawn = rng.sample_cards(&mut deck, 9);
        let hole = HandMask::from_cards(&drawn[0..4]);
        let board = HandMask::from_cards(&drawn[4..9]);
        deals.push((hole, board));
    }

    let passes = 10usize;
    let total_omaha_evals = sample_len * passes;
    let start = Instant::now();
    let mut checksum = 0u64;
    for _ in 0..passes {
        for &(hole, board) in &deals {
            checksum = checksum
                .wrapping_add(eval_omaha_mask(black_box(hole), black_box(board)).raw() as u64);
        }
    }
    let elapsed = start.elapsed();
    let secs = elapsed.as_secs_f64();
    let omaha_per_sec = (total_omaha_evals as f64) / secs;
    let effective_5card_per_sec = omaha_per_sec * 60.0;

    println!(
        "  Omaha best-hand ({total_omaha_evals} hands): {:.2} ms ({:.2} M Omaha evals/sec | {:.2} M underlying 5-card evals/sec) [checksum=0x{checksum:016x}]",
        secs * 1000.0,
        omaha_per_sec / 1e6,
        effective_5card_per_sec / 1e6
    );
}

fn bench_equity_fixed_cases() {
    println!("--- [3] Exact Turn+River & Flop/Preflop Equity Timing (Fixed Cases) ---");

    let hero = Card::parse_n::<4>("As Ks Qh Jh").unwrap();
    let villain = Card::parse_n::<4>("Td 9d 8c 7c").unwrap();
    let river_board = Card::parse_many("Qs Ts 2d 4c 9h").unwrap();
    let turn_board = Card::parse_many("Qs Ts 2d 4c").unwrap();
    let flop_board = Card::parse_many("Qs Ts 2d").unwrap();

    // 3a. Exact River Hand-vs-Hand (1 board runout)
    let iters_river = 100_000usize;
    let t0 = Instant::now();
    let mut river_res = None;
    for _ in 0..iters_river {
        river_res = Some(
            compute_hand_vs_hand_equity(
                black_box(hero),
                black_box(villain),
                black_box(&river_board),
                EquityMode::Exact,
            )
            .unwrap(),
        );
    }
    let dt_river = t0.elapsed();
    let river_res = river_res.unwrap();
    println!(
        "  [River Exact Hand-vs-Hand] {:>7.3} us/call ({iters_river} iters in {:.2} ms) -> {}",
        (dt_river.as_secs_f64() * 1e6) / (iters_river as f64),
        dt_river.as_secs_f64() * 1000.0,
        river_res
    );

    // 3b. Exact Turn Hand-vs-Hand (40 river runouts)
    let iters_turn = 10_000usize;
    let t1 = Instant::now();
    let mut turn_res = None;
    for _ in 0..iters_turn {
        turn_res = Some(
            compute_hand_vs_hand_equity(
                black_box(hero),
                black_box(villain),
                black_box(&turn_board),
                EquityMode::Exact,
            )
            .unwrap(),
        );
    }
    let dt_turn = t1.elapsed();
    let turn_res = turn_res.unwrap();
    println!(
        "  [Turn  Exact Hand-vs-Hand] {:>7.3} us/call ({iters_turn} iters in {:.2} ms) -> {}",
        (dt_turn.as_secs_f64() * 1e6) / (iters_turn as f64),
        dt_turn.as_secs_f64() * 1000.0,
        turn_res
    );

    // 3c. Exact Flop Hand-vs-Hand (C(41,2) = 820 turn+river runouts)
    let iters_flop = 1_000usize;
    let t2 = Instant::now();
    let mut flop_res = None;
    for _ in 0..iters_flop {
        flop_res = Some(
            compute_hand_vs_hand_equity(
                black_box(hero),
                black_box(villain),
                black_box(&flop_board),
                EquityMode::Exact,
            )
            .unwrap(),
        );
    }
    let dt_flop = t2.elapsed();
    let flop_res = flop_res.unwrap();
    println!(
        "  [Flop  Exact Hand-vs-Hand] {:>7.3} us/call ({iters_flop} iters in {:.2} ms) -> {}",
        (dt_flop.as_secs_f64() * 1e6) / (iters_flop as f64),
        dt_flop.as_secs_f64() * 1000.0,
        flop_res
    );

    // 3d. Exact Turn & Flop Hand-vs-Range (10-combo weighted range)
    let range = PloRange::from_str_specs(&[
        ("Td 9d 8c 7c", 1.0),
        ("Ac Ad Kh Kd", 1.0),
        ("Jd Td 9s 8s", 0.75),
        ("Qd Qc Js 9s", 0.5),
        ("Ah 5h 4d 3d", 1.0),
        ("Ks Qs Jc Tc", 0.5),
        ("9h 8h 7d 6d", 1.0),
        ("2c 2d 7h 7s", 0.25),
        ("As 4s 3c 2c", 0.8),
        ("Kc Qc Jd Td", 1.0),
    ])
    .unwrap();

    let iters_range_turn = 2_000usize;
    let t3 = Instant::now();
    let mut range_turn_res = None;
    for _ in 0..iters_range_turn {
        range_turn_res = Some(
            compute_hand_vs_range_equity(
                black_box(hero),
                black_box(&range),
                black_box(&turn_board),
                EquityMode::Exact,
            )
            .unwrap(),
        );
    }
    let dt_range_turn = t3.elapsed();
    let range_turn_res = range_turn_res.unwrap();
    println!(
        "  [Turn  Exact Hand-vs-Range (10 combos)] {:>7.3} us/call ({iters_range_turn} iters in {:.2} ms) -> {}",
        (dt_range_turn.as_secs_f64() * 1e6) / (iters_range_turn as f64),
        dt_range_turn.as_secs_f64() * 1000.0,
        range_turn_res
    );

    let iters_range_flop = 200usize;
    let t4 = Instant::now();
    let mut range_flop_res = None;
    for _ in 0..iters_range_flop {
        range_flop_res = Some(
            compute_hand_vs_range_equity(
                black_box(hero),
                black_box(&range),
                black_box(&flop_board),
                EquityMode::Exact,
            )
            .unwrap(),
        );
    }
    let dt_range_flop = t4.elapsed();
    let range_flop_res = range_flop_res.unwrap();
    println!(
        "  [Flop  Exact Hand-vs-Range (10 combos)] {:>7.3} us/call ({iters_range_flop} iters in {:.2} ms) -> {}",
        (dt_range_flop.as_secs_f64() * 1e6) / (iters_range_flop as f64),
        dt_range_flop.as_secs_f64() * 1000.0,
        range_flop_res
    );

    // 3e. Preflop Monte Carlo Hand-vs-Hand (100,000 samples, fixed seed)
    let mc_samples = 100_000usize;
    let t5 = Instant::now();
    let preflop_mc_res = compute_hand_vs_hand_equity(
        black_box(hero),
        black_box(villain),
        &[],
        EquityMode::MonteCarlo {
            samples: mc_samples,
            seed: BENCH_SEED,
        },
    )
    .unwrap();
    let dt_preflop_mc = t5.elapsed();
    println!(
        "  [Preflop MC  Hand-vs-Hand] {:>7.3} ms/call -> {}",
        dt_preflop_mc.as_secs_f64() * 1000.0,
        preflop_mc_res
    );
}
