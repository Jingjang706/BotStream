// LiveTip KH server. No npm install needed. Run: node server.js  (Node 18+)
// Owner mode env: OWNER_PASSWORD (turns it on), OWNER_SLUG, ALERT_TOKEN, NOTIFY_TOKEN, LANDING=1
// Optional env: PORT, DB_FILE, ADMIN_KEY, TELEGRAM_BOT_TOKEN, GOOGLE_TTS_KEY, YOUTUBE_API_KEY
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const E = process.env, PORT = E.PORT || 3000, DB = E.DB_FILE || 'data.json', KHR_RATE = 4000;
const VERCEL = !!E.VERCEL;
const Ably = VERCEL && E.ABLY_API_KEY ? require('ably/promises') : null;
const ably = Ably ? new Ably.Rest(E.ABLY_API_KEY) : null;
const channelName = token => 'botstream:' + token;
const requestContext = new AsyncLocalStorage();
let localDb = { users: {}, sessions: {} };
if (!VERCEL) {
  try { localDb = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch {}
}
const currentDb = () => requestContext.getStore() || localDb;
const db = new Proxy({}, {
  get: (_target, key) => currentDb()[key],
  set: (_target, key, value) => { currentDb()[key] = value; return true; }
});
const save = () => {
  const state = currentDb();
  if (VERCEL) { state.__dirty = true; return; }
  fs.writeFileSync(DB, JSON.stringify(state));
};

const REDIS = VERCEL ? require('@upstash/redis').Redis.fromEnv() : null;
const PREFIX = String(E.BOTSTREAM_NAMESPACE || 'botstream:production').replace(/[^a-zA-Z0-9:_-]/g, '').slice(0, 80);
const REDIS_USERS = PREFIX + ':v1:users';
const REDIS_SESSIONS = PREFIX + ':v1:sessions';
const REDIS_LOCK = PREFIX + ':v1:write-lock';
const overlayKey = token => PREFIX + ':v1:overlay:' + token;
const userKey = slug => PREFIX + ':v1:user:' + encodeURIComponent(slug);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const parseStored = value => {
  if (value == null) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
};
async function acquireRedisLock() {
  const token = crypto.randomBytes(16).toString('hex'), deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await REDIS.set(REDIS_LOCK, token, { nx: true, ex: 60 });
    if (result === 'OK' || result === true) return token;
    await pause(120);
  }
  throw new Error('The data store is busy. Please retry.');
}
async function releaseRedisLock(token) {
  if (!token) return;
  await REDIS.eval(
    'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
    [REDIS_LOCK], [token]
  );
}
async function loadRedisDb() {
  const slugs = await REDIS.smembers(REDIS_USERS) || [], users = {};
  for (let i = 0; i < slugs.length; i += 50) {
    const group = slugs.slice(i, i + 50);
    const values = await REDIS.mget(...group.map(userKey));
    group.forEach((slug, j) => {
      const value = parseStored(values[j]);
      if (value) users[slug] = value;
    });
  }
  const sessions = await REDIS.hgetall(REDIS_SESSIONS) || {};
  return { users, sessions };
}
function remoteSnapshot(state) {
  return {
    users: Object.fromEntries(Object.entries(state.users).map(([slug, user]) => [slug, JSON.stringify(user)])),
    sessions: { ...state.sessions }
  };
}
async function persistRedisDb(state, before) {
  const tasks = [];
  for (const [slug, user] of Object.entries(state.users)) {
    const serialized = JSON.stringify(user);
    if (before.users[slug] === serialized) continue;
    tasks.push(REDIS.set(userKey(slug), serialized));
    tasks.push(REDIS.sadd(REDIS_USERS, slug));
    if (user.alertToken) {
      tasks.push(REDIS.set(overlayKey(user.alertToken), JSON.stringify({
        cursor: user.eventSeq || 0,
        events: user.events || [],
        stats: stats(user)
      })));
    }
    const oldUser = parseStored(before.users[slug]);
    if (oldUser && oldUser.alertToken && oldUser.alertToken !== user.alertToken) {
      tasks.push(REDIS.del(overlayKey(oldUser.alertToken)));
    }
  }
  for (const slug of Object.keys(before.users)) {
    if (state.users[slug]) continue;
    const oldUser = parseStored(before.users[slug]);
    tasks.push(REDIS.del(userKey(slug)));
    tasks.push(REDIS.srem(REDIS_USERS, slug));
    if (oldUser && oldUser.alertToken) tasks.push(REDIS.del(overlayKey(oldUser.alertToken)));
  }
  const tokens = new Set([...Object.keys(before.sessions), ...Object.keys(state.sessions)]);
  for (const token of tokens) {
    if (before.sessions[token] === state.sessions[token]) continue;
    if (state.sessions[token]) tasks.push(REDIS.hset(REDIS_SESSIONS, { [token]: state.sessions[token] }));
    else tasks.push(REDIS.hdel(REDIS_SESSIONS, token));
  }
  await Promise.all(tasks);
  state.__dirty = false;
}
const rid = () => crypto.randomBytes(16).toString('hex');
const hash = (p, s) => crypto.scryptSync(String(p), s, 32).toString('hex');
const clients = {}, hits = {}, chatIds = {};
const send = (u, ev) => {
  u.eventSeq = (u.eventSeq || 0) + 1;
  u.events = u.events || [];
  u.events.push({ id: u.eventSeq, at: Date.now(), data: ev });
  if (u.events.length > 200) u.events.splice(0, u.events.length - 200);
  save();
  (clients[u.alertToken] || []).forEach(r => r.write('data: ' + JSON.stringify(ev) + '\n\n'));
  if (ably) {
    ably.channels.get(channelName(u.alertToken)).publish('event', ev)
      .catch(error => console.error('BotStream realtime publish failed:', error));
  }
};
const usd = t => t.currency === 'KHR' ? t.amount / KHR_RATE : t.amount;
const DEF = { spinMin: 10, timerPerUsd: 1, scareMin: 20, mediaMin: 2, pointsPerUsd: 10, tgChat: '', ytVideo: '', discordHook: '' };
const DEFREDEEMS = [{ id: 'r1', title: 'Jumpscare', cost: 200, kind: 'scare' }, { id: 'r2', title: 'Spin the wheel', cost: 100, kind: 'spin' }, { id: 'r3', title: 'Shoutout', cost: 50, kind: 'alert' }];
const KINDS = ['alert', 'scare', 'spin'];
const pts = u => (u.points = u.points || {});
const pkey = n => String(n || '').trim().toLowerCase().slice(0, 30);
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
// A viewer proves who they are with the passcode they chose on their first matched tip.
const acct = (u, name, pass) => { const a = pts(u)[pkey(name)]; return a && a.pass && pass && eq(hash(pass, u.salt), a.pass) ? a : null; };
const SLICES = ['Shoutout', 'Song request', 'Ask me anything', 'Try again'];
const cfg = u => ({ ...DEF, ...u.cfg });
const ip = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
function limited(req, key, max) {
  const k = key + ip(req), now = Date.now(), h = hits[k] = (hits[k] || []).filter(t => now - t < 60000);
  h.push(now); return h.length > max;
}
const dc = (hook, content) => hook && /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(hook) && fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: String(content).slice(0, 1900) }) }).catch(() => {});
const tg = (chat, text) => E.TELEGRAM_BOT_TOKEN && chat && fetch('https://api.telegram.org/bot' + E.TELEGRAM_BOT_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text }) }).catch(() => {});

function tops(u) {
  const by = {};
  for (const t of u.tips) by[t.name] = (by[t.name] || 0) + usd(t);
  return Object.entries(by).sort((a, b) => b[1] - a[1]);
}
const pubPoll = u => u.poll ? { q: u.poll.q, open: u.poll.open, options: u.poll.options.map(o => ({ t: o.t, v: o.v })) } : null;
const pubPred = u => u.pred ? { q: u.pred.q, state: u.pred.state, win: u.pred.win, options: u.pred.options.map((t, i) => ({ t, pool: u.pred.bets.filter(b => b.i === i).reduce((s, b) => s + b.amt, 0) })) } : null;
function stats(u) {
  const raised = u.tips.reduce((s, t) => s + usd(t), 0);
  return { type: 'stats', goal: u.goal, raised: +raised.toFixed(2), top: tops(u).slice(0, 5).map(([name, v]) => ({ name, usd: +v.toFixed(2) })), timer: u.timer || 0, poll: pubPoll(u), pred: pubPred(u), tts: !!E.GOOGLE_TTS_KEY, video: cfg(u).ytVideo };
}
function spin(u, title, slices) {
  slices = slices || u.wheel || SLICES;
  send(u, { type: 'spin', title, slices, index: crypto.randomInt(slices.length) });
}

// Reads a bank notification. Banks word these differently, so adjust the patterns to match yours.
const payer = t => (t.match(/paid by\s+(.+?)(?:\s*[\(,.]|\s+on\s|\s+via\s|$)/i) || [])[1] || '';
function parse(text) {
  if (!/paid|received|credit|ទទួល|ទូទាត់/i.test(text)) return null;
  const num = s => parseFloat(s.replace(/,/g, ''));
  let m = text.match(/(?:\$|USD)\s?([\d,]+(?:\.\d+)?)/i) || text.match(/([\d,]+(?:\.\d+)?)\s?(?:USD|\$)/i);
  if (m) return { amount: num(m[1]), currency: 'USD', payer: payer(text) };
  m = text.match(/(?:៛|KHR)\s?([\d,]+(?:\.\d+)?)/i) || text.match(/([\d,]+(?:\.\d+)?)\s?(?:៛|KHR)/i);
  if (m) return { amount: num(m[1]), currency: 'KHR', payer: payer(text) };
  return null;
}

function handleNote(u, text) {
  const n = parse(text), now = Date.now();
  if (!n || !(n.amount > 0)) return false;
  if (u.lastNote && u.lastNote.text === text && now - u.lastNote.at < 60000) return true; // duplicate
  u.lastNote = { text, at: now };
  u.pending = u.pending.filter(p => now - p.at < 15 * 60000);
  const i = u.pending.findIndex(p => p.currency === n.currency && Math.abs(p.amount - n.amount) < 0.001);
  const p = i >= 0 ? u.pending.splice(i, 1)[0] : null;
  const tip = { id: rid(), name: (p && p.name) || n.payer || 'Anonymous', message: p ? p.message : '', amount: n.amount, currency: n.currency, at: now };
  const c = cfg(u), v = usd(tip), before = (tops(u)[0] || [])[0];
  if (p && p.media) tip.media = p.media;
  if (c.scareMin > 0 && v >= c.scareMin) tip.scare = true;
  u.tips.push(tip); u.tips = u.tips.slice(-1000);
  const after = tops(u)[0][0];
  if (before && after === tip.name && before !== after) tip.champion = true;
  if (u.timer > now && c.timerPerUsd > 0) u.timer += Math.round(c.timerPerUsd * v * 60000);
  u.raffle = u.raffle || []; if (!u.raffle.includes(tip.name)) u.raffle.push(tip.name);
  if (p && c.pointsPerUsd > 0 && tip.name !== 'Anonymous') {
    const a = pts(u)[pkey(tip.name)] = pts(u)[pkey(tip.name)] || { name: tip.name, p: 0 };
    a.p += Math.floor(v * c.pointsPerUsd); if (!a.pass && p.pass) a.pass = p.pass;
    tip.points = a.p;
  }
  save();
  send(u, { type: 'tip', ...tip });
  if (c.spinMin > 0 && v >= c.spinMin) spin(u, tip.name + ' spins the wheel');
  send(u, stats(u));
  dc(c.discordHook, tip.name + ' tipped ' + (tip.currency === 'KHR' ? '៛' + tip.amount : '$' + tip.amount) + (tip.message ? ': ' + tip.message : ''));
  tg(c.tgChat, tip.name + ' tipped ' + (tip.currency === 'KHR' ? '៛' + tip.amount : '$' + tip.amount) + (tip.message ? ': ' + tip.message : ''));
  return true;
}

async function videoOk(id) {
  try {
    const r = await fetch('https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=' + id, { signal: AbortSignal.timeout(4000) });
    return ![400, 401, 403, 404].includes(r.status);
  } catch { return true; } // YouTube unreachable: do not block the tip
}
async function ytchat(video, page) {
  const K = E.YOUTUBE_API_KEY, g = u => fetch(u).then(r => r.json());
  if (!chatIds[video]) {
    const j = await g('https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=' + video + '&key=' + K);
    chatIds[video] = j.items && j.items[0] && j.items[0].liveStreamingDetails && j.items[0].liveStreamingDetails.activeLiveChatId;
  }
  if (!chatIds[video]) return { error: 'No live chat found for that video.' };
  const j = await g('https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet,authorDetails&liveChatId=' + chatIds[video] + '&pageToken=' + (page || '') + '&key=' + K);
  return { messages: (j.items || []).map(i => ({ author: i.authorDetails.displayName, text: i.snippet.displayMessage })), next: j.nextPageToken, wait: Math.max(j.pollingIntervalMillis || 5000, 4000) };
}

const json = (res, o, c = 200) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const rawBody = req => new Promise(r => { let b = ''; req.on('data', c => { b += c; if (b.length > 3e6) req.destroy(); }); req.on('end', () => r(b)); });
const authUser = req => db.users[db.sessions[(req.headers.authorization || '').replace('Bearer ', '')]];
const byToken = (k, v) => Object.values(db.users).find(x => x[k] === v);
const page = (res, f) => { try { res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }); res.end(fs.readFileSync(path.join(__dirname, 'public', f))); } catch { res.writeHead(404); res.end(); } };
const login = (res, slug, extra) => { const t = rid(); db.sessions[t] = slug; save(); json(res, { session: t, ...extra }); };
const adminOk = req => E.ADMIN_KEY && req.headers['x-admin-key'] === E.ADMIN_KEY;

const newUser = (slug, salt) => ({ slug, name: slug, salt, pass: '', rec: '', created: Date.now(), alertToken: rid(), notifyToken: rid(), goal: { title: 'Stream goal', target: 50 }, khqr: '', tips: [], pending: [], raffle: [], cfg: {}, wheel: SLICES, timer: 0, poll: null, points: {}, redeems: DEFREDEEMS, pred: null });

// Single-owner mode: set OWNER_PASSWORD and the server has one account, made from your settings. Signups are closed.
const SINGLE = !!E.OWNER_PASSWORD, OWNER = (E.OWNER_SLUG || 'owner').toLowerCase();
if (SINGLE && !VERCEL) {
  const o = db.users[OWNER] = db.users[OWNER] || newUser(OWNER, rid());
  o.pass = hash(E.OWNER_PASSWORD, o.salt);
  if (E.ALERT_TOKEN) o.alertToken = E.ALERT_TOKEN;   // fixed links keep working after restarts
  if (E.NOTIFY_TOKEN) o.notifyToken = E.NOTIFY_TOKEN;
  save();
}
function ensureOwner() {
  if (!SINGLE) return;
  const existed = !!db.users[OWNER];
  const o = db.users[OWNER] || newUser(OWNER, rid());
  db.users[OWNER] = o;
  const nextPass = hash(E.OWNER_PASSWORD, o.salt);
  let changed = !existed || o.pass !== nextPass;
  o.pass = nextPass;
  if (E.ALERT_TOKEN && o.alertToken !== E.ALERT_TOKEN) { o.alertToken = E.ALERT_TOKEN; changed = true; }
  if (E.NOTIFY_TOKEN && o.notifyToken !== E.NOTIFY_TOKEN) { o.notifyToken = E.NOTIFY_TOKEN; changed = true; }
  if (changed) save();
}

async function app(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  const url = new URL(req.url, 'http://x'), p = url.pathname, m = req.method, q = url.searchParams;
  const raw = m === 'POST' ? await rawBody(req) : '';
  let b = {}; try { b = JSON.parse(raw); } catch {}

  if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (p === '/api/config') return json(res, { single: SINGLE });
  if (p === '/') {
    if (SINGLE && !E.LANDING) { res.writeHead(302, { Location: '/pay/' + OWNER }); return res.end(); }
    return page(res, 'index.html');
  }
  if (p === '/app') return page(res, 'app.html');
  if (p === '/overlay') return page(res, 'overlay.html');
  if (p === '/admin') return page(res, 'admin.html');
  if (p.startsWith('/pay/')) return page(res, 'pay.html');

  if (p === '/api/register' && m === 'POST') {
    if (SINGLE) return json(res, { error: 'Registration is closed.' }, 403);
    if (limited(req, 'reg', 5)) return json(res, { error: 'Too many tries. Wait a minute.' }, 429);
    const slug = String(b.slug || '').toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(slug) || String(b.password || '').length < 6) return json(res, { error: 'Username: 3 to 20 letters or numbers. Password: at least 6 characters.' }, 400);
    if (db.users[slug]) return json(res, { error: 'That username is taken.' }, 409);
    const salt = rid(), rec = rid().slice(0, 12);
    db.users[slug] = { ...newUser(slug, salt), pass: hash(b.password, salt), rec: hash(rec, salt) };
    return login(res, slug, { recovery: rec });
  }
  if (p === '/api/login' && m === 'POST') {
    if (limited(req, 'login', 10)) return json(res, { error: 'Too many tries. Wait a minute.' }, 429);
    const u = db.users[String(b.slug || '').toLowerCase()];
    if (!u || hash(b.password, u.salt) !== u.pass) return json(res, { error: 'Wrong username or password.' }, 401);
    return login(res, u.slug);
  }
  if (p === '/api/reset' && m === 'POST') {
    if (SINGLE) return json(res, { error: 'To reset, change OWNER_PASSWORD on the server and restart.' }, 403);
    if (limited(req, 'reset', 5)) return json(res, { error: 'Too many tries. Wait a minute.' }, 429);
    const u = db.users[String(b.slug || '').toLowerCase()];
    if (!u || String(b.password || '').length < 6 || hash(b.recovery, u.salt) !== u.rec) return json(res, { error: 'Recovery code or password is not valid.' }, 401);
    u.pass = hash(b.password, u.salt); return login(res, u.slug);
  }
  if (p.startsWith('/api/public/')) {
    const u = db.users[p.slice(12)];
    return u ? json(res, { name: u.name, khqr: u.khqr, poll: pubPoll(u), pred: pubPred(u), mediaMin: cfg(u).mediaMin, pointsPerUsd: cfg(u).pointsPerUsd, redeems: u.redeems || DEFREDEEMS }) : json(res, { error: 'Not found' }, 404);
  }
  if (p.startsWith('/api/pay/') && m === 'POST') {
    if (limited(req, 'pay', 20)) return json(res, { error: 'Too many tries. Wait a minute.' }, 429);
    const u = db.users[p.slice(9)], amount = +b.amount;
    if (!u || !(amount > 0) || !['USD', 'KHR'].includes(b.currency)) return json(res, { error: 'Check the amount.' }, 400);
    let media;
    if (b.videoUrl) {
      media = (String(b.videoUrl).match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([\w-]{11})/) || [])[1];
      const c = cfg(u);
      if (!media) return json(res, { error: 'That is not a YouTube link.' }, 400);
      if (usd({ amount, currency: b.currency }) < c.mediaMin) return json(res, { error: 'Media share starts at $' + c.mediaMin + '.' }, 400);
      if (!(await videoOk(media))) return json(res, { error: 'That video can’t be played on stream. Try another one.' }, 400);
    }
    u.pending.push({ name: String(b.name || 'Anonymous').slice(0, 30), message: String(b.message || '').slice(0, 150), amount, currency: b.currency, media, pass: b.passcode ? hash(String(b.passcode).slice(0, 40), u.salt) : '', at: Date.now() });
    u.pending = u.pending.slice(-50); save();
    return json(res, { ok: true });
  }
  if (p.startsWith('/api/vote/') && m === 'POST') {
    if (limited(req, 'vote', 30)) return json(res, { error: 'Too many tries.' }, 429);
    const u = db.users[p.slice(10)], pl = u && u.poll, o = pl && pl.options[+b.i];
    if (!pl || !pl.open || !o) return json(res, { error: 'Voting is closed.' }, 400);
    const who = crypto.createHash('sha256').update(ip(req) + pl.id).digest('hex').slice(0, 16);
    if (pl.voters.includes(who)) return json(res, { error: 'You already voted.' }, 409);
    pl.voters.push(who); o.v++; save(); send(u, stats(u)); return json(res, { ok: true });
  }
  if (p.startsWith('/api/points/') && m === 'POST') {
    if (limited(req, 'points', 30)) return json(res, { error: 'Too many tries.' }, 429);
    const u = db.users[p.slice(12)], a = u && acct(u, b.name, b.passcode);
    return a ? json(res, { points: a.p, name: a.name }) : json(res, { error: 'Wrong name or passcode. Your passcode is set with your first paid tip.' }, 401);
  }
  if (p.startsWith('/api/redeem/') && m === 'POST') {
    if (limited(req, 'redeem', 20)) return json(res, { error: 'Too many tries.' }, 429);
    const u = db.users[p.slice(12)], a = u && acct(u, b.name, b.passcode);
    if (!a) return json(res, { error: 'Wrong name or passcode.' }, 401);
    const r = (u.redeems || DEFREDEEMS).find(x => x.id === b.id);
    if (!r) return json(res, { error: 'That redeem does not exist.' }, 400);
    if (a.p < r.cost) return json(res, { error: 'Not enough points. You have ' + a.p + ', this costs ' + r.cost + '.' }, 400);
    a.p -= r.cost; save();
    send(u, { type: 'redeem', name: a.name, title: r.title, kind: r.kind, message: String(b.message || '').slice(0, 150) });
    if (r.kind === 'spin') spin(u, a.name + ' redeemed ' + r.title);
    return json(res, { ok: true, points: a.p });
  }
  if (p.startsWith('/api/bet/') && m === 'POST') {
    if (limited(req, 'bet', 30)) return json(res, { error: 'Too many tries.' }, 429);
    const u = db.users[p.slice(9)], a = u && acct(u, b.name, b.passcode), pr = u && u.pred, amt = Math.floor(+b.amount), i = Math.floor(+b.i);
    if (!a) return json(res, { error: 'Wrong name or passcode.' }, 401);
    if (!pr || pr.state !== 'open') return json(res, { error: 'Betting is closed.' }, 400);
    if (!(i >= 0 && i < pr.options.length) || !(amt >= 1)) return json(res, { error: 'Pick an outcome and an amount.' }, 400);
    if (amt > a.p) return json(res, { error: 'You only have ' + a.p + ' points.' }, 400);
    const k = pkey(a.name), prev = pr.bets.find(x => x.k === k);
    if (prev && prev.i !== i) return json(res, { error: 'You already bet on a different outcome.' }, 400);
    a.p -= amt; if (prev) prev.amt += amt; else pr.bets.push({ k, i, amt });
    save(); send(u, stats(u)); return json(res, { ok: true, points: a.p });
  }
  if (p.startsWith('/api/notify/') && m === 'POST') {
    if (limited(req, 'notify', 60)) return json(res, { error: 'Too many requests.' }, 429);
    const u = byToken('notifyToken', p.slice(12));
    if (!u) return json(res, { error: 'Bad token' }, 404);
    return json(res, { matched: handleNote(u, String(b.text || b.message || raw)) });
  }
  if (p === '/api/ably-token' && m === 'GET') {
    const owner = byToken('alertToken', q.get('token') || '');
    if (!owner || !ably) return json(res, { error: 'Realtime is not configured.' }, 501);
    try {
      const tokenRequest = await ably.auth.createTokenRequest({
        clientId: 'overlay-' + owner.alertToken.slice(0, 12),
        capability: { [channelName(owner.alertToken)]: ['subscribe'] },
        ttl: 60 * 60 * 1000
      });
      res.setHeader('Cache-Control', 'no-store');
      return json(res, tokenRequest);
    } catch (error) {
      console.error('BotStream realtime token error:', error);
      return json(res, { error: 'Could not authorize overlay connection.' }, 503);
    }
  }

  if (p === '/api/tts') { // Khmer voice from Google Cloud Text-to-Speech, when GOOGLE_TTS_KEY is set
    const u = byToken('alertToken', q.get('token') || '');
    if (!u || !E.GOOGLE_TTS_KEY) { res.writeHead(501); return res.end(); }
    try {
      const r = await (await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + E.GOOGLE_TTS_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: { text: String(q.get('text') || '').slice(0, 250) }, voice: { languageCode: 'km-KH' }, audioConfig: { audioEncoding: 'MP3' } }) })).json();
      if (!r.audioContent) { res.writeHead(502); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); return res.end(Buffer.from(r.audioContent, 'base64'));
    } catch { res.writeHead(502); return res.end(); }
  }
  if (p === '/api/ytchat') {
    const u = byToken('alertToken', q.get('token') || ''), v = q.get('video') || '';
    if (!u || !E.YOUTUBE_API_KEY || !/^[\w-]{11}$/.test(v)) return json(res, { error: 'YouTube chat is not set up.' }, 501);
    try { return json(res, await ytchat(v, q.get('page'))); } catch { return json(res, { error: 'YouTube did not answer.' }, 502); }
  }
  if (p.startsWith('/events/')) {
    const u = byToken('alertToken', p.slice(8));
    if (!u) return json(res, { error: 'Not found' }, 404);
    const hasCursor = q.has('since');
    const since = Math.max(0, Number(q.get('since') || 0));
    res.setHeader('Cache-Control', 'no-store');
    return json(res, {
      events: hasCursor ? (u.events || []).filter(event => event.id > since) : [],
      cursor: u.eventSeq || 0,
      stats: stats(u)
    });
  }

  if (p === '/api/admin/users' && adminOk(req)) return json(res, Object.values(db.users).map(u => ({ slug: u.slug, created: u.created, tips: u.tips.length, raised: +u.tips.reduce((s, t) => s + usd(t), 0).toFixed(2) })));
  if (p === '/api/admin/delete' && m === 'POST' && adminOk(req)) { delete db.users[String(b.slug)]; save(); return json(res, { ok: true }); }

  const u = authUser(req);
  if (p.startsWith('/api/') && !u) return json(res, { error: 'Please log in.' }, 401);
  if (p === '/api/backup') { const { pass, salt, rec, ...rest } = u; rest.points = Object.fromEntries(Object.entries(pts(u)).map(([k, a]) => [k, { name: a.name, p: a.p }])); return json(res, rest); }
  if (p === '/api/me') return json(res, { slug: u.slug, name: u.name, khqr: u.khqr, goal: u.goal, cfg: cfg(u), wheel: u.wheel || SLICES, raffle: (u.raffle || []).length, alertToken: u.alertToken, notifyToken: u.notifyToken, tips: u.tips.slice(-15).reverse(), stats: stats(u), redeems: u.redeems || DEFREDEEMS, players: Object.keys(pts(u)).length, tgReady: !!E.TELEGRAM_BOT_TOKEN, ytReady: !!E.YOUTUBE_API_KEY });
  if (p === '/api/settings' && m === 'POST') {
    if (b.name) u.name = String(b.name).slice(0, 30);
    if (typeof b.khqr === 'string' && b.khqr.length < 2.5e6) u.khqr = b.khqr;
    if (b.goal) u.goal = { title: String(b.goal.title || 'Stream goal').slice(0, 40), target: Math.max(1, +b.goal.target || 50) };
    if (b.cfg) {
      const c = {};
      for (const k of ['spinMin', 'timerPerUsd', 'scareMin', 'mediaMin', 'pointsPerUsd']) if (b.cfg[k] !== undefined) c[k] = Math.max(0, +b.cfg[k] || 0);
      for (const k of ['tgChat', 'ytVideo']) if (typeof b.cfg[k] === 'string') c[k] = b.cfg[k].trim().slice(0, 60);
      if (typeof b.cfg.discordHook === 'string') { const h = b.cfg.discordHook.trim().slice(0, 200); c.discordHook = !h || /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(h) ? h : u.cfg.discordHook || ''; }
      u.cfg = { ...u.cfg, ...c };
    }
    if (Array.isArray(b.redeems)) u.redeems = b.redeems.map(r => ({ title: String(r.title || '').trim().slice(0, 30), cost: Math.max(1, Math.floor(+r.cost) || 0), kind: KINDS.includes(r.kind) ? r.kind : 'alert' })).filter(r => r.title && r.cost).slice(0, 8).map((r, i) => ({ id: 'r' + (i + 1), ...r }));
    if (Array.isArray(b.wheel)) { const w = b.wheel.map(s => String(s).trim().slice(0, 24)).filter(Boolean).slice(0, 12); if (w.length >= 2) u.wheel = w; }
    save(); send(u, stats(u)); return json(res, { ok: true });
  }
  if (p === '/api/test' && m === 'POST') { send(u, { type: 'tip', test: true, name: 'Sokha', amount: 5, currency: 'USD', message: b.message || 'សូមអរគុណសម្រាប់ការផ្សាយ!' }); return json(res, { ok: true }); }
  if (p === '/api/skip' && m === 'POST') { send(u, { type: 'skip' }); return json(res, { ok: true }); }
  if (p === '/api/spin' && m === 'POST') { spin(u, 'Test spin'); return json(res, { ok: true }); }
  if (p === '/api/timer' && m === 'POST') { u.timer = +b.minutes > 0 ? Date.now() + Math.min(+b.minutes, 5000) * 60000 : 0; save(); send(u, stats(u)); return json(res, { ok: true }); }
  if (p === '/api/poll' && m === 'POST') {
    if (b.action === 'close' && u.poll) u.poll.open = false;
    else if (b.action === 'clear') u.poll = null;
    else if (b.q && Array.isArray(b.options) && b.options.filter(Boolean).length >= 2) u.poll = { id: rid(), q: String(b.q).slice(0, 80), open: true, voters: [], options: b.options.filter(Boolean).slice(0, 6).map(t => ({ t: String(t).slice(0, 30), v: 0 })) };
    else return json(res, { error: 'Add a question and at least two options.' }, 400);
    save(); send(u, stats(u)); return json(res, { ok: true });
  }
  if (p === '/api/predict' && m === 'POST') {
    const pr = u.pred, refund = () => pr.bets.forEach(x => { const a = pts(u)[x.k]; if (a) a.p += x.amt; });
    if (b.action === 'clear') u.pred = null;
    else if (b.action === 'lock' && pr && pr.state === 'open') pr.state = 'locked';
    else if (b.action === 'cancel' && pr && pr.state !== 'done') { refund(); pr.state = 'done'; pr.win = -1; }
    else if (b.action === 'resolve' && pr && pr.state !== 'done' && pr.options[+b.win] !== undefined) {
      const w = +b.win, total = pr.bets.reduce((s, x) => s + x.amt, 0), winPool = pr.bets.filter(x => x.i === w).reduce((s, x) => s + x.amt, 0);
      if (!winPool) refund(); else pr.bets.filter(x => x.i === w).forEach(x => { const a = pts(u)[x.k]; if (a) a.p += Math.floor(x.amt / winPool * total); });
      pr.state = 'done'; pr.win = w;
    }
    else if (b.q && Array.isArray(b.options) && b.options.map(s => String(s).trim()).filter(Boolean).length >= 2) u.pred = { id: rid(), q: String(b.q).slice(0, 80), state: 'open', win: null, bets: [], options: b.options.map(s => String(s).trim().slice(0, 30)).filter(Boolean).slice(0, 3) };
    else return json(res, { error: 'Add a question and 2 or 3 outcomes.' }, 400);
    save(); send(u, stats(u)); return json(res, { ok: true });
  }
  if (p === '/api/raffle' && m === 'POST') {
    u.raffle = u.raffle || [];
    if (b.action === 'clear') { u.raffle = []; save(); return json(res, { ok: true, entries: 0 }); }
    if (u.raffle.length < 2) return json(res, { error: 'A raffle needs at least 2 entries. Tippers are entered automatically.' }, 400);
    spin(u, 'Raffle winner', u.raffle.slice(-12)); return json(res, { ok: true, entries: u.raffle.length });
  }
  if (p === '/api/announce' && m === 'POST') {
    const c = cfg(u), tgOk = E.TELEGRAM_BOT_TOKEN && c.tgChat;
    if (!tgOk && !c.discordHook) return json(res, { error: 'Add a Discord webhook in settings, or set TELEGRAM_BOT_TOKEN on the server plus a Telegram chat ID.' }, 400);
    const text = String(b.text || (u.name + ' is live! Tip page: ' + (b.origin || '') + '/pay/' + u.slug));
    tg(c.tgChat, text); dc(c.discordHook, text); return json(res, { ok: true });
  }
  res.writeHead(404); res.end('Not found');
}

async function handleRequest(req, res) {
  if (!VERCEL) {
    return requestContext.run(localDb, async () => app(req, res));
  }

  let lockToken = null;
  try {
    const pathName = new URL(req.url, 'http://vercel').pathname;
    if (req.method === 'GET' && pathName.startsWith('/events/')) {
      const token = pathName.slice(8);
      const snapshot = parseStored(await REDIS.get(overlayKey(token)));
      if (!snapshot) return json(res, { error: 'Not found' }, 404);
      const eventUrl = new URL(req.url, 'http://vercel');
      const hasCursor = eventUrl.searchParams.has('since');
      const since = Math.max(0, Number(eventUrl.searchParams.get('since') || 0));
      res.setHeader('Cache-Control', 'no-store');
      return json(res, {
        events: hasCursor ? (snapshot.events || []).filter(event => event.id > since) : [],
        cursor: snapshot.cursor || 0,
        stats: snapshot.stats
      });
    }

    const needsLock = req.method === 'POST' || SINGLE;
    if (needsLock) lockToken = await acquireRedisLock();
    const state = await loadRedisDb();
    const before = remoteSnapshot(state);

    return await requestContext.run(state, async () => {
      ensureOwner();

      const originalWriteHead = res.writeHead.bind(res);
      const originalEnd = res.end.bind(res);
      let pendingHeaders = null, finishPromise = null;
      res.writeHead = (...args) => { pendingHeaders = args; return res; };
      res.end = (...args) => {
        if (finishPromise) return res;
        finishPromise = (async () => {
          let finalArgs = args;
          try {
            if (state.__dirty) await persistRedisDb(state, before);
          } catch (error) {
            console.error('BotStream storage write failed:', error);
            pendingHeaders = null;
            res.statusCode = 503;
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.removeHeader('Location');
            finalArgs = [JSON.stringify({ error: 'Persistent storage is temporarily unavailable. Please retry.' })];
          } finally {
            if (lockToken) {
              try { await releaseRedisLock(lockToken); }
              catch (error) { console.error('BotStream storage lock release failed:', error); }
            }
          }
          if (pendingHeaders) originalWriteHead(...pendingHeaders);
          originalEnd(...finalArgs);
        })();
        return res;
      };

      try { await app(req, res); }
      catch (error) {
        console.error('BotStream request failed:', error);
        if (!finishPromise) json(res, { error: 'Internal server error.' }, 500);
      }
      if (finishPromise) await finishPromise;
      else if (lockToken) await releaseRedisLock(lockToken);
    });
  } catch (error) {
    console.error('BotStream serverless handler failed:', error);
    if (lockToken) {
      try { await releaseRedisLock(lockToken); } catch {}
    }
    if (!res.headersSent) return json(res, { error: 'Service temporarily unavailable. Check the Vercel storage configuration.' }, 503);
    return res.end();
  }
}

if (require.main === module) {
  http.createServer((req, res) => handleRequest(req, res))
    .listen(PORT, () => console.log('LiveTip KH running on http://localhost:' + PORT));
}
module.exports = { handleRequest };
