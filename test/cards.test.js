const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function waitForHealth(baseUrl, child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('BotStream exited before becoming healthy');
    try { if ((await fetch(baseUrl + '/healthz')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('BotStream health check timed out');
}
const post = async (url, body, headers = {}) => {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
};

test('card pulls, collection passcode, editor validation and boss battles', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'botstream-cards-'));
  const port = await freePort(), base = 'http://127.0.0.1:' + port;
  const env = { ...process.env, PORT: String(port), DB_FILE: path.join(dir, 'data.json') };
  delete env.VERCEL; delete env.OWNER_PASSWORD;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(async () => { child.kill('SIGTERM'); await new Promise(r => child.once('exit', r)); await rm(dir, { recursive: true, force: true }); });
  await waitForHealth(base, child);

  const created = (await post(base + '/api/register', { slug: 'cardcreator', password: 'correct-horse-battery' })).data;
  const auth = { Authorization: 'Bearer ' + created.session };
  const me = await fetch(base + '/api/me', { headers: auth }).then(r => r.json());
  assert.ok(me.cards.length >= 3, 'starter cards exist');

  // Shared design system and pages are served.
  const css = await fetch(base + '/assets/botstream.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  for (const page of ['/app', '/pay/cardcreator', '/overlay']) assert.equal((await fetch(base + page)).status, 200, page);

  // Card editor: needs 3+ cards, bad rarity and non-https art are cleaned, script-like names stay inert text.
  const tooFew = await post(base + '/api/settings', { cards: [{ name: 'A' }, { name: 'B' }] }, auth);
  assert.equal(tooFew.data.ok, true);
  assert.equal((await fetch(base + '/api/me', { headers: auth }).then(r => r.json())).cards.length, me.cards.length, 'too few cards keeps the old set');
  await post(base + '/api/settings', {
    cards: [
      { name: 'Gold One', rarity: 'legendary', emoji: '👑', color: '#ffd700', art: 'javascript:alert(1)' },
      { name: 'Gold Two', rarity: 'legendary', emoji: '🌟', color: 'red', art: 'https://example.com/a.png' },
      { name: '<img src=x onerror=alert(1)>', rarity: 'nonsense', emoji: '🔥', color: '#112233' }
    ],
    cfg: { bossPower: 0, battleCost: 10, battleReward: 30 }
  }, auth);
  const edited = await fetch(base + '/api/me', { headers: auth }).then(r => r.json());
  assert.equal(edited.cards.length, 3);
  assert.equal(edited.cards[0].art, '', 'non-https art rejected');
  assert.equal(edited.cards[1].art, 'https://example.com/a.png');
  assert.equal(edited.cards[1].color, '#7b6cf6', 'invalid color falls back');
  assert.equal(edited.cards[2].rarity, 'common', 'unknown rarity becomes common');

  // A named tip with a passcode earns points and card pulls.
  await post(base + '/api/pay/cardcreator', { name: 'Collector', amount: 5, currency: 'USD', passcode: 'sesame' });
  const note = await post(base + '/api/notify/' + me.notifyToken, { text: 'Received USD $5.00 from Collector' });
  assert.equal(note.data.matched, true);
  const events = await fetch(base + '/events/' + me.alertToken + '?since=0').then(r => r.json());
  const pull = events.events.map(e => e.data).find(d => d.type === 'pull');
  assert.ok(pull, 'pull event emitted');
  assert.equal(pull.name, 'Collector');
  assert.equal(pull.cards.length, 3, 'a $5 tip pulls the max of 3 cards');

  // Collection requires the passcode.
  assert.equal((await post(base + '/api/cards/cardcreator', { name: 'Collector', passcode: 'wrong' })).status, 401);
  assert.equal((await post(base + '/api/cards/cardcreator', { name: 'Someone', passcode: 'sesame' })).status, 401);
  const coll = await post(base + '/api/cards/cardcreator', { name: 'collector', passcode: 'sesame' });
  assert.equal(coll.status, 200);
  assert.equal(Object.values(coll.data.owned).reduce((a, b) => a + b, 0), 3);
  assert.equal(coll.data.points, 50);

  // Public API exposes the card set but no secrets.
  const pub = await fetch(base + '/api/public/cardcreator').then(r => r.text());
  assert.ok(JSON.parse(pub).cards.length === 3);
  assert.ok(!/passcode|"pass"|salt|notifyToken|alertToken/.test(pub));

  // Battles: must own the card, need points, win against a power-0 boss, 12s arena cooldown.
  const ownedId = Object.keys(coll.data.owned)[0];
  const notOwned = edited.cards.find(c => !coll.data.owned[c.id]);
  const body = { name: 'Collector', passcode: 'sesame', cardId: ownedId };
  if (notOwned) assert.equal((await post(base + '/api/battle/cardcreator', { ...body, cardId: notOwned.id })).status, 400);
  assert.equal((await post(base + '/api/battle/cardcreator', { ...body, passcode: 'bad' })).status, 401);
  assert.equal((await post(base + '/api/battle/cardcreator', { ...body, cardId: 'does-not-exist' })).status, 400);
  const fight = await post(base + '/api/battle/cardcreator', body);
  assert.equal(fight.status, 200);
  const ownedCard = edited.cards.find(c => c.id === ownedId);
  assert.ok(fight.data.mine >= (ownedCard.rarity === 'legendary' ? 90 : 10));
  assert.equal(fight.data.points, fight.data.won ? 50 - 10 + 30 : 50 - 10);
  assert.equal((await post(base + '/api/battle/cardcreator', body)).status, 429, 'arena cooldown');
  const after = await fetch(base + '/events/' + me.alertToken + '?since=0').then(r => r.json());
  assert.ok(after.events.some(e => e.data.type === 'battle'), 'battle event emitted');

  // Test button for the stream overlay and the backup never leak passcode hashes.
  assert.equal((await post(base + '/api/test-card', {}, auth)).data.ok, true);
  const backup = await fetch(base + '/api/backup', { headers: auth }).then(r => r.text());
  assert.ok(!/"pass":"[0-9a-f]{64}"/.test(backup), 'backup has no passcode hashes');
  assert.equal(Object.keys(JSON.parse(backup).points.collector.cards).length > 0, true, 'backup keeps card collections');
});
