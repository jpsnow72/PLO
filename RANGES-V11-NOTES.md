# RANGES-V11-NOTES — Continuation sets v1.1 (method `constructed-equity-v1.1`)

Build-only lane deliverable. Nothing in this tree was compiled or run on the
Muse VM (checks limited to JSON parsing, `node --check`, a Python mirror of
the fitting algorithm, and git-diff inspection — see §7). The coordinator
runs the commands in §8 on a host.
Branch: `ranges-v11-continuations` (based on `ranges-constructed-v1` @ 3fc93d1,
i.e. current main).

## 1. What was built

The 300-spot catalog's 3-bet group needs, for each 3-bet pot, the *opener's*
continuation range after facing the 3-bet. v1 sets contain only the
three-bettor's `three_bet` slice (inside the `vs_rfi` sets). This lane adds
the missing side, with the existing constructed-ranges machinery:

| Piece | Location |
| --- | --- |
| Continuation builder `build_continuation_set` + opening-weighted totals + config parsing + generation stage | `engine/crates/plo-solve/src/ranges.rs` |
| CLI updates (`--check` covers v1.1 sets; index rewriting preserves foreign entries without swallowing v1.1 ones) | `engine/crates/plo-solve/src/bin/build-ranges.rs` |
| Config: new `continuations_v11` section + two `_comment_*` blocks (purely additive — see §6) | `data/preflop/ranges-config-v1.json` |
| Schema: `vs_three_bet` context added (enum + per-context action rule + amendment note) | `data/preflop/rangeset.schema.json` |
| Importer context table gains `vs_three_bet` (fold/call/four_bet) so its document validation accepts the new sets unchanged | `data/preflop/import-csv.mjs` |
| Tests (2 new, in the existing style) | `engine/crates/plo-solve/tests/ranges_validation.rs` |
| Docs | `data/preflop/README.md`, `data/preflop/sets/README.md` |

Sets emitted by a generation run (in addition to the 41 v1 sets; 44 total):

- `constructed-v1.1-6max-btn-vs-bb-3bet` — BTN opens, BB 3-bets, BTN continues (continuer IP)
- `constructed-v1.1-6max-btn-vs-sb-3bet` — BTN opens, SB 3-bets, BTN continues (continuer IP)
- `constructed-v1.1-6max-co-vs-btn-3bet` — CO opens, BTN 3-bets, CO continues (continuer OOP)

6max only, per the catalog taxonomy (no 9max 3-bet pots). Each set's
`position` is the continuer; `context` is `vs_three_bet`;
`context_detail` names the full line, e.g. "BTN opens, BB 3-bets, BTN
continues (constructed)".

## 2. Methodology (extends v1, same machinery)

1. **Eligibility.** A class can continue only if the opener actually opens
   it: its raise frequency in the opener's emitted RFI set is > 0.
   Eligibility is read from the built RFI document (`action_freqs(..,
   "raise")`), so it matches the emitted set exactly, rounding included.
   Never-opened classes are emitted as fold 1.0.
2. **Reference range.** Equity is computed against the three-bettor's
   actual `three_bet` slice (from their built `vs_rfi` set), sampled as a
   frequency-weighted combo pool — the same `opener_pool`/`equity_vs_pool`
   machinery v1 uses against openers. Seeded Monte Carlo,
   `samples_vs_three_bettor` = 4,000 per class (mirrors v1's vs-opener
   count); each matchup's stream derives from the config master seed with
   its own tag base (900,000 + 10,000 × matchup index — the v1 opener tags
   stay below ~111,000, so no stream collides), and per-class results are
   thread-count invariant via the existing `par_map`.
3. **Score.** The v1 blend (`score_from_components`, config weights), with
   the equity slot filled by equity vs the three-bettor's slice
   **discounted by the continuer's postflop realisation factor**:
   0.92 in position (BTN vs BB, BTN vs SB), 0.84 out of position (CO vs
   BTN) — the v1 `realisation` config values. This is the lane's reading
   of the brief's two bullets (score = v1 blend vs the three-bettor's
   range; realisation factor config-exposed): a single ranking drives both
   slices, so the factor is applied inside that ranking's equity slot,
   mirroring how v1's call slice ranks by discounted equity.
4. **Selection.** Eligible classes ranked by score (key tie-break, as v1).
   The `four_bet` slice takes the top band; `call` takes the next band
   over the remaining (1 − four_bet) capacity. Both slices are fitted with
   v1's `fit_to_target` (linear ramp over ±1pp band + deterministic
   residual correction), in **opening-range weight** units: class mass =
   combo share × opener raise frequency.
5. **Emitted frequencies are conditional on having opened**: for an
   eligible class, fold + call + four_bet = 1. Consequently the natural
   totals for these sets are *fractions of the opener's raising range*,
   and both the set documents and `--check` use opening-range-weighted
   totals (`opening_weighted_totals`, which reweights the emitted hands
   by the opener RFI set's raise frequencies). Plain all-combo totals
   would be meaningless here and are never printed for these sets.

## 3. Targets — internal parameters, labelled as such (honesty contract)

**No published cross-check anchor for opener continuation rates vs a
3-bet exists in the free literature we may use.** The free-charts research
(`free-charts-research-2026-11-07.md`) was re-checked for this lane: the
only free page covering a vs-3bet spot (plo.ai-speeds.com, BTN vs BB
3-bet) publishes *dominant actions only, no frequencies*, states its
ranges are its own construction ("not a solver solution"), and carries no
reuse licence — reference-only, and it is **not** cited as a source
anywhere in the emitted data.

Targets are therefore set in the config as fractions **of the opener's
raising range by weight**, the brief's suggested starting point:

- continue **50%** of the opening range (`continue_fraction_of_open: 0.5`)
- of the continue slice: **call 82% / four_bet 18%**
  (`call_fraction_of_continue`, `four_bet_fraction_of_continue`)

i.e. per-set targets, in opening-range units: call 41.0%, four_bet 9.0%.
They are recorded everywhere as **internal construction parameters**:

- config `_comment_continuations_targets_v11` states they are not
  published values and gives the cross_check status verbatim:
  **"no published anchor - method disclosed"**;
- each set's `notes` state the units ("OF THE OPENER'S RAISING RANGE …
  not of all combos") and "Target kind: internal";
- each set's provenance is `method: constructed-equity-v1.1`,
  `sources: []`, with a `derivation` (see §4);
- `--check` prints them as "internal target … (internal - no published
  anchor - method disclosed)" and treats >0.5pp deviation as a failure of
  the *construction contract* only (same fit tolerance as v1) — it is not
  an external validation and is never printed as one.

## 4. Provenance shape of the new sets

Per the brief, `sources` = the two input sets. The schema's provenance
`sources` array holds external source blocks (name/licence/retrieved) and
cannot honestly hold set ids, so — following the existing 9-max precedent
(empty `sources` + `derivation`) — the input sets are named in the
`derivation`, which reads (BTN vs BB example):

> constructed-equity-v1.1 continuation: eligible classes = the opener's
> RFI classes (input set constructed-v1-6max-btn-rfi, raise frequency >
> 0); scored against the three-bettor's three_bet slice (input set
> constructed-v1-6max-bb-vs-btn) with realisation 0.92 (continuer in
> position postflop). Continuation targets are INTERNAL CONSTRUCTION
> PARAMETERS - fractions of the opener's raising range by weight
> (continue 50.0% of the opening range; of the continue slice, call
> 82.0% / four_bet 18.0%). cross_check: no published anchor - method
> disclosed.

(545 chars, within the schema's 1,000-char derivation limit; notes are
488 chars, within the 2,000 limit.) The top-level `source` field is
**not** emitted for these sets (provenance replaces it, as for all
constructed sets), and the index entries likewise carry provenance only.
The generator fails loudly if the config's named input-set ids do not
match the sets it actually generated — the derivation can never name the
wrong inputs. `RangeSetDoc` gained per-document `method` / `derivation` /
`notes_override` fields to support this; v1 documents populate them with
exactly the values the old hardcoded paths produced (method
`constructed-equity-v1`; derivation `None` for 6max, the seat-mapping
note for 9max; no notes override).

## 5. Schema amendment

`rangeset.schema.json`: `vs_three_bet` added to the `context` enum, an
`allOf` rule restricts its hands to fold/call/four_bet (mirroring the
existing `three_bet` context rule), the context description and the
schema description record the amendment. Note the pre-existing
`three_bet` context (a transcribed-chart context in the original plumbing)
is unchanged and distinct: the brief names the new context
`vs_three_bet`, and that is what the constructed sets use.
`ranges.rs::validate_rangeset` gained the matching `CONTEXT_ACTIONS`
entry, and `import-csv.mjs`'s context table gained the same entry.

## 6. v1 regeneration: identical by construction, one flagged exception

- The config diff is **purely additive** (verified by `git diff`: 30
  insertions, 0 modifications): every v1 key/value is byte-untouched.
- No v1 code path reads the new section: config parsing of all v1 fields
  is unchanged and happens before the optional section is parsed;
  `score_all_classes`, `build_rfi_set`, `build_response_set`, all seed
  derivations, sample counts, weights and targets are untouched. The
  `RangeSetDoc` emission refactor is value-preserving for v1 documents
  (see §4), including the 9-max derivation branch.
- **Flagged exception (by design, coordinator to confirm):** a full
  regeneration rewrites the v1 set files with the *current* config hash,
  and `config_hash` is a hash of the whole config file — which now
  includes the v1.1 section. So regenerated v1 files will differ from the
  committed ones **only** in the `config_hash` values (set provenance +
  index entries). Hands, totals, notes and sources are byte-identical.
  Coordinator check: after generating, `git diff data/preflop/sets/` on
  the v1 files should show config_hash lines only. (Suppressing this
  would require hashing a subset of the config — rejected as dishonest:
  the hash must identify the config actually used.)

## 7. Static sanity checks performed by this lane (no builds run)

- Config and amended schema parse as JSON; the config diff vs v1 is
  insertions-only; all six input set ids named in `continuations_v11`
  correspond to files that exist in `data/preflop/sets/` and to the ids
  the generator produces (RFI id rule and vs_rfi id rule checked by hand).
- `node --check` passes on the edited `import-csv.mjs`.
- A Python mirror of `fit_to_target` on synthetic opening-weight masses
  confirms the mechanics the tests rely on: both slice targets fit
  exactly, and the top-ranked class receives four_bet exactly 1.0.
- Brace/paren balance of the edited Rust files: the naive-count deltas
  are identical to the base file's (string literals), i.e. no new
  imbalance was introduced; all three `RangeSetDoc` construction sites
  were updated with the new fields (grep-verified — there are exactly
  three, plus the new builder).
- Emitted derivation/notes strings measured against the schema's length
  limits (545 / 488 chars vs 1,000 / 2,000).

**Not verified statically** (needs the host run): that the Rust compiles
(riskiest spots: match ergonomics in `opening_weighted_totals`, the
`matchup_for_set_id` closure in `check_doc_totals`, and the test file's
closure-heavy equity plumbing); actual Monte Carlo outputs; the premium
assertion (AAKK double-suited four-bets at exactly 1.0 — it rests on the
same ramp+residual mechanism that keeps v1's premium raise at exactly
1.0, and on AAKKds ranking first against a 3-bet slice; if the host run
shows a residual nudge, the failure will be precise); and the v1
byte-identity claim of §6 beyond the config_hash exception.

Test runtime note: the new heavy test adds five 2,000-sample equity
passes over all classes (two openers + three three-bettor slices) on top
of the existing suite's cost — expect the ranges suite to grow by roughly
that factor in release mode.

## 8. Coordinator commands (on a host, from the tree root)

```bash
cd engine
cargo build --release -p plo-solve --bin build-ranges
cargo test  --release -p plo-solve --test ranges_validation
cd ..
./engine/target/release/build-ranges --data-dir data/preflop            # generate (44 sets) + print cross-check
./engine/target/release/build-ranges --data-dir data/preflop --check    # validate emitted files + cross-check
# v1 byte-identity spot-check (expect config_hash lines only):
git diff data/preflop/sets/constructed-v1-6max-btn-rfi.json data/preflop/sets/constructed-v1-6max-bb-vs-btn.json
```

Emitted set ids for the catalog regeneration:

- `constructed-v1.1-6max-btn-vs-bb-3bet`
- `constructed-v1.1-6max-btn-vs-sb-3bet`
- `constructed-v1.1-6max-co-vs-btn-3bet`

## 9. Known downstream gap (NOT part of this lane)

The solver API's set-expansion currently loads `vs_rfi` sets by their
**call** slice only. Loading a 3-bet pot needs asymmetric expansion: one
side from a `vs_rfi` set's **three_bet** slice (the three-bettor) and the
other side from a `vs_three_bet` set's **call** slice (the opener who
called the 3-bet — the four_bet branch leads to a different, 4-bet pot).
That is an API follow-up ticket; until it lands, these sets serve the
catalog/preflop layer and any consumer that reads set files directly.
Relatedly, the four_bet slice of these sets describes the 4-bet branch
for completeness of the preflop tree; no 4-bet-pot continuation set
(facing a 4-bet) exists yet.

## 10. Deliberate simplifications

- One continuation target set for all three matchups (50% / 82% / 18%):
  with no published anchor, per-matchup differentiation would be invented
  precision. The config structure allows per-matchup overrides later if
  a defensible basis appears.
- The call slice does not apply v1's discounted-equity floor: eligibility
  is already restricted to opened classes, and the brief's construction
  ranks a single list into two bands. (The realisation discount is inside
  the ranking score instead — see §2.3.)
- Frequencies are conditional on opening (see §2.5); a consumer wanting
  the unconditional continuing range multiplies by the RFI set's raise
  frequencies — exactly what `opening_weighted_totals` does in reverse.
