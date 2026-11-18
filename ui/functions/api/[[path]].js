// Pages Function: same-site proxy for the PLO job service (WIRE-1).
//
// The browser client (ui/src/lib/api.ts) only ever calls same-origin
// relative paths (/api/...). In production those requests land here, on
// the Pages origin, and are forwarded verbatim to the API origin on the
// VPS (https://plo-api.finchlearn.com, Caddy -> api/server.mjs).
//
// Why a proxy instead of calling the API origin directly: the admin
// session cookie is SameSite=Lax, which browsers will not attach to
// cross-site fetches. Keeping /api on the Pages origin makes the cookie
// first-party, so login-gated calls work from the deployed site. See
// api/README.md, "Admin auth, CORS and cookies".
//
// This is a transparent pass-through: no body transformation, no added
// cache headers (the origin's own headers are returned as-is), and any
// origin status — including 401s — is returned untouched.
//
// The origin can be overridden per Pages environment with the
// API_ORIGIN variable (e.g. a preview deployment pointing at a staging
// box); it defaults to the production origin.

const DEFAULT_ORIGIN = 'https://plo-api.finchlearn.com';

export async function onRequest(context) {
  const { request, env } = context;
  const origin = env && env.API_ORIGIN ? env.API_ORIGIN : DEFAULT_ORIGIN;

  const incoming = new URL(request.url);
  const target = origin + incoming.pathname + incoming.search;

  // Forward the client's headers, minus the ones the fetch to the origin
  // must set itself: Host (the origin's, not the Pages host) and
  // Content-Length (recomputed from the streamed body; a copied value
  // can go stale and corrupt large ingest uploads).
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('content-length');

  const init = {
    method: request.method,
    headers,
    // Never follow redirects inside the proxy: pass them to the browser.
    redirect: 'manual',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // Stream the body through (ingest payloads can be hundreds of MB);
    // duplex: 'half' is required by the Workers runtime for stream bodies.
    init.body = request.body;
    init.duplex = 'half';
  }

  let upstream;
  try {
    upstream = await fetch(target, init);
  } catch {
    // Origin unreachable: answer in the API's own error shape so the
    // client surfaces its normal "engine offline" state (api.ts reads
    // `error` from JSON bodies).
    return new Response(JSON.stringify({ error: 'API origin unreachable' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Copy the response headers, taking care with Set-Cookie: collapsing
  // multiple cookies into one comma-joined header breaks them (cookie
  // Expires values contain commas), so re-append each cookie separately
  // when the runtime exposes them individually.
  const responseHeaders = new Headers(upstream.headers);
  if (typeof upstream.headers.getSetCookie === 'function') {
    const cookies = upstream.headers.getSetCookie();
    if (cookies.length > 0) {
      responseHeaders.delete('set-cookie');
      for (const cookie of cookies) {
        responseHeaders.append('set-cookie', cookie);
      }
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
