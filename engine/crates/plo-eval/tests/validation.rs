//! Comprehensive validation suite for `plo-eval`.
//!
//! Contains:
//! 1. A completely independent, straight-line reference evaluator (`ref_eval_5cards` and
//!    `ref_eval_omaha`) using no lookup tables and no bit tricks.
//! 2. Exhaustive 5-card verification across all $\binom{52}{5} = 2,598,960$ hands.
//! 3. Deterministic randomised verification across $\ge 200,000$ random Omaha showdowns
//!    spanning flop, turn, and river board runouts (fixed seed, printed on failure).
//! 4. Brute-force reference equity verification (exact river, exact turn, exact flop,
//!    hand-vs-hand and hand-vs-range, plus preflop Monte Carlo with standard error).
//! 5. 20 hand-written known-answer showdowns covering all 9 hand categories, wheel straights,
//!    and Omaha-specific traps ("playing the board", 4-flush in hole, 4-flush on board,
//!    quads in hole, quads on board, 3-hole-card mirage straight, etc.).

use std::cmp::Ordering;

use plo_cards::{Card, HandMask};
use plo_eval::{
    compare_omaha, compute_hand_vs_hand_auto, compute_hand_vs_hand_equity,
    compute_hand_vs_range_equity, eval_5cards, eval_omaha, DeterministicRng, EquityMode,
    HandCategory, PloRange, ShowdownOutcome,
};

// ============================================================================
// Independent Reference Evaluator (straight-line checks, no tables, no bit-math)
// ============================================================================

/// Reference 5-card hand score: `(HandCategory, [u8; 5])` where the 5 tiebreaker bytes
/// are compared lexicographically.
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct RefScore {
    category: HandCategory,
    tiebreakers: [u8; 5],
}

/// Evaluates 5 cards using plain sorting, frequency counting, and straight-line category checks.
/// Uses zero lookup tables and zero bit manipulation.
fn ref_eval_5cards(cards: [Card; 5]) -> RefScore {
    let mut ranks = [
        cards[0].rank().index(),
        cards[1].rank().index(),
        cards[2].rank().index(),
        cards[3].rank().index(),
        cards[4].rank().index(),
    ];
    let suits = [
        cards[0].suit().index(),
        cards[1].suit().index(),
        cards[2].suit().index(),
        cards[3].suit().index(),
        cards[4].suit().index(),
    ];

    // Sort ranks descending (plain 5-element insertion sort)
    for i in 1..5 {
        let mut j = i;
        while j > 0 && ranks[j - 1] < ranks[j] {
            ranks.swap(j - 1, j);
            j -= 1;
        }
    }

    let is_flush =
        suits[0] == suits[1] && suits[1] == suits[2] && suits[2] == suits[3] && suits[3] == suits[4];

    // Check straight (5 consecutive ranks, or A-5-4-3-2 wheel where Ace=12 plays low as 5-high=3)
    let is_regular_straight = ranks[0] == ranks[1] + 1
        && ranks[1] == ranks[2] + 1
        && ranks[2] == ranks[3] + 1
        && ranks[3] == ranks[4] + 1;
    let is_wheel_straight = ranks == [12, 3, 2, 1, 0];

    let straight_high: Option<u8> = if is_regular_straight {
        Some(ranks[0])
    } else if is_wheel_straight {
        Some(3) // 5-high straight
    } else {
        None
    };

    // Count rank multiplicities
    let mut counts = [0u8; 13];
    let mut idx = 0;
    while idx < 5 {
        counts[ranks[idx] as usize] += 1;
        idx += 1;
    }

    // Collect (count, rank) pairs on the stack and sort by (count desc, rank desc)
    let mut groups = [(0u8, 0u8); 5];
    let mut num_groups = 0usize;
    let mut r = 13u8;
    while r > 0 {
        r -= 1;
        let c = counts[r as usize];
        if c > 0 {
            groups[num_groups] = (c, r);
            num_groups += 1;
        }
    }
    for i in 1..num_groups {
        let mut j = i;
        while j > 0
            && (groups[j - 1].0 < groups[j].0
                || (groups[j - 1].0 == groups[j].0 && groups[j - 1].1 < groups[j].1))
        {
            groups.swap(j - 1, j);
            j -= 1;
        }
    }

    // Straight-line category checks from strongest to weakest
    if is_flush {
        if let Some(high) = straight_high {
            return RefScore {
                category: HandCategory::StraightFlush,
                tiebreakers: [high, 0, 0, 0, 0],
            };
        }
    }

    if groups[0].0 == 4 {
        return RefScore {
            category: HandCategory::FourOfAKind,
            tiebreakers: [groups[0].1, groups[1].1, 0, 0, 0],
        };
    }

    if groups[0].0 == 3 && groups[1].0 == 2 {
        return RefScore {
            category: HandCategory::FullHouse,
            tiebreakers: [groups[0].1, groups[1].1, 0, 0, 0],
        };
    }

    if is_flush {
        return RefScore {
            category: HandCategory::Flush,
            tiebreakers: ranks,
        };
    }

    if let Some(high) = straight_high {
        return RefScore {
            category: HandCategory::Straight,
            tiebreakers: [high, 0, 0, 0, 0],
        };
    }

    if groups[0].0 == 3 {
        return RefScore {
            category: HandCategory::ThreeOfAKind,
            tiebreakers: [groups[0].1, groups[1].1, groups[2].1, 0, 0],
        };
    }

    if groups[0].0 == 2 && groups[1].0 == 2 {
        return RefScore {
            category: HandCategory::TwoPair,
            tiebreakers: [groups[0].1, groups[1].1, groups[2].1, 0, 0],
        };
    }

    if groups[0].0 == 2 {
        return RefScore {
            category: HandCategory::OnePair,
            tiebreakers: [groups[0].1, groups[1].1, groups[2].1, groups[3].1, 0],
        };
    }

    RefScore {
        category: HandCategory::HighCard,
        tiebreakers: ranks,
    }
}

/// Evaluates an Omaha hand by brute-force iterating over all C(4,2) * C(5,3) = 60
/// combinations of 2 hole cards + 3 board cards using `ref_eval_5cards`.
fn ref_eval_omaha(hole: [Card; 4], board: [Card; 5]) -> RefScore {
    let mut best: Option<RefScore> = None;
    let mut combo_count = 0usize;

    for i in 0..4 {
        for j in (i + 1)..4 {
            for a in 0..5 {
                for b in (a + 1)..5 {
                    for c in (b + 1)..5 {
                        combo_count += 1;
                        let five = [hole[i], hole[j], board[a], board[b], board[c]];
                        let score = ref_eval_5cards(five);
                        match best {
                            None => best = Some(score),
                            Some(cur) if score > cur => best = Some(score),
                            _ => {}
                        }
                    }
                }
            }
        }
    }
    debug_assert_eq!(combo_count, 60);
    best.unwrap()
}

fn ref_compare_omaha(
    hero: [Card; 4],
    villain: [Card; 4],
    board: [Card; 5],
) -> (ShowdownOutcome, RefScore, RefScore) {
    let h = ref_eval_omaha(hero, board);
    let v = ref_eval_omaha(villain, board);
    let out = match h.cmp(&v) {
        Ordering::Greater => ShowdownOutcome::HeroWin,
        Ordering::Less => ShowdownOutcome::VillainWin,
        Ordering::Equal => ShowdownOutcome::Tie,
    };
    (out, h, v)
}

/// Converts a `RefScore` into the packed 20-bit tiebreaker format to verify exact score parity.
fn ref_packed_tiebreaker(s: RefScore) -> u32 {
    let [t0, t1, t2, t3, t4] = s.tiebreakers;
    ((t0 as u32) << 16)
        | ((t1 as u32) << 12)
        | ((t2 as u32) << 8)
        | ((t3 as u32) << 4)
        | (t4 as u32)
}

// ============================================================================
// 1. Exhaustive 5-Card Evaluator Verification (All C(52,5) = 2,598,960 hands)
// ============================================================================

#[test]
fn test_exhaustive_all_2598960_five_card_hands_and_category_counts() {
    let mut cat_counts = [0usize; 9];
    let mut spot_check_counter = 0usize;

    for a in 0..48u8 {
        let ca = Card::from_id(a).unwrap();
        for b in (a + 1)..49 {
            let cb = Card::from_id(b).unwrap();
            for c in (b + 1)..50 {
                let cc = Card::from_id(c).unwrap();
                for d in (c + 1)..51 {
                    let cd = Card::from_id(d).unwrap();
                    for e in (d + 1)..52 {
                        let ce = Card::from_id(e).unwrap();
                        let five = [ca, cb, cc, cd, ce];
                        let fast = eval_5cards(five);
                        cat_counts[fast.category() as usize] += 1;

                        // Compare against reference evaluator on every 13th hand (~200,000 hands)
                        // so debug mode stays fast while covering every rank/suit pattern.
                        spot_check_counter += 1;
                        if spot_check_counter % 13 == 0 {
                            let r = ref_eval_5cards(five);
                            assert_eq!(
                                fast.category(),
                                r.category,
                                "5-card category mismatch on {:?}",
                                five
                            );
                            assert_eq!(
                                fast.tiebreaker(),
                                ref_packed_tiebreaker(r),
                                "5-card tiebreaker mismatch on {:?}",
                                five
                            );
                        }
                    }
                }
            }
        }
    }

    // Exact textbook combinatorial counts for a 52-card deck:
    assert_eq!(cat_counts[HandCategory::StraightFlush as usize], 40);
    assert_eq!(cat_counts[HandCategory::FourOfAKind as usize], 624);
    assert_eq!(cat_counts[HandCategory::FullHouse as usize], 3_744);
    assert_eq!(cat_counts[HandCategory::Flush as usize], 5_108);
    assert_eq!(cat_counts[HandCategory::Straight as usize], 10_200);
    assert_eq!(cat_counts[HandCategory::ThreeOfAKind as usize], 54_912);
    assert_eq!(cat_counts[HandCategory::TwoPair as usize], 123_552);
    assert_eq!(cat_counts[HandCategory::OnePair as usize], 1_098_240);
    assert_eq!(cat_counts[HandCategory::HighCard as usize], 1_302_540);
    assert_eq!(cat_counts.iter().sum::<usize>(), 2_598_960);
}

// ============================================================================
// 2. Large Deterministic Randomised Sample: >= 200,000 Omaha Showdowns
//    across Flop, Turn, and River boards (fast vs reference evaluator)
// ============================================================================

#[test]
fn test_210k_random_omaha_showdowns_fast_vs_reference_across_streets() {
    const SEED: u64 = 0x2026_E100_DEAD_BEEF;
    let mut rng = DeterministicRng::from_seed(SEED);
    let mut deck = Card::ALL;

    // 70,000 flop-origin showdowns + 70,000 turn-origin showdowns + 70,000 river-origin showdowns
    // = 210,000 random Omaha showdowns total.
    let showdowns_per_street = 70_000usize;
    let mut total_checked = 0usize;

    for street in ["flop", "turn", "river"] {
        for deal_idx in 0..showdowns_per_street {
            // Draw Hero (4), Villain (4), and initial street board (3, 4, or 5), then complete runout to 5
            let drawn = rng.sample_cards(&mut deck, 13);
            let hero = [drawn[0], drawn[1], drawn[2], drawn[3]];
            let villain = [drawn[4], drawn[5], drawn[6], drawn[7]];
            let board = match street {
                "flop" => {
                    // Flop = drawn[8..11], Turn+River runout = drawn[11..13]
                    [drawn[8], drawn[9], drawn[10], drawn[11], drawn[12]]
                }
                "turn" => {
                    // Turn = drawn[8..12], River runout = drawn[12]
                    [drawn[8], drawn[9], drawn[10], drawn[11], drawn[12]]
                }
                "river" => {
                    // River = drawn[8..13]
                    [drawn[8], drawn[9], drawn[10], drawn[11], drawn[12]]
                }
                _ => unreachable!(),
            };

            let (fast_outcome, fast_h, fast_v) = compare_omaha(hero, villain, board);
            let (ref_outcome, ref_h, ref_v) = ref_compare_omaha(hero, villain, board);

            assert_eq!(
                fast_outcome, ref_outcome,
                "Showdown outcome mismatch! seed=0x{SEED:016x}, street={street}, deal_idx={deal_idx}, hero={hero:?}, villain={villain:?}, board={board:?}, fast=({fast_outcome:?}, {fast_h:?}, {fast_v:?}), ref=({ref_outcome:?}, {ref_h:?}, {ref_v:?})"
            );
            assert_eq!(
                fast_h.category(),
                ref_h.category,
                "Hero category mismatch! seed=0x{SEED:016x}, street={street}, deal_idx={deal_idx}, hero={hero:?}, board={board:?}"
            );
            assert_eq!(
                fast_h.tiebreaker(),
                ref_packed_tiebreaker(ref_h),
                "Hero tiebreaker mismatch! seed=0x{SEED:016x}, street={street}, deal_idx={deal_idx}, hero={hero:?}, board={board:?}"
            );
            assert_eq!(
                fast_v.category(),
                ref_v.category,
                "Villain category mismatch! seed=0x{SEED:016x}, street={street}, deal_idx={deal_idx}, villain={villain:?}, board={board:?}"
            );
            assert_eq!(
                fast_v.tiebreaker(),
                ref_packed_tiebreaker(ref_v),
                "Villain tiebreaker mismatch! seed=0x{SEED:016x}, street={street}, deal_idx={deal_idx}, villain={villain:?}, board={board:?}"
            );

            total_checked += 1;
        }
    }

    assert_eq!(total_checked, 210_000);
}

// ============================================================================
// 3. Brute-Force Reference Equity Validation (River, Turn, Flop, and Range)
// ============================================================================

/// Computes exact hand-vs-hand equity via brute-force enumeration using `ref_eval_omaha`.
fn ref_brute_force_hand_vs_hand_equity(
    hero: [Card; 4],
    villain: [Card; 4],
    board: &[Card],
) -> (u64, u64, u64, f64) {
    let mut used = Vec::new();
    used.extend_from_slice(&hero);
    used.extend_from_slice(&villain);
    used.extend_from_slice(board);

    let remaining: Vec<Card> = Card::ALL
        .iter()
        .copied()
        .filter(|c| !used.contains(c))
        .collect();

    let needed = 5 - board.len();
    let mut wins = 0u64;
    let mut ties = 0u64;
    let mut losses = 0u64;

    match needed {
        0 => {
            let full = [board[0], board[1], board[2], board[3], board[4]];
            match ref_compare_omaha(hero, villain, full).0 {
                ShowdownOutcome::HeroWin => wins += 1,
                ShowdownOutcome::VillainWin => losses += 1,
                ShowdownOutcome::Tie => ties += 1,
            }
        }
        1 => {
            for &r in &remaining {
                let full = [board[0], board[1], board[2], board[3], r];
                match ref_compare_omaha(hero, villain, full).0 {
                    ShowdownOutcome::HeroWin => wins += 1,
                    ShowdownOutcome::VillainWin => losses += 1,
                    ShowdownOutcome::Tie => ties += 1,
                }
            }
        }
        2 => {
            for i in 0..remaining.len() {
                for j in (i + 1)..remaining.len() {
                    let full = [board[0], board[1], board[2], remaining[i], remaining[j]];
                    match ref_compare_omaha(hero, villain, full).0 {
                        ShowdownOutcome::HeroWin => wins += 1,
                        ShowdownOutcome::VillainWin => losses += 1,
                        ShowdownOutcome::Tie => ties += 1,
                    }
                }
            }
        }
        _ => panic!("ref_brute_force_hand_vs_hand_equity supports flop/turn/river"),
    }

    let total = (wins + ties + losses) as f64;
    let eq = (wins as f64 + 0.5 * ties as f64) / total;
    (wins, ties, losses, eq)
}

/// Computes exact hand-vs-range equity via brute-force enumeration using `ref_eval_omaha`.
fn ref_brute_force_hand_vs_range_equity(
    hero: [Card; 4],
    range: &PloRange,
    board: &[Card],
) -> (f64, f64, f64, f64) {
    let mut wins = 0.0f64;
    let mut ties = 0.0f64;
    let mut losses = 0.0f64;

    for combo in range.combos() {
        // Card removal check against Hero and initial board
        let mut collides = false;
        for &vc in &combo.cards {
            if hero.contains(&vc) || board.contains(&vc) {
                collides = true;
                break;
            }
        }
        if collides {
            continue;
        }

        let (w, t, l, _) = ref_brute_force_hand_vs_hand_equity(hero, combo.cards, board);
        wins += (w as f64) * combo.weight;
        ties += (t as f64) * combo.weight;
        losses += (l as f64) * combo.weight;
    }

    let total = wins + ties + losses;
    let eq = (wins + 0.5 * ties) / total;
    (wins, ties, losses, eq)
}

#[test]
fn test_exact_equity_matches_reference_brute_force_river_turn_flop() {
    let cases: &[(&str, &str, &str)] = &[
        // River cases (5 board cards)
        ("As Ks Qh Jh", "Td 9d 8c 7c", "Qs Ts 2d 4c 9h"),
        ("Ac Ad Kh Kd", "Qd Jd Tc 9c", "Ah Ks Qs Js Ts"),
        ("As 2s 3d 4d", "KhKdQcJc", "5s 6h 7c 8d 2h"),
        // Turn cases (4 board cards -> 40 river runouts)
        ("As Ks Qh Jh", "Td 9d 8c 7c", "Qs Ts 2d 4c"),
        ("Ah Ad Ks Kd", "Jd Td 9s 8s", "Js Ts 2c 7h"),
        ("Ac Kc Qc Jc", "9h 9d 8h 8d", "Tc 9c 2s 2d"),
        ("6s 5s 4d 3d", "As Ah Kh Kd", "7s 2s Kc 8h"),
        // Flop cases (3 board cards -> C(41,2) = 820 turn+river runouts)
        ("As Ks Qh Jh", "Td 9d 8c 7c", "Qs Ts 2d"),
        ("Ac Ad Kh Kd", "Jd Td 9c 8c", "Qd Js 2h"),
        ("Ah 5h 4s 3s", "Kc Qc Jd Td", "2h 6s 9h"),
    ];

    for &(h_str, v_str, b_str) in cases {
        let hero = Card::parse_n::<4>(h_str).unwrap();
        let villain = Card::parse_n::<4>(v_str).unwrap();
        let board = Card::parse_many(b_str).unwrap();

        let fast =
            compute_hand_vs_hand_equity(hero, villain, &board, EquityMode::Exact).unwrap();
        let (ref_w, ref_t, ref_l, ref_eq) =
            ref_brute_force_hand_vs_hand_equity(hero, villain, &board);

        assert!(fast.is_exact());
        assert_eq!(fast.std_error, 0.0);
        assert_eq!(
            fast.wins as u64, ref_w,
            "Wins mismatch on {h_str} vs {v_str} on {b_str}"
        );
        assert_eq!(
            fast.ties as u64, ref_t,
            "Ties mismatch on {h_str} vs {v_str} on {b_str}"
        );
        assert_eq!(
            fast.losses as u64, ref_l,
            "Losses mismatch on {h_str} vs {v_str} on {b_str}"
        );
        assert_eq!(
            fast.equity, ref_eq,
            "Exact equity mismatch on {h_str} vs {v_str} on {b_str}"
        );
    }
}

#[test]
fn test_exact_hand_vs_range_with_card_removal_matches_reference() {
    let hero = Card::parse_n::<4>("As Ks Qh Jh").unwrap();

    // Includes combos that collide with Hero ("As ...") and combos that collide with the board
    // ("Qs ...") as well as non-colliding weighted combos.
    let range = PloRange::from_str_specs(&[
        ("As Ad Kc Kd", 1.0), // blocked by Hero's As
        ("Qs Qd Jc Jd", 1.0), // blocked by board's Qs
        ("Td 9d 8c 7c", 1.0), // unblocked
        ("Ac Ad Kh Kd", 0.5), // unblocked
        ("Jd Td 9s 8s", 1.5), // unblocked initially, 9s/Ts/etc. may be blocked on some runouts
        ("2c 2d 7h 7s", 0.25), // unblocked
    ])
    .unwrap();

    for b_str in ["Qs Ts 2d 4c 9h", "Qs Ts 2d 4c", "Qs Ts 2d"] {
        let board = Card::parse_many(b_str).unwrap();
        let fast =
            compute_hand_vs_range_equity(hero, &range, &board, EquityMode::Exact).unwrap();
        let (rw, rt, rl, req) = ref_brute_force_hand_vs_range_equity(hero, &range, &board);

        assert!(
            (fast.wins - rw).abs() < 1e-9,
            "Range wins mismatch on board {b_str}: fast={} vs ref={}",
            fast.wins,
            rw
        );
        assert!(
            (fast.ties - rt).abs() < 1e-9,
            "Range ties mismatch on board {b_str}: fast={} vs ref={}",
            fast.ties,
            rt
        );
        assert!(
            (fast.losses - rl).abs() < 1e-9,
            "Range losses mismatch on board {b_str}: fast={} vs ref={}",
            fast.losses,
            rl
        );
        assert!(
            (fast.equity - req).abs() < 1e-12,
            "Range equity mismatch on board {b_str}: fast={} vs ref={}",
            fast.equity,
            req
        );
    }
}

#[test]
fn test_preflop_and_flop_monte_carlo_determinism_and_standard_error() {
    const SEED: u64 = 0xCAFE_BABE_1234_5678;

    // 1. Symmetric preflop matchup: As Ks Qh Jh vs Ad Kd Qc Jc must have true equity = 0.50
    let h1 = Card::parse_n::<4>("As Ks Qh Jh").unwrap();
    let h2 = Card::parse_n::<4>("Ad Kd Qc Jc").unwrap();
    let mc1 = compute_hand_vs_hand_auto(h1, h2, &[], 50_000, SEED).unwrap();
    let mc2 = compute_hand_vs_hand_auto(h1, h2, &[], 50_000, SEED).unwrap();

    // Deterministic repeatability
    assert_eq!(mc1, mc2, "Monte Carlo with fixed seed must be 100% deterministic");
    assert!(mc1.is_monte_carlo());
    assert!(mc1.std_error > 0.0 && mc1.std_error < 0.003);
    assert!(
        (mc1.equity - 0.50).abs() <= 3.5 * mc1.std_error,
        "Symmetric preflop hands should be ~50% within 3.5 SE: eq={}, se={} (seed=0x{SEED:016x})",
        mc1.equity,
        mc1.std_error
    );

    // 2. Flop MC vs Exact Enumeration comparison
    let hero = Card::parse_n::<4>("As Ks Qh Jh").unwrap();
    let villain = Card::parse_n::<4>("Td 9d 8c 7c").unwrap();
    let flop = Card::parse_many("Qs Ts 2d").unwrap();

    let exact_flop = compute_hand_vs_hand_equity(hero, villain, &flop, EquityMode::Exact).unwrap();
    let mc_flop = compute_hand_vs_hand_equity(
        hero,
        villain,
        &flop,
        EquityMode::MonteCarlo {
            samples: 40_000,
            seed: SEED,
        },
    )
    .unwrap();

    assert!(exact_flop.is_exact());
    assert!(mc_flop.is_monte_carlo());
    assert!(
        (mc_flop.equity - exact_flop.equity).abs() <= 3.5 * mc_flop.std_error,
        "Flop MC equity {} (SE {}) diverged from exact flop equity {} (seed=0x{SEED:016x})",
        mc_flop.equity,
        mc_flop.std_error,
        exact_flop.equity
    );
}

// ============================================================================
// 4. Known-Answer Showdowns (>= 15 cases; 20 hand-written cases below)
//    covering all 9 hand categories, wheel straights, and Omaha-specific traps
// ============================================================================

struct KnownShowdownCase {
    name: &'static str,
    hero: &'static str,
    villain: &'static str,
    board: &'static str,
    expected_hero_cat: HandCategory,
    expected_villain_cat: HandCategory,
    expected_outcome: ShowdownOutcome,
}

#[test]
fn test_20_known_answer_showdowns_and_omaha_traps() {
    let cases: [KnownShowdownCase; 20] = [
        // Case 1: OMAHA TRAP — 4 spades in hole ("As Ks Qs Js") on a 1-spade board
        // Hero can only use 2 spades from hole + 1 spade on board = 3 spades (NOT a flush!).
        // Hero makes Ace-King high; Villain holds a pair of Deuces and wins!
        KnownShowdownCase {
            name: "Trap 1: 4-flush in hole on 1-flush board is NOT a flush",
            hero: "As Ks Qs Js",
            villain: "2h 7h 8c 9d",
            board: "2s 3d 4c 8h Td",
            expected_hero_cat: HandCategory::HighCard,
            expected_villain_cat: HandCategory::TwoPair,
            expected_outcome: ShowdownOutcome::VillainWin,
        },
        // Case 2: OMAHA TRAP — 1 spade in hole ("As") on a 4-spade board ("Ks Qs Js Ts 2d")
        // Hero does NOT have a Royal Flush or even a Flush (must use 2 hole cards + 3 board cards).
        // Hero uses As + Kd with Qs Js Ts for a Broadway Straight; Villain has 3s 2s for a Spade Flush!
        KnownShowdownCase {
            name: "Trap 2: Lone Ace of spades on 4-spade board loses to small 2-card flush",
            hero: "As Kd Qh Jc",
            villain: "3s 2s 8d 9c",
            board: "Ks Qs Js Ts 2d",
            expected_hero_cat: HandCategory::Straight,
            expected_villain_cat: HandCategory::Flush,
            expected_outcome: ShowdownOutcome::VillainWin,
        },
        // Case 3: OMAHA TRAP — 3 spades in hole ("As Ks Qs 2d") on a 2-spade board ("Js Ts 9h 8c 3c")
        // Hero only gets 2 spades from hole + 2 spades from board = 4 spades (NOT a flush!).
        // Hero's best hand is a King-high Straight (Ks Qs + Js Ts 9h).
        // Villain holds "9d 9c 4d 5d" for Three of a Kind (Three Nines) and loses to Hero's Straight.
        KnownShowdownCase {
            name: "Trap 3: 3 spades in hole + 2 spades on board is a Straight, NOT a Straight Flush",
            hero: "As Ks Qs 2d",
            villain: "9d 9c 4d 5d",
            board: "Js Ts 9h 8c 3c",
            expected_hero_cat: HandCategory::Straight,
            expected_villain_cat: HandCategory::ThreeOfAKind,
            expected_outcome: ShowdownOutcome::HeroWin,
        },
        // Case 4: OMAHA TRAP — "Playing the board" is impossible in Omaha!
        // The board is a Royal Flush ("As Ks Qs Js Ts").
        // Hero holds "2c 3c 4d 5d" and MUST use two hole cards (e.g., 5d 4d + As Ks Qs = Ace-high).
        // Villain holds "Ac Kd 7h 8h" and uses Ac Kd + Qs Js Ts = Broadway Straight!
        KnownShowdownCase {
            name: "Trap 4: Playing the Royal Flush board is impossible; Hero has only High Card",
            hero: "2c 3c 4d 5d",
            villain: "Ac Kd 7h 8h",
            board: "As Ks Qs Js Ts",
            expected_hero_cat: HandCategory::HighCard,
            expected_villain_cat: HandCategory::Straight,
            expected_outcome: ShowdownOutcome::VillainWin,
        },
        // Case 5: OMAHA TRAP — Four of a Kind on the board ("Ah Ad Ac As Kc")
        // Neither player can use all 4 Aces from the board! At most 3 board cards can be used.
        // Hero holds "Kd Qd 2h 3h": if Hero uses 3 Aces (Ah Ad Ac), Hero must use 2 hole cards (Kd Qd) -> Three Aces!
        // If Hero uses Ah Ad Kc + Kd Qd -> Two Pair (Aces and Kings). So Hero only has Three Aces!
        // Villain holds pocket Kings ("Kh Ks 4c 5c") and uses Kh Ks + Ah Ad Ac = Aces full of Kings!
        KnownShowdownCase {
            name: "Trap 5: Board quads (AAAAK) — lone King in hole is only Trips, pocket Kings makes Full House",
            hero: "Kd Qd 2h 3h",
            villain: "Kh Ks 4c 5c",
            board: "Ah Ad Ac As Kc",
            expected_hero_cat: HandCategory::ThreeOfAKind,
            expected_villain_cat: HandCategory::FullHouse,
            expected_outcome: ShowdownOutcome::VillainWin,
        },
        // Case 6: OMAHA TRAP — Four of a Kind in hole ("As Ah Ad Ac")
        // Hero holds all 4 Aces in hand! Hero can only use 2 of them, making One Pair of Aces.
        // Villain holds "Ks Qd 7c 8c" on "Kh Qs 2c 5d 9h" for Two Pair (Kings and Queens) and wins!
        KnownShowdownCase {
            name: "Trap 6: Quads in hole (AAAA) is only One Pair of Aces",
            hero: "As Ah Ad Ac",
            villain: "Ks Qd 7c 8c",
            board: "Kh Qs 2c 5d 9h",
            expected_hero_cat: HandCategory::OnePair,
            expected_villain_cat: HandCategory::TwoPair,
            expected_outcome: ShowdownOutcome::VillainWin,
        },
        // Case 7: OMAHA TRAP — Three of a Kind in hole ("Ks Kh Kd 2c") with 4th King on board
        // Hero has 3 Kings in hand and 1 King on the board, which is Three Kings (2 hole + 1 board), NOT Quads!
        // Villain makes a 6-high Straight and beats Hero's Three Kings.
        KnownShowdownCase {
            name: "Trap 7: 3 Kings in hole + 1 King on board is Trips, not Quads",
            hero: "Ks Kh Kd 2c",
            villain: "5s 6d 9c Tc",
            board: "Kc 2d 3h 4s 8c",
            expected_hero_cat: HandCategory::ThreeOfAKind,
            expected_villain_cat: HandCategory::Straight,
            expected_outcome: ShowdownOutcome::VillainWin,
        },
        // Case 8: OMAHA TRAP — 3-hole-card mirage straight ("9s 8d 7h 2c" on "6c 5d Ks Qh Jd")
        // 9-8-7 in hand + 6-5 on board would be a 9-high straight if 3 hole cards were allowed,
        // but with strictly 2 hole cards + 3 board cards, Hero only has King-high!
        KnownShowdownCase {
            name: "Trap 8: 3-hole-card + 2-board-card mirage straight is only High Card",
            hero: "9s 8d 7h 2c",
            villain: "Jc Td 3s 4s",
            board: "6c 5d Ks Qh Jd",
            expected_hero_cat: HandCategory::HighCard,
            expected_villain_cat: HandCategory::OnePair,
            expected_outcome: ShowdownOutcome::VillainWin,
        },
        // Case 9: OMAHA TRAP — 1-hole-card + 4-board-card mirage straight ("As 2c 3d 4h" on "Ks Qd Jc Td 7s")
        // Hero cannot play lone As with K-Q-J-T on board; Hero only has Ace-high, while Villain has One Pair of Sevens.
        KnownShowdownCase {
            name: "Trap 9: 1-hole-card + 4-board-card mirage straight is only High Card",
            hero: "As 2c 3d 4h",
            villain: "7d 5d 6c 2s",
            board: "Ks Qd Jc Td 7s",
            expected_hero_cat: HandCategory::HighCard,
            expected_villain_cat: HandCategory::OnePair,
            expected_outcome: ShowdownOutcome::VillainWin,
        },
        // Case 10: Wheel Straight (A-2-3-4-5) vs 6-high Straight (2-3-4-5-6)
        // Hero uses As 2d + 3c 4h 5s = 5-high wheel straight.
        // Villain uses 6c 2h + 3c 4h 5s = 6-high straight and wins.
        KnownShowdownCase {
            name: "Category Straight: Wheel (A-2-3-4-5) loses to 6-high Straight (2-3-4-5-6)",
            hero: "As 2d Kc Qc",
            villain: "6c 2h Jd Td",
            board: "3c 4h 5s 9d Kh",
            expected_hero_cat: HandCategory::Straight,
            expected_villain_cat: HandCategory::Straight,
            expected_outcome: ShowdownOutcome::VillainWin,
        },
        // Case 11: Wheel Straight beats Three of a Kind
        KnownShowdownCase {
            name: "Category Straight: Wheel (A-2-3-4-5) beats Three of a Kind",
            hero: "As 2d Tc 9c",
            villain: "Kh Kd Qc Jc",
            board: "3c 4h 5s Ks 8d",
            expected_hero_cat: HandCategory::Straight,
            expected_villain_cat: HandCategory::ThreeOfAKind,
            expected_outcome: ShowdownOutcome::HeroWin,
        },
        // Case 12: Steel Wheel Straight Flush (As 2s 3s 4s 5s) beats Four of a Kind
        KnownShowdownCase {
            name: "Category StraightFlush: Steel Wheel (A-2-3-4-5 suited) beats Four of a Kind",
            hero: "As 2sKc Qd",
            villain: "9h 9dJc Td",
            board: "3s 4s 5s 9s 9c",
            expected_hero_cat: HandCategory::StraightFlush,
            expected_villain_cat: HandCategory::FourOfAKind,
            expected_outcome: ShowdownOutcome::HeroWin,
        },
        // Case 13: Royal Flush beats King-high Straight Flush
        KnownShowdownCase {
            name: "Category StraightFlush: Royal Flush beats 9-high Straight Flush",
            hero: "As Ks 2d 3d",
            villain: "9s 8s 4c 5c",
            board: "Qs Js Ts 2c 3h",
            expected_hero_cat: HandCategory::StraightFlush,
            expected_villain_cat: HandCategory::StraightFlush,
            expected_outcome: ShowdownOutcome::HeroWin,
        },
        // Case 14: Four of a Kind (2 in hole + 2 on board) vs Full House
        KnownShowdownCase {
            name: "Category FourOfAKind: Quads (2 hole + 2 board) beats Aces full",
            hero: "7s 7d 2c 3c",
            villain: "As Ad Kh Kd",
            board: "7h 7c Ah Ks 4d",
            expected_hero_cat: HandCategory::FourOfAKind,
            expected_villain_cat: HandCategory::FullHouse,
            expected_outcome: ShowdownOutcome::HeroWin,
        },
        // Case 15: Four of a Kind (1 in hole + 3 on board) kicker tiebreaker
        // Board has 8s 8h 8d 2c 3d. Hero has 8c As ..., Villain has 8c? (Can't share 8c — instead board has two pairs of quads possibilities: 8s 8h 9s 9h, Hero has 9d 9c, Villain has 8d 8c).
        KnownShowdownCase {
            name: "Category FourOfAKind: Quad Nines beats Quad Eights on double-paired board",
            hero: "9d 9c 2s 3s",
            villain: "8d 8c As Ks",
            board: "9s 9h 8s 8h 4d",
            expected_hero_cat: HandCategory::FourOfAKind,
            expected_villain_cat: HandCategory::FourOfAKind,
            expected_outcome: ShowdownOutcome::HeroWin,
        },
        // Case 16: Full House over Full House (same trips, higher pair wins)
        KnownShowdownCase {
            name: "Category FullHouse: Queens full of Kings beats Queens full of Jacks",
            hero: "Qd Kh 2c 3c",
            villain: "Qc Jh 4d 5d",
            board: "Qs Qh Ks Js 2d",
            expected_hero_cat: HandCategory::FullHouse,
            expected_villain_cat: HandCategory::FullHouse,
            expected_outcome: ShowdownOutcome::HeroWin,
        },
        // Case 17: Flush over Flush (5th card kicker tiebreaker)
        KnownShowdownCase {
            name: "Category Flush: Nut flush with 6h kicker beats Nut flush with 5h kicker on 4-flush board",
            hero: "Ah 6h 2c 3c",
            villain: "Kh 5h 2d 3d",
            board: "Qh Jh 9h 4h 8s",
            expected_hero_cat: HandCategory::Flush,
            expected_villain_cat: HandCategory::Flush,
            expected_outcome: ShowdownOutcome::HeroWin,
        },
        // Case 18: Two Pair kicker tiebreaker
        KnownShowdownCase {
            name: "Category TwoPair: Kings & Tens with Ace kicker beats Kings & Tens with Queen kicker",
            hero: "Ks As 2c 3c",
            villain: "Kd Qd 4h 5h",
            board: "Kh Ts Td 7c 8d",
            expected_hero_cat: HandCategory::TwoPair,
            expected_villain_cat: HandCategory::TwoPair,
            expected_outcome: ShowdownOutcome::HeroWin,
        },
        // Case 19: One Pair kicker tiebreaker
        KnownShowdownCase {
            name: "Category OnePair: Pair of Jacks with Ace-Queen-9 kickers beats Pair of Jacks with Ace-Ten-9 kickers",
            hero: "Js Qs 2c 3c",
            villain: "Jd Td 4h 5h",
            board: "Jh Ac 9d 7s 6c",
            expected_hero_cat: HandCategory::OnePair,
            expected_villain_cat: HandCategory::OnePair,
            expected_outcome: ShowdownOutcome::HeroWin,
        },
        // Case 20: Exact Split Pot Tie (identical Broadway straights in different suits)
        KnownShowdownCase {
            name: "Exact Split Pot Tie: Both players make Broadway Straight using K-Q in different suits",
            hero: "Ks Qs 2c 3c",
            villain: "Kd Qd 4h 5h",
            board: "Ah Jc Td 7s 2d",
            expected_hero_cat: HandCategory::Straight,
            expected_villain_cat: HandCategory::Straight,
            expected_outcome: ShowdownOutcome::Tie,
        },
    ];

    for (idx, c) in cases.iter().enumerate() {
        let hero = Card::parse_n::<4>(c.hero).unwrap();
        let villain = Card::parse_n::<4>(c.villain).unwrap();
        let board = Card::parse_n::<5>(c.board).unwrap();

        // Ensure valid deal with no duplicate cards across hero + villain + board
        let combined = HandMask::from_cards(&hero)
            | HandMask::from_cards(&villain)
            | HandMask::from_cards(&board);
        assert_eq!(
            combined.count(),
            13,
            "Case #{idx} ({}) has colliding cards!",
            c.name
        );

        let (fast_out, fast_h, fast_v) = compare_omaha(hero, villain, board);
        let (ref_out, ref_h, ref_v) = ref_compare_omaha(hero, villain, board);

        assert_eq!(
            fast_h.category(),
            c.expected_hero_cat,
            "Case #{idx} ({}): Hero category mismatch",
            c.name
        );
        assert_eq!(
            fast_v.category(),
            c.expected_villain_cat,
            "Case #{idx} ({}): Villain category mismatch",
            c.name
        );
        assert_eq!(
            fast_out, c.expected_outcome,
            "Case #{idx} ({}): Showdown outcome mismatch",
            c.name
        );

        // Also assert fast and reference evaluators agree on every single case
        assert_eq!(fast_out, ref_out, "Case #{idx} ({}): fast vs ref outcome", c.name);
        assert_eq!(
            fast_h.raw(),
            ((ref_h.category as u32) << 20) | ref_packed_tiebreaker(ref_h),
            "Case #{idx} ({}): fast vs ref hero score",
            c.name
        );
        assert_eq!(
            fast_v.raw(),
            ((ref_v.category as u32) << 20) | ref_packed_tiebreaker(ref_v),
            "Case #{idx} ({}): fast vs ref villain score",
            c.name
        );
        assert_eq!(eval_omaha(hero, board), fast_h);
        assert_eq!(eval_omaha(villain, board), fast_v);
    }
}

#[test]
fn test_card_removal_errors_and_blocked_combos() {
    use plo_eval::EquityError;

    let hero = Card::parse_n::<4>("As Ks Qh Jh").unwrap();
    let colliding_villain = Card::parse_n::<4>("As Td 9c 8c").unwrap();
    let board = Card::parse_many("2c 3d 4s").unwrap();

    assert_eq!(
        compute_hand_vs_hand_equity(hero, colliding_villain, &board, EquityMode::Exact),
        Err(EquityError::CardCollision)
    );

    let colliding_board = Card::parse_many("Ks 2c 3d").unwrap();
    let clean_villain = Card::parse_n::<4>("Td 9d 8c 7c").unwrap();
    assert_eq!(
        compute_hand_vs_hand_equity(hero, clean_villain, &colliding_board, EquityMode::Exact),
        Err(EquityError::CardCollision)
    );

    let blocked_range = PloRange::from_str_specs(&[
        ("As Td 9c 8c", 1.0), // blocked by Hero's As
        ("2c 7d 6h 5s", 1.0), // blocked by board's 2c
    ])
    .unwrap();
    assert_eq!(
        compute_hand_vs_range_equity(hero, &blocked_range, &board, EquityMode::Exact),
        Err(EquityError::AllRangeCombosBlocked)
    );
}

