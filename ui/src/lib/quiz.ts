// Quiz Trainer core: question generation + grading, all derived from
// real solve data. No question exists unless a parsed solve (or the
// heuristics log) actually supports it.
//
// GRADING HONESTY (read this before touching the grader):
// The engine's solve JSON stores, per decision node, each combo's
// action FREQUENCIES, plus one whole-solve EV per combo. It does NOT
// store per-action EVs at a node, so the EV cost of picking action A
// over action B at a node cannot be computed from today's data — any
// "EV lost" number shown for such a solve would be fabricated.
// The grader therefore has two modes and always reports which fired:
//   - 'ev':        only when a solve node carries per-combo per-action
//                  EVs (a future engine field, `combo_action_evs`,
//                  checked defensively). Grade = EV lost vs the best
//                  action for that combo, mapped to 0..1 (see
//                  EV_SCORE_SPAN_POT_FRACTION).
//   - 'frequency': the mode that fires for every solve the current
//                  engine produces. Grade = the frequency with which
//                  the solver takes the chosen action with this exact
//                  combo (0..1). The UI labels it "frequency match"
//                  everywhere and never calls it EV.
// Heuristic questions grade as 'match' (picked the applicable
// heuristic, or not) — binary by nature, labelled as recall, not EV.

import { parseCombo } from './cards';
import type { Heuristic } from './heuristics';
import {
  actionToken,
  childHistory,
  liveCombos,
  type SolveData,
  type SolveNode,
} from './solveTree';
import { boardFamilies, FAMILY_LABEL, type TextureFamily } from './texture';

// ---------- Topics -----------------------------------------------------------

export interface QuizTopic {
  texture: string;
  street: string;
  spot_type: string;
}

export function topicKey(topic: QuizTopic): string {
  return `${topic.texture}|${topic.street}|${topic.spot_type}`;
}

export function topicLabel(topic: QuizTopic): string {
  const texture =
    FAMILY_LABEL[topic.texture as TextureFamily] ?? topic.texture.replace(/-/g, ' ');
  return `${texture} · ${topic.street} · ${topic.spot_type.replace(/-/g, ' ')}`;
}

/** The full board visible at a node (root board + dealt turn/river cards). */
export function boardAtNode(data: SolveData, node: SolveNode): string[] {
  const labels = data.boardCards.map((c) => c.label);
  if (node.turn_card) labels.push(node.turn_card);
  if (node.river_card) labels.push(node.river_card);
  return labels;
}

/**
 * Topic for a decision node. Texture = the primary family of the board
 * as it stands at this node (texture.ts order: paired, flush-heavy,
 * connected, dry). Spot type is read off the node itself: facing a bet
 * (to_call > 0) vs first to act / free decision (to_call = 0).
 */
export function topicForNode(data: SolveData, node: SolveNode): QuizTopic {
  const families = boardFamilies(boardAtNode(data, node).join(' '));
  return {
    texture: families[0] ?? 'dry',
    street: node.streetName,
    spot_type: node.to_call > 0 ? 'facing-bet' : 'first-to-act',
  };
}

// ---------- Line reconstruction ----------------------------------------------

/** Human label for one history token ("B(75)" -> "Bet 75", "X" -> "Check"). */
function tokenLabel(token: string): string {
  if (token === 'X') return 'Check';
  if (token === 'F') return 'Fold';
  if (token === 'C') return 'Call';
  const m = /^(BAI|RAI|B|R)\((.+)\)$/.exec(token);
  if (m) {
    const kind =
      m[1] === 'B'
        ? 'Bet'
        : m[1] === 'BAI'
          ? 'Bet all-in'
          : m[1] === 'R'
            ? 'Raise to'
            : 'Raise all-in to';
    return `${kind} ${m[2]}`;
  }
  return token;
}

/**
 * Rebuild the line that leads to `node` as readable steps
 * ("OOP · Bet 75", "Turn card · As", ...), by replaying the node's
 * history against the tree: each action token is matched to the action
 * label of the node it was taken at, so the acting player is the node's
 * own `player` field — nothing is guessed. Returns [] for the root, and
 * falls back to whatever prefix resolved if a step cannot be matched
 * (defensive; histories come from the same engine that built the tree).
 */
export function lineSteps(data: SolveData, node: SolveNode): string[] {
  if (node.history === 'root') return [];
  const steps: string[] = [];
  let current: SolveNode = data.root;
  // Segments: action runs separated by chance markers, e.g.
  // "B(75)/C|t:As/X|r:Kd" -> ["B(75)/C", "t:As/X", "r:Kd"].
  const segments = node.history.split('|');
  for (const segment of segments) {
    const tokens = segment.split('/').filter((t) => t.length > 0);
    let start = 0;
    const chance = /^([tr]):(.+)$/.exec(tokens[0] ?? '');
    if (chance) {
      const street = chance[1] === 't' ? 'Turn' : 'River';
      steps.push(`${street} card · ${chance[2]}`);
      const next = data.nodesByHistory.get(
        current.history === 'root'
          ? `root|${chance[1]}:${chance[2]}`
          : `${current.history}|${chance[1]}:${chance[2]}`,
      );
      // The subtree root's history is "{parentHistory}|t:{Card}" only
      // when the parent action closed the street; the parent here is the
      // node reached after the previous segment's actions, whose history
      // already includes them — so look the child up by suffix instead.
      const resolved =
        next ??
        [...data.nodesByHistory.values()].find(
          (n) =>
            n.history.endsWith(`|${chance[1]}:${chance[2]}`) &&
            (current.history === 'root' || n.history.startsWith(current.history)),
        );
      if (resolved) current = resolved;
      start = 1;
    }
    for (let i = start; i < tokens.length; i++) {
      const token = tokens[i] ?? '';
      const label = current.actions.find((a) => actionToken(a) === token);
      if (!label) return steps; // unresolved token: show the prefix we trust
      steps.push(`${current.player} · ${tokenLabel(token)}`);
      const child = data.nodesByHistory.get(childHistory(current, label));
      if (!child) return steps;
      current = child;
    }
  }
  return steps;
}

// ---------- Spot questions -----------------------------------------------------

export type GradingMode = 'ev' | 'frequency' | 'match';

export interface SpotQuestion {
  kind: 'spot';
  itemKey: string;
  solveId: string;
  solveName: string;
  solveSource: 'library' | 'sample';
  board: string[];
  boardText: string;
  street: string;
  player: string;
  heroCombo: string;
  heroCards: string[];
  pot: number;
  toCall: number;
  startingPot: number;
  line: string[];
  topic: QuizTopic;
  actions: string[];
  /** The combo's solver frequencies at this node, aligned with actions. */
  frequencies: number[];
  /**
   * Per-action EVs for this combo at this node, when the solve carries
   * them (future engine field). Null for every solve today's engine
   * produces — grading then falls back to frequency mode.
   */
  actionEvs: number[] | null;
  nashPct: number;
}

/**
 * Defensive read of a hypothetical per-combo per-action EV table on a
 * raw node: `combo_action_evs: { [combo]: number[] }`, aligned with
 * `actions`. Returns the row for `combo`, or null when absent/misaligned.
 */
function actionEvsFor(node: SolveNode, combo: string): number[] | null {
  const raw = (node as unknown as Record<string, unknown>).combo_action_evs;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const row = (raw as Record<string, unknown>)[combo];
  if (!Array.isArray(row) || row.length !== node.actions.length) return null;
  if (!row.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return row as number[];
}

export interface SpotSource {
  id: string;
  name: string;
  source: 'library' | 'sample';
  data: SolveData;
}

/**
 * Every (node, combo) pair in a solve that can honestly be a question:
 * the node offers a real choice (>= 2 actions) and the combo is live
 * there (its frequency row sums to ~1).
 */
export function collectSpotQuestions(src: SpotSource): SpotQuestion[] {
  const out: SpotQuestion[] = [];
  const { data } = src;
  for (const node of data.nodesByHistory.values()) {
    if (node.actions.length < 2) continue;
    for (const combo of liveCombos(node)) {
      const freqs = node.strategy[combo];
      if (!freqs || freqs.length !== node.actions.length) continue;
      const sum = freqs.reduce((a, b) => a + b, 0);
      if (sum < 0.98 || sum > 1.02) continue;
      const cards = parseCombo(combo);
      if (!cards) continue;
      const board = boardAtNode(data, node);
      out.push({
        kind: 'spot',
        itemKey: `${src.id}|${node.history}|${combo}`,
        solveId: src.id,
        solveName: src.name,
        solveSource: src.source,
        board,
        boardText: board.join(' '),
        street: node.streetName,
        player: node.player,
        heroCombo: combo,
        heroCards: cards.map((c) => c.label),
        pot: node.pot,
        toCall: node.to_call,
        startingPot: data.raw.starting_pot,
        line: lineSteps(data, node),
        topic: topicForNode(data, node),
        actions: [...node.actions],
        frequencies: [...freqs],
        actionEvs: actionEvsFor(node, combo),
        nashPct: data.raw.exploitability.nash_distance_pct,
      });
    }
  }
  return out;
}

// ---------- Grading ------------------------------------------------------------

/** An EV loss of this fraction of the pot maps to score 0 in EV mode. */
export const EV_SCORE_SPAN_POT_FRACTION = 0.25;

export interface GradeResult {
  grading: GradingMode;
  /** 0..1 — feeds the SRS ladder (>= 0.85 solid, 0.4..0.85 partial, < 0.4 miss). */
  score: number;
  band: 'solid' | 'partial' | 'miss';
  headline: string;
  /** Why this grade, in plain terms — names the grading mode explicitly. */
  detail: string;
  /** EV lost in chips, EV mode only; null otherwise (never fabricated). */
  evLostChips: number | null;
  bestActionIdx: number;
}

export function bandForScore(score: number): GradeResult['band'] {
  return score >= 0.85 ? 'solid' : score >= 0.4 ? 'partial' : 'miss';
}

/**
 * Grade a spot answer. EV mode fires ONLY when the question carries
 * per-action EVs (see the honesty note at the top of this file);
 * otherwise frequency mode grades by how often the solver takes the
 * chosen action with this exact combo.
 */
export function gradeSpotAnswer(q: SpotQuestion, chosenIdx: number): GradeResult {
  const chosenFreq = q.frequencies[chosenIdx] ?? 0;
  let bestIdx = 0;
  q.frequencies.forEach((f, i) => {
    if (f > (q.frequencies[bestIdx] ?? 0)) bestIdx = i;
  });

  if (q.actionEvs) {
    const evs = q.actionEvs;
    let evBest = 0;
    evs.forEach((ev, i) => {
      if (ev > (evs[evBest] ?? -Infinity)) evBest = i;
    });
    const evLost = Math.max(0, (evs[evBest] ?? 0) - (evs[chosenIdx] ?? 0));
    const span = EV_SCORE_SPAN_POT_FRACTION * q.pot;
    const score = span > 0 ? Math.min(1, Math.max(0, 1 - evLost / span)) : evLost === 0 ? 1 : 0;
    return {
      grading: 'ev',
      score,
      band: bandForScore(score),
      headline:
        evLost === 0
          ? 'Best action — no EV lost'
          : `EV lost: ${evLost.toFixed(1)} chips (${((evLost / q.pot) * 100).toFixed(1)}% of pot)`,
      detail:
        'Graded by EV lost: this solve stores per-action EVs for this hand, so your pick was ' +
        'scored against the solver’s best action for this exact combo.',
      evLostChips: evLost,
      bestActionIdx: evBest,
    };
  }

  const score = Math.min(1, Math.max(0, chosenFreq));
  const band = bandForScore(score);
  return {
    grading: 'frequency',
    score,
    band,
    headline:
      band === 'solid'
        ? 'Matches the solver’s main line for this hand'
        : band === 'partial'
          ? 'A real part of the solver’s mix — but not its main line'
          : 'The solver rarely takes this action with this hand',
    detail:
      'Graded by frequency match: this solve stores the solver’s action frequencies per hand, ' +
      'not per-action EVs, so your score is how often the solver itself takes your pick with ' +
      'this exact hand. No EV-loss figure is shown, because the data cannot support one.',
    evLostChips: null,
    bestActionIdx: bestIdx,
  };
}

// ---------- Heuristic questions --------------------------------------------------

export interface HeuristicQuestion {
  kind: 'heuristic';
  itemKey: string;
  heuristicId: string;
  topic: QuizTopic;
  /** Context shown: a real solved spot's board when one matches, else the tags as text. */
  contextBoard: string[] | null;
  contextText: string;
  /** Option heuristic ids, shuffled; includes the correct one. */
  options: Heuristic[];
  correctId: string;
}

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export { shuffle };

/**
 * "Which heuristic applies here?" questions from the log. Only 'active'
 * heuristics are quiz material (candidates still 'testing' and retired
 * ones are excluded). Needs at least 2 active heuristics to offer a
 * choice. Each question's context is a real solved spot whose topic
 * matches the heuristic's tags on street + texture when one is
 * available in `spots`; otherwise the context is the tag description
 * itself (the question is then about the heuristic's stated trigger
 * conditions — labelled as such in contextText).
 */
export function buildHeuristicQuestions(
  heuristics: Heuristic[],
  spots: SpotQuestion[],
): HeuristicQuestion[] {
  const active = heuristics.filter((h) => h.status === 'active');
  if (active.length < 2) return [];
  const out: HeuristicQuestion[] = [];
  for (const h of active) {
    const topic: QuizTopic = {
      texture: h.tags.texture ?? 'unknown',
      street: h.tags.street ?? 'unknown',
      spot_type: h.tags.spot_type ?? 'unknown',
    };
    const match = spots.find(
      (s) =>
        s.topic.street === topic.street &&
        s.topic.texture === topic.texture &&
        s.topic.spot_type === topic.spot_type,
    );
    const distractors = shuffle(active.filter((x) => x.id !== h.id)).slice(0, 3);
    out.push({
      kind: 'heuristic',
      itemKey: `heuristic|${h.id}`,
      heuristicId: h.id,
      topic,
      contextBoard: match ? match.board : null,
      contextText: match
        ? `${match.solveName} — ${match.street}, ${topicLabel(topic)}`
        : `Spot type from the heuristic’s tags: ${topicLabel(topic)} (no solved spot with these exact tags is loaded)`,
      options: shuffle([h, ...distractors]),
      correctId: h.id,
    });
  }
  return out;
}

export function gradeHeuristicAnswer(q: HeuristicQuestion, chosenId: string): GradeResult {
  const correct = chosenId === q.correctId;
  return {
    grading: 'match',
    score: correct ? 1 : 0,
    band: correct ? 'solid' : 'miss',
    headline: correct
      ? 'Correct — that is the heuristic for this spot type'
      : 'Not the heuristic tagged for this spot type',
    detail:
      'Graded by recall: heuristic questions test whether you recognise which of your own ' +
      'rules applies — there is no solver EV behind this grade.',
    evLostChips: null,
    bestActionIdx: q.options.findIndex((o) => o.id === q.correctId),
  };
}

// ---------- Progress (server-persisted SRS state) ---------------------------------

export interface QuizItemState {
  kind: 'spot' | 'heuristic';
  topic: QuizTopic;
  level: number;
  due_at: string;
  attempts: number;
  score_sum: number;
  last_score: number | null;
  last_grading: GradingMode | null;
  last_at: string | null;
}

export interface QuizTopicStats {
  attempts: number;
  score_sum: number;
  last_at: string | null;
}

export interface QuizProgress {
  items: Record<string, QuizItemState>;
  topics: Record<string, QuizTopicStats>;
  intervalsDays: number[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseTopic(v: unknown): QuizTopic {
  const t = isRecord(v) ? v : {};
  return {
    texture: typeof t.texture === 'string' ? t.texture : 'unknown',
    street: typeof t.street === 'string' ? t.street : 'unknown',
    spot_type: typeof t.spot_type === 'string' ? t.spot_type : 'unknown',
  };
}

/** Parse a GET /api/quiz/progress body; null when unrecognisable. */
export function parseQuizProgress(body: unknown): QuizProgress | null {
  if (!isRecord(body) || !isRecord(body.items) || !isRecord(body.topics)) return null;
  const items: Record<string, QuizItemState> = {};
  for (const [key, raw] of Object.entries(body.items)) {
    if (!isRecord(raw)) continue;
    items[key] = {
      kind: raw.kind === 'heuristic' ? 'heuristic' : 'spot',
      topic: parseTopic(raw.topic),
      level: typeof raw.level === 'number' ? raw.level : 0,
      due_at: typeof raw.due_at === 'string' ? raw.due_at : new Date(0).toISOString(),
      attempts: typeof raw.attempts === 'number' ? raw.attempts : 0,
      score_sum: typeof raw.score_sum === 'number' ? raw.score_sum : 0,
      last_score: typeof raw.last_score === 'number' ? raw.last_score : null,
      last_grading:
        raw.last_grading === 'ev' || raw.last_grading === 'frequency' || raw.last_grading === 'match'
          ? raw.last_grading
          : null,
      last_at: typeof raw.last_at === 'string' ? raw.last_at : null,
    };
  }
  const topics: Record<string, QuizTopicStats> = {};
  for (const [key, raw] of Object.entries(body.topics)) {
    if (!isRecord(raw)) continue;
    topics[key] = {
      attempts: typeof raw.attempts === 'number' ? raw.attempts : 0,
      score_sum: typeof raw.score_sum === 'number' ? raw.score_sum : 0,
      last_at: typeof raw.last_at === 'string' ? raw.last_at : null,
    };
  }
  return {
    items,
    topics,
    intervalsDays: Array.isArray(body.intervals_days)
      ? body.intervals_days.filter((n): n is number => typeof n === 'number')
      : [0, 1, 2, 4, 7, 15, 30],
  };
}

/** Item keys whose review is due at `now` (from a progress snapshot). */
export function dueItemKeys(progress: QuizProgress, now: Date): Set<string> {
  const due = new Set<string>();
  for (const [key, item] of Object.entries(progress.items)) {
    if (new Date(item.due_at).getTime() <= now.getTime()) due.add(key);
  }
  return due;
}

/** Topics with enough attempts to judge, worst accuracy first. */
export function weakTopics(
  topics: Record<string, QuizTopicStats>,
  minAttempts = 2,
): { key: string; accuracy: number; attempts: number }[] {
  return Object.entries(topics)
    .filter(([, s]) => s.attempts >= minAttempts)
    .map(([key, s]) => ({ key, accuracy: s.attempts > 0 ? s.score_sum / s.attempts : 0, attempts: s.attempts }))
    .sort((a, b) => a.accuracy - b.accuracy);
}
