# Library parity — rebrand slice 11 (issue #23)

The reference surface is GTO Wizard's Solution Library selector
(captures gtw2-f14/f83: search, stack-size list, rake profile, "48
solutions" count) plus its Custom Solutions list (gtw2-f15: name +
actions, search, one saved solve). Our equivalent is the Explore
landing page (SpotPicker): finished jobs publish into the same library
as catalog solves, so the two lists are one list here, told apart by a
Source chip and filter. The page previously grouped solves by board
texture family only, with no filters at all.

## What the data actually carries (verified before building)

- `GET /api/library` list item: id, name, kind (street), board,
  oop/ip_range_set, spot_id, nash_distance_pct, iterations, finished_at,
  size_bytes — plus, as of this slice, starting_pot, effective_stack
  and locked (see the API change below).
- `GET /api/catalog` entry (joined by spot_id): group, matchup,
  oop/ip_position, table_size, pot_type ('srp' | '3bet'), street, tier.
  This join is the ONLY source of setup fields; a custom solve has no
  catalog entry and therefore no pot type / setup / table size.
- The bundled sample is parsed locally; geometry + lock state come
  from its own payload.
- The 300-spot catalog itself is NOT listed on this page (it never
  was): planned/queued status lives on the Dashboard coverage panel
  and the Runner queue (gap analysis: HAVE). Nothing here invents a
  solved state for an unsolved catalog spot — a spot appears only
  once a finished solve exists in the library.

## API change (small, additive)

`listLibrary()` in api/server.mjs already parses every stored solve;
it now also returns `starting_pot`, `effective_stack` (both read off
the stored solve, null when absent) and `locked` (the solve payload's
own `locked: true`, or the job meta's flag). Without this, list rows
could not show geometry or badge nodelocked solves without fetching
every payload. api/README.md's route summary updated to match.

## Filters — have / added, each with its bound field

| Filter | Status | Binds to |
| --- | --- | --- |
| Search | ADDED | name, board, street, source + joined group / matchup / positions / table size / pot-type label (lib/library.ts `searchHaystack`) |
| Street (Flop/Turn/River chips, with counts) | ADDED | item `kind` |
| Board texture (the old grouping, now a filter) | ADDED | `boardFamilies(board)` — same vocabulary as before |
| Source (Library / Custom / Sample chips) | ADDED | spot_id resolves in the catalog → Library; library item without one → Custom; bundled → Sample |
| Pot type (SRP / 3-bet pot) | ADDED | catalog `pot_type` via spot_id join; custom/sample rows never match when set |
| Setup (e.g. "SRP BTN vs BB", "3-bet pots") | ADDED | catalog `group` via join; options built only from groups actually present |
| Table size (6max / 9max) | ADDED | catalog `table_size` via join; the control renders only when >1 size is present |
| Stack depth (SPR ≤ 2 / 2–5 / > 5) | ADDED | `effective_stack / starting_pot` from the solve itself (the reference's stack-size list is bb depths; ours is the geometry our solves store — SPR is the depth measure every solve carries) |
| Accuracy (Nash ≤ 0.1% / 0.1–0.3% / > 0.3% of pot) | ADDED | measured `nash_distance_pct`, banded by the Phase-0 bars (0.1% strict, 0.3% general). Bands describe the measured number; no tier is claimed for a finished solve |
| Nodelocked only | ADDED | `locked` from the solve payload (row also badged LOCKED, amber, and its Nash shown as plain text — never the green GTO badge) |
| Sort (Newest / Best accuracy / Name) | ADDED | `finished_at` desc / `nash_distance_pct` asc / name; undated and unmeasured rows sort last, never first |
| Result count + Clear all | ADDED | "X of Y shown" in the rail header; clear resets to DEFAULT_LIBRARY_FILTERS |

Filters combine (AND). A set filter never matches a row lacking its
field — unknown is not treated as a value. The catalog fetch is
best-effort: if it fails, rows stay listed and the setup filters
simply have no options.

## List rows

Graphical board (CardRow, mono fallback), solve name, subline
(Street · Pot/Stack/SPR where stored · catalog group + matchup where
joined · finished date), Source chip, LOCKED chip where applicable,
and the certification AccuracyBadge at the right (our differentiator,
kept prominent) — or the measured Nash as plain text on locked rows,
or "No Nash measurement" when the list carries none. Rows open in the
Explorer exactly as before. Empty states stay honest: nothing solved
yet points at the Dashboard coverage panel and the Solver; a filter
combination that matches nothing says so and offers Clear all.

## Omitted — captured in the reference, deliberately not built

- **Rake filter (PLO100 etc.)** — our solves carry no rake field; the
  engine solves no-rake (rake is the V2 engine ticket). No dead control.
- **Cash/MTT selector, player-count (HU/6/7/8-max) variants,
  Classic/Ante/Straddle, limps** — our game is HU pots at 6/9-max
  tables; MTT, ante, straddle and limped pots exist nowhere in our
  metadata. Table size (the one axis that does exist) is covered.
- **Rename / Edit on custom solutions (f15)** — no API endpoint can
  rename a library entry, and a library entry does not retain the
  spot JSON that produced it, so "reopen the setup" has nothing to
  reopen. Both need API tickets (a rename endpoint; retaining the
  originating spot in the library meta). Not faked with local-only
  state.
- **Status filter (planned / queued / solved)** — vacuous over this
  list (everything listed is solved by construction). Per-spot status
  already lives where the catalog is listed: Dashboard coverage and
  the Runner queue.
- **DRAFT as a separate badge/filter** — finished solves are not
  tier-labelled in our data; the measured Nash is shown on every row
  and the accuracy filter's top band (>0.3%) is exactly "missed the
  general bar", without inventing a DRAFT state the payload lacks.
