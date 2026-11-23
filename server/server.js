// Ahazang — сервер: аккаунты, зашифрованные чаты (E2E), сигнализация звонков, push, TURN, админ-кабинет
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const http2 = require('http2');
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
const PORT = +(process.env.PORT || 443);
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
// блокировка: заблокированный не может писать, звонить, отправлять файлы и заявки (в обе стороны)
const blocks = (a, b) => !!(db.users[a] && (db.users[a].blocked || []).includes(b));
// Как в телефоне: написать и позвонить можно любому номеру, если никто из двоих не заблокировал другого
const canTalk = (a, b) => !!(db.users[a] && db.users[b] && a !== b && !blocks(a, b) && !blocks(b, a));

// ---------- номера ----------
// Обычный номер — 6 цифр (случайный или выбранный самим, если свободен). «Красивые» номера
// и номера короче 6 цифр выдаёт только администратор.
const numIndex = new Map(); // номер -> ключ пользователя
const fmtNum = (n) => (/^\d{6}$/.test(n) ? n.slice(0, 3) + ' ' + n.slice(3) : n || '');
function isPretty(n) {
  if (!/^\d{6}$/.test(n)) return true;
  const d = [...n].map(Number), steps = d.slice(1).map((x, i) => x - d[i]);
  return /^(\d)\1{5}$/.test(n) || /^(\d\d)\1\1$/.test(n) || /^(\d{3})\1$/.test(n) || /^(\d)\1\1(\d)\2\2$/.test(n) ||
    /^(\d)\1{3}/.test(n) || /(\d)\1{3}$/.test(n) || /0000$/.test(n) || steps.every((x) => x === 1) || steps.every((x) => x === -1) ||
    n === n.split('').reverse().join('');
}
function randomNum() {
  for (;;) { const n = String(crypto.randomInt(100000, 1000000)); if (!numIndex.has(n) && !isPretty(n)) return n; }
}
function setNum(key, n) { const u = db.users[key]; if (u.num) numIndex.delete(u.num); u.num = n; numIndex.set(n, key); }
const keyByNum = (n) => numIndex.get(String(n || '').replace(/\D/g, ''));
// имя, под которым viewer сохранил пользователя key (или его номер)
const dispFor = (viewer, key) => ((db.users[viewer] && db.users[viewer].book && db.users[viewer].book[key]) || fmtNum(db.users[key] && db.users[key].num) || name(key));
// Перенос со старой схемы: всем выдаём номера, взаимные контакты → телефонная книга (имя = прежний логин)
(function migrateNumbers() {
  let changed = false;
  for (const [k, u] of Object.entries(db.users)) if (u.num) numIndex.set(u.num, k);
  for (const [k, u] of Object.entries(db.users)) {
    if (!u.num) { setNum(k, randomNum()); changed = true; }
    if (!u.book) { u.book = {}; for (const c of u.contacts || []) if (db.users[c]) u.book[c] = db.users[c].login; changed = true; }
  }
  if (changed) setTimeout(save, 0);
})();
const del = (arr, x) => { const i = arr.indexOf(x); if (i >= 0) arr.splice(i, 1); };

// ---------- HTTP ----------
const app = express();
app.set('trust proxy', false);
app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN' }); next(); });
// Версия веб-приложения: устаревшие клиенты получают команду перезагрузиться
const APP_VERSION = '10';
// ---------- доступ: интерфейс и API только для приложений Ahazang ----------
// Приложения (Android/iPhone) добавляют к User-Agent метку «AhazangApp/». Браузер вместо интерфейса получает
// страницу «Скачайте приложение». Админка открыта в браузере (по паролю; можно ограничить IP через ADMIN_IPS).
// ALLOW_WEB=1 в .env временно открывает интерфейс и для браузера.
const isApp = (req) => process.env.ALLOW_WEB === '1' || /AhazangApp\//.test(req.headers['user-agent'] || '');
const ADMIN_IPS = (process.env.ADMIN_IPS || '').split(/[\s,]+/).filter(Boolean);
const ipOf = (req) => String(req.ip || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
const adminIpOk = (req) => !ADMIN_IPS.length || ADMIN_IPS.includes(ipOf(req));
const PUBLIC_FILES = /^\/(get\.html|privacy\.html|terms\.html|logo\.png|favicon\.png|icon-\d+\.png)$/;
app.use((req, res, next) => {
  if (req.path === '/admin.html' || req.path.startsWith('/api/admin/')) return adminIpOk(req) ? next() : res.status(404).end();
  if (isApp(req) || PUBLIC_FILES.test(req.path)) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Ahazang работает только в приложении' });
  res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'public', 'get.html'));
});
// HTML/JS/CSS не кэшируются вовсе (Safari на iPhone иначе может держать старый app.js), картинки — с проверкой
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true, setHeaders: (res, file) =>
  res.set('Cache-Control', /\.(html|js|css|json)$/.test(file) ? 'no-store, must-revalidate' : 'no-cache') }));

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
  const { login, password } = req.body || {}, want = String((req.body && req.body.num) || '').replace(/\D/g, '');
  if (!LOGIN_RE.test(login || '')) return res.status(400).json({ error: 'Логин: 3–24 символа (буквы, цифры, _ . -)' });
  if (!password || password.length < 6) return res.status(400).json({ error: 'Пароль не короче 6 символов' });
  const key = login.toLowerCase();
  if (db.users[key]) return res.status(409).json({ error: 'Логин занят' });
  if (want && !/^\d{6}$/.test(want)) return res.status(400).json({ error: 'Номер — ровно 6 цифр (или оставьте поле пустым)' });
  if (want && numIndex.has(want)) return res.status(409).json({ error: 'Этот номер уже занят, выберите другой' });
  if (want && isPretty(want)) return res.status(409).json({ error: 'Этот номер зарезервирован, выберите другой' });
  db.users[key] = { login, hash: await bcrypt.hash(password, 11), subs: [], created: Date.now(), book: {} };
  setNum(key, want || randomNum());
  res.json({ token: newToken(key), login, num: db.users[key].num, keys: null });
});

app.post('/api/login', async (req, res) => {
  if (limited('l' + req.ip)) return res.status(429).json({ error: 'Слишком много попыток, подождите минуту' });
  const { login, password } = req.body || {};
  // войти можно по логину или по номеру
  let key = String(login || '').trim().toLowerCase();
  if (!db.users[key] && /^[\d\s+-]+$/.test(key)) key = keyByNum(key) || key;
  const u = db.users[key];
  if (!u || !(await bcrypt.compare(password || '', u.hash))) return res.status(401).json({ error: 'Неверный логин, номер или пароль' });
  res.json({ token: newToken(key), login: u.login, num: u.num, keys: keysOf(u) });
});

app.post('/api/logout', auth, (req, res) => { delete db.tokens[tokenOf(req)]; save(); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ login: name(req.me), num: db.users[req.me].num, hasKeys: !!db.users[req.me].pub, voip: !!apnsKey }));

// ---------- iPhone: звонки как в WhatsApp (PushKit/CallKit через Apple Push Notification service) ----------
// В .env: APNS_KEY_FILE=/opt/ahazang/apns.p8, APNS_KEY_ID=…, APNS_TEAM_ID=…, (APNS_TOPIC=am.ahazang.app)
const APNS = { file: process.env.APNS_KEY_FILE, kid: process.env.APNS_KEY_ID, team: process.env.APNS_TEAM_ID,
  topic: process.env.APNS_TOPIC || 'am.ahazang.app', host: process.env.APNS_HOST || 'api.push.apple.com' };
let apnsKey = null;
try { if (APNS.file && APNS.kid && APNS.team) { apnsKey = crypto.createPrivateKey(fs.readFileSync(APNS.file)); console.log('[apns] включено, ключ', APNS.kid); } }
catch (e) { console.log('[apns] ключ не загружен:', e.message); }
let apnsJwt = '', apnsJwtAt = 0, apnsSession = null;
function apnsAuth() {
  if (apnsJwt && Date.now() - apnsJwtAt < 40 * 60e3) return apnsJwt;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = b64({ alg: 'ES256', kid: APNS.kid }) + '.' + b64({ iss: APNS.team, iat: Math.floor(Date.now() / 1000) });
  apnsJwt = data + '.' + crypto.sign('sha256', Buffer.from(data), { key: apnsKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  apnsJwtAt = Date.now(); return apnsJwt;
}
function apnsClient() {
  if (apnsSession && !apnsSession.closed && !apnsSession.destroyed) return apnsSession;
  apnsSession = http2.connect('https://' + APNS.host);
  apnsSession.on('error', (e) => { console.log('[apns] соединение:', e.message); apnsSession = null; });
  apnsSession.on('goaway', () => { apnsSession = null; });
  apnsSession.on('close', () => { apnsSession = null; });
  return apnsSession;
}
// VoIP-сигнал на все iPhone пользователя: iOS будит приложение и показывает системный входящий (CallKit)
function sendVoip(login, payload) {
  const u = db.users[login]; if (!apnsKey || !u || !u.voip || !u.voip.length) return;
  for (const t of u.voip.slice()) {
    let req;
    try {
      req = apnsClient().request({ ':method': 'POST', ':path': '/3/device/' + t, authorization: 'bearer ' + apnsAuth(),
        'apns-topic': APNS.topic + '.voip', 'apns-push-type': 'voip', 'apns-priority': '10', 'apns-expiration': '0', 'content-type': 'application/json' });
    } catch (e) { console.log('[apns]', e.message); apnsSession = null; continue; }
    let status = 0, body = '';
    req.on('response', (h) => { status = h[':status']; });
    req.setEncoding('utf8'); req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (status === 200) return;
      console.log('[apns]', login, status, body);
      if (status === 410 || /BadDeviceToken|Unregistered|DeviceTokenNotForTopic/.test(body)) { u.voip = (u.voip || []).filter((x) => x !== t); save(); }
    });
    req.on('error', (e) => console.log('[apns] запрос:', e.message));
    req.end(JSON.stringify(payload));
  }
}
// Приложение для iPhone регистрирует свой VoIP-токен (один iPhone — один пользователь)
app.post('/api/voip', auth, (req, res) => {
  const t = String((req.body && req.body.token) || '').toLowerCase();
  if (!/^[0-9a-f]{32,200}$/.test(t)) return res.status(400).json({ error: 'bad token' });
  for (const [k, U] of Object.entries(db.users)) if (k !== req.me && U.voip) U.voip = U.voip.filter((x) => x !== t);
  const u = db.users[req.me]; u.voip = [t, ...(u.voip || []).filter((x) => x !== t)].slice(0, 5); save();
  res.json({ ok: true, voip: !!apnsKey });
});
app.post('/api/voip/remove', auth, (req, res) => {
  const t = String((req.body && req.body.token) || '').toLowerCase(), u = db.users[req.me];
  if (u.voip) u.voip = u.voip.filter((x) => x !== t); save(); res.json({ ok: true });
});
// Состояние вызова для системного экрана звонка iPhone (пока звонит — проверяет, не сбросили ли) и отклонение без открытия приложения
app.get('/api/call/:id', auth, (req, res) => {
  const r = rooms.get(String(req.params.id));
  res.json({ ringing: !!(r && r.invited.has(req.me)), active: !!(r && r.members.has(req.me)) });
});
app.post('/api/call/:id/reject', auth, (req, res) => { rejectInvite(req.me, String(req.params.id), 'rejected', null); res.json({ ok: true }); });
// Сменить свой номер на свободный 6-значный
app.post('/api/number', auth, (req, res) => {
  if (limited('n' + req.me, 5)) return res.status(429).json({ error: 'Слишком много попыток, подождите минуту' });
  const n = String((req.body && req.body.num) || '').replace(/\D/g, '');
  if (!/^\d{6}$/.test(n)) return res.status(400).json({ error: 'Номер — ровно 6 цифр' });
  if (numIndex.has(n) && numIndex.get(n) !== req.me) return res.status(409).json({ error: 'Этот номер уже занят' });
  if (isPretty(n)) return res.status(409).json({ error: 'Этот номер зарезервирован, выберите другой' });
  setNum(req.me, n); save(); res.json({ num: n });
});

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

// ---------- контакты: телефонная книга (без подтверждения второй стороны) ----------
const book = (k) => (db.users[k].book ||= {});
const peerInfo = (me, k) => ({ login: name(k), num: db.users[k].num, name: book(me)[k] || '', online: isOnline(k), lastSeen: db.users[k].lastSeen || 0 });
app.get('/api/contacts', auth, (req, res) => {
  const u = db.users[req.me];
  res.json({
    contacts: Object.keys(book(req.me)).filter((k) => db.users[k]).map((k) => peerInfo(req.me, k))
      .sort((x, y) => (x.name || x.num).localeCompare(y.name || y.num)),
    requests: [], sent: [],
    blocked: (u.blocked || []).filter((k) => db.users[k]).map((k) => peerInfo(req.me, k)),
  });
});
// найти человека по номеру (без подробностей — только логин для связи и номер)
app.get('/api/lookup/:num', auth, (req, res) => {
  if (limited('lk' + req.me, 30)) return res.status(429).json({ error: 'Слишком много запросов, подождите минуту' });
  const k = keyByNum(req.params.num);
  if (!k || k === req.me) return res.status(404).json({ error: 'Абонент с таким номером не найден' });
  res.json(peerInfo(req.me, k));
});
app.get('/api/peer/:login', auth, (req, res) => {
  const k = String(req.params.login || '').toLowerCase();
  if (!db.users[k]) return res.status(404).json({ error: 'Нет пользователя' });
  res.json({ ...peerInfo(req.me, k), blocked: blocks(req.me, k) });
});
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
app.post('/api/contacts/add', auth, (req, res) => {
  if (limited('c' + req.me, 30)) return res.status(429).json({ error: 'Слишком много запросов, подождите минуту' });
  const b = req.body || {}, k = b.num ? keyByNum(b.num) : String(b.login || '').toLowerCase();
  if (!k || !db.users[k] || k === req.me) return res.status(404).json({ error: 'Абонент с таким номером не найден' });
  book(req.me)[k] = cleanName(b.name); save();
  res.json(peerInfo(req.me, k));
});
app.post('/api/contacts/rename', auth, (req, res) => {
  const k = String((req.body && req.body.login) || '').toLowerCase();
  if (!db.users[k]) return res.status(404).json({ error: 'Нет пользователя' });
  book(req.me)[k] = cleanName(req.body.name); save(); res.json(peerInfo(req.me, k));
});
app.delete('/api/contacts/:login', auth, (req, res) => {
  delete book(req.me)[req.params.login.toLowerCase()]; save(); res.json({ ok: true });
});
function contactOnly(req, res, next) {
  const t = String(req.params.peer || req.params.login || '').toLowerCase();
  if (!db.users[t] || t === req.me) return res.status(404).json({ error: 'Нет пользователя' });
  req.peer = t; next();
}

app.get('/api/chats', auth, (req, res) => {
  const out = [];
  for (const [pk, list] of Object.entries(db.msgs)) {
    const [a, b] = pk.split('|'); if (a !== req.me && b !== req.me) continue;
    const peer = a === req.me ? b : a; if (!db.users[peer] || !list.length) continue;
    const myRead = (db.reads[pk] || {})[req.me] || 0, peerRead = (db.reads[pk] || {})[peer] || 0;
    const last = list[list.length - 1];
    out.push({ peer: name(peer), num: db.users[peer].num, name: book(req.me)[peer] || '', blocked: blocks(req.me, peer), online: isOnline(peer), last: { ...last, f: name(last.f) }, peerRead,
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

// Удалить сообщения (у обоих): стираются на сервере вместе с файлами, собеседнику — команда убрать их с экрана.
// { ids: [...] } — выбранные, { all: true } — вся переписка
app.post('/api/messages/:peer/delete', auth, (req, res) => {
  const peer = String(req.params.peer || '').toLowerCase();
  if (!db.users[peer] || peer === req.me) return res.status(404).json({ error: 'Нет такого чата' });
  const pk = pairKey(req.me, peer), list = db.msgs[pk] || [];
  const all = !!(req.body && req.body.all);
  const ids = new Set((Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(String).slice(0, 500));
  const keep = all ? [] : list.filter((m) => !ids.has(m.id));
  const removed = all ? list.map((m) => m.id) : list.filter((m) => ids.has(m.id)).map((m) => m.id);
  if (all) delete db.msgs[pk]; else db.msgs[pk] = keep;
  // файлы этих сообщений (клиент знает их номера — содержимое сообщений сервер не видит)
  for (const id of (Array.isArray(req.body && req.body.files) ? req.body.files : []).map(String).slice(0, 500)) {
    const f = fileMeta(id);
    if (f && ((f.o === req.me && f.t === peer) || (f.o === peer && f.t === req.me))) dropFile(id);
  }
  if (all) for (const [id, f] of Object.entries(db.files)) if ((f.o === req.me && f.t === peer) || (f.o === peer && f.t === req.me)) dropFile(id);
  save();
  const ev = { type: 'del', ids: removed, all };
  for (const w of online.get(req.me) || []) w.readyState === 1 && w.send(JSON.stringify({ ...ev, peer: name(peer) }));
  sendTo(peer, { ...ev, peer: name(req.me) });
  console.log('[del]', req.me, '↔', peer, all ? 'вся переписка' : removed.length + ' сообщ.');
  res.json({ ok: true, removed: removed.length });
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

// Диагностика с телефонов (загрузки страницы, ошибки JS): пишется в журнал сервера
app.post('/api/diag', (req, res) => {
  if (limited('d' + req.ip, 60)) return res.status(429).end();
  const b = req.body || {};
  console.log('[diag]', req.ip, String(b.ev || '').slice(0, 20), '#' + (+b.n || 0), String(b.nav || '').slice(0, 12),
    String(b.url || '').slice(0, 80), '|', String(b.info || '').slice(0, 600).replace(/\s+/g, ' '), '|', String(b.ua || '').slice(0, 200));
  res.status(204).end();
});
// ---------- блокировка и жалобы ----------
app.post('/api/block', auth, (req, res) => {
  const t = String((req.body && req.body.login) || '').toLowerCase(), u = db.users[req.me];
  if (!db.users[t] || t === req.me) return res.status(404).json({ error: 'Нет пользователя' });
  u.blocked ||= []; if (!u.blocked.includes(t)) u.blocked.push(t);
  const U = C(u); del(U.requests, t); // входящая заявка от заблокированного больше не висит
  // идущий звонок с ним завершается
  for (const [id, r] of rooms) if (r.members.has(req.me) && (r.members.has(t) || r.invited.has(t))) leaveRoom(id, req.me);
  save(); res.json({ ok: true });
});
app.post('/api/unblock', auth, (req, res) => {
  const t = String((req.body && req.body.login) || '').toLowerCase(), u = db.users[req.me];
  if (u.blocked) del(u.blocked, t); save(); res.json({ ok: true });
});
// Жалоба: сервер не может читать переписку, поэтому текст последних сообщений (по желанию) присылает сам жалующийся
db.reports ||= [];
app.post('/api/report', auth, (req, res) => {
  if (limited('rep' + req.me, 10)) return res.status(429).json({ error: 'Слишком много жалоб, подождите минуту' });
  const b = req.body || {}, t = String(b.login || '').toLowerCase();
  if (!db.users[t] || t === req.me) return res.status(404).json({ error: 'Нет пользователя' });
  const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-10).map((m) => ({
    f: String(m.f || '').slice(0, 40), ts: +m.ts || 0, text: String(m.text || '').slice(0, 1000) }));
  const rep = { id: crypto.randomBytes(6).toString('hex'), from: name(req.me), about: name(t), reason: String(b.reason || '').slice(0, 200),
    note: String(b.note || '').slice(0, 1000), messages: msgs, ts: Date.now(), status: 'new' };
  db.reports.push(rep); if (db.reports.length > 2000) db.reports.splice(0, db.reports.length - 2000);
  console.log('[report]', rep.from, '→', rep.about, rep.reason);
  save(); res.json({ ok: true });
});
// Удаление своего аккаунта (обязательно для App Store): подтверждение паролем
app.post('/api/account/delete', auth, async (req, res) => {
  if (limited('del' + req.me, 5)) return res.status(429).json({ error: 'Слишком много попыток, подождите минуту' });
  const u = db.users[req.me];
  if (!(await bcrypt.compare(String((req.body && req.body.password) || ''), u.hash))) return res.status(403).json({ error: 'Неверный пароль' });
  deleteUser(req.me); res.json({ ok: true });
});

// ---------- файлы: на сервере только зашифрованные данные ----------
// Телефон шифрует файл случайным ключом (AES-256-GCM) и загружает шифротекст; ключ уходит собеседнику
// внутри зашифрованного сообщения. Сервер не может открыть файл.
const FILES_DIR = path.join(__dirname, 'data', 'files');
fs.mkdirSync(FILES_DIR, { recursive: true });
db.files ||= {};
const MAX_FILE = (+process.env.MAX_FILE_MB || 100) * 1024 * 1024 + 64 * 1024; // + служебные байты шифрования
const FILE_DAYS = +process.env.FILE_DAYS || 365;
const fileMeta = (id) => (/^[a-f0-9]{32}$/.test(id) ? db.files[id] : null);
function dropFile(id) { delete db.files[id]; fs.rm(path.join(FILES_DIR, id), { force: true }, () => {}); }
app.post('/api/files', auth, (req, res) => {
  const to = String(req.query.to || '').toLowerCase(), len = +req.headers['content-length'];
  if (!canTalk(req.me, to)) return res.status(403).json({ error: 'Файл не отправлен: пользователь недоступен' });
  if (!len) return res.status(411).json({ error: 'Пустой файл' });
  if (len > MAX_FILE) return res.status(413).json({ error: `Файл больше ${process.env.MAX_FILE_MB || 100} МБ` });
  if (limited('f' + req.me, 60)) return res.status(429).json({ error: 'Слишком много файлов, подождите минуту' });
  const id = crypto.randomBytes(16).toString('hex'), tmp = path.join(FILES_DIR, id + '.part');
  const out = fs.createWriteStream(tmp, { mode: 0o600 });
  let got = 0, failed = false;
  const fail = (code, msg) => { if (failed) return; failed = true; out.destroy(); fs.rm(tmp, { force: true }, () => {}); if (!res.headersSent) res.status(code).json({ error: msg }); };
  req.on('data', (c) => { got += c.length; if (got > MAX_FILE) { fail(413, 'Файл слишком большой'); req.destroy(); } });
  req.on('aborted', () => fail(400, 'Загрузка прервана'));
  out.on('error', () => fail(500, 'Не удалось сохранить файл'));
  req.pipe(out);
  out.on('finish', () => {
    if (failed) return;
    if (got !== len) return fail(400, 'Загрузка прервана');
    fs.rename(tmp, path.join(FILES_DIR, id), (e) => {
      if (e) return fail(500, 'Не удалось сохранить файл');
      db.files[id] = { o: req.me, t: to, s: got, ts: Date.now() }; save();
      res.json({ id });
    });
  });
});
app.get('/api/files/:id', auth, (req, res) => {
  const f = fileMeta(req.params.id);
  if (!f || (f.o !== req.me && f.t !== req.me)) return res.status(404).json({ error: 'Файл не найден или срок хранения истёк' });
  res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.sendFile(path.join(FILES_DIR, req.params.id), (e) => e && !res.headersSent && res.status(404).end());
});
// Файлы старше FILE_DAYS дней и недогруженные куски удаляются
setInterval(() => {
  const old = Date.now() - FILE_DAYS * 864e5; let n = 0;
  for (const [id, f] of Object.entries(db.files)) if (f.ts < old || !db.users[f.o] || !db.users[f.t]) { dropFile(id); n++; }
  for (const name of fs.readdirSync(FILES_DIR)) if (name.endsWith('.part')) {
    try { if (Date.now() - fs.statSync(path.join(FILES_DIR, name)).mtimeMs > 3600e3) fs.rmSync(path.join(FILES_DIR, name)); } catch {}
  }
  if (n) save();
}, 3600e3);

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
app.get('/api/admin/stats', admin, (req, res) => {
  const files = Object.values(db.files); res.json({ users: Object.keys(db.users).length, files: files.length, bytes: files.reduce((a, f) => a + f.s, 0) });
});
app.get('/api/admin/users', admin, (req, res) => {
  res.json(Object.entries(db.users).map(([k, u]) => ({ login: u.login, num: u.num, created: u.created, lastSeen: u.lastSeen || 0, online: isOnline(k) }))
    .sort((a, b) => a.login.localeCompare(b.login)));
});
app.post('/api/admin/users', admin, async (req, res) => {
  // администратор может задать любой номер (в т.ч. «красивый» и короче 6 цифр) и пароль любой длины
  const { login, password } = req.body || {}, n = String((req.body && req.body.num) || '').replace(/\D/g, '');
  if (!LOGIN_RE.test(login || '')) return res.status(400).json({ error: 'Логин: 3–24 символа (буквы, цифры, _ . -)' });
  if (!password) return res.status(400).json({ error: 'Укажите пароль' });
  const key = login.toLowerCase(); if (db.users[key]) return res.status(409).json({ error: 'Логин занят' });
  if (n && n.length > 12) return res.status(400).json({ error: 'Номер — от 1 до 12 цифр' });
  if (n && numIndex.has(n)) return res.status(409).json({ error: 'Номер занят пользователем ' + name(numIndex.get(n)) });
  db.users[key] = { login, hash: await bcrypt.hash(password, 11), subs: [], created: Date.now(), book: {} };
  setNum(key, n || randomNum()); save(); res.json({ ok: true, num: db.users[key].num });
});
app.post('/api/admin/number', admin, (req, res) => {
  const key = String((req.body && req.body.login) || '').toLowerCase(), n = String((req.body && req.body.num) || '').replace(/\D/g, '');
  if (!db.users[key]) return res.status(404).json({ error: 'Нет пользователя' });
  if (!n || n.length > 12) return res.status(400).json({ error: 'Номер — от 1 до 12 цифр' });
  if (numIndex.has(n) && numIndex.get(n) !== key) return res.status(409).json({ error: 'Номер занят пользователем ' + name(numIndex.get(n)) });
  setNum(key, n); save(); res.json({ ok: true, num: n });
});
function dropSessions(key) {
  for (const [t, l] of Object.entries(db.tokens)) if (l === key) delete db.tokens[t];
  for (const ws of online.get(key) || []) ws.close(4001, 'auth');
}
app.post('/api/admin/reset', admin, async (req, res) => {
  const { login, password } = req.body || {}, key = (login || '').toLowerCase(), u = db.users[key];
  if (!u) return res.status(404).json({ error: 'Нет пользователя' });
  if (!password) return res.status(400).json({ error: 'Укажите пароль' });
  u.hash = await bcrypt.hash(password, 11);
  // Старый ключ зашифрован старым паролем — его невозможно восстановить. Создаётся новый при входе.
  delete u.pub; delete u.wrapped; delete u.salt; delete u.iv;
  dropSessions(key); save(); res.json({ ok: true });
});
app.delete('/api/admin/users/:login', admin, (req, res) => {
  const key = req.params.login.toLowerCase(); if (!db.users[key]) return res.status(404).json({ error: 'Нет пользователя' });
  deleteUser(key); res.json({ ok: true });
});
// Полное удаление пользователя: аккаунт, сессии, связи, переписка, файлы, участие в звонках
function deleteUser(key) {
  for (const [id, r] of rooms) if (r.members.has(key)) leaveRoom(id, key);
  dropSessions(key);
  for (const U of Object.values(db.users)) { C(U); del(U.contacts, key); del(U.requests, key); del(U.sent, key); if (U.blocked) del(U.blocked, key); if (U.book) delete U.book[key]; }
  if (db.users[key] && db.users[key].num) numIndex.delete(db.users[key].num);
  for (const k of Object.keys(db.users)) if (k !== key) sendTo(k, { type: 'contacts' });
  delete db.users[key];
  for (const [id, f] of Object.entries(db.files)) if (f.o === key || f.t === key) dropFile(id);
  for (const pk of Object.keys(db.msgs)) if (pk.split('|').includes(key)) { delete db.msgs[pk]; delete db.reads[pk]; }
  save();
}
app.get('/api/admin/reports', admin, (req, res) => res.json(db.reports.slice().reverse()));
app.post('/api/admin/reports/:id/close', admin, (req, res) => {
  const r = db.reports.find((x) => x.id === req.params.id); if (!r) return res.status(404).json({ error: 'Нет жалобы' });
  r.status = 'closed'; save(); res.json({ ok: true });
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
      title: (video ? '📹 Видеозвонок' : '📞 Звонок') + ' · Ahazang', body: dispFor(to, from) + ' звонит вам…' });
  };
  tick();
  ringing.set(key, { timer: setInterval(tick, 3500), from });
}
function stopRinging(id, to, missed) {
  const key = id + '|' + to, r = ringing.get(key); if (!r) return;
  clearInterval(r.timer); ringing.delete(key);
  if (missed) pushTo(to, { kind: 'missed', id, from: name(r.from), title: 'Пропущенный звонок', body: 'от ' + name(r.from) });
}

function rejectInvite(me, id, reason, exceptWs) {
  const r = rooms.get(id); if (!r || !r.invited.has(me)) return;
  dropInvite(id, r, me, false);
  for (const w of online.get(me) || []) if (w !== exceptWs && w.readyState === 1) w.send(JSON.stringify({ type: 'hangup', id, reason: 'elsewhere' }));
  roomSend(r, { type: 'declined', id, login: name(me), reason });
  r.reason = reason;
  maybeEnd(id);
}
function inviteInto(id, r, from, to, video) {
  const inv = { from };
  r.invited.set(to, inv);
  pending.set(to, { id, from, video, ts: Date.now() });
  sendTo(to, { type: 'invite', id, from: name(from), fromName: dispFor(to, from), fromNum: db.users[from].num, video, members: [...r.members].map(name) });
  sendVoip(to, { type: 'call', id, from: name(from), name: dispFor(to, from), num: db.users[from].num, video: !!video });
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
// не больше ~40 игровых сообщений в секунду от одного человека
const gameRate = new Map();
function gameFlood(me) {
  const now = Date.now(), r = gameRate.get(me) || { t: now, n: 0 };
  if (now - r.t > 1000) { r.t = now; r.n = 0; }
  r.n++; gameRate.set(me, r);
  return r.n > 40;
}
const leaveTimers = new Map();
const reloadSent = new Map(); // token -> когда последний раз просили перезагрузиться

const server = process.env.CERT
  ? https.createServer({ cert: fs.readFileSync(process.env.CERT), key: fs.readFileSync(process.env.KEY) }, app)
  : http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });

wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams, me = db.tokens[q.get('token')];
  if (!me || !db.users[me]) return ws.close(4001, 'auth');
  if (!isApp(req)) return ws.close(4003, 'app only');
  ws.bg = q.get('bg') === '1';
  console.log('[ws]', me, ws.bg ? 'фон (Android-служба)' : 'страница v' + q.get('v'), String(req.headers['user-agent'] || '').slice(0, 120));
  // Устаревший клиент перезагружаем, но не чаще раза в 2 минуты — чтобы не было бесконечной перезагрузки,
  // если браузер всё-таки отдал старый файл из кэша
  if (!ws.bg && q.get('v') !== APP_VERSION) {
    const key = q.get('token'), last = reloadSent.get(key) || 0;
    console.log('[reload]', me, 'версия клиента', q.get('v'), Date.now() - last > 120000 ? '→ перезагрузка' : '→ пропуск (недавно уже просили)');
    if (Date.now() - last > 120000) { reloadSent.set(key, Date.now()); ws.send(JSON.stringify({ type: 'reload', v: APP_VERSION })); }
  }
  const was = isOnline(me);
  if (!online.has(me)) online.set(me, new Set());
  online.get(me).add(ws);
  if (!was && isOnline(me)) broadcastPresence(me, true);
  ws.isAlive = true; ws.on('pong', () => (ws.isAlive = true));
  // любое соединение (в том числе фоновое соединение Android-службы) отменяет выход из звонка
  clearTimeout(leaveTimers.get(me)); leaveTimers.delete(me);
  const p = pending.get(me), pr = p && rooms.get(p.id);
  if (pr && pr.invited.has(me)) {
    ws.send(JSON.stringify({ type: 'invite', id: p.id, from: name(p.from), fromName: dispFor(me, p.from), fromNum: db.users[p.from] && db.users[p.from].num, video: p.video, members: [...pr.members].map(name) }));
    if (!ws.bg) stopRinging(p.id, me, false);
  }

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    // Игры (шахматы, шашки, танки): пересылаем сопернику. Танки шлют до ~20 сообщений в секунду —
    // у игр свой лимит, чтобы не мешать сообщениям и звонкам
    if (m.type === 'game') {
      const to = String(m.to || '').toLowerCase();
      if (gameFlood(me) || raw.length > 12000 || !to || !canTalk(me, to)) return;
      if (!isOnline(to)) return ws.send(JSON.stringify({ type: 'game', k: 'offline', g: m.g, from: name(to) }));
      sendTo(to, { ...m, to: undefined, from: name(me), fromName: dispFor(to, me), fromNum: db.users[me].num });
      return;
    }
    if (limited('w' + me, 300)) return;
    const to = String(m.to || '').toLowerCase();
    if (['invite', 'accept', 'reject', 'hangup', 'offer', 'answer', 'reneg'].includes(m.type))
      console.log('[call]', m.type, me + (ws.bg ? '(фон)' : ''), to ? '→ ' + to : '', m.id ? 'id=' + m.id : '');
    switch (m.type) {
      case 'msg': { // зашифрованное сообщение
        if (!canTalk(me, to) || typeof m.ct !== 'string' || typeof m.iv !== 'string' || m.ct.length > 200000) return ws.send(JSON.stringify({ type: 'error', text: canTalk(me, to) ? 'Сообщение не отправлено' : 'Сообщение не доставлено: пользователь недоступен' }));
        const pk = pairKey(me, to), msg = { id: crypto.randomBytes(8).toString('hex'), f: me, ts: Date.now(), iv: m.iv, ct: m.ct };
        (db.msgs[pk] ||= []).push(msg); if (db.msgs[pk].length > 5000) db.msgs[pk].splice(0, 1000); save();
        ws.send(JSON.stringify({ type: 'sent', cid: m.cid, id: msg.id, ts: msg.ts, to: name(to) }));
        for (const w of online.get(me) || []) if (w !== ws) w.send(JSON.stringify({ type: 'msg', ...msg, f: name(me), peer: name(to) }));
        sendTo(to, { type: 'msg', ...msg, f: name(me), peer: name(me), fn: dispFor(to, me), fnum: db.users[me].num });
        pushTo(to, { title: dispFor(to, me), body: '🔒 Новое сообщение', from: name(me), kind: 'msg' });
        break;
      }
      case 'typing': if (canTalk(me, to)) sendTo(to, { type: 'typing', from: name(me) }); break;
      case 'invite': {
        let id = m.id && String(m.id), r = id && rooms.get(id);
        if (id && (!r || !r.members.has(me))) return;
        if (!canTalk(me, to)) return ws.send(JSON.stringify({ type: 'error', text: 'Абонент недоступен' }));
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
      case 'reject': rejectInvite(me, String(m.id), m.reason === 'busy' ? 'busy' : 'rejected', ws); break;
      case 'hangup': leaveRoom(String(m.id), me); break;
      case 'offer': case 'answer': case 'ice': case 'reneg': {
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
    }
    // Свернутое приложение (Яндекс Карты и т.п.) часто теряет соединение страницы, но сам звонок идёт напрямую
    // между телефонами. Поэтому из звонка выводим, только если у человека не осталось НИ ОДНОГО соединения
    // (включая фоновое) дольше 60 секунд. Завершённый с телефона звонок закрывается сообщением hangup сразу.
    if (!online.has(me) && [...rooms.values()].some((r) => r.members.has(me))) {
      clearTimeout(leaveTimers.get(me));
      leaveTimers.set(me, setTimeout(() => {
        leaveTimers.delete(me); if (online.has(me)) return;
        for (const [id, r] of rooms) if (r.members.has(me)) leaveRoom(id, me);
      }, 60000));
    }
  });
});
function broadcastPresence(login, on) {
  const msg = JSON.stringify({ type: 'presence', login: name(login), online: on, ts: Date.now() });
  for (const [k, u] of Object.entries(db.users)) if (u.book && u.book[login]) for (const w of online.get(k) || []) w.readyState === 1 && w.send(msg);
}
setInterval(() => wss.clients.forEach((ws) => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); }), 25000);

server.listen(PORT, () => console.log(`Ahazang: ${process.env.CERT ? 'https' : 'http'}://${DOMAIN}:${PORT}  (админ: /admin.html)`));
