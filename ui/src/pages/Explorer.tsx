import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AccuracyBadge, ApproximationBadge } from '../components/AccuracyBadge';
import { ActionList } from '../components/ActionList';
import { actionColor, prettyAction } from '../components/actionStyle';
import { CardRow } from '../components/CardChip';
import { HandDetail } from '../components/HandDetail';
import { PathBar } from '../components/PathBar';
import { RangeGrid } from '../components/RangeGrid';
import { RunoutPicker } from '../components/RunoutPicker';
import { parseCard } from '../lib/cards';
import { aggregateFrequencies, rangeEv } from '../lib/solveTree';
import { currentNodeOf, useStore } from '../store/useStore';

function terminalMessage(actionLabel: string): string {
  if (actionLabel === 'Fold') return 'Fold — the hand ends here.';
  if (actionLabel === 'Call') return 'Call — showdown. No further decisions on this line.';
  if (actionLabel === 'Check') return 'Check — showdown. No further decisions on this line.';
  return 'No further decision nodes on this line in this solve (the hand is all-in or complete).';
}

export function ExplorerPage() {
  const solve = useStore((s) => s.solve);
  const solveName = useStore((s) => s.solveName);
  const solveSource = useStore((s) => s.solveSource);
  const loadStatus = useStore((s) => s.loadStatus);
  const loadError = useStore((s) => s.loadError);
  const loadSample = useStore((s) => s.loadSample);
  const path = useStore((s) => s.path);
  const pendingRunout = useStore((s) => s.pendingRunout);
  const terminalAction = useStore((s) => s.terminalAction);
  const chooseAction = useStore((s) => s.chooseAction);
  const chooseRunout = useStore((s) => s.chooseRunout);
  const dismissRunout = useStore((s) => s.dismissRunout);
  const goToStep = useStore((s) => s.goToStep);
  const resetPath = useStore((s) => s.resetPath);

  const node = currentNodeOf(solve, path);
  const [colorActionIdx, setColorActionIdx] = useState(0);
  const [selectedCombo, setSelectedCombo] = useState<string | null>(null);

  useEffect(() => {
    if (loadStatus === 'idle') void loadSample();
  }, [loadStatus, loadSample]);

  const aggregates = useMemo(
    () => (solve && node ? aggregateFrequencies(solve, node) : []),
    [solve, node],
  );

  // On arriving at a new node, colour the grid by its most-taken action
  // and clear the combo selection (ranges differ per node).
  const nodeHistory = node?.history;
  useEffect(() => {
    setSelectedCombo(null);
    if (aggregates.length > 0) {
      let best = 0;
      aggregates.forEach((f, i) => {
        if (f > (aggregates[best] ?? 0)) best = i;
      });
      setColorActionIdx(best);
    } else {
      setColorActionIdx(0);
    }
  }, [nodeHistory, aggregates]);

  if (loadStatus === 'loading' || (loadStatus === 'idle' && !solve)) {
    return <p className="text-ink-dim">Loading solve…</p>;
  }
  if (!solve || !node) {
    return (
      <div className="rounded-lg border border-navy-700 bg-navy-900 p-4">
        <h1 className="text-lg font-semibold text-ink">No solve loaded</h1>
        <p className="mt-1 text-sm text-ink-dim">
          {loadError ?? 'Load the bundled sample or open a solve from the library.'}
        </p>
        <button
          type="button"
          onClick={() => void loadSample()}
          className="mt-3 rounded-md bg-table px-3 py-2 text-sm font-semibold text-white hover:bg-table-dark"
        >
          Load sample solve
        </button>
      </div>
    );
  }

  const riverCard = node.river_card ? parseCard(node.river_card) : null;
  const oopEv = rangeEv(solve, 'OOP');
  const ipEv = rangeEv(solve, 'IP');

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div>
          <h1 className="text-xl font-bold text-ink">{solveName}</h1>
          <p className="text-xs text-ink-faint">
            {solve.kind === 'turn' ? 'Turn solve (turn + river tree)' : 'River solve'} ·{' '}
            {solve.raw.iterations.toLocaleString()} iterations · pot {solve.raw.starting_pot} ·
            stacks {solve.raw.effective_stack}
            {solveSource === 'sample' ? ' · bundled fixture' : ''}
          </p>
        </div>
        <div className="ml-auto">
          <AccuracyBadge nashPct={solve.raw.exploitability.nash_distance_pct} />
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)_340px]">
        {/* Left: board + line */}
        <div className="flex flex-col gap-4">
          <section
            aria-label="Board"
            className="rounded-lg border border-navy-700 bg-navy-900 p-3 shadow-panel"
          >
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Board
            </h2>
            <div className="flex items-center gap-2">
              <CardRow cards={solve.boardCards} size="lg" />
              {riverCard ? (
                <span className="rounded-md ring-2 ring-accent">
                  <CardRow cards={[riverCard]} size="lg" />
                </span>
              ) : null}
            </div>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-md bg-navy-850 px-2 py-1.5">
                <dt className="text-ink-faint">Street</dt>
                <dd className="text-sm capitalize text-ink">{node.streetName}</dd>
              </div>
              <div className="rounded-md bg-navy-850 px-2 py-1.5">
                <dt className="text-ink-faint">To act</dt>
                <dd className="text-sm text-ink">{node.player}</dd>
              </div>
              <div className="rounded-md bg-navy-850 px-2 py-1.5">
                <dt className="text-ink-faint">Pot</dt>
                <dd className="font-mono text-sm text-ink">{node.pot.toFixed(1)}</dd>
              </div>
              <div className="rounded-md bg-navy-850 px-2 py-1.5">
                <dt className="text-ink-faint">To call</dt>
                <dd className="font-mono text-sm text-ink">{node.to_call.toFixed(1)}</dd>
              </div>
            </dl>
          </section>

          <section className="rounded-lg border border-navy-700 bg-navy-900 p-3 shadow-panel">
            <PathBar path={path} onGoTo={goToStep} onReset={resetPath} />
          </section>

          <section className="rounded-lg border border-navy-700 bg-navy-900 p-3 text-xs text-ink-dim shadow-panel">
            <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Badges
            </h2>
            <p className="flex flex-col gap-1.5">
              <span>
                <AccuracyBadge nashPct={solve.raw.exploitability.nash_distance_pct} /> measured
                against a best response — certified solver output.
              </span>
              <span>
                <ApproximationBadge /> guidance only (multiway lens, V2) — never a measured solve.
              </span>
            </p>
          </section>
        </div>

        {/* Centre: actions */}
        <section
          aria-label="Actions at this node"
          className="flex flex-col gap-3 rounded-lg border border-navy-700 bg-navy-900 p-3 shadow-panel"
        >
          <h2 className="text-sm font-semibold text-ink">
            {node.player} to act <span className="font-normal text-ink-dim">— pick an action to follow the line</span>
          </h2>

          {pendingRunout ? (
            <RunoutPicker options={pendingRunout} onPick={chooseRunout} onDismiss={dismissRunout} />
          ) : null}
          {terminalAction ? (
            <p className="rounded-lg border border-navy-700 bg-navy-850 px-3 py-2.5 text-sm text-ink">
              {terminalMessage(terminalAction)}{' '}
              <span className="text-ink-dim">Use the line on the left to step back.</span>
            </p>
          ) : null}

          <ActionList actions={node.actions} aggregates={aggregates} onChoose={chooseAction} />

          <div className="mt-auto rounded-lg bg-navy-850 px-3 py-2.5 text-xs text-ink-dim">
            <h3 className="mb-1 font-semibold uppercase tracking-wide text-ink-faint">
              Range EV (whole solve)
            </h3>
            <p className="font-mono text-sm text-ink">
              OOP {oopEv.toFixed(2)} · IP {ipEv.toFixed(2)}
            </p>
            <p className="mt-1">
              The engine reports EV per combo for the whole solve (see hand detail), not per
              action — frequencies above are the strategy. Bars show how often this node's range
              takes each action, weighted by combo weight.
            </p>
          </div>
        </section>

        {/* Right: range grid + hand detail */}
        <section
          aria-label="Range"
          className="flex flex-col gap-3 rounded-lg border border-navy-700 bg-navy-900 p-3 shadow-panel"
        >
          <div>
            <h2 className="text-sm font-semibold text-ink">{node.player} range</h2>
            <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Colour grid by action">
              {node.actions.map((label, i) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setColorActionIdx(i)}
                  aria-pressed={i === colorActionIdx}
                  className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs ${
                    i === colorActionIdx
                      ? 'bg-navy-800 font-semibold text-ink ring-1 ring-accent'
                      : 'text-ink-dim hover:bg-navy-800 hover:text-ink'
                  }`}
                >
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: actionColor(label) }}
                    aria-hidden="true"
                  />
                  {prettyAction(label)}
                </button>
              ))}
            </div>
          </div>

          <RangeGrid
            key={node.history}
            data={solve}
            node={node}
            colorActionIdx={colorActionIdx}
            selectedCombo={selectedCombo}
            onSelectCombo={setSelectedCombo}
          />

          <div className="border-t border-navy-700 pt-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Hand detail
            </h3>
            <HandDetail data={solve} node={node} combo={selectedCombo} />
          </div>
        </section>
      </div>

      <p className="text-xs text-ink-faint">
        Exploring is fully client-side: every number comes from the loaded solve — no re-solving,
        no waiting. Want a spot that isn't solved yet?{' '}
        <Link to="/solver" className="text-table-light underline hover:text-table">
          Run it in the Solver
        </Link>
        .
      </p>
    </div>
  );
}
