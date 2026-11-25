# Split flop storage — API half (issue #57, items 1–4)

## Why

A finished flop solve is one JSON document of 5–9+ GB (300 combos/side;
the whole turn/river subtree forest serialized as a flat `nodes`
array). The settle path read it whole and died over Node's 2 GiB buffer
limit — Vultr job 457c60e8's certified result (Nash 0.364127%,
2,000 iterations) could not be ingested at all. Turns (~180 MB) were
unaffected. This change makes flop solves ingestible, storable and
servable at any size by splitting them at settle time. The UI half
(lazy subtree loading in the Explorer) is a separate lane building to
the same contract.

## The split format

`api/flop-split.mjs` — `splitFlopResult(resultPath, libraryDir, id)`:

- `<id>.json` — the **header doc**: every top-level field of the engine
  result byte-verbatim (board, starting_pot, effective_stack,
  iterations, locked/locks, exploitability, oop_evs, ip_evs), with the
  `nodes` array reduced to the flop-street nodes only (node objects
  byte-verbatim), plus a top-level
  `"split": {"format": 1, "turn_cards": [<cards in encounter order>]}`.
  It parses as an ordinary solve doc.
- `<id>.turn-<Card>.json.br` — per turn card, brotli quality 5 of
  `{"turn_card": "<Card>", "nodes": [<that card's node objects,
  byte-verbatim>]}`. An uncompressed `<id>.turn-<Card>.json` twin form
  is recognised on every read path (fixtures use it).
- Returns `{nash_distance_pct, iterations, board, starting_pot,
  effective_stack, locked, node_count, parts}` parsed from the header
  fields (all precede the nodes array).

### The scanner

One pass over `fs.createReadStream` (1 MiB chunks, StringDecoder for
UTF-8 boundaries). Two phases:

1. **Prefix**: chars accumulate verbatim while a string/depth state
   machine watches for the `"nodes"` key at depth 1 followed by `[`.
   Everything through that `[` is flushed to the header file and also
   kept as text for scalar extraction (regexes for board / numbers /
   locked; the only `nash_distance_pct` in this region is the
   exploitability object's).
2. **Nodes**: at array level, each `{` opens a node buffer; a
   string-aware brace counter finds its end. One node is buffered at a
   time — never the file. The buffered node's `turn_card` is located
   by a bounded regex over the node text (any field position), parsed
   as JSON: `null` → flop street → streamed into the header; a card →
   streamed into that card's brotli writer (created lazily, cards
   recorded in encounter order).

Assumptions about the serializer (`engine/.../json.rs`,
`format_flop_solve_result_json`) and why they hold: top-level scalars
all precede the single `nodes` array (the formatter emits them first,
in fixed order); every array element is one object carrying
`turn_card` (the formatter's node writer always emits it); card strings
are 2–3 alphanumerics (`format_cards`). Nothing depends on node field
order, node size, or card order. A flop with zero subtree nodes yields
`parts: []` and a header with all its nodes.

Memory bound: the header prefix (kilobytes at real caps) + one node
object + stream buffers. Throughput is char-loop bound; the gate's
real-fixture run (below) is the measurement that matters.

## Settle integration (server.mjs `runJob`)

When the finishing job's kind is `flop` (job record kind, derived from
the board at submit; fallback: the spot's `street === 'flop'`), settle
runs the splitter instead of the whole-file read:

- header + parts written into `DATA_DIR/library`;
- `<id>.meta.json` mirrors the turn/river sidecar fields (name, kind,
  street, board, range sets, spot_id, range_expansion, locked,
  starting_pot, effective_stack, nash_distance_pct, iterations,
  finished_at — the #55 set) plus `"split": true` and
  `"split_parts_present": <number of parts>`;
- the raw `jobs/<id>/result.json` is deleted after a successful split;
- job.nash_distance_pct / iterations come from the splitter's return.

The turn/river branch is the historical code, behaviorally unchanged
(it sits in the `else` of the flop branch). One adjacent change, forced
by parts living in the library dir: `listLibrary`'s file filter now
also excludes `<id>.turn-<Card>.json` so uncompressed parts never list
as entries (the `.json.br` form never matched). No existing test files
were modified.

## Serving

- `GET /api/solves/:id/turn/:card` — streams the part as
  `application/json`, brotli-decompressing the stored `.json.br` on the
  fly, or streaming an uncompressed `.json` part as-is. Unknown id or
  card → 404 `{"error": ...}`.
- The header doc needs no new route: it is the library file
  `<id>.json`, served by the existing `GET /api/library/:id`.
  (Note for the UI lane: `GET /api/solves/:id` remains the *job
  record*; the header doc lives on the library route.)

## Upload protocol (uploader.mjs `attemptSplitUpload`)

`attemptItemUpload` branches on the local meta's `split: true` (the
raw job result no longer exists by then):

1. Header via the existing `POST /api/library/ingest` (`attemptUpload`
   unchanged). Central's ingest accepts a result carrying `"split"`
   and stores it + its meta without expecting subtrees; the sidecar
   gains `split: true` and `split_parts_present` initialised from the
   parts already on central's disk.
2. Each part via `PUT /api/solves/<spot.id>/parts/<card>` [admin] with
   the stored bytes as the body and `x-part-encoding: brotli` (or
   `identity` for an uncompressed part). Central stores the bytes
   as-is (streamed to a temp file, size-capped at INGEST_MAX_BYTES,
   renamed into place), updates the sidecar's `split_parts_present`,
   and responds `{id, card, parts: [<all cards central holds>],
   split_parts_present}`.
3. The uploader records the acknowledged list in the local meta as
   `split_uploaded_parts` after every PUT and sends only unacknowledged
   parts on each attempt — an interrupted upload resumes where it
   stopped; a fully uploaded entry re-sends nothing.

Failure modes:

- **Partial upload** (crash/network between parts): acknowledged parts
  are in the local meta; the queue's retry loop re-runs the upload and
  only the missing parts go over the wire.
- **Older central** (no parts route → 404 on the first PUT): the
  uploader logs a warning, returns a retryable failure naming the
  missing route, and keeps every part locally. No crash, no data loss;
  the header is already central, the parts follow once central upgrades.
- **Split failure at settle** (malformed result): partial outputs are
  removed, the job lands in `error` like any other unreadable result,
  and the raw result file is left in place for diagnosis.
- **Part PUT for an unknown id** (no header ingested yet): 404, so a
  runner can never create orphan parts.

## Tests (api/flop-split.test.mjs)

Splitter round-trip on a serializer-shaped synthetic doc (byte-verbatim
node checks, encounter-order cards, a node with `turn_card` out of
position, river nodes inside subtrees); zero-subtree flop; a ~45 MB
doc through the streaming path; queue settle of a catalog flop entry
with a fake engine (header + parts + split meta on disk, raw result
deleted, job record carrying the doc's Nash/iterations); part serving
+ 404s + library-list hygiene; upload resume (hold back one part →
first run sends one, second run sends only the missing one, third run
sends nothing; `split_parts_present` 1 → 2); older-central 404.

## Gate checklist

- [ ] `node --test api/*.test.mjs` (glob form) — whole suite green,
      including the untouched #48/#53/#55 suites.
- [ ] **Real-fixture ingest**: copy Vultr job 457c60e8's result
      (9,198,447,098 bytes) to a scratch server host, run a scratch
      instance (QUEUE off is fine — call the splitter through a scratch
      queue job or a one-off import), and verify: header doc +
      **49 parts**; header parses and carries board `Ts 9h 8d`;
      meta `nash_distance_pct` **0.364127**, `iterations` **2000**;
      reassembly equality — the header's nodes plus every part's nodes
      equal the original document's node set (compare per-node hashes
      streamed from the original, never loading it whole); wall time
      and peak RSS of the split recorded (the char-loop is the suspect
      if either is ugly).
- [ ] Round-trip one part through `GET /api/solves/:id/turn/:card` on
      the scratch instance and byte-compare against the corresponding
      slice of the original.
- [ ] Upload the split fixture to a second scratch instance as central:
      header ingest + 49 PUTs, kill the uploader mid-way, re-run, and
      confirm only the missing parts are sent and
      `split_parts_present` reaches 49.
- [ ] Confirm a turn and a river queue job still settle byte-identical
      library files (the non-flop branch is untouched code, but prove
      it), and that GET /api/library lists the split entry once with
      the header's size.
