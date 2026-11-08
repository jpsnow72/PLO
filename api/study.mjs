// Study-layer persistence + routes (ticket S1) — Node standard library
// only. Owns two personal data sets, both gated by the admin session
// (they are the user's own study state, not public library data):
//
//   Heuristics log (the user's distilled playbook):
//     GET    /api/heuristics          { heuristics: [...] }        [admin]
//     POST   /api/heuristics          create -> 201 record         [admin]
//     PUT    /api/heuristics/:id      partial update -> record     [admin]
//     DELETE /api/heuristics/:id      -> { deleted: true, id }     [admin]
//     Persisted in DATA_DIR/heuristics.json.
//
//   Quick Review outcomes (deliberately minimal — the Quiz lane owns
//   spaced repetition; this is just the event log + a summary):
//     POST   /api/study/review-events { events: [...] } -> 201     [admin]
//     GET    /api/study/progress      aggregate summary            [admin]
//     Persisted in DATA_DIR/study-progress.json.
//
// Persistence discipline mirrors the queue (server.mjs): in-memory state,
// saves serialised through a promise chain, atomic temp-file + rename on
// every mutation, a missing/corrupt file starts empty (corruption is
// logged, never fatal).
//
// Heuristic record shape (unknown input fields are stripped, always):
//   {
//     id,                                  // server-generated
//     text,                                // non-empty string
//     source: 'manual'|'ai-suggested'|'mined',
//     tags: { texture?, street?, spot_type? },
//     linked_spot_ids: [string],
//     status: 'active'|'retired',
//     support_n?, mean_freq?, spread?,     // mined support stats, only
//                                          // present when supplied valid
//     created_at, updated_at               // ISO strings
//   }

import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const HEURISTIC_SOURCES = new Set(['manual', 'ai-suggested', 'mined']);
const HEURISTIC_STATUSES = new Set(['active', 'retired']);
const TAG_KEYS = ['texture', 'street', 'spot_type'];
const MAX_TEXT_LEN = 2000;
const MAX_TAG_LEN = 60;
const MAX_LINKED_SPOTS = 200;
const MAX_EVENTS_PER_POST = 100;
const MAX_STORED_EVENTS = 10000;
const SPOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Input sanitising. Each sanitizer returns { value } or { error } so the
// route layer can answer 400 with a precise message. `partial` (PUT)
// means absent fields are left out of the result instead of defaulted.
// ---------------------------------------------------------------------------

function sanitizeText(v) {
  if (typeof v !== 'string') return { error: 'text must be a string' };
  const text = v.trim();
  if (text.length === 0) return { error: 'text must be non-empty' };
  if (text.length > MAX_TEXT_LEN) {
    return { error: `text is too long (limit ${MAX_TEXT_LEN} characters)` };
  }
  return { value: text };
}

function sanitizeTags(v) {
  if (!isPlainObject(v)) return { error: 'tags must be an object' };
  const tags = {};
  for (const key of TAG_KEYS) {
    const raw = v[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') return { error: `tags.${key} must be a string` };
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > MAX_TAG_LEN) {
      return { error: `tags.${key} is too long (limit ${MAX_TAG_LEN} characters)` };
    }
    tags[key] = trimmed;
  }
  return { value: tags };
}

function sanitizeLinkedSpotIds(v) {
  if (!Array.isArray(v)) return { error: 'linked_spot_ids must be an array of spot id strings' };
  const ids = [];
  for (const raw of v) {
    if (typeof raw !== 'string' || !SPOT_ID_RE.test(raw)) {
      return { error: `linked_spot_ids entries must be id strings (letters, digits, - and _); got ${JSON.stringify(raw)}` };
    }
    if (!ids.includes(raw)) ids.push(raw);
  }
  if (ids.length > MAX_LINKED_SPOTS) {
    return { error: `linked_spot_ids is too long (limit ${MAX_LINKED_SPOTS})` };
  }
  return { value: ids };
}

function sanitizeSupportField(name, v) {
  // null clears the field (PUT); a finite number in range sets it.
  if (v === null) return { value: null };
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return { error: `${name} must be a number` };
  }
  if (name === 'support_n' && (!Number.isInteger(v) || v < 0)) {
    return { error: 'support_n must be a non-negative integer' };
  }
  if (name === 'mean_freq' && (v < 0 || v > 1)) {
    return { error: 'mean_freq must be between 0 and 1' };
  }
  if (name === 'spread' && v < 0) return { error: 'spread must be >= 0' };
  return { value: v };
}

function sanitizeHeuristicInput(body, { partial }) {
  if (!isPlainObject(body)) return { error: 'Body must be a JSON object.' };
  const out = {};

  if (body.text !== undefined) {
    const r = sanitizeText(body.text);
    if (r.error) return r;
    out.text = r.value;
  } else if (!partial) {
    return { error: 'text is required' };
  }

  if (body.source !== undefined) {
    if (typeof body.source !== 'string' || !HEURISTIC_SOURCES.has(body.source)) {
      return { error: `source must be one of: ${[...HEURISTIC_SOURCES].join(', ')}` };
    }
    out.source = body.source;
  } else if (!partial) {
    out.source = 'manual';
  }

  if (body.tags !== undefined) {
    const r = sanitizeTags(body.tags);
    if (r.error) return r;
    out.tags = r.value;
  } else if (!partial) {
    out.tags = {};
  }

  if (body.linked_spot_ids !== undefined) {
    const r = sanitizeLinkedSpotIds(body.linked_spot_ids);
    if (r.error) return r;
    out.linked_spot_ids = r.value;
  } else if (!partial) {
    out.linked_spot_ids = [];
  }

  if (body.status !== undefined) {
    if (typeof body.status !== 'string' || !HEURISTIC_STATUSES.has(body.status)) {
      return { error: `status must be one of: ${[...HEURISTIC_STATUSES].join(', ')}` };
    }
    out.status = body.status;
  } else if (!partial) {
    out.status = 'active';
  }

  for (const name of ['support_n', 'mean_freq', 'spread']) {
    if (body[name] !== undefined) {
      const r = sanitizeSupportField(name, body[name]);
      if (r.error) return r;
      out[name] = r.value; // may be null on PUT = clear the field
    }
  }

  return { value: out };
}

function sanitizeReviewEvent(raw) {
  if (!isPlainObject(raw)) return { error: 'each event must be an object' };
  if (raw.grade !== 'got' && raw.grade !== 'missed') {
    return { error: 'event grade must be "got" or "missed"' };
  }
  const ev = { grade: raw.grade };
  const str = (name, max = 300) => {
    const v = raw[name];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') return undefined; // signals error below via marker
    return v.slice(0, max);
  };
  for (const name of ['session_id', 'board', 'street', 'player', 'node_history', 'hero_combo']) {
    const v = str(name);
    if (v === undefined) return { error: `event ${name} must be a string` };
    if (v !== null) ev[name] = v;
  }
  if (raw.spot_id !== undefined && raw.spot_id !== null) {
    if (typeof raw.spot_id !== 'string' || !SPOT_ID_RE.test(raw.spot_id)) {
      return { error: 'event spot_id must be an id string (letters, digits, - and _)' };
    }
    ev.spot_id = raw.spot_id;
  } else {
    ev.spot_id = null;
  }
  if (raw.source !== undefined && raw.source !== null) {
    if (!['library', 'job', 'sample'].includes(raw.source)) {
      return { error: 'event source must be "library", "job" or "sample"' };
    }
    ev.source = raw.source;
  } else {
    ev.source = null;
  }
  return { value: ev };
}

// ---------------------------------------------------------------------------
// Store: lazy-loaded file-backed state with serialised atomic saves.
// ---------------------------------------------------------------------------

function createJsonFileStore(file, emptyValue, label) {
  let state = null;
  let saveChain = Promise.resolve();

  async function load() {
    if (state) return state;
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      // A parseable but wrongly-shaped file is corruption too: start empty.
      state = isPlainObject(parsed) ? parsed : emptyValue();
      if (state !== parsed) {
        console.error(`${label}: ${file} does not hold a JSON object; starting empty`);
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        console.error(`${label}: could not parse ${file} (${err.message}); starting empty`);
      }
      state = emptyValue();
    }
    return state;
  }

  function save() {
    const snapshot = JSON.stringify(state, null, 2);
    saveChain = saveChain
      .then(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp-${process.pid}`;
        await fs.writeFile(tmp, snapshot);
        await fs.rename(tmp, file);
      })
      .catch((err) => {
        console.error(`${label}: could not persist state: ${err instanceof Error ? err.message : err}`);
      });
    return saveChain;
  }

  return { load, save };
}

// ---------------------------------------------------------------------------
// Route factory. `ctx` carries the server.mjs helpers so responses keep
// the exact house shape (CORS, error JSON, admin gate, body reader).
// ---------------------------------------------------------------------------

export function createStudyApi(ctx) {
  const { dataDir, requireAdmin, sendJson, readBody, HttpError, nowIso } = ctx;

  const heuristicsStore = createJsonFileStore(
    path.join(dataDir, 'heuristics.json'),
    () => ({ heuristics: [] }),
    'heuristics',
  );
  const progressStore = createJsonFileStore(
    path.join(dataDir, 'study-progress.json'),
    () => ({ events: [] }),
    'study-progress',
  );

  async function loadHeuristics() {
    const state = await heuristicsStore.load();
    if (!state || !Array.isArray(state.heuristics)) {
      state.heuristics = [];
    }
    return state.heuristics;
  }

  async function loadEvents() {
    const state = await progressStore.load();
    if (!state || !Array.isArray(state.events)) {
      state.events = [];
    }
    return state.events;
  }

  async function parseJsonBody(req) {
    const text = await readBody(req);
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(400, 'Body must be valid JSON.');
    }
  }

  /** Returns true when a study route handled the request. */
  async function handle(req, res, url, parts) {
    const isHeuristicsRoot = url.pathname === '/api/heuristics';
    const isHeuristicItem =
      parts[0] === 'api' && parts[1] === 'heuristics' && typeof parts[2] === 'string';
    const isReviewEvents = url.pathname === '/api/study/review-events';
    const isProgress = url.pathname === '/api/study/progress';
    if (!isHeuristicsRoot && !isHeuristicItem && !isReviewEvents && !isProgress) return false;

    // All study data is personal: same admin-session gate as the writes.
    if (!(await requireAdmin(req, res))) return true;

    try {
      if (req.method === 'GET' && isHeuristicsRoot) {
        const heuristics = await loadHeuristics();
        sendJson(req, res, 200, { heuristics });
        return true;
      }

      if (req.method === 'POST' && isHeuristicsRoot) {
        const body = await parseJsonBody(req);
        const r = sanitizeHeuristicInput(body, { partial: false });
        if (r.error) throw new HttpError(400, r.error);
        const now = nowIso();
        const record = { id: randomUUID(), ...r.value, created_at: now, updated_at: now };
        // Support stats only land on the record when actually supplied.
        for (const name of ['support_n', 'mean_freq', 'spread']) {
          if (record[name] === null || record[name] === undefined) delete record[name];
        }
        const heuristics = await loadHeuristics();
        heuristics.push(record);
        await heuristicsStore.save();
        sendJson(req, res, 201, record);
        return true;
      }

      if (isHeuristicItem && (req.method === 'PUT' || req.method === 'DELETE')) {
        const id = parts[2];
        const heuristics = await loadHeuristics();
        const idx = heuristics.findIndex((h) => h && h.id === id);
        if (idx === -1) throw new HttpError(404, `Unknown heuristic id "${id}"`);
        if (req.method === 'DELETE') {
          heuristics.splice(idx, 1);
          await heuristicsStore.save();
          sendJson(req, res, 200, { deleted: true, id });
          return true;
        }
        const body = await parseJsonBody(req);
        const r = sanitizeHeuristicInput(body, { partial: true });
        if (r.error) throw new HttpError(400, r.error);
        const record = { ...heuristics[idx] };
        for (const [key, value] of Object.entries(r.value)) {
          if (value === null && ['support_n', 'mean_freq', 'spread'].includes(key)) {
            delete record[key];
          } else {
            record[key] = value;
          }
        }
        record.updated_at = nowIso();
        heuristics[idx] = record;
        await heuristicsStore.save();
        sendJson(req, res, 200, record);
        return true;
      }

      if (req.method === 'POST' && isReviewEvents) {
        const body = await parseJsonBody(req);
        if (!isPlainObject(body) || !Array.isArray(body.events)) {
          throw new HttpError(400, 'Body must be { events: [...] }.');
        }
        if (body.events.length > MAX_EVENTS_PER_POST) {
          throw new HttpError(400, `Too many events in one post (limit ${MAX_EVENTS_PER_POST}).`);
        }
        const events = await loadEvents();
        const now = nowIso();
        let recorded = 0;
        for (const raw of body.events) {
          const r = sanitizeReviewEvent(raw);
          if (r.error) throw new HttpError(400, r.error);
          events.push({ ...r.value, recorded_at: now });
          recorded += 1;
        }
        if (events.length > MAX_STORED_EVENTS) {
          events.splice(0, events.length - MAX_STORED_EVENTS);
        }
        await progressStore.save();
        sendJson(req, res, 201, { recorded, total: events.length });
        return true;
      }

      if (req.method === 'GET' && isProgress) {
        const events = await loadEvents();
        const byStreet = {};
        const sessions = new Set();
        let got = 0;
        let missed = 0;
        let lastSessionAt = null;
        for (const ev of events) {
          if (!ev || typeof ev !== 'object') continue;
          if (ev.grade === 'got') got += 1;
          else if (ev.grade === 'missed') missed += 1;
          const street = typeof ev.street === 'string' ? ev.street : 'unknown';
          byStreet[street] = byStreet[street] ?? { got: 0, missed: 0 };
          if (ev.grade === 'got' || ev.grade === 'missed') byStreet[street][ev.grade] += 1;
          if (typeof ev.session_id === 'string') sessions.add(ev.session_id);
          if (typeof ev.recorded_at === 'string') lastSessionAt = ev.recorded_at;
        }
        sendJson(req, res, 200, {
          total_events: events.length,
          got,
          missed,
          sessions: sessions.size,
          last_session_at: lastSessionAt,
          by_street: byStreet,
        });
        return true;
      }

      throw new HttpError(404, 'Not found');
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(req, res, err.status, { error: err.message });
        return true;
      }
      throw err;
    }
  }

  return { handle };
}
