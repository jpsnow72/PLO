// Deterministic explain-why for one decision node, computed ONLY from
// the loaded solve's stored data. No LLM, no generic poker advice:
// every sentence below is backed by a number this module computed from
// the node's strategy rows, the solve's per-combo weights/EVs, or the
// node's own pot/to-call fields. If a factor cannot be computed from
// the stored data, it does not appear — most notably, per-action EVs
// are NOT stored by the engine, so this module never quotes an EV gap
// between two actions at a node. What it can honestly report about
// "stakes" is labelled as such (mix concentration, solve-level EV
// split, the solve's measured Nash distance).
//
// Factor inventory (each with its data source):
//   1. Dominant line      — range-aggregate frequencies
//      (aggregateFrequencies: strategy rows weighted by range weights).
//   2. Mix concentration  — the dominant action's aggregate share.
//   3. Combo line         — the selected combo's own strategy row:
//      its dominant action and whether it agrees with the range's.
//   4. Range EV split     — whole-solve per-combo EVs (rangeEv),
//      labelled whole-solve every time it is shown.
//   5. Pot context        — node.pot / node.to_call arithmetic
//      (break-even equity when facing a bet). Pure arithmetic on
//      stored numbers; stated as arithmetic, not advice.
//   6. Blockers           — (selected combo only) the share of the
//      opponent's range weight, from the solve's weight table, whose
//      combos share a card with the selected combo and so cannot be
//      held against it.
//   7. Accuracy bound     — the solve's measured Nash distance.
//
// The candidate heuristic follows the spec format —
//   "On [texture] in [spot], [action] is favoured because [measured
//   factor]"
// — and is always badged CANDIDATE in the UI: it is a pattern read off
// ONE node, not a solver claim.

import { parseCombo } from './cards';
import { prettyAction } from '../components/actionStyle';
import {
  aggregateFrequencies,
  comboEv,
  rangeEv,
  type SolveData,
  type SolveNode,
} from './solveTree';
import { boardFamilies, FAMILY_LABEL, type TextureFamily } from './texture';
import { boardAtNode, topicForNode, type QuizTopic } from './quiz';

export interface ExplanationFactor {
  label: string;
  detail: string;
}

export interface NodeExplanation {
  /** One-sentence headline: the dominant line and its share. */
  headline: string;
  factors: ExplanationFactor[];
  /** Spot descriptor used in the heuristic, e.g. "on the river, facing a bet". */
  spotLabel: string;
  textureLabel: string;
  topic: QuizTopic;
  dominantAction: string;
  dominantShare: number;
  /** Candidate heuristic sentence, or null when the node has no usable data. */
  candidateHeuristic: string | null;
  /** True when the node carried no live strategy rows (nothing to explain). */
  empty: boolean;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

function textureOf(data: SolveData, node: SolveNode): { key: string; label: string } {
  const families = boardFamilies(boardAtNode(data, node).join(' '));
  const key = families[0] ?? 'dry';
  return { key, label: FAMILY_LABEL[key as TextureFamily] ?? key };
}

function spotOf(node: SolveNode): string {
  const facing = node.to_call > 0;
  return facing
    ? `on the ${node.streetName}, facing a bet of ${node.to_call.toFixed(0)}`
    : `on the ${node.streetName}, first to act`;
}

export function explainNode(
  data: SolveData,
  node: SolveNode,
  combo: string | null,
): NodeExplanation {
  const topic = topicForNode(data, node);
  const texture = textureOf(data, node);
  const spotLabel = spotOf(node);
  const aggregates = aggregateFrequencies(data, node);

  let dominantIdx = -1;
  let dominantShare = 0;
  aggregates.forEach((f, i) => {
    if (f > dominantShare) {
      dominantShare = f;
      dominantIdx = i;
    }
  });

  if (dominantIdx === -1 || dominantShare <= 0) {
    return {
      headline: 'No live strategy data at this node.',
      factors: [
        {
          label: 'No data',
          detail:
            'Every combo in this range is blocked or has a zero strategy row here, so there ' +
            'is nothing the solver can be said to favour. No explanation is generated.',
        },
      ],
      spotLabel,
      textureLabel: texture.label,
      topic,
      dominantAction: '',
      dominantShare: 0,
      candidateHeuristic: null,
      empty: true,
    };
  }

  const dominantAction = node.actions[dominantIdx] ?? '';
  const factors: ExplanationFactor[] = [];

  // 1 + 2. Dominant line and how concentrated the mix is.
  const concentration =
    dominantShare >= 0.9
      ? 'nearly pure — one line, taken almost always; the decision here is close to forced'
      : dominantShare >= 0.6
        ? 'a clear favourite, with a real minority taking another line'
        : dominantShare >= 0.4
          ? 'the most common line, but the solver mixes substantially — no single action dominates'
          : 'a genuine mix — the solver spreads this range across lines, so any single “answer” misstates the strategy';
  factors.push({
    label: 'Dominant line',
    detail:
      `${node.player}’s range takes ${prettyAction(dominantAction)} ${pct(dominantShare)} of the ` +
      `time at this node (weighted by combo weight). That share makes it ${concentration}.`,
  });

  // 3. Selected combo's own line.
  if (combo) {
    const row = node.strategy[combo];
    const rowSum = row?.reduce((a, b) => a + b, 0) ?? 0;
    if (row && rowSum > 0) {
      let cBest = 0;
      row.forEach((f, i) => {
        if (f > (row[cBest] ?? 0)) cBest = i;
      });
      const cAction = node.actions[cBest] ?? '';
      const cShare = row[cBest] ?? 0;
      const agrees = cBest === dominantIdx;
      const comboNote =
        `With ${combo}, the solver takes ${prettyAction(cAction)} ${pct(cShare)} of the time` +
        (agrees
          ? ' — the same line the range as a whole favours.'
          : ` — unlike the range as a whole, which favours ${prettyAction(dominantAction)}. ` +
            'This hand is played differently from the average of the range.');
      factors.push({ label: 'This hand', detail: comboNote });
      const ev = comboEv(data, node.player, combo);
      if (ev !== null) {
        factors.push({
          label: 'This hand’s solve EV',
          detail:
            `${combo} is worth ${ev.toFixed(1)} chips under the solver’s strategy across the ` +
            'whole solve (the engine reports EV per combo for the full tree, not per action — ' +
            'so no per-action EV gap is quoted anywhere in this panel).',
        });
      }
    }
  }

  // 4. Whole-solve range EV split (labelled as solve-level).
  const oopEv = rangeEv(data, 'OOP');
  const ipEv = rangeEv(data, 'IP');
  const edge = Math.abs(oopEv - ipEv);
  if (edge > 0.005) {
    const leader = oopEv > ipEv ? 'OOP' : 'IP';
    factors.push({
      label: 'Range EV (whole solve)',
      detail:
        `Across the whole solve, ${leader}’s range holds the EV edge: OOP ${oopEv.toFixed(1)} ` +
        `vs IP ${ipEv.toFixed(1)} chips on average. That is a solve-level number, not a ` +
        'measurement of this node alone.',
    });
  }

  // 5. Pot context (arithmetic on the node's stored fields).
  if (node.to_call > 0) {
    const breakeven = node.to_call / (node.pot + node.to_call);
    factors.push({
      label: 'Price being offered',
      detail:
        `Facing ${node.to_call.toFixed(0)} to call into a pot of ${node.pot.toFixed(0)}: a ` +
        `call-or-fold decision breaks even at ${(breakeven * 100).toFixed(0)}% equity. ` +
        'That is arithmetic on this node’s pot fields, not a recommendation.',
    });
  } else {
    factors.push({
      label: 'Price being offered',
      detail:
        `No bet to face (pot ${node.pot.toFixed(0)}): checking is free, so every bet here is ` +
        'a voluntary investment rather than a price the solver is being offered.',
    });
  }

  // 6. Blockers for the selected combo.
  if (combo) {
    const cards = parseCombo(combo);
    if (cards) {
      const heroLabels = new Set(cards.map((c) => c.label));
      const opp = node.player === 'OOP' ? 'IP' : 'OOP';
      const oppWeights = data.weights[opp];
      let total = 0;
      let blocked = 0;
      let blockedCount = 0;
      for (const [oppCombo, w] of oppWeights) {
        total += w;
        const oppCards = oppCombo.split(/[\s,]+/).filter((t) => t.length > 0);
        if (oppCards.some((t) => heroLabels.has(t))) {
          blocked += w;
          blockedCount += 1;
        }
      }
      if (total > 0 && blockedCount > 0) {
        factors.push({
          label: 'Blockers',
          detail:
            `Holding ${combo} removes ${blockedCount} of ${opp}’s combos outright — ` +
            `${pct(blocked / total)} of ${opp}’s range by weight can never be held against ` +
            'this exact hand. (Counted from the solve’s range tables.)',
        });
      }
    }
  }

  // 7. Accuracy bound.
  factors.push({
    label: 'Accuracy',
    detail:
      `This solve’s strategy is certified to a Nash distance of ` +
      `${data.raw.exploitability.nash_distance_pct.toFixed(3)}% of pot by the engine’s ` +
      'best-response checker, so the frequencies above are that accurate — the explanation ' +
      'inherits that bound and claims nothing finer.',
  });

  const headline =
    `${node.player} to act ${spotLabel}: ${prettyAction(dominantAction)} leads at ` +
    `${pct(dominantShare)} of the range.`;

  const candidateHeuristic =
    `On ${texture.label.toLowerCase()} in ${spotLabel}, ${prettyAction(dominantAction)} is ` +
    `favoured because the solver takes it with ${pct(dominantShare)} of this range ` +
    `(measured at this node of a solve certified to ${data.raw.exploitability.nash_distance_pct.toFixed(3)}% Nash).`;

  return {
    headline,
    factors,
    spotLabel,
    textureLabel: texture.label,
    topic,
    dominantAction,
    dominantShare,
    candidateHeuristic,
    empty: false,
  };
}
