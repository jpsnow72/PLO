# RETARGET-NOTES — Preflop v1.5: raked 6-max retarget to the GTO Wizard anchors

**Date:** 2026-11-21 · **Decision ticket:** #10 (Justin's decision, 2026-11-21 voice call)
**Build ticket:** #32 · **Base:** GitHub main `b3d494ec` · **Branch:** `retarget-v15`

## What this is

The 2026-11-20 GTO Wizard cross-check (PLO100 raked set, totals-level only — the
standing boundary: totals as cross-check targets, never combo data) found our
constructed raked 6-max totals within ~1pp of the raked solution everywhere
**except three totals**. Justin decided to retarget those three to the GTO
Wizard raked anchors. This ship does exactly that — a new config version, no
new family, no machinery change.

All ranges remain **CONSTRUCTED** (amber badge, provenance shown). Nothing
about this retarget makes them solver output; it changes which published
totals the construction is fitted to.

## The three retargeted totals

| Set | Field | v1–v1.4 | v1.5 | Source of the new number |
|---|---|---|---|---|
| `constructed-v1-6max-btn-rfi` | RFI target | 0.49 (band 0.48–0.50) | **0.426** (band 0.416–0.436) | GTO Wizard Cash 6-max Classic, PLO100 (5%/2bb cap), BTN RFI total, collected 2026-11-17 |
| `constructed-v1-6max-bb-vs-utg` | call | 0.163 | **0.242** | GTO Wizard PLO100 raked, BB vs UTG call total, collected 2026-11-17 |
| `constructed-v1-6max-bb-vs-btn` | call | 0.30 | **0.322** | GTO Wizard PLO100 raked, BB vs BTN call total, collected 2026-11-17 |

Why these were wrong: the BTN target had been set to the band that matches
the **no-rake** anchor (48.9) although the raked family describes a raked
game — rake costs the button ~6pp of opens. The BB call widths were anchored
on PLO.com totals and ran ~8pp (vs UTG) tighter than the raked solution.

The band convention for the new BTN target is anchor ±1pp, the same
convention the deep200 anchors use (the old ±1pp-around-49 band shape is
preserved, just re-centred).

## What deliberately did NOT change

- **Three-bet targets.** BB vs UTG 3-bet 0.043 already equals the GTO Wizard
  raked total (4.3) exactly; BB vs BTN 0.09 vs their 10.1 sits inside the
  3pp defense cross-check tolerance. Moving them was not part of the
  decision.
- **The remaining GTO Wizard raked deltas**, recorded in the config's
  `_comment_gtw_raked` and left for a future decision, not silent edits:
  BB vs CO call 0.21 vs 28.0 · BB vs HJ (MP) call 0.187 vs 25.4 ·
  BB vs SB open call 0.32 vs 62.4 · SB vs BTN call 0.045 vs 5.3.
- **Every other family.** 9-max, no-rake 6-max, both 8-max variants, and
  deep200 carry their v1.4 targets verbatim (proof below).

## Config mechanics

`data/preflop/ranges-config-v1.5.json` was produced from v1.4 by a scripted
edit and verified by a deep diff of the two parsed configs: **exactly 10
differences** — the three target values, the BTN band, the `version` string,
and five comment fields (the appended `_comment` v1.5 paragraph, the
resolution appended to `_comment_gtw_raked`, the corrected BTN figure in
`_comment_rfi_targets`, the BB-vs-BTN anchor-source clause in
`_comment_response_targets`, and the new `_comment_retarget_v15`). The file
round-trips byte-exactly under `json.dumps(indent=1, ensure_ascii=False)`
with authored key order, the same formatting as v1.2–v1.4.

`build-ranges` now defaults to the v1.5 config (bin doc comment, `--help`
text, and the default path — the only three places the pointer lived,
mirroring the v1.4 ship). Prior configs are untouched and remain readable
via `--config` for historical reproduction.

## Derivation-coupling check (the v1.3 warning)

The brief's concern: 8-max targets were *derived from* 6-max targets, so
could editing the 6-max numbers move 8-max/9-max/deep200 outputs at
generation time? **No — verified in the generator source**
(`engine/crates/plo-solve/src/ranges.rs`):

- Every family parses its **own literal target maps** from the config:
  `RangesConfig.rfi_targets` / `response_targets` carry separate `6max`
  and `9max` maps; `NoRakeConfig`, `EightMaxVariant` (×2), and
  `Deep200Config` each hold their own `rfi_targets` / `response_targets`.
- `generate()` and `build_eightmax_variant()` read only the family-local
  maps. The seat-mapping derivations were applied **at authoring time**
  (v1.3/v1.4) and frozen into the file as numbers; no code path recomputes
  one family's targets from another's.
- The v1.5 test `v15_config_retargets_raked_6max_to_gtw_anchors` asserts
  this at the config level exhaustively: every target, weight, seed,
  sample count, and continuation parameter outside the three retargeted
  entries is identical between the parsed v1.4 and v1.5 configs.

So no pinning was necessary: leaving the other sections byte-identical
provably leaves their generation inputs identical.

## Dependency closure — which sets' `hands` change, and why

Within the raked 6-max family, sets are **not** independent: `generate()`
builds response sets against the opener's same-run RFI document
(equity-vs-opener pool), and continuation sets against the opener's RFI
document plus the three-bettor's `three_bet` slice. The retarget's blast
radius is therefore exactly **6 of the 132 sets**:

| Set | Why it changes |
|---|---|
| `constructed-v1-6max-btn-rfi` | Targeted (0.49 → 0.426) |
| `constructed-v1-6max-bb-vs-utg` | Targeted (call 0.163 → 0.242) |
| `constructed-v1-6max-bb-vs-btn` | Targeted (call 0.30 → 0.322) + opener changed |
| `constructed-v1-6max-sb-vs-btn` | Knock-on: built against BTN's narrowed range (own targets unchanged — the v1.5 tests assert it still lands on them) |
| `constructed-v1.1-6max-btn-vs-bb-3bet` | Knock-on: continuer range (BTN) + 3-bettor slice (BB vs BTN) both changed |
| `constructed-v1.1-6max-btn-vs-sb-3bet` | Knock-on: continuer range (BTN) + 3-bettor slice (SB vs BTN) both changed |

Every other set — the rest of the raked 6-max family (including
`constructed-v1.1-6max-co-vs-btn-3bet`: CO's range and BTN-vs-CO are both
unchanged), all 9-max, no-rake, 8-max, and deep200 sets — must regenerate
with `hands` **byte-identical** to the committed files. Their full documents
will differ only in `provenance.config_version` / `config_hash`, which is
why the guard hashes `hands`, not whole files. `class-table.json` is
target-independent and must also regenerate byte-identically.

## Set-id decision: ids stay stable

Retargeted sets keep their existing ids (`constructed-v1-6max-…`,
`constructed-v1.1-6max-…`). Rationale:

- **Ids name the family, not the generating config** — code constants in
  `RangesConfig::raked_family()` (`constructed-v1-{table}`), unchanged
  since v1. The raked sets have kept `v1` ids through configs v1.2, v1.3,
  and v1.4; only *new families* ever received new prefixes.
- **Consumers key on ids**: `data/preflop/index.json`, the API, the UI,
  the library spot catalog (which references range-set ids), and the
  runner queue. Renaming would break all of them for zero information
  gain.
- The config that produced a set is already recorded **inside** each set
  document (`provenance.config_version` + `config_hash`), which is where
  the v1.5 provenance lives. The v1.5 build test asserts the retargeted
  BTN set emits `config_version: ranges-config-v1.5` under its stable id.

## Sentinel classes — expectations (report-only; measured at the gate)

The 2026-11-20 sentinel verification (12 classes × UTG RFI / BTN RFI /
BB vs BTN, ours vs GTO Wizard raked) found five shape differences. This
retarget changes **totals, not the selection ranking** (score = equity +
playability blend, 3-bet slice takes the top band first, call takes the
next band down to its target). Honest expectations:

- **9876ds, A765ds, AAJ7-rainbow (BB defense: theirs ~100% 3-bet, ours
  call)** — *not expected to move.* The disagreement is which band the
  ranking puts them in; the 3-bet targets and the ranking are untouched.
  The widened BB call bands (notably vs UTG, +7.9pp) only extend the call
  band further down the same ranking.
- **QQQ5 (BB vs BTN: theirs fold 100%, ours call 75 / fold 25)** — *not
  expected to flip; may drift further toward call.* Widening the BB vs
  BTN call target by +2.2pp pulls the call/fold boundary down the
  ranking; a mid-ranked class already mostly calling is likelier to gain
  call share than to start folding. GTW folds this class while calling
  wider in aggregate — a class-selection difference, not a totals
  difference, and totals are all this retarget changes.
- **KQJ9ss (UTG RFI: theirs ~50/50 mix, ours raise 89 / fold 11)** —
  *not expected to move.* UTG's target is unchanged, and the mix shape
  at the boundary is a property of the ramp + residual correction, not
  of any retargeted number.

If the gate measurement contradicts any of these, that is a finding about
the construction's ranking, to be filed — not something to hand-tune here.
Per-class fixes were explicitly out of scope for this build.

## Gate procedure (coordinator, on the VPS)

Generation is CPU-heavy (~30 min on the VPS for prior versions). Run from
the composed gate tree at the repo root, Node 22 + cargo on PATH.

```bash
# 0. Snapshot the committed sets' hands hashes (the "before" state).
python3 - <<'PY'
import json, hashlib, glob, os
out = {}
for f in sorted(glob.glob('data/preflop/sets/*.json')):
    doc = json.load(open(f))
    h = json.dumps(doc['hands'], sort_keys=True, separators=(',', ':'))
    out[doc['id']] = hashlib.sha256(h.encode()).hexdigest()
json.dump(out, open('/tmp/hands-before.json', 'w'), indent=1)
print(len(out), 'sets snapshotted')
PY

# 1. Validation tests (19: 17 prior + 2 v1.5).
cargo test --release -p plo-solve --test ranges_validation

# 2. Generate with the default (v1.5) config, then --check.
cargo run --release -p plo-solve --bin build-ranges
cargo run --release -p plo-solve --bin build-ranges -- --check
#    Expect: --check green. In the cross-check output, the BTN RFI line
#    sits inside the new 41.6-43.6 band, and the three GTO Wizard
#    informational delta lines (BTN RFI, BB vs UTG call, BB vs BTN call)
#    print ~+0.00pp.

# 3. Hash guard: regenerate the snapshot and compare.
python3 - <<'PY'
import json, hashlib, glob
before = json.load(open('/tmp/hands-before.json'))
changed, same = [], 0
for f in sorted(glob.glob('data/preflop/sets/*.json')):
    doc = json.load(open(f))
    h = json.dumps(doc['hands'], sort_keys=True, separators=(',', ':'))
    digest = hashlib.sha256(h.encode()).hexdigest()
    if before.get(doc['id']) != digest:
        changed.append(doc['id'])
    else:
        same += 1
print('changed:', sorted(changed))
print('identical:', same)
PY
#    Expect changed == exactly the 6 closure sets listed above
#    (btn-rfi, bb-vs-utg, bb-vs-btn, sb-vs-btn, btn-vs-bb-3bet,
#    btn-vs-sb-3bet) and identical == 126. class-table.json must show
#    no git diff at all.

# 4. Achieved totals on the three retargeted sets (from --check output
#    or the set docs): BTN raise 42.6%, BB vs UTG call 24.2% /
#    three_bet 4.3%, BB vs BTN call 32.2% / three_bet 9.0%.

# 5. Sentinel measurement: for each of 9876ds, A765ds, AAJ7-rainbow,
#    QQQ5 (in the regenerated bb-vs-btn doc; 9876ds/A765ds also in
#    bb-vs-utg) and KQJ9ss (utg-rfi doc), find the class's canonical key
#    via class-table.json (rank multiset + suitedness), read its action
#    map, and compare against the 2026-11-20 baselines:
#    9876ds call 83/fold 17 · A765ds call 100 · AAJ7r call 100 ·
#    QQQ5 call 75/fold 25 · KQJ9ss raise 89/fold 11.
#    Record the readings on ticket #32 and in the Notion validation
#    page; expectations are in the section above — surprises are
#    findings, not tuning invitations.

# 6. Standard PLO gate for the data/API surface: API tests
#    (node --test api/*.test.mjs, glob form, built tree) + UI build.
#    Index must still list exactly 132 rangesets with unchanged ids.

# 7. Ship, then redeploy /root/plo-api/app (data lives in the app
#    checkout), restart plo-api.service, verify through the public URL:
#    /api/preflop/index = 132 sets; the BTN RFI set's totals read 42.6%.
#    Follow-up (separate step): refresh the Notion Starting Hands
#    raked tables to the retargeted numbers.
```

## Files changed

| File | Change |
|---|---|
| `data/preflop/ranges-config-v1.5.json` | NEW — v1.4 verbatim except the 10-point diff above |
| `engine/crates/plo-solve/src/bin/build-ranges.rs` | Default config pointer v1.4 → v1.5 (doc, help, path) |
| `engine/crates/plo-solve/src/ranges.rs` | Module doc: v1.5 retarget paragraph (no code change) |
| `engine/crates/plo-solve/tests/ranges_validation.rs` | `load_config_v15` + 2 tests (config guard, retargeted-set targets) + header doc |
| `data/preflop/README.md` | v1.5 section, Files-list entries (v1.4 + v1.5), canonical-config pointer → v1.5 |
| `RETARGET-NOTES.md` | This file |

Generated data (`sets/*.json`, `index.json`) is **not** in this lane's
commit — the coordinator regenerates at the gate and ships the regenerated
files with the merge, as with prior versions.
