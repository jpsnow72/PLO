// Auto-upload of finished catalog solves to the central library —
// Node standard library only.
//
// The runner (Justin's PC) solves catalog spots locally. When a queue
// item finishes, its result already exists in the LOCAL library (that is
// what "done" means); this module then pushes it to the central server
// via POST {central_url}/api/library/ingest, which is idempotent by
// content hash, so retries and duplicate pushes are safe.
//
// Configuration lives in DATA_DIR/runner-config.json:
//   { "central_url": "https://central.example", "session_cookie": "..." }
// written by `node api/runner-login.mjs` (the value is the central
// server's `plo_admin` session cookie). When the file does not exist the
// runner is in OFFLINE MODE: uploads are reported as "skipped", the queue
// still completes locally, and nothing is treated as an error. When a
// config appears later, previously skipped/failed items are retried by
// the server's retry loop.
//
// attemptUpload() never throws for network/HTTP problems: it returns
// { ok: true, status, detail } or { ok: false, error } and the caller
// records the outcome on the queue item.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SESSION_COOKIE } from './auth.mjs';

export const RUNNER_CONFIG_NAME = 'runner-config.json';

export function runnerConfigPath(dataDir) {
  return path.join(dataDir, RUNNER_CONFIG_NAME);
}

/** Parsed runner-config.json, or null when absent/malformed. */
export async function loadRunnerConfig(dataDir) {
  try {
    const parsed = JSON.parse(await fs.readFile(runnerConfigPath(dataDir), 'utf8'));
    if (
      parsed &&
      typeof parsed.central_url === 'string' &&
      parsed.central_url.length > 0 &&
      typeof parsed.session_cookie === 'string' &&
      parsed.session_cookie.length > 0
    ) {
      return {
        central_url: parsed.central_url.replace(/\/+$/, ''),
        session_cookie: parsed.session_cookie,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Write runner-config.json atomically (temp + rename). */
export async function saveRunnerConfig(dataDir, config) {
  await fs.mkdir(dataDir, { recursive: true });
  const file = runnerConfigPath(dataDir);
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2));
  await fs.rename(tmp, file);
}

/**
 * Push one finished solve to the central library.
 *
 * @param {object} args
 * @param {{central_url: string, session_cookie: string}} args.config
 * @param {object} args.spot    the catalog entry (stored as spot metadata)
 * @param {object} args.result  the engine solve JSON, verbatim
 * @returns {Promise<{ok: boolean, status?: string, error?: string}>}
 *   status is the ingest status: "created" | "exists" | "updated".
 */
export async function attemptUpload({ config, spot, result }) {
  const url = `${config.central_url}/api/library/ingest`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${SESSION_COOKIE}=${config.session_cookie}`,
      },
      body: JSON.stringify({ spot, result }),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Upload request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.ok && body && typeof body.status === 'string') {
    return { ok: true, status: body.status };
  }
  const detail =
    body && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
  return {
    ok: false,
    error:
      response.status === 401
        ? `Central server rejected the runner session (401: ${detail}). Re-run: node api/runner-login.mjs`
        : `Central ingest failed: ${detail}`,
  };
}
