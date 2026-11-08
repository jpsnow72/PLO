import { useEffect, useMemo, useState } from 'react';
import { ApiError, createHeuristic, fetchHeuristics } from '../lib/api';
import { explainNode } from '../lib/explain';
import type { SolveData, SolveNode } from '../lib/solveTree';
import { useStore } from '../store/useStore';
import { ApproximationBadge } from './AccuracyBadge';

type HeuristicsAvailability = 'checking' | 'available' | 'missing' | 'locked';
type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface Props {
  data: SolveData;
  node: SolveNode;
  combo: string | null;
}

/**
 * "GTO Insight & Rationale" panel (Explorer, right column). Everything
 * shown is computed by lib/explain.ts from the loaded solve — no LLM,
 * no generic advice. The closing candidate heuristic is badged
 * CANDIDATE and can be saved to the heuristics log; the save path is
 * defensive because that endpoint is a parallel lane: when it is not
 * there (404 / unreachable) or the session is signed out (401), the
 * button disables itself with the reason rather than failing silently.
 */
export function ExplainPanel({ data, node, combo }: Props) {
  const solveId = useStore((s) => s.solveId);
  const explanation = useMemo(() => explainNode(data, node, combo), [data, node, combo]);
  const [availability, setAvailability] = useState<HeuristicsAvailability>('checking');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveNote, setSaveNote] = useState<string | null>(null);

  // Probe the heuristics endpoint once per mount (not per node): the
  // answer decides whether "Save to heuristics" can work at all.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await fetchHeuristics();
        if (!cancelled) setAvailability('available');
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) setAvailability('locked');
        else setAvailability('missing');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A new node (or a new candidate) resets the save state.
  const candidate = explanation.candidateHeuristic;
  useEffect(() => {
    setSaveState('idle');
    setSaveNote(null);
  }, [candidate]);

  const save = async () => {
    if (!candidate) return;
    setSaveState('saving');
    setSaveNote(null);
    try {
      await createHeuristic({
        text: candidate,
        tags: {
          texture: explanation.topic.texture,
          street: explanation.topic.street,
          spot_type: explanation.topic.spot_type,
        },
        // Link the current solve when an id is set in the store (library
        // or job solve); empty array for the id-less bundled sample.
        linked_spot_ids: solveId ? [solveId] : [],
        source: 'ai-suggested',
      });
      setSaveState('saved');
      setSaveNote('Saved to your heuristics log as a candidate (source: ai-suggested).');
    } catch (err) {
      setSaveState('error');
      setSaveNote(
        err instanceof ApiError && err.status === 401
          ? 'Sign in (admin) to save heuristics — the candidate was not saved.'
          : 'The heuristics service did not accept the save — the candidate was not saved.',
      );
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium text-ink">{explanation.headline}</p>

      <dl className="flex flex-col gap-2.5">
        {explanation.factors.map((factor) => (
          <div key={factor.label} className="rounded-md bg-navy-850 px-2.5 py-2">
            <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
              {factor.label}
            </dt>
            <dd className="mt-0.5 text-xs leading-relaxed text-ink-dim">{factor.detail}</dd>
          </div>
        ))}
      </dl>

      {candidate ? (
        <div className="rounded-lg border border-navy-700 bg-navy-850 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
              Candidate heuristic
            </h4>
            <span className="ml-auto">
              <ApproximationBadge label="CANDIDATE" />
            </span>
          </div>
          <p className="mt-1.5 text-sm leading-relaxed text-ink">{candidate}</p>
          <p className="mt-1 text-xs text-ink-faint">
            A pattern read off this one node — a candidate for your log, not a solver claim.
            Test it against more spots before trusting it.
          </p>
          {availability === 'available' ? (
            <button
              type="button"
              onClick={() => void save()}
              disabled={saveState === 'saving' || saveState === 'saved'}
              className="mt-2 rounded-md bg-table px-3 py-1.5 text-sm font-semibold text-white hover:bg-table-dark disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saveState === 'saving'
                ? 'Saving…'
                : saveState === 'saved'
                  ? 'Saved to heuristics'
                  : 'Save to heuristics'}
            </button>
          ) : (
            <p className="mt-2 text-xs text-ink-faint">
              {availability === 'checking'
                ? 'Checking whether the heuristics log is reachable…'
                : availability === 'locked'
                  ? 'Save to heuristics is unavailable: sign in (admin) to use the heuristics log.'
                  : 'Save to heuristics is unavailable: the heuristics service is not running on this server yet.'}
            </p>
          )}
          {saveNote ? (
            <p className="mt-1.5 text-xs text-ink-dim" role="status">
              {saveNote}
            </p>
          ) : null}
        </div>
      ) : null}

      <p className="text-xs text-ink-faint">
        Every line above is computed from this solve’s stored data — frequencies, range weights
        and whole-solve EVs. Per-action EVs are not stored by the engine, so this panel never
        quotes an EV gap between actions.
      </p>
    </div>
  );
}
