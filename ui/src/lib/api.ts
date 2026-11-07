// Client for the thin job service (api/). Every call fails soft: the UI
// falls back to the bundled sample solve and shows an "engine offline"
// notice when the service is unreachable.

import type { JobRecord, LibraryItem } from './types';

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

/** Load the bundled sample river solve (always available, no API needed). */
export async function fetchSampleSolve(): Promise<unknown> {
  const res = await fetch('/sample-river-solve.json');
  if (!res.ok) throw new ApiError(res.status, 'Sample solve missing');
  return (await res.json()) as unknown;
}
