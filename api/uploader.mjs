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

// --- Split flop uploads (issue #57) -----------------------------------------
//
// A split flop entry lives in the LOCAL library as a header doc
// (<localId>.json), one brotli part per turn card
// (<localId>.turn-<Card>.json.br, or an uncompressed .json in fixtures),
// and a meta sidecar. Upload = the header through the ordinary ingest
// POST (central stores it like any solve doc; its "split" marker tells
// central not to expect subtrees in it), then each part through
// PUT /api/solves/<spot.id>/parts/<card> with the stored bytes as-is.
// Central answers each PUT with the list of parts it now holds; that
// list is recorded in the local meta as split_uploaded_parts, so every
// later attempt sends only the parts central has not acknowledged
// (idempotent resume after an interrupted upload). A central build
// without the parts route answers 404: the parts stay local, the
// outcome is a retryable failure, nothing is lost.

const PART_FILE_RE = /\.turn-([A-Za-z0-9]{2,3})\.json(\.br)?$/;

async function listLocalParts(libraryDir, localId) {
  let files = [];
  try {
    files = await fs.readdir(libraryDir);
  } catch {
    return [];
  }
  const found = new Map();
  for (const f of files) {
    if (!f.startsWith(`${localId}.turn-`)) continue;
    const m = PART_FILE_RE.exec(f);
    if (!m) continue;
    // Prefer the compressed stored form when both exist.
    if (!found.has(m[1]) || m[2]) {
      found.set(m[1], {
        card: m[1],
        file: path.join(libraryDir, f),
        encoding: m[2] ? 'brotli' : 'identity',
      });
    }
  }
  return [...found.values()];
}

/**
 * Upload one split flop entry (header + turn parts) to central.
 *
 * @param {object} args
 * @param {{central_url: string, session_cookie: string}} args.config
 * @param {object} args.spot       the catalog entry (central files the
 *                                 entry under spot.id, as with ingest)
 * @param {string} args.libraryDir the LOCAL library directory
 * @param {string} args.localId    the local library id (job id)
 * @returns {Promise<{ok: boolean, status?: string, error?: string,
 *   sent_parts?: string[], acknowledged_parts?: string[]}>}
 */
export async function attemptSplitUpload({ config, spot, libraryDir, localId }) {
  const metaPath = path.join(libraryDir, `${localId}.meta.json`);
  let meta = null;
  try {
    meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  } catch {
    meta = null;
  }
  let header;
  try {
    header = JSON.parse(
      await fs.readFile(path.join(libraryDir, `${localId}.json`), 'utf8'),
    );
  } catch {
    return { ok: false, error: 'Split header doc is missing locally; cannot upload.' };
  }
  const head = await attemptUpload({ config, spot, result: header });
  if (!head.ok) return head;

  let acknowledged = Array.isArray(meta?.split_uploaded_parts)
    ? [...meta.split_uploaded_parts]
    : [];
  const localParts = await listLocalParts(libraryDir, localId);
  const sent = [];
  for (const part of localParts) {
    if (acknowledged.includes(part.card)) continue;
    let response;
    try {
      response = await fetch(
        `${config.central_url}/api/solves/${encodeURIComponent(spot.id)}/parts/${encodeURIComponent(part.card)}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'x-part-encoding': part.encoding,
            Cookie: `${SESSION_COOKIE}=${config.session_cookie}`,
          },
          body: await fs.readFile(part.file),
        },
      );
    } catch (err) {
      return {
        ok: false,
        error: `Part upload request failed (${part.card}): ${err instanceof Error ? err.message : String(err)}`,
        sent_parts: sent,
        acknowledged_parts: acknowledged,
      };
    }
    if (response.status === 404) {
      console.warn(
        `attemptSplitUpload: central has no split-parts route (404 on ${part.card}); ` +
          'keeping parts locally for a later retry.',
      );
      return {
        ok: false,
        error:
          'Central server does not expose the split-parts route (404); split parts kept locally for retry.',
        sent_parts: sent,
        acknowledged_parts: acknowledged,
      };
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok || !body || !Array.isArray(body.parts)) {
      const detail =
        body && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
      return {
        ok: false,
        error: `Part upload failed for turn card ${part.card}: ${detail}`,
        sent_parts: sent,
        acknowledged_parts: acknowledged,
      };
    }
    acknowledged = body.parts;
    sent.push(part.card);
    if (meta) {
      meta.split_uploaded_parts = acknowledged;
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2));
    }
  }
  return {
    ok: true,
    status: head.status,
    sent_parts: sent,
    acknowledged_parts: acknowledged,
  };
}
