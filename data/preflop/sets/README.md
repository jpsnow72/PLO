# Generated constructed range sets

This directory is populated by `build-ranges` (engine `plo-solve` crate),
method `constructed-equity-v1`. One JSON file per set, named by the set's
`id`:

- `constructed-v1-<table>-<position>-rfi.json` — raise-first-in sets
  (SB's first-in set uses the `sb_play` context and an `-sbplay` suffix)
- `constructed-v1-<table>-<responder>-vs-<opener>.json` — response sets
  (`vs_rfi` context: fold / call / three_bet)

Do not hand-edit these files: change `../ranges-config-v1.json` and
regenerate. See `RANGES-NOTES.md` at the repository root and
`../README.md` for the constructed-sets rules.
