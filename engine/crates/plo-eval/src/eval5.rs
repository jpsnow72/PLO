//! Fast branchless 5-card poker hand evaluator backed by build-time generated lookup tables.
//!
//! Score encoding (`HandRank(u32)`, higher = stronger):
//! - Bits `20..24`: [`HandCategory`] (`0 = HighCard` .. `8 = StraightFlush`)
//! - Bits `0..20`:  Five 4-bit rank nibbles (`r0 << 16 | r1 << 12 | r2 << 8 | r3 << 4 | r4`)
//!                  ordered by `(multiplicity desc, rank desc)`, with `A-2-3-4-5` wheel straights
//!                  scored as `5`-high (`r0 = 3`).

use std::fmt;

use plo_cards::{Card, HandMask};

#[allow(dead_code)]
mod tables {
    include!(concat!(env!("OUT_DIR"), "/eval_tables.rs"));
}

pub use tables::{EVAL_TABLE, FLUSH_BASE, RANK_WEIGHTS, SUIT_KEY};

/// Standard 5-card poker hand categories in ascending strength order.
#[repr(u8)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum HandCategory {
    HighCard = 0,
    OnePair = 1,
    TwoPair = 2,
    ThreeOfAKind = 3,
    Straight = 4,
    Flush = 5,
    FullHouse = 6,
    FourOfAKind = 7,
    StraightFlush = 8,
}

impl HandCategory {
    /// Converts a category index `0..=8` to a [`HandCategory`].
    #[inline]
    pub const fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(HandCategory::HighCard),
            1 => Some(HandCategory::OnePair),
            2 => Some(HandCategory::TwoPair),
            3 => Some(HandCategory::ThreeOfAKind),
            4 => Some(HandCategory::Straight),
            5 => Some(HandCategory::Flush),
            6 => Some(HandCategory::FullHouse),
            7 => Some(HandCategory::FourOfAKind),
            8 => Some(HandCategory::StraightFlush),
            _ => None,
        }
    }

    /// Human-readable category name.
    #[inline]
    pub const fn name(self) -> &'static str {
        match self {
            HandCategory::HighCard => "High Card",
            HandCategory::OnePair => "One Pair",
            HandCategory::TwoPair => "Two Pair",
            HandCategory::ThreeOfAKind => "Three of a Kind",
            HandCategory::Straight => "Straight",
            HandCategory::Flush => "Flush",
            HandCategory::FullHouse => "Full House",
            HandCategory::FourOfAKind => "Four of a Kind",
            HandCategory::StraightFlush => "Straight Flush",
        }
    }
}

impl fmt::Display for HandCategory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.name())
    }
}

/// Strength score of a 5-card poker hand (`higher = stronger`).
///
/// Two hands have equal [`HandRank`] if and only if they tie (split the pot).
#[repr(transparent)]
#[derive(Copy, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct HandRank(pub u32);

impl HandRank {
    /// Creates a [`HandRank`] from its raw `u32` score.
    #[inline]
    pub const fn from_raw(raw: u32) -> Self {
        Self(raw)
    }

    /// Returns the raw `u32` score.
    #[inline]
    pub const fn raw(self) -> u32 {
        self.0
    }

    /// Returns the [`HandCategory`] (`HighCard` .. `StraightFlush`) of this hand rank.
    #[inline]
    pub const fn category(self) -> HandCategory {
        match HandCategory::from_u8((self.0 >> 20) as u8) {
            Some(cat) => cat,
            None => HandCategory::HighCard,
        }
    }

    /// Returns the 20-bit within-category tiebreaker payload (`self.0 & 0xFFFFF`).
    #[inline]
    pub const fn tiebreaker(self) -> u32 {
        self.0 & 0xFFFFF
    }
}

impl fmt::Debug for HandRank {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "HandRank({:?}, tie=0x{:05x}, raw=0x{:06x})",
            self.category(),
            self.tiebreaker(),
            self.0
        )
    }
}

impl fmt::Display for HandRank {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} (0x{:05x})", self.category(), self.tiebreaker())
    }
}

/// Evaluates a 5-card hand encoded as a [`HandMask`] (`mask.count() == 5`).
///
/// Performs 4 suit-mask extractions and 1 lookup into `EVAL_TABLE` with zero branches.
#[inline(always)]
pub fn eval_5cards_mask(mask: HandMask) -> HandRank {
    debug_assert_eq!(
        mask.count(),
        5,
        "eval_5cards_mask requires a 5-card HandMask"
    );
    let b = mask.0;
    let c = (b & 0x1FFF) as usize;
    let d = ((b >> 13) & 0x1FFF) as usize;
    let h = ((b >> 26) & 0x1FFF) as usize;
    let s = ((b >> 39) & 0x1FFF) as usize;
    // Safety: For any 5-bit mask in 0..52, either one suit has 5 bits and the other three are 0
    // (producing FLUSH_BASE + m < EVAL_TABLE.len()), or all four suits have <= 4 bits with total
    // 5 bits (producing a valid 5-card multiset weight sum <= max_5_sum < FLUSH_BASE).
    let key = unsafe {
        (*SUIT_KEY.get_unchecked(c))
            + (*SUIT_KEY.get_unchecked(d))
            + (*SUIT_KEY.get_unchecked(h))
            + (*SUIT_KEY.get_unchecked(s))
    };
    let score = unsafe { *EVAL_TABLE.get_unchecked(key as usize) };
    HandRank(score)
}

/// Evaluates an array of 5 distinct [`Card`]s.
#[inline(always)]
pub fn eval_5cards(cards: [Card; 5]) -> HandRank {
    let mask = HandMask(
        cards[0].bit() | cards[1].bit() | cards[2].bit() | cards[3].bit() | cards[4].bit(),
    );
    eval_5cards_mask(mask)
}
