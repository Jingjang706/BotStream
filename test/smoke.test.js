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
    try {
      const response = await fetch(baseUrl + '/healthz');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('BotStream health check timed out');
}

function startServer(port, dbFile) {
  const env = { ...process.env, PORT: String(port), DB_FILE: dbFile };
  delete env.VERCEL;
  delete env.OWNER_PASSWORD;
  return spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env,
    stdio: ['ignore', 'ignore', 'pipe']
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return { response, data: await response.json() };
}

test('creator registration, tip matching, overlay events, and disk persistence', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'botstream-'));
  const dbFile = path.join(dir, 'data.json');
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  let child = startServer(port, dbFile);

  t.after(async () => {
    await stopServer(child);
    await rm(dir, { recursive: true, force: true });
  });

  await waitForHealth(base, child);

  const { response: registration, data: created } = await postJson(base + '/api/register', {
    slug: 'testcreator',
    password: 'correct-horse-battery'
  });
  assert.equal(registration.status, 200);
  assert.ok(created.session);
  assert.ok(created.recovery);

  const auth = { Authorization: 'Bearer ' + created.session };
  const meResponse = await fetch(base + '/api/me', { headers: auth });
  assert.equal(meResponse.status, 200);
  const me = await meResponse.json();
  assert.equal(me.slug, 'testcreator');
  assert.ok(me.alertToken);
  assert.ok(me.notifyToken);

  const { response: pendingResponse, data: pending } = await postJson(base + '/api/pay/testcreator', {
    name: 'Stream Supporter',
    amount: 4.5,
    currency: 'USD',
    message: 'Keep going!'
  });
  assert.equal(pendingResponse.status, 200);
  assert.equal(pending.ok, true);

  const notificationText = 'Received USD $4.50 from Stream Supporter';
  const notify = await postJson(base + '/api/notify/' + me.notifyToken, { text: notificationText });
  assert.equal(notify.response.status, 200);
  assert.equal(notify.data.matched, true);

  const eventsResponse = await fetch(base + '/events/' + me.alertToken + '?since=0');
  assert.equal(eventsResponse.status, 200);
  const eventPayload = await eventsResponse.json();
  assert.ok(eventPayload.events.some(event => event.data.type === 'tip'));
  assert.equal(eventPayload.stats.raised, 4.5);

  // A repeated bank notification must not create a second tip alert.
  const duplicate = await postJson(base + '/api/notify/' + me.notifyToken, { text: notificationText });
  assert.equal(duplicate.data.matched, true);
  const afterDuplicate = await fetch(base + '/events/' + me.alertToken + '?since=0').then(r => r.json());
  assert.equal(afterDuplicate.stats.raised, 4.5);

  await stopServer(child);
  child = startServer(port, dbFile);
  await waitForHealth(base, child);

  const { response: loginResponse, data: loggedIn } = await postJson(base + '/api/login', {
    slug: 'testcreator',
    password: 'correct-horse-battery'
  });
  assert.equal(loginResponse.status, 200);
  assert.ok(loggedIn.session);

  const afterRestart = await fetch(base + '/api/me', {
    headers: { Authorization: 'Bearer ' + loggedIn.session }
  }).then(r => r.json());
  assert.equal(afterRestart.slug, 'testcreator');
  assert.equal(afterRestart.stats.raised, 4.5);
  assert.equal(afterRestart.tips.length, 1);
});
