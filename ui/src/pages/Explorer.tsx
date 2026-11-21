import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AccuracyBadge, ApproximationBadge } from '../components/AccuracyBadge';
import { SampledChip } from '../components/SampledChip';
import { ActionList } from '../components/ActionList';
import { BlockersView } from '../components/BlockersView';
import { CardPicker } from '../components/CardPicker';
import { CardRow } from '../components/CardChip';
import { ExplainPanel } from '../components/ExplainPanel';
import { HandDetail } from '../components/HandDetail';
import { LinkToHeuristic } from '../components/LinkToHeuristic';
import { MultiwayLens } from '../components/MultiwayLens';
import { NodeStrip } from '../components/NodeStrip';
import { CategoriesRail, EvBucketsRail } from '../components/RailInsights';
import { RangeGrid } from '../components/RangeGrid';
import { RangesView } from '../components/RangesView';
import { ShortcutsHelp } from '../components/ShortcutsHelp';
import { StrategyTables } from '../components/StrategyTables';
import { TableView } from '../components/TableView';
import { parseCard } from '../lib/cards';
import { sampledInfo } from '../lib/sampled';
import { aggregateFrequencies, rangeEv } from '../lib/solveTree';
import { useExplorerHotkeys } from '../lib/useExplorerHotkeys';
import { currentNodeOf, useStore } from '../store/useStore';

function terminalMessage(actionLabel: string): string {
  if (actionLabel === 'Fold') return 'Fold — the hand ends here.';
  if (actionLabel === 'Call') return 'Call — showdown. No further decisions on this line.';
  if (actionLabel === 'Check') return 'Check — showdown. No further decisions on this line.';
  return 'No further decision nodes on this line in this solve (the hand is all-in or complete).';
}

type ExplorerView = 'strategy' | 'matrix' | 'table' | 'ranges' | 'blockers';

export function ExplorerPage() {
  const solve = useStore((s) => s.solve);
  const solveName = useStore((s) => s.solveName);
  const solveSource = useStore((s) => s.solveSource);
  const solveId = useStore((s) => s.solveId);
  const solveRangeExpansion = useStore((s) => s.solveRangeExpansion);
  const loadStatus = useStore((s) => s.loadStatus);
  const loadError = useStore((s) => s.loadError);
  const loadSample = useStore((s) => s.loadSample);
  const path = useStore((s) => s.path);
  const pendingRunout = useStore((s) => s.pendingRunout);
  const terminalAction = useStore((s) => s.terminalAction);
  const chooseAction = useStore((s) => s.chooseAction);
  const chooseRunout = useStore((s) => s.chooseRunout);
  const goToStep = useStore((s) => s.goToStep);
  const resetPath = useStore((s) => s.resetPath);
  const setTrainerFocus = useStore((s) => s.setTrainerFocus);
  const navigate = useNavigate();

  const node = currentNodeOf(solve, path);
  const [selectedCombo, setSelectedCombo] = useState<string | null>(null);
  const [view, setView] = useState<ExplorerView>('strategy');
  const [pickerDismissed, setPickerDismissed] = useState(false);

  // Keyboard navigation: ←/→ walk the line, 1–5 take an action
  // (issue #25). The hook guards itself (typing, open picker,
  // modifiers) and owns the forward-history stack.
  useExplorerHotkeys();

  useEffect(() => {
    if (loadStatus === 'idle') void loadSample();
  }, [loadStatus, loadSample]);

  // A fresh runout choice reopens the card picker (it may have been
  // dismissed at the previous chance node).
  useEffect(() => {
    if (pendingRunout) setPickerDismissed(false);
  }, [pendingRunout]);

  const aggregates = useMemo(
    () => (solve && node ? aggregateFrequencies(solve, node) : []),
    [solve, node],
  );

  // On arriving at a new node, clear the combo selection (ranges
  // differ per node). The matrix is keyed by node history, so its own
  // lock/filter state resets the same way.
  const nodeHistory = node?.history;
  useEffect(() => {
    setSelectedCombo(null);
  }, [nodeHistory]);

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

  const turnCard = node.turn_card ? parseCard(node.turn_card) : null;
  const riverCard = node.river_card ? parseCard(node.river_card) : null;
  const currentBoardCards = [
    ...solve.boardCards,
    ...(turnCard ? [turnCard] : []),
    ...(riverCard ? [riverCard] : []),
  ];
  const nodeRangeText = Object.entries(node.strategy)
    .filter(([, freqs]) => freqs.reduce((a, b) => a + b, 0) > 0)
    .map(([combo]) => {
      const w = solve.weights[node.player].get(combo) ?? 1;
      return `${combo}:${w}`;
    })
    .join('\n');
  const oopEv = rangeEv(solve, 'OOP');
  const ipEv = rangeEv(solve, 'IP');
  const sampled = sampledInfo(solveRangeExpansion);
  const pendingStreet = pendingRunout?.[0]?.street ?? null;
  const potOddsPct = node.to_call > 0 ? (node.to_call / (node.pot + node.to_call)) * 100 : null;

  // Cards that can never be dealt at the pending chance node.
  const pickerDeadCards = [
    ...solve.boardCards.map((c) => c.label),
    ...(pendingStreet === 'river' && node.turn_card ? [node.turn_card] : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div>
          <h1 className="text-xl font-bold text-ink">{solveName}</h1>
          <p className="text-xs text-ink-faint">
            {solve.kind === 'flop'
              ? 'Flop solve (flop + turn + river tree)'
              : solve.kind === 'turn'
                ? 'Turn solve (turn + river tree)'
                : 'River solve'}{' '}
            ·{' '}
            {solve.raw.iterations.toLocaleString()} iterations · pot {solve.raw.starting_pot} ·
            stacks {solve.raw.effective_stack}
            {solveSource === 'sample' ? ' · bundled fixture' : ''}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {sampled ? <SampledChip info={sampled} /> : null}
          <AccuracyBadge nashPct={solve.raw.exploitability.nash_distance_pct} />
        </div>
      </header>

      {/* Node strip: the line so far, one card per node */}
      <NodeStrip
        solve={solve}
        path={path}
        pendingStreet={pendingStreet}
        onGoTo={goToStep}
        onPendingClick={() => setPickerDismissed(false)}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* Centre: action chooser + strategy / matrix views */}
        <section
          aria-label="Actions at this node"
          className="flex flex-col gap-3 rounded-lg border border-navy-700 bg-navy-900 p-3 shadow-panel"
        >
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-ink">
              {node.player} to act{' '}
              <span className="font-normal text-ink-dim">— pick an action to follow the line</span>
            </h2>
            <span className="ml-auto flex items-center gap-1">
              <ShortcutsHelp />
              <button
                type="button"
                onClick={resetPath}
                className="rounded px-1.5 py-0.5 text-xs text-ink-dim hover:bg-navy-800 hover:text-ink"
              >
                Reset line
              </button>
              <button
                type="button"
                disabled={node.actions.length < 2 || (solveSource !== 'sample' && !solveId)}
                title={
                  node.actions.length < 2
                    ? 'This node has no decision to drill'
                    : 'Drill this exact node in the Quiz Trainer — hands are dealt from this node’s range and graded against its strategy'
                }
                onClick={() => {
                  setTrainerFocus({
                    kind: 'spot',
                    solveId: solveSource === 'sample' || !solveId ? 'sample' : solveId,
                    solveName,
                    solveSource: solveSource ?? 'sample',
                    history: node.history,
                  });
                  navigate('/quiz');
                }}
                className="rounded bg-navy-800 px-2 py-0.5 text-xs font-semibold text-table-light ring-1 ring-navy-600 hover:bg-navy-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Practice this spot
              </button>
            </span>
          </div>

          {terminalAction ? (
            <p className="rounded-lg border border-navy-700 bg-navy-850 px-3 py-2.5 text-sm text-ink">
              {terminalMessage(terminalAction)}{' '}
              <span className="text-ink-dim">Use the node strip above to step back.</span>
            </p>
          ) : null}
          {pendingRunout && pickerDismissed ? (
            <p className="rounded-lg border border-accent/60 bg-navy-850 px-3 py-2.5 text-sm text-ink">
              The street closed — a {pendingStreet} card comes next.{' '}
              <button
                type="button"
                onClick={() => setPickerDismissed(false)}
                className="font-semibold text-table-light underline"
              >
                Pick the {pendingStreet} card
              </button>
            </p>
          ) : null}

          <ActionList actions={node.actions} aggregates={aggregates} onChoose={chooseAction} />

          {/* View tabs: Strategy / Matrix / Table / Ranges / Blockers */}
          <div className="mt-1 flex gap-1.5 border-b border-navy-700" role="tablist" aria-label="Explorer views">
            {(
              [
                { key: 'strategy', label: 'Strategy' },
                { key: 'matrix', label: 'Matrix' },
                { key: 'table', label: 'Table' },
                { key: 'ranges', label: 'Ranges' },
                { key: 'blockers', label: 'Blockers' },
              ] as { key: ExplorerView; label: string }[]
            ).map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={view === t.key}
                onClick={() => setView(t.key)}
                className={`rounded-t-md px-3 py-1.5 text-sm ${
                  view === t.key
                    ? 'bg-navy-800 font-semibold text-ink ring-1 ring-navy-700'
                    : 'text-ink-dim hover:bg-navy-800 hover:text-ink'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {view === 'strategy' ? (
            <StrategyTables
              key={node.history}
              data={solve}
              node={node}
              aggregates={aggregates}
              selectedCombo={selectedCombo}
              onSelectCombo={setSelectedCombo}
            />
          ) : view === 'matrix' ? (
            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold text-ink">{node.player} range</h3>
              <RangeGrid
                key={node.history}
                data={solve}
                node={node}
                selectedCombo={selectedCombo}
                onSelectCombo={setSelectedCombo}
              />
            </div>
          ) : view === 'table' ? (
            <TableView
              key={node.history}
              solve={solve}
              node={node}
              path={path}
              boardCards={currentBoardCards}
              terminalAction={terminalAction}
              pendingStreet={pendingStreet}
            />
          ) : view === 'ranges' ? (
            <RangesView
              key={node.history}
              data={solve}
              node={node}
              path={path}
              boardCards={currentBoardCards}
              selectedCombo={selectedCombo}
              onSelectCombo={setSelectedCombo}
            />
          ) : (
            // Blockers is keyed by solve, not by node: the picked hand
            // is hero's holding for the whole hand, so it survives
            // walking the tree; every number still re-derives per node
            // from props. A new solve remounts with an empty hand.
            <BlockersView
              key={solveId ?? solveName}
              data={solve}
              node={node}
              path={path}
              boardCards={currentBoardCards}
            />
          )}
        </section>

        {/* Right rail: node overview, accuracy, hand detail, study tools */}
        <div className="flex flex-col gap-4">
          <section
            aria-label="Node overview"
            className="rounded-lg border border-navy-700 bg-navy-900 p-3 shadow-panel"
          >
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Node overview
            </h2>
            <div className="mb-3 flex flex-wrap gap-1.5" aria-label="Positions and stacks">
              {(['OOP', 'IP'] as const).map((p) => (
                <span
                  key={p}
                  className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${
                    node.player === p
                      ? 'bg-navy-800 font-semibold text-ink ring-1 ring-table'
                      : 'text-ink-dim ring-1 ring-navy-700'
                  }`}
                >
                  {p}
                  <span className="num font-mono text-ink-faint">
                    stack {solve.raw.effective_stack}
                  </span>
                  {node.player === p ? <span className="text-table-light">· to act</span> : null}
                </span>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <CardRow cards={solve.boardCards} size="lg" />
              {turnCard ? (
                <span className="rounded-md ring-2 ring-table" title="Turn card">
                  <CardRow cards={[turnCard]} size="lg" />
                </span>
              ) : null}
              {riverCard ? (
                <span className="rounded-md ring-2 ring-accent" title="River card">
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
                <dd className="num font-mono text-sm text-ink">{node.pot.toFixed(1)}</dd>
              </div>
              <div className="rounded-md bg-navy-850 px-2 py-1.5">
                <dt className="text-ink-faint">To call</dt>
                <dd className="num font-mono text-sm text-ink">{node.to_call.toFixed(1)}</dd>
              </div>
              {potOddsPct !== null ? (
                <div className="rounded-md bg-navy-850 px-2 py-1.5">
                  <dt className="text-ink-faint">Pot odds</dt>
                  <dd className="num font-mono text-sm text-ink">{potOddsPct.toFixed(1)}%</dd>
                </div>
              ) : null}
              <div className="rounded-md bg-navy-850 px-2 py-1.5">
                <dt className="text-ink-faint">Range EV (whole solve)</dt>
                <dd className="num font-mono text-sm text-ink">
                  OOP {oopEv.toFixed(2)} · IP {ipEv.toFixed(2)}
                </dd>
              </div>
            </dl>
            <p className="mt-2 text-xs text-ink-faint">
              Pot odds are the call amount over the pot after calling, from this node's own pot /
              to-call figures. Range EV is the whole solve's weighted per-combo EV — the engine
              reports EV per combo for the whole solve, not per action.
            </p>
          </section>

          <CategoriesRail data={solve} node={node} path={path} boardCards={currentBoardCards} />

          <EvBucketsRail data={solve} node={node} path={path} />

          <section
            aria-label="Solve accuracy"
            className="rounded-lg border border-navy-700 bg-navy-900 p-3 shadow-panel"
          >
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Accuracy
            </h2>
            <AccuracyBadge nashPct={solve.raw.exploitability.nash_distance_pct} />
            <p className="mt-2 text-xs text-ink-dim">
              Measured against a best response by the engine's independent checker — certified
              solver output, {solve.raw.iterations.toLocaleString()} iterations.
            </p>
            <p className="mt-2 flex items-center gap-2 text-xs text-ink-dim">
              <ApproximationBadge /> guidance only (multiway lens, V2) — never a measured solve.
            </p>
          </section>

          <section
            aria-label="Hand detail"
            className="rounded-lg border border-navy-700 bg-navy-900 p-3 shadow-panel"
          >
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Hand detail
            </h2>
            <HandDetail data={solve} node={node} combo={selectedCombo} />
          </section>

          <MultiwayLens
            boardCards={currentBoardCards}
            selectedCombo={selectedCombo}
            nodeRangeText={nodeRangeText}
          />

          <section
            aria-label="Study tools"
            className="flex flex-col gap-4 rounded-lg border border-navy-700 bg-navy-900 p-3 shadow-panel"
          >
            <div>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                Link to heuristic
              </h2>
              <LinkToHeuristic spotId={solveId} />
            </div>
            <div className="border-t border-navy-700 pt-3">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                GTO Insight &amp; Rationale
              </h2>
              <ExplainPanel data={solve} node={node} combo={selectedCombo} />
            </div>
          </section>
        </div>
      </div>

      {/* Runout card picker (chance node) */}
      {pendingRunout && !pickerDismissed ? (
        <CardPicker
          title={`Deal the ${pendingStreet ?? 'next'} card`}
          caption="Only runouts present in this solve can be picked. Each was solved exactly — pick any card to keep walking the tree."
          deadCards={pickerDeadCards}
          enabledCards={pendingRunout.map((o) => o.card)}
          onPick={chooseRunout}
          onClear={() => setPickerDismissed(true)}
          onRandom={() => {
            const opt = pendingRunout[Math.floor(Math.random() * pendingRunout.length)];
            if (opt) chooseRunout(opt.card);
          }}
          onClose={() => setPickerDismissed(true)}
        />
      ) : null}

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
