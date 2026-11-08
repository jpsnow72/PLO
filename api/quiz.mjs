// Quiz progress + spaced repetition store for PLO GTO Study — Node
// standard library only.
//
// State lives in DATA_DIR/quiz-progress.json and tracks, per quiz item:
//   - items[item_key]:   SRS state (ladder level, next due time, history)
//   - topics[topic_key]: aggregate accuracy per topic, where a topic is
//                        "<texture>|<street>|<spot_type>"
//
// Item keys are built by the client and are opaque here:
//   spot questions:      "<solveId>|<node history>|<combo>"
//   heuristic questions: "heuristic|<heuristic id>"
//
// SRS LADDER (deliberately simple; see S2-NOTES.md): the review interval
// for an item is INTERVAL_DAYS[level] days. After each graded answer:
//   score >= 0.85  ("solid")   -> level += 1 (capped), due at now + interval
//   0.40..0.85     ("partial") -> level unchanged, due at now + 1 day
//   score <  0.40  ("miss")    -> level resets to 0, due immediately
// A missed item is therefore due again at once (the client also re-asks
// it once at the end of the same session); solid answers push the next
// review out along 0 -> 1 -> 2 -> 4 -> 7 -> 15 -> 30 days.
//
// Scores are computed by the CLIENT from the solve data (the server has
// no poker knowledge); this module only validates, clamps and stores.
// Writes are atomic (temp file + rename) and serialised through a
// promise chain, the same persistence pattern as the queue in
// server.mjs. A missing or corrupt file starts empty — progress is a
// study aid, not the library; losing it loses no solves.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const SRS_INTERVAL_DAYS = [0, 1, 2, 4, 7, 15, 30];
export const SOLID_THRESHOLD = 0.85;
export const PARTIAL_THRESHOLD = 0.4;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_KEY_LEN = 300;
const MAX_TAG_LEN = 60;
const ITEM_KINDS = new Set(['spot', 'heuristic']);
const GRADINGS = new Set(['ev', 'frequency', 'match']);

function cleanTag(value) {
  if (typeof value !== 'string') return 'unknown';
  const trimmed = value.trim().slice(0, MAX_TAG_LEN);
  return trimmed.length > 0 ? trimmed : 'unknown';
}

export function topicKeyOf(topic) {
  return `${cleanTag(topic?.texture)}|${cleanTag(topic?.street)}|${cleanTag(topic?.spot_type)}`;
}

/**
 * Pure SRS transition: given the current level and a score in [0, 1],
 * returns the new level and how many days until the item is due again.
 */
export function srsTransition(level, score) {
  const lvl = Number.isInteger(level) ? Math.min(Math.max(level, 0), SRS_INTERVAL_DAYS.length - 1) : 0;
  if (score >= SOLID_THRESHOLD) {
    const next = Math.min(lvl + 1, SRS_INTERVAL_DAYS.length - 1);
    return { level: next, dueInDays: SRS_INTERVAL_DAYS[next] ?? 0 };
  }
  if (score >= PARTIAL_THRESHOLD) {
    return { level: lvl, dueInDays: 1 };
  }
  return { level: 0, dueInDays: 0 };
}

function emptyProgress() {
  return { version: 1, items: {}, topics: {} };
}

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Keep only well-formed entries from a parsed progress file. */
function sanitiseProgress(parsed) {
  const out = emptyProgress();
  if (!isRecord(parsed)) return out;
  if (isRecord(parsed.items)) {
    for (const [key, item] of Object.entries(parsed.items)) {
      if (!isRecord(item)) continue;
      out.items[key] = {
        kind: ITEM_KINDS.has(item.kind) ? item.kind : 'spot',
        topic: {
          texture: cleanTag(item.topic?.texture),
          street: cleanTag(item.topic?.street),
          spot_type: cleanTag(item.topic?.spot_type),
        },
        level:
          Number.isInteger(item.level) && item.level >= 0 && item.level < SRS_INTERVAL_DAYS.length
            ? item.level
            : 0,
        due_at: typeof item.due_at === 'string' ? item.due_at : new Date(0).toISOString(),
        attempts: Number.isFinite(item.attempts) ? Math.max(0, Math.floor(item.attempts)) : 0,
        score_sum: Number.isFinite(item.score_sum) ? item.score_sum : 0,
        last_score: Number.isFinite(item.last_score) ? item.last_score : null,
        last_grading: GRADINGS.has(item.last_grading) ? item.last_grading : null,
        last_at: typeof item.last_at === 'string' ? item.last_at : null,
      };
    }
  }
  if (isRecord(parsed.topics)) {
    for (const [key, stats] of Object.entries(parsed.topics)) {
      if (!isRecord(stats)) continue;
      out.topics[key] = {
        attempts: Number.isFinite(stats.attempts) ? Math.max(0, Math.floor(stats.attempts)) : 0,
        score_sum: Number.isFinite(stats.score_sum) ? stats.score_sum : 0,
        last_at: typeof stats.last_at === 'string' ? stats.last_at : null,
      };
    }
  }
  return out;
}

/**
 * Create the quiz store bound to a DATA_DIR. Usage:
 *   const store = createQuizStore(DATA_DIR);
 *   await store.load();
 *   store.getProgress();            // -> { version, items, topics, intervals_days }
 *   await store.recordAnswer(body); // -> { item, topic } or throws HttpError-like {status, message}
 */
export function createQuizStore(dataDir) {
  const filePath = path.join(dataDir, 'quiz-progress.json');
  let progress = emptyProgress();
  let saveChain = Promise.resolve();

  function save() {
    const snapshot = JSON.stringify(progress, null, 2);
    saveChain = saveChain
      .then(async () => {
        await fs.mkdir(dataDir, { recursive: true });
        const tmp = `${filePath}.tmp-${process.pid}`;
        await fs.writeFile(tmp, snapshot);
        await fs.rename(tmp, filePath);
      })
      .catch((err) => {
        console.error(
          `quiz: could not persist progress: ${err instanceof Error ? err.message : err}`,
        );
      });
    return saveChain;
  }

  return {
    async load() {
      try {
        progress = sanitiseProgress(JSON.parse(await fs.readFile(filePath, 'utf8')));
      } catch {
        progress = emptyProgress();
      }
      return progress;
    },

    getProgress() {
      return {
        version: progress.version,
        items: progress.items,
        topics: progress.topics,
        intervals_days: SRS_INTERVAL_DAYS,
      };
    },

    /**
     * Validate + record one graded answer. Body:
     *   { item_key, kind, topic: { texture, street, spot_type },
     *     score, grading, ev_lost_pct? }
     * `score` is the client's 0..1 grade (re-clamped here); `grading`
     * records WHICH grading produced it ('ev' | 'frequency' | 'match')
     * so the stored history never pretends a frequency match was an EV
     * measurement. Throws { status, message } on a malformed body.
     */
    async recordAnswer(body) {
      const bad = (message) => {
        const err = new Error(message);
        err.status = 400;
        throw err;
      };
      if (!isRecord(body)) bad('Body must be a JSON object.');
      const itemKey = body.item_key;
      if (typeof itemKey !== 'string' || itemKey.length === 0 || itemKey.length > MAX_KEY_LEN) {
        bad(`item_key must be a non-empty string of at most ${MAX_KEY_LEN} characters.`);
      }
      if (!ITEM_KINDS.has(body.kind)) bad('kind must be "spot" or "heuristic".');
      if (!GRADINGS.has(body.grading)) bad('grading must be "ev", "frequency" or "match".');
      if (typeof body.score !== 'number' || !Number.isFinite(body.score)) {
        bad('score must be a finite number (the client grade, 0..1).');
      }
      const score = Math.min(1, Math.max(0, body.score));
      const topic = {
        texture: cleanTag(body.topic?.texture),
        street: cleanTag(body.topic?.street),
        spot_type: cleanTag(body.topic?.spot_type),
      };
      const now = new Date();
      const nowIsoStr = now.toISOString();

      const prev = progress.items[itemKey];
      const transition = srsTransition(prev?.level ?? 0, score);
      const item = {
        kind: body.kind,
        topic,
        level: transition.level,
        due_at: new Date(now.getTime() + transition.dueInDays * DAY_MS).toISOString(),
        attempts: (prev?.attempts ?? 0) + 1,
        score_sum: (prev?.score_sum ?? 0) + score,
        last_score: score,
        last_grading: body.grading,
        last_at: nowIsoStr,
      };
      progress.items[itemKey] = item;

      const key = topicKeyOf(topic);
      const stats = progress.topics[key] ?? { attempts: 0, score_sum: 0, last_at: null };
      stats.attempts += 1;
      stats.score_sum += score;
      stats.last_at = nowIsoStr;
      progress.topics[key] = stats;

      await save();
      return { item: { item_key: itemKey, ...item }, topic: { key, ...stats } };
    },
  };
}
