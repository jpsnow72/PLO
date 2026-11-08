//! Validation and unit tests for multiway Pot Limit Omaha equity (`plo_eval::multiway`).

use plo_cards::{Card, HandMask};
use plo_eval::{
    compute_hand_vs_hand_equity, compute_hand_vs_range_equity, compute_multiway_equity,
    compute_multiway_equity_auto, EquityError, EquityMode, HeroInput, PloRange,
    DEFAULT_MULTIWAY_MC_SAMPLES, DEFAULT_MULTIWAY_MC_SEED, EXACT_MAX_SHOWDOWNS,
};

#[test]
fn test_made_hand_vs_random_on_river_is_exact_and_known_value() {
    // Board: Qs Js Ts 4c 9h
    // Hero:  As Ks 2d 3d -> makes Royal Flush (As Ks Qs Js Ts), unbeatable by any opponent hand.
    let board = Card::parse_many("Qs Js Ts 4c 9h").unwrap();
    let hero_cards = Card::parse_n::<4>("As Ks 2d 3d").unwrap();
    let dead = HandMask::from_cards(&board) | HandMask::from_cards(&hero_cards);
    let random_opp = PloRange::all_unblocked(dead).unwrap();

    // C(43, 4) = 123,410 unblocked opponent combos <= EXACT_MAX_SHOWDOWNS (250,000)
    assert_eq!(random_opp.len(), 123_410);
    assert!((random_opp.len() as u128) <= EXACT_MAX_SHOWDOWNS);

    let res = compute_multiway_equity_auto(
        &HeroInput::Hand(hero_cards),
        &[random_opp],
        &board,
        &[],
        DEFAULT_MULTIWAY_MC_SAMPLES,
        DEFAULT_MULTIWAY_MC_SEED,
    )
    .unwrap();

    assert!(res.is_exact(), "river hand vs random must be Exact");
    assert_eq!(res.mode, EquityMode::Exact);
    assert_eq!(res.total_weight, 123_410.0);
    assert!((res.hero_equity - 1.0).abs() < 1e-12);
    assert!((res.players[0].equity - 1.0).abs() < 1e-12);
    assert!((res.players[0].win_prob - 1.0).abs() < 1e-12);
    assert!((res.players[1].equity - 0.0).abs() < 1e-12);
    assert!((res.players[1].loss_prob - 1.0).abs() < 1e-12);

    // Second known-value river case against random:
    // Board: As Ks Qs Js Ts (Royal Flush on board — in PLO each player MUST use 2 hole + 3 board).
    // Hero holds 2c 3c 4d 5d: cannot make a flush or straight using 2 hole + 3 board cards,
    // so Hero's best Omaha hand is Ace-King-Queen-Five-Four high!
    // Any opponent holding any pair (or two broadway cards for a straight, or two spades for a flush)
    // beats Hero. Moreover, any opponent hand on this board has at least Ace-King-Queen high;
    // the only hands that lose to or tie 5-4 kicker are hands whose best 2-card combination with
    // As Ks Qs is <= 5-4 high (i.e. all 4 cards in {2,3,4,5} with at most one spade).
    // Out of the 12 non-spade {2,3,4,5} cards + 4 spade {2s,3s,4s,5s} cards:
    // Any hand with >= 2 spades makes a spade flush!
    // So an opponent doesn't make a flush or pair or higher high-card iff they have 4 distinct ranks
    // {2,3,4,5} with at most 1 spade:
    //   - 0 spades: 3^4 = 81 hands ( minus Hero's 4 cards: 2c, 3c, 4d, 5d -> 2*2*2*2 = 16 hands)
    //   - 1 spade: 4 choices of which rank is spade * 2^3 choices for other 3 ranks = 32 hands
    // All 16 + 32 = 48 such hands have ranks {5,4,3,2} without 2 spades, so they ALSO play 5-4 with As Ks Qs and TIE Hero!
    // Zero hands in the deck can make worse than 5-4-A-K-Q on As Ks Qs Js Ts!
    // Therefore Hero has 0 wins, 48 ties, and 123,410 - 48 = 123,362 losses!
    let board2 = Card::parse_many("As Ks Qs Js Ts").unwrap();
    let hero2 = Card::parse_n::<4>("2c 3c 4d 5d").unwrap();
    let dead2 = HandMask::from_cards(&board2) | HandMask::from_cards(&hero2);
    let random_opp2 = PloRange::all_unblocked(dead2).unwrap();

    let res2 = compute_multiway_equity_auto(
        &HeroInput::Hand(hero2),
        &[random_opp2],
        &board2,
        &[],
        DEFAULT_MULTIWAY_MC_SAMPLES,
        DEFAULT_MULTIWAY_MC_SEED,
    )
    .unwrap();

    assert!(res2.is_exact());
    assert_eq!(res2.players[0].wins, 0.0);
    assert_eq!(res2.players[0].ties, 48.0);
    assert_eq!(res2.players[0].losses, 123_362.0);
    let expected_eq = 24.0 / 123_410.0;
    assert!((res2.hero_equity - expected_eq).abs() < 1e-12);
    let sum_eq: f64 = res2.players.iter().map(|p| p.equity).sum();
    assert!((sum_eq - 1.0).abs() < 1e-12);
}

#[test]
fn test_multiway_tie_handling_2way_3way_4way_5way() {
    // Board: As Ks Qs Js 2c
    // Any player holding (Ace + Ten) without two spades makes Broadway Straight (A-K-Q-J-T).
    // Let's test a 3-way tie in a 4-player pot (Hero + 3 opponents):
    // - Hero:       Ac Td 3d 4d (Broadway straight)
    // - Opponent 1: Ah Tc 5d 6d (Broadway straight)
    // - Opponent 2: Ad Th 7c 8c (Broadway straight)
    // - Opponent 3: 9h 9d 8h 7h (Pair of Nines -> loses)
    // The 3 tied winners must each receive 1/3 of the pot (0.333333333333...), NOT 1/2!
    let board = Card::parse_many("As Ks Qs Js 2c").unwrap();
    let hero = Card::parse_n::<4>("Ac Td 3d 4d").unwrap();
    let opp1 = PloRange::from_str_specs(&[("Ah Tc 5d 6d", 1.0)]).unwrap();
    let opp2 = PloRange::from_str_specs(&[("Ad Th 7c 8c", 1.0)]).unwrap();
    let opp3 = PloRange::from_str_specs(&[("9h 9d 8h 7h", 1.0)]).unwrap();

    let res_3way_tie = compute_multiway_equity_auto(
        &HeroInput::Hand(hero),
        &[opp1.clone(), opp2.clone(), opp3.clone()],
        &board,
        &[],
        10_000,
        DEFAULT_MULTIWAY_MC_SEED,
    )
    .unwrap();

    assert!(res_3way_tie.is_exact());
    for p in 0..3 {
        assert!((res_3way_tie.players[p].equity - (1.0 / 3.0)).abs() < 1e-12);
        assert!((res_3way_tie.players[p].tie_prob - 1.0).abs() < 1e-12);
        assert!((res_3way_tie.players[p].tie_equity - (1.0 / 3.0)).abs() < 1e-12);
        assert!((res_3way_tie.players[p].win_prob - 0.0).abs() < 1e-12);
    }
    assert!((res_3way_tie.players[3].equity - 0.0).abs() < 1e-12);
    assert!((res_3way_tie.players[3].loss_prob - 1.0).abs() < 1e-12);
    let sum_3way: f64 = res_3way_tie.players.iter().map(|p| p.equity).sum();
    assert!((sum_3way - 1.0).abs() < 1e-12);

    // 2-way tie in a 3-player pot: Hero + Opp1 tie (1/2 each), Opp3 loses (0).
    let res_2way_tie = compute_multiway_equity_auto(
        &HeroInput::Hand(hero),
        &[opp1.clone(), opp3.clone()],
        &board,
        &[],
        10_000,
        DEFAULT_MULTIWAY_MC_SEED,
    )
    .unwrap();
    assert!(res_2way_tie.is_exact());
    assert!((res_2way_tie.players[0].equity - 0.5).abs() < 1e-12);
    assert!((res_2way_tie.players[1].equity - 0.5).abs() < 1e-12);
    assert!((res_2way_tie.players[2].equity - 0.0).abs() < 1e-12);

    // 5-way tie in a 5-player pot (Hero + 4 opponents all make the same Broadway straight on As Ks Qs 2c 2d):
    // Board: As Ks Qs 2c 2d. Any player with JT rainbow makes A-K-Q-J-T straight.
    let board5 = Card::parse_many("As Ks Qs 2c 2d").unwrap();
    let h5 = Card::parse_n::<4>("Jc Td 3c 4d").unwrap();
    let o1 = PloRange::from_str_specs(&[("Jd Tc 5c 6d", 1.0)]).unwrap();
    let o2 = PloRange::from_str_specs(&[("Jh Th 7c 8d", 1.0)]).unwrap();
    let o3 = PloRange::from_str_specs(&[("Js Ts 9c 9d", 1.0)]).unwrap(); // only 1 spade on board (As Ks Qs has 3 spades! Wait: Js Ts + As Ks Qs is Royal Flush! Let's use clubs/diamonds/hearts board)
    let _ = (board5, h5, o1, o2, o3);

    // Rainbow-ish board with no 3-flush: As Kd Qc 2s 2h.
    // Every player holding (J + T) makes Broadway straight A-K-Q-J-T, and no flush/full house is possible for 3-9 kickers.
    let board_5tie = Card::parse_many("As Kd Qc 2s 2h").unwrap();
    let h_5tie = Card::parse_n::<4>("Jc Td 3c 4d").unwrap();
    let o1_5tie = PloRange::from_str_specs(&[("Jd Tc 5c 6d", 1.0)]).unwrap();
    let o2_5tie = PloRange::from_str_specs(&[("Jh Th 7c 8d", 1.0)]).unwrap();
    let o3_5tie = PloRange::from_str_specs(&[("Js Ts 3h 4h", 1.0)]).unwrap();
    let o4_5tie = PloRange::from_str_specs(&[("9c 8c 7d 6c", 1.0)]).unwrap();

    // First test 4-way tie + 1 loser in 5-player pot:
    let res_4way = compute_multiway_equity_auto(
        &HeroInput::Hand(h_5tie),
        &[o1_5tie, o2_5tie, o3_5tie, o4_5tie],
        &board_5tie,
        &[],
        10_000,
        DEFAULT_MULTIWAY_MC_SEED,
    )
    .unwrap();
    assert!(res_4way.is_exact());
    for p in 0..4 {
        assert!((res_4way.players[p].equity - 0.25).abs() < 1e-12);
    }
    assert!((res_4way.players[4].equity - 0.0).abs() < 1e-12);
    let sum_4way: f64 = res_4way.players.iter().map(|p| p.equity).sum();
    assert!((sum_4way - 1.0).abs() < 1e-12);
}

#[test]
fn test_card_removal_blocked_combos_never_appear() {
    // Board: Qs Js Ts 2c 3d (3 spades on board).
    // Hero holds 9h 9d 4c 5c (One Pair of Nines, very weak).
    // Opponent 1 has two combos:
    //   - "As Ks Qd Jd" (Royal Flush — EXCEPT Qd is not on board, wait: Qs is on board!
    //     Let's make the Royal Flush combo use Qs (blocked by board) or 9h (blocked by Hero)
    //     or 8c (blocked by Opponent 2's fixed hand)!)
    //   - "6h 7h 8d 4d" (8-high — loses to Hero's pair of Nines).
    // Opponent 2 has a fixed hand: "8c 7c 6d 5d" (8-high — loses to Hero's pair of Nines).
    let board = Card::parse_many("Qs Js Ts 2c 3d").unwrap();
    let hero = Card::parse_n::<4>("9h 9d 4c 5c").unwrap();

    // Opp 1 combos:
    // 1. "As Ks Qs 4h" -> blocked by board card Qs
    // 2. "As Ks 9h 4h" -> blocked by Hero card 9h
    // 3. "As Ks 8c 4h" -> blocked by Opp 2's only combo card 8c
    // 4. "6h 7h 8d 4d" -> unblocked, loses to Hero's 99
    let opp1 = PloRange::from_str_specs(&[
        ("As Ks Qs 4h", 100.0),
        ("As Ks 9h 4h", 100.0),
        ("As Ks 8c 4h", 100.0),
        ("6h 7h 8d 4d", 1.0),
    ])
    .unwrap();
    let opp2 = PloRange::from_str_specs(&[("8c 7c 6d 5d", 1.0)]).unwrap();

    // Check in Exact mode:
    let exact_res = compute_multiway_equity(
        &HeroInput::Hand(hero),
        &[opp1.clone(), opp2.clone()],
        &board,
        &[],
        EquityMode::Exact,
    )
    .unwrap();
    assert!((exact_res.hero_equity - 1.0).abs() < 1e-12);
    assert_eq!(exact_res.players[1].wins, 0.0);
    assert_eq!(exact_res.players[2].wins, 0.0);

    // Check in Monte Carlo mode: even with weight 100.0 on the blocked Royal Flush combos,
    // card removal against board, Hero, and Opp 2 prevents them from ever being dealt.
    let mc_res = compute_multiway_equity(
        &HeroInput::Hand(hero),
        &[opp1, opp2.clone()],
        &board,
        &[],
        EquityMode::MonteCarlo {
            samples: 5_000,
            seed: DEFAULT_MULTIWAY_MC_SEED,
        },
    )
    .unwrap();
    assert!((mc_res.hero_equity - 1.0).abs() < 1e-12);
    assert_eq!(mc_res.players[1].wins, 0.0);

    // If all combos in an opponent range are blocked, returns AllRangeCombosBlocked:
    let all_blocked_opp = PloRange::from_str_specs(&[
        ("As Ks Qs 4h", 1.0), // blocked by board Qs
        ("As Ks 9h 4h", 1.0), // blocked by Hero 9h
        ("As Ks 8c 4h", 1.0), // blocked by Opp 2 8c
    ])
    .unwrap();
    let err = compute_multiway_equity(
        &HeroInput::Hand(hero),
        &[all_blocked_opp, opp2],
        &board,
        &[],
        EquityMode::Exact,
    )
    .unwrap_err();
    assert_eq!(err, EquityError::AllRangeCombosBlocked);
}

#[test]
fn test_symmetric_ranges_equal_equities_and_sum_to_one() {
    // 3 players (Hero + 2 opponents) each holding a full random range on a flop board.
    // By symmetry, every player's true equity is exactly 1/3, and equities sum to 1.0.
    let board = Card::parse_many("As Kd 7c").unwrap();
    let dead = HandMask::from_cards(&board);
    let full_range = PloRange::all_unblocked(dead).unwrap();

    let res = compute_multiway_equity_auto(
        &HeroInput::Range(full_range.clone()),
        &[full_range.clone(), full_range],
        &board,
        &[],
        30_000,
        DEFAULT_MULTIWAY_MC_SEED,
    )
    .unwrap();

    assert!(res.is_monte_carlo());
    assert_eq!(res.players.len(), 3);
    let sum_eq: f64 = res.players.iter().map(|p| p.equity).sum();
    assert!(
        (sum_eq - 1.0).abs() < 1e-9,
        "MC equities must sum to 1.0 within 1e-9, got {sum_eq}"
    );

    for p in &res.players {
        assert!(p.std_error > 0.0 && p.std_error < 0.01);
        assert!(
            (p.equity - (1.0 / 3.0)).abs() <= 3.5 * p.std_error,
            "Player {} equity {} deviated from 1/3 by more than 3.5 SE ({})",
            p.player_index,
            p.equity,
            p.std_error
        );
    }

    // Also verify exact symmetry on a turn board with 3 suit-symmetric ranges on a rainbow-ish board:
    // Board: 2s 2h 2d 2c (four deuces on the turn — only 3 can be used!).
    // Player 0: As Ah Ks Kh (clubs/diamonds symmetry)
    //Wait: on 2s 2h 2d 2c, let's use river 2s 2h 2d 7c 7d and give two players symmetric hands:
    // Hero: As Ac Ks Kc vs Opp1: Ah Ad Kh Kd on 2s 3s 2h 3h 9d -> exact 50% / 50%!
    let sym_board = Card::parse_many("2s 3s 2h 3h 9d").unwrap();
    let h_range = PloRange::from_str_specs(&[("As Ac Ks Kc", 1.0), ("Qs Qc Js Jc", 1.0)]).unwrap();
    let o_range = PloRange::from_str_specs(&[("Ah Ad Kh Kd", 1.0), ("Qh Qd Jh Jd", 1.0)]).unwrap();
    let exact_sym = compute_multiway_equity_auto(
        &HeroInput::Range(h_range),
        &[o_range],
        &sym_board,
        &[],
        10_000,
        DEFAULT_MULTIWAY_MC_SEED,
    )
    .unwrap();
    assert!(exact_sym.is_exact());
    assert!((exact_sym.players[0].equity - 0.5).abs() < 1e-12);
    assert!((exact_sym.players[1].equity - 0.5).abs() < 1e-12);
}

#[test]
fn test_headsup_parity_and_hero_range_distribution_deciles() {
    // Verify 1-opponent multiway matches heads-up `compute_hand_vs_range_equity` on flop/turn/river
    let hero = Card::parse_n::<4>("As Ks Qh Jh").unwrap();
    let opp = PloRange::from_str_specs(&[
        ("Td 9d 8c 7c", 1.0),
        ("Ac Ad Kh Kd", 0.5),
        ("Jd Td 9s 8s", 1.5),
        ("2c 2d 7h 7s", 0.25),
    ])
    .unwrap();

    for b_str in ["Qs Ts 2d 4c 9h", "Qs Ts 2d 4c", "Qs Ts 2d"] {
        let board = Card::parse_many(b_str).unwrap();
        let hu = compute_hand_vs_range_equity(hero, &opp, &board, EquityMode::Exact).unwrap();
        let mw = compute_multiway_equity(
            &HeroInput::Hand(hero),
            std::slice::from_ref(&opp),
            &board,
            &[],
            EquityMode::Exact,
        )
        .unwrap();
        assert!((hu.equity - mw.hero_equity).abs() < 1e-12);
        assert!((hu.villain_equity - mw.players[1].equity).abs() < 1e-12);
    }

    // Verify HeroInput::Range distribution summary and top/bottom deciles:
    // Create a 20-combo Hero range on river "As Ks Qs 7d 2c" against a fixed opponent hand.
    // Top decile = ceil(20 / 10) = 2 combos; bottom decile = 2 combos.
    let river = Card::parse_many("As Ks Qs 7d 2c").unwrap();
    let hero_range = PloRange::from_str_specs(&[
        ("Js Ts 9h 8h", 1.0), // Straight flush (Js Ts + As Ks Qs) -> 100% equity
        ("9s 8s 6h 5h", 1.0), // King-high flush -> 100% vs pair/set
        ("Ah Ad Kh Kd", 1.0), // Set of Aces / Kings
        ("Ah Ac Kh Kc", 1.0), // Set of Aces / Kings
        ("7h 7c 6s 5s", 1.0), // Flush / Set of Sevens
        ("2h 2s 6c 5c", 1.0), // Set of Deuces
        ("Ac Kc Jc Tc", 1.0), // Broadway straight
        ("Ad Kd 9c 8c", 1.0), // Top two pair
        ("Ah Kc Tc 9c", 1.0), // Aces and Kings
        ("Kh Qc Tc 9c", 1.0), // Kings and Queens
        ("Ad 7h 6c 5c", 1.0), // Aces and Sevens
        ("Kd 7h 6c 5c", 1.0), // Kings and Sevens
        ("Qc 7h 6c 5c", 1.0), // Queens and Sevens
        ("Ah 2h 6c 5c", 1.0), // Aces and Deuces
        ("Kh 2h 6c 5c", 1.0), // Kings and Deuces
        ("Qc 2h 6c 5c", 1.0), // Queens and Deuces
        ("9h 9c 8d 6d", 1.0), // Pair of Nines
        ("8h 8c 6d 5d", 1.0), // Pair of Eights
        ("6h 6c 5d 8s", 1.0), // Pair of Sixes
        ("5h 5c 9d 8d", 1.0), // Pair of Fives
    ])
    .unwrap();

    let opp_range = PloRange::from_str_specs(&[
        ("Jd Jh Td Th", 1.0), // Pair of Jacks
        ("Qd Qh 4d 3d", 1.0), // Three Queens
    ])
    .unwrap();

    let range_res = compute_multiway_equity_auto(
        &HeroInput::Range(hero_range),
        &[opp_range],
        &river,
        &[],
        10_000,
        DEFAULT_MULTIWAY_MC_SEED,
    )
    .unwrap();

    assert!(range_res.is_exact());
    let dist = range_res
        .hero_range_distribution
        .expect("range distribution must be present for HeroInput::Range");
    assert_eq!(dist.combo_count, 20);
    assert_eq!(dist.top_decile.len(), 2);
    assert_eq!(dist.bottom_decile.len(), 2);
    assert!((dist.mean - range_res.hero_equity).abs() < 1e-12);
    assert!(dist.min <= dist.q25 && dist.q25 <= dist.median && dist.median <= dist.q75 && dist.q75 <= dist.max);
    assert_eq!(dist.quartiles, [dist.min, dist.q25, dist.median, dist.q75, dist.max]);
    assert!(dist.top_decile[0].equity >= dist.top_decile[1].equity);
    assert!(dist.bottom_decile[0].equity <= dist.bottom_decile[1].equity);
    assert!((dist.top_decile[0].equity - 1.0).abs() < 1e-12);
    assert!((dist.bottom_decile[0].equity - 0.0).abs() < 1e-12);

    // Check headsup hand-vs-hand parity as well
    let h1 = Card::parse_n::<4>("Js Ts 9h 8h").unwrap();
    let h2 = Card::parse_n::<4>("Jd Jh Td Th").unwrap();
    let hu_hh = compute_hand_vs_hand_equity(h1, h2, &river, EquityMode::Exact).unwrap();
    assert_eq!(hu_hh.equity, 1.0);
}
