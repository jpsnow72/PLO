import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { server } from './server.mjs';

let baseUrl = '';

before(async () => {
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
});

async function postMultiway(body) {
  const res = await fetch(`${baseUrl}/api/multiway/equity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('POST /api/multiway/equity: exact 3-way river hand vs hands', async () => {
  const { status, json } = await postMultiway({
    board: ['As', 'Ks', 'Qs', '2d', '3c'],
    hero_hand: 'Js Ts 4h 5h',
    opponents: ['Ah Ad Kh Kd', '9s 8s 6d 7d'],
  });
  assert.equal(status, 200);
  assert.equal(json.mode, 'exact');
  assert.equal(json.hero_equity, 1);
  assert.equal(json.players.length, 3);
  assert.equal(json.players[0].equity, 1);
  assert.equal(json.players[1].equity, 0);
  assert.equal(json.players[2].equity, 0);
});

test('POST /api/multiway/equity: exact river hand vs random preset', async () => {
  const { status, json } = await postMultiway({
    board: 'As Ks Qs 2d 3c',
    hero_hand: 'JsTs4h5h',
    opponents: ['random'],
  });
  assert.equal(status, 200);
  assert.equal(json.mode, 'exact');
  assert.equal(json.badge, 'EXACT');
  assert.equal(json.estimated_showdowns, 123410);
  assert.equal(json.hero_equity, 1);
  assert.equal(json.players.length, 2);
});

test('POST /api/multiway/equity: solver range text format and Monte Carlo mode for wide 3-way flop', async () => {
  const { status, json } = await postMultiway({
    board: ['As', 'Kd', '7c'],
    hero_hand: 'Ah Ad Ks Qs',
    opponents: [
      'KhKdQsJs:1.0\nQhQdJsTs:0.5',
      'random',
    ],
    samples: 5000,
    seed: 12345,
  });
  assert.equal(status, 200);
  assert.equal(json.mode, 'monte_carlo');
  assert.equal(json.samples, 5000);
  assert.equal(json.players.length, 3);
  const sum = json.players.reduce((acc, p) => acc + p.equity, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-6, `Expected equities to sum to 1.0, got ${sum}`);
});

test('POST /api/multiway/equity: hero range distribution (mean, quartiles, deciles)', async () => {
  const { status, json } = await postMultiway({
    board: ['As', 'Ks', 'Qs', '2d', '3c'],
    hero_range: 'JsTs4h5h:1\n9s8s4d5d:1\n2h2s4c5c:1\n7h8h9dTd:1',
    opponents: ['AhAdKhKd:1'],
  });
  assert.equal(status, 200);
  assert.equal(json.mode, 'exact');
  assert.ok(json.hero_range_distribution, 'Expected hero_range_distribution');
  assert.equal(json.hero_range_distribution.combo_count, 4);
  assert.ok(Array.isArray(json.hero_range_distribution.quartiles));
  assert.equal(json.hero_range_distribution.quartiles.length, 5);
  assert.ok(json.hero_range_distribution.top_decile.length >= 1);
  assert.ok(json.hero_range_distribution.bottom_decile.length >= 1);
});

test('POST /api/multiway/equity: validates opponent count (1..4)', async () => {
  const resZero = await postMultiway({
    board: 'As Kd 7c',
    hero_hand: 'Ah Ad Ks Qs',
    opponents: [],
  });
  assert.equal(resZero.status, 400);

  const resFive = await postMultiway({
    board: 'As Kd 7c',
    hero_hand: 'Ah Ad Ks Qs',
    opponents: ['random', 'random', 'random', 'random', 'random'],
  });
  assert.equal(resFive.status, 400);
});

test('POST /api/multiway/equity: rejects invalid cards and duplicate cards across board/hero', async () => {
  const badCard = await postMultiway({
    board: 'As Kd 10c',
    hero_hand: 'Ah Ad Ks Qs',
    opponents: ['random'],
  });
  assert.equal(badCard.status, 400);

  const dupBoardHero = await postMultiway({
    board: 'As Kd 7c',
    hero_hand: 'As Ad Ks Qs',
    opponents: ['random'],
  });
  assert.equal(dupBoardHero.status, 400);
  assert.match(dupBoardHero.json.error, /duplicate card/i);
});
