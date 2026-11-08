// Heraxos — сервер: аккаунты, зашифрованные чаты (E2E), сигнализация звонков, push, TURN, админ-кабинет
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const webpush = require('web-push');
const { WebSocketServer } = require('ws');

// ---------- конфиг ----------
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const PORT = +(process.env.PORT || 8445);
const DOMAIN = process.env.DOMAIN || 'localhost';
const TURN_SECRET = process.env.TURN_SECRET || 'change-me';
const TURN_HOST = process.env.TURN_HOST || DOMAIN;
const TURN_PORT = process.env.TURN_PORT || 3478;
const TURNS_PORT = process.env.TURNS_PORT || 5349;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
let VAPID_PUBLIC = process.env.VAPID_PUBLIC, VAPID_PRIVATE = process.env.VAPID_PRIVATE;
if (!VAPID_PUBLIC) {
  const k = webpush.generateVAPIDKeys(); VAPID_PUBLIC = k.publicKey; VAPID_PRIVATE = k.privateKey;
  fs.appendFileSync(envFile, `\nVAPID_PUBLIC=${VAPID_PUBLIC}\nVAPID_PRIVATE=${VAPID_PRIVATE}\n`);
}
webpush.setVapidDetails('mailto:admin@' + DOMAIN, VAPID_PUBLIC, VAPID_PRIVATE);

// ---------- хранилище ----------
// Сообщения хранятся ТОЛЬКО в зашифрованном виде (AES-GCM, ключ знают лишь собеседники).
const DB_FILE = path.join(__dirname, 'data', 'db.json');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) : {};
db.users ||= {}; db.tokens ||= {}; db.msgs ||= {}; db.reads ||= {};
let saveTimer;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => {
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE);
}, 300); };
const pairKey = (a, b) => [a, b].sort().join('|');
const LOGIN_RE = /^[a-zA-Z0-9_.\-а-яА-ЯёЁ]{3,24}$/;
const name = (k) => (db.users[k] ? db.users[k].login : k);
const C = (u) => { u.contacts ||= []; u.requests ||= []; u.sent ||= []; return u; };
const isContact = (a, b) => !!(db.users[a] && db.users[b] && C(db.users[a]).contacts.includes(b) && C(db.users[b]).contacts.includes(a));
const del = (arr, x) => { const i = arr.indexOf(x); if (i >= 0) arr.splice(i, 1); };

// ---------- HTTP ----------
const app = express();
app.set('trust proxy', false);
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' }); next(); });
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

const attempts = new Map();
function limited(key, max = 10) {
  const now = Date.now(), a = (attempts.get(key) || []).filter((x) => now - x < 60000);
  a.push(now); attempts.set(key, a); return a.length > max;
}
const tokenOf = (req) => (req.headers.authorization || '').replace('Bearer ', '');
function auth(req, res, next) {
  const login = db.tokens[tokenOf(req)];
  if (!login || !db.users[login]) return res.status(401).json({ error: 'Не авторизован' });
  req.me = login; next();
}
const keysOf = (u) => (u.pub ? { pub: u.pub, wrapped: u.wrapped, salt: u.salt, iv: u.iv } : null);
function newToken(login) { const t = crypto.randomBytes(24).toString('hex'); db.tokens[t] = login; save(); return t; }

app.post('/api/register', async (req, res) => {
  if (limited('r' + req.ip, 5)) return res.status(429).json({ error: 'Слишком много попыток, подождите минуту' });
  const { login, password } = req.body || {};
  if (!LOGIN_RE.test(login || '')) return res.status(400).json({ error: 'Логин: 3–24 символа (буквы, цифры, _ . -)' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Пароль не короче 6 символов' });
  const key = login.toLowerCase();
  if (db.users[key]) return res.status(409).json({ error: 'Логин занят' });
  db.users[key] = { login, hash: await bcrypt.hash(password, 11), subs: [], created: Date.now() };
  res.json({ token: newToken(key), login, keys: null });
});

app.post('/api/login', async (req, res) => {
  if (limited('l' + req.ip)) return res.status(429).json({ error: 'Слишком много попыток, подождите минуту' });
  const { login, password } = req.body || {};
  const key = (login || '').toLowerCase(), u = db.users[key];
  if (!u || !(await bcrypt.compare(password || '', u.hash))) return res.status(401).json({ error: 'Неверный логин или пароль' });
  res.json({ token: newToken(key), login: u.login, keys: keysOf(u) });
});

app.post('/api/logout', auth, (req, res) => { delete db.tokens[tokenOf(req)]; save(); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ login: name(req.me), hasKeys: !!db.users[req.me].pub }));

// Ключи: публичный открыто, приватный — только зашифрованный паролем пользователя (сервер его не знает)
app.post('/api/keys', auth, (req, res) => {
  const u = db.users[req.me], { pub, wrapped, salt, iv } = req.body || {};
  if (u.pub) return res.status(409).json({ error: 'Ключи уже есть' });
  if (!pub || !wrapped || !salt || !iv) return res.status(400).json({ error: 'bad keys' });
  Object.assign(u, { pub, wrapped, salt, iv }); save(); res.json({ ok: true });
});
app.get('/api/key/:login', auth, contactOnly, (req, res) => {
  const u = db.users[req.params.login.toLowerCase()];
  if (!u) return res.status(404).json({ error: 'Нет пользователя' });
  res.json({ pub: u.pub || null });
});

// ---------- контакты: только по взаимному согласию ----------
const pub = (k) => ({ login: name(k), online: isOnline(k), lastSeen: db.users[k].lastSeen || 0 });
app.get('/api/contacts', auth, (req, res) => {
  const u = C(db.users[req.me]), ok = (k) => !!db.users[k];
  res.json({
    contacts: u.contacts.filter(ok).map(pub).sort((x, y) => x.login.localeCompare(y.login)),
    requests: u.requests.filter(ok).map(name),
    sent: u.sent.filter(ok).map(name),
  });
});
function makeMutual(a, b) {
  const A = C(db.users[a]), B = C(db.users[b]);
  if (!A.contacts.includes(b)) A.contacts.push(b); if (!B.contacts.includes(a)) B.contacts.push(a);
  del(A.requests, b); del(A.sent, b); del(B.requests, a); del(B.sent, a);
}
app.post('/api/contacts/add', auth, (req, res) => {
  if (limited('c' + req.me, 20)) return res.status(429).json({ error: 'Слишком много запросов, подождите минуту' });
  const t = String((req.body && req.body.login) || '').trim().toLowerCase(), me = req.me;
  if (!db.users[t] || t === me) return res.status(404).json({ error: 'Пользователь с таким логином не найден' });
  const M = C(db.users[me]), T = C(db.users[t]);
  if (isContact(me, t)) return res.json({ status: 'contact' });
  if (M.requests.includes(t)) { makeMutual(me, t); save(); sendTo(t, { type: 'contacts' }); return res.json({ status: 'contact' }); }
  if (!M.sent.includes(t)) M.sent.push(t);
  if (!T.requests.includes(me)) {
    T.requests.push(me);
    sendTo(t, { type: 'contacts', request: name(me) });
    pushTo(t, { title: 'Heraxos', body: name(me) + ' хочет добавить вас в контакты', from: name(me), kind: 'request' });
  }
  save(); res.json({ status: 'sent' });
});
app.post('/api/contacts/accept', auth, (req, res) => {
  const t = String(req.body.login || '').toLowerCase();
  if (!C(db.users[req.me]).requests.includes(t) || !db.users[t]) return res.status(404).json({ error: 'Заявка не найдена' });
  makeMutual(req.me, t); save(); sendTo(t, { type: 'contacts', accepted: name(req.me) }); res.json({ ok: true });
});
app.post('/api/contacts/decline', auth, (req, res) => {
  const t = String(req.body.login || '').toLowerCase(), M = C(db.users[req.me]);
  del(M.requests, t); if (db.users[t]) { del(C(db.users[t]).sent, req.me); sendTo(t, { type: 'contacts' }); }
  save(); res.json({ ok: true });
});
app.post('/api/contacts/cancel', auth, (req, res) => {
  const t = String(req.body.login || '').toLowerCase(), M = C(db.users[req.me]);
  del(M.sent, t); if (db.users[t]) { del(C(db.users[t]).requests, req.me); sendTo(t, { type: 'contacts' }); }
  save(); res.json({ ok: true });
});
app.delete('/api/contacts/:login', auth, (req, res) => {
  const t = req.params.login.toLowerCase();
  del(C(db.users[req.me]).contacts, t); if (db.users[t]) { del(C(db.users[t]).contacts, req.me); sendTo(t, { type: 'contacts' }); }
  save(); res.json({ ok: true });
});
function contactOnly(req, res, next) {
  const t = String(req.params.peer || req.params.login || '').toLowerCase();
  if (!isContact(req.me, t)) return res.status(403).json({ error: 'Сначала добавьте пользователя в контакты' });
  req.peer = t; next();
}

app.get('/api/chats', auth, (req, res) => {
  const out = [];
  for (const [pk, list] of Object.entries(db.msgs)) {
    const [a, b] = pk.split('|'); if (a !== req.me && b !== req.me) continue;
    const peer = a === req.me ? b : a; if (!isContact(req.me, peer) || !list.length) continue;
    const myRead = (db.reads[pk] || {})[req.me] || 0, peerRead = (db.reads[pk] || {})[peer] || 0;
    const last = list[list.length - 1];
    out.push({ peer: name(peer), online: isOnline(peer), last: { ...last, f: name(last.f) }, peerRead,
      unread: list.filter((m) => m.f === peer && m.ts > myRead).length });
  }
  res.json(out.sort((x, y) => y.last.ts - x.last.ts));
});

app.get('/api/messages/:peer', auth, contactOnly, (req, res) => {
  const peer = req.params.peer.toLowerCase(), pk = pairKey(req.me, peer);
  const before = +req.query.before || Infinity;
  const list = (db.msgs[pk] || []).filter((m) => m.ts < before).slice(-100);
  res.json({ msgs: list.map((m) => ({ ...m, f: name(m.f) })), peerRead: (db.reads[pk] || {})[peer] || 0 });
});

app.post('/api/read/:peer', auth, contactOnly, (req, res) => {
  const peer = req.params.peer.toLowerCase(), pk = pairKey(req.me, peer), ts = +req.body.ts || Date.now();
  db.reads[pk] ||= {}; if (ts > (db.reads[pk][req.me] || 0)) { db.reads[pk][req.me] = ts; save(); }
  sendTo(peer, { type: 'read', from: name(req.me), ts }); res.json({ ok: true });
});

app.get('/api/vapid', (req, res) => res.json({ key: VAPID_PUBLIC }));
app.post('/api/subscribe', auth, (req, res) => {
  const sub = req.body && req.body.sub; if (!sub || !sub.endpoint) return res.status(400).json({ error: 'bad sub' });
  const u = db.users[req.me]; u.subs = u.subs.filter((s) => s.endpoint !== sub.endpoint).concat(sub).slice(-5);
  save(); res.json({ ok: true });
});

app.get('/api/ice', auth, (req, res) => {
  const username = `${Math.floor(Date.now() / 1000) + 12 * 3600}:${req.me}`;
  const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  res.json([
    { urls: `stun:${TURN_HOST}:${TURN_PORT}` },
    { urls: [`turn:${TURN_HOST}:${TURN_PORT}?transport=udp`, `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`, `turns:${TURN_HOST}:${TURNS_PORT}?transport=tcp`], username, credential },
  ]);
});

// ---------- админ-кабинет: только управление аккаунтами ----------
const adminTokens = new Map();
function admin(req, res, next) {
  const t = tokenOf(req), exp = adminTokens.get(t);
  if (!exp || exp < Date.now()) return res.status(401).json({ error: 'Нужен вход администратора' });
  adminTokens.set(t, Date.now() + 30 * 60000); next();
}
app.post('/api/admin/login', (req, res) => {
  if (limited('a' + req.ip, 5)) return res.status(429).json({ error: 'Слишком много попыток, подождите минуту' });
  const p = Buffer.from((req.body && req.body.password) || ''), a = Buffer.from(ADMIN_PASSWORD);
  if (!ADMIN_PASSWORD || p.length !== a.length || !crypto.timingSafeEqual(p, a)) return res.status(401).json({ error: 'Неверный пароль' });
  const t = crypto.randomBytes(24).toString('hex'); adminTokens.set(t, Date.now() + 30 * 60000); res.json({ token: t });
});
app.get('/api/admin/users', admin, (req, res) => {
  res.json(Object.entries(db.users).map(([k, u]) => ({ login: u.login, created: u.created, lastSeen: u.lastSeen || 0, online: isOnline(k) }))
    .sort((a, b) => a.login.localeCompare(b.login)));
});
app.post('/api/admin/users', admin, async (req, res) => {
  const { login, password } = req.body || {};
  if (!LOGIN_RE.test(login || '')) return res.status(400).json({ error: 'Логин: 3–24 символа (буквы, цифры, _ . -)' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Пароль не короче 6 символов' });
  const key = login.toLowerCase(); if (db.users[key]) return res.status(409).json({ error: 'Логин занят' });
  db.users[key] = { login, hash: await bcrypt.hash(password, 11), subs: [], created: Date.now() }; save(); res.json({ ok: true });
});
function dropSessions(key) {
  for (const [t, l] of Object.entries(db.tokens)) if (l === key) delete db.tokens[t];
  for (const ws of online.get(key) || []) ws.close(4001, 'auth');
}
app.post('/api/admin/reset', admin, async (req, res) => {
  const { login, password } = req.body || {}, key = (login || '').toLowerCase(), u = db.users[key];
  if (!u) return res.status(404).json({ error: 'Нет пользователя' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Пароль не короче 6 символов' });
  u.hash = await bcrypt.hash(password, 11);
  // Старый ключ зашифрован старым паролем — его невозможно восстановить. Создаётся новый при входе.
  delete u.pub; delete u.wrapped; delete u.salt; delete u.iv;
  dropSessions(key); save(); res.json({ ok: true });
});
app.delete('/api/admin/users/:login', admin, (req, res) => {
  const key = req.params.login.toLowerCase(); if (!db.users[key]) return res.status(404).json({ error: 'Нет пользователя' });
  dropSessions(key);
  for (const k of C(db.users[key]).contacts) if (db.users[k]) { const U = C(db.users[k]); del(U.contacts, key); del(U.requests, key); del(U.sent, key); }
  for (const U of Object.values(db.users)) { C(U); del(U.contacts, key); del(U.requests, key); del(U.sent, key); }
  delete db.users[key];
  for (const pk of Object.keys(db.msgs)) if (pk.split('|').includes(key)) { delete db.msgs[pk]; delete db.reads[pk]; }
  save(); res.json({ ok: true });
});

// ---------- WebSocket ----------
const online = new Map(), pending = new Map();
// «В сети» — только открытое приложение; фоновое соединение Android-службы (bg=1) не считается
const isOnline = (k) => { const set = online.get(k); if (!set) return false; for (const w of set) if (!w.bg) return true; return false; };
function sendTo(login, msg) {
  const set = online.get(login); if (!set) return false;
  for (const ws of set) ws.readyState === 1 && ws.send(JSON.stringify(msg)); return true;
}
async function pushTo(login, payload) {
  const u = db.users[login]; if (!u || !u.subs.length) return;
  const keep = [];
  for (const s of u.subs) {
    try { await webpush.sendNotification(s, JSON.stringify(payload), { TTL: payload.call ? 45 : 3600, urgency: 'high' }); keep.push(s); }
    catch (e) { if (e.statusCode !== 404 && e.statusCode !== 410) keep.push(s); }
  }
  u.subs = keep; save();
}

// ---------- звонки: «комнаты» до 5 участников (каждый с каждым, P2P) ----------
const MAX_CALL = 5;
const rooms = new Map(); // id -> { members:Set, invited:Map(login -> {from, timer}), video, ever, reason }
const roomSend = (r, msg, except) => { for (const k of r.members) if (k !== except) sendTo(k, msg); };

// Повторяющиеся push-уведомления, пока идёт вызов (каждые ~3.5 с, до 45 с)
const ringing = new Map(); // `${id}|${to}` -> {timer, from}
function startRinging(id, from, to, video) {
  const key = id + '|' + to; let n = 0;
  const tick = () => {
    const r = rooms.get(id);
    if (!r || !r.invited.has(to)) return stopRinging(id, to, false);
    n++;
    pushTo(to, { kind: 'call', call: true, id, n, video, from: name(from),
      title: (video ? '📹 Видеозвонок' : '📞 Звонок') + ' · Heraxos', body: name(from) + ' звонит вам…' });
  };
  tick();
  ringing.set(key, { timer: setInterval(tick, 3500), from });
}
function stopRinging(id, to, missed) {
  const key = id + '|' + to, r = ringing.get(key); if (!r) return;
  clearInterval(r.timer); ringing.delete(key);
  if (missed) pushTo(to, { kind: 'missed', id, from: name(r.from), title: 'Пропущенный звонок', body: 'от ' + name(r.from) });
}

function inviteInto(id, r, from, to, video) {
  const inv = { from };
  r.invited.set(to, inv);
  pending.set(to, { id, from, video, ts: Date.now() });
  sendTo(to, { type: 'invite', id, from: name(from), video, members: [...r.members].map(name) });
  roomSend(r, { type: 'ringing', id, login: name(to) });
  startRinging(id, from, to, video);
  inv.timer = setTimeout(() => {
    if (rooms.get(id) !== r || r.invited.get(to) !== inv) return;
    r.invited.delete(to); if (pending.get(to)?.id === id) pending.delete(to);
    stopRinging(id, to, true);
    sendTo(to, { type: 'hangup', id, reason: 'missed' });
    roomSend(r, { type: 'noanswer', id, login: name(to) });
    r.reason = 'noanswer'; maybeEnd(id);
  }, 45000);
}
function dropInvite(id, r, login, missedPush) {
  const inv = r.invited.get(login); if (!inv) return;
  clearTimeout(inv.timer); r.invited.delete(login);
  if (pending.get(login)?.id === id) pending.delete(login);
  stopRinging(id, login, missedPush);
}
// Звонок заканчивается, когда в нём остался 1 человек и никого не вызывают
function maybeEnd(id) {
  const r = rooms.get(id); if (!r) return;
  if (r.members.size === 0) {
    for (const k of [...r.invited.keys()]) { dropInvite(id, r, k, true); sendTo(k, { type: 'hangup', id, reason: 'missed' }); }
    rooms.delete(id); return;
  }
  if (r.members.size === 1 && r.invited.size === 0) {
    for (const k of r.members) sendTo(k, { type: 'hangup', id, reason: r.ever ? 'ended' : (r.reason || 'noanswer') });
    rooms.delete(id);
  }
}
function leaveRoom(id, me) {
  const r = rooms.get(id); if (!r || !r.members.has(me)) return;
  r.members.delete(me);
  roomSend(r, { type: 'left', id, login: name(me) });
  maybeEnd(id);
}
const leaveTimers = new Map();

const server = process.env.CERT
  ? https.createServer({ cert: fs.readFileSync(process.env.CERT), key: fs.readFileSync(process.env.KEY) }, app)
  : http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams, me = db.tokens[q.get('token')];
  if (!me || !db.users[me]) return ws.close(4001, 'auth');
  ws.bg = q.get('bg') === '1';
  const was = isOnline(me);
  if (!online.has(me)) online.set(me, new Set());
  online.get(me).add(ws);
  if (!was && isOnline(me)) broadcastPresence(me, true);
  ws.isAlive = true; ws.on('pong', () => (ws.isAlive = true));
  if (!ws.bg) { clearTimeout(leaveTimers.get(me)); leaveTimers.delete(me); }
  const p = pending.get(me), pr = p && rooms.get(p.id);
  if (pr && pr.invited.has(me)) {
    ws.send(JSON.stringify({ type: 'invite', id: p.id, from: name(p.from), video: p.video, members: [...pr.members].map(name) }));
    if (!ws.bg) stopRinging(p.id, me, false);
  }

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (limited('w' + me, 300)) return;
    const to = String(m.to || '').toLowerCase();
    switch (m.type) {
      case 'msg': { // зашифрованное сообщение
        if (!isContact(me, to) || typeof m.ct !== 'string' || typeof m.iv !== 'string' || m.ct.length > 200000) return;
        const pk = pairKey(me, to), msg = { id: crypto.randomBytes(8).toString('hex'), f: me, ts: Date.now(), iv: m.iv, ct: m.ct };
        (db.msgs[pk] ||= []).push(msg); if (db.msgs[pk].length > 5000) db.msgs[pk].splice(0, 1000); save();
        ws.send(JSON.stringify({ type: 'sent', cid: m.cid, id: msg.id, ts: msg.ts, to: name(to) }));
        for (const w of online.get(me) || []) if (w !== ws) w.send(JSON.stringify({ type: 'msg', ...msg, f: name(me), peer: name(to) }));
        sendTo(to, { type: 'msg', ...msg, f: name(me), peer: name(me) });
        pushTo(to, { title: name(me), body: '🔒 Новое сообщение', from: name(me), kind: 'msg' });
        break;
      }
      case 'typing': if (isContact(me, to)) sendTo(to, { type: 'typing', from: name(me) }); break;
      case 'invite': {
        let id = m.id && String(m.id), r = id && rooms.get(id);
        if (id && (!r || !r.members.has(me))) return;
        if (!isContact(me, to)) return ws.send(JSON.stringify({ type: 'error', text: 'Звонить можно только контактам' }));
        if (r && (r.members.has(to) || r.invited.has(to))) return;
        if (r && r.members.size + r.invited.size >= MAX_CALL) return ws.send(JSON.stringify({ type: 'error', text: 'В звонке может быть не больше 5 человек' }));
        if (!r) {
          id = crypto.randomBytes(8).toString('hex');
          r = { members: new Set([me]), invited: new Map(), video: !!m.video, ever: false, reason: '' };
          rooms.set(id, r);
          ws.send(JSON.stringify({ type: 'calling', id, to: name(to) }));
        }
        inviteInto(id, r, me, to, !!(m.video ?? r.video));
        break;
      }
      case 'accept': {
        const id = String(m.id), r = rooms.get(id);
        if (!r || !r.invited.has(me)) return ws.send(JSON.stringify({ type: 'hangup', id, reason: 'gone' }));
        dropInvite(id, r, me, false);
        const existing = [...r.members].map(name);
        r.members.add(me); r.ever = true;
        ws.send(JSON.stringify({ type: 'room', id, members: existing }));
        roomSend(r, { type: 'joined', id, login: name(me) }, me);
        for (const w of online.get(me) || []) if (w !== ws) w.send(JSON.stringify({ type: 'hangup', id, reason: 'elsewhere' }));
        break;
      }
      case 'reject': {
        const id = String(m.id), r = rooms.get(id); if (!r || !r.invited.has(me)) return;
        dropInvite(id, r, me, false);
        for (const w of online.get(me) || []) if (w !== ws) w.send(JSON.stringify({ type: 'hangup', id, reason: 'elsewhere' }));
        roomSend(r, { type: 'declined', id, login: name(me), reason: m.reason === 'busy' ? 'busy' : 'rejected' });
        r.reason = m.reason === 'busy' ? 'busy' : 'rejected';
        maybeEnd(id);
        break;
      }
      case 'hangup': leaveRoom(String(m.id), me); break;
      case 'offer': case 'answer': case 'ice': {
        const r = rooms.get(String(m.id)); if (!r || !r.members.has(me) || !r.members.has(to)) return;
        sendTo(to, { ...m, from: name(me), to: undefined });
        break;
      }
      case 'media': case 'quality': {
        const r = rooms.get(String(m.id)); if (!r || !r.members.has(me)) return;
        roomSend(r, { ...m, from: name(me), to: undefined }, me);
        break;
      }
    }
  });
  ws.on('close', () => {
    const s = online.get(me); if (!s) return;
    const was = isOnline(me); s.delete(ws); if (!s.size) online.delete(me);
    if (was && !isOnline(me)) {
      if (db.users[me]) { db.users[me].lastSeen = Date.now(); save(); } broadcastPresence(me, false);
      leaveTimers.set(me, setTimeout(() => {
        leaveTimers.delete(me); if (isOnline(me)) return;
        for (const [id, r] of rooms) if (r.members.has(me)) leaveRoom(id, me);
      }, 20000));
    }
  });
});
function broadcastPresence(login, on) {
  const msg = JSON.stringify({ type: 'presence', login: name(login), online: on, ts: Date.now() });
  for (const k of C(db.users[login] || {}).contacts || []) for (const w of online.get(k) || []) w.readyState === 1 && w.send(msg);
}
setInterval(() => wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 25000);

server.listen(PORT, () => console.log(`Heraxos: ${process.env.CERT ? 'https' : 'http'}://${DOMAIN}:${PORT}  (админ: /admin.html)`));
