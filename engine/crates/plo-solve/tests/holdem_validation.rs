use plo_cards::Card;
use plo_eval::HoldemRange;
use plo_solve::{
    format_holdem_solve_result_json, holdem_bet_sizes, parse_holdem_spot_json, solve_holdem_river,
    DcfrConfig, HoldemGame, HoldemSpot, HoldemTreeConfig, JsonValue,
};

#[test]
fn no_limit_sizes_allow_bets_larger_than_the_pot() {
    let config = HoldemTreeConfig {
        bet_sizes: vec![2.5],
        include_all_in_bet: false,
        ..HoldemTreeConfig::default()
    };
    assert_eq!(
        holdem_bet_sizes(100.0, 500.0, &config),
        vec![(250.0, false)]
    );
}

#[test]
fn short_all_in_raise_does_not_reopen_betting() {
    let spot = HoldemSpot {
        board: Card::parse_n::<5>("2c 3d 4h 5s 9c").unwrap(),
        oop_range: HoldemRange::from_str_specs(&[("Ac Ad", 1.0)]).unwrap(),
        ip_range: HoldemRange::from_str_specs(&[("Kc Kd", 1.0)]).unwrap(),
        starting_pot: 100.0,
        effective_stack: 110.0,
        tree_config: HoldemTreeConfig {
            bet_sizes: vec![0.75],
            raise_sizes: vec![1.0],
            include_all_in_bet: false,
            include_all_in_raise: true,
            max_raises: 3,
        },
    };
    let game = HoldemGame::new(spot).unwrap();
    let short_raise_response = game
        .nodes
        .iter()
        .find_map(|node| match node {
            plo_solve::Node::Decision(decision) if decision.history == "B(75)/RAI(110)" => {
                Some(decision)
            }
            _ => None,
        })
        .expect("short all-in raise should have a response node");
    assert_eq!(short_raise_response.actions.len(), 2);
    assert!(matches!(
        short_raise_response.actions[0],
        plo_solve::Action::Fold
    ));
    assert!(matches!(
        short_raise_response.actions[1],
        plo_solve::Action::Call { .. }
    ));
}

#[test]
fn holdem_json_roundtrip_exposes_game_and_two_card_strategy_keys() {
    let input = r#"{
        "board": "2c 3d 4h 5s 9c",
        "oop_range": ["Ac Ad"],
        "ip_range": ["Kc Kd"],
        "pot": 100,
        "stack": 500,
        "bet_sizes": [1.5],
        "raise_sizes": [1.0],
        "max_raises": 1,
        "iterations": 2
    }"#;
    let (spot, config) = parse_holdem_spot_json(input).unwrap();
    assert_eq!(spot.oop_range.combos()[0].cards.len(), 2);
    assert_eq!(config.max_iterations, 2);
    let game = HoldemGame::new(spot).unwrap();
    let result = solve_holdem_river(&game, &config);
    assert!(result.exploitability.nash_distance_pct.is_finite());
    let json = JsonValue::parse(&format_holdem_solve_result_json(&game, &result)).unwrap();
    assert_eq!(json.get("game").and_then(JsonValue::as_str), Some("holdem"));
    assert_eq!(
        json.get("nodes")
            .and_then(JsonValue::as_array)
            .and_then(|nodes| nodes.first())
            .and_then(|node| node.get("strategy"))
            .and_then(|strategy| strategy.get("Ac Ad"))
            .and_then(JsonValue::as_array)
            .map(<[JsonValue]>::len),
        Some(3)
    );
}

#[test]
fn exploitability_checker_reports_zero_for_forced_showdown() {
    let game = HoldemGame::new(HoldemSpot {
        board: Card::parse_n::<5>("2c 3d 4h 5s 9c").unwrap(),
        oop_range: HoldemRange::from_str_specs(&[("Ac Ad", 1.0)]).unwrap(),
        ip_range: HoldemRange::from_str_specs(&[("Kc Kd", 1.0)]).unwrap(),
        starting_pot: 100.0,
        effective_stack: 100.0,
        tree_config: HoldemTreeConfig {
            bet_sizes: Vec::new(),
            raise_sizes: Vec::new(),
            include_all_in_bet: false,
            include_all_in_raise: false,
            max_raises: 0,
        },
    })
    .unwrap();
    let result = solve_holdem_river(
        &game,
        &DcfrConfig {
            max_iterations: 5,
            target_exploitability_pct: 0.001,
            check_interval: 1,
            ..DcfrConfig::default()
        },
    );
    assert_eq!(result.iterations, 1);
    assert!(result.exploitability.nash_distance_chips.abs() < 1e-9);
}

#[test]
fn holdem_dcfr_finds_the_polarized_all_in_equilibrium() {
    let game = HoldemGame::new(HoldemSpot {
        board: Card::parse_n::<5>("As Ks Qs 7d 2c").unwrap(),
        oop_range: HoldemRange::from_str_specs(&[("Ts 9s", 1.0), ("3d 4d", 1.0)]).unwrap(),
        ip_range: HoldemRange::from_str_specs(&[("Jd Td", 1.0)]).unwrap(),
        starting_pot: 100.0,
        effective_stack: 100.0,
        tree_config: HoldemTreeConfig {
            bet_sizes: Vec::new(),
            raise_sizes: Vec::new(),
            include_all_in_bet: true,
            include_all_in_raise: false,
            max_raises: 0,
        },
    })
    .unwrap();
    let result = solve_holdem_river(
        &game,
        &DcfrConfig {
            max_iterations: 50_000,
            target_exploitability_pct: 0.0,
            ..DcfrConfig::default()
        },
    );
    let root = &result.strategies[0];
    let value_bet = root.combo_strategy(0)[1];
    let bluff_bet = root.combo_strategy(1)[1];
    let response = result
        .strategies
        .iter()
        .find(|strategy| strategy.history == "BAI(100)")
        .unwrap();
    let call = response.combo_strategy(0)[1];
    assert!(value_bet > 0.99);
    assert!((bluff_bet - 0.5).abs() < 0.03, "{bluff_bet}");
    assert!((call - 0.5).abs() < 0.03, "{call}");
    assert!(result.exploitability.nash_distance_pct < 1.0);
}

#[test]
fn holdem_river_solver_builds_strategies_for_two_card_ranges() {
    let config = HoldemTreeConfig {
        bet_sizes: vec![1.5],
        raise_sizes: vec![1.0],
        include_all_in_bet: false,
        include_all_in_raise: false,
        max_raises: 1,
    };
    let spot = HoldemSpot {
        board: Card::parse_n::<5>("2c 3d 4h 5s 9c").unwrap(),
        oop_range: HoldemRange::from_str_specs(&[("Ac Ad", 1.0)]).unwrap(),
        ip_range: HoldemRange::from_str_specs(&[("Kc Kd", 1.0)]).unwrap(),
        starting_pot: 100.0,
        effective_stack: 500.0,
        tree_config: config,
    };
    let game = HoldemGame::new(spot).unwrap();
    assert!(game.decision_node(0).actions.iter().any(|action| {
        matches!(action, plo_solve::Action::Bet { to, .. } if (*to - 150.0).abs() < 1e-9)
    }));

    let result = solve_holdem_river(
        &game,
        &DcfrConfig {
            max_iterations: 10,
            target_exploitability_pct: 0.0,
            ..DcfrConfig::default()
        },
    );
    assert_eq!(result.iterations, 10);
    assert_eq!(result.strategies.len(), game.num_decision_nodes());
    for strategy in &result.strategies {
        for combo in 0..strategy.num_combos {
            let total: f64 = strategy.combo_strategy(combo).iter().sum();
            assert!((total - 1.0).abs() < 1e-9);
        }
    }
}
