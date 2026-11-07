import { canonicalClass, parseCombo } from '../lib/cards';
import { comboEv, comboWeight, type SolveData, type SolveNode } from '../lib/solveTree';
import { actionColor, prettyAction } from './actionStyle';
import { CardRow } from './CardChip';
import { FrequencyBar, pctText } from './FrequencyBar';

interface Props {
  data: SolveData;
  node: SolveNode;
  combo: string | null;
}

/**
 * Detail for one combo at the current node: its exact per-action
 * frequencies from the solve JSON, its range weight, and its solve-level
 * EV (the engine reports per-combo EV for the whole solve, not per node).
 */
export function HandDetail({ data, node, combo }: Props) {
  if (!combo) {
    return (
      <p className="text-sm text-ink-faint">
        Pick a combo in the range grid to see exactly how the solver plays it here.
      </p>
    );
  }
  const cards = parseCombo(combo);
  const freqs = node.strategy[combo];
  const rowSum = freqs?.reduce((a, b) => a + b, 0) ?? 0;
  const ev = comboEv(data, node.player, combo);
  const weight = comboWeight(data, node.player, combo);

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        {cards ? <CardRow cards={cards} size="sm" /> : <span className="font-mono">{combo}</span>}
        <span className="rounded bg-navy-800 px-1.5 py-0.5 font-mono text-xs text-ink-dim">
          class {canonicalClass(combo)}
        </span>
      </div>
      <dl className="mt-2 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-md bg-navy-900 px-2 py-1.5">
          <dt className="text-ink-faint">Range weight</dt>
          <dd className="font-mono text-sm text-ink">{weight.toFixed(2)}</dd>
        </div>
        <div className="rounded-md bg-navy-900 px-2 py-1.5">
          <dt className="text-ink-faint">Solve EV (whole tree)</dt>
          <dd className="font-mono text-sm text-ink">{ev === null ? '—' : ev.toFixed(2)}</dd>
        </div>
      </dl>
      {rowSum === 0 ? (
        <p className="mt-2 text-sm text-ink-dim">
          This combo is blocked on this runout (it uses the river card) and has no strategy here.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {node.actions.map((label, i) => {
            const f = freqs?.[i] ?? 0;
            return (
              <li key={label}>
                <div className="flex items-baseline justify-between text-xs">
                  <span className="text-ink-dim">{prettyAction(label)}</span>
                  <span className="font-mono text-ink">{pctText(f)}</span>
                </div>
                <FrequencyBar fraction={f} color={actionColor(label)} height="h-2" />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
