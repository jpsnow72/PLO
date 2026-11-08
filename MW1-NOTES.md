# MW-1 Notes — Multiway Lens: Exact & Seeded Monte Carlo Multiway Equity

## 1. Architecture & Deliverables Summary

Ticket **MW-1** implements end-to-end multiway PLO equity calculation across the Rust engine (`plo-eval` + `plo-solve`), the Node HTTP job service (`api/`), and the React Explorer UI (`ui/`):

1. **Engine (`engine/crates/plo-eval/src/multiway.rs`, exported from `plo-eval/src/lib.rs`)**:
   - Supports 3-card (flop), 4-card (turn), and 5-card (river) boards (`board: &[Card]`).
   - Supports `HeroInput::Hand([Card; 4])` (a specific 4-card PLO combo) or `HeroInput::Range(PloRange)` (a weighted PLO range).
   - Supports `1..=4` weighted opponent ranges (`opponents: &[PloRange]`, total `2..=5` players).
   - Enforces dead-card removal (`board` + `extra_dead` + hero cards + already-chosen opponent cards + runout cards) using 64-bit `HandMask` bitmask operations (`overlaps()`).
   - Splits `m`-way ties equally (`1.0 / m as f64` share to each tied winner; `win_prob` increments only for outright `m == 1` wins; `tie_prob` and `tie_equity` track tied showdowns).
   - Computes per-player `PlayerEquity` (`equity`, `win_prob`, `tie_prob`, `tie_equity`, `loss_prob`, `std_error`), `hero_equity`, the `EquityMode` (`Exact` or `MonteCarlo { samples, seed }`), and when Hero is a range, `HeroRangeDistribution` (`mean`, `quartiles: [min, q25, median, q75, max]`, `top_decile`, `bottom_decile`).
   - Added `PloRange::all_unblocked(dead: HandMask)` and `PloRange::all_combos()` in `engine/crates/plo-eval/src/equity.rs` for fast uniform `"random"` range construction without string parsing overhead.

2. **CLI Binary (`engine/crates/plo-solve/src/bin/multiway-equity.rs` + `engine/crates/plo-solve/src/json.rs`)**:
   - Reads a JSON request from a file path argument or `stdin`, executes `run_multiway_equity_request`, and prints formatted JSON (`format_multiway_equity_result_json`) to `stdout`.
   - Always emits `"mode": "exact" | "monte_carlo"`, `"badge": "EXACT" | "MONTE CARLO"`, `"is_exact": true | false`, `"samples"`, and `"seed"` so Monte Carlo results are never presented as exact.

3. **API (`POST /api/multiway/equity` in `api/server.mjs`, documented in `api/README.md`)**:
   - Validates `board` (3, 4, or 5 valid cards, no duplicates), `dead_cards` (optional), Hero (`hero_hand` or `hero_range`), and `opponents` (array of 1..4 opponent specs).
   - Accepts opponent ranges in all formats used across the app:
     - Preset `"random"` (or `{ preset: "random" }`)
     - Solver-compatible range text (`"AhAdKhKd:1.0\nQsJsTs9s:0.5"`, space-separated or compact 8-char combos, newline or comma separated)
     - Engine array of `"Combo:weight"` strings
     - Preflop range-set ID (`{ range_set: "constructed-v1-..." }`)
   - Spawns `multiway-equity` from `ENGINE_BIN` with `MULTIWAY_TIMEOUT_MS` (default `30000` ms) and returns its JSON output or an HTTP error (`400` / `422` / `504`).

4. **UI (`ui/src/components/MultiwayLens.tsx` integrated into `ui/src/pages/Explorer.tsx`)**:
   - Collapsible **Multiway lens** panel in the right column of Explorer below the Range / Hand Detail panel.
   - Tracks the current board at the active tree node (`solve.boardCards` + `turnCard` + `riverCard`).
   - Uses `selectedCombo` from the Explorer range grid as Hero's hand (or prompts the user to pick a combo in the range grid when none is selected), and also supports switching Hero to Range mode (with a one-click `"Use node range"` helper).
   - Configures `1..4` opponents with `"random"` preset or `"Range text"` input.
   - Calls `POST /api/multiway/equity`, displays per-player equities (Hero + Opponents 1..K) with `<MultiwayEquityBadge />` (`✓ EXACT` vs `≈ MONTE CARLO (N samples)`), and surfaces any API error in an alert box with **no fake or default equities**.
   - Includes the required empty placeholder slot:
     `"Adjustment guide — coming in a later ticket (approximation)"` with `<ApproximationBadge />` and no invented advice text.

---

## 2. Exact vs. Monte Carlo Threshold (`EXACT_MAX_SHOWDOWNS`) & Rationale

- **Constant**: `pub const EXACT_MAX_SHOWDOWNS: u128 = 250_000;` (defined in `engine/crates/plo-eval/src/multiway.rs`).
- **How `estimated_showdowns` is calculated**:
  $$\text{estimated\_showdowns} = |H_{\text{unblocked}}| \times \left(\prod_{i=1}^{K} |O_{i,\text{unblocked}}|\right) \times \binom{52 - |\text{dead}_{\text{base}}|}{5 - |\text{board}|}$$
  where:
  - $|H_{\text{unblocked}}|$ is `1` for `HeroInput::Hand` or the number of unblocked combos in `HeroInput::Range`,
  - $|O_{i,\text{unblocked}}|$ is the number of combos in opponent $i$'s range that do not collide with `dead_base` (`board | extra_dead | hero_hand`),
  - $\binom{52 - |\text{dead}_{\text{base}}|}{5 - |\text{board}|}$ is the upper bound on board runouts (`1` on the river, $\le 44$ on the turn, $\le 990$ on the flop).
- **Rationale for `250_000`**:
  1. **River made-hand vs. random is guaranteed EXACT**: On a 5-card river board with a 4-card Hero hand (9 dead cards, 43 remaining deck cards), a full `"random"` opponent range has $\binom{43}{4} = 123,410$ unblocked combos and $1$ runout, so $\text{estimated\_showdowns} = 123,410 \le 250,000$. With precomputed per-combo river ranks (`precompute_combo_river_ranks`), all $123,410$ river showdowns evaluate in **~2 ms in release** (~15 ms in debug).
  2. **Hand vs. hand(s) on flop, turn, and river is guaranteed EXACT**: For 1..4 opponents holding single hands or narrow ranges, flop enumeration ($\le 820$ runouts), turn enumeration ($\le 40$ runouts), and river enumeration ($1$ runout) are well under $250,000$ showdowns and complete in milliseconds.
  3. **Wide multiway ranges / flop ranges switch cleanly to seeded Monte Carlo**: When $K \ge 2$ opponents have wide ranges (e.g. two `"random"` opponents on the river: $123,410^2 \approx 1.52 \times 10^{10}$ combinations) or wide ranges on the flop/turn, `estimated_showdowns > 250_000` triggers deterministic Monte Carlo (`DEFAULT_MULTIWAY_MC_SAMPLES = 50_000`, `DEFAULT_MULTIWAY_MC_SEED = 0x504C_4F35_4D43_5344`), keeping response latency bounded (~20–120 ms) while reporting `mode: "monte_carlo"`, `samples`, `seed`, and per-player `std_error`.

---

## 3. Sampling Approach (Monte Carlo Mode)

When `estimated_showdowns > EXACT_MAX_SHOWDOWNS` (or when `EquityMode::MonteCarlo` is explicitly requested):

1. **Deterministic PRNG**: Uses `DeterministicRng` (`xorshift64*` from `plo-eval::rng`) seeded with `seed` (default `0x504C_4F35_4D43_5344`), ensuring identical inputs always produce bit-for-bit identical outputs.
2. **Cumulative-Weight Binary Search**:
   - Each player's unblocked range is pre-indexed into a `WeightedSampler` storing cumulative weights `cum_weights: Vec<f64>` and `total_weight: f64`.
   - Each draw generates $u \in [0, W_{\text{total}})$ via `rng.next_f64() * total_weight` and locates the combo in $O(\log C)$ via `partition_point`.
3. **Rejection Sampling for Card Collisions**:
   - In each trial, Hero's combo is drawn first (or fixed if `HeroInput::Hand`), initializing `used_mask = base_dead | hero.mask`.
   - Each opponent $i \in \{1..K\}$ draws a weighted combo from its `WeightedSampler`. If `opp.mask.overlaps(used_mask)`, the trial is rejected (`continue` loop up to `max_attempts = samples * 200`), otherwise `used_mask |= opp.mask`.
   - Because each player's sampler draws proportionally to its combo weight $w_i(c_i)$ and rejects iff any two players share a card, accepted joint tuples $(c_0, c_1, \dots, c_K)$ are distributed strictly according to the conditional product measure:
     $$P(c_0, \dots, c_K) \propto \prod_{p=0}^{K} w_p(c_p) \cdot \mathbf{1}[\text{pairwise disjoint}].$$
4. **Uniform Runout Sampling Without Replacement**:
   - From `remaining_deck = full_deck_mask() - used_mask`, `cards_needed = 5 - board.len()` runout cards are drawn uniformly without replacement using partial Fisher–Yates over the remaining deck array.
5. **Showdown Evaluation & Variance Tracking**:
   - Evaluates all $K+1$ players on the 5-card final board via `best_plo_hand_five_board`.
   - Finds the maximum `HandRank` and count $m$ of tied winners; each tied winner receives share $s_p = 1/m$, and online sum of squares $\sum s_p^2$ is tracked to report the sample standard error $\text{SE}_p = \sqrt{\frac{\hat{\sigma}_p^2}{N_{\text{accepted}}}}$.

---

## 4. Hero Range Distribution & Decile Slicing

When Hero is `HeroInput::Range`:
- Every unblocked Hero combo $c_0$ with positive showdown weight against the opponents' joint distribution has its conditional equity $e(c_0) = \frac{\text{equity\_sum}(c_0)}{\text{weight\_sum}(c_0)}$ recorded in `ComboEquity`.
- Combos are sorted in ascending order of equity (ties broken canonically by cards) to compute weighted quantiles (`min`, `q25`, `median`, `q75`, `max`).
- Combos are sorted in descending order of equity to extract the **top decile** (`ceil(0.10 * combo_count)`, capped at `MAX_DECILE_COMBOS = 100`) and in ascending order of equity to extract the **bottom decile** (`ceil(0.10 * combo_count)`, capped at `MAX_DECILE_COMBOS = 100`), avoiding payload bloat on 10,000+ combo ranges while preserving full summary statistics.

---

## 5. Test List

### Rust Engine Tests (`engine/crates/plo-eval`)
- **Unit tests in `src/multiway.rs`**:
  - `test_two_player_multiway_matches_headsup_river_and_turn`: Verifies 1-opponent multiway exact equity matches `compute_equity_exact` to $< 10^{-12}$ on both river and turn.
  - `test_three_way_tie_splits_one_third_each`: Verifies 3-way tie on the board split gives `1/3` equity to each player.
  - `test_monte_carlo_matches_exact_within_tolerance`: Verifies seeded Monte Carlo (`20,000` samples) agrees with exact 3-way flop enumeration within `0.015`.
- **Integration tests in `tests/multiway.rs`**:
  - `test_symmetric_ranges_equal_equities_and_sum_to_one`: 2-way, 3-way, and 4-way symmetric ranges (suits permuted on rainbow board + identical multi-combo ranges) produce equal equities (`1/2`, `1/3`, `1/4`) and sum to `1.0` in both Exact and Monte Carlo modes.
  - `test_card_removal_blocked_combos_never_appear`: Asserts opponent combos sharing cards with the board or Hero hand are never dealt, and fully blocked opponent ranges return `EquityError::AllRangeCombosBlocked`.
  - `test_made_hand_vs_random_on_river_is_exact_and_known_value`: Verifies royal flush (`Js Ts 4h 5h` on `As Ks Qs 2d 3c`) vs `"random"` (`123,410` combos) runs in `EquityMode::Exact` with `hero_equity == 1.0`, and nut-low quads (`2h 2s 4d 5c` on `As Ks Qs 2d 2c`) vs `"random"` runs in `EquityMode::Exact` and matches closed-form combinatorial calculation ($1 - \frac{36}{\binom{43}{4}} = \frac{123374}{123410}$) to $< 10^{-12}$.
  - `test_multiway_tie_handling_2way_3way_4way_5way`: Verifies 2-way (`1/2`), 3-way (`1/3`), 4-way (`1/4`), and 5-way (`1/5`) ties and mixed win + 3-way tie range showdowns.
  - `test_headsup_parity_and_hero_range_distribution_deciles`: Verifies 1-opponent `HeroInput::Range` matches `compute_equity_exact` and produces sorted `quartiles` and `top_decile` / `bottom_decile` slices.

### Node API Integration Tests (`api/multiway.test.mjs`)
- `POST /api/multiway/equity: exact 3-way river hand vs hands`
- `POST /api/multiway/equity: exact river hand vs random preset`
- `POST /api/multiway/equity: solver range text format and Monte Carlo mode for wide 3-way flop`
- `POST /api/multiway/equity: hero range distribution (mean, quartiles, deciles)`
- `POST /api/multiway/equity: validates opponent count (1..4)`
- `POST /api/multiway/equity: rejects invalid cards and duplicate cards across board/hero`

---

## 6. Exact Commands Run & Results

1. **Multiway integration & unit tests (`plo-eval`)**:
   - Command:
     ```
     /root/.cargo/bin/cargo test --manifest-path engine/Cargo.toml -p plo-eval multiway
     ```
   - Result: `3 passed` (unit tests in `src/multiway.rs`) + `5 passed` (integration tests in `tests/multiway.rs`), `0 failed`.

2. **Release build of `multiway-equity` binary (`plo-solve`)**:
   - Command:
     ```
     /root/.cargo/bin/cargo build --manifest-path engine/Cargo.toml --release --bin multiway-equity
     ```
   - Result: Exit `0`, built `engine/target/release/multiway-equity` in `19.60s`.

3. **Full Rust workspace test suite (`plo-cards`, `plo-eval`, `plo-solve`)**:
   - Command:
     ```
     /root/.cargo/bin/cargo test --manifest-path engine/Cargo.toml
     ```
   - Result: Exit `0`, all unit and integration tests across `plo-cards`, `plo-eval`, and `plo-solve` passed (`0 failed`).

4. **API syntax check & end-to-end `POST /api/multiway/equity` test suite**:
   - Commands:
     ```
     /root/node22/bin/node --check api/server.mjs
     /root/node22/bin/node --test api/multiway.test.mjs
     ```
   - Result: Exit `0`, `6 passed, 0 failed` (`381ms`).

5. **UI TypeScript check & Vite production build**:
   - Commands:
     ```
     /root/node22/bin/node ui/node_modules/typescript/bin/tsc --project ui/tsconfig.json --noEmit
     /root/node22/bin/node ui/node_modules/vite/bin/vite.js build ui
     ```
   - Result: Exit `0`, `tsc --noEmit` reported `0` errors; `vite build ui` transformed 74 modules and emitted `ui/dist/` in `2.19s`.
