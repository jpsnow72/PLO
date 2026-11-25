// Split-solve loading (issue #57): the fetch + graft layer between
// the API and the solve-tree model.
//
// A split flop's header doc indexes only the flop street. The first
// time navigation needs a node under a turn card, ONE fetch for that
// card goes out (concurrent triggers share it), the returned nodes
// are grafted into the model index, and the card is cached for the
// session — it is never fetched again for that solve. A failed or
// malformed fetch resolves false and caches NOTHING, so the next
// trigger simply retries; the UI turns that false into a retryable
// inline error on the chance branch, never a blank screen.
//
// The fetcher is injectable so tests can serve synthetic payloads
// without a network; the app uses the shared instance below, wired
// to GET /api/solves/:id/turn/<card>.

import { fetchSolveTurn } from './api';
import { graftTurnNodes, type SolveData } from './solveTree';

export type TurnCardFetcher = (solveId: string, card: string) => Promise<unknown>;

export class TurnCardLoader {
  private readonly inflight = new Map<string, Promise<boolean>>();

  constructor(private readonly fetcher: TurnCardFetcher) {}

  /** True when the card's nodes are in the model (or arrive so). */
  ensureCard(data: SolveData, solveId: string, card: string): Promise<boolean> {
    if (!data.split) return Promise.resolve(false);
    if (data.split.loadedCards.has(card)) return Promise.resolve(true);
    if (!data.split.turnCards.includes(card)) return Promise.resolve(false);
    const key = `${solveId}|${card}`;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p: Promise<boolean> = (async () => {
      try {
        const body = await this.fetcher(solveId, card);
        return graftTurnNodes(data, card, body);
      } catch {
        return false;
      }
    })();
    this.inflight.set(key, p);
    void p.then(() => {
      if (this.inflight.get(key) === p) this.inflight.delete(key);
    });
    return p;
  }
}

/** The app-wide loader, backed by the job-service API. */
export const turnCardLoader = new TurnCardLoader((id, card) => fetchSolveTurn(id, card));

/**
 * Quiz preparation for a split flop (issue #57): fetch ONE random
 * available turn card, so question generation — which only ever sees
 * the loaded model — draws from the flop street plus that one card's
 * subtree, never from unloaded content it would have to invent.
 * Returns the loaded card, or null when the solve is not split or
 * the fetch failed (the flop street alone still yields questions).
 */
export async function prepareSplitForQuiz(
  data: SolveData,
  solveId: string,
  loader: TurnCardLoader = turnCardLoader,
  rng: () => number = Math.random,
): Promise<string | null> {
  if (!data.split) return null;
  const unloaded = data.split.turnCards.filter((c) => !data.split!.loadedCards.has(c));
  if (unloaded.length === 0) return null;
  const card = unloaded[Math.floor(rng() * unloaded.length)] ?? unloaded[0];
  if (!card) return null;
  const ok = await loader.ensureCard(data, solveId, card);
  return ok ? card : null;
}
