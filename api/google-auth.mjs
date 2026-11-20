// Google ID-token verification for Sign in with Google — Node standard
// library only, no client secret anywhere in the system.
//
// The browser obtains an ID token (a signed JWT) from Google Identity
// Services and posts it to POST /api/auth/google. This module proves the
// token is genuine and meant for us:
//
//   - RS256 signature verified against Google's public keys (JWKS at
//     https://www.googleapis.com/oauth2/v3/certs, cached in memory and
//     refetched once when an unknown key id shows up — key rotation).
//   - iss is accounts.google.com (either spelling).
//   - aud equals our OAuth client id (the GOOGLE_CLIENT_ID env var).
//   - exp is in the future.
//   - email_verified is exactly true and an email claim is present.
//
// Every failure raises GoogleTokenError with a server-side detail
// message; the route turns all of them into one generic 401 so callers
// learn nothing about which check failed.

import { createPublicKey, verify as cryptoVerify } from 'node:crypto';

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const VALID_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const JWKS_FETCH_TIMEOUT_MS = 5000;
const DEFAULT_JWKS_CACHE_MS = 60 * 60 * 1000;
const MAX_JWKS_CACHE_MS = 24 * 60 * 60 * 1000;

export class GoogleTokenError extends Error {}

/** @type {{ keysByKid: Map<string, import('node:crypto').KeyObject>, expiresAt: number } | null} */
let jwksCache = null;

function cacheLifetimeMs(headers) {
  const cc = headers.get('cache-control') ?? '';
  const match = /max-age=(\d+)/.exec(cc);
  if (!match) return DEFAULT_JWKS_CACHE_MS;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_JWKS_CACHE_MS;
  return Math.min(seconds * 1000, MAX_JWKS_CACHE_MS);
}

async function fetchJwks() {
  let res;
  try {
    res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new GoogleTokenError(`JWKS fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new GoogleTokenError(`JWKS fetch returned HTTP ${res.status}`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new GoogleTokenError('JWKS response was not valid JSON');
  }
  if (!body || typeof body !== 'object' || !Array.isArray(body.keys)) {
    throw new GoogleTokenError('JWKS response carried no keys array');
  }
  const keysByKid = new Map();
  for (const jwk of body.keys) {
    if (!jwk || typeof jwk !== 'object' || typeof jwk.kid !== 'string') continue;
    try {
      keysByKid.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
    } catch {
      // Skip keys this Node build cannot import; another key may match.
    }
  }
  if (keysByKid.size === 0) throw new GoogleTokenError('JWKS response carried no usable keys');
  jwksCache = { keysByKid, expiresAt: Date.now() + cacheLifetimeMs(res.headers) };
  return jwksCache;
}

async function signingKeyFor(kid) {
  if (!jwksCache || jwksCache.expiresAt <= Date.now()) await fetchJwks();
  let key = jwksCache.keysByKid.get(kid);
  if (key) return key;
  // Unknown kid: Google may have rotated keys since the cache filled.
  // Refetch exactly once before giving up.
  await fetchJwks();
  key = jwksCache.keysByKid.get(kid);
  if (!key) throw new GoogleTokenError(`No Google signing key for kid ${kid}`);
  return key;
}

function decodeJsonPart(part, label) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new GoogleTokenError(`ID token ${label} is not base64url JSON`);
  }
}

/**
 * Verify a Google ID token against the expected audience (our OAuth
 * client id). Resolves to { email, sub } on success; throws
 * GoogleTokenError on any failure.
 */
export async function verifyGoogleIdToken(idToken, expectedAudience) {
  if (typeof idToken !== 'string' || idToken.length === 0) {
    throw new GoogleTokenError('ID token is missing');
  }
  if (typeof expectedAudience !== 'string' || expectedAudience.length === 0) {
    throw new GoogleTokenError('No expected audience configured');
  }
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) {
    throw new GoogleTokenError('ID token is not a three-part JWT');
  }
  const header = decodeJsonPart(parts[0], 'header');
  const claims = decodeJsonPart(parts[1], 'payload');
  if (!header || typeof header !== 'object' || header.alg !== 'RS256') {
    throw new GoogleTokenError('ID token alg is not RS256');
  }
  if (typeof header.kid !== 'string' || header.kid.length === 0) {
    throw new GoogleTokenError('ID token header carries no kid');
  }
  if (!claims || typeof claims !== 'object') {
    throw new GoogleTokenError('ID token payload is not an object');
  }

  const key = await signingKeyFor(header.kid);
  let signatureOk = false;
  try {
    signatureOk = cryptoVerify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8'),
      key,
      Buffer.from(parts[2], 'base64url'),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) throw new GoogleTokenError('ID token signature did not verify');

  if (!VALID_ISSUERS.has(String(claims.iss))) {
    throw new GoogleTokenError(`Unexpected iss: ${String(claims.iss)}`);
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expectedAudience)) {
    throw new GoogleTokenError('ID token aud does not match our client id');
  }
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) {
    throw new GoogleTokenError('ID token is expired (or carries no exp)');
  }
  if (claims.email_verified !== true) {
    throw new GoogleTokenError('Google account email is not verified');
  }
  if (typeof claims.email !== 'string' || claims.email.length === 0) {
    throw new GoogleTokenError('ID token carries no email claim');
  }
  return {
    email: claims.email,
    sub: typeof claims.sub === 'string' ? claims.sub : null,
  };
}

/**
 * Parse the ADMIN_EMAILS env value: comma-separated, case-insensitive,
 * blanks dropped. Returns a Set of lowercased addresses.
 */
export function parseAdminEmails(raw) {
  const out = new Set();
  if (typeof raw !== 'string') return out;
  for (const part of raw.split(',')) {
    const email = part.trim().toLowerCase();
    if (email.length > 0) out.add(email);
  }
  return out;
}
