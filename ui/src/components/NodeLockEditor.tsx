// The visual node-lock editor (issue #9), shared by the Explorer's
// Edit Node surface and the Solver's Node locks fieldset. Modelled on
// the reference's Set Range Frequencies dialog (capture gtw2-f28):
// one slider + numeric input per action, percentages of the WHOLE
// range, a Reset to the solver's own frequencies, and Apply-style
// add/update into a lock list. All logic lives in lib/nodelocks.ts;
// this component only renders it.
//
// Honesty rules baked into the copy: a lock holds every combo at the
// node to the same mix (the v1 engine's whole-node semantics), the
// percentages shown are the user's own, and locked solves are badged
// LOCKED and priced as played — never presented as GTO.

import { useEffect, useMemo, useState } from 'react';
import {
  lockSummary,
  rebalancePercentages,
  validatePercentages,
  type LockDraft,
} from '../lib/nodelocks';
import type { Player } from '../lib/types';

export interface LockEditorNode {
  history: string;
  player: Player;
  actionLabels: string[];
  /** Human label, e.g. "OOP · river · B(75) · pot 175.0". */
  label: string;
  /** The solver's own overall percentages at this node (full precision). */
  solverPercentages: number[] | null;
}

interface NodeLockEditorProps {
  /** The node being edited (Explorer), or null in staged-only mode (Solver). */
  node: LockEditorNode | null;
  locks: LockDraft[];
  onChange: (locks: LockDraft[]) => void;
  /** Earlier decision nodes on the current line that a line lock would pin. */
  lineLockCount?: number;
  lineLocked?: boolean;
  onLineLockChange?: (on: boolean) => void;
}

/** Round full-precision percentages to whole percents summing to exactly 100. */
function toWholePercents(percentages: number[]): number[] {
  const floors = percentages.map((p) => Math.floor(p));
  let residue = 100 - floors.reduce((a, b) => a + b, 0);
  const byRemainder = percentages
    .map((p, i) => ({ i, r: p - Math.floor(p) }))
    .sort((a, b) => b.r - a.r);
  for (const { i } of byRemainder) {
    if (residue <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    residue -= 1;
  }
  return floors;
}

const SOURCE_LABEL: Record<LockDraft['source'], string> = {
  node: 'This node',
  line: 'Line',
  staged: 'Staged',
};

export function NodeLockEditor({
  node,
  locks,
  onChange,
  lineLockCount = 0,
  lineLocked = false,
  onLineLockChange,
}: NodeLockEditorProps) {
  // The lock currently loaded into the sliders: the Explorer's node,
  // or a lock picked from the list (the Solver's staged mode).
  const [focusHistory, setFocusHistory] = useState<string | null>(node?.history ?? null);
  const [pcts, setPcts] = useState<number[]>([]);

  const focusLock = useMemo(
    () => locks.find((l) => l.history === focusHistory) ?? null,
    [locks, focusHistory],
  );
  const focus: LockEditorNode | null = useMemo(() => {
    if (node && focusHistory === node.history) return node;
    if (focusLock) {
      return {
        history: focusLock.history,
        player: focusLock.player,
        actionLabels: focusLock.actionLabels,
        label: `${focusLock.player} · ${focusLock.history}`,
        solverPercentages: null,
      };
    }
    return node;
  }, [node, focusHistory, focusLock]);

  // (Re)load the sliders when the focus changes: an existing lock's
  // own percentages win, else the solver's frequencies at the node.
  const focusKey = focus?.history ?? null;
  useEffect(() => {
    if (!focus) {
      setPcts([]);
      return;
    }
    const existing = locks.find((l) => l.history === focus.history);
    if (existing) {
      setPcts(toWholePercents(existing.percentages));
    } else if (focus.solverPercentages) {
      setPcts(toWholePercents(focus.solverPercentages));
    } else {
      setPcts(focus.actionLabels.map(() => 0));
    }
    // Only the focus identity reseeds the sliders — lock edits below
    // flow through onChange, not back through this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);

  const validationError = pcts.length > 0 ? validatePercentages(pcts) : null;
  const total = pcts.reduce((a, b) => a + b, 0);

  const applyFocusLock = () => {
    if (!focus || validationError) return;
    const draft: LockDraft = {
      history: focus.history,
      player: focus.player,
      actionLabels: focus.actionLabels,
      percentages: [...pcts],
      source: node && focus.history === node.history ? 'node' : (focusLock?.source ?? 'staged'),
    };
    const rest = locks.filter((l) => l.history !== draft.history);
    onChange([...rest, draft]);
  };

  const removeLock = (history: string) => onChange(locks.filter((l) => l.history !== history));

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-ink-dim">
        A lock fixes one player&apos;s overall action frequencies at a decision node and
        re-solves the rest of the tree around them. The engine holds{' '}
        <span className="text-ink">every combo at the node to the same mix</span> — the
        percentages below are yours, shown as yours. Locked solves are badged{' '}
        <span className="font-semibold text-accent">LOCKED</span> and priced as played, never
        GTO.
      </p>

      {focus ? (
        <div className="rounded-md bg-navy-850 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-ink">{focus.label}</h3>
            <span className="text-xs text-ink-faint">{focus.player} to act</span>
            {focus.solverPercentages ? (
              <button
                type="button"
                onClick={() => setPcts(toWholePercents(focus.solverPercentages ?? []))}
                className="ml-auto rounded-md bg-navy-800 px-2 py-1 text-xs text-ink-dim hover:text-ink"
                title="Restore the loaded solve's own overall frequencies at this node"
              >
                Reset to solver frequencies
              </button>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-ink-faint">
            Set the overall action frequencies of the entire range at this node.
          </p>
          <div className="mt-2 flex flex-col gap-2">
            {focus.actionLabels.map((label, i) => (
              <div key={label} className="flex items-center gap-2">
                <span className="w-28 shrink-0 truncate text-sm text-ink" title={label}>
                  {label}
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={pcts[i] ?? 0}
                  aria-label={`${label} percent (slider)`}
                  onChange={(e) =>
                    setPcts((prev) => rebalancePercentages(prev, i, Number(e.target.value)))
                  }
                  className="w-full accent-[#2E9E6B]"
                />
                <span className="flex shrink-0 items-center gap-1">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={pcts[i] ?? 0}
                    aria-label={`${label} percent`}
                    onChange={(e) =>
                      setPcts((prev) =>
                        prev.map((p, j) => (j === i ? Number(e.target.value) : p)),
                      )
                    }
                    className="w-16 rounded-md border border-navy-700 bg-navy-900 px-2 py-1 text-right text-sm text-ink"
                  />
                  <span className="text-xs text-ink-faint">%</span>
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span
              className={`text-xs font-semibold ${validationError ? 'text-red-300' : 'text-table-light'}`}
            >
              Total {total}%{validationError ? ` — ${validationError}` : ''}
            </span>
            <button
              type="button"
              disabled={validationError !== null}
              onClick={applyFocusLock}
              className="ml-auto rounded-md bg-table px-3 py-1.5 text-xs font-semibold text-white hover:bg-table-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {focusLock ? 'Update lock' : 'Add lock'}
            </button>
          </div>
          <p className="mt-1 text-xs text-ink-faint">
            Sliders rebalance the other actions proportionally so the total stays 100; typed
            numbers never rewrite each other — an off-100 total is flagged instead.
          </p>
        </div>
      ) : (
        <p className="rounded-md bg-navy-850 px-3 py-2.5 text-sm text-ink-dim">
          No node is being edited. Locks are picked on a solved tree — open a solve in the
          Explorer and use <span className="text-ink">Edit node</span> — or pick a staged lock
          below to adjust its percentages.
        </p>
      )}

      {onLineLockChange ? (
        <label className="flex items-start gap-2 text-sm text-ink-dim">
          <input
            type="checkbox"
            checked={lineLocked}
            onChange={(e) => onLineLockChange(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[#2E9E6B]"
          />
          <span>
            Lock the line to this node — also lock the {lineLockCount} earlier decision
            {lineLockCount === 1 ? '' : 's'} on this line at the solver&apos;s own frequencies,
            so the re-solve cannot drift away from the line you studied.
          </span>
        </label>
      ) : null}

      <div>
        <div className="mb-1.5 flex items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Locks on this solve ({locks.length})
          </h3>
          {locks.length > 0 ? (
            <button
              type="button"
              onClick={() => onChange([])}
              className="ml-auto rounded px-1.5 py-0.5 text-xs text-ink-dim hover:bg-navy-800 hover:text-ink"
            >
              Clear all
            </button>
          ) : null}
        </div>
        {locks.length === 0 ? (
          <p className="text-sm text-ink-faint">No locks yet — this solve runs unlocked.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {locks.map((lock) => (
              <li
                key={lock.history}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-navy-850 px-3 py-2 text-sm"
              >
                <span className="font-mono text-xs text-ink">{lock.history}</span>
                <span className="text-xs text-ink-dim">{lock.player}</span>
                <span className="rounded-full border border-accent px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-accent">
                  {SOURCE_LABEL[lock.source]}
                </span>
                <span className="text-xs text-ink-dim">{lockSummary(lock)}</span>
                <span className="ml-auto flex gap-1">
                  <button
                    type="button"
                    onClick={() => setFocusHistory(lock.history)}
                    className="rounded px-1.5 py-0.5 text-xs text-ink-dim hover:bg-navy-800 hover:text-ink"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => removeLock(lock.history)}
                    className="rounded px-1.5 py-0.5 text-xs text-red-300 hover:bg-navy-800"
                  >
                    Remove
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
