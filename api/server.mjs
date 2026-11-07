// Thin job service for PLO GTO Study — Node standard library only.
//
//   POST /api/solves            spot JSON -> job record (queued)
//   GET  /api/solves/:id        job status
//   GET  /api/solves/:id/result finished solve JSON (engine output)
//   GET  /api/jobs              all job records this process knows
//   GET  /api/library           finished solves in the data dir
//   GET  /api/library/:id       one library solve JSON
//
// Jobs run one at a time (solves are CPU-heavy). The service writes the
// spot JSON to DATA_DIR/jobs/<id>/spot.json, invokes the engine binary
// (solve-river for 5-card boards, solve-turn for 4-card boards, solve-flop
// for 3-card boards) from ENGINE_BIN, and on success copies the result
// into DATA_DIR/library/.
//
// NO AUTH: bind to localhost / a private network only. See README.md.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR ?? path.join(HERE, 'data');
const ENGINE_BIN =
  process.env.ENGINE_BIN ?? path.resolve(HERE, '..', 'engine', 'target', 'release');
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS ?? 30 * 60 * 1000);

const JOBS_DIR = path.join(DATA_DIR, 'jobs');
const LIBRARY_DIR = path.join(DATA_DIR, 'library');

/** @type {Map<string, object>} */
const jobs = new Map();
let jobChain = Promise.resolve();

function nowIso() {
  return new Date().toISOString();
}

function boardCardCount(board) {
  if (typeof board !== 'string') return 0;
  return board.split(/[\s,]+/).filter((t) => t.trim().length > 0).length;
}

function kindForBoard(board) {
  const n = boardCardCount(board);
  if (n === 5) return 'river';
  if (n === 4) return 'turn';
  if (n === 3) return 'flop';
  return null;
}

async function writeJobFile(job) {
  const dir = path.join(JOBS_DIR, job.id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'job.json'), JSON.stringify(job, null, 2));
}

async function runJob(job, spot) {
  job.status = 'running';
  await writeJobFile(job);
  const dir = path.join(JOBS_DIR, job.id);
  const spotPath = path.join(dir, 'spot.json');
  const resultPath = path.join(dir, 'result.json');
  await fs.writeFile(spotPath, JSON.stringify(spot, null, 2));

  const binaryName =
    job.kind === 'flop' ? 'solve-flop' : job.kind === 'turn' ? 'solve-turn' : 'solve-river';
  const binary = path.join(ENGINE_BIN, binaryName);
  try {
    await fs.access(binary);
  } catch {
    job.status = 'error';
    job.error = `Engine binary not found at ${binary}. Build the engine (cargo build --release) or set ENGINE_BIN.`;
    job.finished_at = nowIso();
    await writeJobFile(job);
    return;
  }

  const code = await new Promise((resolve) => {
    const child = spawn(binary, [spotPath, resultPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, JOB_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(-1);
    });
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      job.stderr_tail = stderr.slice(-2000);
      resolve(exitCode ?? -1);
    });
  });

  if (code !== 0) {
    job.status = 'error';
    job.error = `Engine exited with code ${code}. ${job.stderr_tail ?? ''}`.trim();
    job.finished_at = nowIso();
    await writeJobFile(job);
    return;
  }

  try {
    const raw = await fs.readFile(resultPath, 'utf8');
    const result = JSON.parse(raw);
    job.nash_distance_pct = result?.exploitability?.nash_distance_pct ?? null;
    job.iterations = result?.iterations ?? null;
    job.status = 'done';
    job.finished_at = nowIso();
    // Publish into the library.
    await fs.mkdir(LIBRARY_DIR, { recursive: true });
    await fs.writeFile(path.join(LIBRARY_DIR, `${job.id}.json`), raw);
    await fs.writeFile(
      path.join(LIBRARY_DIR, `${job.id}.meta.json`),
      JSON.stringify(
        {
          id: job.id,
          name: job.name,
          kind: job.kind,
          street: job.kind,
          board: job.board,
          nash_distance_pct: job.nash_distance_pct,
          iterations: job.iterations,
          finished_at: job.finished_at,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    job.status = 'error';
    job.error = `Could not read engine result: ${err instanceof Error ? err.message : String(err)}`;
    job.finished_at = nowIso();
  }
  await writeJobFile(job);
}

function publicJob(job) {
  const { stderr_tail, ...rest } = job;
  return rest;
}

async function listLibrary() {
  await fs.mkdir(LIBRARY_DIR, { recursive: true });
  const files = (await fs.readdir(LIBRARY_DIR)).filter(
    (f) => f.endsWith('.json') && !f.endsWith('.meta.json'),
  );
  const items = [];
  for (const file of files) {
    const id = file.replace(/\.json$/, '');
    const full = path.join(LIBRARY_DIR, file);
    try {
      const raw = await fs.readFile(full, 'utf8');
      const result = JSON.parse(raw);
      let meta = {};
      try {
        meta = JSON.parse(await fs.readFile(path.join(LIBRARY_DIR, `${id}.meta.json`), 'utf8'));
      } catch {
        meta = {};
      }
      const stat = await fs.stat(full);
      items.push({
        id,
        name: meta.name ?? `Solve · ${result.board ?? id}`,
        kind: meta.kind ?? meta.street ?? kindForBoard(result.board) ?? 'river',
        board: result.board ?? '',
        nash_distance_pct:
          result?.exploitability?.nash_distance_pct ?? meta.nash_distance_pct ?? null,
        iterations: result?.iterations ?? meta.iterations ?? null,
        finished_at: meta.finished_at ?? null,
        size_bytes: stat.size,
      });
    } catch {
      // Skip unreadable entries rather than failing the whole list.
    }
  }
  items.sort((a, b) => String(b.finished_at ?? '').localeCompare(String(a.finished_at ?? '')));
  return items;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const parts = url.pathname.split('/').filter((p) => p.length > 0);
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/solves') {
      const text = await readBody(req);
      let spot;
      try {
        spot = JSON.parse(text);
      } catch {
        sendJson(res, 400, { error: 'Body must be valid JSON (an engine spot).' });
        return;
      }
      const kind = kindForBoard(spot?.board);
      if (kind === null) {
        sendJson(res, 400, { error: 'Spot board must have 3, 4 or 5 cards.' });
        return;
      }
      const job = {
        id: randomUUID().slice(0, 8),
        status: 'queued',
        kind,
        board: spot.board,
        name: `Custom solve · ${spot.board}`,
        created_at: nowIso(),
        finished_at: null,
        nash_distance_pct: null,
        iterations: null,
        error: null,
      };
      jobs.set(job.id, job);
      await writeJobFile(job);
      // Serial queue: one solve at a time.
      jobChain = jobChain.then(() => runJob(job, spot)).catch(() => undefined);
      sendJson(res, 202, publicJob(job));
      return;
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'solves' && parts[2]) {
      const job = jobs.get(parts[2]);
      if (!job) {
        sendJson(res, 404, { error: 'Unknown job id' });
        return;
      }
      if (parts[3] === 'result') {
        if (job.status !== 'done') {
          sendJson(res, 409, { error: `Job is ${job.status}, no result yet` });
          return;
        }
        const raw = await fs.readFile(path.join(JOBS_DIR, job.id, 'result.json'), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(raw);
        return;
      }
      sendJson(res, 200, publicJob(job));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      sendJson(res, 200, { jobs: [...jobs.values()].map(publicJob) });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/library') {
      sendJson(res, 200, { library: await listLibrary() });
      return;
    }

    if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'library' && parts[2]) {
      if (!/^[A-Za-z0-9_-]+$/.test(parts[2])) {
        sendJson(res, 400, { error: 'Bad library id' });
        return;
      }
      const file = path.join(LIBRARY_DIR, `${parts[2]}.json`);
      try {
        const raw = await fs.readFile(file, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(raw);
      } catch {
        sendJson(res, 404, { error: 'Unknown library id' });
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, engine_bin: ENGINE_BIN, data_dir: DATA_DIR });
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : 'Internal error' });
  }
});

await fs.mkdir(JOBS_DIR, { recursive: true });
await fs.mkdir(LIBRARY_DIR, { recursive: true });
server.listen(PORT, HOST, () => {
  console.log(`plo-api listening on http://${HOST}:${PORT}`);
  console.log(`  ENGINE_BIN=${ENGINE_BIN}`);
  console.log(`  DATA_DIR=${DATA_DIR}`);
});
