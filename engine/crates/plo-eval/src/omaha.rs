//! Omaha best-hand evaluation: for a player with 4 hole cards and a 5-card board,
//! evaluates all $\binom{4}{2} \times \binom{5}{3} = 60$ valid 5-card combinations
//! (strictly 2 hole cards + strictly 3 board cards) and takes the maximum [`HandRank`].

use std::cmp::Ordering;

use plo_cards::{Card, HandMask};

use crate::eval5::{eval_5cards_mask, HandRank};

/// Outcome of a heads-up showdown.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum ShowdownOutcome {
    HeroWin,
    VillainWin,
    Tie,
}

/// Extracts all $\binom{4}{2} = 6$ two-card bitmasks from a 4-card `hole` [`HandMask`].
#[inline(always)]
pub fn extract_hole_pairs(hole: HandMask) -> [u64; 6] {
    debug_assert_eq!(hole.count(), 4, "PLO hole mask must contain 4 cards");
    let mut h = hole.0;
    let h0 = h & h.wrapping_neg();
    h ^= h0;
    let h1 = h & h.wrapping_neg();
    h ^= h1;
    let h2 = h & h.wrapping_neg();
    let h3 = h ^ h2;

    [h0 | h1, h0 | h2, h0 | h3, h1 | h2, h1 | h3, h2 | h3]
}

/// Extracts all $\binom{5}{3} = 10$ three-card bitmasks from a 5-card `board` [`HandMask`].
#[inline(always)]
pub fn extract_board_triples(board: HandMask) -> [u64; 10] {
    debug_assert_eq!(board.count(), 5, "Board mask must contain 5 cards");
    let mut b = board.0;
    let b0 = b & b.wrapping_neg();
    b ^= b0;
    let b1 = b & b.wrapping_neg();
    b ^= b1;
    let b2 = b & b.wrapping_neg();
    b ^= b2;
    let b3 = b & b.wrapping_neg();
    let b4 = b ^ b3;

    let b01 = b0 | b1;
    let b02 = b0 | b2;
    let b12 = b1 | b2;
    let b34 = b3 | b4;

    [
        b01 | b2,
        b01 | b3,
        b01 | b4,
        b02 | b3,
        b02 | b4,
        b0 | b34,
        b12 | b3,
        b12 | b4,
        b1 | b34,
        b2 | b34,
    ]
}

/// Evaluates an Omaha hand given pre-extracted 6 hole pairs and 10 board triples (60 five-card hands).
#[inline(always)]
pub fn eval_omaha_pairs_triples(hole_pairs: &[u64; 6], board_triples: &[u64; 10]) -> HandRank {
    let mut best = 0u32;
    for &hp in hole_pairs {
        for &bt in board_triples {
            let r = eval_5cards_mask(HandMask(hp | bt)).0;
            if r > best {
                best = r;
            }
        }
    }
    HandRank(best)
}

/// Evaluates the best Omaha hand from a 4-card `hole` [`HandMask`] and a 5-card `board` [`HandMask`],
/// testing all $\binom{4}{2} \times \binom{5}{3} = 60$ five-card combinations (2 hole + 3 board).
#[inline]
pub fn eval_omaha_mask(hole: HandMask, board: HandMask) -> HandRank {
    debug_assert_eq!(hole.count(), 4, "Hole mask must have 4 cards");
    debug_assert_eq!(board.count(), 5, "Board mask must have 5 cards");
    debug_assert!(!hole.overlaps(board), "Hole and board masks must be disjoint");

    let hp = extract_hole_pairs(hole);
    let bt = extract_board_triples(board);
    eval_omaha_pairs_triples(&hp, &bt)
}

/// Evaluates the best Omaha hand from 4 hole [`Card`]s and 5 board [`Card`]s,
/// testing all $\binom{4}{2} \times \binom{5}{3} = 60$ five-card combinations (2 hole + 3 board).
#[inline]
pub fn eval_omaha(hole: [Card; 4], board: [Card; 5]) -> HandRank {
    let h0 = hole[0].bit();
    let h1 = hole[1].bit();
    let h2 = hole[2].bit();
    let h3 = hole[3].bit();
    let hp = [h0 | h1, h0 | h2, h0 | h3, h1 | h2, h1 | h3, h2 | h3];

    let b0 = board[0].bit();
    let b1 = board[1].bit();
    let b2 = board[2].bit();
    let b3 = board[3].bit();
    let b4 = board[4].bit();

    let b01 = b0 | b1;
    let b02 = b0 | b2;
    let b12 = b1 | b2;
    let b34 = b3 | b4;

    let bt = [
        b01 | b2,
        b01 | b3,
        b01 | b4,
        b02 | b3,
        b02 | b4,
        b0 | b34,
        b12 | b3,
        b12 | b4,
        b1 | b34,
        b2 | b34,
    ];

    eval_omaha_pairs_triples(&hp, &bt)
}

/// Compares Hero's 4 hole cards against Villain's 4 hole cards on a 5-card board.
#[inline]
pub fn compare_omaha(
    hero: [Card; 4],
    villain: [Card; 4],
    board: [Card; 5],
) -> (ShowdownOutcome, HandRank, HandRank) {
    let board_mask = HandMask::from_cards(&board);
    let bt = extract_board_triples(board_mask);

    let h0 = hero[0].bit();
    let h1 = hero[1].bit();
    let h2 = hero[2].bit();
    let h3 = hero[3].bit();
    let hero_hp = [h0 | h1, h0 | h2, h0 | h3, h1 | h2, h1 | h3, h2 | h3];

    let v0 = villain[0].bit();
    let v1 = villain[1].bit();
    let v2 = villain[2].bit();
    let v3 = villain[3].bit();
    let villain_hp = [v0 | v1, v0 | v2, v0 | v3, v1 | v2, v1 | v3, v2 | v3];

    let hero_rank = eval_omaha_pairs_triples(&hero_hp, &bt);
    let villain_rank = eval_omaha_pairs_triples(&villain_hp, &bt);

    let outcome = match hero_rank.cmp(&villain_rank) {
        Ordering::Greater => ShowdownOutcome::HeroWin,
        Ordering::Less => ShowdownOutcome::VillainWin,
        Ordering::Equal => ShowdownOutcome::Tie,
    };
    (outcome, hero_rank, villain_rank)
}
