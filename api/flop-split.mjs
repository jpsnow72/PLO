// Streaming splitter for finished flop solves (issue #57).
//
// A flop result is ONE JSON document of 5-9+ GB at library range caps
// (300 combos/side, the full turn/river subtree forest serialized as a
// flat "nodes" array). Reading it whole dies over Node's 2 GiB buffer
// limit, and no browser could load it either. This module scans the
// file ONCE with a string-aware brace-matching scanner and writes:
//
//   <id>.json                the header doc: every top-level field
//                            byte-verbatim, with the nodes array reduced
//                            to the flop-street nodes (turn_card null),
//                            plus "split": {"format": 1, "turn_cards":
//                            [cards in encounter order]}
//   <id>.turn-<Card>.json.br per turn card: brotli (quality 5) of
//                            {"turn_card": "<Card>", "nodes": [that
//                            card's node objects, byte-verbatim]}
//
// The scanner's assumptions about the serializer
// (engine/crates/plo-solve/src/json.rs, format_flop_solve_result_json):
// top-level scalar fields (board, starting_pot, effective_stack,
// iterations, locked/locks, exploitability, oop_evs, ip_evs) all precede
// the single "nodes" array, and every node is one JSON object in that
// array carrying a "turn_card" field (null on flop-street nodes). The
// scanner does NOT depend on field order inside a node (turn_card is
// located by regex on the buffered node text), on node size, or on the
// cards' encounter order. Memory stays bounded by the header prefix
// (scalars + combo EVs - kilobytes at real caps) plus ONE node object.
//
// Node built-ins only.

import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { once } from 'node:events';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import zlib from 'node:zlib';

const CARD_RE = /^[A-Za-z0-9]{2,3}$/;
const TURN_CARD_RE = /"turn_card"\s*:\s*(null|"(?:[^"\\]|\\.)*")/;

function writeChunk(stream, text) {
  return new Promise((resolve, reject) => {
    stream.write(text, (err) => (err ? reject(err) : resolve()));
  });
}

async function endStream(stream) {
  const finished = once(stream, 'finish');
  stream.end();
  await finished;
}

function numField(text, key) {
  const m = new RegExp(
    '"' + key + '"\\s*:\\s*(-?[0-9]+(?:\\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)',
  ).exec(text);
  return m ? Number(m[1]) : null;
}

function parseHeaderScalars(prefix) {
  const boardMatch = /"board"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(prefix);
  let board = null;
  if (boardMatch) {
    try {
      board = JSON.parse('"' + boardMatch[1] + '"');
    } catch {
      board = boardMatch[1];
    }
  }
  const lockedMatch = /"locked"\s*:\s*(true|false)/.exec(prefix);
  return {
    board,
    starting_pot: numField(prefix, 'starting_pot'),
    effective_stack: numField(prefix, 'effective_stack'),
    iterations: numField(prefix, 'iterations'),
    // The only nash_distance_pct in the header region is the
    // exploitability object's - it precedes the nodes array.
    nash_distance_pct: numField(prefix, 'nash_distance_pct'),
    locked: lockedMatch ? lockedMatch[1] === 'true' : false,
  };
}

/**
 * Split one flop result file into header + per-turn-card brotli parts.
 *
 * @param {string} resultPath  the engine's flop result JSON
 * @param {string} libraryDir  destination library directory
 * @param {string} id          solve id (file stem for all outputs)
 * @returns {Promise<object>} header scalars (nash_distance_pct,
 *   iterations, board, starting_pot, effective_stack, locked),
 *   node_count, and parts (turn cards in encounter order)
 */
export async function splitFlopResult(resultPath, libraryDir, id) {
  await fs.mkdir(libraryDir, { recursive: true });
  const headerPath = path.join(libraryDir, `${id}.json`);
  const headerStream = createWriteStream(headerPath);
  headerStream.on('error', () => undefined);
  const created = [headerPath];
  const partWriters = new Map();
  const parts = [];
  let nodeCount = 0;
  let flopCount = 0;
  let prefixText = '';

  async function routeNode(text) {
    nodeCount += 1;
    const m = TURN_CARD_RE.exec(text);
    let card = null;
    if (m && m[1] !== 'null') {
      try {
        card = JSON.parse(m[1]);
      } catch {
        card = null;
      }
    }
    if (card === null) {
      await writeChunk(headerStream, `${flopCount === 0 ? '\n' : ',\n'}${text}`);
      flopCount += 1;
      return;
    }
    if (typeof card !== 'string' || !CARD_RE.test(card)) {
      throw new Error(
        `splitFlopResult: invalid turn_card ${JSON.stringify(card)} in ${resultPath}`,
      );
    }
    let w = partWriters.get(card);
    if (!w) {
      const partPath = path.join(libraryDir, `${id}.turn-${card}.json.br`);
      created.push(partPath);
      const file = createWriteStream(partPath);
      file.on('error', () => undefined);
      const brotli = zlib.createBrotliCompress({
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
      });
      brotli.on('error', () => undefined);
      brotli.pipe(file);
      w = { brotli, file, count: 0 };
      partWriters.set(card, w);
      parts.push(card);
      await writeChunk(brotli, `{"turn_card": ${JSON.stringify(card)}, "nodes": [\n`);
    }
    await writeChunk(w.brotli, `${w.count === 0 ? '' : ',\n'}${text}`);
    w.count += 1;
  }

  // --- scanner state -------------------------------------------------------
  let phase = 'prefix'; // 'prefix' | 'nodes' | 'tail'
  let prefix = '';
  let depth = 0;
  let inStr = false;
  let esc = false;
  let strBuf = null; // content of the current depth-1 string, when tracked
  let lastKey = null; // last completed depth-1 string
  let nodesKeyPending = false;
  let nodeBuf = null; // current node object text, when inside one
  let nodeDepth = 0;
  let nodeInStr = false;
  let nodeEsc = false;

  async function feed(text) {
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (phase === 'prefix') {
        prefix += ch;
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') {
            inStr = false;
            if (depth === 1 && strBuf !== null) lastKey = strBuf;
            strBuf = null;
          } else if (strBuf !== null) strBuf += ch;
          continue;
        }
        if (ch === '"') {
          inStr = true;
          if (depth === 1) strBuf = '';
          continue;
        }
        if (ch === '{' || ch === '[') {
          if (ch === '[' && depth === 1 && nodesKeyPending) {
            prefixText = prefix;
            phase = 'nodes';
            await writeChunk(headerStream, prefix);
            prefix = '';
          }
          depth += 1;
          continue;
        }
        if (ch === '}' || ch === ']') {
          depth -= 1;
          continue;
        }
        if (ch === ':' && depth === 1 && lastKey === 'nodes') nodesKeyPending = true;
        continue;
      }
      if (phase === 'nodes') {
        if (nodeBuf !== null) {
          nodeBuf += ch;
          if (nodeInStr) {
            if (nodeEsc) nodeEsc = false;
            else if (ch === '\\') nodeEsc = true;
            else if (ch === '"') nodeInStr = false;
            continue;
          }
          if (ch === '"') {
            nodeInStr = true;
            continue;
          }
          if (ch === '{') nodeDepth += 1;
          else if (ch === '}') {
            nodeDepth -= 1;
            if (nodeDepth === 0) {
              const complete = nodeBuf;
              nodeBuf = null;
              await routeNode(complete);
            }
          }
          continue;
        }
        if (ch === '{') {
          nodeBuf = '{';
          nodeDepth = 1;
          nodeInStr = false;
          nodeEsc = false;
          continue;
        }
        if (ch === ']') phase = 'tail';
        continue; // commas / whitespace between nodes
      }
      // 'tail': the closing brace of the document - nothing to capture.
    }
  }

  try {
    const decoder = new StringDecoder('utf8');
    const input = createReadStream(resultPath, { highWaterMark: 1 << 20 });
    for await (const chunk of input) {
      await feed(decoder.write(chunk));
    }
    await feed(decoder.end());
    if (phase !== 'tail') {
      throw new Error(
        `splitFlopResult: no complete "nodes" array found in ${resultPath}`,
      );
    }
    for (const w of partWriters.values()) {
      await writeChunk(w.brotli, '\n]}\n');
      // Wait for the FILE stream's finish, not just the compressor's:
      // the pipe ends the file only once the brotli readable side has
      // fully drained, and 'finish' means every byte is flushed.
      const fileFinished = once(w.file, 'finish');
      w.brotli.end();
      await fileFinished;
    }
    await writeChunk(
      headerStream,
      `\n  ],\n  "split": {"format": 1, "turn_cards": ${JSON.stringify(parts)}}\n}\n`,
    );
    await endStream(headerStream);
  } catch (err) {
    headerStream.destroy();
    for (const w of partWriters.values()) {
      w.brotli.destroy();
      w.file.destroy();
    }
    await Promise.all(
      created.map((p) => fs.rm(p, { force: true }).catch(() => undefined)),
    );
    throw err;
  }

  const scalars = parseHeaderScalars(prefixText);
  return {
    nash_distance_pct: scalars.nash_distance_pct,
    iterations: scalars.iterations,
    board: scalars.board,
    starting_pot: scalars.starting_pot,
    effective_stack: scalars.effective_stack,
    locked: scalars.locked,
    node_count: nodeCount,
    parts,
  };
}
