import { parseCard } from '../lib/cards';
import type { SolveData } from '../lib/solveTree';
import type { PathStep } from '../store/useStore';
import { CardRow } from './CardChip';

interface Props {
  solve: SolveData;
  path: PathStep[];
  /** Street of the pending chance node, when a runout choice is outstanding. */
  pendingStreet: 'turn' | 'river' | null;
  onGoTo: (index: number) => void;
  onPendingClick: () => void;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Horizontal strip of node cards replacing the old vertical line list:
 * a board card, then one card per node on the current path (position to
 * act, the action/runout that led there, pot and amount to call — all
 * straight from the solve payload). The current node is outlined green;
 * clicking any card jumps back to it. When a runout choice is pending, a
 * dashed "pick a card" card trails the strip and reopens the picker.
 */
export function NodeStrip({ solve, path, pendingStreet, onGoTo, onPendingClick }: Props) {
  const currentNode = solve.nodesByHistory.get(path[path.length - 1]?.nodeHistory ?? 'root');

  const boardCards = [...solve.boardCards];
  if (currentNode?.turn_card) {
    const c = parseCard(currentNode.turn_card);
    if (c) boardCards.push(c);
  }
  if (currentNode?.river_card) {
    const c = parseCard(currentNode.river_card);
    if (c) boardCards.push(c);
  }

  return (
    <div
      className="flex gap-2 overflow-x-auto pb-1"
      role="navigation"
      aria-label="Line taken — node strip"
    >
      {/* Board card */}
      <div className="flex w-44 shrink-0 flex-col justify-between rounded-lg border border-navy-700 bg-navy-900 px-3 py-2 shadow-panel">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
          Board · {currentNode ? capitalize(currentNode.streetName) : ''}
        </span>
        <span className="mt-1.5">
          <CardRow cards={boardCards} size="sm" />
        </span>
      </div>

      {path.map((step, i) => {
        const node = solve.nodesByHistory.get(step.nodeHistory);
        const isCurrent = i === path.length - 1;
        return (
          <button
            key={`${step.nodeHistory}-${i}`}
            type="button"
            onClick={() => onGoTo(i)}
            aria-current={isCurrent ? 'true' : undefined}
            className={`flex w-44 shrink-0 flex-col justify-between rounded-lg border px-3 py-2 text-left shadow-panel transition-colors ${
              isCurrent
                ? 'border-table bg-navy-800 ring-2 ring-table'
                : 'border-navy-700 bg-navy-900 hover:border-navy-600 hover:bg-navy-800'
            }`}
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">
                {node ? `${capitalize(node.streetName)} · ${node.player} to act` : 'Node'}
              </span>
              <span className="text-[10px] text-ink-faint">{i + 1}</span>
            </span>
            <span className={`mt-1 text-sm ${isCurrent ? 'font-semibold text-ink' : 'text-ink-dim'}`}>
              {step.kind === 'root' ? 'Start of hand' : step.label}
            </span>
            {node ? (
              <span className="num mt-1 font-mono text-[11px] text-ink-faint">
                Pot {node.pot.toFixed(1)}
                {node.to_call > 0 ? ` · to call ${node.to_call.toFixed(1)}` : ''}
              </span>
            ) : null}
          </button>
        );
      })}

      {pendingStreet ? (
        <button
          type="button"
          onClick={onPendingClick}
          className="flex w-44 shrink-0 flex-col justify-between rounded-lg border border-dashed border-accent/70 bg-navy-900 px-3 py-2 text-left shadow-panel transition-colors hover:bg-navy-800"
          aria-label={`Pick the ${pendingStreet} card`}
        >
          <span className="text-[10px] font-semibold uppercase tracking-wide text-accent">
            {capitalize(pendingStreet)} card
          </span>
          <span className="mt-1 text-sm font-semibold text-ink">Pick a card →</span>
          <span className="mt-1 text-[11px] text-ink-faint">Street closed — deal the next card</span>
        </button>
      ) : null}
    </div>
  );
}
