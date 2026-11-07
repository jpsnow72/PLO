// Generate the ADMIN_PASSWORD_HASH value for the job service.
//
//   node hash-password.mjs            # prompts for the password on stdin
//   ADMIN_PASSWORD='...' node hash-password.mjs
//
// The resulting `scrypt$...` string is printed to stdout (and only
// there), ready to paste into the server's environment:
//
//   ADMIN_PASSWORD_HASH='scrypt$...' node server.mjs
//
// The plaintext password is never written to disk by this tool.

import { hashPassword } from './auth.mjs';

function readPasswordFromStdin() {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      // Piped input: take the first line.
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', (chunk) => {
        buf += chunk;
      });
      stdin.on('end', () => resolve(buf.split(/\r?\n/)[0] ?? ''));
      stdin.on('error', reject);
      return;
    }
    // Interactive TTY: read with echo disabled so the password is not
    // shown (and does not land in shell history via this terminal).
    process.stderr.write('Admin password: ');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (ch) => {
      if (ch === '\n' || ch === '\r' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stderr.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        process.stderr.write('\n');
        process.exit(130);
      } else if (ch === '\u007f') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const password = process.env.ADMIN_PASSWORD ?? (await readPasswordFromStdin());
if (!password) {
  process.stderr.write('No password provided; nothing generated.\n');
  process.exit(1);
}
const hash = await hashPassword(password);
process.stdout.write(`${hash}\n`);
process.stderr.write(
  'Store this as ADMIN_PASSWORD_HASH in the server environment. It cannot be reversed to the password.\n',
);
