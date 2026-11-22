//! Texas Hold'em hand evaluation and weighted two-card ranges.

use plo_cards::{Card, HandMask};

use crate::{eval_5cards, EquityError, HandRank};

/// Evaluates the best five-card hand available from two hole cards and a five-card board.
pub fn eval_holdem(hole: [Card; 2], board: [Card; 5]) -> HandRank {
    let cards = [
        hole[0], hole[1], board[0], board[1], board[2], board[3], board[4],
    ];
    let mut best = HandRank::default();
    for a in 0..3 {
        for b in a + 1..4 {
            for c in b + 1..5 {
                for d in c + 1..6 {
                    for e in d + 1..7 {
                        best = best.max(eval_5cards([
                            cards[a], cards[b], cards[c], cards[d], cards[e],
                        ]));
                    }
                }
            }
        }
    }
    best
}

/// A weighted two-card Hold'em combination.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct HoldemCombo {
    pub cards: [Card; 2],
    pub mask: HandMask,
    pub weight: f64,
}

impl HoldemCombo {
    pub fn new(cards: [Card; 2], weight: f64) -> Result<Self, EquityError> {
        let mask = HandMask::from_cards(&cards);
        if mask.count() != 2 {
            return Err(EquityError::InvalidHoldemHandCardCount(
                mask.count() as usize
            ));
        }
        if !weight.is_finite() || weight <= 0.0 {
            return Err(EquityError::InvalidWeight(weight));
        }
        Ok(Self {
            cards,
            mask,
            weight,
        })
    }

    pub fn from_str_weight(s: &str, weight: f64) -> Result<Self, EquityError> {
        let cards = Card::parse_n::<2>(s).map_err(EquityError::ParseError)?;
        Self::new(cards, weight)
    }
}

/// A weighted range of two-card Hold'em combinations.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HoldemRange {
    combos: Vec<HoldemCombo>,
}

impl HoldemRange {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_str_specs(specs: &[(&str, f64)]) -> Result<Self, EquityError> {
        let mut range = Self::new();
        for &(hand, weight) in specs {
            range.push(
                Card::parse_n::<2>(hand).map_err(EquityError::ParseError)?,
                weight,
            )?;
        }
        if range.is_empty() {
            return Err(EquityError::EmptyRange);
        }
        Ok(range)
    }

    pub fn push(&mut self, cards: [Card; 2], weight: f64) -> Result<(), EquityError> {
        self.combos.push(HoldemCombo::new(cards, weight)?);
        Ok(())
    }

    pub fn combos(&self) -> &[HoldemCombo] {
        &self.combos
    }

    pub fn len(&self) -> usize {
        self.combos.len()
    }

    pub fn is_empty(&self) -> bool {
        self.combos.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HandCategory;

    #[test]
    fn holdem_evaluation_uses_any_five_of_seven_cards() {
        let royal_board = Card::parse_n::<5>("As Ks Qs Js Ts").unwrap();
        let hole = Card::parse_n::<2>("2c 3d").unwrap();
        assert_eq!(
            eval_holdem(hole, royal_board).category(),
            HandCategory::StraightFlush
        );

        let wheel_board = Card::parse_n::<5>("2c 3d 4h 5s 9c").unwrap();
        let ace = Card::parse_n::<2>("Ac Kc").unwrap();
        assert_eq!(
            eval_holdem(ace, wheel_board).category(),
            HandCategory::Straight
        );
    }

    #[test]
    fn holdem_ranges_require_two_distinct_cards_and_positive_weights() {
        assert!(HoldemCombo::from_str_weight("As As", 1.0).is_err());
        let duplicate = Card::parse_n::<1>("As").unwrap()[0];
        assert_eq!(
            HoldemCombo::new([duplicate, duplicate], 1.0)
                .unwrap_err()
                .to_string(),
            "Hold'em hand must have 2 distinct cards, got 1"
        );
        assert!(HoldemCombo::from_str_weight("As Kd", 0.0).is_err());
        let range = HoldemRange::from_str_specs(&[("As Kd", 0.5)]).unwrap();
        assert_eq!(range.len(), 1);
        assert_eq!(range.combos()[0].weight, 0.5);
    }
}
