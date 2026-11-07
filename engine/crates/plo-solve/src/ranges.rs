//! `ranges` — Constructed preflop starting ranges, method `constructed-equity-v1`.
//!
//! This module builds PLO4 preflop range sets (6-max and 9-max, 100bb) WITHOUT any
//! external range data: every canonical hand class (16,432 suit-isomorphism classes
//! covering all 270,725 four-card combinations) is scored by a transparent,
//! config-driven formula combining
//!
//! * Monte Carlo showdown equity vs a random hand,
//! * Monte Carlo showdown equity vs a generic top-fraction continuing range
//!   (and, for response sets, vs the specific opener's constructed RFI range),
//! * playability features computed exactly from the cards (pair structure,
//!   suitedness, connectedness, high-card strength).
//!
//! Classes are ranked by score and selected from the top until each position's
//! target frequency (a documented construction assumption in
//! `data/preflop/ranges-config-v1.json`, cross-checked against published
//! solver-derived totals) is reached; a linear ramp over the boundary band plus a
//! deterministic residual correction replaces the hard in/out cliff.
//!
//! The emitted sets are CONSTRUCTED ranges. They are not solver output and must
//! never be labelled GTO. Provenance is recorded per set: 6-max sets cite the
//! PLO.com published totals as cross-check targets (the only external source);
//! 9-max sets are derived from the 6-max targets by a seat-mapping rule and cite
//! no source.
//!
//! v1.1 extension (method `constructed-equity-v1.1`): continuation sets for the
//! opener facing a 3-bet (context `vs_three_bet`), built by
//! [`build_continuation_set`]. Eligible classes are exactly the classes the
//! opener opens in their constructed RFI set; classes are scored with the v1
//! blend against the three-bettor's `three_bet` slice. The continuation-rate
//! targets are INTERNAL construction parameters (fractions of the opener's
//! raising range, from the config's `continuations_v11` section): no published
//! cross-check anchor for continuation rates was found, so the sets carry an
//! empty provenance `sources` list and state the construction — and that
//! status — in their `derivation`.
//!
//! Equity note: exact preflop hand-vs-range equity would need
//! C(48,4) opponent combos x C(44,5) boards per class, which is not feasible to
//! enumerate, so equities are Monte Carlo estimates with a fixed seed (fully
//! reproducible). Sample counts and the seed live in the config and are recorded
//! in the emitted class table. Everything else (class enumeration, features,
//! selection, frequencies) is exact and deterministic.

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write as _;

use plo_cards::{canonicalize_plo_hand, Card, HandMask, Rank, Suit};
use plo_eval::{eval_omaha_pairs_triples, extract_board_triples, extract_hole_pairs, DeterministicRng};

use crate::json::JsonValue;

/// Method identifier recorded in every emitted set's provenance block.
pub const METHOD: &str = "constructed-equity-v1";
/// Method identifier for the v1.1 continuation sets (`vs_three_bet` context).
pub const METHOD_V11: &str = "constructed-equity-v1.1";
/// Total number of 4-card combinations from a 52-card deck: C(52,4).
pub const TOTAL_COMBOS: u64 = 270_725;
/// Number of suit-isomorphism classes of PLO starting hands.
pub const CLASS_COUNT: usize = 16_432;

/// Positions in preflop action order, 6-max.
pub const POSITIONS_6MAX: [&str; 6] = ["UTG", "MP", "CO", "BTN", "SB", "BB"];
/// Positions in preflop action order, 9-max.
pub const POSITIONS_9MAX: [&str; 9] = ["UTG", "UTG+1", "UTG+2", "LJ", "HJ", "CO", "BTN", "SB", "BB"];
/// Postflop acting order (SB first, BTN last) — decides in/out of position for
/// the realisation factor in call selection.
pub const POSTFLOP_ORDER: [&str; 10] = ["SB", "BB", "UTG", "UTG+1", "UTG+2", "MP", "LJ", "HJ", "CO", "BTN"];

pub fn positions_for(table_size: &str) -> Option<&'static [&'static str]> {
    match table_size {
        "6max" => Some(&POSITIONS_6MAX),
        "9max" => Some(&POSITIONS_9MAX),
        _ => None,
    }
}

/// `true` if `responder` acts after `opener` postflop.
pub fn is_in_position_postflop(responder: &str, opener: &str) -> bool {
    let idx = |p: &str| POSTFLOP_ORDER.iter().position(|&x| x == p);
    match (idx(responder), idx(opener)) {
        (Some(r), Some(o)) => r > o,
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Canonical hand-class keys (rangeset format: see data/preflop/README.md)
// ---------------------------------------------------------------------------

const CANONICAL_SUIT_LETTERS: [char; 4] = ['s', 'h', 'd', 'c'];

/// Builds the rangeset hand key for a canonical representative: ranks in
/// non-increasing order, suits relabelled by first occurrence (first distinct
/// suit `s`, then `h`, `d`, `c`). `cards` must already be in canonical order
/// (rank descending), as returned by [`canonicalize_plo_hand`].
pub fn hand_key(cards: &[Card; 4]) -> String {
    let mut letter_of: [Option<char>; 4] = [None; 4];
    let mut next = 0usize;
    let mut out = String::with_capacity(11);
    for (i, card) in cards.iter().enumerate() {
        let s = card.suit() as usize;
        let letter = match letter_of[s] {
            Some(l) => l,
            None => {
                let l = CANONICAL_SUIT_LETTERS[next];
                next += 1;
                letter_of[s] = Some(l);
                l
            }
        };
        if i > 0 {
            out.push(' ');
        }
        out.push(card.rank().to_char());
        out.push(letter);
    }
    out
}

/// Checks a hand key against the rangeset canonical-form rules, mirroring
/// `data/preflop/import-csv.mjs` exactly: four distinct cards, ranks
/// non-increasing, suits labelled by first occurrence (s, then h, d, c).
pub fn is_canonical_key(key: &str) -> bool {
    let tokens: Vec<&str> = key.split(' ').collect();
    if tokens.len() != 4 {
        return false;
    }
    let mut seen: Vec<&str> = Vec::with_capacity(4);
    let mut suit_map: Vec<(char, char)> = Vec::with_capacity(4);
    let mut prev_rank = u8::MAX;
    for tok in tokens {
        let b = tok.as_bytes();
        if b.len() != 2 {
            return false;
        }
        let rank = match Rank::from_char(b[0] as char) {
            Some(r) => r.index(),
            None => return false,
        };
        let suit = b[1] as char;
        if !CANONICAL_SUIT_LETTERS.contains(&suit) {
            return false;
        }
        if seen.contains(&tok) {
            return false;
        }
        seen.push(tok);
        if rank > prev_rank {
            return false;
        }
        prev_rank = rank;
        match suit_map.iter().find(|(s, _)| *s == suit) {
            Some((_, expected)) => {
                if *expected != suit {
                    return false;
                }
            }
            None => {
                let expected = CANONICAL_SUIT_LETTERS[suit_map.len()];
                if expected != suit {
                    return false;
                }
                suit_map.push((suit, expected));
            }
        }
    }
    true
}

/// Parses a canonical hand key back into 4 cards whose suits are the canonical
/// letters themselves (s=Spades, h=Hearts, d=Diamonds, c=Clubs). The result is
/// a concrete member of the class, suitable as its representative.
pub fn parse_hand_key(key: &str) -> Option<[Card; 4]> {
    let mut cards = [Card::new(Rank::Two, Suit::Clubs); 4];
    let tokens: Vec<&str> = key.split(' ').collect();
    if tokens.len() != 4 {
        return None;
    }
    for (i, tok) in tokens.iter().enumerate() {
        let b = tok.as_bytes();
        if b.len() != 2 {
            return None;
        }
        let rank = Rank::from_char(b[0] as char)?;
        let suit = Suit::from_char(b[1] as char)?;
        cards[i] = Card::new(rank, suit);
    }
    Some(cards)
}

// ---------------------------------------------------------------------------
// Class enumeration
// ---------------------------------------------------------------------------

/// One canonical hand class: its rangeset key, a concrete representative
/// (the canonical cards), how many raw combos it covers, and every concrete
/// combo mask (kept for building sampling pools).
#[derive(Clone, Debug)]
pub struct HandClass {
    pub key: String,
    pub representative: [Card; 4],
    pub multiplicity: u32,
    pub combos: Vec<HandMask>,
}

/// Enumerates all 270,725 four-card combos, canonicalises each under suit
/// isomorphism (via [`canonicalize_plo_hand`]), and groups them into the
/// 16,432 classes. Classes are returned sorted by key for determinism.
pub fn enumerate_classes() -> Vec<HandClass> {
    let mut by_mask: HashMap<HandMask, usize> = HashMap::with_capacity(CLASS_COUNT * 2);
    let mut classes: Vec<HandClass> = Vec::with_capacity(CLASS_COUNT);
    for a in 0..52u8 {
        for b in (a + 1)..52u8 {
            for c in (b + 1)..52u8 {
                for d in (c + 1)..52u8 {
                    let raw = [
                        Card::from_id(a).unwrap(),
                        Card::from_id(b).unwrap(),
                        Card::from_id(c).unwrap(),
                        Card::from_id(d).unwrap(),
                    ];
                    let canon = canonicalize_plo_hand(raw);
                    let mask = HandMask::from_cards(&canon);
                    let idx = match by_mask.get(&mask) {
                        Some(&i) => i,
                        None => {
                            let i = classes.len();
                            by_mask.insert(mask, i);
                            classes.push(HandClass {
                                key: hand_key(&canon),
                                representative: canon,
                                multiplicity: 0,
                                combos: Vec::new(),
                            });
                            i
                        }
                    };
                    classes[idx].multiplicity += 1;
                    classes[idx].combos.push(HandMask::from_cards(&raw));
                }
            }
        }
    }
    classes.sort_by(|x, y| x.key.cmp(&y.key));
    classes
}

// ---------------------------------------------------------------------------
// Playability features (exact, from the representative's cards)
// ---------------------------------------------------------------------------

#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum PairKind {
    None,
    OnePair,
    TwoPair,
    Trips,
    Quads,
}

impl PairKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            PairKind::None => "none",
            PairKind::OnePair => "one_pair",
            PairKind::TwoPair => "two_pair",
            PairKind::Trips => "trips",
            PairKind::Quads => "quads",
        }
    }
}

#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Features {
    pub pair_kind: PairKind,
    /// Highest paired rank (2..=14); 0 when `pair_kind == PairKind::None`.
    pub top_pair_rank: u8,
    /// Suit-count pattern label: "double" [2,2], "four" [4], "three" [3,1],
    /// "single" [2,1,1], "rainbow" [1,1,1,1].
    pub suitedness: &'static str,
    /// Longest rundown chain length over distinct ranks (gap <= 2 links,
    /// ace counted high and low), 1..=4.
    pub rundown_len: u8,
    pub pair_component: f64,
    pub suitedness_component: f64,
    pub connectedness_component: f64,
    pub high_card_component: f64,
}

/// Computes the playability features of one hand from its 4 cards, using the
/// component tables in the config.
pub fn compute_features(cards: &[Card; 4], cfg: &RangesConfig) -> Features {
    let mut ranks: Vec<u8> = cards.iter().map(|c| c.rank().index() + 2).collect();
    ranks.sort_unstable_by(|a, b| b.cmp(a));
    // Pair structure.
    let mut counts: Vec<(u8, u8)> = Vec::with_capacity(4);
    for &r in &ranks {
        let mut found = false;
        for e in counts.iter_mut() {
            if e.0 == r {
                e.1 += 1;
                found = true;
                break;
            }
        }
        if !found {
            counts.push((r, 1));
        }
    }
    let mut shape: Vec<u8> = counts.iter().map(|(_, n)| *n).collect();
    shape.sort_unstable_by(|a, b| b.cmp(a));
    let pair_kind = match shape.as_slice() {
        [4] => PairKind::Quads,
        [3, 1] => PairKind::Trips,
        [2, 2] => PairKind::TwoPair,
        [2, 1, 1] => PairKind::OnePair,
        _ => PairKind::None,
    };
    let top_pair_rank = counts
        .iter()
        .filter(|(_, n)| *n >= 2)
        .map(|(r, _)| *r)
        .max()
        .unwrap_or(0);
    let pair_component = cfg.pair_base(pair_kind) + cfg.components_pair_rank_bonus * (top_pair_rank as f64 / 14.0);
    // Suitedness.
    let mut suit_counts = [0u8; 4];
    for c in cards {
        suit_counts[c.suit() as usize] += 1;
    }
    let mut suit_shape: Vec<u8> = suit_counts.iter().copied().filter(|&n| n > 0).collect();
    suit_shape.sort_unstable_by(|a, b| b.cmp(a));
    let (suitedness, suitedness_component) = match suit_shape.as_slice() {
        [2, 2] => ("double", cfg.components_suitedness.double),
        // Four cards of one suit: only one flush suit, but no dead suits
        // either; scored with the double-suited component (see RANGES-NOTES).
        [4] => ("four", cfg.components_suitedness.double),
        [3, 1] => ("three", cfg.components_suitedness.three),
        [2, 1, 1] => ("single", cfg.components_suitedness.single),
        _ => ("rainbow", cfg.components_suitedness.rainbow),
    };
    // Connectedness over distinct ranks; ace plays low as well.
    let mut distinct: Vec<u8> = ranks.clone();
    distinct.dedup();
    let (conn_a, len_a) = rundown(&distinct);
    let mut low: Vec<u8> = distinct.iter().map(|&r| if r == 14 { 1 } else { r }).collect();
    low.sort_unstable_by(|a, b| b.cmp(a));
    low.dedup();
    let (conn_b, len_b) = rundown(&low);
    let (connectedness_component, rundown_len) = if conn_b > conn_a {
        (conn_b, len_b)
    } else {
        (conn_a, len_a)
    };
    let high_card_component =
        0.6 * (ranks[0] as f64 / 14.0) + 0.4 * ((ranks[0] as f64 + ranks[1] as f64) / 28.0);
    Features {
        pair_kind,
        top_pair_rank,
        suitedness,
        rundown_len,
        pair_component,
        suitedness_component,
        connectedness_component,
        high_card_component,
    }
}

/// Best rundown chain over distinct ranks sorted descending: consecutive
/// ranks with gap 1 score 1.0 per link, gap 2 scores 0.5. Returns
/// (component = best chain link score / 3, chain length in ranks).
fn rundown(distinct_desc: &[u8]) -> (f64, u8) {
    let n = distinct_desc.len();
    if n == 0 {
        return (0.0, 0);
    }
    let mut best_val = vec![0.0f64; n];
    let mut best_len = vec![1u8; n];
    for i in 0..n {
        for j in 0..i {
            let gap = distinct_desc[j] as i16 - distinct_desc[i] as i16;
            let step = match gap {
                1 => Some(1.0),
                2 => Some(0.5),
                _ => None,
            };
            if let Some(s) = step {
                let cand = best_val[j] + s;
                if cand > best_val[i] || (cand == best_val[i] && best_len[j] + 1 > best_len[i]) {
                    best_val[i] = cand;
                    best_len[i] = best_len[j] + 1;
                }
            }
        }
    }
    let mut bi = 0usize;
    for i in 1..n {
        if best_val[i] > best_val[bi] {
            bi = i;
        }
    }
    (best_val[bi] / 3.0, best_len[bi])
}

/// The scoring formula. All inputs in [0,1]; weights from config. For
/// response sets, `equity_vs_opener` is passed as `equity_reference_slot`
/// (it takes the equity_vs_reference weight; see config comment).
pub fn score_from_components(
    cfg: &RangesConfig,
    equity_vs_random: f64,
    equity_reference_slot: f64,
    f: &Features,
) -> f64 {
    cfg.weights.equity_vs_random * equity_vs_random
        + cfg.weights.equity_vs_reference * equity_reference_slot
        + cfg.weights.pair * f.pair_component
        + cfg.weights.suitedness * f.suitedness_component
        + cfg.weights.connectedness * f.connectedness_component
        + cfg.weights.high_card * f.high_card_component
}

// ---------------------------------------------------------------------------
// Config (data/preflop/ranges-config-v1.json)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct Weights {
    pub equity_vs_random: f64,
    pub equity_vs_reference: f64,
    pub pair: f64,
    pub suitedness: f64,
    pub connectedness: f64,
    pub high_card: f64,
}

#[derive(Clone, Debug)]
pub struct SuitednessComponents {
    pub double: f64,
    pub three: f64,
    pub single: f64,
    pub rainbow: f64,
}

#[derive(Clone, Debug)]
pub struct SourceBlock {
    pub name: String,
    /// Optional: owner-provided sources (e.g. a PDF the owner supplied) have
    /// no URL to record, and none is invented for them.
    pub url: Option<String>,
    pub licence: String,
    pub retrieved: String,
}

#[derive(Clone, Debug)]
pub struct RfiTarget {
    pub target: f64,
    pub band: [f64; 2],
    pub kind: String,
}

#[derive(Clone, Debug)]
pub struct PairTarget {
    pub three_bet: f64,
    pub call: f64,
    pub kind: String,
}

/// One v1.1 continuation matchup: `continuer` opened (their RFI set
/// `opener_rfi_set`), `three_bettor` 3-bet (their vs_rfi set
/// `three_bettor_set`, `three_bet` slice), `continuer` now continues.
#[derive(Clone, Debug)]
pub struct ContinuationMatchup {
    pub continuer: String,
    pub three_bettor: String,
    pub opener_rfi_set: String,
    pub three_bettor_set: String,
}

/// The config's `continuations_v11` section. All targets here are INTERNAL
/// construction parameters (fractions of the opener's raising range by combo
/// weight) — no published cross-check anchor exists for continuation rates;
/// `cross_check_status` records that verbatim for the emitted provenance.
#[derive(Clone, Debug)]
pub struct ContinuationsConfig {
    pub method: String,
    pub continue_fraction_of_open: f64,
    pub call_fraction_of_continue: f64,
    pub four_bet_fraction_of_continue: f64,
    pub samples_vs_three_bettor: usize,
    pub cross_check_status: String,
    pub matchups: Vec<ContinuationMatchup>,
}

impl ContinuationsConfig {
    /// The emitted set id for a matchup, per the v1.1 naming rule
    /// `constructed-v1.1-6max-<continuer>-vs-<three-bettor>-3bet`.
    pub fn set_id(m: &ContinuationMatchup) -> String {
        format!(
            "constructed-v1.1-6max-{}-vs-{}-3bet",
            slug(&m.continuer),
            slug(&m.three_bettor)
        )
    }

    pub fn matchup_for_set_id(&self, id: &str) -> Option<&ContinuationMatchup> {
        self.matchups.iter().find(|m| Self::set_id(m) == id)
    }
}

#[derive(Clone, Debug)]
pub struct RangesConfig {
    pub version: String,
    pub seed: u64,
    pub samples_vs_random: usize,
    pub samples_vs_reference: usize,
    pub samples_vs_opener: usize,
    pub reference_top_fraction: f64,
    pub weights: Weights,
    pub pair_base_none: f64,
    pub pair_base_one_pair: f64,
    pub pair_base_two_pair: f64,
    pub pair_base_trips: f64,
    pub pair_base_quads: f64,
    pub components_pair_rank_bonus: f64,
    pub components_suitedness: SuitednessComponents,
    pub ramp_band: f64,
    pub call_equity_floor: f64,
    pub realisation_in_position: f64,
    pub realisation_out_of_position: f64,
    pub stack_bb: f64,
    pub rake_note: String,
    pub cross_check_defense_tolerance: f64,
    pub cross_check_source: SourceBlock,
    pub cross_check_source_2: Option<SourceBlock>,
    pub upswing_rfi: BTreeMap<String, f64>,
    pub derivation_note_9max: String,
    pub btn_vs: BTreeMap<String, Vec<String>>,
    pub rfi_targets: BTreeMap<String, BTreeMap<String, RfiTarget>>,
    pub response_targets: BTreeMap<String, BTreeMap<String, BTreeMap<String, PairTarget>>>,
    /// Optional v1.1 section (`continuations_v11`); absent = v1 behaviour only.
    pub continuations: Option<ContinuationsConfig>,
    /// FNV-1a 64-bit hash of the raw config file bytes (identification only).
    pub config_hash: String,
}

impl RangesConfig {
    pub fn pair_base(&self, kind: PairKind) -> f64 {
        match kind {
            PairKind::None => self.pair_base_none,
            PairKind::OnePair => self.pair_base_one_pair,
            PairKind::TwoPair => self.pair_base_two_pair,
            PairKind::Trips => self.pair_base_trips,
            PairKind::Quads => self.pair_base_quads,
        }
    }

    pub fn from_json_text(text: &str) -> Result<Self, String> {
        let root = JsonValue::parse(text).map_err(|e| format!("config JSON: {e}"))?;
        let get = |key: &str| root.get(key).ok_or_else(|| format!("config missing field '{key}'"));
        let num = |v: &JsonValue, key: &str| {
            v.as_f64().ok_or_else(|| format!("config field '{key}' must be a number"))
        };
        let obj_num = |obj: &JsonValue, key: &str| {
            let v = obj.get(key).ok_or_else(|| format!("config object missing '{key}'"))?;
            v.as_f64().ok_or_else(|| format!("config field '{key}' must be a number"))
        };
        let obj_str = |obj: &JsonValue, key: &str| {
            let v = obj.get(key).ok_or_else(|| format!("config object missing '{key}'"))?;
            v.as_str().map(|s| s.to_string()).ok_or_else(|| format!("config field '{key}' must be a string"))
        };
        let version = get("version")?.as_str().ok_or("config 'version' must be a string")?.to_string();
        let seed = num(get("seed")?, "seed")? as u64;
        let samples = get("mc_samples")?;
        let weights_j = get("weights")?;
        let weights = Weights {
            equity_vs_random: obj_num(weights_j, "equity_vs_random")?,
            equity_vs_reference: obj_num(weights_j, "equity_vs_reference")?,
            pair: obj_num(weights_j, "pair")?,
            suitedness: obj_num(weights_j, "suitedness")?,
            connectedness: obj_num(weights_j, "connectedness")?,
            high_card: obj_num(weights_j, "high_card")?,
        };
        let comp = get("components")?;
        let pair_base = comp.get("pair_base").ok_or("config components missing 'pair_base'")?;
        let suit_j = comp.get("suitedness").ok_or("config components missing 'suitedness'")?;
        let real = get("realisation")?;
        let src = get("cross_check_source")?;
        let cross_check_source = SourceBlock {
            name: obj_str(src, "name")?,
            url: Some(obj_str(src, "url")?),
            licence: obj_str(src, "licence")?,
            retrieved: obj_str(src, "retrieved")?,
        };
        let cross_check_source_2 = match root.get("cross_check_source_2") {
            Some(s2) => Some(SourceBlock {
                name: obj_str(s2, "name")?,
                url: s2.get("url").and_then(|v| v.as_str()).map(|s| s.to_string()),
                licence: obj_str(s2, "licence")?,
                retrieved: obj_str(s2, "retrieved")?,
            }),
            None => None,
        };
        let mut upswing_rfi: BTreeMap<String, f64> = BTreeMap::new();
        if let Some(u) = root.get("upswing_rfi_6max") {
            if let JsonValue::Object(entries) = u {
                for (pos, v) in entries {
                    upswing_rfi.insert(
                        pos.clone(),
                        v.as_f64().ok_or("upswing_rfi_6max values must be numbers")?,
                    );
                }
            }
        }
        let mut btn_vs: BTreeMap<String, Vec<String>> = BTreeMap::new();
        if let JsonValue::Object(entries) = get("btn_vs")? {
            for (table, arr) in entries {
                let mut v = Vec::new();
                for item in arr.as_array().ok_or("btn_vs entries must be arrays")? {
                    v.push(item.as_str().ok_or("btn_vs entries must be strings")?.to_string());
                }
                btn_vs.insert(table.clone(), v);
            }
        } else {
            return Err("config 'btn_vs' must be an object".to_string());
        }
        let mut rfi_targets: BTreeMap<String, BTreeMap<String, RfiTarget>> = BTreeMap::new();
        if let JsonValue::Object(tables) = get("rfi_targets")? {
            for (table, positions) in tables {
                let mut map = BTreeMap::new();
                if let JsonValue::Object(pos_entries) = positions {
                    for (pos, t) in pos_entries {
                        let band = t.get("band").and_then(|b| b.as_array()).ok_or("rfi target missing 'band'")?;
                        if band.len() != 2 {
                            return Err("rfi target 'band' must have 2 entries".to_string());
                        }
                        map.insert(
                            pos.clone(),
                            RfiTarget {
                                target: obj_num(t, "target")?,
                                band: [
                                    band[0].as_f64().ok_or("band[0] must be a number")?,
                                    band[1].as_f64().ok_or("band[1] must be a number")?,
                                ],
                                kind: obj_str(t, "kind")?,
                            },
                        );
                    }
                }
                rfi_targets.insert(table.clone(), map);
            }
        } else {
            return Err("config 'rfi_targets' must be an object".to_string());
        }
        let mut response_targets: BTreeMap<String, BTreeMap<String, BTreeMap<String, PairTarget>>> = BTreeMap::new();
        if let JsonValue::Object(tables) = get("response_targets")? {
            for (table, responders) in tables {
                let mut rmap = BTreeMap::new();
                if let JsonValue::Object(resp_entries) = responders {
                    for (resp, openers) in resp_entries {
                        let mut omap = BTreeMap::new();
                        if let JsonValue::Object(op_entries) = openers {
                            for (op, t) in op_entries {
                                omap.insert(
                                    op.clone(),
                                    PairTarget {
                                        three_bet: obj_num(t, "three_bet")?,
                                        call: obj_num(t, "call")?,
                                        kind: obj_str(t, "kind")?,
                                    },
                                );
                            }
                        }
                        rmap.insert(resp.clone(), omap);
                    }
                }
                response_targets.insert(table.clone(), rmap);
            }
        } else {
            return Err("config 'response_targets' must be an object".to_string());
        }
        // Optional v1.1 section. Parsing it must not disturb any v1 field:
        // every v1 value above is read exactly as before, and the v1
        // generation path never consults this section.
        let continuations = match root.get("continuations_v11") {
            Some(sec) => {
                let method = obj_str(sec, "method")?;
                if method != METHOD_V11 {
                    return Err(format!(
                        "continuations_v11.method must be '{METHOD_V11}', got '{method}'"
                    ));
                }
                let continue_fraction_of_open = obj_num(sec, "continue_fraction_of_open")?;
                let call_fraction_of_continue = obj_num(sec, "call_fraction_of_continue")?;
                let four_bet_fraction_of_continue = obj_num(sec, "four_bet_fraction_of_continue")?;
                if !(0.0 < continue_fraction_of_open && continue_fraction_of_open < 1.0) {
                    return Err("continuations_v11.continue_fraction_of_open must be in (0, 1)".to_string());
                }
                if (call_fraction_of_continue + four_bet_fraction_of_continue - 1.0).abs() > 1e-9 {
                    return Err(
                        "continuations_v11 call/four_bet fractions of continue must sum to 1"
                            .to_string(),
                    );
                }
                let mut matchups = Vec::new();
                let arr = sec
                    .get("matchups")
                    .and_then(|v| v.as_array())
                    .ok_or("continuations_v11.matchups must be an array")?;
                if arr.is_empty() {
                    return Err("continuations_v11.matchups must not be empty".to_string());
                }
                for m in arr {
                    let continuer = obj_str(m, "continuer")?;
                    let three_bettor = obj_str(m, "three_bettor")?;
                    if !POSITIONS_6MAX.contains(&continuer.as_str())
                        || !POSITIONS_6MAX.contains(&three_bettor.as_str())
                    {
                        return Err(format!(
                            "continuations_v11 matchup {continuer} vs {three_bettor}: v1.1 continuations are 6max only"
                        ));
                    }
                    if continuer == three_bettor {
                        return Err("continuations_v11 matchup: continuer and three_bettor must differ".to_string());
                    }
                    matchups.push(ContinuationMatchup {
                        continuer,
                        three_bettor,
                        opener_rfi_set: obj_str(m, "opener_rfi_set")?,
                        three_bettor_set: obj_str(m, "three_bettor_set")?,
                    });
                }
                Some(ContinuationsConfig {
                    method,
                    continue_fraction_of_open,
                    call_fraction_of_continue,
                    four_bet_fraction_of_continue,
                    samples_vs_three_bettor: obj_num(sec, "samples_vs_three_bettor")? as usize,
                    cross_check_status: obj_str(sec, "cross_check")?,
                    matchups,
                })
            }
            None => None,
        };
        Ok(RangesConfig {
            version,
            seed,
            samples_vs_random: obj_num(samples, "vs_random")? as usize,
            samples_vs_reference: obj_num(samples, "vs_reference")? as usize,
            samples_vs_opener: obj_num(samples, "vs_opener")? as usize,
            reference_top_fraction: num(get("reference_top_fraction")?, "reference_top_fraction")?,
            weights,
            pair_base_none: obj_num(pair_base, "none")?,
            pair_base_one_pair: obj_num(pair_base, "one_pair")?,
            pair_base_two_pair: obj_num(pair_base, "two_pair")?,
            pair_base_trips: obj_num(pair_base, "trips")?,
            pair_base_quads: obj_num(pair_base, "quads")?,
            components_pair_rank_bonus: obj_num(comp, "pair_rank_bonus")?,
            components_suitedness: SuitednessComponents {
                double: obj_num(suit_j, "double")?,
                three: obj_num(suit_j, "three")?,
                single: obj_num(suit_j, "single")?,
                rainbow: obj_num(suit_j, "rainbow")?,
            },
            ramp_band: num(get("ramp_band")?, "ramp_band")?,
            call_equity_floor: num(get("call_equity_floor")?, "call_equity_floor")?,
            realisation_in_position: obj_num(real, "in_position")?,
            realisation_out_of_position: obj_num(real, "out_of_position")?,
            stack_bb: num(get("stack_bb")?, "stack_bb")?,
            rake_note: get("rake_note")?.as_str().ok_or("config 'rake_note' must be a string")?.to_string(),
            cross_check_defense_tolerance: num(
                get("cross_check_defense_tolerance")?,
                "cross_check_defense_tolerance",
            )?,
            cross_check_source,
            cross_check_source_2,
            upswing_rfi,
            derivation_note_9max: get("derivation_note_9max")?
                .as_str()
                .ok_or("config 'derivation_note_9max' must be a string")?
                .to_string(),
            btn_vs,
            rfi_targets,
            response_targets,
            continuations,
            config_hash: fnv1a64_hex(text.as_bytes()),
        })
    }
}

/// FNV-1a 64-bit hash, hex-encoded. Identification only (not cryptographic).
pub fn fnv1a64_hex(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

// ---------------------------------------------------------------------------
// Monte Carlo equity (seeded; sample counts recorded in the class table)
// ---------------------------------------------------------------------------

fn showdown(hero_pairs: &[u64; 6], opp_pairs: &[u64; 6], board: HandMask) -> f64 {
    let bt = extract_board_triples(board);
    let h = eval_omaha_pairs_triples(hero_pairs, &bt);
    let v = eval_omaha_pairs_triples(opp_pairs, &bt);
    match h.cmp(&v) {
        std::cmp::Ordering::Greater => 1.0,
        std::cmp::Ordering::Less => 0.0,
        std::cmp::Ordering::Equal => 0.5,
    }
}

fn derive_seed(master: u64, tag: u64, index: usize) -> u64 {
    master
        ^ tag.wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ^ (index as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F)
}

/// Seeded Monte Carlo equity of `hero` vs a uniformly random opposing hand
/// (exact card removal: 9 cards dealt from the 48 unseen).
pub fn equity_vs_random(hero: &[Card; 4], samples: usize, seed: u64) -> f64 {
    let hero_mask = HandMask::from_cards(hero);
    let hero_pairs = extract_hole_pairs(hero_mask);
    let mut deck: Vec<Card> = Card::ALL.iter().copied().filter(|c| !hero_mask.contains(*c)).collect();
    let mut rng = DeterministicRng::from_seed(seed);
    let mut total = 0.0f64;
    for _ in 0..samples {
        let drawn: Vec<Card> = rng.sample_cards(&mut deck, 9).to_vec();
        let opp_mask = HandMask::from_cards(&drawn[0..4]);
        let board = HandMask::from_cards(&drawn[4..9]);
        total += showdown(&hero_pairs, &extract_hole_pairs(opp_mask), board);
    }
    total / samples as f64
}

/// A weighted pool of concrete combos to sample opponents from.
pub struct ComboPool {
    masks: Vec<HandMask>,
    hole_pairs: Vec<[u64; 6]>,
    cumulative: Vec<f64>,
    total: f64,
}

impl ComboPool {
    /// Builds a pool from `(combo, weight)` pairs (weights > 0).
    pub fn new(entries: Vec<(HandMask, f64)>) -> Self {
        let mut masks = Vec::with_capacity(entries.len());
        let mut hole_pairs = Vec::with_capacity(entries.len());
        let mut cumulative = Vec::with_capacity(entries.len());
        let mut run = 0.0f64;
        for (mask, w) in entries {
            if w <= 0.0 {
                continue;
            }
            run += w;
            masks.push(mask);
            hole_pairs.push(extract_hole_pairs(mask));
            cumulative.push(run);
        }
        ComboPool { masks, hole_pairs, cumulative, total: run }
    }

    pub fn is_empty(&self) -> bool {
        self.masks.is_empty()
    }

    fn sample_index(&self, rng: &mut DeterministicRng) -> usize {
        let u = rng.next_f64() * self.total;
        match self.cumulative.binary_search_by(|w| w.partial_cmp(&u).unwrap_or(std::cmp::Ordering::Equal)) {
            Ok(i) => i.min(self.masks.len() - 1),
            Err(i) => i.min(self.masks.len() - 1),
        }
    }
}

/// Seeded Monte Carlo equity of `hero` vs opponents sampled from `pool`
/// (weighted, with card removal: overlapping combos are redrawn, then the
/// board is dealt from the remaining cards).
pub fn equity_vs_pool(hero: &[Card; 4], pool: &ComboPool, samples: usize, seed: u64) -> f64 {
    let hero_mask = HandMask::from_cards(hero);
    let hero_pairs = extract_hole_pairs(hero_mask);
    let full = HandMask::FULL_DECK;
    let mut rng = DeterministicRng::from_seed(seed);
    let mut total = 0.0f64;
    let mut counted = 0usize;
    for _ in 0..samples {
        let mut opp_idx = pool.sample_index(&mut rng);
        let mut attempts = 0;
        while pool.masks[opp_idx].overlaps(hero_mask) && attempts < 64 {
            opp_idx = pool.sample_index(&mut rng);
            attempts += 1;
        }
        if pool.masks[opp_idx].overlaps(hero_mask) {
            continue;
        }
        let remaining = full - hero_mask - pool.masks[opp_idx];
        let mut deck: Vec<Card> = remaining.iter().collect();
        let board_cards: Vec<Card> = rng.sample_cards(&mut deck, 5).to_vec();
        let board = HandMask::from_cards(&board_cards);
        total += showdown(&hero_pairs, &pool.hole_pairs[opp_idx], board);
        counted += 1;
    }
    if counted == 0 {
        0.5
    } else {
        total / counted as f64
    }
}

// ---------------------------------------------------------------------------
// Selection: ramped top-slice fitting to a target total frequency
// ---------------------------------------------------------------------------

/// Assigns frequencies in [0,1] to items ranked best-first so that
/// `sum(mass[i] * freq[i]) == target` (to <1e-9 before rounding).
///
/// * `mass[i]` is item i's share of all combos; `capacity[i]` caps item i's
///   frequency (1.0 for a fresh set; for call selection it is the share of the
///   hand not already taken by 3-betting, and `mass` is then the *callable*
///   mass `share * capacity`).
/// * A linear ramp over `band` (in cumulative-mass units) around the target
///   smooths the boundary: items whose mass midpoint lies above the band get
///   their full capacity, below it get 0, inside it a proportional share.
/// * A deterministic residual correction then walks items nearest the
///   boundary first and nudges frequencies (within [0, capacity]) until the
///   total matches the target.
pub fn fit_to_target(mass: &[f64], capacity: &[f64], target: f64, band: f64) -> Vec<f64> {
    let n = mass.len();
    let mut freq = vec![0.0f64; n];
    let upper = target + band / 2.0;
    let mut cum = 0.0f64;
    for i in 0..n {
        let mid = cum + mass[i] / 2.0;
        let raw = if band > 0.0 {
            ((upper - mid) / band).clamp(0.0, 1.0)
        } else if mid < target {
            1.0
        } else {
            0.0
        };
        freq[i] = raw * capacity[i];
        cum += mass[i];
    }
    // Residual correction, boundary-nearest items first.
    let mut achieved: f64 = mass.iter().zip(freq.iter()).map(|(m, f)| m * f).sum();
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| {
        let da = (freq[a] / capacity[a].max(1e-12) - 0.5).abs();
        let db = (freq[b] / capacity[b].max(1e-12) - 0.5).abs();
        da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal).then(a.cmp(&b))
    });
    for &i in &order {
        let diff = target - achieved;
        if diff.abs() < 1e-12 {
            break;
        }
        if mass[i] <= 0.0 {
            continue;
        }
        let delta = (diff / mass[i]).clamp(-freq[i], capacity[i] - freq[i]);
        if delta != 0.0 {
            freq[i] += delta;
            achieved += delta * mass[i];
        }
    }
    freq
}

// ---------------------------------------------------------------------------
// Range-set documents
// ---------------------------------------------------------------------------

/// One constructed range set, ready to serialise. `hands` maps canonical
/// hand keys to action -> frequency maps (frequencies sum to 1 per hand).
#[derive(Clone, Debug)]
pub struct RangeSetDoc {
    pub id: String,
    pub table_size: String,
    pub position: String,
    pub context: String,
    pub context_detail: Option<String>,
    pub target_kind: String,
    /// Construction targets for this set's non-fold actions.
    pub targets: BTreeMap<String, f64>,
    /// Achieved totals (combo-weighted) for the non-fold actions.
    pub achieved: BTreeMap<String, f64>,
    pub hands: BTreeMap<String, BTreeMap<String, f64>>,
    /// Provenance method for this document (`METHOD` for v1 sets,
    /// `METHOD_V11` for continuation sets).
    pub method: String,
    /// When `Some`, provenance is emitted as `sources: []` plus this
    /// derivation text and no top-level `source` block is written. v1 9-max
    /// sets carry the seat-mapping derivation here; v1.1 continuation sets
    /// carry their construction description (naming the input sets). `None`
    /// (v1 6-max sets) keeps the cross-check-sources provenance shape.
    pub derivation: Option<String>,
    /// When `Some`, this text replaces the generated `notes` string
    /// verbatim (v1.1 sets state their target units explicitly: fractions
    /// of the opener's raising range, not of all combos).
    pub notes_override: Option<String>,
}

fn round6(x: f64) -> f64 {
    (x * 1e6).round() / 1e6
}

fn fmt_num(x: f64) -> String {
    if x == x.trunc() && x.abs() < 1e15 {
        format!("{x:.1}")
    } else {
        let s = format!("{x:.6}");
        let s = s.trim_end_matches('0').trim_end_matches('.');
        s.to_string()
    }
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out
}

fn source_json(src: &SourceBlock, indent: &str) -> String {
    let mut s = format!(
        "{{\n{indent}  \"name\": \"{}\",\n",
        json_escape(&src.name)
    );
    if let Some(url) = &src.url {
        let _ = write!(s, "{indent}  \"url\": \"{}\",\n", json_escape(url));
    }
    let _ = write!(
        s,
        "{indent}  \"licence\": \"{}\",\n{indent}  \"retrieved\": \"{}\"\n{indent}}}",
        json_escape(&src.licence),
        json_escape(&src.retrieved)
    );
    s
}

impl RangeSetDoc {
    /// Serialises to the rangeset JSON format (amended schema: see
    /// data/preflop/rangeset.schema.json — `source` is present on sourced
    /// sets; constructed sets always carry a `provenance` block).
    pub fn to_json(&self, cfg: &RangesConfig) -> String {
        let mut s = String::with_capacity(1 << 20);
        s.push_str("{\n");
        let _ = writeln!(s, "  \"schema_version\": 1,");
        let _ = writeln!(s, "  \"id\": \"{}\",", json_escape(&self.id));
        let _ = writeln!(s, "  \"table_size\": \"{}\",", self.table_size);
        let _ = writeln!(s, "  \"position\": \"{}\",", self.position);
        let _ = writeln!(s, "  \"context\": \"{}\",", self.context);
        if let Some(detail) = &self.context_detail {
            let _ = writeln!(s, "  \"context_detail\": \"{}\",", json_escape(detail));
        }
        let _ = writeln!(s, "  \"stack_bb\": {},", fmt_num(cfg.stack_bb));
        let _ = writeln!(s, "  \"rake_note\": \"{}\",", json_escape(&cfg.rake_note));
        let achieved_txt = self
            .achieved
            .iter()
            .map(|(a, v)| format!("{a} {:.4}", v * 100.0))
            .collect::<Vec<_>>()
            .join(", ");
        let target_txt = self
            .targets
            .iter()
            .map(|(a, v)| format!("{a} {:.4}", v * 100.0))
            .collect::<Vec<_>>()
            .join(", ");
        let notes = match &self.notes_override {
            Some(text) => text.clone(),
            None => format!(
                "CONSTRUCTED range (method {}) — built by build-ranges from exact card features and seeded Monte Carlo equities against config targets; NOT solver output, NOT GTO. Target ({}) vs achieved ({}) in % of all combos. Target kind: {}.",
                self.method, target_txt, achieved_txt, self.target_kind
            ),
        };
        let _ = writeln!(s, "  \"notes\": \"{}\",", json_escape(&notes));
        if self.table_size == "6max" && self.derivation.is_none() {
            let _ = writeln!(s, "  \"source\": {},", source_json(&cfg.cross_check_source, "  "));
        }
        // Provenance block.
        s.push_str("  \"provenance\": {\n");
        let _ = writeln!(s, "    \"method\": \"{}\",", self.method);
        let _ = writeln!(s, "    \"tool\": \"build-ranges (plo-solve)\",");
        let _ = writeln!(s, "    \"tool_version\": \"{}\",", env!("CARGO_PKG_VERSION"));
        let _ = writeln!(s, "    \"config_version\": \"{}\",", json_escape(&cfg.version));
        let _ = writeln!(s, "    \"config_hash\": \"fnv1a64:{}\",", cfg.config_hash);
        if let Some(derivation) = &self.derivation {
            s.push_str("    \"sources\": [],\n");
            let _ = writeln!(s, "    \"derivation\": \"{}\"", json_escape(derivation));
        } else if self.table_size == "6max" {
            let mut sources = source_json(&cfg.cross_check_source, "    ");
            if let Some(s2) = &cfg.cross_check_source_2 {
                sources.push_str(",\n    ");
                sources.push_str(&source_json(s2, "    "));
            }
            let _ = writeln!(s, "    \"sources\": [{sources}]");
        } else {
            s.push_str("    \"sources\": [],\n");
            let _ = writeln!(s, "    \"derivation\": \"{}\"", json_escape(&cfg.derivation_note_9max));
        }
        s.push_str("  },\n");
        // Hands.
        s.push_str("  \"hands\": {");
        let mut first = true;
        for (hand, actions) in &self.hands {
            if !first {
                s.push(',');
            }
            first = false;
            let _ = write!(s, "\n    \"{hand}\": {{");
            let mut afirst = true;
            for action in ["fold", "call", "raise", "three_bet", "four_bet"] {
                if let Some(&f) = actions.get(action) {
                    if f <= 0.0 {
                        continue;
                    }
                    if !afirst {
                        s.push_str(", ");
                    }
                    afirst = false;
                    let _ = write!(s, "\"{action}\": {}", fmt_num(round6(f)));
                }
            }
            s.push('}');
        }
        s.push_str("\n  }\n}\n");
        s
    }
}

/// Slugifies a position for use in a set id (`UTG+1` -> `utgplus1`).
pub fn slug(s: &str) -> String {
    s.to_lowercase().replace('+', "plus")
}

// ---------------------------------------------------------------------------
// Generation pipeline
// ---------------------------------------------------------------------------

/// A class with features and equities attached.
#[derive(Clone, Debug)]
pub struct ScoredClass {
    pub class: HandClass,
    pub features: Features,
    pub equity_vs_random: f64,
    pub equity_vs_reference: f64,
    pub score: f64,
}

pub struct Generation {
    pub classes: Vec<ScoredClass>,
    pub sets: Vec<RangeSetDoc>,
}

const SEED_TAG_RANDOM: u64 = 1;
const SEED_TAG_REFERENCE: u64 = 2;
const SEED_TAG_OPENER_BASE: u64 = 3;
/// Base tag for the v1.1 equity-vs-three-bettor streams (kept far from the
/// opener tags, which stay below ~111,000, so streams never collide).
const SEED_TAG_CONTINUATION_BASE: u64 = 900_000;

/// Deterministic parallel map over `0..n` producing one f64 per index.
/// Per-index results depend only on the index (each equity stream has its
/// own derived seed), so the output is identical for any thread count.
fn par_map(n: usize, f: &(dyn Fn(usize) -> f64 + Sync)) -> Vec<f64> {
    let threads = std::thread::available_parallelism()
        .map(|v| v.get())
        .unwrap_or(1)
        .min(n.max(1));
    if threads <= 1 || n < 4096 {
        return (0..n).map(|i| f(i)).collect();
    }
    let chunk = (n + threads - 1) / threads;
    let mut out = vec![0.0f64; n];
    std::thread::scope(|s| {
        let mut handles = Vec::new();
        let mut start = 0usize;
        while start < n {
            let end = (start + chunk).min(n);
            handles.push((start, s.spawn(move || (start..end).map(|i| f(i)).collect::<Vec<f64>>())));
            start = end;
        }
        for (start, h) in handles {
            let vals = h.join().expect("equity worker thread panicked");
            out[start..start + vals.len()].copy_from_slice(&vals);
        }
    });
    out
}

/// Stage 1–4: enumerate classes, compute equities vs random and vs the
/// reference range, compute features and scores. Kept separate from set
/// construction so tests can run partial pipelines cheaply.
pub fn score_all_classes(cfg: &RangesConfig) -> Vec<ScoredClass> {
    let classes = enumerate_classes();
    let eq_random: Vec<f64> = par_map(classes.len(), &|i| {
        equity_vs_random(
            &classes[i].representative,
            cfg.samples_vs_random,
            derive_seed(cfg.seed, SEED_TAG_RANDOM, i),
        )
    });
    // Reference range: top fraction by equity vs random, combo-weighted.
    let mut by_eq: Vec<usize> = (0..classes.len()).collect();
    by_eq.sort_by(|&a, &b| {
        eq_random[b]
            .partial_cmp(&eq_random[a])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(classes[a].key.cmp(&classes[b].key))
    });
    let mut in_ref = vec![false; classes.len()];
    let mut acc = 0u64;
    let want = (cfg.reference_top_fraction * TOTAL_COMBOS as f64) as u64;
    for &i in &by_eq {
        if acc >= want {
            break;
        }
        in_ref[i] = true;
        acc += classes[i].multiplicity as u64;
    }
    let mut pool_entries: Vec<(HandMask, f64)> = Vec::new();
    for (i, c) in classes.iter().enumerate() {
        if in_ref[i] {
            for &m in &c.combos {
                pool_entries.push((m, 1.0));
            }
        }
    }
    let pool = ComboPool::new(pool_entries);
    let eq_refs: Vec<f64> = if pool.is_empty() {
        eq_random.clone()
    } else {
        par_map(classes.len(), &|i| {
            equity_vs_pool(
                &classes[i].representative,
                &pool,
                cfg.samples_vs_reference,
                derive_seed(cfg.seed, SEED_TAG_REFERENCE, i),
            )
        })
    };
    classes
        .into_iter()
        .enumerate()
        .map(|(i, class)| {
            let eq_ref = eq_refs[i];
            let features = compute_features(&class.representative, cfg);
            let score = score_from_components(cfg, eq_random[i], eq_ref, &features);
            ScoredClass { class, features, equity_vs_random: eq_random[i], equity_vs_reference: eq_ref, score }
        })
        .collect()
}

/// Ranked class indices (score descending, key ascending tie-break) plus
/// each class's combo-mass share, in ranked order.
fn ranked_by<'a, F>(classes: &'a [ScoredClass], key: F) -> (Vec<usize>, Vec<f64>)
where
    F: Fn(&ScoredClass) -> f64,
{
    let mut idx: Vec<usize> = (0..classes.len()).collect();
    idx.sort_by(|&a, &b| {
        key(&classes[b])
            .partial_cmp(&key(&classes[a]))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(classes[a].class.key.cmp(&classes[b].class.key))
    });
    let mass: Vec<f64> = idx
        .iter()
        .map(|&i| classes[i].class.multiplicity as f64 / TOTAL_COMBOS as f64)
        .collect();
    (idx, mass)
}

fn achieved_total(classes: &[ScoredClass], freqs: &[f64], ranked_idx: &[usize]) -> f64 {
    ranked_idx
        .iter()
        .map(|&i| classes[i].class.multiplicity as f64 / TOTAL_COMBOS as f64 * freqs[i])
        .sum()
}

/// Builds one RFI (or SB sb_play) set for `position`.
pub fn build_rfi_set(
    cfg: &RangesConfig,
    classes: &[ScoredClass],
    table_size: &str,
    position: &str,
) -> Result<RangeSetDoc, String> {
    let target = cfg
        .rfi_targets
        .get(table_size)
        .and_then(|m| m.get(position))
        .ok_or_else(|| format!("no RFI target for {table_size} {position}"))?;
    let (ranked, mass) = ranked_by(classes, |c| c.score);
    let capacity = vec![1.0f64; ranked.len()];
    let ranked_freq = fit_to_target(&mass, &capacity, target.target, cfg.ramp_band);
    let mut freq = vec![0.0f64; classes.len()];
    for (r, &i) in ranked.iter().enumerate() {
        freq[i] = ranked_freq[r];
    }
    let achieved = achieved_total(classes, &freq, &ranked);
    let context = if position == "SB" { "sb_play" } else { "rfi" };
    let mut hands: BTreeMap<String, BTreeMap<String, f64>> = BTreeMap::new();
    for (i, c) in classes.iter().enumerate() {
        let mut actions = BTreeMap::new();
        let raise = round6(freq[i]);
        if raise > 0.0 {
            actions.insert("raise".to_string(), raise);
        }
        let fold = round6(1.0 - raise);
        if fold > 0.0 {
            actions.insert("fold".to_string(), fold);
        }
        if actions.is_empty() {
            actions.insert("fold".to_string(), 1.0);
        }
        hands.insert(c.class.key.clone(), actions);
    }
    let mut targets = BTreeMap::new();
    targets.insert("raise".to_string(), target.target);
    let mut achieved_map = BTreeMap::new();
    achieved_map.insert("raise".to_string(), achieved);
    Ok(RangeSetDoc {
        id: format!("constructed-v1-{}-{}-{}", table_size, slug(position), if context == "sb_play" { "sbplay" } else { "rfi" }),
        table_size: table_size.to_string(),
        position: position.to_string(),
        context: context.to_string(),
        context_detail: None,
        target_kind: target.kind.clone(),
        targets,
        achieved: achieved_map,
        hands,
        method: METHOD.to_string(),
        derivation: if table_size == "9max" {
            Some(cfg.derivation_note_9max.clone())
        } else {
            None
        },
        notes_override: None,
    })
}

/// Builds one vs_rfi response set: `responder` facing an open from `opener`,
/// whose constructed RFI frequencies are `opener_freq` (per class index).
/// `eq_vs_opener` is each class's equity vs that opener's range.
pub fn build_response_set(
    cfg: &RangesConfig,
    classes: &[ScoredClass],
    eq_vs_opener: &[f64],
    table_size: &str,
    responder: &str,
    opener: &str,
) -> Result<RangeSetDoc, String> {
    let target = cfg
        .response_targets
        .get(table_size)
        .and_then(|m| m.get(responder))
        .and_then(|m| m.get(opener))
        .ok_or_else(|| format!("no response target for {table_size} {responder} vs {opener}"))?;
    // 3-bet slice: rank by response score (equity vs opener in the
    // equity_vs_reference weight slot).
    let resp_score: Vec<f64> = classes
        .iter()
        .enumerate()
        .map(|(i, c)| score_from_components(cfg, c.equity_vs_random, eq_vs_opener[i], &c.features))
        .collect();
    let mut idx: Vec<usize> = (0..classes.len()).collect();
    idx.sort_by(|&a, &b| {
        resp_score[b]
            .partial_cmp(&resp_score[a])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(classes[a].class.key.cmp(&classes[b].class.key))
    });
    let ranked_mass: Vec<f64> = idx
        .iter()
        .map(|&i| classes[i].class.multiplicity as f64 / TOTAL_COMBOS as f64)
        .collect();
    let cap_all = vec![1.0f64; classes.len()];
    let tb_ranked = fit_to_target(&ranked_mass, &cap_all, target.three_bet, cfg.ramp_band);
    let mut three_bet = vec![0.0f64; classes.len()];
    for (r, &i) in idx.iter().enumerate() {
        three_bet[i] = tb_ranked[r];
    }
    // Call slice: rank remaining classes by discounted equity vs opener.
    let factor = if is_in_position_postflop(responder, opener) {
        cfg.realisation_in_position
    } else {
        cfg.realisation_out_of_position
    };
    let discounted: Vec<f64> = eq_vs_opener.iter().map(|e| e * factor).collect();
    let mut floor = cfg.call_equity_floor;
    let (call, used_floor) = loop {
        let mut cidx: Vec<usize> = (0..classes.len())
            .filter(|&i| discounted[i] >= floor)
            .collect();
        cidx.sort_by(|&a, &b| {
            discounted[b]
                .partial_cmp(&discounted[a])
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(resp_score[b].partial_cmp(&resp_score[a]).unwrap_or(std::cmp::Ordering::Equal))
                .then(classes[a].class.key.cmp(&classes[b].class.key))
        });
        let cmass: Vec<f64> = cidx
            .iter()
            .map(|&i| {
                classes[i].class.multiplicity as f64 / TOTAL_COMBOS as f64 * (1.0 - three_bet[i])
            })
            .collect();
        let callable: f64 = cmass.iter().sum();
        if callable >= target.call || floor <= 0.0 {
            let ccap: Vec<f64> = cidx.iter().map(|_| 1.0).collect();
            let g = fit_to_target(&cmass, &ccap, target.call.min(callable), cfg.ramp_band);
            let mut call = vec![0.0f64; classes.len()];
            for (r, &i) in cidx.iter().enumerate() {
                call[i] = (1.0 - three_bet[i]) * g[r];
            }
            break (call, floor);
        }
        floor = (floor - 0.02).max(0.0);
    };
    let _ = used_floor;
    let achieved_tb = achieved_total(classes, &three_bet, &(0..classes.len()).collect::<Vec<_>>());
    let achieved_call = achieved_total(classes, &call, &(0..classes.len()).collect::<Vec<_>>());
    let mut hands: BTreeMap<String, BTreeMap<String, f64>> = BTreeMap::new();
    for (i, c) in classes.iter().enumerate() {
        let tb = round6(three_bet[i]);
        let ca = round6(call[i]);
        let fo = round6(1.0 - tb - ca);
        let mut actions = BTreeMap::new();
        if fo > 0.0 {
            actions.insert("fold".to_string(), fo);
        }
        if ca > 0.0 {
            actions.insert("call".to_string(), ca);
        }
        if tb > 0.0 {
            actions.insert("three_bet".to_string(), tb);
        }
        if actions.is_empty() {
            actions.insert("fold".to_string(), 1.0);
        }
        hands.insert(c.class.key.clone(), actions);
    }
    let mut targets = BTreeMap::new();
    targets.insert("three_bet".to_string(), target.three_bet);
    targets.insert("call".to_string(), target.call);
    let mut achieved_map = BTreeMap::new();
    achieved_map.insert("three_bet".to_string(), achieved_tb);
    achieved_map.insert("call".to_string(), achieved_call);
    Ok(RangeSetDoc {
        id: format!(
            "constructed-v1-{}-{}-vs-{}",
            table_size,
            slug(responder),
            slug(opener)
        ),
        table_size: table_size.to_string(),
        position: responder.to_string(),
        context: "vs_rfi".to_string(),
        context_detail: Some(format!("vs {opener} open (constructed response set)")),
        target_kind: target.kind.clone(),
        targets,
        achieved: achieved_map,
        hands,
        method: METHOD.to_string(),
        derivation: if table_size == "9max" {
            Some(cfg.derivation_note_9max.clone())
        } else {
            None
        },
        notes_override: None,
    })
}

/// Builds one v1.1 continuation set (context `vs_three_bet`): `matchup`'s
/// opener has opened (per-class RFI raise frequencies `opener_freq`, read
/// from the emitted RFI set, so eligibility is exactly "opened in that
/// set") and now faces a 3-bet from `matchup`'s three-bettor.
/// `eq_vs_three_bettor` is each class's seeded Monte Carlo equity against
/// the three-bettor's `three_bet` slice.
///
/// Construction: eligible classes (opener raise frequency > 0) are ranked
/// by the v1 score blend with the equity slot filled by equity vs the
/// three-bettor's range, discounted by the continuer's postflop
/// realisation factor (in position 0.92 / out of position 0.84, from the
/// v1 config). The `four_bet` slice takes the top band and `call` the next
/// band, fitted in opening-range weight (class combo share x opener raise
/// frequency) with the v1 ramp + residual correction. Emitted frequencies
/// are conditional on having opened: fold + call + four_bet = 1 for
/// eligible classes; never-opened classes fold at 1.0.
///
/// Targets are fractions OF THE OPENER'S RAISING RANGE (see the config's
/// `continuations_v11` section): internal construction parameters with no
/// published cross-check anchor, labelled as such in the emitted notes and
/// provenance derivation.
pub fn build_continuation_set(
    cfg: &RangesConfig,
    classes: &[ScoredClass],
    eq_vs_three_bettor: &[f64],
    opener_freq: &[f64],
    matchup: &ContinuationMatchup,
) -> Result<RangeSetDoc, String> {
    let cont = cfg
        .continuations
        .as_ref()
        .ok_or("config has no continuations_v11 section")?;
    let continuer = matchup.continuer.as_str();
    let three_bettor = matchup.three_bettor.as_str();
    let share: Vec<f64> = classes
        .iter()
        .map(|c| c.class.multiplicity as f64 / TOTAL_COMBOS as f64)
        .collect();
    let open_weight: Vec<f64> = share
        .iter()
        .zip(opener_freq.iter())
        .map(|(s, f)| s * f)
        .collect();
    let open_total: f64 = open_weight.iter().sum();
    if open_total <= 0.0 {
        return Err(format!(
            "continuation {continuer} vs {three_bettor}: opener's RFI set opens nothing"
        ));
    }
    // Targets, in opening-range weight units.
    let continue_w = open_total * cont.continue_fraction_of_open;
    let four_bet_w = continue_w * cont.four_bet_fraction_of_continue;
    let call_w = continue_w * cont.call_fraction_of_continue;
    // Score: v1 blend, equity slot = realisation-discounted equity vs the
    // three-bettor's three_bet slice.
    let in_position = is_in_position_postflop(continuer, three_bettor);
    let factor = if in_position {
        cfg.realisation_in_position
    } else {
        cfg.realisation_out_of_position
    };
    let scores: Vec<f64> = classes
        .iter()
        .enumerate()
        .map(|(i, c)| {
            score_from_components(cfg, c.equity_vs_random, eq_vs_three_bettor[i] * factor, &c.features)
        })
        .collect();
    let mut eligible: Vec<usize> = (0..classes.len())
        .filter(|&i| opener_freq[i] > 0.0)
        .collect();
    eligible.sort_by(|&a, &b| {
        scores[b]
            .partial_cmp(&scores[a])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(classes[a].class.key.cmp(&classes[b].class.key))
    });
    let mass: Vec<f64> = eligible.iter().map(|&i| open_weight[i]).collect();
    let capacity = vec![1.0f64; eligible.len()];
    let fb_ranked = fit_to_target(&mass, &capacity, four_bet_w, cfg.ramp_band);
    let mut four_bet = vec![0.0f64; classes.len()];
    for (r, &i) in eligible.iter().enumerate() {
        four_bet[i] = fb_ranked[r];
    }
    let callable_mass: Vec<f64> = eligible
        .iter()
        .map(|&i| open_weight[i] * (1.0 - four_bet[i]))
        .collect();
    let call_ranked = fit_to_target(&callable_mass, &capacity, call_w, cfg.ramp_band);
    let mut call = vec![0.0f64; classes.len()];
    for (r, &i) in eligible.iter().enumerate() {
        call[i] = (1.0 - four_bet[i]) * call_ranked[r];
    }
    let achieved_four_bet: f64 =
        eligible.iter().map(|&i| open_weight[i] * four_bet[i]).sum::<f64>() / open_total;
    let achieved_call: f64 =
        eligible.iter().map(|&i| open_weight[i] * call[i]).sum::<f64>() / open_total;
    let mut hands: BTreeMap<String, BTreeMap<String, f64>> = BTreeMap::new();
    for (i, c) in classes.iter().enumerate() {
        let mut actions = BTreeMap::new();
        if opener_freq[i] > 0.0 {
            let fb = round6(four_bet[i]);
            let ca = round6(call[i]);
            let fo = round6(1.0 - fb - ca);
            if fo > 0.0 {
                actions.insert("fold".to_string(), fo);
            }
            if ca > 0.0 {
                actions.insert("call".to_string(), ca);
            }
            if fb > 0.0 {
                actions.insert("four_bet".to_string(), fb);
            }
        }
        if actions.is_empty() {
            actions.insert("fold".to_string(), 1.0);
        }
        hands.insert(c.class.key.clone(), actions);
    }
    let call_target = cont.continue_fraction_of_open * cont.call_fraction_of_continue;
    let four_bet_target = cont.continue_fraction_of_open * cont.four_bet_fraction_of_continue;
    let mut targets = BTreeMap::new();
    targets.insert("call".to_string(), call_target);
    targets.insert("four_bet".to_string(), four_bet_target);
    let mut achieved_map = BTreeMap::new();
    achieved_map.insert("call".to_string(), achieved_call);
    achieved_map.insert("four_bet".to_string(), achieved_four_bet);
    let derivation = format!(
        "constructed-equity-v1.1 continuation: eligible classes = the opener's RFI classes (input set {}, raise frequency > 0); scored against the three-bettor's three_bet slice (input set {}) with realisation {} (continuer {} postflop). Continuation targets are INTERNAL CONSTRUCTION PARAMETERS - fractions of the opener's raising range by weight (continue {:.1}% of the opening range; of the continue slice, call {:.1}% / four_bet {:.1}%). cross_check: {}.",
        matchup.opener_rfi_set,
        matchup.three_bettor_set,
        fmt_num(factor),
        if in_position { "in position" } else { "out of position" },
        cont.continue_fraction_of_open * 100.0,
        cont.call_fraction_of_continue * 100.0,
        cont.four_bet_fraction_of_continue * 100.0,
        cont.cross_check_status
    );
    let notes = format!(
        "CONSTRUCTED range (method {METHOD_V11}) - built by build-ranges from the opener's constructed RFI set and the three-bettor's constructed three_bet slice; NOT solver output, NOT GTO. Target (call {:.4}, four_bet {:.4}) vs achieved (call {:.4}, four_bet {:.4}) in % OF THE OPENER'S RAISING RANGE (opening-range-weighted), not of all combos. Target kind: internal - internal construction parameters, no published anchor (cross_check: {}).",
        call_target * 100.0,
        four_bet_target * 100.0,
        achieved_call * 100.0,
        achieved_four_bet * 100.0,
        cont.cross_check_status
    );
    Ok(RangeSetDoc {
        id: ContinuationsConfig::set_id(matchup),
        table_size: "6max".to_string(),
        position: continuer.to_string(),
        context: "vs_three_bet".to_string(),
        context_detail: Some(format!(
            "{continuer} opens, {three_bettor} 3-bets, {continuer} continues (constructed)"
        )),
        target_kind: "internal".to_string(),
        targets,
        achieved: achieved_map,
        hands,
        method: METHOD_V11.to_string(),
        derivation: Some(derivation),
        notes_override: Some(notes),
    })
}

/// Recomputes a continuation set's action totals as fractions OF THE
/// OPENER'S RAISING RANGE (opening-range-weighted), from the emitted JSON
/// of the continuation set and of its opener RFI set. A class contributes
/// only through the weight with which the opener actually opens it, so the
/// totals are directly comparable to the config's internal continuation
/// targets. (Plain [`set_totals`] would weight every class equally and is
/// NOT meaningful for `vs_three_bet` sets.)
pub fn opening_weighted_totals(
    cont_doc: &JsonValue,
    opener_doc: &JsonValue,
    multiplicity: &HashMap<String, u32>,
) -> BTreeMap<String, f64> {
    let mut totals: BTreeMap<String, f64> = BTreeMap::new();
    let (opener_hands, cont_hands) = match (opener_doc.get("hands"), cont_doc.get("hands")) {
        (Some(JsonValue::Object(o)), Some(JsonValue::Object(c))) => (o, c),
        _ => return totals,
    };
    let cont_by_hand: HashMap<&str, &JsonValue> = cont_hands
        .iter()
        .map(|(hand, actions)| (hand.as_str(), actions))
        .collect();
    let mut denom = 0.0f64;
    for (hand, oacts) in opener_hands {
        let raise = match oacts.get("raise") {
            Some(v) => v.as_f64().unwrap_or(0.0),
            None => 0.0,
        };
        if raise <= 0.0 {
            continue;
        }
        let w = multiplicity.get(hand).copied().unwrap_or(0) as f64 / TOTAL_COMBOS as f64 * raise;
        denom += w;
        if let Some(JsonValue::Object(cacts)) = cont_by_hand.get(hand.as_str()) {
            for (action, freq) in cacts {
                if let Some(f) = freq.as_f64() {
                    *totals.entry(action.clone()).or_insert(0.0) += w * f;
                }
            }
        }
    }
    if denom > 0.0 {
        for v in totals.values_mut() {
            *v /= denom;
        }
    }
    totals
}

/// Builds the opener sampling pool from per-class RFI frequencies.
pub fn opener_pool(classes: &[ScoredClass], freq: &[f64]) -> ComboPool {
    let mut entries: Vec<(HandMask, f64)> = Vec::new();
    for (i, c) in classes.iter().enumerate() {
        if freq[i] > 0.0 {
            for &m in &c.class.combos {
                entries.push((m, freq[i]));
            }
        }
    }
    ComboPool::new(entries)
}

/// Extracts one action's per-class frequencies from a built set, aligned
/// with `classes` order (0 for classes absent or not taking the action).
pub fn action_freqs(doc: &RangeSetDoc, classes: &[ScoredClass], action: &str) -> Vec<f64> {
    classes
        .iter()
        .map(|c| {
            doc.hands
                .get(&c.class.key)
                .and_then(|a| a.get(action))
                .copied()
                .unwrap_or(0.0)
        })
        .collect()
}

/// Full generation: scores all classes, then builds every RFI and vs_rfi
/// set implied by the config targets.
pub fn generate(cfg: &RangesConfig) -> Result<Generation, String> {
    let classes = score_all_classes(cfg);
    let mut sets: Vec<RangeSetDoc> = Vec::new();
    // RFI sets first (responses are built against them).
    let mut rfi_docs: BTreeMap<(String, String), RangeSetDoc> = BTreeMap::new();
    for table in ["6max", "9max"] {
        let positions = positions_for(table).unwrap();
        for &pos in positions {
            if pos == "BB" {
                continue;
            }
            let doc = build_rfi_set(cfg, &classes, table, pos)?;
            rfi_docs.insert((table.to_string(), pos.to_string()), doc);
        }
    }
    for doc in rfi_docs.values() {
        sets.push(doc.clone());
    }
    // Response sets. Equities vs an opener's range are computed once per
    // (table, opener) and shared by every responder facing that opener.
    // The docs are also kept addressable: the v1.1 continuation stage needs
    // the three-bettors' three_bet slices.
    let mut response_docs: BTreeMap<(String, String, String), RangeSetDoc> = BTreeMap::new();
    let mut opener_eq: BTreeMap<(String, String), Vec<f64>> = BTreeMap::new();
    for table in ["6max", "9max"] {
        let positions = positions_for(table).unwrap();
        let responders: Vec<(&str, Vec<&str>)> = {
            let mut v: Vec<(&str, Vec<&str>)> = Vec::new();
            // BB vs everyone else.
            v.push(("BB", positions.iter().copied().filter(|&p| p != "BB").collect()));
            // SB vs every non-blind opener.
            v.push((
                "SB",
                positions.iter().copied().filter(|&p| p != "SB" && p != "BB").collect(),
            ));
            // BTN vs config list.
            let btn_openers: Vec<&str> = cfg
                .btn_vs
                .get(table)
                .map(|list| list.iter().map(|s| s.as_str()).collect())
                .unwrap_or_default();
            v.push(("BTN", btn_openers));
            v
        };
        for (responder, openers) in responders {
            for opener in openers {
                let cache_key = (table.to_string(), opener.to_string());
                if !opener_eq.contains_key(&cache_key) {
                    let rfi = rfi_docs
                        .get(&cache_key)
                        .ok_or_else(|| format!("missing RFI doc for {table} {opener}"))?;
                    let ofreq = action_freqs(rfi, &classes, "raise");
                    let pool = opener_pool(&classes, &ofreq);
                    let tag = SEED_TAG_OPENER_BASE + opener_seed_tag(table, opener);
                    let eq = par_map(classes.len(), &|i| {
                        equity_vs_pool(
                            &classes[i].class.representative,
                            &pool,
                            cfg.samples_vs_opener,
                            derive_seed(cfg.seed, tag, i),
                        )
                    });
                    opener_eq.insert(cache_key.clone(), eq);
                }
                let eq = &opener_eq[&cache_key];
                let doc = build_response_set(cfg, &classes, eq, table, responder, opener)?;
                response_docs.insert(
                    (table.to_string(), responder.to_string(), opener.to_string()),
                    doc.clone(),
                );
                sets.push(doc);
            }
        }
    }
    // v1.1 continuation sets (6max only): for each configured matchup, the
    // opener's continuation after facing a 3-bet. Equities are computed
    // against the three-bettor's three_bet slice, one seeded pass per
    // matchup.
    if let Some(cont) = &cfg.continuations {
        for (mi, matchup) in cont.matchups.iter().enumerate() {
            let rfi = rfi_docs
                .get(&("6max".to_string(), matchup.continuer.clone()))
                .ok_or_else(|| {
                    format!("missing RFI doc for 6max {}", matchup.continuer)
                })?;
            if rfi.id != matchup.opener_rfi_set {
                return Err(format!(
                    "continuations_v11 matchup {} vs {}: opener_rfi_set '{}' does not match the generated RFI set '{}'",
                    matchup.continuer, matchup.three_bettor, matchup.opener_rfi_set, rfi.id
                ));
            }
            let tb_doc = response_docs
                .get(&(
                    "6max".to_string(),
                    matchup.three_bettor.clone(),
                    matchup.continuer.clone(),
                ))
                .ok_or_else(|| {
                    format!(
                        "missing response doc for 6max {} vs {}",
                        matchup.three_bettor, matchup.continuer
                    )
                })?;
            if tb_doc.id != matchup.three_bettor_set {
                return Err(format!(
                    "continuations_v11 matchup {} vs {}: three_bettor_set '{}' does not match the generated response set '{}'",
                    matchup.continuer, matchup.three_bettor, matchup.three_bettor_set, tb_doc.id
                ));
            }
            let opener_freq = action_freqs(rfi, &classes, "raise");
            let tb_freq = action_freqs(tb_doc, &classes, "three_bet");
            let pool = opener_pool(&classes, &tb_freq);
            if pool.is_empty() {
                return Err(format!(
                    "continuation {} vs {}: three-bettor's three_bet slice is empty",
                    matchup.continuer, matchup.three_bettor
                ));
            }
            let tag = SEED_TAG_CONTINUATION_BASE + (mi as u64) * 10_000;
            let eq = par_map(classes.len(), &|i| {
                equity_vs_pool(
                    &classes[i].class.representative,
                    &pool,
                    cont.samples_vs_three_bettor,
                    derive_seed(cfg.seed, tag, i),
                )
            });
            let doc = build_continuation_set(cfg, &classes, &eq, &opener_freq, matchup)?;
            sets.push(doc);
        }
    }
    sets.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(Generation { classes, sets })
}

fn opener_seed_tag(table: &str, opener: &str) -> u64 {
    let mut h = if table == "6max" { 0u64 } else { 100u64 };
    for (i, p) in POSTFLOP_ORDER.iter().enumerate() {
        if *p == opener {
            h += i as u64 + 1;
        }
    }
    h * 1000
}

// ---------------------------------------------------------------------------
// Validation (mirrors the amended rangeset.schema.json)
// ---------------------------------------------------------------------------

const CONTEXT_ACTIONS: [(&str, &[&str]); 5] = [
    ("rfi", &["fold", "raise"]),
    ("vs_rfi", &["fold", "call", "three_bet"]),
    ("three_bet", &["fold", "call", "four_bet"]),
    ("sb_play", &["fold", "call", "raise", "three_bet"]),
    ("vs_three_bet", &["fold", "call", "four_bet"]),
];

fn valid_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return false;
    }
    let (y, m, d) = (
        s[0..4].parse::<u32>(),
        s[5..7].parse::<u32>(),
        s[8..10].parse::<u32>(),
    );
    match (y, m, d) {
        (Ok(_), Ok(m), Ok(d)) => (1..=12).contains(&m) && (1..=31).contains(&d),
        _ => false,
    }
}

fn check_source_block(v: &JsonValue, what: &str, url_required: bool, errors: &mut Vec<String>) {
    let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("");
    if name.is_empty() {
        errors.push(format!("{what}.name is required"));
    }
    match v.get("url").and_then(|x| x.as_str()) {
        Some(u) => {
            if !(u.starts_with("https://") || u.starts_with("http://")) {
                errors.push(format!("{what}.url is not an http(s) URL"));
            }
        }
        None => {
            if url_required {
                errors.push(format!("{what}.url is required"));
            }
        }
    }
    if v.get("licence").and_then(|x| x.as_str()).unwrap_or("").is_empty() {
        errors.push(format!("{what}.licence is required"));
    }
    let retrieved = v.get("retrieved").and_then(|x| x.as_str()).unwrap_or("");
    if !valid_date(retrieved) {
        errors.push(format!("{what}.retrieved is not a YYYY-MM-DD date"));
    }
}

/// Validates a rangeset document (already parsed) against the rules of the
/// amended schema. Returns a list of problems (empty = valid).
pub fn validate_rangeset(doc: &JsonValue) -> Vec<String> {
    let mut errors = Vec::new();
    if doc.get("schema_version").and_then(|v| v.as_f64()) != Some(1.0) {
        errors.push("schema_version must be 1".to_string());
    }
    let id = doc.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "._-".contains(c))
        || !id.chars().next().map(|c| c.is_ascii_alphanumeric()).unwrap_or(false)
    {
        errors.push(format!("id '{id}' is not a slug"));
    }
    let table = doc.get("table_size").and_then(|v| v.as_str()).unwrap_or("");
    let position = doc.get("position").and_then(|v| v.as_str()).unwrap_or("");
    match positions_for(table) {
        Some(list) => {
            if !list.contains(&position) {
                errors.push(format!("position '{position}' is not a {table} position"));
            }
        }
        None => errors.push(format!("table_size '{table}' must be 6max or 9max")),
    }
    let context = doc.get("context").and_then(|v| v.as_str()).unwrap_or("");
    let allowed = CONTEXT_ACTIONS.iter().find(|(c, _)| *c == context).map(|(_, a)| *a);
    match allowed {
        Some(_) => {}
        None => errors.push(format!("context '{context}' is not a known context")),
    }
    if context == "sb_play" && position != "SB" {
        errors.push("context 'sb_play' requires position 'SB'".to_string());
    }
    match doc.get("stack_bb").and_then(|v| v.as_f64()) {
        Some(x) if x > 0.0 && x <= 1000.0 => {}
        _ => errors.push("stack_bb must be a number in (0, 1000]".to_string()),
    }
    if doc.get("rake_note").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
        errors.push("rake_note is required".to_string());
    }
    // Amended provenance rule: `source` is required unless a `provenance`
    // block is present (constructed sets always carry one).
    match doc.get("source") {
        Some(src) => check_source_block(src, "source", true, &mut errors),
        None => {
            if doc.get("provenance").is_none() {
                errors.push("source is required when no provenance block is present".to_string());
            }
        }
    }
    if let Some(prov) = doc.get("provenance") {
        if prov.get("method").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
            errors.push("provenance.method is required".to_string());
        }
        match prov.get("sources").and_then(|v| v.as_array()) {
            Some(items) => {
                for (i, item) in items.iter().enumerate() {
                    check_source_block(item, &format!("provenance.sources[{i}]"), false, &mut errors);
                }
            }
            None => errors.push("provenance.sources must be an array".to_string()),
        }
    }
    // Hands.
    let hands = match doc.get("hands") {
        Some(JsonValue::Object(entries)) if !entries.is_empty() => entries.clone(),
        _ => {
            errors.push("hands must be a non-empty object".to_string());
            Vec::new()
        }
    };
    for (hand, actions) in &hands {
        if !is_canonical_key(hand) {
            errors.push(format!("hand '{hand}' is not a canonical representative key"));
        }
        let entries = match actions {
            JsonValue::Object(e) => e,
            _ => {
                errors.push(format!("{hand}: actions must be an object"));
                continue;
            }
        };
        let mut sum = 0.0f64;
        for (action, freq) in entries {
            if let Some(allowed) = allowed {
                if !allowed.contains(&action.as_str()) {
                    errors.push(format!("{hand}: action '{action}' not allowed in context '{context}'"));
                }
            }
            match freq.as_f64() {
                Some(f) if (0.0..=1.0).contains(&f) => sum += f,
                _ => errors.push(format!("{hand}: frequency for '{action}' outside [0,1]")),
            }
        }
        if (sum - 1.0).abs() > 0.0005 + 1e-9 {
            errors.push(format!("{hand}: frequencies sum to {sum}, expected 1"));
        }
    }
    errors
}

// ---------------------------------------------------------------------------
// Class table + index emission
// ---------------------------------------------------------------------------

/// Serialises the per-class feature/equity table (data/preflop/class-table.json).
pub fn class_table_json(cfg: &RangesConfig, classes: &[ScoredClass]) -> String {
    let mut s = String::with_capacity(1 << 22);
    s.push_str("{\n");
    let _ = writeln!(s, "  \"method\": \"{METHOD}\",");
    let _ = writeln!(s, "  \"tool\": \"build-ranges (plo-solve)\",");
    let _ = writeln!(s, "  \"tool_version\": \"{}\",", env!("CARGO_PKG_VERSION"));
    let _ = writeln!(s, "  \"config_version\": \"{}\",", json_escape(&cfg.version));
    let _ = writeln!(s, "  \"config_hash\": \"fnv1a64:{}\",", cfg.config_hash);
    let _ = writeln!(s, "  \"total_combos\": {TOTAL_COMBOS},");
    let _ = writeln!(s, "  \"class_count\": {},", classes.len());
    s.push_str("  \"equity_method\": \"seeded Monte Carlo (preflop hand-vs-range equity has no feasible exact enumeration; sample counts and seed recorded below)\",\n");
    let _ = writeln!(
        s,
        "  \"mc\": {{\"seed\": {}, \"samples_vs_random\": {}, \"samples_vs_reference\": {}, \"samples_vs_opener\": {}}},",
        cfg.seed, cfg.samples_vs_random, cfg.samples_vs_reference, cfg.samples_vs_opener
    );
    let _ = writeln!(
        s,
        "  \"reference_range\": \"top {} of classes by equity vs a random hand, combo-weighted\",",
        fmt_num(cfg.reference_top_fraction)
    );
    s.push_str("  \"classes\": [");
    for (i, c) in classes.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        let f = &c.features;
        let _ = write!(
            s,
            "\n    {{\"hand\": \"{}\", \"multiplicity\": {}, \"equity_vs_random\": {}, \"equity_vs_reference\": {}, \"score\": {}, \"features\": {{\"pair_kind\": \"{}\", \"top_pair_rank\": {}, \"suitedness\": \"{}\", \"rundown_len\": {}, \"pair_component\": {}, \"suitedness_component\": {}, \"connectedness_component\": {}, \"high_card_component\": {}}}}}",
            c.class.key,
            c.class.multiplicity,
            fmt_num(round6(c.equity_vs_random)),
            fmt_num(round6(c.equity_vs_reference)),
            fmt_num(round6(c.score)),
            f.pair_kind.as_str(),
            f.top_pair_rank,
            f.suitedness,
            f.rundown_len,
            fmt_num(round6(f.pair_component)),
            fmt_num(round6(f.suitedness_component)),
            fmt_num(round6(f.connectedness_component)),
            fmt_num(round6(f.high_card_component)),
        );
    }
    s.push_str("\n  ]\n}\n");
    s
}

/// One index.json entry for a constructed set.
pub fn index_entry_json(doc: &RangeSetDoc, cfg: &RangesConfig) -> String {
    let mut s = String::new();
    s.push_str("    {\n");
    let _ = writeln!(s, "      \"id\": \"{}\",", json_escape(&doc.id));
    let _ = writeln!(s, "      \"path\": \"sets/{}.json\",", json_escape(&doc.id));
    let _ = writeln!(s, "      \"table_size\": \"{}\",", doc.table_size);
    let _ = writeln!(s, "      \"position\": \"{}\",", doc.position);
    let _ = writeln!(s, "      \"context\": \"{}\",", doc.context);
    let _ = writeln!(s, "      \"stack_bb\": {},", fmt_num(cfg.stack_bb));
    if doc.table_size == "6max" && doc.derivation.is_none() {
        let _ = writeln!(s, "      \"source\": {},", source_json(&cfg.cross_check_source, "      "));
    }
    s.push_str("      \"provenance\": {\n");
    let _ = writeln!(s, "        \"method\": \"{}\",", doc.method);
    let _ = writeln!(s, "        \"config_version\": \"{}\",", json_escape(&cfg.version));
    let _ = writeln!(s, "        \"config_hash\": \"fnv1a64:{}\"", cfg.config_hash);
    s.push_str("      }\n    }");
    s
}

// ---------------------------------------------------------------------------
// Cross-check mode: diff emitted sets against the published targets
// ---------------------------------------------------------------------------

/// Recomputes a set's combo-weighted action totals from its emitted hands.
/// Needs class multiplicities, looked up by hand key.
pub fn set_totals(doc: &JsonValue, multiplicity: &HashMap<String, u32>) -> BTreeMap<String, f64> {
    let mut totals: BTreeMap<String, f64> = BTreeMap::new();
    if let Some(JsonValue::Object(hands)) = doc.get("hands") {
        for (hand, actions) in hands {
            let mult = multiplicity.get(hand).copied().unwrap_or(0) as f64;
            if let JsonValue::Object(acts) = actions {
                for (action, freq) in acts {
                    if let Some(f) = freq.as_f64() {
                        *totals.entry(action.clone()).or_insert(0.0) += mult * f / TOTAL_COMBOS as f64;
                    }
                }
            }
        }
    }
    totals
}

/// Extracts the opener position from a vs_rfi `context_detail` string of
/// the form "vs {OPENER} open (...)".
pub fn parse_opener(context_detail: &str) -> String {
    context_detail
        .strip_prefix("vs ")
        .and_then(|d| d.split(' ').next())
        .unwrap_or("")
        .to_string()
}

/// Compares one set's recomputed totals against the config targets.
/// Returns (report lines, hard failures) — see [`cross_check`] for what
/// counts as a hard failure. For `vs_three_bet` sets, `totals` must be the
/// OPENING-RANGE-WEIGHTED totals from [`opening_weighted_totals`] (the
/// config's continuation targets are fractions of the opener's raising
/// range, not of all combos); callers are responsible for passing those.
pub fn check_doc_totals(
    cfg: &RangesConfig,
    id: &str,
    table_size: &str,
    position: &str,
    context: &str,
    opener: Option<&str>,
    totals: &BTreeMap<String, f64>,
) -> (Vec<String>, usize) {
    let mut lines = Vec::new();
    let mut failures = 0usize;
    if context == "rfi" || context == "sb_play" {
        let achieved = totals.get("raise").copied().unwrap_or(0.0);
        match cfg.rfi_targets.get(table_size).and_then(|m| m.get(position)) {
            Some(t) => {
                let in_band = achieved >= t.band[0] - 1e-9 && achieved <= t.band[1] + 1e-9;
                if !in_band {
                    failures += 1;
                }
                lines.push(format!(
                    "{}: raise {:.2}% vs target {:.2}% (band {:.0}-{:.0}%, {}) {}",
                    id,
                    achieved * 100.0,
                    t.target * 100.0,
                    t.band[0] * 100.0,
                    t.band[1] * 100.0,
                    t.kind,
                    if in_band { "OK" } else { "OUT OF BAND" }
                ));
                if table_size == "6max" {
                    if let Some(u) = cfg.upswing_rfi.get(position) {
                        lines.push(format!(
                            "{}:   vs Upswing owner-provided total {:.1}% -> delta {:+.2}pp (informational)",
                            id,
                            u * 100.0,
                            (achieved - u) * 100.0
                        ));
                    }
                }
            }
            None => {
                lines.push(format!("{id}: no RFI target in config"));
                failures += 1;
            }
        }
    } else if context == "vs_rfi" {
        let opener = opener.unwrap_or("");
        match cfg
            .response_targets
            .get(table_size)
            .and_then(|m| m.get(position))
            .and_then(|m| m.get(opener))
        {
            Some(t) => {
                for (action, want) in [("three_bet", t.three_bet), ("call", t.call)] {
                    let achieved = totals.get(action).copied().unwrap_or(0.0);
                    let delta = (achieved - want) * 100.0;
                    let hard = t.kind == "anchor";
                    let bad = hard && (achieved - want).abs() > cfg.cross_check_defense_tolerance;
                    if bad {
                        failures += 1;
                    }
                    lines.push(format!(
                        "{}: {} {:.2}% vs target {:.2}% (delta {:+.2}pp, {}) {}",
                        id,
                        action,
                        achieved * 100.0,
                        want * 100.0,
                        delta,
                        t.kind,
                        if bad { "OUT OF TOLERANCE" } else { "OK" }
                    ));
                }
            }
            None => {
                lines.push(format!("{id}: no response target in config"));
                failures += 1;
            }
        }
    } else if context == "vs_three_bet" {
        // Internal construction contract (no published anchor): the
        // opening-range-weighted totals must land on the configured
        // internal targets within the same 0.5pp fit tolerance as v1.
        match cfg.continuations.as_ref().and_then(|c| {
            c.matchup_for_set_id(id).map(|m| (c, m))
        }) {
            Some((cont, _m)) => {
                let want_call = cont.continue_fraction_of_open * cont.call_fraction_of_continue;
                let want_fb = cont.continue_fraction_of_open * cont.four_bet_fraction_of_continue;
                for (action, want) in [("call", want_call), ("four_bet", want_fb)] {
                    let achieved = totals.get(action).copied().unwrap_or(0.0);
                    let delta = (achieved - want) * 100.0;
                    let bad = (achieved - want).abs() > 0.005;
                    if bad {
                        failures += 1;
                    }
                    lines.push(format!(
                        "{}: {} {:.2}% of opening range vs internal target {:.2}% (delta {:+.2}pp, internal - {}) {}",
                        id,
                        action,
                        achieved * 100.0,
                        want * 100.0,
                        delta,
                        cont.cross_check_status,
                        if bad { "OUT OF TOLERANCE" } else { "OK" }
                    ));
                }
            }
            None => {
                lines.push(format!("{id}: no continuations_v11 matchup in config for this set"));
                failures += 1;
            }
        }
    }
    (lines, failures)
}

/// Runs the cross-check over in-memory set documents (used right after
/// generation). Returns (report lines, number of hard failures). Hard
/// failures: RFI sets outside their published band; anchored defense totals
/// beyond the configured tolerance; v1.1 continuation totals beyond 0.5pp
/// of their INTERNAL targets (a construction-contract check only — there is
/// no published anchor for them). Interpolated/extrapolated/derived
/// totals and the Upswing totals are reported as deltas only.
pub fn cross_check(
    cfg: &RangesConfig,
    docs: &[RangeSetDoc],
    multiplicity: &HashMap<String, u32>,
) -> (Vec<String>, usize) {
    let mut lines = Vec::new();
    let mut failures = 0usize;
    lines.push(format!(
        "cross-check: constructed sets vs published targets (tolerance for anchored defense: {:.1}pp)",
        cfg.cross_check_defense_tolerance * 100.0
    ));
    for doc in docs {
        // Recompute achieved totals from the set's own hands via a JSON
        // round-trip, so the check measures the emitted document, not the
        // in-memory construction.
        let parsed = match JsonValue::parse(&doc.to_json(cfg)) {
            Ok(v) => v,
            Err(e) => {
                lines.push(format!("{}: JSON parse failed: {e}", doc.id));
                failures += 1;
                continue;
            }
        };
        let totals = if doc.context == "vs_three_bet" {
            // Continuation targets live in opening-range units: recompute
            // the totals weighted by the opener's RFI set (also present in
            // `docs`), round-tripped the same way.
            let opener_doc = cfg
                .continuations
                .as_ref()
                .and_then(|c| c.matchup_for_set_id(&doc.id))
                .and_then(|m| docs.iter().find(|d| d.id == m.opener_rfi_set));
            match opener_doc {
                Some(od) => match JsonValue::parse(&od.to_json(cfg)) {
                    Ok(op) => opening_weighted_totals(&parsed, &op, multiplicity),
                    Err(e) => {
                        lines.push(format!("{}: opener JSON parse failed: {e}", doc.id));
                        failures += 1;
                        continue;
                    }
                },
                None => {
                    lines.push(format!(
                        "{}: no opener RFI doc available for opening-weighted totals",
                        doc.id
                    ));
                    failures += 1;
                    continue;
                }
            }
        } else {
            set_totals(&parsed, multiplicity)
        };
        let opener = doc.context_detail.as_deref().map(parse_opener);
        let (mut dl, df) = check_doc_totals(
            cfg,
            &doc.id,
            &doc.table_size,
            &doc.position,
            &doc.context,
            opener.as_deref(),
            &totals,
        );
        lines.append(&mut dl);
        failures += df;
    }
    (lines, failures)
}

/// Minimal compact serializer for [`JsonValue`] (used to preserve foreign
/// index entries when build-ranges rewrites data/preflop/index.json).
pub fn json_to_compact(v: &JsonValue) -> String {
    let mut s = String::new();
    write_json_compact(v, &mut s);
    s
}

fn write_json_compact(v: &JsonValue, out: &mut String) {
    match v {
        JsonValue::Null => out.push_str("null"),
        JsonValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        JsonValue::Number(n) => out.push_str(&fmt_num(*n)),
        JsonValue::String(s) => {
            out.push('"');
            out.push_str(&json_escape(s));
            out.push('"');
        }
        JsonValue::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                write_json_compact(item, out);
            }
            out.push(']');
        }
        JsonValue::Object(entries) => {
            out.push('{');
            for (i, (k, val)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push_str(", ");
                }
                out.push('"');
                out.push_str(&json_escape(k));
                out.push_str("\": ");
                write_json_compact(val, out);
            }
            out.push('}');
        }
    }
}
