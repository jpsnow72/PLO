# Deep200 engine support — `deep200_6max` family (PLO issue #28, lane notes)

Branch `deep200-engine`, base `a267b80` (current main). Build-only lane:
nothing was compiled, generated, or run on this VM (no cargo/npm/generator
execution here by rule). The coordinator generates and gates on the VPS.
Implements the "Engine" open-items list in `PREFLOP-200BB-NOTES.md`.

## What changed

| File | Change |
|---|---|
| `engine/crates/plo-solve/src/ranges.rs` | `Deep200Config` + `deep200_6max` parser, `deep200_family()`, per-family `stack_bb` (see below), seed-tag bases 1_700_000 / 1_900_000, deep generation stage in `generate()`, deep branches in `check_doc_totals`, deep lookup in `continuation_matchup`, v1.4 module-doc paragraph. |
| `engine/crates/plo-solve/src/bin/build-ranges.rs` | Default config bumped v1.3 → v1.4 (default path, `--help` text, header doc — with the standing hazard note preserved and updated: regenerating with an older config rewrites the index without the newer families). `constructed-v1.4-` added to the constructed-prefix lists in `write_index` (foreign-entry preservation) and `run_check` (which index entries get checked). |
| `engine/crates/plo-solve/tests/ranges_validation.rs` | `load_config_v14()` loader, deep continuations wired into `small_samples`, and two v1.4 tests: `v14_config_carries_deep200_family_with_gtw_200bb_anchors`, `deep200_sets_hit_targets_and_validate`. |
| `DEEP200-ENGINE-NOTES.md` | This file. |

No config, data, UI, or schema file was modified. No existing family's
code path changes behaviour (see "Byte-identity" below).

## The deep family (ranges.rs)

- Parser mirrors `norake_6max` exactly: `cross_check_source`, `rake_note`,
  `rfi_targets` (validated as 6-max non-BB seats, band of 2), and
  `response_targets`, plus the section's own `stack_bb` (required, must be
  in (0, 1000] — the config carries 200). Continuations parse through the
  shared `parse_continuations_section` with prefix
  `constructed-v1.4-6max-deep200`, so the emitted continuation ids are
  `constructed-v1.4-6max-deep200-<continuer>-vs-<tb>-3bet`.
- `deep200_family()` follows the `norake_family()` precedent: rake
  `no-rake`, the section's rake note, ID prefix
  `constructed-v1.4-6max-deep200`, sources = the section's GTO Wizard
  200bb cEV source with `top_source: true` (the top-level `source` block
  is emitted, like the no-rake 6-max family), no derivation.
- Provenance/labelling is inherited from the machinery, unchanged: sets
  are CONSTRUCTED (never GTO), each set's `target_kind` comes from the
  config target's `kind` — `anchor` for the five RFI sets and BB vs BTN,
  `interpolated` for the other ten responses, `internal` for the three
  continuations — and the config's provenance fields (source, rake note)
  ride through the family spec exactly as `norake_6max`'s do.
- Seed tags (confirmed against the in-use ranges in
  PREFLOP-200BB-NOTES: raked < ~111k, 8-max opener 300k, no-rake opener
  500k, no-rake continuation 700k, continuation 900k, 8-max continuation
  1.1M, 8-max no-rake opener 1.3M, 8-max no-rake continuation 1.5M — the
  next clear slots by the established +200k spacing):
  `SEED_TAG_DEEP200_OPENER_BASE = 1_700_000`,
  `SEED_TAG_DEEP200_CONTINUATION_BASE = 1_900_000`.
- Generation stage in `generate()` mirrors the no-rake stage stage-for-
  stage (RFI for every non-BB seat → responses for BB / SB / BTN with one
  seeded equity pass per opener, BTN openers from the config's 6-max
  `btn_vs` list → continuations), with its own pools and passes — no
  equity pass is shared with any other family. It produces exactly the
  family's 19 sets: 5 RFI + 11 responses + 3 continuations.
- `--check` handling: `check_doc_totals` recognises deep sets by their
  `constructed-v1.4-6max-deep200` id prefix (they share table `6max` and
  rake `no-rake` with the v1.2 family, so the prefix is the
  discriminator) and checks them against the `deep200_6max` targets. The
  existing kind-driven logic then does the right thing with no further
  special-casing: RFI sets (all `anchor`) must land inside their bands,
  the anchored BB vs BTN defense must land within
  `cross_check_defense_tolerance` (±3pp), and `interpolated` responses
  are reported as deltas only. Continuations resolve through
  `continuation_matchup`, which now also searches the deep section, and
  check against the internal targets as usual. The Upswing / GTW-raked
  informational lines stay gated on the raked 6-max family, so deep sets
  never pick them up.

## How per-family stack emission works

Structural, family-driven — one new field threaded through three places:

1. `FamilySpec.stack_bb` is the single source. Every pre-existing family
   constructor (`raked_family` both branches, `norake_family`,
   `eightmax_raked_family`, `eightmax_norake_family`) sets it from the
   config's top-level `stack_bb` (100); `deep200_family()` sets it from
   its section's `stack_bb` (200).
2. `RangeSetDoc.stack_bb` is copied from `family.stack_bb` in the three
   styled builders (`build_rfi_set_styled`, `build_response_set_styled`,
   `build_continuation_set_styled`) — the only three places a
   `RangeSetDoc` is constructed in the codebase.
3. Both emitters read the document, not the config:
   `RangeSetDoc::to_json` writes `"stack_bb": <doc.stack_bb>` and
   `index_entry_json` writes the same. There is no remaining
   `cfg.stack_bb` emission site.

## Byte-identity of the existing 113 sets

The hard constraint holds by construction:

- Existing families' `FamilySpec`s carry `stack_bb = cfg.stack_bb` (100),
  so their documents and index entries emit the identical `stack_bb`
  value from the identical formatting path (`fmt_num`) — the emitted
  bytes are unchanged, only the value's source moved from config to doc.
- The deep stage runs only when the `deep200_6max` section is present,
  appends only new sets (ids under a new prefix), and `generate()` sorts
  all sets by id at the end, as before. No existing target, seed tag,
  pool, or builder input is touched; the new seed bases sit in previously
  unused ranges.
- The v1.4 config itself was already in the tree (data lane); its
  `_comment` records that the v1/v1.2/v1.3 fields are unchanged, so the
  recorded config version/hash in provenance is the only intended
  difference when regenerating under v1.4 — same as every prior version
  bump. (Per-set `hands` hashes, the coordinator's check, exclude
  provenance by construction.)

## Judgement calls

- **Deep-set recognition in `check_doc_totals` is by id prefix**, not by
  a new parameter: the function's signature is shared by both callers
  (`cross_check` in-memory and `run_check` on emitted files), and the
  emitted/check paths both have the id in hand. A `stack_bb`-based
  branch was rejected — stack is a value the check should be verifying,
  not trusting as its own selector.
- **The deep stage sits between the no-rake and 8-max stages** in
  `generate()`; order is immaterial (final sort by id) but keeps the
  6-max families together.
- **Test tolerance**: the brief's ±1pp is the anchor band (asserted
  exactly in the config test: UTG/MP/CO/BTN bands are target ±1pp); the
  sets test asserts achieved totals within the family's standing 0.5pp
  construction-fit tolerance of the anchors (UTG 16.9 / MP 21.7 /
  CO 29.9 / BTN 48.6; BB vs BTN 3-bet 10.2 / call 43.8), matching the
  v1.2 test precedent.
- The sets test also pins the byte-identity mechanism: a no-rake set
  built under the v1.4 config must emit `stack_bb` 100 in both its
  document and its index entry, while deep sets emit 200 in both.

## Coordinator verification (on the VPS)

From the repo root of the ship tree, with the engine built in release
mode (paths as in the existing gate scripts):

```sh
# 1. Snapshot the pre-change hands hashes of the 113 existing sets
#    (run against the CURRENT data/preflop before regenerating):
python3 - <<'EOF'
import json, hashlib, pathlib
for p in sorted(pathlib.Path("data/preflop/sets").glob("*.json")):
    doc = json.loads(p.read_text())
    h = hashlib.sha256(json.dumps(doc["hands"], sort_keys=True).encode()).hexdigest()
    print(p.stem, h)
EOF
#    -> save as /tmp/hands-hashes-before.txt

# 2. Generate with the v1.4 config (now the default) and run --check:
cargo run --release -p plo-solve --bin build-ranges
cargo run --release -p plo-solve --bin build-ranges -- --check
#    --check must exit 0: deep anchors inside band/tolerance,
#    interpolated deep responses reported as deltas only.

# 3. Count: the index must hold exactly 132 entries
#    (113 existing + 19 deep), 19 of them deep200:
python3 -c "
import json
idx = json.load(open('data/preflop/index.json'))['rangesets']
print(len(idx))
print(sum(1 for e in idx if e['id'].startswith('constructed-v1.4-6max-deep200')))
print(sorted({e['stack_bb'] for e in idx}))  # expect [100, 200]
"

# 4. Hash-compare: every pre-existing set's hands must be byte-identical
#    to the step-1 snapshot (same python snippet, diff the outputs).

# 5. Validation suite:
cargo test --release -p plo-solve --test ranges_validation
#    (includes the two new v1.4 tests; all prior tests must pass
#    unchanged)
```
