//! Deterministic, seedable PRNG (`Xoshiro256**` seeded via `SplitMix64`) for Monte Carlo
//! equity simulation and deterministic randomised validation tests.

use plo_cards::Card;

/// Deterministic `Xoshiro256**` pseudo-random number generator.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeterministicRng {
    state: [u64; 4],
}

impl DeterministicRng {
    /// Initialises the generator deterministically from a 64-bit `seed` using `SplitMix64`.
    #[inline]
    pub const fn from_seed(seed: u64) -> Self {
        let mut sm = seed;
        let s0 = splitmix64(&mut sm);
        let s1 = splitmix64(&mut sm);
        let s2 = splitmix64(&mut sm);
        let s3 = splitmix64(&mut sm);
        Self {
            state: [s0, s1, s2, s3],
        }
    }

    /// Generates the next 64-bit unsigned integer.
    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        let result = self.state[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.state[1] << 17;

        self.state[2] ^= self.state[0];
        self.state[3] ^= self.state[1];
        self.state[1] ^= self.state[2];
        self.state[0] ^= self.state[3];

        self.state[2] ^= t;
        self.state[3] = self.state[3].rotate_left(45);

        result
    }

    /// Generates a uniform `f64` in `[0.0, 1.0)`.
    #[inline]
    pub fn next_f64(&mut self) -> f64 {
        const SCALE: f64 = 1.0 / ((1u64 << 53) as f64);
        ((self.next_u64() >> 11) as f64) * SCALE
    }

    /// Generates an unbiased uniform index in `0..bound` using Lemire's fast divisionless method.
    #[inline]
    pub fn gen_index(&mut self, bound: usize) -> usize {
        debug_assert!(bound > 0);
        let b = bound as u128;
        let mut x = self.next_u64() as u128;
        let mut m = x * b;
        let mut l = m as u64;
        if l < (bound as u64) {
            let t = (bound as u64).wrapping_neg() % (bound as u64);
            while l < t {
                x = self.next_u64() as u128;
                m = x * b;
                l = m as u64;
            }
        }
        (m >> 64) as usize
    }

    /// Performs a partial Fisher-Yates shuffle on `deck[..len]` to draw `k` cards uniformly
    /// without replacement into the first `k` slots `&deck[..k]`.
    #[inline]
    pub fn sample_cards<'a>(&mut self, deck: &'a mut [Card], k: usize) -> &'a [Card] {
        let n = deck.len();
        debug_assert!(k <= n);
        for i in 0..k {
            let j = i + self.gen_index(n - i);
            deck.swap(i, j);
        }
        &deck[..k]
    }
}

#[inline]
const fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}
