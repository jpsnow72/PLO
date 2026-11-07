#!/usr/bin/env node
// import-csv.mjs — dependency-free converter from a simple CSV of
// hand,action,frequency rows into a validated preflop range-set JSON
// document (see rangeset.schema.json and README.md in this directory).
//
// The importer validates FORM only: card syntax, canonical hand keys,
// per-context actions, duplicate rows, frequency ranges and sums, and the
// document's required metadata. It does not (and cannot) verify that a
// chart is accurate or that its licence permits use — that check happens
// before a CSV for a source is prepared.

import fs from 'node:fs';

const RANK_VALUE = {
  2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14,
};
const CANONICAL_SUITS = ['s', 'h', 'd', 'c'];
const CONTEXT_ACTIONS = {
  rfi: ['fold', 'raise'],
  vs_rfi: ['fold', 'call', 'three_bet'],
  three_bet: ['fold', 'call', 'four_bet'],
  sb_play: ['fold', 'call', 'raise', 'three_bet'],
};
const ACTION_ORDER = ['fold', 'call', 'raise', 'three_bet', 'four_bet'];
const ACTION_ALIASES = {
  '3bet': 'three_bet',
  '3-bet': 'three_bet',
  '4bet': 'four_bet',
  '4-bet': 'four_bet',
  open: 'raise',
  open_raise: 'raise',
  'open-raise': 'raise',
};
const POSITIONS_BY_TABLE = {
  '6max': ['UTG', 'MP', 'CO', 'BTN', 'SB', 'BB'],
  '9max': ['UTG', 'UTG+1', 'UTG+2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'],
};
const SUM_TOLERANCE = 0.0005;

function fail(message) {
  throw new Error(message);
}

// ---------------------------------------------------------------------------
// CLI arguments
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set([
  'input', 'output', 'id', 'table-size', 'position', 'context', 'stack-bb',
  'rake-note', 'context-detail', 'notes',
  'source-name', 'source-url', 'source-licence', 'retrieved',
]);

function parseArgs(argv) {
  const opts = { force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node import-csv.mjs --input rows.csv --output <id>.json \\\n' +
          '  --id <slug> --table-size 6max|9max --position <POS> \\\n' +
          '  --context rfi|vs_rfi|three_bet|sb_play --stack-bb <n> \\\n' +
          '  --rake-note "<note>" --source-name "<name>" --source-url <url> \\\n' +
          '  --source-licence "<licence>" --retrieved YYYY-MM-DD [--force]',
      );
      process.exit(0);
    }
    if (arg === '--force') {
      opts.force = true;
      continue;
    }
    if (!arg.startsWith('--')) fail(`unexpected argument: ${arg}`);
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (!VALUE_FLAGS.has(name)) fail(`unknown option: --${name}`);
    let value = eq >= 0 ? arg.slice(eq + 1) : argv[i + 1];
    if (eq < 0) {
      if (value === undefined || value.startsWith('--')) fail(`missing value for --${name}`);
      i += 1;
    }
    opts[name] = value;
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Minimal CSV parser (quoted fields, escaped quotes, CRLF)
// ---------------------------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push({ fields: row, line: rowLine });
    row = [];
  };
  let i = 0;
  const src = text.replace(/^\uFEFF/, '');
  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      if (ch === '\n') line += 1;
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      line += 1;
      rowLine = line;
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (inQuotes) fail('CSV ends inside a quoted field');
  if (field.length > 0 || row.length > 0) endRow();
  return rows.filter((r) => r.fields.some((f) => f.trim() !== ''));
}

// ---------------------------------------------------------------------------
// Field validation (mirrors rangeset.schema.json)
// ---------------------------------------------------------------------------

function parseHand(raw, where) {
  const trimmed = raw.trim();
  const compact = trimmed.replace(/\s+/g, '');
  const tokens =
    trimmed.includes(' ') || trimmed.includes('\t')
      ? trimmed.split(/\s+/)
      : compact.length === 8
        ? compact.match(/.{2}/g) ?? []
        : [];
  if (tokens.length !== 4) {
    fail(
      `${where}: hand "${raw}" is not four cards. Use the canonical representative ` +
        'form, e.g. "As Ah Kd Qc" (source shorthand like "AAKKds" is not accepted).',
    );
  }
  const seen = new Set();
  const suitByFirstOccurrence = new Map();
  let previousRank = Infinity;
  for (const token of tokens) {
    if (!/^[AKQJT98765432][shdc]$/.test(token)) {
      fail(`${where}: invalid card "${token}" in hand "${raw}" (rank AKQJT98765432 + suit shdc)`);
    }
    if (seen.has(token)) fail(`${where}: duplicate card "${token}" in hand "${raw}"`);
    seen.add(token);
    const rank = RANK_VALUE[token[0]];
    if (rank > previousRank) {
      fail(`${where}: hand "${raw}" is not canonical: ranks must be in non-increasing order`);
    }
    previousRank = rank;
    const suit = token[1];
    if (!suitByFirstOccurrence.has(suit)) {
      suitByFirstOccurrence.set(suit, CANONICAL_SUITS[suitByFirstOccurrence.size]);
    }
    if (suitByFirstOccurrence.get(suit) !== suit) {
      fail(
        `${where}: hand "${raw}" is not canonical: suits must be relabelled by first ` +
          'occurrence (first distinct suit s, then h, d, c)',
      );
    }
  }
  return tokens.join(' ');
}

function parseFrequency(raw, where) {
  const trimmed = raw.trim();
  let value;
  if (trimmed.endsWith('%')) {
    value = Number(trimmed.slice(0, -1));
    if (!Number.isFinite(value)) fail(`${where}: invalid frequency "${raw}"`);
    value /= 100;
  } else {
    value = Number(trimmed);
    if (!Number.isFinite(value)) fail(`${where}: invalid frequency "${raw}"`);
    if (value > 1) {
      fail(
        `${where}: frequency "${raw}" is greater than 1 without a % sign — ambiguous, ` +
          'write a fraction (0.75) or a percent (75%)',
      );
    }
  }
  if (value < 0 || value > 1) fail(`${where}: frequency "${raw}" is outside [0, 1]`);
  return value;
}

function parseAction(raw, context, where) {
  const lowered = raw.trim().toLowerCase();
  const action = ACTION_ALIASES[lowered] ?? lowered;
  const allowed = CONTEXT_ACTIONS[context];
  if (!Object.values(CONTEXT_ACTIONS).flat().includes(action)) {
    fail(`${where}: unknown action "${raw}" (known: ${ACTION_ORDER.join(', ')})`);
  }
  if (!allowed.includes(action)) {
    fail(
      `${where}: action "${action}" is not allowed in context "${context}" ` +
        `(allowed: ${allowed.join(', ')})`,
    );
  }
  return action;
}

function isValidDateString(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function validateRangeSet(doc) {
  const errors = [];
  if (doc.schema_version !== 1) errors.push('schema_version must be 1');
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(doc.id ?? '')) errors.push(`id "${doc.id}" is not a slug`);
  if (!POSITIONS_BY_TABLE[doc.table_size]) {
    errors.push(`table_size "${doc.table_size}" must be 6max or 9max`);
  } else if (!POSITIONS_BY_TABLE[doc.table_size].includes(doc.position)) {
    errors.push(
      `position "${doc.position}" is not a ${doc.table_size} position ` +
        `(${POSITIONS_BY_TABLE[doc.table_size].join(', ')})`,
    );
  }
  if (!CONTEXT_ACTIONS[doc.context]) {
    errors.push(`context "${doc.context}" must be one of ${Object.keys(CONTEXT_ACTIONS).join(', ')}`);
  }
  if (doc.context === 'sb_play' && doc.position !== 'SB') {
    errors.push('context "sb_play" requires position "SB"');
  }
  if (!(typeof doc.stack_bb === 'number' && doc.stack_bb > 0 && doc.stack_bb <= 1000)) {
    errors.push('stack_bb must be a number in (0, 1000]');
  }
  if (!doc.rake_note) errors.push('rake_note is required');
  const source = doc.source ?? {};
  if (!source.name) errors.push('source.name is required');
  try {
    const url = new URL(source.url ?? '');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('scheme');
  } catch {
    errors.push(`source.url "${source.url}" is not an http(s) URL`);
  }
  if (!source.licence) errors.push('source.licence is required');
  if (!isValidDateString(source.retrieved ?? '')) {
    errors.push(`source.retrieved "${source.retrieved}" is not a valid YYYY-MM-DD date`);
  }
  const handEntries = Object.entries(doc.hands ?? {});
  if (handEntries.length === 0) errors.push('hands must not be empty');
  for (const [hand, actions] of handEntries) {
    let sum = 0;
    for (const [action, frequency] of Object.entries(actions)) {
      if (!ACTION_ORDER.includes(action)) errors.push(`${hand}: unknown action "${action}"`);
      if (doc.context && CONTEXT_ACTIONS[doc.context] && !CONTEXT_ACTIONS[doc.context].includes(action)) {
        errors.push(`${hand}: action "${action}" not allowed in context "${doc.context}"`);
      }
      if (!(typeof frequency === 'number' && frequency >= 0 && frequency <= 1)) {
        errors.push(`${hand}: frequency for "${action}" is outside [0, 1]`);
      }
      sum += frequency;
    }
    if (Math.abs(sum - 1) > SUM_TOLERANCE + 1e-9) {
      errors.push(`${hand}: frequencies sum to ${sum}, expected 1 (within ${SUM_TOLERANCE})`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const required = [
    'input', 'output', 'id', 'table-size', 'position', 'context', 'stack-bb',
    'rake-note', 'source-name', 'source-url', 'source-licence', 'retrieved',
  ];
  for (const name of required) {
    if (!opts[name]) fail(`missing required option --${name}`);
  }
  const context = opts.context;
  if (!CONTEXT_ACTIONS[context]) {
    fail(`--context must be one of ${Object.keys(CONTEXT_ACTIONS).join(', ')}`);
  }
  const stackBb = Number(opts['stack-bb']);
  if (!Number.isFinite(stackBb)) fail(`--stack-bb "${opts['stack-bb']}" is not a number`);

  if (fs.existsSync(opts.output) && !opts.force) {
    fail(`output file ${opts.output} already exists (pass --force to overwrite)`);
  }

  const csvText = fs.readFileSync(opts.input, 'utf8');
  const rows = parseCsv(csvText);
  if (rows.length === 0) fail('CSV is empty');
  const header = rows[0].fields.map((f) => f.trim().toLowerCase());
  if (header.length !== 3 || header[0] !== 'hand' || header[1] !== 'action' || header[2] !== 'frequency') {
    fail(`CSV header must be exactly "hand,action,frequency" (line ${rows[0].line})`);
  }

  const seenPairs = new Set();
  const byHand = new Map();
  for (const row of rows.slice(1)) {
    const where = `line ${row.line}`;
    if (row.fields.length !== 3) fail(`${where}: expected 3 fields, got ${row.fields.length}`);
    const hand = parseHand(row.fields[0], where);
    const action = parseAction(row.fields[1], context, where);
    const frequency = parseFrequency(row.fields[2], where);
    const pairKey = `${hand}|${action}`;
    if (seenPairs.has(pairKey)) fail(`${where}: duplicate row for hand ${hand}, action ${action}`);
    seenPairs.add(pairKey);
    if (!byHand.has(hand)) byHand.set(hand, new Map());
    byHand.get(hand).set(action, frequency);
  }
  if (byHand.size === 0) fail('CSV contains no data rows');

  let remainderHands = 0;
  const hands = {};
  const sortedHands = [...byHand.keys()].sort((a, b) => {
    const ranksA = a.split(' ').map((t) => RANK_VALUE[t[0]]);
    const ranksB = b.split(' ').map((t) => RANK_VALUE[t[0]]);
    for (let i = 0; i < 4; i += 1) {
      if (ranksA[i] !== ranksB[i]) return ranksB[i] - ranksA[i];
    }
    return a < b ? -1 : 1;
  });
  for (const hand of sortedHands) {
    const actions = byHand.get(hand);
    const sum = [...actions.values()].reduce((acc, v) => acc + v, 0);
    if (sum > 1 + 1e-9) fail(`hand ${hand}: frequencies sum to ${sum}, above 1`);
    if (sum < 1 - SUM_TOLERANCE) {
      // In these preflop contexts the unlisted mass is the fold mass; making
      // it explicit keeps every stored hand a complete distribution.
      actions.set('fold', (actions.get('fold') ?? 0) + (1 - sum));
      remainderHands += 1;
    }
    const ordered = {};
    for (const action of ACTION_ORDER) {
      if (actions.has(action)) ordered[action] = actions.get(action);
    }
    hands[hand] = ordered;
  }

  const doc = {
    schema_version: 1,
    id: opts.id,
    table_size: opts['table-size'],
    position: opts.position,
    context,
    ...(opts['context-detail'] ? { context_detail: opts['context-detail'] } : {}),
    stack_bb: stackBb,
    rake_note: opts['rake-note'],
    source: {
      name: opts['source-name'],
      url: opts['source-url'],
      licence: opts['source-licence'],
      retrieved: opts.retrieved,
    },
    ...(opts.notes ? { notes: opts.notes } : {}),
    hands,
  };

  const errors = validateRangeSet(doc);
  if (errors.length > 0) {
    fail(`range-set validation failed:\n  - ${errors.join('\n  - ')}`);
  }

  fs.writeFileSync(opts.output, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(
    `Wrote ${opts.output}: ${sortedHands.length} hands from ${seenPairs.size} CSV rows ` +
      `(context ${context}, position ${opts.position}, ${opts['table-size']}, ${stackBb}bb).`,
  );
  if (remainderHands > 0) {
    console.log(
      `Note: assigned the unlisted remainder to "fold" for ${remainderHands} hand(s) ` +
        'whose listed frequencies summed to less than 1.',
    );
  }
}

try {
  main();
} catch (err) {
  console.error(`import-csv error: ${err.message}`);
  process.exit(1);
}
