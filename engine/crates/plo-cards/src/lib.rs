//! Core card, deck, bitmask (`u64` hand mask), parsing/formatting, and suit-isomorphism
//! canonicalisation types for Pot Limit Omaha (`plo-engine`).
//!
//! Card encoding:
//! - `Rank` is `0..13` (`Two = 0`, ..., `Ace = 12`).
//! - `Suit` is `0..4` (`Clubs = 0`, `Diamonds = 1`, `Hearts = 2`, `Spades = 3`).
//! - `Card` is `0..52` where `id = (suit as u8) * 13 + (rank as u8)`.
//! - `HandMask(u64)` sets bit `card.id()` in `0..52`. Consequently, each suit occupies
//!   a contiguous 13-bit lane:
//!   - Clubs:    bits `0..13`
//!   - Diamonds: bits `13..26`
//!   - Hearts:   bits `26..39`
//!   - Spades:   bits `39..52`

use std::fmt;
use std::ops::{BitAnd, BitAndAssign, BitOr, BitOrAssign, BitXor, BitXorAssign, Sub};
use std::str::FromStr;

/// Card rank from `Two` (0) through `Ace` (12).
#[repr(u8)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Rank {
    Two = 0,
    Three = 1,
    Four = 2,
    Five = 3,
    Six = 4,
    Seven = 5,
    Eight = 6,
    Nine = 7,
    Ten = 8,
    Jack = 9,
    Queen = 10,
    King = 11,
    Ace = 12,
}

impl Rank {
    /// All 13 ranks in ascending order (`Two` to `Ace`).
    pub const ALL: [Rank; 13] = [
        Rank::Two,
        Rank::Three,
        Rank::Four,
        Rank::Five,
        Rank::Six,
        Rank::Seven,
        Rank::Eight,
        Rank::Nine,
        Rank::Ten,
        Rank::Jack,
        Rank::Queen,
        Rank::King,
        Rank::Ace,
    ];

    /// Converts an index `0..13` to a [`Rank`].
    #[inline]
    pub const fn from_u8(val: u8) -> Option<Self> {
        if val < 13 {
            Some(Self::ALL[val as usize])
        } else {
            None
        }
    }

    /// Returns the `0..13` numeric index of this rank.
    #[inline]
    pub const fn index(self) -> u8 {
        self as u8
    }

    /// Returns the 13-bit mask (`1 << rank`) for this rank.
    #[inline]
    pub const fn bit(self) -> u16 {
        1u16 << (self as u8)
    }

    /// Parses a single ASCII character (`'2'..='9'`, `'T'`, `'J'`, `'Q'`, `'K'`, `'A'`, case-insensitive).
    #[inline]
    pub const fn from_char(c: char) -> Option<Self> {
        match c {
            '2' => Some(Rank::Two),
            '3' => Some(Rank::Three),
            '4' => Some(Rank::Four),
            '5' => Some(Rank::Five),
            '6' => Some(Rank::Six),
            '7' => Some(Rank::Seven),
            '8' => Some(Rank::Eight),
            '9' => Some(Rank::Nine),
            'T' | 't' => Some(Rank::Ten),
            'J' | 'j' => Some(Rank::Jack),
            'Q' | 'q' => Some(Rank::Queen),
            'K' | 'k' => Some(Rank::King),
            'A' | 'a' => Some(Rank::Ace),
            _ => None,
        }
    }

    /// Formats the rank as its canonical uppercase character (`'2'..='9'`, `'T'`, `'J'`, `'Q'`, `'K'`, `'A'`).
    #[inline]
    pub const fn to_char(self) -> char {
        const CHARS: [char; 13] = [
            '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A',
        ];
        CHARS[self as usize]
    }
}

impl fmt::Display for Rank {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.to_char())
    }
}

/// Card suit (`Clubs = 0`, `Diamonds = 1`, `Hearts = 2`, `Spades = 3`).
#[repr(u8)]
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Suit {
    Clubs = 0,
    Diamonds = 1,
    Hearts = 2,
    Spades = 3,
}

impl Suit {
    /// All 4 suits in ascending order (`Clubs`, `Diamonds`, `Hearts`, `Spades`).
    pub const ALL: [Suit; 4] = [Suit::Clubs, Suit::Diamonds, Suit::Hearts, Suit::Spades];

    /// Converts an index `0..4` to a [`Suit`].
    #[inline]
    pub const fn from_u8(val: u8) -> Option<Self> {
        if val < 4 {
            Some(Self::ALL[val as usize])
        } else {
            None
        }
    }

    /// Returns the `0..4` numeric index of this suit.
    #[inline]
    pub const fn index(self) -> u8 {
        self as u8
    }

    /// Parses a single suit character (`'c'`, `'d'`, `'h'`, `'s'`, case-insensitive).
    #[inline]
    pub const fn from_char(c: char) -> Option<Self> {
        match c {
            'c' | 'C' => Some(Suit::Clubs),
            'd' | 'D' => Some(Suit::Diamonds),
            'h' | 'H' => Some(Suit::Hearts),
            's' | 'S' => Some(Suit::Spades),
            _ => None,
        }
    }

    /// Formats the suit as its canonical lowercase character (`'c'`, `'d'`, `'h'`, `'s'`).
    #[inline]
    pub const fn to_char(self) -> char {
        const CHARS: [char; 4] = ['c', 'd', 'h', 's'];
        CHARS[self as usize]
    }
}

impl fmt::Display for Suit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.to_char())
    }
}

/// Lookup table mapping `card_id` (`0..52`) to `Rank`.
const CARD_RANKS: [Rank; 52] = {
    let mut table = [Rank::Two; 52];
    let mut i = 0;
    while i < 52 {
        table[i] = Rank::ALL[i % 13];
        i += 1;
    }
    table
};

/// Lookup table mapping `card_id` (`0..52`) to `Suit`.
const CARD_SUITS: [Suit; 52] = {
    let mut table = [Suit::Clubs; 52];
    let mut i = 0;
    while i < 52 {
        table[i] = Suit::ALL[i / 13];
        i += 1;
    }
    table
};

/// A single playing card encoded in `0..52` as `suit * 13 + rank`.
#[repr(transparent)]
#[derive(Copy, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Card(u8);

impl Card {
    /// Total number of cards in a standard deck.
    pub const COUNT: usize = 52;

    /// All 52 cards ordered by `id` (`0..52`).
    pub const ALL: [Card; 52] = {
        let mut arr = [Card(0); 52];
        let mut i = 0;
        while i < 52 {
            arr[i] = Card(i as u8);
            i += 1;
        }
        arr
    };

    /// Creates a new [`Card`] from a [`Rank`] and [`Suit`].
    #[inline]
    pub const fn new(rank: Rank, suit: Suit) -> Self {
        Self((suit as u8) * 13 + (rank as u8))
    }

    /// Creates a [`Card`] from a raw `0..52` identifier.
    #[inline]
    pub const fn from_id(id: u8) -> Option<Self> {
        if id < 52 {
            Some(Self(id))
        } else {
            None
        }
    }

    /// Returns the `0..52` identifier of this card.
    #[inline]
    pub const fn id(self) -> u8 {
        self.0
    }

    /// Returns the [`Rank`] of this card.
    #[inline]
    pub const fn rank(self) -> Rank {
        CARD_RANKS[self.0 as usize]
    }

    /// Returns the [`Suit`] of this card.
    #[inline]
    pub const fn suit(self) -> Suit {
        CARD_SUITS[self.0 as usize]
    }

    /// Returns the single-bit `u64` mask (`1u64 << self.id()`) for this card.
    #[inline]
    pub const fn bit(self) -> u64 {
        1u64 << self.0
    }

    /// Returns this card wrapped as a 1-card [`HandMask`].
    #[inline]
    pub const fn mask(self) -> HandMask {
        HandMask(1u64 << self.0)
    }

    /// Parses a sequence of cards from a string such as `"As Kd Qh Jc"` or `"AsKdQhJc"`.
    /// Rejects duplicate cards and invalid rank/suit characters.
    pub fn parse_many(input: &str) -> Result<Vec<Card>, CardParseError> {
        let trimmed = input.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }

        let mut cards = Vec::new();
        let mut seen = HandMask::EMPTY;
        let bytes = trimmed.as_bytes();
        let mut i = 0;

        while i < bytes.len() {
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            if i >= bytes.len() {
                break;
            }
            if i + 1 >= bytes.len() {
                return Err(CardParseError::UnexpectedLength(trimmed.to_string()));
            }
            let r_char = bytes[i] as char;
            let s_char = bytes[i + 1] as char;
            let rank = Rank::from_char(r_char).ok_or(CardParseError::InvalidRank(r_char))?;
            let suit = Suit::from_char(s_char).ok_or(CardParseError::InvalidSuit(s_char))?;
            let card = Card::new(rank, suit);
            if seen.contains(card) {
                return Err(CardParseError::DuplicateCard(card));
            }
            seen.insert(card);
            cards.push(card);
            i += 2;
        }

        Ok(cards)
    }

    /// Parses an exact number `N` of distinct cards from a string (e.g. `Card::parse_n::<4>("As Kd Qh Jc")`).
    pub fn parse_n<const N: usize>(input: &str) -> Result<[Card; N], CardParseError> {
        let vec = Self::parse_many(input)?;
        if vec.len() != N {
            return Err(CardParseError::WrongCardCount {
                expected: N,
                actual: vec.len(),
            });
        }
        let mut arr = [Card(0); N];
        arr.copy_from_slice(&vec);
        Ok(arr)
    }
}

impl fmt::Debug for Card {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}{}", self.rank().to_char(), self.suit().to_char())
    }
}

impl fmt::Display for Card {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}{}", self.rank().to_char(), self.suit().to_char())
    }
}

impl FromStr for Card {
    type Err = CardParseError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let trimmed = s.trim();
        let mut chars = trimmed.chars();
        let r_char = chars
            .next()
            .ok_or_else(|| CardParseError::UnexpectedLength(trimmed.to_string()))?;
        let s_char = chars
            .next()
            .ok_or_else(|| CardParseError::UnexpectedLength(trimmed.to_string()))?;
        if chars.next().is_some() {
            return Err(CardParseError::UnexpectedLength(trimmed.to_string()));
        }
        let rank = Rank::from_char(r_char).ok_or(CardParseError::InvalidRank(r_char))?;
        let suit = Suit::from_char(s_char).ok_or(CardParseError::InvalidSuit(s_char))?;
        Ok(Card::new(rank, suit))
    }
}

/// Errors that can occur when parsing card or hand strings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CardParseError {
    InvalidRank(char),
    InvalidSuit(char),
    UnexpectedLength(String),
    DuplicateCard(Card),
    WrongCardCount { expected: usize, actual: usize },
}

impl fmt::Display for CardParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CardParseError::InvalidRank(c) => write!(f, "invalid rank character: '{c}'"),
            CardParseError::InvalidSuit(c) => write!(f, "invalid suit character: '{c}'"),
            CardParseError::UnexpectedLength(s) => write!(f, "unexpected card string length: \"{s}\""),
            CardParseError::DuplicateCard(c) => write!(f, "duplicate card in hand: {c}"),
            CardParseError::WrongCardCount { expected, actual } => {
                write!(f, "expected {expected} cards, got {actual}")
            }
        }
    }
}

impl std::error::Error for CardParseError {}

/// Formats a slice of cards as space-separated tokens (e.g. `"As Kd Qh Jc"`).
pub fn format_cards(cards: &[Card]) -> String {
    let mut out = String::with_capacity(cards.len().saturating_mul(3));
    for (idx, card) in cards.iter().enumerate() {
        if idx > 0 {
            out.push(' ');
        }
        out.push(card.rank().to_char());
        out.push(card.suit().to_char());
    }
    out
}

/// Bitmask representation of a set of cards in a `u64` (bits `0..52`).
///
/// Each suit occupies 13 contiguous bits:
/// - Clubs:    `bits 0..13`
/// - Diamonds: `bits 13..26`
/// - Hearts:   `bits 26..39`
/// - Spades:   `bits 39..52`
#[repr(transparent)]
#[derive(Copy, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct HandMask(pub u64);

impl HandMask {
    /// Empty hand mask (0 cards).
    pub const EMPTY: Self = Self(0);

    /// Full 52-card deck mask (`(1 << 52) - 1`).
    pub const FULL_DECK: Self = Self((1u64 << 52) - 1);

    /// Creates a [`HandMask`] from raw `u64` bits (masked to the lower 52 bits).
    #[inline]
    pub const fn from_bits(bits: u64) -> Self {
        Self(bits & Self::FULL_DECK.0)
    }

    /// Creates a [`HandMask`] from a slice of [`Card`]s.
    #[inline]
    pub fn from_cards(cards: &[Card]) -> Self {
        let mut mask = 0u64;
        for &c in cards {
            mask |= c.bit();
        }
        Self(mask)
    }

    /// Returns the raw `u64` bitmask.
    #[inline]
    pub const fn bits(self) -> u64 {
        self.0
    }

    /// Returns the number of cards (set bits) in the mask.
    #[inline]
    pub const fn count(self) -> u32 {
        self.0.count_ones()
    }

    /// Returns `true` if no cards are present in the mask.
    #[inline]
    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// Returns `true` if `card` is present in the mask.
    #[inline]
    pub const fn contains(self, card: Card) -> bool {
        (self.0 & card.bit()) != 0
    }

    /// Returns `true` if `self` and `other` share at least one card.
    #[inline]
    pub const fn overlaps(self, other: Self) -> bool {
        (self.0 & other.0) != 0
    }

    /// Inserts `card` into the mask.
    #[inline]
    pub fn insert(&mut self, card: Card) {
        self.0 |= card.bit();
    }

    /// Removes `card` from the mask.
    #[inline]
    pub fn remove(&mut self, card: Card) {
        self.0 &= !card.bit();
    }

    /// Returns a new mask with `card` added.
    #[inline]
    pub const fn with(self, card: Card) -> Self {
        Self(self.0 | card.bit())
    }

    /// Returns a new mask with `card` removed.
    #[inline]
    pub const fn without(self, card: Card) -> Self {
        Self(self.0 & !card.bit())
    }

    /// Returns the union of two masks.
    #[inline]
    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }

    /// Returns the intersection of two masks.
    #[inline]
    pub const fn intersection(self, other: Self) -> Self {
        Self(self.0 & other.0)
    }

    /// Returns cards in `self` that are not in `other`.
    #[inline]
    pub const fn difference(self, other: Self) -> Self {
        Self(self.0 & !other.0)
    }

    /// Extracts the 13-bit rank mask (`0..8192`) for the given `suit`.
    #[inline]
    pub const fn suit_ranks(self, suit: Suit) -> u16 {
        ((self.0 >> ((suit as u8) * 13)) & 0x1FFF) as u16
    }

    /// Extracts the 13-bit union of ranks across all 4 suits.
    #[inline]
    pub const fn all_ranks_mask(self) -> u16 {
        let b = self.0;
        (((b) | (b >> 13) | (b >> 26) | (b >> 39)) & 0x1FFF) as u16
    }

    /// Iterates over the cards in this mask in ascending `Card::id()` order.
    #[inline]
    pub const fn iter(self) -> HandMaskIter {
        HandMaskIter(self.0)
    }

    /// Collects the cards in this mask into a `Vec<Card>`, sorted in canonical display order
    /// (descending rank, then descending suit).
    pub fn to_canonical_vec(self) -> Vec<Card> {
        let mut cards: Vec<Card> = self.iter().collect();
        sort_cards_canonical(&mut cards);
        cards
    }
}

impl BitOr for HandMask {
    type Output = Self;
    #[inline]
    fn bitor(self, rhs: Self) -> Self::Output {
        Self(self.0 | rhs.0)
    }
}

impl BitOrAssign for HandMask {
    #[inline]
    fn bitor_assign(&mut self, rhs: Self) {
        self.0 |= rhs.0;
    }
}

impl BitAnd for HandMask {
    type Output = Self;
    #[inline]
    fn bitand(self, rhs: Self) -> Self::Output {
        Self(self.0 & rhs.0)
    }
}

impl BitAndAssign for HandMask {
    #[inline]
    fn bitand_assign(&mut self, rhs: Self) {
        self.0 &= rhs.0;
    }
}

impl BitXor for HandMask {
    type Output = Self;
    #[inline]
    fn bitxor(self, rhs: Self) -> Self::Output {
        Self(self.0 ^ rhs.0)
    }
}

impl BitXorAssign for HandMask {
    #[inline]
    fn bitxor_assign(&mut self, rhs: Self) {
        self.0 ^= rhs.0;
    }
}

impl Sub for HandMask {
    type Output = Self;
    #[inline]
    fn sub(self, rhs: Self) -> Self::Output {
        Self(self.0 & !rhs.0)
    }
}

impl FromStr for HandMask {
    type Err = CardParseError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let cards = Card::parse_many(s)?;
        Ok(Self::from_cards(&cards))
    }
}

impl fmt::Display for HandMask {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let cards = self.to_canonical_vec();
        write!(f, "{}", format_cards(&cards))
    }
}

impl fmt::Debug for HandMask {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "HandMask(\"{}\", 0x{:013x})", self, self.0)
    }
}

/// Fast bit-scanning iterator over [`Card`]s in a [`HandMask`].
#[derive(Copy, Clone, Debug)]
pub struct HandMaskIter(u64);

impl Iterator for HandMaskIter {
    type Item = Card;

    #[inline]
    fn next(&mut self) -> Option<Self::Item> {
        if self.0 == 0 {
            None
        } else {
            let tz = self.0.trailing_zeros() as u8;
            self.0 &= self.0 - 1;
            Some(Card(tz))
        }
    }

    #[inline]
    fn size_hint(&self) -> (usize, Option<usize>) {
        let c = self.0.count_ones() as usize;
        (c, Some(c))
    }
}

impl ExactSizeIterator for HandMaskIter {}

impl IntoIterator for HandMask {
    type Item = Card;
    type IntoIter = HandMaskIter;

    #[inline]
    fn into_iter(self) -> Self::IntoIter {
        self.iter()
    }
}

/// A 4-card Pot Limit Omaha starting hand.
#[derive(Copy, Clone, PartialEq, Eq, Hash)]
pub struct PloHand {
    cards: [Card; 4],
    mask: HandMask,
}

impl PloHand {
    /// Creates a [`PloHand`] from 4 cards, returning `None` if any two cards are identical.
    #[inline]
    pub fn new(cards: [Card; 4]) -> Option<Self> {
        let mask = HandMask::from_cards(&cards);
        if mask.count() != 4 {
            None
        } else {
            Some(Self { cards, mask })
        }
    }

    /// Returns the 4 hole cards.
    #[inline]
    pub const fn cards(self) -> [Card; 4] {
        self.cards
    }

    /// Returns the 4-bit [`HandMask`] of this hand.
    #[inline]
    pub const fn mask(self) -> HandMask {
        self.mask
    }

    /// Returns all $\binom{4}{2} = 6$ two-card hole combinations as [`HandMask`]s.
    #[inline]
    pub const fn hole_pair_masks(self) -> [HandMask; 6] {
        let b0 = self.cards[0].bit();
        let b1 = self.cards[1].bit();
        let b2 = self.cards[2].bit();
        let b3 = self.cards[3].bit();
        [
            HandMask(b0 | b1),
            HandMask(b0 | b2),
            HandMask(b0 | b3),
            HandMask(b1 | b2),
            HandMask(b1 | b3),
            HandMask(b2 | b3),
        ]
    }

    /// Returns a suit-canonicalised copy of this PLO hand.
    #[inline]
    pub fn canonicalize(self) -> Self {
        let canon = canonicalize_plo_hand(self.cards);
        Self {
            cards: canon,
            mask: HandMask::from_cards(&canon),
        }
    }
}

impl FromStr for PloHand {
    type Err = CardParseError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let cards = Card::parse_n::<4>(s)?;
        Ok(Self {
            cards,
            mask: HandMask::from_cards(&cards),
        })
    }
}

impl fmt::Display for PloHand {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", format_cards(&self.cards))
    }
}

impl fmt::Debug for PloHand {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "PloHand(\"{}\")", self)
    }
}

/// Sorts cards in canonical display order: descending by [`Rank`], then descending by [`Suit`]
/// (`Spades > Hearts > Diamonds > Clubs`).
#[inline]
pub fn sort_cards_canonical(cards: &mut [Card]) {
    cards.sort_unstable_by(|a, b| {
        b.rank()
            .cmp(&a.rank())
            .then_with(|| b.suit().cmp(&a.suit()))
    });
}

/// Canonicalises a 4-card PLO preflop hand under suit isomorphism.
///
/// Two 4-card hands are suit-isomorphic if and only if there exists a permutation of the 4 suits
/// mapping one hand to the other (reducing $\binom{52}{4} = 270,725$ raw hands to $16,432$
/// canonical equivalence classes).
///
/// This function evaluates all $4! = 24$ suit permutations and picks the lexicographically smallest
/// canonical representation (where each permuted hand is sorted by `(rank desc, suit asc)`).
pub fn canonicalize_plo_hand(hand: [Card; 4]) -> [Card; 4] {
    const PERMS: [[Suit; 4]; 24] = [
        [Suit::Clubs, Suit::Diamonds, Suit::Hearts, Suit::Spades],
        [Suit::Clubs, Suit::Diamonds, Suit::Spades, Suit::Hearts],
        [Suit::Clubs, Suit::Hearts, Suit::Diamonds, Suit::Spades],
        [Suit::Clubs, Suit::Hearts, Suit::Spades, Suit::Diamonds],
        [Suit::Clubs, Suit::Spades, Suit::Diamonds, Suit::Hearts],
        [Suit::Clubs, Suit::Spades, Suit::Hearts, Suit::Diamonds],
        [Suit::Diamonds, Suit::Clubs, Suit::Hearts, Suit::Spades],
        [Suit::Diamonds, Suit::Clubs, Suit::Spades, Suit::Hearts],
        [Suit::Diamonds, Suit::Hearts, Suit::Clubs, Suit::Spades],
        [Suit::Diamonds, Suit::Hearts, Suit::Spades, Suit::Clubs],
        [Suit::Diamonds, Suit::Spades, Suit::Clubs, Suit::Hearts],
        [Suit::Diamonds, Suit::Spades, Suit::Hearts, Suit::Clubs],
        [Suit::Hearts, Suit::Clubs, Suit::Diamonds, Suit::Spades],
        [Suit::Hearts, Suit::Clubs, Suit::Spades, Suit::Diamonds],
        [Suit::Hearts, Suit::Diamonds, Suit::Clubs, Suit::Spades],
        [Suit::Hearts, Suit::Diamonds, Suit::Spades, Suit::Clubs],
        [Suit::Hearts, Suit::Spades, Suit::Clubs, Suit::Diamonds],
        [Suit::Hearts, Suit::Spades, Suit::Diamonds, Suit::Clubs],
        [Suit::Spades, Suit::Clubs, Suit::Diamonds, Suit::Hearts],
        [Suit::Spades, Suit::Clubs, Suit::Hearts, Suit::Diamonds],
        [Suit::Spades, Suit::Diamonds, Suit::Clubs, Suit::Hearts],
        [Suit::Spades, Suit::Diamonds, Suit::Hearts, Suit::Clubs],
        [Suit::Spades, Suit::Hearts, Suit::Clubs, Suit::Diamonds],
        [Suit::Spades, Suit::Hearts, Suit::Diamonds, Suit::Clubs],
    ];

    let mut best: Option<([Card; 4], [u8; 8])> = None;

    for perm in &PERMS {
        let mut mapped = [
            Card::new(hand[0].rank(), perm[hand[0].suit() as usize]),
            Card::new(hand[1].rank(), perm[hand[1].suit() as usize]),
            Card::new(hand[2].rank(), perm[hand[2].suit() as usize]),
            Card::new(hand[3].rank(), perm[hand[3].suit() as usize]),
        ];
        // Sort by rank descending, then suit ascending (`Clubs` first).
        mapped.sort_unstable_by(|a, b| {
            b.rank()
                .cmp(&a.rank())
                .then_with(|| a.suit().cmp(&b.suit()))
        });
        let key = [
            12 - mapped[0].rank() as u8,
            mapped[0].suit() as u8,
            12 - mapped[1].rank() as u8,
            mapped[1].suit() as u8,
            12 - mapped[2].rank() as u8,
            mapped[2].suit() as u8,
            12 - mapped[3].rank() as u8,
            mapped[3].suit() as u8,
        ];
        match best {
            None => best = Some((mapped, key)),
            Some((_, best_key)) if key < best_key => best = Some((mapped, key)),
            _ => {}
        }
    }

    best.unwrap().0
}

/// Returns the canonical [`HandMask`] of a 4-card PLO hand under suit isomorphism.
#[inline]
pub fn canonical_plo_mask(hand: [Card; 4]) -> HandMask {
    let canon = canonicalize_plo_hand(hand);
    HandMask::from_cards(&canon)
}

/// Canonicalises a `(hand, board)` pair under suit isomorphism.
///
/// Suits are relabelled using the permutation that first minimises the canonical board
/// representation and breaks ties using the hole cards.
pub fn canonicalize_hand_with_board(hand: [Card; 4], board: &[Card]) -> ([Card; 4], Vec<Card>) {
    const PERMS: [[Suit; 4]; 24] = [
        [Suit::Clubs, Suit::Diamonds, Suit::Hearts, Suit::Spades],
        [Suit::Clubs, Suit::Diamonds, Suit::Spades, Suit::Hearts],
        [Suit::Clubs, Suit::Hearts, Suit::Diamonds, Suit::Spades],
        [Suit::Clubs, Suit::Hearts, Suit::Spades, Suit::Diamonds],
        [Suit::Clubs, Suit::Spades, Suit::Diamonds, Suit::Hearts],
        [Suit::Clubs, Suit::Spades, Suit::Hearts, Suit::Diamonds],
        [Suit::Diamonds, Suit::Clubs, Suit::Hearts, Suit::Spades],
        [Suit::Diamonds, Suit::Clubs, Suit::Spades, Suit::Hearts],
        [Suit::Diamonds, Suit::Hearts, Suit::Clubs, Suit::Spades],
        [Suit::Diamonds, Suit::Hearts, Suit::Spades, Suit::Clubs],
        [Suit::Diamonds, Suit::Spades, Suit::Clubs, Suit::Hearts],
        [Suit::Diamonds, Suit::Spades, Suit::Hearts, Suit::Clubs],
        [Suit::Hearts, Suit::Clubs, Suit::Diamonds, Suit::Spades],
        [Suit::Hearts, Suit::Clubs, Suit::Spades, Suit::Diamonds],
        [Suit::Hearts, Suit::Diamonds, Suit::Clubs, Suit::Spades],
        [Suit::Hearts, Suit::Diamonds, Suit::Spades, Suit::Clubs],
        [Suit::Hearts, Suit::Spades, Suit::Clubs, Suit::Diamonds],
        [Suit::Hearts, Suit::Spades, Suit::Diamonds, Suit::Clubs],
        [Suit::Spades, Suit::Clubs, Suit::Diamonds, Suit::Hearts],
        [Suit::Spades, Suit::Clubs, Suit::Hearts, Suit::Diamonds],
        [Suit::Spades, Suit::Diamonds, Suit::Clubs, Suit::Hearts],
        [Suit::Spades, Suit::Diamonds, Suit::Hearts, Suit::Clubs],
        [Suit::Spades, Suit::Hearts, Suit::Clubs, Suit::Diamonds],
        [Suit::Spades, Suit::Hearts, Suit::Diamonds, Suit::Clubs],
    ];

    let mut best: Option<([Card; 4], Vec<Card>, Vec<(u8, u8)>)> = None;

    for perm in &PERMS {
        let mut mapped_board: Vec<Card> = board
            .iter()
            .map(|c| Card::new(c.rank(), perm[c.suit() as usize]))
            .collect();
        mapped_board.sort_unstable_by(|a, b| {
            b.rank()
                .cmp(&a.rank())
                .then_with(|| a.suit().cmp(&b.suit()))
        });

        let mut mapped_hand = [
            Card::new(hand[0].rank(), perm[hand[0].suit() as usize]),
            Card::new(hand[1].rank(), perm[hand[1].suit() as usize]),
            Card::new(hand[2].rank(), perm[hand[2].suit() as usize]),
            Card::new(hand[3].rank(), perm[hand[3].suit() as usize]),
        ];
        mapped_hand.sort_unstable_by(|a, b| {
            b.rank()
                .cmp(&a.rank())
                .then_with(|| a.suit().cmp(&b.suit()))
        });

        let mut key = Vec::with_capacity(mapped_board.len() + 4);
        for c in &mapped_board {
            key.push((12 - c.rank() as u8, c.suit() as u8));
        }
        for c in &mapped_hand {
            key.push((12 - c.rank() as u8, c.suit() as u8));
        }

        match &best {
            None => best = Some((mapped_hand, mapped_board, key)),
            Some((_, _, best_key)) if &key < best_key => {
                best = Some((mapped_hand, mapped_board, key))
            }
            _ => {}
        }
    }

    let (h, b, _) = best.unwrap();
    (h, b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_card_roundtrip_and_bitmask() {
        let mut full = HandMask::EMPTY;
        for suit in Suit::ALL {
            for rank in Rank::ALL {
                let c = Card::new(rank, suit);
                assert_eq!(c.rank(), rank);
                assert_eq!(c.suit(), suit);
                let s = c.to_string();
                let parsed: Card = s.parse().unwrap();
                assert_eq!(parsed, c);
                assert!(!full.contains(c));
                full.insert(c);
                assert!(full.contains(c));
            }
        }
        assert_eq!(full, HandMask::FULL_DECK);
        assert_eq!(full.count(), 52);
    }

    #[test]
    fn test_hand_parsing_and_formatting() {
        let cards = Card::parse_n::<4>("As Kd Qh Jc").unwrap();
        assert_eq!(format_cards(&cards), "As Kd Qh Jc");

        let compact = Card::parse_n::<4>("AsKdQhJc").unwrap();
        assert_eq!(cards, compact);

        let mask: HandMask = "As Kd Qh Jc".parse().unwrap();
        assert_eq!(mask.count(), 4);
        assert_eq!(mask.to_string(), "As Kd Qh Jc");
    }

    #[test]
    fn test_duplicate_card_rejected() {
        let err = Card::parse_many("As Kd As Jc").unwrap_err();
        assert_eq!(
            err,
            CardParseError::DuplicateCard(Card::new(Rank::Ace, Suit::Spades))
        );
    }

    #[test]
    fn test_suit_canonicalisation_isomorphism() {
        // Double-suited Aces: As Ks Qh Jh vs Ad Kd Qc Jc vs Ah Kh Qd Jd
        let h1 = Card::parse_n::<4>("As Ks Qh Jh").unwrap();
        let h2 = Card::parse_n::<4>("Ad Kd Qc Jc").unwrap();
        let h3 = Card::parse_n::<4>("Ah Kh Qd Jd").unwrap();
        assert_eq!(canonicalize_plo_hand(h1), canonicalize_plo_hand(h2));
        assert_eq!(canonicalize_plo_hand(h2), canonicalize_plo_hand(h3));

        // Different suit structure: As Ks Qh Jd (single-suited) must NOT match double-suited
        let h_single = Card::parse_n::<4>("As Ks Qh Jd").unwrap();
        assert_ne!(canonicalize_plo_hand(h1), canonicalize_plo_hand(h_single));

        // Rainbow Aces: As Kd Qh Jc vs Ad Kh Qs Jc
        let r1 = Card::parse_n::<4>("As Kd Qh Jc").unwrap();
        let r2 = Card::parse_n::<4>("Ad Kh Qs Jc").unwrap();
        assert_eq!(canonicalize_plo_hand(r1), canonicalize_plo_hand(r2));
    }

    #[test]
    fn test_hand_with_board_canonicalisation() {
        // Hero holds nut flush draw on a 2-tone flop in Spades vs Hearts
        let h1 = Card::parse_n::<4>("As Ks Qd Jc").unwrap();
        let b1 = Card::parse_many("Ts 9s 2d").unwrap();

        let h2 = Card::parse_n::<4>("Ah Kh Qc Jd").unwrap();
        let b2 = Card::parse_many("Th 9h 2c").unwrap();

        assert_eq!(
            canonicalize_hand_with_board(h1, &b1),
            canonicalize_hand_with_board(h2, &b2)
        );
    }
}
