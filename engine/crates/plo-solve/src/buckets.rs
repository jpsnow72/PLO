//! Flop card bucketing (Ticket E4): texture-feature abstraction for the flop street.
//!
//! Exact heads-up flop trees are far too large to solve (the turn+river subtrees below
//! every flop history dominate memory), so the flop street is abstracted: combos that
//! "play the same" on a given flop share one strategy (one infoset per bucket instead
//! of one per combo). Turn and river play below the flop stays exact (see
//! [`crate::flop`]).
//!
//! # Features (never raw equity alone)
//!
//! Every combo on a fixed 3-card flop is mapped to a 12-dimensional texture-feature
//! vector ([`ComboFeatures`]), computed exactly from the cards (no sampling, no
//! equity anywhere in the vector — equity enters only implicitly through the
//! hand-structure features). The five feature families from the design spec:
//!
//! 1. **Pairedness (primary, highest distance weight):** hole pair structure
//!    (`f0`), pair height (`f1`), and pair interaction with the board (`f2`).
//! 2. **3-connectedness:** straight texture of the hole cards (`f3`) and
//!    straight-draw potential against the board (`f4`).
//! 3. **Flush-draw presence:** made flush-draw strength (`f5`) plus nut-flush
//!    blocker presence (`f6`).
//! 4. **Suitedness:** hole suit pattern (`f7`).
//! 5. **High/low distribution:** top-card strength (`f8`), low-card share (`f9`),
//!    overcard share vs the board (`f10`), and board-pairing interaction for
//!    the hole cards' ranks (`f11`: hole cards duplicating board ranks, i.e.
//!    trips/set potential and board-pair blockers).
//!
//! # Clustering algorithm (deterministic)
//!
//! Weighted k-means (Lloyd's algorithm) over the feature vectors:
//! - Distance is weighted Euclidean with per-dimension weights [`FEATURE_WEIGHTS`]
//!   (pairedness dimension `f0` carries the largest weight, per spec).
//! - Centroid initialisation is deterministic k-means++ driven by
//!   [`DeterministicRng`] with the fixed seed [`BUCKET_SEED`].
//! - Centroids are range-weight-weighted means of their members.
//! - Assignment ties break to the lowest centroid index; empty clusters are
//!   re-seeded to the member point with the largest weighted distance to its
//!   centroid (deterministic tie-break by combo index).
//! - At most [`KMEANS_ITERATIONS`] Lloyd iterations, stopping early when the
//!   assignment stops changing.
//!
//! Because every step is deterministic, the same `(board, range, K)` always yields
//! the same assignment. Combos with identical feature vectors always land in the
//! same bucket (they have identical distances to every centroid at every step).
//!
//! Bucket definitions serialise via [`BucketAssignment::to_json`] so the Explore
//! UI can display exactly which bucket a combo played in.

use std::fmt::Write as _;

use plo_cards::{Card, HandMask, Rank, Suit};
use plo_eval::{DeterministicRng, WeightedCombo};

/// Number of texture-feature dimensions in [`ComboFeatures`].
pub const FEATURE_DIMS: usize = 12;

/// Fixed RNG seed for deterministic k-means++ initialisation.
pub const BUCKET_SEED: u64 = 0xE4F1_0000_0000_0001;

/// Maximum Lloyd iterations for bucket clustering.
pub const KMEANS_ITERATIONS: usize = 50;

/// Per-dimension distance weights. Index 0 (pairedness) is primary per spec.
pub const FEATURE_WEIGHTS: [f64; FEATURE_DIMS] = [
    2.0,  // f0 hole pair structure (PRIMARY)
    1.0,  // f1 pair height
    1.0,  // f2 trips/set interaction with board pair
    1.5,  // f3 hole 3-connectedness
    1.0,  // f4 straight-draw potential vs board
    1.5,  // f5 flush-draw strength
    0.75, // f6 nut-flush blocker
    1.0,  // f7 suitedness pattern
    1.0,  // f8 top-card strength
    0.75, // f9 low-card share
    0.75, // f10 overcard share vs board
    0.75, // f11 hole duplicates of board ranks
];

/// The 12-dimensional texture-feature vector of one combo on one flop.
///
/// All components lie in `[0.0, 1.0]`. See the module docs for the families.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct ComboFeatures {
    /// The feature values, in the documented `f0..f11` order.
    pub values: [f64; FEATURE_DIMS],
}

impl ComboFeatures {
    /// Weighted squared Euclidean distance to another feature vector.
    #[inline]
    pub fn weighted_dist_sq(&self, other: &ComboFeatures) -> f64 {
        let mut sum = 0.0f64;
        for d in 0..FEATURE_DIMS {
            let diff = self.values[d] - other.values[d];
            sum += FEATURE_WEIGHTS[d] * diff * diff;
        }
        sum
    }
}

/// Rank as a low-card-aware index: Ace counts as both 12 (high) and -1 (low, for
/// wheel windows). Returns the plain index `0..12`.
#[inline]
fn rank_idx(card: Card) -> i32 {
    card.rank().index() as i32
}

/// Computes the exact texture-feature vector of `combo` on the 3-card `board`.
pub fn combo_features(board: &[Card; 3], combo: &WeightedCombo) -> ComboFeatures {
    let hole = combo.cards;
    let mut hole_ranks: Vec<i32> = hole.iter().map(|&c| rank_idx(c)).collect();
    hole_ranks.sort_unstable_by(|a, b| b.cmp(a)); // descending
    let board_ranks: Vec<i32> = board.iter().map(|&c| rank_idx(c)).collect();

    // ---- Family 1: pairedness -------------------------------------------
    // Count multiplicities of hole ranks.
    let mut rank_count = [0u32; 13];
    for &r in &hole_ranks {
        rank_count[r as usize] += 1;
    }
    let mut pairs = 0u32;
    let mut trips = false;
    let mut quads = false;
    let mut highest_pair_rank = -1i32;
    for (r, &cnt) in rank_count.iter().enumerate() {
        match cnt {
            2 => {
                pairs += 1;
                highest_pair_rank = highest_pair_rank.max(r as i32);
            }
            3 => {
                trips = true;
                highest_pair_rank = highest_pair_rank.max(r as i32);
            }
            4 => {
                quads = true;
                highest_pair_rank = highest_pair_rank.max(r as i32);
            }
            _ => {}
        }
    }
    let f0 = if quads {
        1.0
    } else if trips {
        0.8
    } else if pairs == 2 {
        0.65
    } else if pairs == 1 {
        0.4
    } else {
        0.0
    };
    let f1 = if highest_pair_rank >= 0 {
        highest_pair_rank as f64 / 12.0
    } else {
        0.0
    };
    // f2: interaction with a paired board — a hole card matching the board pair's
    // rank makes trips/full-house texture; matching a single board rank is a pair
    // with the board. (Board-pairing interaction of hole ranks is also f11; f2 is
    // specifically about the board being paired.)
    let board_pair_rank: Option<i32> = {
        let mut bc = [0u32; 13];
        for &r in &board_ranks {
            bc[r as usize] += 1;
        }
        (0..13).find(|&r| bc[r] >= 2).map(|r| r as i32)
    };
    let f2 = match board_pair_rank {
        Some(pr) => {
            if rank_count[pr as usize] > 0 {
                1.0 // hole card(s) on the board pair rank: trips+ texture
            } else if pairs > 0 || trips || quads {
                0.45 // own pair plays differently on a paired board
            } else {
                0.0
            }
        }
        None => 0.0,
    };

    // ---- Family 2: connectedness ----------------------------------------
    // Distinct hole ranks, with Ace duplicated as -1 for wheel windows.
    let mut distinct: Vec<i32> = Vec::with_capacity(5);
    for &r in &hole_ranks {
        if !distinct.contains(&r) {
            distinct.push(r);
        }
    }
    if distinct.contains(&12) {
        distinct.push(-1);
    }
    // f3: max share of distinct hole ranks inside any 5-rank window.
    let mut best_window = 0usize;
    for lo in -1..=8 {
        let hi = lo + 4;
        let cnt = distinct.iter().filter(|&&r| r >= lo && r <= hi).count();
        best_window = best_window.max(cnt);
    }
    let num_distinct_hole = hole_ranks
        .iter()
        .collect::<std::collections::HashSet<_>>()
        .len()
        .max(1);
    let f3 = best_window as f64 / num_distinct_hole as f64;
    // f4: straight-draw potential — distinct ranks of hole ∪ board inside the
    // best 5-rank window (4+ = a real draw or made straight texture).
    let mut all_ranks: Vec<i32> = distinct.clone();
    for &r in &board_ranks {
        if !all_ranks.contains(&r) {
            all_ranks.push(r);
        }
    }
    if all_ranks.contains(&12) && !all_ranks.contains(&-1) {
        all_ranks.push(-1);
    }
    let mut best_all = 0usize;
    for lo in -1..=8 {
        let hi = lo + 4;
        let cnt = all_ranks.iter().filter(|&&r| r >= lo && r <= hi).count();
        best_all = best_all.max(cnt);
    }
    let f4 = best_all as f64 / 5.0;

    // ---- Family 3: flush draws ------------------------------------------
    // hole_s[s], board_s[s]: card counts per suit.
    let mut hole_s = [0u32; 4];
    let mut board_s = [0u32; 4];
    for &c in &hole {
        hole_s[c.suit().index() as usize] += 1;
    }
    for &c in board.iter() {
        board_s[c.suit().index() as usize] += 1;
    }
    let mut f5 = 0.0f64;
    let mut f6 = 0.0f64;
    for s in 0..4 {
        let suit = Suit::from_u8(s as u8).unwrap();
        if hole_s[s] >= 2 && board_s[s] >= 1 {
            // Real flush draw (or made flush with 3 board cards of the suit).
            let mut v = 0.55 + 0.15 * (board_s[s] - 1) as f64 + 0.15 * (hole_s[s] - 2) as f64;
            if board_s[s] >= 3 {
                v = 1.0; // flush already made possible texture-wise
            }
            f5 = f5.max(v);
        } else if hole_s[s] >= 2 && board_s[s] == 0 {
            f5 = f5.max(0.2); // two suited hole cards, suit absent: weak backdoor
        } else if hole_s[s] == 1 && board_s[s] >= 2 {
            f5 = f5.max(0.3); // one-card backdoor flush draw
        }
        // Nut-flush blocker: holding the Ace (or King when Ace is on board) of a
        // suit that appears on the board, without holding a made flush draw of it.
        if board_s[s] >= 1 {
            let has_ace = hole
                .iter()
                .any(|&c| c.suit() == suit && c.rank() == Rank::Ace);
            let has_king = hole
                .iter()
                .any(|&c| c.suit() == suit && c.rank() == Rank::King);
            let ace_on_board = board
                .iter()
                .any(|&c| c.suit() == suit && c.rank() == Rank::Ace);
            if has_ace {
                f6 = f6.max(1.0);
            } else if has_king && ace_on_board {
                f6 = f6.max(0.6);
            } else if has_king {
                f6 = f6.max(0.35);
            }
        }
    }

    // ---- Family 4: suitedness pattern ------------------------------------
    let mut suit_counts: Vec<u32> = hole_s.iter().copied().filter(|&n| n > 0).collect();
    suit_counts.sort_unstable_by(|a, b| b.cmp(a));
    let f7 = match suit_counts.as_slice() {
        [2, 2] => 1.0,       // double suited
        [3, 1] => 0.45,      // three of one suit
        [4] => 0.3,          // single suit (four flush cards in hand)
        [2, 1, 1] => 0.65,   // single suited
        [1, 1, 1, 1] => 0.0, // rainbow
        _ => 0.0,
    };

    // ---- Family 5: high/low distribution ---------------------------------
    let f8 = (hole_ranks[0] + hole_ranks[1]) as f64 / 24.0;
    let f9 = hole_ranks.iter().filter(|&&r| r <= 6).count() as f64 / 4.0; // Eight or lower
    let highest_board = *board_ranks.iter().max().unwrap() as f64;
    let f10 = hole_ranks.iter().filter(|&&r| (r as f64) > highest_board).count() as f64 / 4.0;
    // f11: share of hole cards whose rank appears on the board (pair-with-board /
    // set potential / blocker duplication).
    let f11 = hole_ranks
        .iter()
        .filter(|&&r| board_ranks.contains(&r))
        .count() as f64
        / 4.0;

    ComboFeatures {
        values: [f0, f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11],
    }
}

/// A bucket assignment for one player's range on one flop.
#[derive(Clone, Debug, PartialEq)]
pub struct BucketAssignment {
    /// The flop this assignment was built for.
    pub board: [Card; 3],
    /// The requested number of buckets (`K`); equals the combo count in exact mode.
    pub k_requested: usize,
    /// `true` when no abstraction was applied (one bucket per combo).
    pub exact: bool,
    /// Bucket index of each combo (`0..num_buckets`), aligned with the range order.
    pub bucket_of: Vec<u16>,
    /// Combo indices per bucket, in combo order within each bucket.
    pub buckets: Vec<Vec<usize>>,
    /// Feature vector of each combo (kept so solve output can show *why* combos
    /// were grouped).
    pub features: Vec<ComboFeatures>,
}

impl BucketAssignment {
    /// Number of buckets actually used.
    #[inline]
    pub fn num_buckets(&self) -> usize {
        self.buckets.len()
    }

    /// Total range weight in bucket `b`.
    pub fn bucket_weight(&self, combos: &[WeightedCombo], b: usize) -> f64 {
        self.buckets[b].iter().map(|&i| combos[i].weight).sum()
    }

    /// Builds the exact assignment: every combo is its own bucket.
    pub fn exact(board: [Card; 3], combos: &[WeightedCombo]) -> Self {
        let features: Vec<ComboFeatures> =
            combos.iter().map(|c| combo_features(&board, c)).collect();
        let n = combos.len();
        Self {
            board,
            k_requested: n,
            exact: true,
            bucket_of: (0..n).map(|i| i as u16).collect(),
            buckets: (0..n).map(|i| vec![i]).collect(),
            features,
        }
    }

    /// Serialises the bucket definitions (board, K, per-combo bucket, per-bucket
    /// members and centroid) as JSON for solve output / the Explore UI.
    pub fn to_json(&self, combos: &[WeightedCombo]) -> String {
        let mut out = String::new();
        let board_str = plo_cards::format_cards(&self.board);
        let _ = write!(
            out,
            "{{\"board\":\"{}\",\"k_requested\":{},\"exact\":{},\"num_buckets\":{},\"buckets\":[",
            board_str,
            self.k_requested,
            self.exact,
            self.num_buckets()
        );
        for (b, members) in self.buckets.iter().enumerate() {
            if b > 0 {
                out.push(',');
            }
            // Centroid (plain mean of member feature vectors) for display.
            let mut centroid = [0.0f64; FEATURE_DIMS];
            for &i in members {
                for d in 0..FEATURE_DIMS {
                    centroid[d] += self.features[i].values[d];
                }
            }
            if !members.is_empty() {
                let inv = 1.0 / members.len() as f64;
                for c in centroid.iter_mut() {
                    *c *= inv;
                }
            }
            let _ = write!(
                out,
                "{{\"bucket\":{},\"weight\":{:.6},\"members\":[",
                b,
                self.bucket_weight(combos, b)
            );
            for (k, &i) in members.iter().enumerate() {
                if k > 0 {
                    out.push(',');
                }
                let _ = write!(
                    out,
                    "{{\"combo\":\"{}\",\"weight\":{:.6}}}",
                    plo_cards::format_cards(&combos[i].cards),
                    combos[i].weight
                );
            }
            out.push_str("],\"centroid\":[");
            for (d, c) in centroid.iter().enumerate() {
                if d > 0 {
                    out.push(',');
                }
                let _ = write!(out, "{c:.4}");
            }
            out.push_str("]}");
        }
        out.push_str("]}");
        out
    }
}

/// Clusters `combos` on `board` into at most `k_requested` buckets using the
/// deterministic weighted k-means documented at the top of this module.
/// If `k_requested >= combos.len()`, returns the exact assignment.
pub fn assign_buckets(board: [Card; 3], combos: &[WeightedCombo], k_requested: usize) -> BucketAssignment {
    let n = combos.len();
    if k_requested >= n {
        return BucketAssignment::exact(board, combos);
    }
    let k = k_requested.max(1);
    let features: Vec<ComboFeatures> = combos.iter().map(|c| combo_features(&board, c)).collect();
    let weights: Vec<f64> = combos.iter().map(|c| c.weight).collect();

    // --- Deterministic k-means++ seeding --------------------------------
    let mut rng = DeterministicRng::from_seed(BUCKET_SEED);
    let mut centroids: Vec<[f64; FEATURE_DIMS]> = Vec::with_capacity(k);
    // First centroid: the combo whose index is drawn deterministically.
    let first = (rng.next_u64() % (n as u64)) as usize;
    centroids.push(features[first].values);
    // Subsequent centroids: sample proportional to weighted distance^2.
    let mut dist_sq: Vec<f64> = features
        .iter()
        .map(|f| f.weighted_dist_sq(&ComboFeatures { values: centroids[0] }))
        .collect();
    while centroids.len() < k {
        let total: f64 = dist_sq.iter().zip(weights.iter()).map(|(d, w)| d * w).sum();
        let next_idx = if total <= 0.0 {
            // All remaining points coincide with existing centroids: take the
            // first point not already a centroid (deterministic).
            (0..n)
                .find(|&i| !centroids.contains(&features[i].values))
                .unwrap_or(0)
        } else {
            let target = (rng.next_u64() as f64 / u64::MAX as f64) * total;
            let mut acc = 0.0f64;
            let mut chosen = n - 1;
            for i in 0..n {
                acc += dist_sq[i] * weights[i];
                if acc >= target {
                    chosen = i;
                    break;
                }
            }
            chosen
        };
        centroids.push(features[next_idx].values);
        for i in 0..n {
            let d = features[i].weighted_dist_sq(&ComboFeatures {
                values: centroids[centroids.len() - 1],
            });
            if d < dist_sq[i] {
                dist_sq[i] = d;
            }
        }
    }

    // --- Lloyd iterations -------------------------------------------------
    let mut assignment: Vec<usize> = vec![usize::MAX; n];
    for _ in 0..KMEANS_ITERATIONS {
        // Assign each combo to its nearest centroid (ties -> lowest index).
        let mut changed = false;
        for i in 0..n {
            let mut best = 0usize;
            let mut best_d = f64::INFINITY;
            for (c, cent) in centroids.iter().enumerate() {
                let d = features[i].weighted_dist_sq(&ComboFeatures { values: *cent });
                if d < best_d {
                    best_d = d;
                    best = c;
                }
            }
            if assignment[i] != best {
                assignment[i] = best;
                changed = true;
            }
        }
        // Recompute centroids as range-weight-weighted means.
        let mut sums = vec![[0.0f64; FEATURE_DIMS]; k];
        let mut wsums = vec![0.0f64; k];
        for i in 0..n {
            let b = assignment[i];
            wsums[b] += weights[i];
            for d in 0..FEATURE_DIMS {
                sums[b][d] += weights[i] * features[i].values[d];
            }
        }
        for c in 0..k {
            if wsums[c] > 0.0 {
                for d in 0..FEATURE_DIMS {
                    centroids[c][d] = sums[c][d] / wsums[c];
                }
            } else {
                // Empty cluster: re-seed to the point with the largest weighted
                // distance to its own centroid (ties -> lowest combo index).
                let mut far_i = 0usize;
                let mut far_v = -1.0f64;
                for i in 0..n {
                    let d = features[i].weighted_dist_sq(&ComboFeatures {
                        values: centroids[assignment[i]],
                    }) * weights[i];
                    if d > far_v {
                        far_v = d;
                        far_i = i;
                    }
                }
                centroids[c] = features[far_i].values;
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }

    // Compact: drop any still-empty buckets and renumber deterministically.
    let mut remap = vec![usize::MAX; k];
    let mut buckets: Vec<Vec<usize>> = Vec::new();
    for i in 0..n {
        let old = assignment[i];
        if remap[old] == usize::MAX {
            remap[old] = buckets.len();
            buckets.push(Vec::new());
        }
        let nb = remap[old];
        buckets[nb].push(i);
    }
    let bucket_of: Vec<u16> = assignment.iter().map(|&b| remap[b] as u16).collect();

    BucketAssignment {
        board,
        k_requested,
        exact: false,
        bucket_of,
        buckets,
        features,
    }
}

/// Convenience: builds assignments for both players of a flop spot.
pub fn assign_buckets_both(
    board: [Card; 3],
    oop_combos: &[WeightedCombo],
    ip_combos: &[WeightedCombo],
    k_requested: usize,
    exact: bool,
) -> [BucketAssignment; 2] {
    if exact {
        [
            BucketAssignment::exact(board, oop_combos),
            BucketAssignment::exact(board, ip_combos),
        ]
    } else {
        [
            assign_buckets(board, oop_combos, k_requested),
            assign_buckets(board, ip_combos, k_requested),
        ]
    }
}

/// Mask of the 3-card board (helper for callers that already hold cards).
pub fn board_mask(board: &[Card; 3]) -> HandMask {
    HandMask::from_cards(board)
}
