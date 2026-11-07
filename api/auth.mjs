// Admin auth primitives for the job service — Node standard library only.
//
// Password storage: a single scrypt hash string (produced by
// `node hash-password.mjs`), supplied to the server via the
// ADMIN_PASSWORD_HASH environment variable. The plaintext password is
// never stored anywhere.
//
// Sessions: opaque 32-byte random tokens. Only the SHA-256 hash of a
// token is kept at rest (DATA_DIR/auth-sessions.json), so a leak of the
// sessions file does not leak usable tokens. Sessions expire 30 days
// after creation.

import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// scrypt cost parameters for NEW hashes. Verification uses the parameters
// embedded in the stored string, so these can be raised later without
// invalidating existing hashes.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;

export const SESSION_COOKIE = 'plo_admin';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Hash a password into the storage format:
 *   scrypt$<N>$<r>$<p>$<salt base64>$<derived key base64>
 */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_LEN);
  const key = await scryptAsync(password, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * Parse a stored hash string. Accepts the current format
 * `scrypt$N$r$p$salt$key` and the simpler `scrypt$salt$key` (default
 * parameters). Returns null for anything malformed.
 */
export function parsePasswordHash(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  let N = SCRYPT_N;
  let r = SCRYPT_R;
  let p = SCRYPT_P;
  let saltB64;
  let keyB64;
  if (parts.length === 6 && parts[0] === 'scrypt') {
    N = Number(parts[1]);
    r = Number(parts[2]);
    p = Number(parts[3]);
    saltB64 = parts[4];
    keyB64 = parts[5];
  } else if (parts.length === 3 && parts[0] === 'scrypt') {
    saltB64 = parts[1];
    keyB64 = parts[2];
  } else {
    return null;
  }
  if (!Number.isInteger(N) || N <= 1 || !Number.isInteger(r) || r <= 0 || !Number.isInteger(p) || p <= 0) {
    return null;
  }
  const salt = Buffer.from(saltB64 ?? '', 'base64');
  const key = Buffer.from(keyB64 ?? '', 'base64');
  if (salt.length === 0 || key.length === 0) return null;
  return { N, r, p, salt, key };
}

/** Constant-time password check against a stored hash string. */
export async function verifyPassword(password, stored) {
  const parsed = parsePasswordHash(stored);
  if (!parsed || typeof password !== 'string') return false;
  try {
    const derived = await scryptAsync(password, parsed.salt, parsed.key.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
    });
    return derived.length === parsed.key.length && timingSafeEqual(derived, parsed.key);
  } catch {
    return false;
  }
}

function tokenHash(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * File-backed session store. Records are keyed by the SHA-256 hash of the
 * session token: { created_at, expires_at } (ISO strings). Loaded lazily,
 * pruned of expired entries on load and on creation, and persisted on
 * every change (temp file + rename, so a crash cannot truncate it).
 */
export class SessionStore {
  constructor(file) {
    this.file = file;
    /** @type {Map<string, {created_at: string, expires_at: string}> | null} */
    this.sessions = null;
  }

  async load() {
    if (this.sessions) return this.sessions;
    let parsed = {};
    try {
      parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      parsed = {};
    }
    this.sessions = new Map();
    const now = Date.now();
    if (parsed && typeof parsed === 'object') {
      for (const [hash, rec] of Object.entries(parsed)) {
        if (
          rec &&
          typeof rec === 'object' &&
          typeof rec.expires_at === 'string' &&
          Date.parse(rec.expires_at) > now
        ) {
          this.sessions.set(hash, {
            created_at: typeof rec.created_at === 'string' ? rec.created_at : new Date().toISOString(),
            expires_at: rec.expires_at,
          });
        }
      }
    }
    return this.sessions;
  }

  async save() {
    if (!this.sessions) return;
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(this.sessions), null, 2));
    await fs.rename(tmp, this.file);
  }

  /** Create a session; returns the raw token (shown to the client once). */
  async create() {
    const sessions = await this.load();
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    sessions.set(tokenHash(token), {
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    });
    await this.save();
    return token;
  }

  /** True when the raw token names a live session. */
  async has(token) {
    if (typeof token !== 'string' || token.length === 0) return false;
    const sessions = await this.load();
    const rec = sessions.get(tokenHash(token));
    if (!rec) return false;
    if (Date.parse(rec.expires_at) <= Date.now()) {
      sessions.delete(tokenHash(token));
      await this.save();
      return false;
    }
    return true;
  }

  async delete(token) {
    if (typeof token !== 'string' || token.length === 0) return;
    const sessions = await this.load();
    if (sessions.delete(tokenHash(token))) await this.save();
  }
}

/** Parse the Cookie header into a name -> value map (first value wins). */
export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = new Map();
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name && !out.has(name)) {
      try {
        out.set(name, decodeURIComponent(value));
      } catch {
        out.set(name, value);
      }
    }
  }
  return out;
}

/** True when the request arrived over HTTPS (direct TLS or a proxy that says so). */
export function requestIsSecure(req) {
  if (req.socket && req.socket.encrypted) return true;
  const proto = req.headers['x-forwarded-proto'];
  return typeof proto === 'string' && proto.split(',')[0].trim() === 'https';
}

/** Set-Cookie value for a fresh session token. */
export function sessionCookieValue(token, secure) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/** Set-Cookie value that clears the session cookie. */
export function clearCookieValue(secure) {
  const attrs = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}
