// Trainer drills (issue #22): focused-session definitions, the drill
// catalogue derived from real loaded data, and saved drills.
//
// A "focus" is a reusable training setup — the thing GTO Wizard calls
// a drill. Focuses are pure filters over questions the trainer can
// actually generate: a spot (one exact node of one solve), a topic, a
// street, a spot type, or the spaced-repetition due list. Nothing here
// invents questions; a focus whose filter matches nothing simply
// cannot start, and the UI says so.
//
// Saved drills persist in localStorage on this device only (there is
// no server-side drill store). A saved drill stores the focus, never
// question data — launching it re-derives the questions from whatever
// solves the trainer can load at that moment, so a drill saved against
// a thin library grows as the library does.

import type { PreflopIndex } from './preflop';
import { SPOT_LABEL, studySetOptions, type SpotKind } from './preflopStudy';
import { nodeHistoryOf, topicKey, topicLabel, type SpotQuestion } from './quiz';

// ---------- Focuses ----------------------------------------------------------

export type TrainerFocus =
  | {
      kind: 'spot';
      solveId: string;
      solveName: string;
      solveSource: 'library' | 'sample' | 'job';
      history: string;
    }
  | { kind: 'topic'; key: string }
  | { kind: 'street'; street: string }
  | { kind: 'spot-type'; spotType: string }
  | { kind: 'due' };

export function focusLabel(focus: TrainerFocus): string {
  switch (focus.kind) {
    case 'spot':
      return `Practice this spot · ${focus.solveName}`;
    case 'topic': {
      const [texture = '', street = '', spotType = ''] = focus.key.split('|');
      return topicLabel({ texture, street, spot_type: spotType });
    }
    case 'street':
      return `${capitalize(focus.street)} decisions`;
    case 'spot-type':
      return focus.spotType === 'facing-bet' ? 'Facing a bet' : 'First to act';
    case 'due':
      return 'Due for review (spaced repetition)';
  }
}

function capitalize(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Does this question belong to the focused session? */
export function focusMatches(focus: TrainerFocus, q: SpotQuestion): boolean {
  switch (focus.kind) {
    case 'spot':
      return q.solveId === focus.solveId && nodeHistoryOf(q) === focus.history;
    case 'topic':
      return topicKey(q.topic) === focus.key;
    case 'street':
      return q.street.toLowerCase() === focus.street.toLowerCase();
    case 'spot-type':
      return q.topic.spot_type === focus.spotType;
    case 'due':
      return false; // due-ness lives in the progress snapshot, not the question
  }
}

// ---------- Drill catalogue (derived from loaded questions) ------------------

export interface DrillEntry {
  focus: TrainerFocus;
  label: string;
  /** How many loaded questions this drill would draw from. */
  count: number;
  detail: string;
}

function countBy<T>(items: T[], keyOf: (item: T) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

export function streetDrillEntries(questions: SpotQuestion[]): DrillEntry[] {
  const counts = countBy(questions, (q) => q.street.toLowerCase());
  const order = ['flop', 'turn', 'river'];
  return [...counts.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([street, count]) => ({
      focus: { kind: 'street' as const, street },
      label: `${capitalize(street)} decisions`,
      count,
      detail: 'Every loaded decision on this street, due reviews first.',
    }));
}

export function spotTypeDrillEntries(questions: SpotQuestion[]): DrillEntry[] {
  const counts = countBy(questions, (q) => q.topic.spot_type);
  const labels: Record<string, string> = {
    'facing-bet': 'Facing a bet',
    'first-to-act': 'First to act',
  };
  return [...counts.entries()]
    .sort((a, b) => (labels[a[0]] ?? a[0]).localeCompare(labels[b[0]] ?? b[0]))
    .map(([spotType, count]) => ({
      focus: { kind: 'spot-type' as const, spotType },
      label: labels[spotType] ?? spotType.replace(/-/g, ' '),
      count,
      detail:
        spotType === 'facing-bet'
          ? 'Decisions where money is already in front of you.'
          : 'Decisions where you act first or the action checked to you.',
    }));
}

/**
 * One drill per topic present in the loaded questions. Weakest topics
 * first when synced accuracy is known (the app's standing convention),
 * otherwise the topics with the most questions first.
 */
export function topicDrillEntries(
  questions: SpotQuestion[],
  accuracyByKey?: Map<string, number>,
): DrillEntry[] {
  const counts = countBy(questions, (q) => topicKey(q.topic));
  const entries = [...counts.entries()].map(([key, count]) => {
    const [texture = '', street = '', spotType = ''] = key.split('|');
    const accuracy = accuracyByKey?.get(key);
    return {
      focus: { kind: 'topic' as const, key },
      label: topicLabel({ texture, street, spot_type: spotType }),
      count,
      detail:
        accuracy !== undefined
          ? `Your accuracy on this topic so far: ${(accuracy * 100).toFixed(0)}%.`
          : 'No graded answers on this topic yet.',
      accuracy,
    };
  });
  entries.sort((a, b) => {
    if (a.accuracy !== undefined && b.accuracy !== undefined) return a.accuracy - b.accuracy;
    if (a.accuracy !== undefined) return -1;
    if (b.accuracy !== undefined) return 1;
    return b.count - a.count;
  });
  return entries.map(({ accuracy: _accuracy, ...rest }) => rest);
}

// ---------- Preflop drill groups (derived from the range-set index) ---------

export interface PreflopDrillGroup {
  key: string;
  label: string;
  setCount: number;
  /** The set the Starting Hands page opens on; any set in the group is one picker step away there. */
  firstSetId: string;
  detail: string;
}

/**
 * Group the drillable range sets by table size + spot kind. The
 * Starting Hands drill takes one set at a time, so a group launches
 * that page preselected on its first set — the position picker there
 * reaches the rest of the group.
 */
export function preflopDrillGroups(index: PreflopIndex): PreflopDrillGroup[] {
  const groups = new Map<string, PreflopDrillGroup>();
  for (const option of studySetOptions(index)) {
    const key = `${option.entry.table_size}|${option.spot}`;
    const existing = groups.get(key);
    if (existing) {
      existing.setCount += 1;
      continue;
    }
    groups.set(key, {
      key,
      label: `${option.entry.table_size} · ${SPOT_LABEL[option.spot as SpotKind]}`,
      setCount: 1,
      firstSetId: option.entry.id,
      detail:
        option.spot === 'first-in'
          ? 'Open-or-fold decisions by position, against the constructed ranges.'
          : 'Blind and button defense against an open, against the constructed ranges.',
    });
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// ---------- Saved drills (localStorage, this device only) --------------------

export interface SavedDrill {
  id: string;
  name: string;
  focus: TrainerFocus;
  created_at: string;
}

const SAVED_DRILLS_KEY = 'plo-saved-drills';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseFocus(v: unknown): TrainerFocus | null {
  if (!isRecord(v)) return null;
  switch (v.kind) {
    case 'spot':
      if (
        typeof v.solveId === 'string' &&
        typeof v.solveName === 'string' &&
        (v.solveSource === 'library' || v.solveSource === 'sample' || v.solveSource === 'job') &&
        typeof v.history === 'string'
      ) {
        return {
          kind: 'spot',
          solveId: v.solveId,
          solveName: v.solveName,
          solveSource: v.solveSource,
          history: v.history,
        };
      }
      return null;
    case 'topic':
      return typeof v.key === 'string' ? { kind: 'topic', key: v.key } : null;
    case 'street':
      return typeof v.street === 'string' ? { kind: 'street', street: v.street } : null;
    case 'spot-type':
      return typeof v.spotType === 'string' ? { kind: 'spot-type', spotType: v.spotType } : null;
    case 'due':
      return { kind: 'due' };
    default:
      return null;
  }
}

export function loadSavedDrills(): SavedDrill[] {
  try {
    const raw = localStorage.getItem(SAVED_DRILLS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: SavedDrill[] = [];
    for (const entry of parsed) {
      if (!isRecord(entry) || typeof entry.id !== 'string' || typeof entry.name !== 'string') {
        continue;
      }
      const focus = parseFocus(entry.focus);
      if (!focus) continue;
      out.push({
        id: entry.id,
        name: entry.name,
        focus,
        created_at: typeof entry.created_at === 'string' ? entry.created_at : '',
      });
    }
    return out;
  } catch {
    return [];
  }
}

function persistSavedDrills(drills: SavedDrill[]): void {
  try {
    localStorage.setItem(SAVED_DRILLS_KEY, JSON.stringify(drills));
  } catch {
    // Storage full/blocked: the in-memory list still works this visit.
  }
}

export function addSavedDrill(name: string, focus: TrainerFocus): SavedDrill[] {
  const drill: SavedDrill = {
    id: `drill-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
    name: name.trim() || focusLabel(focus),
    focus,
    created_at: new Date().toISOString(),
  };
  const next = [drill, ...loadSavedDrills()];
  persistSavedDrills(next);
  return next;
}

export function removeSavedDrill(id: string): SavedDrill[] {
  const next = loadSavedDrills().filter((d) => d.id !== id);
  persistSavedDrills(next);
  return next;
}
