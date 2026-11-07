# `plo-engine` — Pot Limit Omaha Evaluator & Equity Core (Ticket E1)

`plo-engine` is the Phase 1 foundation for a 4-card Pot Limit Omaha (PLO) GTO solver. It implements bitmask card representations, a branchless lookup-table 5-card evaluator, an exact 60-combination Omaha best-hand evaluator (`2 hole + 3 board`), and a heads-up equity engine (hand-vs-hand and hand-vs-range, exact enumeration and fixed-seed Monte Carlo with standard error).

## Workspace Crates

- **[`plo-cards`](crates/plo-cards)**:
  - `Rank` (`0..13`), `Suit` (`0..4`), and `Card` (`0..52`, encoded as `suit * 13 + rank`).
  - `HandMask(u64)`: 52-bit card set mask where each suit occupies a contiguous 13-bit lane (`Clubs: 0..13`, `Diamonds: 13..26`, `Hearts: 26..39`, `Spades: 39..52`).
  - Parsing and formatting helpers (`"As Kd Qh Jc"` or `"AsKdQhJc"`, `PloHand`, `Card::parse_many`, `Card::parse_n`).
  - Suit-isomorphism canonicalisation (`canonicalize_plo_hand`, `canonical_plo_mask`, `canonicalize_hand_with_board`).
  - Zero dependencies beyond `std`.

- **[`plo-eval`](crates/plo-eval)**:
  - **Fast 5-card evaluator (`eval_5cards`, `eval_5cards_mask`)**: Uses build-time generated perfect-sum rank weights (`SUIT_KEY[8192]`) and `EVAL_TABLE` (`build.rs`) to evaluate any 5-card `HandMask` in 4 suit-lane lookups + 1 table lookup with zero branches. Returns `HandRank(u32)` (`(category << 20) | tiebreaker`, where higher = stronger).
  - **Omaha best-hand evaluator (`eval_omaha`, `eval_omaha_mask`, `compare_omaha`)**: Evaluates strictly 2 hole cards + strictly 3 board cards across all $\binom{4}{2} \times \binom{5}{3} = 60$ five-card combinations and returns the maximum `HandRank`.
  - **Heads-up equity calculator (`compute_hand_vs_hand_equity`, `compute_hand_vs_range_equity`, `compute_hand_vs_hand_auto`, `compute_hand_vs_range_auto`)**:
    - Supports both hand-vs-hand and hand-vs-range (`PloRange` of weighted 4-card combos) with full card-removal correctness against Hero's hand, the initial board, and all board runout cards.
    - Exact enumeration (`EquityMode::Exact`) over all remaining board runouts for river (1 board), turn (40 boards), and flop (820 boards).
    - Deterministic fixed-seed Monte Carlo (`EquityMode::MonteCarlo { samples, seed }`) for preflop (or any street), reporting sample standard error (`EquityResult::std_error`) via Welford's online variance algorithm.

- **[`plo-bench`](crates/plo-bench)**:
  - Standalone timing binary (no external benchmark dependencies) measuring 5-card evaluations/sec, Omaha 60-combo evaluations/sec, and exact river/turn/flop + preflop MC equity latency on fixed test cases.

## Running Tests and Benchmarks

Run the full test suite (recommended in `--release` mode for speed on the 210k random showdown and 2.59M exhaustive 5-card checks, though debug mode also passes):

```bash
cargo test --release
cargo test
```

Run the benchmark binary in release mode:

```bash
cargo run --release -p plo-bench
```

## Validation Design (Fast vs. Reference)

Accuracy is enforced in [`crates/plo-eval/tests/validation.rs`](crates/plo-eval/tests/validation.rs) by validating the fast table-driven evaluator against a completely separate, deliberately simple reference evaluator (`ref_eval_5cards` and `ref_eval_omaha`) built from straight-line category checks, plain array sorting, and frequency counting (no lookup tables, no bitmasks):

1. **Exhaustive 5-Card Verification**: Enumerates all $\binom{52}{5} = 2,598,960$ five-card hands, verifying exact combinatorial counts for all 9 categories and spot-checking exact category + tiebreaker parity against `ref_eval_5cards`.
2. **210,000 Randomised Omaha Showdowns**: Using a fixed deterministic seed (`0x2026_E100_DEAD_BEEF`, printed on failure), deals 70,000 flop, 70,000 turn, and 70,000 river Omaha showdowns and asserts 100% identical win/loss/tie outcomes, categories, and tiebreakers between `compare_omaha` and `ref_compare_omaha`.
3. **Brute-Force Reference Equity Parity**: Asserts exact equality between the fast equity calculator and brute-force reference enumeration across fixed river, turn, and flop hand-vs-hand and weighted hand-vs-range test cases (including card-removal blocking), plus preflop/flop Monte Carlo convergence within standard error.
4. **20 Hand-Written Known-Answer & Omaha Trap Cases**: Covers all 9 hand categories, wheel straights (`A-2-3-4-5`), steel wheels, split-pot ties, and Omaha-specific traps (4-flush in hole on 1-flush board, lone flush card on 4-flush board, 3-flush in hole on 2-flush board, "playing the board" on a Royal Flush board, quads on board, quads in hole, 3-of-a-kind in hole, and 3-hole-card / 1-hole-card mirage straights).

## Turn Solver (Ticket E3)

`plo-solve` also contains a two-street **turn solver** (`crates/plo-solve/src/turn.rs`,
CLI: `solve-turn`) that extends the E2 river solver to a game starting on the turn:

- **Game definition (`TurnSpot` / `TurnGame`)**: 4-card board, per-player weighted
  ranges, starting pot, effective stacks, and *per-street* `TreeConfig`s (turn and
  river bet/raise menus may differ). Pot-limit legality on both streets reuses the E2
  functions (`legal_bet_sizes` / `legal_raise_sizes`) with the pot and stack as of
  each street's start.
- **Chance nodes**: when a turn action sequence closes (check-check or a call), a
  chance node deals the river. For any valid combo pair there are always exactly
  `52 - 4 - 4 - 4 = 40` dealable river cards, each with probability `1/40`. Card
  removal is exact per combo pair: per-runout kernels exclude every opponent combo
  containing the river card, and rows for combos containing it are empty — so both
  showdown *and* fold values are exactly 0 for pairs a runout blocks (no
  approximation, no renormalisation drift).
- **Solving**: the same vectorised Discounted CFR as the river solver (α=1.5, β=0,
  γ=2, alternating updates), generalised to the two-street tree. All-in runouts with
  no stack behind collapse directly to showdowns under the chance node.
- **Checking**: `compute_exploitability_turn` (`br.rs`) is an independent traversal of
  the two-street tree (own recursion, ranks recomputed per runout via `eval_omaha`,
  explicit pair filtering at chance nodes) that shares only the evaluator and the
  game/strategy data definitions with the solver.
- **Memory layout**: DCFR keeps three `f64` buffers (cumulative regrets, cumulative
  weighted strategy, current strategy) per (decision node × acting-player combo ×
  action). Terminal evaluation uses one CSR kernel per player per runout (49 per
  player including the pre-river fold kernel), each storing opponent combo indices
  partitioned into wins/ties/losses plus 4 `u32` offsets per combo. Strategies are
  extracted as one `NodeStrategy` per decision node across both streets; river nodes
  carry their runout index and river card, and the `solve-turn` JSON output keys
  them with `"street"` and `"river_card"` fields.
- **Validation** (`crates/plo-solve/tests/turn_validation.rs`): exact card-removal
  weights, a degenerate all-nuts-on-every-runout spot, turn-vs-river consistency
  (forced check-check turns reproduce direct E2 river solves on 3 runouts, checked
  by transplanting strategies into the river game and re-measuring exploitability),
  and two 120-combo convergence spots (wet and paired boards) held to the 0.3%-of-pot
  checker bar. The heavy tests are release-only (`#[cfg(not(debug_assertions))]`)
  because debug-mode wall time over 48 runouts is impractical.
