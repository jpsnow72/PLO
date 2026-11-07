import { parseCard } from '../lib/cards';
import type { RunoutOption } from '../lib/solveTree';
import { CardChip } from './CardChip';

interface Props {
  options: RunoutOption[];
  onPick: (card: string) => void;
  onDismiss: () => void;
}

/**
 * Chance-node picker: shown when an action closes the turn street and the
 * line continues into one river subtree per possible river card.
 */
export function RunoutPicker({ options, onPick, onDismiss }: Props) {
  return (
    <section
      aria-label="Choose the river card"
      className="rounded-lg border border-accent/60 bg-navy-900 p-3 shadow-panel"
    >
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">
          River card <span className="font-normal text-ink-dim">— the turn action closed the street</span>
        </h3>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded px-1.5 py-0.5 text-xs text-ink-dim hover:bg-navy-800 hover:text-ink"
        >
          Cancel
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {options.map((opt) => {
          const card = parseCard(opt.card);
          return (
            <button
              key={opt.card}
              type="button"
              onClick={() => onPick(opt.card)}
              className="rounded-md transition-transform hover:scale-110"
              aria-label={`River card ${opt.card}`}
            >
              {card ? <CardChip card={card} size="sm" /> : <span>{opt.card}</span>}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-ink-faint">
        {options.length} possible runouts in this solve. Each was solved exactly — pick any card to
        keep walking the tree.
      </p>
    </section>
  );
}
