// Runner login CLI — Node standard library only.
//
//   node api/runner-login.mjs [--central <url>] [--data-dir <dir>]
//
// Logs in to the CENTRAL server's admin auth (POST /api/auth/login) with
// the admin password and stores the returned `plo_admin` session cookie
// in DATA_DIR/runner-config.json, which the local runner's uploader
// (uploader.mjs) uses to push finished solves to the central library.
//
// - The password is prompted on stdin with echo disabled when stdin is a
//   TTY; when stdin is piped, the first line is read as the password
//   (handy for scripted coordinator smokes; prefer the prompt).
// - --central / the CENTRAL_URL env var give the central base URL;
//   otherwise it is prompted for. A URL saved by a previous login is
//   offered as the default.
// - DATA_DIR resolves like the server's: --data-dir, else the DATA_DIR
//   env var, else ./data next to this file.
// - runner-config.json contains a live session cookie: treat it like a
//   password. On POSIX, `chmod 600 DATA_DIR/runner-config.json` (the CLI
//   reminds you; it does not chmod on Windows where ACLs differ).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_COOKIE } from './auth.mjs';
import { loadRunnerConfig, saveRunnerConfig } from './uploader.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function argValue(argv, name) {
  const idx = argv.indexOf(name);
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : null;
}

/** Read one line with echo disabled (TTY) or plainly (piped stdin). */
function readSecret(prompt) {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl >= 0) {
          stdin.pause();
          resolve(buf.slice(0, nl).replace(/\r$/, ''));
        }
      });
      stdin.on('end', () => resolve(buf.replace(/\r?\n$/, '')));
      stdin.on('error', reject);
      return;
    }
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch) => {
      if (ch === '\n' || ch === '\r' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        stdin.setRawMode(false);
        process.stdout.write('\n');
        reject(new Error('Aborted'));
      } else if (ch === '\u007f') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on('data', onData);
    stdin.on('error', reject);
  });
}

/** Read one ordinary line from stdin (used for the central URL prompt). */
function readLine(prompt) {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    let buf = '';
    stdin.setEncoding('utf8');
    const onData = (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        stdin.pause();
        stdin.removeListener('data', onData);
        resolve(buf.slice(0, nl).replace(/\r$/, '').trim());
      }
    };
    stdin.on('data', onData);
    stdin.on('end', () => resolve(buf.trim()));
    stdin.on('error', reject);
  });
}

/** Extract the plo_admin cookie value from a login response, or null. */
function sessionCookieFrom(response) {
  const headers = response.headers;
  const raw =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie')].filter(Boolean);
  for (const line of raw) {
    for (const part of String(line).split(/,(?=\s*[A-Za-z0-9_-]+=)/)) {
      const m = part.trim().match(new RegExp(`^${SESSION_COOKIE}=([^;]*)`));
      if (m) return decodeURIComponent(m[1]);
    }
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  const dataDir =
    argValue(argv, '--data-dir') ?? process.env.DATA_DIR ?? path.join(HERE, 'data');
  const prior = await loadRunnerConfig(dataDir);

  let centralUrl =
    argValue(argv, '--central') ?? process.env.CENTRAL_URL ?? prior?.central_url ?? '';
  if (!centralUrl) {
    centralUrl = await readLine('Central server base URL (e.g. http://100.x.y.z:8787): ');
  }
  centralUrl = centralUrl.replace(/\/+$/, '');
  if (!/^https?:\/\/.+/i.test(centralUrl)) {
    throw new Error(`Central URL "${centralUrl}" does not look like an http(s) base URL.`);
  }

  const password = await readSecret('Admin password for the central server: ');
  if (!password) throw new Error('No password given.');

  let response;
  try {
    response = await fetch(`${centralUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
  } catch (err) {
    throw new Error(
      `Could not reach ${centralUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body && typeof body.error === 'string') detail = body.error;
    } catch {
      // keep the HTTP status as the detail
    }
    throw new Error(`Login failed: ${detail}`);
  }
  const cookie = sessionCookieFrom(response);
  if (!cookie) {
    throw new Error('Login succeeded but no plo_admin session cookie was returned.');
  }
  await saveRunnerConfig(dataDir, { central_url: centralUrl, session_cookie: cookie });
  console.log(`Runner login saved to ${path.join(dataDir, 'runner-config.json')}`);
  console.log('That file holds a live session cookie — treat it like a password.');
  console.log('On POSIX hosts: chmod 600 ' + path.join(dataDir, 'runner-config.json'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
