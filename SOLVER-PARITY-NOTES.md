# SOLVER-PARITY-NOTES — Solver setup parity (issue #21, rebrand slice 9)

Lane scope: bring the Solver setup to parity with the reference Custom
Solver dialog (captures gtw2-f39..f51) for everything our engine/API
genuinely accepts — verified against the contract, not assumed. Most of
the setup already existed (quick setups, board picker, per-street size
editors, PPT range paste all landed in earlier ships); this lane added
the four real gaps and verified the rest. MTT/ICM/payout (f48–f51) is
out of scope by design — this is a cash, heads-up-pot tool.

## Contract fields verified in source (before touching the form)

Engine — `engine/crates/plo-solve/src/json.rs`:

- `board`, `pot`, `stacks`, `oop_range` / `ip_range` (API also expands
  `oop_range_set` / `ip_range_set` server-side).
- River spots: `bet_sizes` / `raise_sizes` / `max_raises`. Turn/flop
  spots: `<street>_bet_sizes` / `<street>_raise_sizes` /
  `<street>_max_raises` per street, `include_all_in` plus per-street
  `<street>_include_all_in`.
- Both: `max_iterations`, `target_exploitability_pct` (numbers — the
  engine never sees tier names).
- `locks`: array of `{history (or node), player ("OOP"|"IP"),
  frequencies}` — `parse_locks` in json.rs; API shape-validates the
  same array in `api/server.mjs` (`locksFieldError`: ≤64 entries,
  frequencies 1..64 finite numbers ≥ 0 summing to 1).

Engine — `engine/crates/plo-solve/src/game.rs`, `TreeConfig` is exactly
`{bet_sizes, include_all_in_bet, raise_sizes, include_all_in_raise,
max_raises}`. There is **no** donk-size menu, **no** per-player (OOP/IP)
size menus, **no** force-max-legal threshold, **no** merging threshold.
Anything in the reference dialog that maps to those knobs has nothing
to bind to — omitted below, not faked.

Defaults verified against SIZING-NOTES.md (approved 2026-11-17):
`defaultWizardForm()` / `emptyStreetSizes()` already emit flop
[0.33, 0.75], turn [0.5, 1.0], river [0.5, 1.0], raises [1.0],
maxRaises 2, all-in on at every street. Unchanged by this lane.

## Per capture tab — have / added / omitted

### f39 General
- HAVE: board-first setup (their flow creates the tree, then picks the
  flop afterwards; ours sets the board up front — text input +
  CardPicker for 3/4/5 cards, street chips that follow the board,
  texture shortcuts, graphical preview), Pot and Effective Stack
  inputs, range entry per side.
- ADDED: live SPR readout under the money inputs (stacks ÷ pot) — the
  reference shows Pot and Effective Stack side by side; the ratio is
  the number you actually reason with, so the form derives it visibly.
- OMITTED: "Starting Spot: Preflop" — our engine solves postflop spots
  (flop/turn/river starts); a preflop start needs a preflop solver,
  which was presented in Nov 6 planning and not commissioned. Game
  Type MTT — out of scope (below).

### f40 Rake
- OMITTED (engine-blocked, already a V2 ticket): the engine has no
  rake at settlement, so there is no rake tab, no site presets, no
  No Flop/No Drop. The form keeps the pre-existing disabled Rake % /
  Rake cap fields badged V2, and the footnote now states the fact up
  front: "All solves currently run with no rake."

### f41 Bet Sizes — Flop
- HAVE: per-street editors — up to 3 bet sizes and 3 raise sizes per
  street picked from a preset palette (25/33/50/75/100/125/150% of
  pot), an Include all-in toggle, and a Max raises control (engine
  accepts per-street `max_raises`; default 2, as in the reference's
  Advanced tab).
- ADDED: "Copy flop sizes to turn & river" — their apply-flop-sizes
  toggle, as a one-click form action above the street editors (copies
  the whole street menu: sizes, raises, all-in, max raises).
- Note: their flop tab lists raise and re-raise as separate rows; our
  contract has one `raise_sizes` menu plus the max-raises count, which
  is what the editor exposes.

### f42 Advanced
- HAVE: max raises (per street, in the size editors).
- OMITTED: "force max legal at ≥60% stack commitment", "add max-legal
  option when stack ≤100%", "merging threshold 10%" — no TreeConfig
  fields exist for any of them (verified above). Our all-in toggle is
  the honest equivalent of the max-legal options: when it is on, the
  all-in bet/raise is in the menu whenever pot-limit rules make it
  legal.

### f43 Bet Sizes — Turn (incl. Donk) / f44 River
- HAVE: turn and river editors with the approved defaults (50% + pot,
  all-in on).
- OMITTED: Donk bet rows and separate OOP/IP size editors — the engine
  builds one size menu per street shared by both players; there is no
  donk-specific or per-player menu in the contract.

### f45 Edit Range (paste view)
- HAVE (ship 1, untouched): paste with live checking — plain combos
  with `:weight`, PPT format (`AsKsQsTh@100`) with @ as a weight
  percent; bad entries are flagged inline the moment they are typed,
  never silently dropped. Each side can instead load a constructed
  preflop set from our library (RFI → raise range, vs-RFI → call
  range, with the set's totals shown and a CONSTRUCTED badge).
- OMITTED: the paste view's Copy / Upload / Save buttons — Copy/Clear
  are browser trivialities the textarea already covers natively;
  Upload/Save belong to a saved-range store (see f46).

### f46 Range Library
- OMITTED (deferred, not faked): named saved ranges need API/storage
  work (the quiz-progress store is the pattern). This lane's brief was
  the setup form against the solve contract; inventing a local-only
  store would strand ranges in one browser. Today's substitute is the
  preflop-library set loading on each range field.

### f47 Quick Setup
- HAVE (ship 1, untouched): SRP / 3-bet / 4-bet cards loading
  constructed sets + pot/stack geometry, plus a Heads-up custom card
  that clears both sides to manual entry.
- OMITTED: Squeeze / Limp / Iso presets — multiway or limped-pot
  shapes, outside the heads-up v1 scope by design. Picking players by
  clicking nameplates — our spots are fixed OOP vs IP; the preset
  cards name the positions in their blurbs instead.

### f48–f51 MTT (General / ICM / Payout Structure / Tournament Stage)
- OUT OF SCOPE, deliberately: cash heads-up-pot tool (Justin's Nov 6
  scoping; the gap analysis's Do Not Copy list agrees). Nothing built,
  nothing badged as coming.

## Also in this lane

- **Accuracy fields (their dialog shows no solve-quality choice at
  all — ours differs by design and keeps its edge).** The tier radios
  (Fast 0.5% / Balanced 0.25% / Precise 0.1% of pot) stay, and the two
  numbers the contract actually takes are now editable fields:
  - *Target Nash distance (% of pot)* — prefilled from the tier
    preset; editing it sets a custom override (`targetPctOverride` in
    the form model), picking a tier radio clears back to the preset,
    and a "Back to the preset" reset appears while an override is set.
  - *Max iterations* — was already in the form model (default
    200,000) and emitted as `max_iterations`, but no input rendered
    it; it is now a field next to the target.
  - `buildSpot` now validates both (positive whole number of
    iterations; custom target finite, > 0, ≤ 5% of pot) — before this
    lane a NaN cap could have flowed into the spot JSON unchecked.
  - Copy keeps the honesty rule: a solve that misses its target is
    labelled DRAFT, never certified.
- **Node locks entry.** The contract accepts locks today (verified
  above), but the visual editor — pick a node in the Explorer, set its
  frequencies — is issue #9 and is not built. The form therefore gains
  a disabled "Node locks" fieldset that says exactly that: what locks
  are, that locked results are badged LOCKED (never GTO), that the
  editor is #9, and that until then locks can only be supplied in the
  spot JSON sent to the API. No lock UI was built here, and the wizard
  emits no `locks` key.
- **Live tree preview** (listed as missing in the gap analysis):
  omitted from this lane — it is not an engine/API contract item, and
  the geometry feedback it would give is covered by the board preview,
  street chips, and the new SPR readout. A real preview needs tree
  enumeration in the browser; noted here so the omission is a
  decision, not an oversight.

## Files changed

- `ui/src/lib/spot.ts` — `WizardForm.targetPctOverride` +
  `targetPctFor()`; `buildSpot` emits the effective target and
  validates `maxIterations` / the override; header comment records
  the locks seam.
- `ui/src/pages/Solver.tsx` — SPR readout; Target / Max iterations
  fields with preset-reset behaviour; Copy flop sizes button; Node
  locks disabled fieldset; rake footnote now leads with the no-rake
  fact. Quick setups, range fields, street editors, and the submit /
  job flow are untouched.
