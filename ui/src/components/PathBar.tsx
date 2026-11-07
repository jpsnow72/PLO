import type { PathStep } from '../store/useStore';

interface Props {
  path: PathStep[];
  onGoTo: (index: number) => void;
  onReset: () => void;
}

/** Breadcrumb of the line taken so far; click any step to jump back to it. */
export function PathBar({ path, onGoTo, onReset }: Props) {
  return (
    <nav aria-label="Line taken" className="flex flex-col gap-1">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Line</h3>
        <button
          type="button"
          onClick={onReset}
          className="rounded px-1.5 py-0.5 text-xs text-ink-dim hover:bg-navy-800 hover:text-ink"
        >
          Reset
        </button>
      </div>
      <ol className="flex flex-col gap-1">
        {path.map((step, i) => {
          const isCurrent = i === path.length - 1;
          return (
            <li key={`${step.nodeHistory}-${i}`}>
              <button
                type="button"
                onClick={() => onGoTo(i)}
                aria-current={isCurrent ? 'true' : undefined}
                className={`w-full rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
                  isCurrent
                    ? 'bg-navy-800 font-semibold text-ink ring-1 ring-table'
                    : 'text-ink-dim hover:bg-navy-800 hover:text-ink'
                }`}
              >
                <span className="mr-1.5 text-ink-faint">{i + 1}.</span>
                {step.label}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
