import { useMemo } from 'react';
import type { Card } from '../lib/cards';
import {
  lineMoney,
  rangePresence,
  type RangePresence,
  type SolveData,
  type SolveNode,
} from '../lib/solveTree';
import type { Player } from '../lib/types';
import type { PathStep } from '../store/useStore';
import { CardBack, CardRow } from './CardChip';

interface Props {
  solve: SolveData;
  node: SolveNode;
  path: PathStep[];
  /** Board cards dealt at the current node (flop + any runouts taken). */
  boardCards: Card[];
  /** Set when the line just taken ends the hand at this node. */
  terminalAction: string | null;
  /** Street of the pending chance node, when a runout choice is outstanding. */
  pendingStreet: 'turn' | 'river' | null;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? `${n}` : n.toFixed(1);
}

function fmtShare(share: number): string {
  return `${(share * 100).toFixed(1).replace(/\.0$/, '')}%`;
}

function Seat({
  player,
  stack,
  committed,
  presence,
  toAct,
}: {
  player: Player;
  stack: number;
  committed: number;
  presence: RangePresence;
  toAct: boolean;
}) {
  return (
    <div
      role="group"
      className={`z-10 flex w-64 max-w-[85%] flex-col items-center gap-1.5 rounded-lg border px-3 py-2 shadow-panel ${
        toAct ? 'border-table bg-navy-800 ring-2 ring-table' : 'border-navy-700 bg-navy-900'
      }`}
      aria-label={`${player}${toAct ? ', to act' : ''}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold tracking-wide text-ink">{player}</span>
        {toAct ? (
          <span className="rounded-full bg-table px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
            To act
          </span>
        ) : null}
      </div>
      {/* The player's hand is a range, never known cards: four face-down
          backs stand for the four unknown cards of a PLO hand. */}
      <span className="inline-flex gap-1" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <CardBack key={i} size="sm" />
        ))}
      </span>
      <p className="num text-center font-mono text-[11px] leading-relaxed text-ink-dim">
        Stack {fmt(stack)} · In pot {fmt(committed)}
        <br />
        {presence.combos} combos · {fmtShare(presence.share)} of range
      </p>
    </div>
  );
}

/**
 * Table view (rebrand slice 2, issue #14): the current node drawn as a
 * poker table, in the pattern of the captured reference — a nameplate
 * per player with their stack, the pot and board in the middle, the
 * player to act highlighted. Every figure is the solve payload's own:
 * the pot is the node's pot; stacks and in-pot amounts are derived from
 * the payload's pot figures along the line taken (see lineMoney); range
 * summaries are reach-weighted from the stored strategy rows (see
 * rangePresence). Hole cards are never shown — a seat's four backs are
 * the player's unknown hand, and the combo count beside them is the
 * range that is actually known.
 */
export function TableView({ solve, node, path, boardCards, terminalAction, pendingStreet }: Props) {
  const money = useMemo(() => lineMoney(solve, path), [solve, path]);
  const presence = useMemo(
    () => ({ OOP: rangePresence(solve, path, 'OOP'), IP: rangePresence(solve, path, 'IP') }),
    [solve, path],
  );
  const handOver = terminalAction !== null;

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex w-full flex-col items-center">
        <Seat
          player="OOP"
          stack={money.stackBehind.OOP}
          committed={money.committed.OOP}
          presence={presence.OOP}
          toAct={!handOver && node.player === 'OOP'}
        />
        {/* The felt: oval table in our palette — card-table green felt in
            a deep-navy rim. Board and pot live in the middle. */}
        <div
          className="-my-5 w-full max-w-2xl rounded-[50%] border-[10px] border-navy-800"
          style={{
            background: 'radial-gradient(ellipse at center, #2E9E6B 0%, #248457 72%)',
            boxShadow: 'inset 0 0 0 2px rgba(10,22,40,0.55), inset 0 0 44px rgba(10,22,40,0.45)',
          }}
        >
          <div className="flex flex-col items-center gap-2 px-6 py-9">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-white/70">
              {node.streetName}
              {pendingStreet ? ` · ${pendingStreet} card next` : ''}
            </span>
            <CardRow cards={boardCards} size="lg" />
            <p className="num font-mono text-lg font-bold text-white">
              Pot {fmt(node.pot)}
            </p>
            <p className="num font-mono text-[11px] text-white/75">
              {handOver
                ? `Line ends: ${terminalAction}`
                : node.to_call > 0
                  ? `${node.player} to call ${fmt(node.to_call)}`
                  : 'No bet to face'}
            </p>
          </div>
        </div>
        <Seat
          player="IP"
          stack={money.stackBehind.IP}
          committed={money.committed.IP}
          presence={presence.IP}
          toAct={!handOver && node.player === 'IP'}
        />
      </div>

      {pendingStreet && !handOver ? (
        <p className="text-center text-xs text-ink-dim">
          The street closed — pick the {pendingStreet} card above to keep walking the line.
        </p>
      ) : null}
      <p className="max-w-xl text-center text-xs text-ink-faint">
        Stacks and in-pot amounts are derived from the solve's own pot figures along the line you
        took; the starting pot is pre-solve money and is not split between the players. A seat's
        combo count is the share of that player's range that can still be held at this node —
        hole cards themselves are never known in Explore mode.
      </p>
    </div>
  );
}
