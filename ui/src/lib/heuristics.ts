// Types + defensive parsing for the heuristics log API (GET/POST
// /api/heuristics), which is built by a parallel lane (ticket S1).
//
// Expected shape per entry:
//   { id, text, tags: { texture, street, spot_type },
//     linked_spot_ids: string[], status, source? }
//
// Everything here is defensive on purpose: until the endpoint exists,
// GET answers 404 and callers must degrade (quiz runs on solver spots
// only; the Explorer's save button disables itself) rather than fail.
// Responses are accepted either as a bare array or as
// { heuristics: [...] }; entries missing an id or text are dropped,
// missing fields are defaulted, never invented.

export interface HeuristicTags {
  texture: string;
  street: string;
  spot_type: string;
}

export interface Heuristic {
  id: string;
  text: string;
  tags: HeuristicTags;
  linked_spot_ids: string[];
  status: string;
  /** e.g. "ai-suggested" for candidates saved from the Explain panel. */
  source: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function cleanString(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : fallback;
}

/** Parse one entry; returns null when it lacks the essentials (id, text). */
export function parseHeuristic(value: unknown): Heuristic | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || value.id.length === 0) return null;
  if (typeof value.text !== 'string' || value.text.trim().length === 0) return null;
  const tags = isRecord(value.tags) ? value.tags : {};
  return {
    id: value.id,
    text: value.text.trim(),
    tags: {
      texture: cleanString(tags.texture, 'unknown'),
      street: cleanString(tags.street, 'unknown'),
      spot_type: cleanString(tags.spot_type, 'unknown'),
    },
    linked_spot_ids: Array.isArray(value.linked_spot_ids)
      ? value.linked_spot_ids.filter((x): x is string => typeof x === 'string')
      : [],
    status: cleanString(value.status, 'active'),
    source: typeof value.source === 'string' ? value.source : null,
  };
}

/** Parse a GET /api/heuristics response body; null when unrecognisable. */
export function parseHeuristicsResponse(body: unknown): Heuristic[] | null {
  const list = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.heuristics)
      ? body.heuristics
      : null;
  if (!list) return null;
  const out: Heuristic[] = [];
  for (const entry of list) {
    const parsed = parseHeuristic(entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Body for POST /api/heuristics when saving an Explain-panel candidate. */
export interface NewHeuristic {
  text: string;
  tags: HeuristicTags;
  linked_spot_ids: string[];
  source: string;
}
