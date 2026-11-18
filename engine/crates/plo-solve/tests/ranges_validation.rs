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
//!
//! The v1.2 tests additionally load data/preflop/ranges-config-v1.2.json:
//! the no-rake 6-max family's GTO Wizard cEV anchor targets, its set ids
//! and `rake` recording, and raked-family id stability under the new
//! config.

use plo_solve::ranges::{
    action_freqs, build_continuation_set, build_continuation_set_styled, build_response_set,
    build_response_set_styled, build_rfi_set, build_rfi_set_styled, compute_features,
    enumerate_classes, equity_vs_pool, is_canonical_key, opening_weighted_totals, opener_pool,
    score_all_classes, score_from_components, validate_rangeset, RangesConfig, CLASS_COUNT,
    RAKE_NO_RAKE, RAKE_RAKED, TOTAL_COMBOS,
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

fn load_config_v12() -> RangesConfig {
    let path = format!(
        "{}/../../../data/preflop/ranges-config-v1.2.json",
        env!("CARGO_MANIFEST_DIR")
    );
    let text = std::fs::read_to_string(&path).expect("read ranges-config-v1.2.json");
    RangesConfig::from_json_text(&text).expect("parse ranges-config-v1.2.json")
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
    if let Some(nr) = &mut c.norake {
        if let Some(cont) = &mut nr.continuations {
            cont.samples_vs_three_bettor = vs_three_bettor;
        }
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
    let ids: Vec<String> = cont.matchups.iter().map(|m| cont.set_id(m)).collect();
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
        assert_eq!(doc.id, cont.set_id(matchup));
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

// ---------------------------------------------------------------------------
// v1.2: the rake dimension and the no-rake 6-max family
// ---------------------------------------------------------------------------

#[test]
fn v12_config_carries_norake_family_with_gtw_anchors() {
    let cfg = load_config_v12();
    assert_eq!(cfg.version, "ranges-config-v1.2");
    let nr = cfg.norake.as_ref().expect("v1.2 config must carry norake_6max");
    // Cross-check source: the GTO Wizard cEV totals.
    assert!(
        nr.cross_check_source.name.contains("GTO Wizard"),
        "no-rake cross-check source must be the GTO Wizard totals: {}",
        nr.cross_check_source.name
    );
    assert_eq!(nr.cross_check_source.retrieved, "2026-11-17");
    // RFI anchors (GTO Wizard cEV 100bb totals, collected 2026-11-17;
    // their "HJ" seat is this schema's MP).
    assert_eq!(nr.rfi_targets.len(), 5, "no-rake RFI targets for all non-BB 6max positions");
    assert_eq!(nr.rfi_targets["UTG"].target, 0.185);
    assert_eq!(nr.rfi_targets["MP"].target, 0.234);
    assert_eq!(nr.rfi_targets["CO"].target, 0.317);
    assert_eq!(nr.rfi_targets["BTN"].target, 0.489);
    // SB is raise-or-fold: raise 28.4 + 0.5 x limp 26.4 = 41.6 (the v1
    // reconciliation rule applied to the cEV limp-inclusive totals).
    assert_eq!(nr.rfi_targets["SB"].target, 0.416);
    for t in nr.rfi_targets.values() {
        assert_eq!(t.kind, "anchor");
        assert!(t.band[0] < t.target && t.target < t.band[1], "target inside its band");
    }
    // Responses mirror the raked family's coverage: BB 5 + SB 4 + BTN 2.
    let resp_count: usize = nr.response_targets.values().map(|m| m.len()).sum();
    assert_eq!(resp_count, 11, "no-rake response targets mirror the raked 6max coverage");
    // The headline no-rake finding: defense calls run far wider than the
    // raked anchors (BB vs BTN call 45.6% vs the raked 30%).
    let bb_btn = &nr.response_targets["BB"]["BTN"];
    assert_eq!(bb_btn.three_bet, 0.096);
    assert_eq!(bb_btn.call, 0.456);
    assert_eq!(bb_btn.kind, "anchor");
    let bb_utg = &nr.response_targets["BB"]["UTG"];
    assert_eq!(bb_utg.three_bet, 0.039);
    assert_eq!(bb_utg.call, 0.320);
    let bb_sb = &nr.response_targets["BB"]["SB"];
    assert_eq!(bb_sb.three_bet, 0.098);
    assert_eq!(bb_sb.call, 0.748);
    let sb_btn = &nr.response_targets["SB"]["BTN"];
    assert_eq!(sb_btn.three_bet, 0.095);
    assert_eq!(sb_btn.call, 0.100);
    // Non-anchored entries stay honestly labelled.
    assert_eq!(nr.response_targets["SB"]["CO"].kind, "interpolated");
    assert_eq!(nr.response_targets["BTN"]["CO"].kind, "interpolated");
    // Continuations: the v1.1 internal parameters against the no-rake sets.
    let cont = nr.continuations.as_ref().expect("no-rake continuations present");
    assert!((cont.continue_fraction_of_open - 0.5).abs() < 1e-12);
    assert!((cont.call_fraction_of_continue - 0.82).abs() < 1e-12);
    assert!((cont.four_bet_fraction_of_continue - 0.18).abs() < 1e-12);
    let ids: Vec<String> = cont.matchups.iter().map(|m| cont.set_id(m)).collect();
    assert_eq!(
        ids,
        vec![
            "constructed-v1.2-6max-norake-btn-vs-bb-3bet".to_string(),
            "constructed-v1.2-6max-norake-btn-vs-sb-3bet".to_string(),
            "constructed-v1.2-6max-norake-co-vs-btn-3bet".to_string(),
        ]
    );
    // The raked maps are untouched by the v1.2 config (same targets as v1).
    let v1 = load_config();
    assert_eq!(cfg.rfi_targets["6max"]["BTN"].target, v1.rfi_targets["6max"]["BTN"].target);
    assert_eq!(
        cfg.response_targets["6max"]["BB"]["BTN"].call,
        v1.response_targets["6max"]["BB"]["BTN"].call
    );
}

#[test]
fn raked_ids_and_rake_field_stable_under_v12_config() {
    let cfg = load_config_v12();
    let test_cfg = small_samples(&cfg, 800, 400, 0, 0);
    let classes = score_all_classes(&test_cfg);
    // The raked wrapper entry points under the v1.2 config produce the
    // exact v1 ids, now recording rake = "raked".
    let doc = build_rfi_set(&test_cfg, &classes, "6max", "BTN").expect("raked BTN RFI");
    assert_eq!(doc.id, "constructed-v1-6max-btn-rfi");
    assert_eq!(doc.rake, RAKE_RAKED);
    let parsed = JsonValue::parse(&doc.to_json(&test_cfg)).expect("emitted JSON parses");
    assert_eq!(parsed.get("rake").and_then(|v| v.as_str()), Some("raked"));
    assert_eq!(
        parsed.get("provenance").and_then(|p| p.get("config_version")).and_then(|v| v.as_str()),
        Some("ranges-config-v1.2")
    );
    let errors = validate_rangeset(&parsed);
    assert!(errors.is_empty(), "{} schema errors: {:?}", doc.id, errors);
    // A v1-config document (no norake section) validates the same way.
    let v1_cfg = load_config();
    assert!(v1_cfg.norake.is_none(), "v1 config has no no-rake family");
}

#[test]
fn norake_sets_hit_targets_and_validate() {
    let cfg = load_config_v12();
    let test_cfg = small_samples(&cfg, 800, 400, 2000, 2000);
    let classes = score_all_classes(&test_cfg);
    let nr = test_cfg.norake.as_ref().expect("norake section");
    let family = test_cfg.norake_family().expect("norake family");
    // No-rake BTN RFI: id, rake field, anchor target, provenance source.
    let btn_doc = build_rfi_set_styled(
        &test_cfg,
        &classes,
        "6max",
        "BTN",
        &nr.rfi_targets["BTN"],
        &family,
    )
    .expect("no-rake BTN RFI");
    assert_eq!(btn_doc.id, "constructed-v1.2-6max-norake-btn-rfi");
    assert_eq!(btn_doc.rake, RAKE_NO_RAKE);
    assert!(
        (btn_doc.achieved["raise"] - 0.489).abs() <= 0.005,
        "no-rake BTN raise {} vs GTW anchor 0.489",
        btn_doc.achieved["raise"]
    );
    let parsed = JsonValue::parse(&btn_doc.to_json(&test_cfg)).expect("emitted JSON parses");
    assert_eq!(parsed.get("rake").and_then(|v| v.as_str()), Some("no-rake"));
    let prov = parsed.get("provenance").expect("provenance block present");
    let sources = prov.get("sources").and_then(|v| v.as_array()).expect("sources array");
    assert_eq!(sources.len(), 1, "no-rake sets cite exactly the GTO Wizard source");
    assert!(
        sources[0].get("name").and_then(|v| v.as_str()).unwrap_or("").contains("GTO Wizard"),
        "no-rake provenance must name the GTO Wizard cEV totals"
    );
    // The top-level source block mirrors the raked 6-max shape.
    assert!(
        parsed.get("source").and_then(|s| s.get("name")).and_then(|v| v.as_str()).unwrap_or("").contains("GTO Wizard"),
        "no-rake sets carry the GTO Wizard top-level source block"
    );
    let errors = validate_rangeset(&parsed);
    assert!(errors.is_empty(), "{} schema errors: {:?}", btn_doc.id, errors);
    // No-rake BB vs BTN: the wide cEV defense (call 45.6%).
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
    let doc = build_response_set_styled(
        &test_cfg,
        &classes,
        &eq,
        "6max",
        "BB",
        "BTN",
        &nr.response_targets["BB"]["BTN"],
        &family,
    )
    .expect("no-rake BB vs BTN");
    assert_eq!(doc.id, "constructed-v1.2-6max-norake-bb-vs-btn");
    assert_eq!(doc.rake, RAKE_NO_RAKE);
    assert!(
        (doc.achieved["three_bet"] - 0.096).abs() <= 0.005,
        "no-rake BB 3bet {} vs GTW anchor 0.096",
        doc.achieved["three_bet"]
    );
    assert!(
        (doc.achieved["call"] - 0.456).abs() <= 0.005,
        "no-rake BB call {} vs GTW anchor 0.456",
        doc.achieved["call"]
    );
    let parsed = JsonValue::parse(&doc.to_json(&test_cfg)).expect("emitted JSON parses");
    let errors = validate_rangeset(&parsed);
    assert!(errors.is_empty(), "{} schema errors: {:?}", doc.id, errors);
    // Trash still folds; premium still 3-bets.
    let trash = &doc.hands["9s 7h 3d 2c"];
    assert_eq!(trash.get("fold").copied().unwrap_or(0.0), 1.0, "trash must fold vs BTN open");
    // One no-rake continuation (BTN vs BB) against the internal targets.
    let cont = nr.continuations.as_ref().expect("no-rake continuations");
    let matchup = &cont.matchups[0];
    assert_eq!(matchup.opener_rfi_set, btn_doc.id);
    assert_eq!(matchup.three_bettor_set, doc.id);
    let tb_freq = action_freqs(&doc, &classes, "three_bet");
    let tb_pool = opener_pool(&classes, &tb_freq);
    let eq_tb: Vec<f64> = classes
        .iter()
        .enumerate()
        .map(|(i, c)| {
            equity_vs_pool(
                &c.class.representative,
                &tb_pool,
                cont.samples_vs_three_bettor,
                test_cfg.seed ^ (i as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F),
            )
        })
        .collect();
    let cdoc = build_continuation_set_styled(
        &test_cfg,
        &classes,
        &eq_tb,
        &ofreq,
        matchup,
        cont,
        &family,
    )
    .expect("no-rake continuation set");
    assert_eq!(cdoc.id, "constructed-v1.2-6max-norake-btn-vs-bb-3bet");
    assert_eq!(cdoc.rake, RAKE_NO_RAKE);
    assert_eq!(cdoc.target_kind, "internal");
    let want_call = cont.continue_fraction_of_open * cont.call_fraction_of_continue;
    let want_fb = cont.continue_fraction_of_open * cont.four_bet_fraction_of_continue;
    assert!(
        (cdoc.achieved["call"] - want_call).abs() <= 0.005,
        "{} call {} vs internal target {}",
        cdoc.id,
        cdoc.achieved["call"],
        want_call
    );
    assert!(
        (cdoc.achieved["four_bet"] - want_fb).abs() <= 0.005,
        "{} four_bet {} vs internal target {}",
        cdoc.id,
        cdoc.achieved["four_bet"],
        want_fb
    );
    let parsed = JsonValue::parse(&cdoc.to_json(&test_cfg)).expect("emitted JSON parses");
    let errors = validate_rangeset(&parsed);
    assert!(errors.is_empty(), "{} schema errors: {:?}", cdoc.id, errors);
    // The config-level matchup lookup finds the no-rake continuation.
    let (found_cont, found_m) = test_cfg
        .continuation_matchup("constructed-v1.2-6max-norake-btn-vs-bb-3bet")
        .expect("continuation_matchup must find no-rake matchups");
    assert_eq!(found_m.three_bettor_set, doc.id);
    assert_eq!(found_cont.id_prefix, "constructed-v1.2-6max-norake");
}

#[test]
fn v12_raked_family_cites_gtw_raked_anchors_informational_only() {
    let cfg = load_config_v12();
    // The third cross-check source exists only in the v1.2 config.
    let v1 = RangesConfig::from_json_text(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../data/preflop/ranges-config-v1.json"
        ))
        .unwrap(),
    )
    .unwrap();
    assert!(v1.cross_check_source_3.is_none());
    let s3 = cfg
        .cross_check_source_3
        .as_ref()
        .expect("v1.2 config carries the GTW raked source");
    assert!(s3.name.contains("PLO100"), "source 3 names the raked set");
    assert_eq!(s3.retrieved, "2026-11-17");

    // Anchors parse exactly (GTO Wizard PLO100 totals, 2026-11-17).
    assert_eq!(cfg.gtw_raked_rfi.get("BTN"), Some(&0.426));
    assert_eq!(cfg.gtw_raked_rfi.get("UTG"), Some(&0.173));
    assert_eq!(cfg.gtw_raked_defense["BB"]["BTN"].three_bet, 0.101);
    assert_eq!(cfg.gtw_raked_defense["BB"]["BTN"].call, 0.322);
    assert_eq!(cfg.gtw_raked_defense["BB"]["SB"].call, 0.624);
    assert_eq!(cfg.gtw_raked_defense["SB"]["BTN"].call, 0.053);

    // The anchors are informational: the raked construction targets are
    // untouched — BTN RFI still targets 49% (the band that matches the
    // no-rake anchor), the flagged v1.3 retarget candidate.
    let btn = &cfg.rfi_targets["6max"]["BTN"];
    assert!((btn.target - 0.49).abs() < 1e-9);
    assert_eq!(btn.band, [0.48, 0.50]);

    // Raked 6-max provenance cites all three sources; the top-level
    // source stays PLO.com.
    let test_cfg = small_samples(&cfg, 800, 400, 0, 0);
    let classes = score_all_classes(&test_cfg);
    let doc = build_rfi_set(&test_cfg, &classes, "6max", "BTN").expect("raked BTN RFI");
    let parsed = JsonValue::parse(&doc.to_json(&test_cfg)).expect("emitted JSON parses");
    let prov = parsed.get("provenance").expect("provenance block present");
    let sources = prov
        .get("sources")
        .and_then(|v| v.as_array())
        .expect("sources array");
    assert_eq!(sources.len(), 3, "PLO.com + Upswing + GTW raked");
    assert!(parsed
        .get("source")
        .and_then(|s| s.get("name"))
        .and_then(|v| v.as_str())
        .expect("top-level source name")
        .contains("PLO.com"));
    assert_eq!(validate_rangeset(&parsed), Vec::<String>::new());
}
