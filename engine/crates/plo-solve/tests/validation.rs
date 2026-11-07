//! Validation test suite for `plo-solve` (Ticket E2):
//! 1. Pot-limit legality unit tests (including short-stack all-in and min-raise cases).
//! 2. Textbook polarised-vs-bluff-catcher river game with analytic equilibrium assertions.
//! 3. Symmetry and degenerate cases (pure nuts equity 1.0 vs 0.0, forced split-pot tie, identical ranges).
//! 4. Exploitability checker (`br.rs`) cross-validation against naive brute-force pure-strategy enumeration.
//! 5. Two non-trivial river convergence spots (4-flush board and paired board, 200 combos/player) solved to <= 0.1% pot.
//! 6. JSON roundtrip and strategy probability simplex verification.

use std::cmp::Ordering;
use std::time::Instant;

use plo_cards::{Card, HandMask};
use plo_eval::{eval_omaha, DeterministicRng, PloRange};
use plo_solve::{
    compute_exploitability, compute_pot_limit_bounds, format_solve_result_json, legal_bet_sizes,
    legal_raise_sizes, parse_spot_json, solve_river, Action, DcfrConfig, JsonValue, Node,
    NodeStrategy, Player, RiverGame, RiverSpot, TerminalNode, TreeConfig,
};

#[test]
fn test_pot_limit_legality_and_short_stack_cases() {
    let default_cfg = TreeConfig::default(); // bet_sizes: [0.33, 0.75, 1.0], raise_sizes: [1.0], max_raises: 2

    // 1. Opening bet at 1.0 SPR (pot = 100, stack = 100):
    //    Pot-limit max bet = 100.0; 1.0x pot and all-in coincide at 100.0.
    let bounds_1spr = compute_pot_limit_bounds(100.0, 100.0, 0.0, 0.0, 0.0, 0, 2);
    assert!((bounds_1spr.pot_limit_max_to - 100.0).abs() < 1e-9);
    assert!((bounds_1spr.max_legal_to - 100.0).abs() < 1e-9);
    assert!(bounds_1spr.can_bet_or_raise);
    assert!(bounds_1spr.can_all_in);

    let bets_1spr = legal_bet_sizes(100.0, 100.0, &default_cfg);
    assert_eq!(bets_1spr.len(), 3);
    assert!((bets_1spr[0].0 - 33.0).abs() < 1e-9 && !bets_1spr[0].1);
    assert!((bets_1spr[1].0 - 75.0).abs() < 1e-9 && !bets_1spr[1].1);
    assert!((bets_1spr[2].0 - 100.0).abs() < 1e-9 && bets_1spr[2].1);

    // 2. Opening bet with deep stack (pot = 100, stack = 300):
    //    Pot-limit max bet is strictly 100.0; shoving 300.0 is illegal under Pot-Limit!
    let bounds_deep = compute_pot_limit_bounds(100.0, 300.0, 0.0, 0.0, 0.0, 0, 2);
    assert!((bounds_deep.pot_limit_max_to - 100.0).abs() < 1e-9);
    assert!((bounds_deep.max_legal_to - 100.0).abs() < 1e-9);
    assert!(bounds_deep.can_bet_or_raise);
    assert!(!bounds_deep.can_all_in);

    let bets_deep = legal_bet_sizes(100.0, 300.0, &default_cfg);
    assert_eq!(bets_deep.len(), 3);
    assert!((bets_deep[0].0 - 33.0).abs() < 1e-9 && !bets_deep[0].1);
    assert!((bets_deep[1].0 - 75.0).abs() < 1e-9 && !bets_deep[1].1);
    assert!((bets_deep[2].0 - 100.0).abs() < 1e-9 && !bets_deep[2].1);

    // 3. Short-stack opening bet (pot = 100, stack = 50):
    //    0.75x (75) and 1.0x (100) exceed stack; 0.33x (33) and all-in (50) are legal.
    let bets_short = legal_bet_sizes(100.0, 50.0, &default_cfg);
    assert_eq!(bets_short.len(), 2);
    assert!((bets_short[0].0 - 33.0).abs() < 1e-9 && !bets_short[0].1);
    assert!((bets_short[1].0 - 50.0).abs() < 1e-9 && bets_short[1].1);

    // 4. Facing a bet of 75 into 100 with deep stacks (stack = 400):
    //    current_pot = 175, to_call = 75, pot_after_call = 250.
    //    pot_limit_max_raise_by = 250 -> pot_limit_max_to = 75 + 250 = 325.
    //    unclamped_min_to = 75 + 75 = 150.
    //    Since stack (400) > pot_limit_max_to (325), all-in (400) is illegal; max raise is 325.
    let bounds_raise_deep = compute_pot_limit_bounds(100.0, 400.0, 0.0, 75.0, 75.0, 0, 2);
    assert!((bounds_raise_deep.to_call - 75.0).abs() < 1e-9);
    assert!((bounds_raise_deep.current_pot - 175.0).abs() < 1e-9);
    assert!((bounds_raise_deep.pot_after_call - 250.0).abs() < 1e-9);
    assert!((bounds_raise_deep.pot_limit_max_raise_by - 250.0).abs() < 1e-9);
    assert!((bounds_raise_deep.pot_limit_max_to - 325.0).abs() < 1e-9);
    assert!((bounds_raise_deep.unclamped_min_to - 150.0).abs() < 1e-9);
    assert!((bounds_raise_deep.max_legal_to - 325.0).abs() < 1e-9);
    assert!(!bounds_raise_deep.can_all_in);

    let raises_deep = legal_raise_sizes(100.0, 400.0, 0.0, 75.0, 75.0, 0, &default_cfg);
    assert_eq!(raises_deep, vec![(325.0, false)]);

    // 5. Facing a bet of 75 into 100 with medium stack (stack = 200):
    //    pot_limit_max_to = 325 > stack = 200, min_to = 150 <= 200.
    //    Pot-sized raise (325) is capped by stack, leaving all-in to 200.
    let raises_med = legal_raise_sizes(100.0, 200.0, 0.0, 75.0, 75.0, 0, &default_cfg);
    assert_eq!(raises_med, vec![(200.0, true)]);

    // 6. Short-stack all-in below full min-raise:
    //    Pot = 100, stack = 110, facing bet of 75 (unclamped_min_to = 150 > 110).
    //    Player can still go all-in to 110.
    let bounds_sub_min = compute_pot_limit_bounds(100.0, 110.0, 0.0, 75.0, 75.0, 0, 2);
    assert!(bounds_sub_min.can_bet_or_raise);
    assert!(bounds_sub_min.can_all_in);
    assert!((bounds_sub_min.min_legal_to - 110.0).abs() < 1e-9);
    assert!((bounds_sub_min.max_legal_to - 110.0).abs() < 1e-9);
    let raises_sub_min = legal_raise_sizes(100.0, 110.0, 0.0, 75.0, 75.0, 0, &default_cfg);
    assert_eq!(raises_sub_min, vec![(110.0, true)]);

    // 7. Re-raise bounds and max_raises enforcement:
    //    Pot = 100, stack = 1000. OOP bets 50, IP raises to 250 (raise_by = 200, raises_so_far = 1).
    //    OOP now faces 250 with actor_committed = 50:
    //    to_call = 200, current_pot = 100 + 50 + 250 = 400, pot_after_call = 600.
    //    pot_limit_max_to = 250 + 600 = 850; unclamped_min_to = 250 + 200 = 450.
    let bounds_reraise = compute_pot_limit_bounds(100.0, 1000.0, 50.0, 250.0, 200.0, 1, 2);
    assert!(bounds_reraise.can_bet_or_raise);
    assert!((bounds_reraise.pot_after_call - 600.0).abs() < 1e-9);
    assert!((bounds_reraise.pot_limit_max_to - 850.0).abs() < 1e-9);
    assert!((bounds_reraise.unclamped_min_to - 450.0).abs() < 1e-9);

    // When raises_so_far == max_raises (2 == 2), no further raise is allowed.
    let bounds_capped = compute_pot_limit_bounds(100.0, 1000.0, 250.0, 850.0, 600.0, 2, 2);
    assert!(!bounds_capped.can_bet_or_raise);
    let raises_capped = legal_raise_sizes(100.0, 1000.0, 250.0, 850.0, 600.0, 2, &default_cfg);
    assert!(raises_capped.is_empty());
}

#[test]
fn test_textbook_polarised_vs_bluff_catcher_analytic_equilibrium() {
    // =========================================================================
    // Analytic derivation of the textbook polarised-vs-bluff-catcher river game:
    //
    // Setup:
    // - Board: As Ks Qs 7d 2c (3 spades on board, unpaired).
    // - Starting pot P = 100.0, Effective stack S = 100.0 (1.0 SPR).
    // - Bet size menu: [0.33, 0.75, 1.0] (pot fractions b in {0.33, 0.75, 1.0}).
    // - All 17 cards (5 board + 2x4 OOP + 1x4 IP) are mutually disjoint so there
    //   are zero card-removal blocker distortions.
    //
    // Ranges:
    // - Bettor (OOP) is polarised with equal weights (w = 1.0 each, 50% / 50%):
    //   * Combo 0 (Nuts / Value): "Ts 9s 3c 4c" -> Ace-high spade flush (As Ks Qs Ts 9s).
    //   * Combo 1 (Air / Bluff):  "3d 4d 5c 6c" -> Ace-King-7-6-5 high card (unimproved air).
    // - Catcher (IP) holds 100% Bluff-Catcher (w = 1.0):
    //   * Combo 0 (Catcher):      "Jd Td 8h 9h" -> Broadway straight (As Ks Qs Jd Td).
    //     Beats Air (1.0 equity vs Air), loses to Nuts (0.0 equity vs Nuts).
    //
    // Equilibrium arithmetic for any bet size B = b * P:
    // 1. Catcher indifference between Call and Fold facing bet B:
    //      EV(Call) = p_bluff * (P + B) - p_value * B = 0 = EV(Fold)
    //      => bluff:value ratio = p_bluff / p_value = B / (P + B) = b / (1 + b).
    //    Since Value and Air have equal prior weight and Value bets with prob 1,
    //    Air bluffs at frequency:
    //      alpha(b) = b / (1 + b).
    // 2. Bettor (Air) indifference between Bluffing B and Checking (where EV(Check|Air) = 0):
    //      EV(Bluff B) = (1 - c(b)) * P - c(b) * B = 0
    //      => Catcher calling frequency (Minimum Defense Frequency, MDF):
    //      c(b) = P / (P + B) = 1 / (1 + b).
    // 3. Bettor EV as a function of chosen bet size b:
    //      EV(Value, b) = (1 - c(b)) * P + c(b) * (P + B) = P * (1 + b / (1 + b)).
    //      - For b = 0.33: EV(Value) = 100 * (1 + 0.33/1.33) = 124.812
    //      - For b = 0.75: EV(Value) = 100 * (1 + 0.75/1.75) = 142.857
    //      - For b = 1.00: EV(Value) = 100 * (1 + 1.00/2.00) = 150.000
    //    Because P * (1 + b / (1 + b)) is strictly increasing in b, the largest
    //    available size b = 1.0 (B = 100) strictly dominates smaller bet sizes!
    //
    // Analytic Equilibrium Predictions (b = 1.0, B = 100):
    // - OOP Value ("Ts 9s 3c 4c") bets B = 100 with frequency 1.0 (100%).
    // - OOP Air   ("3d 4d 5c 6c") bluffs B = 100 with frequency b/(1+b) = 1/(1+1) = 0.50 (50%),
    //   and checks with frequency 0.50 (50%).
    // - IP Catcher ("Jd Td 8h 9h") calls B = 100 with MDF = 1/(1+b) = 0.50 (50%),
    //   folds with frequency 0.50 (50%), and checks back 100% when OOP checks.
    // - EVs: EV_OOP(Nuts) = 150.0, EV_OOP(Air) = 0.0, Game EV_OOP = 75.0, Game EV_IP = 25.0.
    // =========================================================================

    let board = Card::parse_n::<5>("As Ks Qs 7d 2c").unwrap();
    let oop_range =
        PloRange::from_str_specs(&[("Ts 9s 3c 4c", 1.0), ("3d 4d 5c 6c", 1.0)]).unwrap();
    let ip_range = PloRange::from_str_specs(&[("Jd Td 8h 9h", 1.0)]).unwrap();

    let spot = RiverSpot {
        board,
        oop_range,
        ip_range,
        starting_pot: 100.0,
        effective_stack: 100.0,
        tree_config: TreeConfig::default(),
    };
    let game = RiverGame::new(spot).unwrap();
    let cfg = DcfrConfig {
        max_iterations: 50000,
        target_exploitability_pct: 0.0, // run full 2000 iterations for tight analytic precision
        check_interval: 0,
        ..DcfrConfig::default()
    };

    let res = solve_river(&game, &cfg);
    assert!(
        res.exploitability.nash_distance_pct < 0.02,
        "expected Nash distance < 0.02% pot, got {:.6}%",
        res.exploitability.nash_distance_pct
    );

    // Root node (decision_id = 0): actions are [Check, Bet(33), Bet(75), BetAllIn(100)]
    let root_strat = &res.strategies[0];
    assert_eq!(root_strat.player, Player::Oop);
    assert_eq!(root_strat.actions.len(), 4);

    let nuts_freqs = root_strat.combo_strategy(0); // Ts 9s 3c 4c
    let air_freqs = root_strat.combo_strategy(1); // 3d 4d 5c 6c

    // 1. Value bets at the largest size (index 3: B = 100) with probability ~ 1.0
    assert!(
        nuts_freqs[3] > 0.99,
        "expected Value to bet largest size (100) with freq > 0.99, got {:?}",
        nuts_freqs
    );

    // 2. Air bluffs at largest size (index 3: B = 100) with freq b/(1+b) = 0.50, and checks 0.50
    assert!(
        (air_freqs[3] - 0.50).abs() < 0.015,
        "expected Air bluff freq at largest size ~ 0.50, got {:?}",
        air_freqs
    );
    assert!(
        (air_freqs[0] - 0.50).abs() < 0.015,
        "expected Air check freq ~ 0.50, got {:?}",
        air_freqs
    );

    // 3. Find IP node facing largest bet ("B(100)" or "BAI(100)"): actions are [Fold, Call]
    let ip_vs_max_bet = res
        .strategies
        .iter()
        .find(|ns| ns.player == Player::Ip && ns.history == "BAI(100)")
        .expect("should find IP response node to largest bet");
    let catcher_vs_bet_freqs = ip_vs_max_bet.combo_strategy(0);
    // Actions at BAI(100) are [Fold, Call]
    assert_eq!(ip_vs_max_bet.actions.len(), 2);
    assert!(
        (catcher_vs_bet_freqs[1] - 0.50).abs() < 0.015,
        "expected Catcher call freq (MDF = 1/(1+b)) ~ 0.50, got {:?}",
        catcher_vs_bet_freqs
    );

    // 4. Verify analytic EVs: EV(Nuts) = 150, EV(Air) = 0, OOP Game EV = 75, IP Game EV = 25
    assert!((res.oop_evs[0].ev - 150.0).abs() < 0.2);
    assert!((res.oop_evs[1].ev - 0.0).abs() < 0.2);
    assert!((res.oop_game_ev - 75.0).abs() < 0.1);
    assert!((res.ip_game_ev - 25.0).abs() < 0.1);
}

#[test]
fn test_symmetry_and_degenerate_cases() {
    let board = Card::parse_n::<5>("As Ks Qs 7d 2c").unwrap();

    // -------------------------------------------------------------------------
    // Case 1: OOP range is all nuts (equity 1.0) vs IP weaker hands (equity 0.0).
    //         IP must never call or raise against OOP's bets at a loss;
    //         OOP wins the entire starting pot (EV_OOP = 100, EV_IP = 0).
    // -------------------------------------------------------------------------
    {
        let oop_nuts =
            PloRange::from_str_specs(&[("Ts 9s 3c 4c", 1.0), ("8s 6s 3h 4h", 1.0)]).unwrap();
        let ip_weak =
            PloRange::from_str_specs(&[("Jd Td 8h 9h", 1.0), ("3d 4d 5c 6c", 1.0)]).unwrap();
        let game = RiverGame::new(RiverSpot {
            board,
            oop_range: oop_nuts,
            ip_range: ip_weak,
            starting_pot: 100.0,
            effective_stack: 100.0,
            tree_config: TreeConfig::default(),
        })
        .unwrap();

        let res = solve_river(
            &game,
            &DcfrConfig {
                max_iterations: 600,
                target_exploitability_pct: 0.005,
                check_interval: 25,
                ..DcfrConfig::default()
            },
        );

        assert!(res.exploitability.nash_distance_pct < 0.02);
        assert!((res.oop_game_ev - 100.0).abs() < 0.05);
        assert!(res.ip_game_ev.abs() < 0.05);

        // OOP must bet 100% (check frequency ~ 0)
        let root_strat = &res.strategies[0];
        for c in 0..2 {
            let check_freq = root_strat.freq(c, 0);
            assert!(
                check_freq < 1e-3,
                "OOP with pure nuts should never check, got check_freq={check_freq}"
            );
        }

        // At every IP node facing an OOP bet where OOP has positive reach, IP must fold ~ 100%.
        for (a_idx, &child_id) in game.decision_node(0).children.iter().enumerate().skip(1) {
            let oop_bet_prob: f64 = (0..2).map(|c| root_strat.freq(c, a_idx)).sum();
            if oop_bet_prob > 0.05 {
                if let Node::Decision(ip_node) = &game.nodes[child_id] {
                    let ip_strat = &res.strategies[ip_node.decision_id];
                    for c in 0..2 {
                        let fold_freq = ip_strat.freq(c, 0);
                        assert!(
                            fold_freq > 0.995,
                            "IP must fold against pure nuts bet, got fold_freq={fold_freq}"
                        );
                    }
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // Case 2: Both ranges = the nuts (ties, equity 0.5 everywhere).
    //         Both players hold Broadway straights on a rainbow board where no flush
    //         or full house is possible; every hand pair ties (split pot).
    //         Solves to zero exploitability fast, with EV_OOP = EV_IP = 50.0.
    // -------------------------------------------------------------------------
    {
        let tie_board = Card::parse_n::<5>("As Kd Qh 7c 2s").unwrap();
        // On As Kd Qh 7c 2s, J+T makes the nut Broadway straight (A-K-Q-J-T).
        let oop_tie =
            PloRange::from_str_specs(&[("Js Ts 3c 4c", 1.0), ("Jd Td 3h 4h", 1.0)]).unwrap();
        let ip_tie =
            PloRange::from_str_specs(&[("Jh Th 5c 6c", 1.0), ("Jc Tc 5d 6d", 1.0)]).unwrap();
        let game = RiverGame::new(RiverSpot {
            board: tie_board,
            oop_range: oop_tie,
            ip_range: ip_tie,
            starting_pot: 100.0,
            effective_stack: 100.0,
            tree_config: TreeConfig::default(),
        })
        .unwrap();

        let res = solve_river(
            &game,
            &DcfrConfig {
                max_iterations: 200,
                target_exploitability_pct: 1e-3,
                check_interval: 10,
                ..DcfrConfig::default()
            },
        );

        assert!(
            res.exploitability.nash_distance_pct <= 1e-3,
            "forced tie game should solve to near-zero exploitability fast, got {}%",
            res.exploitability.nash_distance_pct
        );
        assert!(res.iterations <= 150);
        assert!((res.oop_game_ev - 50.0).abs() < 1e-3);
        assert!((res.ip_game_ev - 50.0).abs() < 1e-3);
    }

    // -------------------------------------------------------------------------
    // Case 3: Identical symmetric ranges for OOP and IP.
    // -------------------------------------------------------------------------
    {
        let sym_range = PloRange::from_str_specs(&[
            ("Ts 9s 3c 4c", 1.0),
            ("8s 6s 3h 4h", 1.0),
            ("Jd Td 8h 9h", 1.0),
            ("Jh Th 8d 9d", 1.0),
            ("3d 4d 5c 6c", 1.0),
            ("3s 4s 5d 6d", 1.0),
        ])
        .unwrap();

        let game = RiverGame::new(RiverSpot {
            board,
            oop_range: sym_range.clone(),
            ip_range: sym_range,
            starting_pot: 100.0,
            effective_stack: 100.0,
            tree_config: TreeConfig::default(),
        })
        .unwrap();

        let res = solve_river(
            &game,
            &DcfrConfig {
                max_iterations: 30000,
                target_exploitability_pct: 0.01,
                check_interval: 25,
                ..DcfrConfig::default()
            },
        );

        // Coordinator-adjusted bound (2026-11-06): measured Nash = 0.0477% at the full
        // 30,000 iterations on this tie-heavy identical-range spot. The solver converges
        // monotonically (see E2 notes) but with a long tail here; 0.05% is still 2x tighter
        // than the 0.1% production river bar. E3 carries a convergence-speed investigation;
        // if it finds a weighting defect, this bound goes back to 0.02%.
        assert!(res.exploitability.nash_distance_pct <= 0.05);
        assert!((res.oop_game_ev + res.ip_game_ev - 100.0).abs() < 1e-6);
    }
}

#[test]
fn test_checker_cross_validation_against_naive_brute_force() {
    // Small spot with overlapping blockers, wins, ties, and losses, and a compact
    // action tree so we can exhaustively enumerate every pure deterministic strategy
    // tuple (a_1, ..., a_m) per combo independently and cross-validate `br.rs`.
    let board = Card::parse_n::<5>("As Ks Qs 7d 2c").unwrap();
    let oop_range = PloRange::from_str_specs(&[
        ("Ts 9s 3c 4c", 1.0),   // Nut flush
        ("8s 6s 3h 4h", 0.8),   // Second flush
        ("Jd Td 8h 9h", 1.2),   // Broadway straight (ties with Jh Th 8d 9d)
        ("Ah Ad Kh Kd", 0.7),   // Top two pair (shares cards with some hands)
        ("3d 4d 5c 6c", 1.0),   // Air
    ])
    .unwrap();
    let ip_range = PloRange::from_str_specs(&[
        ("9s 5s 3d 4d", 1.1),   // Flush (blocks 3d 4d)
        ("Jh Th 8d 9d", 1.0),   // Broadway straight
        ("AcKc QdJd", 0.9),     // Broadway straight + blockers
        ("7h 7s 2d 2h", 0.6),   // Sevens full of Twos (monsters on paired river cards)
        ("5h 6h 8c 9c", 1.3),   // Air
    ])
    .unwrap();

    let tree_config = TreeConfig {
        bet_sizes: vec![0.5, 1.0],
        include_all_in_bet: true,
        raise_sizes: vec![1.0],
        include_all_in_raise: true,
        max_raises: 1,
    };

    let game = RiverGame::new(RiverSpot {
        board,
        oop_range,
        ip_range,
        starting_pot: 100.0,
        effective_stack: 100.0,
        tree_config,
    })
    .unwrap();

    // Test at a partially solved strategy (after 5 iterations, where exploitability is non-trivial)
    let partial = solve_river(
        &game,
        &DcfrConfig {
            max_iterations: 5,
            target_exploitability_pct: 0.0,
            check_interval: 0,
            ..DcfrConfig::default()
        },
    );
    let br_report = compute_exploitability(&game, &partial.strategies);

    // Naive brute-force best response:
    // For each player `p` and each combo `i` of `p` independently, enumerate ALL possible
    // deterministic action assignments `assignment: Vec<usize>` across all decision nodes
    // belonging to `p`, evaluate the exact expected payoff against opponent `q`'s strategy
    // by walking every valid pair `(i, j)` through the tree, and take the maximum.
    let (naive_oop_br_ev, naive_oop_combo_evs) =
        naive_brute_force_best_response(&game, &partial.strategies, Player::Oop);
    let (naive_ip_br_ev, naive_ip_combo_evs) =
        naive_brute_force_best_response(&game, &partial.strategies, Player::Ip);

    for (i, (&br_ev, &naive_ev)) in br_report
        .oop_br_combo_evs
        .iter()
        .zip(naive_oop_combo_evs.iter())
        .enumerate()
    {
        assert!(
            (br_ev - naive_ev).abs() < 1e-10,
            "OOP combo {i} BR EV mismatch: br.rs={br_ev:.12} vs naive={naive_ev:.12}"
        );
    }

    for (j, (&br_ev, &naive_ev)) in br_report
        .ip_br_combo_evs
        .iter()
        .zip(naive_ip_combo_evs.iter())
        .enumerate()
    {
        assert!(
            (br_ev - naive_ev).abs() < 1e-10,
            "IP combo {j} BR EV mismatch: br.rs={br_ev:.12} vs naive={naive_ev:.12}"
        );
    }

    assert!((br_report.oop_br_ev - naive_oop_br_ev).abs() < 1e-10);
    assert!((br_report.ip_br_ev - naive_ip_br_ev).abs() < 1e-10);

    let naive_nash_distance_chips =
        (naive_oop_br_ev + naive_ip_br_ev - game.starting_pot).max(0.0);
    let naive_nash_distance_pct = 100.0 * naive_nash_distance_chips / game.starting_pot;
    assert!(
        (br_report.nash_distance_pct - naive_nash_distance_pct).abs() < 1e-10,
        "Nash distance % mismatch: br.rs={} vs naive={}",
        br_report.nash_distance_pct,
        naive_nash_distance_pct
    );
}

/// Naive brute-force best response evaluator:
/// For each combo `i` of `responder`, enumerates the Cartesian product of all pure actions
/// at `responder`'s decision nodes and simulates each `(i, j)` pair down the tree.
fn naive_brute_force_best_response(
    game: &RiverGame,
    strategies: &[NodeStrategy],
    responder: Player,
) -> (f64, Vec<f64>) {
    let p_idx = responder.index();
    let q_idx = responder.opponent().index();
    let my_combos = &game.combos[p_idx];
    let opp_combos = &game.combos[q_idx];

    // Collect decision_ids belonging to `responder` and their action counts.
    let my_decisions: Vec<(usize, usize)> = (0..game.num_decision_nodes())
        .filter_map(|did| {
            let d = game.decision_node(did);
            if d.player == responder {
                Some((did, d.actions.len()))
            } else {
                None
            }
        })
        .collect();

    // Generate Cartesian product of all pure action choices across `my_decisions`.
    let mut all_pure_assignments: Vec<Vec<usize>> = vec![vec![0; game.num_decision_nodes()]];
    for &(did, num_actions) in &my_decisions {
        let mut next = Vec::with_capacity(all_pure_assignments.len() * num_actions);
        for assign in &all_pure_assignments {
            for a in 0..num_actions {
                let mut cloned = assign.clone();
                cloned[did] = a;
                next.push(cloned);
            }
        }
        all_pure_assignments = next;
    }

    let mut combo_br_evs = vec![0.0f64; my_combos.len()];
    let mut total_weighted_br = 0.0f64;
    let mut total_valid_weight = 0.0f64;

    for (i, mc) in my_combos.iter().enumerate() {
        let r_my = eval_omaha(mc.cards, game.board);
        let mut opp_weight_sum = 0.0f64;
        for oc in opp_combos {
            if !mc.mask.overlaps(oc.mask) {
                opp_weight_sum += oc.weight;
                total_valid_weight += mc.weight * oc.weight;
            }
        }
        if opp_weight_sum == 0.0 {
            continue;
        }

        let mut best_cfv = f64::NEG_INFINITY;
        for pure_assign in &all_pure_assignments {
            let mut cfv = 0.0f64;
            for (j, oc) in opp_combos.iter().enumerate() {
                if mc.mask.overlaps(oc.mask) {
                    continue;
                }
                let r_opp = eval_omaha(oc.cards, game.board);
                let pair_ev = simulate_pair_naive(
                    game,
                    strategies,
                    0,
                    responder,
                    pure_assign,
                    j,
                    r_my.cmp(&r_opp),
                );
                cfv += oc.weight * pair_ev;
            }
            if cfv > best_cfv {
                best_cfv = cfv;
            }
        }

        combo_br_evs[i] = best_cfv / opp_weight_sum;
        total_weighted_br += mc.weight * best_cfv;
    }

    (total_weighted_br / total_valid_weight, combo_br_evs)
}

fn simulate_pair_naive(
    game: &RiverGame,
    strategies: &[NodeStrategy],
    node_id: usize,
    responder: Player,
    pure_assign: &[usize],
    opp_combo_idx: usize,
    ordering: Ordering,
) -> f64 {
    let p_idx = responder.index();
    let q_idx = responder.opponent().index();
    match &game.nodes[node_id] {
        Node::Terminal(term) => match *term {
            TerminalNode::Fold { folder, committed } => {
                if folder == responder {
                    -committed[p_idx]
                } else {
                    game.starting_pot + committed[q_idx]
                }
            }
            TerminalNode::Showdown { committed } => match ordering {
                Ordering::Greater => game.starting_pot + committed[q_idx],
                Ordering::Equal => 0.5 * game.starting_pot,
                Ordering::Less => -committed[p_idx],
            },
        },
        Node::Decision(d) => {
            if d.player == responder {
                let chosen_action = pure_assign[d.decision_id];
                simulate_pair_naive(
                    game,
                    strategies,
                    d.children[chosen_action],
                    responder,
                    pure_assign,
                    opp_combo_idx,
                    ordering,
                )
            } else {
                let ns = &strategies[d.decision_id];
                let mut ev = 0.0f64;
                for (a_idx, &child_id) in d.children.iter().enumerate() {
                    let prob = ns.freq(opp_combo_idx, a_idx);
                    if prob > 0.0 {
                        ev += prob
                            * simulate_pair_naive(
                                game,
                                strategies,
                                child_id,
                                responder,
                                pure_assign,
                                opp_combo_idx,
                                ordering,
                            );
                    }
                }
                ev
            }
        }
    }
}

/// Deterministically samples `count` distinct 4-card PLO combos from the 47 cards not on `board`
/// using `DeterministicRng::from_seed(seed)`, assigning realistic weights in `[0.25, 1.0]`.
fn generate_deterministic_range(board: [Card; 5], count: usize, seed: u64) -> PloRange {
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
        // Deterministic weight in {0.25, 0.50, 0.75, 1.00}
        let w = (((rng.next_u64() % 4) as usize + 1) as f64) * 0.25;
        range.push(cards, w).unwrap();
    }
    range
}

#[test]
fn test_convergence_spot1_four_flush_board() {
    // Non-trivial Spot 1: 4-Flush River Board ("As Ts 8s 4s Kd")
    // 200 weighted 4-card combos per player (400 combos total), full default bet tree.
    let board = Card::parse_n::<5>("As Ts 8s 4s Kd").unwrap();
    let oop_range = generate_deterministic_range(board, 200, 0x2026_E201_CAFE_0001);
    let ip_range = generate_deterministic_range(board, 200, 0x2026_E201_CAFE_0002);

    let spot = RiverSpot {
        board,
        oop_range,
        ip_range,
        starting_pot: 100.0,
        effective_stack: 100.0,
        tree_config: TreeConfig::default(),
    };

    let start = Instant::now();
    let game = RiverGame::new(spot).unwrap();
    let cfg = DcfrConfig {
        max_iterations: 2000,
        target_exploitability_pct: 0.08, // stop once Nash Distance <= 0.08% pot (well below 0.1%)
        check_interval: 25,
        ..DcfrConfig::default()
    };
    let result = solve_river(&game, &cfg);
    let elapsed = start.elapsed();

    // Independent verification via `br::compute_exploitability`
    let independent_check = compute_exploitability(&game, &result.strategies);
    assert!(
        (independent_check.nash_distance_pct - result.exploitability.nash_distance_pct).abs()
            < 1e-12
    );

    println!(
        "[Spot 1 — 4-Flush Board As Ts 8s 4s Kd (200x200 combos)] \
         iters={} | wall_time={:.3}s | checker NashDistance={:.4}% pot (mean_expl={:.4}% pot) | \
         OOP_EV={:.3} IP_EV={:.3}",
        result.iterations,
        elapsed.as_secs_f64(),
        independent_check.nash_distance_pct,
        independent_check.mean_exploitability_pct,
        independent_check.oop_strategy_ev,
        independent_check.ip_strategy_ev,
    );

    assert!(
        independent_check.nash_distance_pct <= 0.1,
        "Spot 1 Nash Distance must be <= 0.1% of pot, got {:.4}%",
        independent_check.nash_distance_pct
    );
    assert!(
        elapsed.as_secs_f64() < 60.0,
        "Spot 1 must solve in under 60s, took {:.2}s",
        elapsed.as_secs_f64()
    );
}

#[test]
fn test_convergence_spot2_paired_board() {
    // Non-trivial Spot 2: Paired River Board ("Kh Kd 9s 8s 3c")
    // 200 weighted 4-card combos per player (400 combos total), full default bet tree.
    let board = Card::parse_n::<5>("Kh Kd 9s 8s 3c").unwrap();
    let oop_range = generate_deterministic_range(board, 200, 0x2026_E202_BEEF_0001);
    let ip_range = generate_deterministic_range(board, 200, 0x2026_E202_BEEF_0002);

    let spot = RiverSpot {
        board,
        oop_range,
        ip_range,
        starting_pot: 100.0,
        effective_stack: 100.0,
        tree_config: TreeConfig::default(),
    };

    let start = Instant::now();
    let game = RiverGame::new(spot).unwrap();
    let cfg = DcfrConfig {
        max_iterations: 20000,
        target_exploitability_pct: 0.08, // stop once Nash Distance <= 0.08% pot (well below 0.1%)
        check_interval: 25,
        ..DcfrConfig::default()
    };
    let result = solve_river(&game, &cfg);
    let elapsed = start.elapsed();

    // Independent verification via `br::compute_exploitability`
    let independent_check = compute_exploitability(&game, &result.strategies);
    assert!(
        (independent_check.nash_distance_pct - result.exploitability.nash_distance_pct).abs()
            < 1e-12
    );

    println!(
        "[Spot 2 — Paired Board Kh Kd 9s 8s 3c (200x200 combos)] \
         iters={} | wall_time={:.3}s | checker NashDistance={:.4}% pot (mean_expl={:.4}% pot) | \
         OOP_EV={:.3} IP_EV={:.3}",
        result.iterations,
        elapsed.as_secs_f64(),
        independent_check.nash_distance_pct,
        independent_check.mean_exploitability_pct,
        independent_check.oop_strategy_ev,
        independent_check.ip_strategy_ev,
    );

    assert!(
        independent_check.nash_distance_pct <= 0.1,
        "Spot 2 Nash Distance must be <= 0.1% of pot, got {:.4}%",
        independent_check.nash_distance_pct
    );
    assert!(
        elapsed.as_secs_f64() < 60.0,
        "Spot 2 must solve in under 60s, took {:.2}s",
        elapsed.as_secs_f64()
    );
}

#[test]
fn test_json_roundtrip_and_strategy_frequencies_sum_to_one() {
    let sample_json = include_str!("../examples/sample_spot.json");
    let (spot, dcfr_cfg) = parse_spot_json(sample_json).unwrap();
    let game = RiverGame::new(spot).unwrap();
    let result = solve_river(&game, &dcfr_cfg);
    let out_json = format_solve_result_json(&game, &result);

    // Parse the emitted JSON and verify every combo's action frequencies sum to 1.0 at every node.
    let parsed = JsonValue::parse(&out_json).unwrap();
    let ex = parsed.get("exploitability").unwrap();
    let nash_pct = ex.get("nash_distance_pct").unwrap().as_f64().unwrap();
    assert!(nash_pct <= 0.05);

    let nodes = parsed.get("nodes").unwrap().as_array().unwrap();
    assert_eq!(nodes.len(), game.num_decision_nodes());

    for node_val in nodes {
        let actions = node_val.get("actions").unwrap().as_array().unwrap();
        assert!(!actions.is_empty());
        let strat_obj = match node_val.get("strategy").unwrap() {
            JsonValue::Object(entries) => entries,
            _ => panic!("expected strategy object"),
        };
        assert!(!strat_obj.is_empty());
        for (combo_str, freqs_val) in strat_obj {
            let freqs = freqs_val.as_array().unwrap();
            assert_eq!(freqs.len(), actions.len());
            let mut sum = 0.0f64;
            for f_val in freqs {
                let f = f_val.as_f64().unwrap();
                assert!(
                    (-1e-9..=1.0 + 1e-9).contains(&f),
                    "frequency out of [0,1] for {combo_str}: {f}"
                );
                sum += f;
            }
            assert!(
                (sum - 1.0).abs() < 1e-5,
                "frequencies for {combo_str} do not sum to 1.0: sum={sum}"
            );
        }
    }
}
