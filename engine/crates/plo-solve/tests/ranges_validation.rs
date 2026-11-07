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
    action_freqs, build_continuation_set, build_response_set, build_rfi_set, compute_features,
    enumerate_classes, equity_vs_pool, is_canonical_key, opening_weighted_totals, opener_pool,
    score_all_classes, score_from_components, validate_rangeset, ContinuationsConfig, RangesConfig,
    CLASS_COUNT, TOTAL_COMBOS,
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

fn small_samples(
    cfg: &RangesConfig,
    vs_random: usize,
    vs_reference: usize,
    vs_opener: usize,
    vs_three_bettor: usize,
) -> RangesConfig {
    let mut c = cfg.clone();
    c.samples_vs_random = vs_random;
    c.samples_vs_reference = vs_reference;
    c.samples_vs_opener = vs_opener;
    if let Some(cont) = &mut c.continuations {
        cont.samples_vs_three_bettor = vs_three_bettor;
    }
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
    let test_cfg = small_samples(&cfg, 800, 400, 0, 0);
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
    let test_cfg = small_samples(&cfg, 800, 400, 2000, 2000);
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

#[test]
fn continuations_config_covers_three_matchups() {
    let cfg = load_config();
    let cont = cfg
        .continuations
        .as_ref()
        .expect("config must carry the continuations_v11 section");
    assert_eq!(cont.method, "constructed-equity-v1.1");
    // The v1.1 internal construction parameters, as chosen for this lane:
    // continue half the opening range by weight, split 82% call / 18%
    // four_bet. These are internal parameters, not published anchors.
    assert!((cont.continue_fraction_of_open - 0.5).abs() < 1e-12);
    assert!((cont.call_fraction_of_continue - 0.82).abs() < 1e-12);
    assert!((cont.four_bet_fraction_of_continue - 0.18).abs() < 1e-12);
    assert_eq!(cont.cross_check_status, "no published anchor - method disclosed");
    let pairs: Vec<(&str, &str)> = cont
        .matchups
        .iter()
        .map(|m| (m.continuer.as_str(), m.three_bettor.as_str()))
        .collect();
    assert_eq!(pairs, vec![("BTN", "BB"), ("BTN", "SB"), ("CO", "BTN")]);
    let ids: Vec<String> = cont.matchups.iter().map(ContinuationsConfig::set_id).collect();
    assert_eq!(
        ids,
        vec![
            "constructed-v1.1-6max-btn-vs-bb-3bet".to_string(),
            "constructed-v1.1-6max-btn-vs-sb-3bet".to_string(),
            "constructed-v1.1-6max-co-vs-btn-3bet".to_string(),
        ]
    );
}

#[test]
fn continuation_sets_hit_internal_targets_and_validate() {
    let cfg = load_config();
    let test_cfg = small_samples(&cfg, 800, 400, 2000, 2000);
    let classes = score_all_classes(&test_cfg);
    let cont = test_cfg
        .continuations
        .as_ref()
        .expect("continuations_v11 section present")
        .clone();
    let multiplicity: std::collections::HashMap<String, u32> = classes
        .iter()
        .map(|c| (c.class.key.clone(), c.class.multiplicity))
        .collect();
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
    // Equity vs each opener's RFI range (needed to build the three-bettors'
    // response sets, whose three_bet slices the continuations face).
    let eq_vs_opener = |opener: &str| -> Vec<f64> {
        let doc = build_rfi_set(&test_cfg, &classes, "6max", opener).expect("opener RFI set");
        let ofreq = action_freqs(&doc, &classes, "raise");
        let pool = opener_pool(&classes, &ofreq);
        classes
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
            .collect()
    };
    let eq_btn = eq_vs_opener("BTN");
    let eq_co = eq_vs_opener("CO");
    let want_call = cont.continue_fraction_of_open * cont.call_fraction_of_continue;
    let want_fb = cont.continue_fraction_of_open * cont.four_bet_fraction_of_continue;
    for matchup in &cont.matchups {
        let rfi_doc =
            build_rfi_set(&test_cfg, &classes, "6max", &matchup.continuer).expect("continuer RFI set");
        assert_eq!(rfi_doc.id, matchup.opener_rfi_set, "config names the generated RFI set");
        let ofreq = action_freqs(&rfi_doc, &classes, "raise");
        let eq_open = if matchup.continuer == "BTN" { &eq_btn } else { &eq_co };
        let tb_doc = build_response_set(
            &test_cfg,
            &classes,
            eq_open,
            "6max",
            &matchup.three_bettor,
            &matchup.continuer,
        )
        .expect("three-bettor response set");
        assert_eq!(tb_doc.id, matchup.three_bettor_set, "config names the generated response set");
        let tb_freq = action_freqs(&tb_doc, &classes, "three_bet");
        let pool = opener_pool(&classes, &tb_freq);
        let eq_tb: Vec<f64> = classes
            .iter()
            .enumerate()
            .map(|(i, c)| {
                equity_vs_pool(
                    &c.class.representative,
                    &pool,
                    cont.samples_vs_three_bettor,
                    test_cfg.seed ^ (i as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F),
                )
            })
            .collect();
        let doc = build_continuation_set(&test_cfg, &classes, &eq_tb, &ofreq, matchup)
            .expect("continuation set");
        assert_eq!(doc.id, ContinuationsConfig::set_id(matchup));
        assert_eq!(doc.context, "vs_three_bet");
        assert_eq!(doc.target_kind, "internal");
        // Schema validation of the emitted document (round-tripped).
        let parsed = JsonValue::parse(&doc.to_json(&test_cfg)).expect("emitted JSON parses");
        let errors = validate_rangeset(&parsed);
        assert!(errors.is_empty(), "{} schema errors: {:?}", doc.id, errors);
        // Provenance honesty: v1.1 method, no external sources, derivation
        // names both input sets and labels the targets internal.
        let prov = parsed.get("provenance").expect("provenance block present");
        assert_eq!(
            prov.get("method").and_then(|v| v.as_str()),
            Some("constructed-equity-v1.1")
        );
        assert_eq!(
            prov.get("sources").and_then(|v| v.as_array()).map(|a| a.len()),
            Some(0),
            "{}: continuation sets must not cite external sources",
            doc.id
        );
        let derivation = prov.get("derivation").and_then(|v| v.as_str()).unwrap_or("");
        assert!(
            derivation.contains(&matchup.opener_rfi_set)
                && derivation.contains(&matchup.three_bettor_set),
            "{}: derivation must name both input sets: {derivation}",
            doc.id
        );
        assert!(
            derivation.contains("INTERNAL CONSTRUCTION PARAMETERS"),
            "{}: derivation must label targets internal: {derivation}",
            doc.id
        );
        // Per-class action sums and the eligibility invariant: a class the
        // opener never opens can never continue.
        for (i, c) in classes.iter().enumerate() {
            let actions = &doc.hands[&c.class.key];
            let sum: f64 = actions.values().sum();
            assert!(
                (sum - 1.0).abs() <= 0.0005,
                "{} hand {} sums to {sum}",
                doc.id,
                c.class.key
            );
            if ofreq[i] <= 0.0 {
                assert_eq!(
                    actions.get("fold").copied().unwrap_or(0.0),
                    1.0,
                    "{}: never-opened class {} must fold at 100%",
                    doc.id,
                    c.class.key
                );
                assert_eq!(actions.get("call").copied().unwrap_or(0.0), 0.0);
                assert_eq!(actions.get("four_bet").copied().unwrap_or(0.0), 0.0);
            }
        }
        // Premium anchor: AAKK double-suited four-bets at 100% everywhere.
        let premium = &doc.hands[&premium_key];
        assert_eq!(
            premium.get("four_bet").copied().unwrap_or(0.0),
            1.0,
            "{}: premium AAKKds must four-bet at 100%",
            doc.id
        );
        // Internal targets (fractions of the opening range), 0.5pp tolerance.
        assert!(
            (doc.achieved["call"] - want_call).abs() <= 0.005,
            "{} call {} vs internal target {}",
            doc.id,
            doc.achieved["call"],
            want_call
        );
        assert!(
            (doc.achieved["four_bet"] - want_fb).abs() <= 0.005,
            "{} four_bet {} vs internal target {}",
            doc.id,
            doc.achieved["four_bet"],
            want_fb
        );
        // The --check path: opening-range-weighted totals recomputed from
        // the round-tripped emitted documents land on the same targets.
        let rfi_parsed = JsonValue::parse(&rfi_doc.to_json(&test_cfg)).expect("RFI JSON parses");
        let ow = opening_weighted_totals(&parsed, &rfi_parsed, &multiplicity);
        assert!(
            (ow["call"] - want_call).abs() <= 0.005,
            "{} opening-weighted call {} vs internal target {}",
            doc.id,
            ow["call"],
            want_call
        );
        assert!(
            (ow["four_bet"] - want_fb).abs() <= 0.005,
            "{} opening-weighted four_bet {} vs internal target {}",
            doc.id,
            ow["four_bet"],
            want_fb
        );
    }
}
