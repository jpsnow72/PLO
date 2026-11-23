# Per-entry accuracy-target override (2026-11-23)

Supports Justin's 2026-11-23 decision: queued 100bb flops solve to
0.5% instead of 0.3%; the batch already running keeps its 0.3% target
(targets are baked into a job at submit time, so nothing about this
change touches a running solve).

## The rule

`translateCatalogEntry` (api/server.mjs) builds the engine spot's
`target_exploitability_pct` via the new `catalogTargetPct(entry)`:

1. If the catalog entry carries `target_exploitability_pct`, it wins.
2. Otherwise the historical tier rule applies, unchanged:
   balanced -> 0.3, precise -> 0.1.

Validation: the override must be a finite number greater than 0 and at
most 5. Anything else (zero, negative, over 5, NaN, a string, null)
throws an HttpError 422 naming the entry id, mirroring the not-ready
error style in the same function. In the queue this surfaces as the
item failing with that message before any range expansion or job
creation, so a catalog authoring error can never silently solve a
spot to a wrong target.

Nothing else changes: no engine changes, no UI changes, existing
tests untouched.

## The catalog data change

`data/library/spot-catalog.json` (the 100bb catalog, 300 entries):
all 86 entries whose id ends in `-flop` gained
`"target_exploitability_pct": 0.5` as their last key. No other field
of any entry changed (verified field-by-field against the pre-change
file). `data/library/spot-catalog-200bb.json` is untouched — the
200bb flops keep the tier rule.

`tools/build_spot_catalog.py` learned the field so the data survives
regeneration: `make_entry` emits it for 100bb flop entries (same key
position, after `status_reason`), and `verify_catalog` asserts its
presence/value on 100bb flops. Regenerating the 100bb catalog
reproduces the shipped file.

## Operational note

The binding constraint is the server code: a runner picks up
`catalogTargetPct` only when its server process restarts on the new
build, so the override activates per runner at its next restart,
with the refreshed catalog file staged in place. The catalog data
itself is not cached — `findCatalogEntry` re-reads CATALOG_PATH on
every queue-item start — so once a runner is on the new build, a
later catalog-file refresh lands on subsequently started items
without another restart. Running jobs are unaffected either way:
their targets were fixed when their spots were built. The
coordinator stages the refreshed server + catalog and restarts each
runner on the normal cadence; no emergency restart is warranted for
this change.

## Tests

`api/target-override.test.mjs` (new) boots the real server with
QUEUE_ENABLED=1 against a scratch catalog cloned from real entries,
with instant fake engines and QUEUE_SMOKE_MAX_ITERATIONS set:

- flop with the 0.5 override -> job records target 0.5
- flop without it (balanced) -> 0.3
- river without it (precise) -> 0.1
- overrides of -1 and "high" -> queue item failed, error names the
  entry and the field, and no job is created (jobs list holds exactly
  the three valid jobs)

## Gate must verify

- Full api suite: `node --test api/*.test.mjs` — all prior files pass
  unchanged, the new target-override file passes (5 queue items settle:
  3 done with targets 0.5 / 0.3 / 0.1, 2 failed with naming errors).
- UI build green (no UI files changed; confirm no accidental drift).
- Catalog integrity: `python3 tools/build_spot_catalog.py --verify`
  passes on the shipped 100bb catalog, and a regeneration to a temp
  --out reproduces `data/library/spot-catalog.json` byte-for-byte.
- The 200bb catalog file's hash is unchanged from main.
- Spot-check the diff: server.mjs changes are confined to
  `catalogTargetPct` + its call site + the doc comment; the catalog
  diff is exactly 86 added `target_exploitability_pct` lines (plus the
  trailing-comma adjustments on the preceding `status_reason` lines).
