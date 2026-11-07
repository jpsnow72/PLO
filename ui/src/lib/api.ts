// Client for the thin job service (api/). Every call fails soft: the UI
// falls back to the bundled sample solve and shows an "engine offline"
// notice when the service is unreachable.

import {
  isPreflopClassTable,
  isPreflopIndex,
  isPreflopSetDoc,
  type PreflopClassTable,
  type PreflopIndex,
  type PreflopSetDoc,
} from './preflop';
import {
  parseCatalogResponse,
  parseEnqueueResult,
  parseQueueResponse,
  parseRunnerStatus,
  type CatalogResponse,
  type EnqueueResult,
  type QueueResponse,
  type RunnerStatus,
} from './runner';
import type { AuthState, JobRecord, LibraryItem } from './types';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(path, {
    ...init,
    // Send the admin session cookie when the API is reached cross-origin
    // (configured server-side via ALLOWED_ORIGIN); harmless same-origin.
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const msg =
      body !== null && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return body;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

export async function fetchLibrary(): Promise<LibraryItem[]> {
  const body = await requestJson('/api/library');
  if (!isRecord(body) || !Array.isArray(body.library)) {
    throw new ApiError(0, 'Malformed library response');
  }
  return body.library as LibraryItem[];
}

export async function fetchJobs(): Promise<JobRecord[]> {
  const body = await requestJson('/api/jobs');
  if (!isRecord(body) || !Array.isArray(body.jobs)) {
    throw new ApiError(0, 'Malformed jobs response');
  }
  return body.jobs as JobRecord[];
}

export async function submitSolve(spot: Record<string, unknown>): Promise<JobRecord> {
  const body = await requestJson('/api/solves', {
    method: 'POST',
    body: JSON.stringify(spot),
  });
  if (!isRecord(body) || typeof body.id !== 'string') {
    throw new ApiError(0, 'Malformed submit response');
  }
  return body as unknown as JobRecord;
}

export async function fetchJob(id: string): Promise<JobRecord> {
  const body = await requestJson(`/api/solves/${encodeURIComponent(id)}`);
  if (!isRecord(body) || typeof body.id !== 'string') {
    throw new ApiError(0, 'Malformed job response');
  }
  return body as unknown as JobRecord;
}

/** Fetch the finished solve JSON for a job (raw engine output). */
export async function fetchJobResult(id: string): Promise<unknown> {
  return requestJson(`/api/solves/${encodeURIComponent(id)}/result`);
}

/** Fetch a library item's solve JSON. */
export async function fetchLibrarySolve(id: string): Promise<unknown> {
  return requestJson(`/api/library/${encodeURIComponent(id)}`);
}

/** The preflop range-set index (all sets, with provenance summaries). */
export async function fetchPreflopIndex(): Promise<PreflopIndex> {
  const body = await requestJson('/api/preflop/index');
  if (!isPreflopIndex(body)) throw new ApiError(0, 'Malformed preflop index response');
  return body;
}

/** One preflop range set document (all 16,432 classes with frequencies). */
export async function fetchPreflopSet(id: string): Promise<PreflopSetDoc> {
  const body = await requestJson(`/api/preflop/sets/${encodeURIComponent(id)}`);
  if (!isPreflopSetDoc(body)) throw new ApiError(0, 'Malformed preflop set response');
  return body;
}

/**
 * The per-class feature/equity table. Throws ApiError(404) until the
 * engine's build-ranges tool has generated it on a host — callers treat
 * that as "features unavailable", not as a hard failure.
 */
export async function fetchPreflopClassTable(): Promise<PreflopClassTable> {
  const body = await requestJson('/api/preflop/class-table');
  if (!isPreflopClassTable(body)) throw new ApiError(0, 'Malformed class table response');
  return body;
}

/** Load the bundled sample river solve (always available, no API needed). */
export async function fetchSampleSolve(): Promise<unknown> {
  const res = await fetch('/sample-river-solve.json');
  if (!res.ok) throw new ApiError(res.status, 'Sample solve missing');
  return (await res.json()) as unknown;
}

// ---------- Admin auth ----------

/**
 * Probe the admin session. A 401 from the server is a normal answer
 * ("not signed in"), not an error; network failures still throw so the
 * caller can distinguish "offline" from "locked".
 */
export async function fetchAuthMe(): Promise<AuthState> {
  try {
    const body = await requestJson('/api/auth/me');
    if (!isRecord(body) || typeof body.admin !== 'boolean') {
      throw new ApiError(0, 'Malformed auth response');
    }
    return {
      admin: body.admin,
      authEnabled: typeof body.auth_enabled === 'boolean' ? body.auth_enabled : true,
    };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return { admin: false, authEnabled: true };
    }
    throw err;
  }
}

/** Log in with the admin password. Throws ApiError with the server's message on failure. */
export async function login(password: string): Promise<void> {
  const body = await requestJson('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
  if (!isRecord(body) || body.admin !== true) {
    throw new ApiError(0, 'Malformed login response');
  }
}

/** Log out (clears the session cookie server-side). */
export async function logout(): Promise<void> {
  await requestJson('/api/auth/logout', { method: 'POST', body: '{}' });
}

// ---------- Local runner (catalog queue) ----------

/** The spot catalog, annotated with per-spot library/queue status. */
export async function fetchCatalog(): Promise<CatalogResponse> {
  const body = await requestJson('/api/catalog');
  const parsed = parseCatalogResponse(body);
  if (!parsed) throw new ApiError(0, 'Malformed catalog response');
  return parsed;
}

/** Current queue state (items, concurrency, paused, enabled). */
export async function fetchQueue(): Promise<QueueResponse> {
  const body = await requestJson('/api/queue');
  const parsed = parseQueueResponse(body);
  if (!parsed) throw new ApiError(0, 'Malformed queue response');
  return parsed;
}

/** Queue switches + upload configuration, for the runner status strip. */
export async function fetchRunnerStatus(): Promise<RunnerStatus> {
  const body = await requestJson('/api/runner/status');
  const parsed = parseRunnerStatus(body);
  if (!parsed) throw new ApiError(0, 'Malformed runner status response');
  return parsed;
}

/** Enqueue catalog spots [admin]. Throws ApiError(401) when not signed in. */
export async function enqueueSpots(spotIds: string[]): Promise<EnqueueResult> {
  const body = await requestJson('/api/queue', {
    method: 'POST',
    body: JSON.stringify({ spot_ids: spotIds }),
  });
  const parsed = parseEnqueueResult(body);
  if (!parsed) throw new ApiError(0, 'Malformed enqueue response');
  return parsed;
}

export type QueueControlAction =
  | { action: 'pause' }
  | { action: 'resume' }
  | { action: 'remove'; spot_id: string }
  | { action: 'set_concurrency'; value: number };

/** Pause/resume/remove/set concurrency [admin]. Returns the new queue state. */
export async function queueControl(action: QueueControlAction): Promise<QueueResponse> {
  const body = await requestJson('/api/queue/control', {
    method: 'POST',
    body: JSON.stringify(action),
  });
  const parsed = parseQueueResponse(body);
  if (!parsed) throw new ApiError(0, 'Malformed queue control response');
  return parsed;
}
