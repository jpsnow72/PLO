// Preflop range-set expansion for the job service — Node stdlib only.
//
// A range set document (data/preflop/) maps canonical hand-class keys (a
// representative combo whose suits are labelled by first occurrence, e.g.
// "As Ah Ks Kh") to per-action frequencies. The concrete combos of a class
// are exactly the distinct suit-permutation images of the representative:
// apply all 24 permutations of the four suits, normalise each image by
// sorting its cards (rank descending, then suit in s/h/d/c order) and
// dedupe. The size of that set is the class multiplicity — summing it over
// a real set file reproduces the set's combo-weighted action totals
// exactly (e.g. the 6-max BTN RFI set yields 270,725 combos and 49.0%
// raise).
//
// COVERAGE FORMULA (identical to the catalog generator's, CATALOG-NOTES.md
// "Coverage method"): for a set side and an action, every concrete combo
// carries weight w = the class frequency for that action — or, for a
// 3-bet continuation side, the PRODUCT w = base (RFI) class frequency x
// conditional action class frequency, because the v1.1 continuation sets'
// frequencies are conditional on having opened. Then:
//   total_weight  = sum of w over ALL positive-weight combos
//   kept_weight   = sum of w over the combos kept after capping
//   coverage_pct  = 100 * kept_weight / total_weight
// In "top" mode the kept combos are the highest-weight ones; all combos of
// a class share the class weight, so kept_weight matches the catalog's
// class-level computation (which allows a partial boundary class) exactly,
// regardless of which specific boundary-class combos the deterministic
// tie-break picks.
//
// RENORMALISATION: when a cap actually removes combos, the kept combo
// weights are scaled by total_weight / kept_weight, i.e. the kept range
// is renormalised to the FULL action mass. Relative frequencies between
// kept combos are unchanged (the engine normalises range weights when it
// builds the game, so a uniform scale is solve-invariant); the scaling
// keeps per-combo weights on the same scale as the uncapped expansion.
//
// DETERMINISM: "top" ranks by (weight desc, combo string asc). "sample"
// draws without replacement with Efraimidis-Spirakis keys
// (key = u^(1/w), u from a mulberry32 PRNG seeded by the caller) over the
// combo list sorted by combo string, so the same (set, action, base, cap,
// seed) yields the same sample on any machine.

import { promises as fs } from 'node:fs';
import path from 'node:path';

export class RangeExpandError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SUIT_ORDER = ['s', 'h', 'd', 'c'];
const RANK_VALUE = {
  A: 14, K: 13, Q: 12, J: 11, T: 10, 9: 9, 8: 8, 7: 7, 6: 6, 5: 5, 4: 4, 3: 3, 2: 2,
};

function suitPermutations() {
  const perms = [];
  const used = [false, false, false, false];
  const current = [];
  const walk = () => {
    if (current.length === 4) {
      perms.push([...current]);
      return;
    }
    for (let i = 0; i < 4; i += 1) {
      if (used[i]) continue;
      used[i] = true;
      current.push(SUIT_ORDER[i]);
      walk();
      current.pop();
      used[i] = false;
    }
  };
  walk();
  return perms;
}
const SUIT_PERMS = suitPermutations();

/** All concrete combos of the class named by a canonical representative key. */
export function classCombos(key) {
  const cards = key.split(' ').map((tok) => ({ rank: tok[0], suit: tok[1] }));
  const seen = new Set();
  for (const perm of SUIT_PERMS) {
    const mapping = { s: perm[0], h: perm[1], d: perm[2], c: perm[3] };
    const mapped = cards.map((c) => ({ rank: c.rank, suit: mapping[c.suit] }));
    mapped.sort(
      (a, b) =>
        RANK_VALUE[b.rank] - RANK_VALUE[a.rank] ||
        SUIT_ORDER.indexOf(a.suit) - SUIT_ORDER.indexOf(b.suit),
    );
    seen.add(mapped.map((c) => `${c.rank}${c.suit}`).join(' '));
  }
  return [...seen];
}

export function formatWeight(freq) {
  return String(Number(freq.toFixed(6)));
}

/** mulberry32 PRNG: tiny, self-contained, deterministic across engines. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash of a string — stable seed derivation for spot ids. */
export function fnv1a32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Normalise a caller seed (number or string) to a uint32. */
export function seedToUint32(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.floor(seed) >>> 0;
  if (typeof seed === 'string' && seed.length > 0) return fnv1a32(seed);
  return 0;
}

/**
 * The action whose frequencies define the continuing range when a set is
 * loaded into a solve WITHOUT an explicit action. v1 supports exactly the
 * contexts where that range is well-defined:
 *   - `rfi` sets:    the opening range = hands' `raise` frequencies.
 *   - `vs_rfi` sets: the continuing range vs an open = hands' `call`
 *                    frequencies (the 3-bet slice is a different, narrower
 *                    range and is NOT silently substituted).
 * Any other context (sb_play, three_bet, ...) returns null.
 */
export function solveActionForSet(doc) {
  if (doc.context === 'rfi') return 'raise';
  if (doc.context === 'vs_rfi') return 'call';
  return null;
}

/**
 * Default action for a CAPPED expansion when the caller did not name one:
 * the v1 rule above, extended with the two contexts whose continuing
 * range is also well-defined once an action is being chosen deliberately:
 *   - `sb_play` (raise-or-fold first-in): `raise`.
 *   - `vs_three_bet` (v1.1 continuations): `call`.
 * Returns null for anything else (an explicit action is then required).
 */
export function defaultActionForSet(doc) {
  const v1 = solveActionForSet(doc);
  if (v1 !== null) return v1;
  if (doc.context === 'sb_play') return 'raise';
  if (doc.context === 'vs_three_bet') return 'call';
  return null;
}

/**
 * Create an expander bound to a preflop data directory. Index and set
 * documents are cached in memory (they are static data files).
 */
export function createRangeExpander(preflopDirArg) {
  // Normalise once: entry paths are resolved absolutely and checked
  // against this root, which only works if the root itself is absolute.
  const preflopDir = path.resolve(preflopDirArg);
  /** @type {object | null} */
  let indexCache = null;
  /** @type {Map<string, object>} */
  const setCache = new Map();

  async function loadIndex() {
    if (indexCache) return indexCache;
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(path.join(preflopDir, 'index.json'), 'utf8'));
    } catch {
      throw new RangeExpandError(
        500,
        `Preflop index not readable at ${path.join(preflopDir, 'index.json')}`,
      );
    }
    if (!parsed || !Array.isArray(parsed.rangesets)) {
      throw new RangeExpandError(500, 'Preflop index is malformed (no rangesets array)');
    }
    indexCache = parsed;
    return parsed;
  }

  async function findSetEntry(id) {
    const index = await loadIndex();
    return index.rangesets.find((entry) => entry && entry.id === id) ?? null;
  }

  /** Resolve an index entry's path inside preflopDir (never user-controlled). */
  function entryPath(entry) {
    const resolved = path.resolve(preflopDir, String(entry.path ?? ''));
    if (!resolved.startsWith(preflopDir + path.sep)) return null;
    return resolved;
  }

  async function loadSet(id) {
    if (setCache.has(id)) return setCache.get(id);
    const entry = await findSetEntry(id);
    if (!entry) {
      throw new RangeExpandError(
        400,
        `Unknown preflop range set id "${id}" (not in the preflop index)`,
      );
    }
    const file = entryPath(entry);
    if (!file) throw new RangeExpandError(500, `Preflop index entry for "${id}" has an unsafe path`);
    let doc;
    try {
      doc = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      throw new RangeExpandError(500, `Preflop range set "${id}" is not readable at ${file}`);
    }
    if (!doc || typeof doc.hands !== 'object' || doc.hands === null) {
      throw new RangeExpandError(500, `Preflop range set "${id}" is malformed (no hands object)`);
    }
    setCache.set(id, doc);
    return doc;
  }

  /**
   * Every positive-weight concrete combo of a set side, as
   * [{ combo, weight }] sorted by combo string (a canonical order, so the
   * sampling draw does not depend on JSON key order). With baseSetId the
   * weight is the product base-freq x action-freq (continuation sides).
   */
  async function weightedCombos({ setId, action, baseSetId = null, baseAction = 'raise' }) {
    const doc = await loadSet(setId);
    const baseDoc = baseSetId ? await loadSet(baseSetId) : null;
    const combos = [];
    let totalWeight = 0;
    for (const [key, actions] of Object.entries(doc.hands)) {
      let freq = actions && typeof actions === 'object' ? actions[action] : undefined;
      if (typeof freq !== 'number' || !(freq > 0)) continue;
      if (baseDoc) {
        const baseActions = baseDoc.hands[key];
        const baseFreq =
          baseActions && typeof baseActions === 'object' ? baseActions[baseAction] : undefined;
        if (typeof baseFreq !== 'number' || !(baseFreq > 0)) continue;
        freq *= baseFreq;
      }
      for (const combo of classCombos(key)) {
        combos.push({ combo, weight: freq });
        totalWeight += freq;
      }
    }
    combos.sort((a, b) => (a.combo < b.combo ? -1 : a.combo > b.combo ? 1 : 0));
    return { doc, combos, totalWeight };
  }

  /**
   * Expand a range set into engine range entries ("As Ah Kd Qc:0.5", ...)
   * with an optional combo cap.
   *
   * @param {object} opts
   * @param {string} opts.setId
   * @param {string} [opts.action]  defaults via defaultActionForSet()
   * @param {number|null} [opts.cap]  max combos kept; null/omitted = all
   * @param {'top'|'sample'} [opts.mode]  cap selection mode (default 'top')
   * @param {number|string} [opts.seed]  sampling seed (mode 'sample')
   * @param {string|null} [opts.baseSetId]  product-weight base set (3-bet
   *   continuation sides: the opener's RFI set)
   * @param {string} [opts.baseAction]  base set action (default 'raise')
   * @returns {Promise<{range: string[], action: string, combos: number,
   *   kept_combos: number, total_combos: number, coverage_pct: number,
   *   mode: string, seed: number|null, base_set: string|null,
   *   base_action: string|null}>}
   */
  async function expandRangeSetCapped(opts) {
    const {
      setId,
      cap = null,
      mode = 'top',
      seed = null,
      baseSetId = null,
      baseAction = 'raise',
    } = opts;
    if (mode !== 'top' && mode !== 'sample') {
      throw new RangeExpandError(400, `range_mode must be "top" or "sample", got "${mode}"`);
    }
    if (cap !== null && (!Number.isInteger(cap) || cap < 1)) {
      throw new RangeExpandError(400, `range_cap must be a positive integer, got ${cap}`);
    }
    const doc = await loadSet(setId);
    let action = opts.action ?? null;
    if (action === null) {
      action = defaultActionForSet(doc);
      if (action === null) {
        throw new RangeExpandError(
          422,
          `Preflop range set "${setId}" has context "${doc.context}", which has no default ` +
            'solve action — name the action explicitly (range_action).',
        );
      }
    }
    const { combos, totalWeight } = await weightedCombos({
      setId,
      action,
      baseSetId,
      baseAction,
    });
    if (combos.length === 0) {
      throw new RangeExpandError(
        422,
        `Preflop range set "${setId}" expands to an empty ${action} range` +
          (baseSetId ? ` (product with base set "${baseSetId}")` : ''),
      );
    }
    const totalCombos = combos.length;
    const capped = cap !== null && cap < totalCombos;
    let kept = combos;
    if (capped && mode === 'top') {
      kept = [...combos]
        .sort((a, b) => b.weight - a.weight || (a.combo < b.combo ? -1 : a.combo > b.combo ? 1 : 0))
        .slice(0, cap);
    } else if (capped && mode === 'sample') {
      // Efraimidis-Spirakis weighted sampling without replacement:
      // key = u^(1/w) with u ~ U(0,1); keep the `cap` largest keys. The
      // input list is combo-sorted and the PRNG is seeded, so the draw is
      // identical on any machine for the same inputs.
      const rand = mulberry32(seedToUint32(seed));
      const keyed = combos.map((c) => ({ ...c, key: Math.pow(rand(), 1 / c.weight) }));
      keyed.sort((a, b) => b.key - a.key || (a.combo < b.combo ? -1 : a.combo > b.combo ? 1 : 0));
      kept = keyed.slice(0, cap).map(({ combo, weight }) => ({ combo, weight }));
    }
    const keptWeight = kept.reduce((sum, c) => sum + c.weight, 0);
    const coveragePct = Number(((100 * keptWeight) / totalWeight).toFixed(4));
    // Renormalise the kept weights to the full action mass when capped
    // (see the module header); uncapped expansions keep raw frequencies,
    // byte-compatible with the historical expandRangeSet output.
    const scale = capped ? totalWeight / keptWeight : 1;
    const ordered = [...kept].sort(
      (a, b) => b.weight - a.weight || (a.combo < b.combo ? -1 : a.combo > b.combo ? 1 : 0),
    );
    const range = ordered.map((c) => `${c.combo}:${formatWeight(c.weight * scale)}`);
    return {
      range,
      action,
      combos: range.length,
      kept_combos: range.length,
      total_combos: totalCombos,
      coverage_pct: coveragePct,
      mode,
      seed: mode === 'sample' ? seedToUint32(seed) : null,
      base_set: baseSetId,
      base_action: baseSetId ? baseAction : null,
    };
  }

  /**
   * The historical uncapped expansion used by POST /api/solves when no cap
   * fields are present: v1 contexts only (rfi -> raise, vs_rfi -> call),
   * raw class frequencies, classes in document order. Returns
   * { range, action, combos } exactly as the ADM-1 server produced.
   */
  async function expandRangeSet(id) {
    const doc = await loadSet(id);
    const action = solveActionForSet(doc);
    if (action === null) {
      throw new RangeExpandError(
        422,
        `Preflop range set "${id}" has context "${doc.context}", which cannot feed a solve in v1. ` +
          'Only RFI sets (their raise range) and vs-RFI sets (their call range) have a well-defined continuing range.',
      );
    }
    const range = [];
    for (const [key, actions] of Object.entries(doc.hands)) {
      const freq = actions && typeof actions === 'object' ? actions[action] : undefined;
      if (typeof freq !== 'number' || !(freq > 0)) continue;
      const weight = formatWeight(freq);
      for (const combo of classCombos(key)) {
        range.push(`${combo}:${weight}`);
      }
    }
    if (range.length === 0) {
      throw new RangeExpandError(422, `Preflop range set "${id}" expands to an empty ${action} range`);
    }
    return { range, action, combos: range.length };
  }

  return { loadIndex, findSetEntry, entryPath, loadSet, expandRangeSet, expandRangeSetCapped };
}
