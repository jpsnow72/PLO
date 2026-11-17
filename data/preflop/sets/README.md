# Generated constructed range sets

This directory is populated by `build-ranges` (engine `plo-solve` crate),
methods `constructed-equity-v1` and `constructed-equity-v1.1`. One JSON
file per set, named by the set's `id`:

- `constructed-v1-<table>-<position>-rfi.json` — raise-first-in sets
  (SB's first-in set uses the `sb_play` context and an `-sbplay` suffix)
- `constructed-v1-<table>-<responder>-vs-<opener>.json` — response sets
  (`vs_rfi` context: fold / call / three_bet)
- `constructed-v1.1-6max-<continuer>-vs-<three-bettor>-3bet.json` —
  continuation sets (`vs_three_bet` context: fold / call / four_bet), the
  opener's range after facing a 3-bet; internal construction targets, see
  `RANGES-V11-NOTES.md` at the repository root
- `constructed-v1.2-6max-norake-<position>-rfi.json`,
  `constructed-v1.2-6max-norake-<responder>-vs-<opener>.json` and
  `constructed-v1.2-6max-norake-<continuer>-vs-<three-bettor>-3bet.json` —
  the v1.2 NO-RAKE 6-max family (same three shapes; every document
  records `rake: "no-rake"` and cites the GTO Wizard cEV totals as its
  cross-check source; the raked files above record `rake: "raked"`)

Do not hand-edit these files: change `../ranges-config-v1.2.json` (the
canonical config; `../ranges-config-v1.json` is the historical raked-only
config) and regenerate. See `RANGES-NOTES.md` at the repository root and
`../README.md` for the constructed-sets rules.
