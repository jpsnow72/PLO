//! Validation tests for the constructed preflop ranges (`ranges` module,
//! method constructed-equity-v1).
//!
//! These tests are deterministic (fixed config seed; Monte Carlo sample
//! counts are reduced via config overrides so the suite stays fast) and are
//! meant to be run in release mode:
//! `cargo test --release -p plo-solve --test ranges_validation`
//!
//! The heavy tests exercise the real target config
//! (data/preflop/ranges-config-v1.json) end to end: class enumeration,
//! scoring, RFI construction for every position, one full response set
//! (BB vs BTN, the best-corroborated defense anchor), schema validation of
//! the emitted documents, and frequency-sum checks.

use plo_solve::ranges::{
    action_freqs, build_response_set, build_rfi_set, compute_features, enumerate_classes,
    equity_vs_pool, is_canonical_key, opener_pool, score_all_classes, score_from_components,
    validate_rangeset, RangesConfig, CLASS_COUNT, TOTAL_COMBOS,
};
use plo_solve::JsonValue;

fn load_config() -> RangesConfig {
    let path = format!(
        "{}/../../../data/preflop/ranges-config-v1.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).expect("read ranges-config-v1.json");
    RangesConfig::from_json_text(&text).expect("parse ranges-config-v1.json")
}

fn small_samples(cfg: &RangesConfig, vs_random: usize, vs_reference: usize, vs_opener: usize) -> RangesConfig {
    let mut c = cfg.clone();
    c.samples_vs_random = vs_random;
    c.samples_vs_reference = vs_reference;
    c.samples_vs_opener = vs_opener;
    c
}

#[test]
fn class_enumeration_is_exactly_16432_classes() {
    let classes = enumerate_classes();
    assert_eq!(classes.len(), CLASS_COUNT, "canonical class count");
    let total: u64 = classes.iter().map(|c| c.multiplicity as u64).sum();
    assert_eq!(total, TOTAL_COMBOS, "multiplicities must cover every combo exactly once");
    let mut seen = std::collections::HashSet::new();
    for c in &classes {
        assert!(seen.insert(c.key.clone()), "duplicate class key {}", c.key);
        assert!(is_canonical_key(&c.key), "key {} is not canonical", c.key);
        assert_eq!(c.combos.len() as u32, c.multiplicity, "combo list length for {}", c.key);
    }
}

#[test]
fn config_targets_cover_all_sets() {
    let cfg = load_config();
    // RFI: 5 (6max) + 8 (9max) positions.
    let rfi_count: usize = cfg.rfi_targets.values().map(|m| m.len()).sum();
    assert_eq!(rfi_count, 13, "RFI targets for all non-BB positions");
    // Responses: 6max BB 5 + SB 4 + BTN 2 = 11; 9max BB 8 + SB 7 + BTN 2 = 17.
    let resp_count: usize = cfg
        .response_targets
        .values()
        .flat_map(|m| m.values())
        .map(|m| m.len())
        .sum();
    assert_eq!(resp_count, 28, "response targets for all emitted pairs");
}

#[test]
fn monotonicity_connectedness_within_family() {
    let cfg = load_config();
    // Same pair structure (none), same suitedness (rainbow), near-equal high
    // cards; only connectedness differs. With equities held equal, the more
    // connected hand must never score lower.
    let gappy = plo_cards::Card::parse_n::<4>("As Qh 8d 5c").unwrap();
    let connected = plo_cards::Card::parse_n::<4>("As Qh Jd Tc").unwrap();
    let f_gappy = compute_features(&gappy, &cfg);
    let f_connected = compute_features(&connected, &cfg);
    assert_eq!(f_gappy.pair_kind, f_connected.pair_kind);
    assert_eq!(f_gappy.suitedness, f_connected.suitedness);
    assert!(
        f_connected.connectedness_component > f_gappy.connectedness_component,
        "connectedness component must reward the rundown: {} vs {}",
        f_connected.connectedness_component,
        f_gappy.connectedness_component
    );
    let s_gappy = score_from_components(&cfg, 0.52, 0.50, &f_gappy);
    let s_connected = score_from_components(&cfg, 0.52, 0.50, &f_connected);
    assert!(s_connected >= s_gappy, "score monotonicity in connectedness");
}

#[test]
fn premium_and_trash_feature_sanity() {
    let cfg = load_config();
    let premium = plo_cards::Card::parse_n::<4>("As Ah Ks Kh").unwrap();
    let f = compute_features(&premium, &cfg);
    assert_eq!(f.pair_kind, plo_solve::ranges::PairKind::TwoPair);
    assert_eq!(f.suitedness, "double");
    assert_eq!(f.top_pair_rank, 14);
    let trash = plo_cards::Card::parse_n::<4>("9s 7h 3d 2c").unwrap();
    let ft = compute_features(&trash, &cfg);
    assert_eq!(ft.pair_kind, plo_solve::ranges::PairKind::None);
    assert_eq!(ft.suitedness, "rainbow");
    assert!(score_from_components(&cfg, 0.62, 0.60, &f) > score_from_components(&cfg, 0.42, 0.40, &ft));
}

#[test]
fn rfi_sets_hit_targets_and_validate() {
    let cfg = load_config();
    let test_cfg = small_samples(&cfg, 800, 400, 0);
    let classes = score_all_classes(&test_cfg);
    // Premium anchor: the AAKK double-suited class must open at 100%
    // everywhere; trash must fold everywhere.
    let premium_key = {
        let classes0 = enumerate_classes();
        classes0
            .iter()
            .find(|c| {
                let f = compute_features(&c.representative, &cfg);
                f.pair_kind == plo_solve::ranges::PairKind::TwoPair
                    && f.top_pair_rank == 14
                    && f.suitedness == "double"
                    && c.representative.iter().filter(|k| k.rank().index() == 11).count() == 2
            })
            .map(|c| c.key.clone())
            .expect("AAKK double-suited class exists")
    };
    let trash_key = "9s 7h 3d 2c".to_string();
    assert!(
        classes.iter().any(|c| c.class.key == trash_key),
        "trash class key must be a real canonical class"
    );
    for table in ["6max", "9max"] {
        let positions = plo_solve::ranges::positions_for(table).unwrap();
        for &pos in positions {
            if pos == "BB" {
                continue;
            }
            let doc = build_rfi_set(&test_cfg, &classes, table, pos).expect("build RFI set");
            // Schema validation of the emitted document (round-tripped).
            let parsed = JsonValue::parse(&doc.to_json(&test_cfg)).expect("emitted JSON parses");
            let errors = validate_rangeset(&parsed);
            assert!(errors.is_empty(), "{} schema errors: {:?}", doc.id, errors);
            // Frequency sum: combo-weighted raise total within 0.5pp of target.
            let target = test_cfg.rfi_targets[table][pos].target;
            let achieved = doc.achieved["raise"];
            assert!(
                (achieved - target).abs() <= 0.005,
                "{} raise total {achieved} vs target {target}",
                doc.id
            );
            // Anchors.
            let premium = &doc.hands[&premium_key];
            assert_eq!(
                premium.get("raise").copied().unwrap_or(0.0),
                1.0,
                "{}: premium AAKKds must raise at 100%",
                doc.id
            );
            let trash = &doc.hands[&trash_key];
            assert_eq!(
                trash.get("fold").copied().unwrap_or(0.0),
                1.0,
                "{}: trash must fold at 100%",
                doc.id
            );
            // Per-hand sums.
            for (hand, actions) in &doc.hands {
                let sum: f64 = actions.values().sum();
                assert!((sum - 1.0).abs() <= 0.0005, "{} hand {hand} sums to {sum}", doc.id);
            }
        }
    }
}

#[test]
fn bb_vs_btn_response_set_hits_anchor_targets() {
    let cfg = load_config();
    let test_cfg = small_samples(&cfg, 800, 400, 2000);
    let classes = score_all_classes(&test_cfg);
    // Build the BTN RFI set, then BB's response against its actual range.
    let btn_doc = build_rfi_set(&test_cfg, &classes, "6max", "BTN").expect("BTN RFI");
    let ofreq = action_freqs(&btn_doc, &classes, "raise");
    let pool = opener_pool(&classes, &ofreq);
    let eq: Vec<f64> = classes
        .iter()
        .enumerate()
        .map(|(i, c)| {
            equity_vs_pool(
                &c.class.representative,
                &pool,
                test_cfg.samples_vs_opener,
                test_cfg.seed ^ (i as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15),
            )
        })
        .collect();
    let doc = build_response_set(&test_cfg, &classes, &eq, "6max", "BB", "BTN").expect("BB vs BTN");
    let parsed = JsonValue::parse(&doc.to_json(&test_cfg)).expect("emitted JSON parses");
    let errors = validate_rangeset(&parsed);
    assert!(errors.is_empty(), "schema errors: {errors:?}");
    let target = &test_cfg.response_targets["6max"]["BB"]["BTN"];
    assert!(
        (doc.achieved["three_bet"] - target.three_bet).abs() <= 0.005,
        "3bet {} vs target {}",
        doc.achieved["three_bet"],
        target.three_bet
    );
    assert!(
        (doc.achieved["call"] - target.call).abs() <= 0.005,
        "call {} vs target {}",
        doc.achieved["call"],
        target.call
    );
    // Trash folds; premium 3-bets (nearly) always.
    let trash = &doc.hands["9s 7h 3d 2c"];
    assert_eq!(trash.get("fold").copied().unwrap_or(0.0), 1.0, "trash must fold vs BTN open");
    let premium_key = classes
        .iter()
        .find(|c| {
            let f = compute_features(&c.class.representative, &cfg);
            f.pair_kind == plo_solve::ranges::PairKind::TwoPair
                && f.top_pair_rank == 14
                && f.suitedness == "double"
                && c.class.representative.iter().filter(|k| k.rank().index() == 11).count() == 2
        })
        .map(|c| c.class.key.clone())
        .expect("AAKK double-suited class exists");
    let premium = &doc.hands[&premium_key];
    assert!(
        premium.get("three_bet").copied().unwrap_or(0.0) >= 0.99,
        "premium AAKKds must 3-bet ~100% vs BTN open, got {premium:?}"
    );
}
