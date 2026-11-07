import { actionColor, prettyAction } from './actionStyle';
import { FrequencyBar, pctText } from './FrequencyBar';

interface Props {
  actions: string[];
  /** Range-aggregate frequency per action (from the solve JSON). */
  aggregates: number[];
  onChoose: (actionLabel: string) => void;
}

/**
 * Centre column: the actions available at the current node, with the
 * range-aggregate frequency of each. Clicking an action descends the tree
 * (or opens the runout picker / terminal note, handled by the store).
 */
export function ActionList({ actions, aggregates, onChoose }: Props) {
  return (
    <div className="flex flex-col gap-2">
      {actions.map((label, i) => {
        const freq = aggregates[i] ?? 0;
        return (
          <button
            key={label}
            type="button"
            onClick={() => onChoose(label)}
            className="group rounded-lg border border-navy-700 bg-navy-900 px-3 py-2.5 text-left shadow-panel transition-colors hover:border-table hover:bg-navy-800"
            aria-label={`${prettyAction(label)}, taken ${pctText(freq)} of the time by this range. Activate to follow this line.`}
          >
            <span className="flex items-baseline justify-between gap-2">
              <span className="font-semibold text-ink">{prettyAction(label)}</span>
              <span className="font-mono text-sm text-ink-dim">{pctText(freq)}</span>
            </span>
            <span className="mt-1.5 block">
              <FrequencyBar fraction={freq} color={actionColor(label)} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
