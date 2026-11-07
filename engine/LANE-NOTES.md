# LANE-NOTES — Ticket E1: PLO Engine (Omaha Evaluator + Equity Core)

## 1. Toolchain Version Used
- `rustc 1.99.1 (58cf8f9c3 2026-10-13)`
- `cargo 1.99.1 (5f94df478 2026-08-27)`
- Rust edition: `2021`
- External dependencies: **0** (`std` only across all crates; deterministic `Xoshiro256**` seeded via `SplitMix64` implemented directly in `plo-eval::rng`).

## 2. Files Created
- `plo-engine/Cargo.toml` — Workspace manifest (`plo-cards`, `plo-eval`, `plo-bench`)
- `plo-engine/README.md` — Architecture, crate responsibilities, test/bench usage, and validation design
- `plo-engine/LANE-NOTES.md` — Lane deliverable summary
- `plo-engine/crates/plo-cards/Cargo.toml` — `plo-cards` package manifest (`std` only)
- `plo-engine/crates/plo-cards/src/lib.rs` — `Rank`, `Suit`, `Card`, `HandMask(u64)`, `PloHand`, parsing/formatting (`"As Kd Qh Jc"`), and suit-isomorphism canonicalisation (`canonicalize_plo_hand`, `canonical_plo_mask`, `canonicalize_hand_with_board`) + 5 unit tests
- `plo-engine/crates/plo-eval/Cargo.toml` — `plo-eval` package manifest
- `plo-engine/crates/plo-eval/build.rs` — Build-time table generator finding collision-free 5-card rank weights `RANK_WEIGHTS[13]`, `SUIT_KEY[8192]`, and `EVAL_TABLE` (6,175 non-flush rank multisets + 1,287 flush masks)
- `plo-engine/crates/plo-eval/src/lib.rs` — Crate root and public re-exports
- `plo-engine/crates/plo-eval/src/eval5.rs` — `HandCategory`, `HandRank(u32)`, `eval_5cards_mask`, and `eval_5cards`
- `plo-engine/crates/plo-eval/src/omaha.rs` — `eval_omaha`, `eval_omaha_mask`, `compare_omaha`, `extract_hole_pairs`, `extract_board_triples` (strictly 2 hole + 3 board over all $\binom{4}{2}\times\binom{5}{3}=60$ combinations)
- `plo-engine/crates/plo-eval/src/equity.rs` — Heads-up equity engine (`compute_hand_vs_hand_equity`, `compute_hand_vs_range_equity`, `compute_hand_vs_hand_auto`, `compute_hand_vs_range_auto`, `PloRange`, `WeightedCombo`, `EquityMode`, `EquityResult`) with exact board runout enumeration, card-removal correctness, and fixed-seed Monte Carlo with Welford standard error
- `plo-engine/crates/plo-eval/src/rng.rs` — Deterministic `Xoshiro256**` PRNG (`DeterministicRng`)
- `plo-engine/crates/plo-eval/tests/validation.rs` — Independent straight-line reference evaluator (`ref_eval_5cards`, `ref_eval_omaha`) and 7 validation test suites (exhaustive 2,598,960 5-card check, 210,000 random Omaha showdowns across flop/turn/river, brute-force equity comparisons, MC standard error checks, 20 hand-written known-answer & Omaha trap cases, and card-removal collision tests)
- `plo-engine/crates/plo-bench/Cargo.toml` — `plo-bench` package manifest
- `plo-engine/crates/plo-bench/src/main.rs` — Standalone benchmark runner (`cargo run --release -p plo-bench`)

## 3. Test Counts and Results
Total tests: **12 passed, 0 failed** (5 unit tests in `plo-cards` + 7 integration/validation suites in `plo-eval`, passing in both `--release` and debug modes).

### `cargo test --release` Output Summary
```text
     Running unittests src/main.rs (plo-engine/target/release/deps/plo_bench-534cbde4c5fb6bf4)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (plo-engine/target/release/deps/plo_cards-aae363b1ab38825c)

running 5 tests
test tests::test_duplicate_card_rejected ... ok
test tests::test_card_roundtrip_and_bitmask ... ok
test tests::test_hand_parsing_and_formatting ... ok
test tests::test_hand_with_board_canonicalisation ... ok
test tests::test_suit_canonicalisation_isomorphism ... ok

test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running unittests src/lib.rs (plo-engine/target/release/deps/plo_eval-f1e2426cb0cba6ba)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/validation.rs (plo-engine/target/release/deps/validation-e0d628ac3b34f193)

running 7 tests
test test_20_known_answer_showdowns_and_omaha_traps ... ok
test test_card_removal_errors_and_blocked_combos ... ok
test test_exact_equity_matches_reference_brute_force_river_turn_flop ... ok
test test_exact_hand_vs_range_with_card_removal_matches_reference ... ok
test test_exhaustive_all_2598960_five_card_hands_and_category_counts ... ok
test test_preflop_and_flop_monte_carlo_determinism_and_standard_error ... ok
test test_210k_random_omaha_showdowns_fast_vs_reference_across_streets ... ok

test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.78s
```

### `cargo test` (Debug Mode) Summary Line
```text
test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 33.17s
```

## 4. Benchmark Output (`cargo run --release -p plo-bench`)
```text
================================================================
  plo-bench — PLO Evaluator & Equity Core Benchmark Suite
================================================================

--- [1] 5-Card Hand Evaluator Throughput ---
  Exhaustive C(52,5) x 20 (51979200 evals): 169.51 ms (306.64 M evals/sec) [checksum=0x00003a92c70d4000]
  Random 5-card buffer (20000000 evals):         75.67 ms (264.29 M evals/sec) [checksum=0x0000168870042338]

--- [2] Omaha Best-Hand (60-combo) Evaluator Throughput ---
  Omaha best-hand (5000000 hands): 988.64 ms (5.06 M Omaha evals/sec | 303.45 M underlying 5-card evals/sec) [checksum=0x00000e45133858b8]

--- [3] Exact Turn+River & Flop/Preflop Equity Timing (Fixed Cases) ---
  [River Exact Hand-vs-Hand]   0.467 us/call (100000 iters in 46.73 ms) -> [Exact] Hero Eq: 100.0000% (Win: 100.0000%, Tie: 0.0000%, Loss: 0.0000%, Weight: 1.0)
  [Turn  Exact Hand-vs-Hand]  11.201 us/call (10000 iters in 112.01 ms) -> [Exact] Hero Eq: 85.0000% (Win: 85.0000%, Tie: 0.0000%, Loss: 15.0000%, Weight: 40.0)
  [Flop  Exact Hand-vs-Hand] 251.813 us/call (1000 iters in 251.81 ms) -> [Exact] Hero Eq: 82.8049% (Win: 82.8049%, Tie: 0.0000%, Loss: 17.1951%, Weight: 820.0)
  [Turn  Exact Hand-vs-Range (10 combos)]  42.475 us/call (2000 iters in 84.95 ms) -> [Exact] Hero Eq: 68.7000% (Win: 67.1000%, Tie: 3.2000%, Loss: 29.7000%, Weight: 250.0)
  [Flop  Exact Hand-vs-Range (10 combos)] 1099.241 us/call (200 iters in 219.85 ms) -> [Exact] Hero Eq: 74.3854% (Win: 72.5366%, Tie: 3.6976%, Loss: 23.7659%, Weight: 5125.0)
  [Preflop MC  Hand-vs-Hand]  50.507 ms/call -> [MC N=100000 seed=0xbeefcafe2026e101] Hero Eq: 54.7340% ± 0.1574% SE (Win: 54.7340%, Tie: 0.0000%, Loss: 45.2660%)
```

## 5. Deliberately Omitted / Out of Scope for E1
- **No external dependencies (`rand`, `criterion`, etc.)**: Implemented a deterministic `Xoshiro256**` PRNG (`DeterministicRng`) seeded via `SplitMix64` directly in `plo-eval` and plain `std::time::Instant` timing in `plo-bench`, keeping external crate count at zero.
- **No multi-way (3+ player) equity or 5-card/6-card PLO variants**: Scoped strictly to heads-up 4-card PLO (`hand-vs-hand` and `hand-vs-range`) per the E1 specification.
- **No game-tree, betting abstraction, or CFR/DCFR solver code**: Reserved for subsequent Phase 1 tickets per the governing spec.
