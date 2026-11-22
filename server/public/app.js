// Ahazang — клиент
const APP_VERSION = '10';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let token = localStorage.getItem('hx_token'), me = localStorage.getItem('hx_me');
const wasLoggedIn = !!token; // для «Что нового»: показываем только тем, кто уже пользовался приложением
let ws, iceServers = [], users = [], chats = [], cur = null, call = null, reloadAfterCall = false;
const peerKeys = new Map(), online = new Set(), lastSeen = new Map();
// Android-приложение Ahazang (WebView) даёт мост window.HeraxosAndroid
const AND = window.HeraxosAndroid || null;
const D = (ev, info) => { try { window.hxDiag && hxDiag(ev, info); } catch {} };
const errText = (e) => (e && (e.name ? e.name + ': ' : '') + (e.message || e)) || String(e);
if (/Android/i.test(navigator.userAgent) && !AND) document.documentElement.classList.add('is-android');
const _qs = new URLSearchParams(location.search);
let autoAnswer = _qs.get('answer') ? { id: _qs.get('call'), video: _qs.get('answer') === 'video' } : null;
window.hxAnswer = (id, video) => { if (call && call.id === id && call.dir === 'ring') accept(!!video); else autoAnswer = { id, video: !!video }; };
window.hxHangup = () => { if (call) endCall(true); };
// iPhone: системный экран звонка (CallKit) — отклонить / VoIP-токен для звонков при закрытом приложении
const isIOSApp = window.HeraxosPlatform === 'ios';
let voipToken = null, serverVoip = false;
window.hxDecline = (id) => { if (call && call.id === id && call.dir === 'ring') { send({ type: 'reject', id }); call.dir = 'declined'; endCall(false); } };
window.hxSetVoip = (t) => {
  if (!/^[0-9a-f]{32,200}$/.test(String(t || ''))) return;
  voipToken = t; if (token) api('/api/voip', { token: t }).then((j) => { serverVoip = !!j.voip; }).catch(() => {});
};
window.hxBack = () => { if ($('viewer').classList.contains('on')) { closeViewer(); return true; } if ($('info').classList.contains('on')) { $('info').classList.remove('on'); return true; } if (call) return true; if ($('qMenu').classList.contains('on')) { $('qMenu').classList.remove('on'); return true; } if (cur && !matchMedia('(min-width:800px)').matches) { closeChat(); return true; } return false; };

// ---------- номера и имена ----------
// Внутри приложения человек определяется логином; на экране — имя из вашей телефонной книги или номер.
const people = new Map(); // логин (строчными) -> { login, num, name }
const fmtNum = (n) => (/^\d{6}$/.test(n || '') ? n.slice(0, 3) + ' ' + n.slice(3) : n || '');
function remember(p) { if (p && p.login) { const k = p.login.toLowerCase(); people.set(k, Object.assign(people.get(k) || {}, p)); } }
function dn(login) {
  if (!login) return '';
  const p = people.get(String(login).toLowerCase());
  return p ? p.name || fmtNum(p.num) || p.login : String(login);
}
const numOf = (login) => { const p = people.get(String(login).toLowerCase()); return p && p.num ? fmtNum(p.num) : ''; };
const inBook = (login) => users.some((u) => u.login.toLowerCase() === String(login).toLowerCase());
async function ensurePeer(login) {
  const k = String(login).toLowerCase(); if (people.has(k) && people.get(k).num) return people.get(k);
  try { const p = await api('/api/peer/' + encodeURIComponent(k)); remember(p); return p; } catch { return null; }
}

// ---------- утилиты ----------
const COLORS = ['#c96442', '#b5835a', '#8b6f47', '#6a8a82', '#7e8fb8', '#a26b8f', '#5e8c61', '#b8875a', '#8c7aa9', '#c17c74', '#6f8fa6', '#9a7b4f'];
function avatar(el, login, isOnline) {
  let h = 0; for (const c of login) h = (h * 31 + c.charCodeAt(0)) | 0;
  el.style.background = COLORS[Math.abs(h) % COLORS.length];
  const label = dn(login) || '?';
  el.innerHTML = esc((/^[\d+ ]/.test(label) ? '#' : label[0]).toUpperCase()) + (isOnline ? '<i></i>' : '');
}
const avaHTML = (login, on, cls = '') => { const d = document.createElement('div'); d.className = 'ava ' + cls; avatar(d, login, on); return d.outerHTML; };
const pad = (n) => String(n).padStart(2, '0');
function fmtTime(ts) { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function fmtDay(ts) {
  const d = new Date(ts), now = new Date(), y = new Date(now - 864e5);
  if (d.toDateString() === now.toDateString()) return 'Сегодня';
  if (d.toDateString() === y.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}
function fmtList(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return fmtTime(ts);
  if (now - d < 2 * 864e5 && new Date(now - 864e5).toDateString() === d.toDateString()) return 'Вчера';
  if (now - d < 6 * 864e5) return d.toLocaleDateString('ru-RU', { weekday: 'short' });
  return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + String(d.getFullYear()).slice(2);
}
function fmtSeen(login) {
  if (online.has(login)) return 'в сети';
  const t = lastSeen.get(login); if (!t) return 'не в сети';
  return 'был(а) ' + (fmtDay(t) === 'Сегодня' ? 'сегодня' : fmtDay(t).toLowerCase()) + ' в ' + fmtTime(t);
}
function toast(t, ms = 2500) { const e = $('toast'); e.textContent = t; e.style.display = 'block'; clearTimeout(e._t); e._t = setTimeout(() => (e.style.display = 'none'), ms); }
const TICK1 = '<svg class="tick" viewBox="0 0 16 11"><path d="M1.5 6 5 9.5 12 1.5"/></svg>';
const TICK2 = '<svg class="tick read" viewBox="0 0 16 11"><path d="M1 6l3.5 3.5L11.5 1.5M7 8.5l1 1L15 1.5"/></svg>';
const CLOCK = '<svg class="tick" viewBox="0 0 16 11"><circle cx="8" cy="5.5" r="4.5"/><path d="M8 3v3h2"/></svg>';

async function api(url, body, method) {
  const r = await fetch(url, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body && JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && !url.startsWith('/api/login')) { logout(true); throw new Error('Сессия завершена'); }
  if (!r.ok) throw new Error(j.error || 'Ошибка');
  return j;
}

// ---------- вход / ключи ----------
async function doAuth(kind) {
  const reg = kind === 'register';
  const login = (reg ? $('rLogin') : $('login')).value.trim(), password = (reg ? $('rPass') : $('pass')).value;
  const num = reg ? $('rNum').value.replace(/\D/g, '') : '';
  if (reg && num && num.length !== 6) return ($('aerr').textContent = 'Номер — ровно 6 цифр, или оставьте поле пустым');
  $('aerr').textContent = '';
  if (!login || !password) return ($('aerr').textContent = 'Введите логин и пароль');
  if (reg && password !== $('rPass2').value) return ($('aerr').textContent = 'Пароли не совпадают');
  if (reg && !$('rTerms').checked) return ($('aerr').textContent = 'Примите условия использования и политику конфиденциальности');
  const btn = reg ? $('bReg') : $('bLogin'); btn.disabled = true;
  $('aerr').textContent = reg ? 'Создаём ключи шифрования…' : 'Вход…';
  try {
    const j = await api('/api/' + kind, reg ? { login, password, num } : { login, password });
    if (j.num) localStorage.setItem('hx_num', j.num);
    if (reg && j.num) setTimeout(() => toast('Ваш номер: ' + fmtNum(j.num), 5000), 800);
    token = j.token; me = j.login;
    let local;
    if (j.keys) local = await HX.unwrap(j.keys, password);
    else { const g = await HX.generate(password); await api('/api/keys', g.server); local = g.local; }
    localStorage.setItem('hx_token', token); localStorage.setItem('hx_me', me); localStorage.setItem('hx_k_' + me, local);
    ['pass', 'rPass', 'rPass2'].forEach((id) => ($(id).value = '')); $('aerr').textContent = ''; start();
  } catch (e) { $('aerr').textContent = /operation/i.test(e.message) ? 'Не удалось расшифровать ключ' : e.message; }
  btn.disabled = false;
}
function authTab(reg) {
  $('tLogin').classList.toggle('on', !reg); $('tReg').classList.toggle('on', reg);
  $('fLogin').hidden = reg; $('fReg').hidden = !reg; $('aerr').textContent = '';
  setTimeout(() => (reg ? $('rLogin') : $('login')).focus(), 50);
}
$('tLogin').onclick = () => authTab(false);
$('tReg').onclick = () => authTab(true);
$('fLogin').onsubmit = (e) => { e.preventDefault(); doAuth('login'); };
$('fReg').onsubmit = (e) => { e.preventDefault(); doAuth('register'); };
document.querySelectorAll('.eye').forEach((b) => (b.onclick = () => {
  const show = !b.classList.contains('on'); b.classList.toggle('on', show);
  if (b.dataset.for === 'pass') $('pass').type = show ? 'text' : 'password';
  else ['rPass', 'rPass2'].forEach((id) => $(id).classList.toggle('shown', show));
}));
function logout(silent) {
  // выходим — этот iPhone больше не должен звонить для этого аккаунта
  if (!silent && voipToken) api('/api/voip/remove', { token: voipToken }).catch(() => {});
  if (!silent) api('/api/logout', {}).catch(() => {});
  if (me) localStorage.removeItem('hx_k_' + me);
  if (AND) try { AND.clearSession(); } catch {}
  localStorage.removeItem('hx_token'); token = null; ws && ws.close(); ws = null;
  $('app').classList.remove('on'); $('auth').classList.add('on');
}
$('bOut').onclick = () => confirm('Выйти из Ahazang на этом устройстве?') && logout();

// ---------- запуск ----------
async function start() {
  const local = localStorage.getItem('hx_k_' + me);
  if (!local) return logout(true);
  await HX.load(local);
  if (AND) try { AND.setSession(token, me); } catch {}
  $('auth').classList.remove('on'); $('app').classList.add('on');
  $('meName').textContent = me; avatar($('meAva'), me); showMyNum(localStorage.getItem('hx_num'));
  api('/api/me').then((j) => { serverVoip = !!j.voip; if (j.num) { localStorage.setItem('hx_num', j.num); showMyNum(j.num); } }).catch(() => {});
  if (voipToken) window.hxSetVoip(voipToken);
  // с версии 6 по умолчанию 1080p (снижается автоматически только при слабом интернете)
  if (localStorage.getItem('hx_q_v') !== '2') { localStorage.setItem('hx_q', 'hd'); localStorage.setItem('hx_q_v', '2'); }
  $('defQuality').value = localStorage.getItem('hx_q') || 'hd';
  // веб-уведомления нужны только в браузере; в приложениях их присылает Android-служба / Apple
  if ('serviceWorker' in navigator && !AND) {
    navigator.serviceWorker.register('/sw.js');
    navigator.serviceWorker.addEventListener('message', (e) => e.data && e.data.open && openChat(e.data.open));
  }
  iceServers = await api('/api/ice').catch(() => []);
  connect(); await Promise.all([loadUsers(), loadChats()]); renderCalls(); setInterval(loadUsers, 30000);
  pushState();
  const q = _qs.get('chat');
  if (location.search) history.replaceState(null, '', '/');
  if (q) openChat(q);
  showVersionInfo(); whatsNewOnce(); checkAppUpdate(false);
}
$('defQuality').onchange = (e) => localStorage.setItem('hx_q', e.target.value);

// вкладки
document.querySelectorAll('#tabbar button').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('#tabbar button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab-page').forEach((p) => p.classList.toggle('on', p.dataset.tab === b.dataset.tab));
  if (b.dataset.tab === 'calls') renderCalls();
  if (b.dataset.tab === 'contacts') loadUsers();
}));

// ---------- WebSocket ----------
let wsRetry = 1000, wsTimer, wsQueue = Promise.resolve();
function connect() {
  if (!token) return;
  clearTimeout(wsTimer);
  if (ws && ws.readyState <= 1) return;
  const s = (ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?token=' + token + '&v=' + APP_VERSION));
  s.onopen = () => {
    wsRetry = 1000; $('connState').textContent = 'в сети';
    // сигнальное соединение вернулось — восстанавливаем звонок, если связь с кем-то потеряна
    if (call) for (const p of call.peers.values()) if (p.lost) restartIce(p);
  };
  s.onclose = (e) => {
    D('ws-close', e.code + (call ? ' (в звонке)' : ''));
    if (ws !== s) return;
    $('connState').textContent = 'нет соединения…';
    if (e.code === 4001) return logout(true);
    if (token) { wsTimer = setTimeout(connect, wsRetry); wsRetry = Math.min(wsRetry * 2, 8000); }
  };
  // сообщения обрабатываем строго по очереди: иначе ответы на перезапуск связи могут обогнать друг друга
  s.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } wsQueue = wsQueue.then(() => onWS(m)).catch((x) => D('ws-err', errText(x))); };
}
const send = (m) => { if (!ws || ws.readyState !== 1) return false; ws.send(JSON.stringify(m)); return true; };
document.addEventListener('visibilitychange', () => {
  // приложение свернули во время входящего — дальше звонит система; открыли — звонит страница
  if (call && call.dir === 'ring') {
    if (!document.hidden) ring(true);
    else if (AND && AND.ringNative) { try { AND.ringNative(call.id, call.title, dn(call.title), !!call.offerVideo); } catch {} ring(false); }
  }
  if (document.hidden || !token) return;
  if (!ws || ws.readyState > 1) { wsRetry = 1000; connect(); }
  if (call) for (const p of call.peers.values()) if (p.lost) restartIce(p);
  loadChats(); if (cur) markRead();
});
// Сменилась сеть (Wi-Fi ↔ мобильный интернет): сразу переподключаемся, не дожидаясь таймаутов
function networkChanged() {
  if (!token) return;
  if (ws && ws.readyState === 1 && call) { /* сигналка жива — просто проверяем звонок */ }
  else { try { ws && ws.close(); } catch {} ws = null; wsRetry = 1000; connect(); }
  if (call) for (const p of call.peers.values()) if (p.pc.connectionState !== 'connected') { p.lost ||= Date.now(); restartIce(p); }
}
window.addEventListener('online', networkChanged);
try { navigator.connection && navigator.connection.addEventListener('change', networkChanged); } catch {}
// Закрытие страницы во время звонка НЕ завершает звонок сразу: Safari на iPhone присылает pagehide и при
// простом сворачивании. Если человек действительно ушёл, сервер выведет его через 60 с без соединения,
// а Android-приложение сообщает о закрытии само.

// Перезагрузка на новую версию: адрес с меткой времени, чтобы браузер точно не взял старые файлы из кэша,
// и не чаще раза в 2 минуты — защита от бесконечной перезагрузки
function hardReload(v) {
  window.hxDiag && hxDiag('hardReload', v);
  try {
    const last = +sessionStorage.getItem('hx_reload_at') || 0;
    if (Date.now() - last < 120000) return toast('Доступна новая версия — закройте и откройте приложение', 5000);
    sessionStorage.setItem('hx_reload_at', String(Date.now()));
  } catch {}
  location.replace('/?v=' + encodeURIComponent(v || '') + '&t=' + Date.now());
}
async function onWS(m) {
  switch (m.type) {
    case 'reload': // на сервере новая версия приложения
      if (call) { reloadAfterCall = true; return; }
      return hardReload(m.v);
    case 'msg': return onMessage(m);
    case 'sent': return onSent(m);
    case 'read':
      if (cur && cur.peer.toLowerCase() === m.from.toLowerCase()) { cur.peerRead = Math.max(cur.peerRead, m.ts); renderMsgs(); }
      return loadChatsSoon();
    case 'typing':
      if (cur && cur.peer.toLowerCase() === m.from.toLowerCase()) {
        $('cStatus').textContent = 'печатает…'; clearTimeout(cur.tt); cur.tt = setTimeout(updateHeadStatus, 3500);
      } return;
    case 'presence':
      if (m.online) online.add(m.login.toLowerCase()); else { online.delete(m.login.toLowerCase()); lastSeen.set(m.login.toLowerCase(), m.ts); }
      updateHeadStatus(); renderChats(); renderUsers(); return;
    case 'contacts':
      loadUsers(); loadChats();
      return;
    default: return onSignal(m);
  }
}

// ---------- контакты (по взаимному согласию) ----------
let requests = [], sentReq = [], blocked = new Set();
async function loadUsers() {
  try {
    const j = await api('/api/contacts');
    users = j.contacts; requests = []; sentReq = [];
    users.forEach(remember); (j.blocked || []).forEach(remember);
    blocked = new Set((j.blocked || []).map((x) => (x.login || x).toLowerCase())); updateBlockUI();
    users.forEach((u) => { const k = u.login.toLowerCase(); u.online ? online.add(k) : online.delete(k); if (u.lastSeen) lastSeen.set(k, u.lastSeen); });
    const rb = $('reqBadge'); rb.textContent = requests.length; rb.style.display = requests.length ? 'block' : 'none';
    renderUsers(); renderChats();
  } catch {}
}
function contactRow(login, actions) {
  const k = login.toLowerCase(), d = document.createElement('div'); d.className = 'row';
  d.innerHTML = `${avaHTML(login, online.has(k))}<div class="body"><div class="top"><b>${esc(dn(login))}</b></div><div class="sub"><span></span></div></div><div class="act">${actions}</div>`;
  return d;
}
function renderUsers() {
  const L = $('userList'); L.innerHTML = ''; $('reqBadge').style.display = 'none';
  L.insertAdjacentHTML('beforeend', `<div class="section">Мои контакты${users.length ? ' · ' + users.length : ''}</div>`);
  if (!users.length) L.insertAdjacentHTML('beforeend', '<div class="empty-list">Контактов пока нет.<br>Введите номер человека выше, при желании — имя, и нажмите «Добавить». Подтверждение с его стороны не нужно.</div>');
  users.forEach((u) => {
    const k = u.login.toLowerCase();
    const d = contactRow(u.login, '<button class="iconbtn" data-a="v"><svg><use href="#i-video"/></svg></button><button class="iconbtn" data-a="a"><svg><use href="#i-phone"/></svg></button><button class="iconbtn dim" data-a="x" title="Ещё"><svg><use href="#i-more"/></svg></button>');
    const st = d.querySelector('.sub span');
    st.innerHTML = `${u.name ? `<span class="num">${esc(fmtNum(u.num))}</span> · ` : ''}${isBlocked(k) ? 'заблокирован(а)' : esc(fmtSeen(k))}`;
    if (online.has(k) && !isBlocked(k)) st.className = 'on';
    d.onclick = (e) => {
      const a = e.target.closest('[data-a]'); if (!a) return openChat(u.login);
      e.stopPropagation();
      if (a.dataset.a === 'x') return contactMenu(u.login);
      startCall(u.login, a.dataset.a === 'v');
    };
    L.appendChild(d);
  });
}
// меню контакта: имя, удаление, блокировка
function contactMenu(login) {
  const saved = inBook(login), b = isBlocked(login);
  infoSheet(dn(login), numOf(login) && dn(login) !== numOf(login) ? `<p class="mute">Номер: ${esc(numOf(login))}</p>` : '', [
    { label: saved ? 'Изменить имя' : 'Сохранить в контакты', primary: true, on: () => askName(login) },
    saved ? { label: 'Удалить из контактов', on: () => removeContact(login) } : null,
    b ? { label: 'Разблокировать', on: () => setBlocked(login, false) } : { label: 'Заблокировать', danger: true, on: () => askBlock(login) },
    { label: 'Закрыть' },
  ].filter(Boolean));
}
function askName(login) {
  const cur0 = (users.find((u) => u.login.toLowerCase() === login.toLowerCase()) || {}).name || '';
  infoSheet(inBook(login) ? 'Изменить имя' : 'Сохранить контакт', `<p class="mute">Номер: ${esc(numOf(login))}</p><input type="text" id="nmIn" maxlength="40" placeholder="Имя" value="${esc(cur0)}">`,
    [{ label: 'Сохранить', primary: true, on: async () => {
      const name = $('nmIn').value.trim();
      try {
        const r = await api(inBook(login) ? '/api/contacts/rename' : '/api/contacts/add', { login, name });
        remember(r); toast('Сохранено', 1500); await loadUsers(); loadChats(); if (cur) { $('cPeer').textContent = dn(cur.peer); updateHeadStatus(); }
      } catch (x) { toast(x.message); }
    } }, { label: 'Отмена' }]);
  setTimeout(() => $('nmIn') && $('nmIn').focus(), 100);
}
async function removeContact(login) {
  if (!confirm(`Удалить «${dn(login)}» из контактов? Переписка сохранится, написать и позвонить по номеру можно будет как и раньше.`)) return;
  await api('/api/contacts/' + encodeURIComponent(login.toLowerCase()), null, 'DELETE').catch(() => {});
  const p = people.get(login.toLowerCase()); if (p) p.name = '';
  await loadUsers(); loadChats(); if (cur) { $('cPeer').textContent = dn(cur.peer); updateHeadStatus(); }
}
$('fAdd').onsubmit = async (e) => {
  e.preventDefault();
  const num = $('addNum').value.replace(/\D/g, ''), name = $('addName').value.trim(); if (!num) return toast('Введите номер');
  try {
    const r = await api('/api/contacts/add', { num, name });
    remember(r); $('addNum').value = $('addName').value = '';
    toast(`${dn(r.login)} добавлен(а) в контакты`, 2500);
    await loadUsers(); loadChats();
  } catch (x) { toast(x.message); }
};

// ---------- мой номер ----------
function showMyNum(n) { $('meNum').textContent = n ? '№ ' + fmtNum(n) : ''; $('myNumState').textContent = n ? fmtNum(n) + ' — нажмите, чтобы сменить' : '—'; }
$('bMyNum').onclick = () => {
  const n = localStorage.getItem('hx_num') || '';
  infoSheet('Мой номер', `<p class="mute">Сейчас: <b>${esc(fmtNum(n))}</b>. Можно выбрать любой свободный 6-значный номер. Старый номер освободится, и по нему вас больше не найдут.</p><input type="text" id="newNum" inputmode="numeric" maxlength="7" placeholder="Новый номер — 6 цифр">`,
    [{ label: 'Сменить номер', primary: true, on: async () => {
      const v = $('newNum').value.replace(/\D/g, '');
      try { const r = await api('/api/number', { num: v }); localStorage.setItem('hx_num', r.num); showMyNum(r.num); toast('Ваш новый номер: ' + fmtNum(r.num), 3500); }
      catch (x) { toast(x.message, 3500); }
    } }, { label: 'Отмена' }]);
};

// ---------- ключи собеседников ----------
async function peerKey(login, fresh) {
  const k = login.toLowerCase();
  if (!fresh && peerKeys.has(k)) return peerKeys.get(k);
  const { pub } = await api('/api/key/' + encodeURIComponent(k)); peerKeys.set(k, pub); return pub;
}
const plain = new Map(); // id -> расшифрованный текст (только в памяти)
async function decryptMsg(peer, m) {
  if (plain.has(m.id)) return plain.get(m.id);
  const pub = await peerKey(peer).catch(() => null);
  const t = pub ? await HX.open(pub, m.iv, m.ct) : null;
  if (t !== null) plain.set(m.id, t); return t;
}

// ---------- список чатов ----------
let lcTimer; const loadChatsSoon = () => { clearTimeout(lcTimer); lcTimer = setTimeout(loadChats, 300); };
async function loadChats() {
  try {
    chats = await api('/api/chats');
    for (const c of chats) { remember({ login: c.peer, num: c.num, name: c.name }); c.preview = await decryptMsg(c.peer, c.last); const k = c.peer.toLowerCase(); c.online ? online.add(k) : online.delete(k); }
    renderChats();
  } catch {}
}
function renderChats() {
  const q = $('qChats').value.trim().toLowerCase(), L = $('chatList');
  let total = 0; L.innerHTML = '';
  if (!AND && (window.Notification && Notification.permission === 'default' || (isIOS && !standalone))) {
    const b = document.createElement('div'); b.className = 'e2e-note'; b.style.margin = '6px 16px 8px'; b.style.cursor = 'pointer';
    b.innerHTML = isIOS && !standalone ? '📲 Добавьте Ahazang на экран «Домой» (Поделиться → На экран «Домой»), чтобы получать звонки и сообщения' : '🔔 Нажмите, чтобы включить уведомления о звонках и сообщениях';
    b.onclick = enablePush; L.appendChild(b);
  }
  const match = (l) => dn(l).toLowerCase().includes(q) || (numOf(l) || '').replace(' ', '').includes(q.replace(/\s/g, ''));
  const list = chats.filter((c) => match(c.peer));
  list.forEach((c) => {
    total += c.unread;
    const mine = c.last.f.toLowerCase() === me.toLowerCase();
    const tick = mine ? (c.last.ts <= c.peerRead ? TICK2 : TICK1) + ' ' : '';
    const prev = c.preview === null ? '🔒 Сообщение недоступно' : previewOf(c.preview);
    const d = document.createElement('div'); d.className = 'row' + (cur && cur.peer === c.peer ? ' sel' : '');
    d.innerHTML = `${avaHTML(c.peer, online.has(c.peer.toLowerCase()))}<div class="body"><div class="top"><b>${esc(dn(c.peer))}</b><time class="${c.unread ? 'unr' : ''}">${fmtList(c.last.ts)}</time></div>
      <div class="sub"><span>${tick}${esc(prev)}</span>${c.unread ? `<b class="badge">${c.unread}</b>` : ''}</div></div>`;
    d.onclick = () => openChat(c.peer); L.appendChild(d);
  });
  const withChat = new Set(chats.map((c) => c.peer.toLowerCase()));
  const rest = users.filter((u) => !withChat.has(u.login.toLowerCase()) && match(u.login))
    .sort((a, b) => online.has(b.login.toLowerCase()) - online.has(a.login.toLowerCase()) || dn(a.login).localeCompare(dn(b.login)));
  if (rest.length) {
    L.insertAdjacentHTML('beforeend', `<div class="section">Контакты · ${rest.length}</div>`);
    rest.forEach((u) => {
      const k = u.login.toLowerCase(), d = document.createElement('div'); d.className = 'row';
      d.innerHTML = `${avaHTML(u.login, online.has(k))}<div class="body"><div class="top"><b>${esc(dn(u.login))}</b></div><div class="sub"><span class="${online.has(k) ? 'on' : ''}">${esc(fmtSeen(k))}</span></div></div>
        <div class="act"><button class="iconbtn" data-a="v"><svg><use href="#i-video"/></svg></button><button class="iconbtn" data-a="a"><svg><use href="#i-phone"/></svg></button></div>`;
      d.onclick = (e) => { const a = e.target.closest('[data-a]'); if (a) { e.stopPropagation(); return startCall(u.login, a.dataset.a === 'v'); } openChat(u.login); };
      L.appendChild(d);
    });
  }
  if (!list.length && !rest.length) L.insertAdjacentHTML('beforeend', `<div class="empty-list">${q ? 'Никого не найдено' : 'Здесь появятся ваши чаты.<br>Добавьте человека по номеру во вкладке «Контакты».'}</div>`);
  const ub = $('unreadBadge'); ub.textContent = total; ub.style.display = total ? 'block' : 'none';
  if (navigator.setAppBadge) total ? navigator.setAppBadge(total).catch(() => {}) : navigator.clearAppBadge().catch(() => {});
}
$('qChats').oninput = renderChats;

// ---------- переписка ----------
async function openChat(peer) {
  const p = await ensurePeer(peer); if (!p) return toast('Абонент не найден');
  peer = p.login;
  cur = { peer, msgs: [], peerRead: 0, pub: null };
  document.querySelector('#tabbar button[data-tab=chats]').click();
  $('chat').classList.add('has'); $('app').classList.add('in-chat');
  $('cPeer').textContent = dn(peer); avatar($('cAva'), peer); updateHeadStatus();
  $('msgs').innerHTML = ''; renderChats(); updateBlockUI();
  try {
    cur.pub = await peerKey(peer, true);
    const j = await api('/api/messages/' + encodeURIComponent(peer.toLowerCase()));
    if (!cur || cur.peer !== peer) return;
    cur.peerRead = j.peerRead;
    for (const m of j.msgs) { m.text = await decryptMsg(peer, m); cur.msgs.push(m); }
    renderMsgs(true); markRead();
  } catch (e) { toast(e.message); }
  if (matchMedia('(min-width:800px)').matches) $('txt').focus();
}
function closeChat() { cur = null; $('app').classList.remove('in-chat'); $('chat').classList.remove('has'); renderChats(); }
$('bBack').onclick = closeChat;
window.addEventListener('popstate', () => cur && closeChat());
$('bAudio').onclick = () => cur && startCall(cur.peer, false);
$('bVideo').onclick = () => cur && startCall(cur.peer, true);

function updateHeadStatus() {
  if (!cur) return; const n = numOf(cur.peer), shown = dn(cur.peer);
  $('cStatus').textContent = (n && n !== shown ? n + ' · ' : '') + fmtSeen(cur.peer.toLowerCase());
}

function renderMsgs(scroll) {
  const box = $('msgs'), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  let html = '<div class="e2e-note">🔒 Сообщения защищены сквозным шифрованием. Никто, кроме вас и собеседника, включая администратора, не может их прочитать.</div>';
  let lastDay = '', lastF = '';
  for (const m of cur.msgs) {
    const day = fmtDay(m.ts); if (day !== lastDay) { html += `<div class="day"><span>${day}</span></div>`; lastDay = day; lastF = ''; }
    const mine = m.f.toLowerCase() === me.toLowerCase();
    const st = !mine ? '' : m.pending ? CLOCK : m.ts <= cur.peerRead ? TICK2 : TICK1;
    const f = m.file || fileOf(m.text), i = cur.msgs.indexOf(m);
    if (f) {
      html += `<div class="m ${mine ? 'o' : ''} ${m.f !== lastF ? 'first' : ''}"><div class="b file" data-fi="${i}">${fileHTML(f, m)}<span class="meta">${fmtTime(m.ts)} ${st}</span></div></div>`;
      lastF = m.f; continue;
    }
    const text = m.text === null ? '<span>🔒 Сообщение недоступно: ключ шифрования изменился</span>' : esc(m.text);
    html += `<div class="m ${mine ? 'o' : ''} ${m.f !== lastF ? 'first' : ''}"><div class="b${m.text === null ? ' lock' : ''}">${text}<span class="meta">${fmtTime(m.ts)} ${st}</span></div></div>`;
    lastF = m.f;
  }
  box.innerHTML = html;
  if (scroll || atBottom) box.scrollTop = box.scrollHeight;
}

function markRead() {
  if (!cur || document.hidden) return;
  const inc = cur.msgs.filter((m) => m.f.toLowerCase() !== me.toLowerCase());
  if (!inc.length) return;
  const ts = inc[inc.length - 1].ts;
  if (cur.myRead >= ts) return; cur.myRead = ts;
  api('/api/read/' + encodeURIComponent(cur.peer.toLowerCase()), { ts }).then(loadChatsSoon).catch(() => {});
}

async function sendMsg() {
  const text = $('txt').value.trim(); if (!text || !cur) return;
  if (!cur.pub) { cur.pub = await peerKey(cur.peer, true).catch(() => null); if (!cur.pub) return toast('Собеседник ещё ни разу не входил — ключа шифрования пока нет'); }
  const { iv, ct } = await HX.seal(cur.pub, text);
  const cid = Math.random().toString(36).slice(2);
  cur.msgs.push({ cid, f: me, ts: Date.now(), text, pending: true });
  $('txt').value = ''; autosize(); renderMsgs(true);
  if (!send({ type: 'msg', to: cur.peer, iv, ct, cid })) toast('Нет соединения, сообщение не отправлено');
}
function onSent(m) {
  if (cur && cur.peer.toLowerCase() === m.to.toLowerCase()) {
    const x = cur.msgs.find((y) => y.cid === m.cid);
    if (x) { x.id = m.id; x.ts = m.ts; x.pending = false; plain.set(m.id, x.text); renderMsgs(); }
  }
  loadChatsSoon();
}
async function onMessage(m) {
  if (cur && cur.peer.toLowerCase() === m.peer.toLowerCase()) {
    if (cur.msgs.some((x) => x.id === m.id)) return;
    m.text = await decryptMsg(cur.peer, m); cur.msgs.push(m); renderMsgs(); markRead();
    if (m.f.toLowerCase() !== me.toLowerCase()) { $('cStatus').textContent = fmtSeen(cur.peer.toLowerCase()); }
  } else if (m.f.toLowerCase() !== me.toLowerCase()) {
    navigator.vibrate && navigator.vibrate(80);
  }
  loadChatsSoon();
}
$('bSend').onclick = sendMsg;

// ---------- блокировка и жалобы ----------
const isBlocked = (l) => blocked.has(K(l));
function updateBlockUI() {
  const b = !!(cur && isBlocked(cur.peer));
  $('blockBar').hidden = !b; $('composer').hidden = b;
  $('bAudio').style.visibility = $('bVideo').style.visibility = b ? 'hidden' : '';
  $('blockedState').textContent = blocked.size ? `${blocked.size} — нажмите, чтобы разблокировать` : 'Никого';
}
async function setBlocked(login, on) {
  try {
    await api(on ? '/api/block' : '/api/unblock', { login });
    toast(on ? `${dn(login)} заблокирован(а): не сможет писать и звонить вам` : `${dn(login)} разблокирован(а)`, 3000);
    if (on && call && [...call.peers.keys(), ...call.pending.keys()].includes(K(login))) endCall(true);
    await loadUsers(); updateBlockUI();
  } catch (e) { toast(e.message); }
}
function askBlock(login) {
  infoSheet(`Заблокировать ${dn(login)}?`, `<p class="mute">${esc(dn(login))} не сможет писать вам, звонить, отправлять файлы и заявки. Об этом ему не сообщается. Разблокировать можно в любой момент.</p>`,
    [{ label: 'Заблокировать', danger: true, on: () => setBlocked(login, true) }, { label: 'Отмена' }]);
}
const REASONS = ['Спам или реклама', 'Оскорбления, угрозы или травля', 'Недопустимые материалы', 'Мошенничество', 'Другое'];
function askReport(login) {
  const own = cur && K(cur.peer) === K(login);
  infoSheet(`Пожаловаться на ${dn(login)}`,
    `<div class="opts">${REASONS.map((r, i) => `<label><input type="radio" name="rr" value="${esc(r)}" ${i ? '' : 'checked'}> ${esc(r)}</label>`).join('')}</div>
     <textarea id="rNote" rows="2" maxlength="1000" placeholder="Комментарий (необязательно)"></textarea>
     ${own ? `<label class="terms"><input type="checkbox" id="rAttach" checked> <span>Приложить последние сообщения от ${esc(dn(login))}. Они расшифровываются на вашем телефоне и передаются только администратору.</span></label>` : ''}`,
    [{ label: 'Отправить жалобу', danger: true, on: () => sendReport(login) }, { label: 'Отмена' }]);
}
async function sendReport(login) {
  const reason = (document.querySelector('input[name=rr]:checked') || {}).value || 'Другое';
  const note = ($('rNote') && $('rNote').value) || '';
  let messages = [];
  if ($('rAttach') && $('rAttach').checked && cur && K(cur.peer) === K(login)) {
    messages = cur.msgs.filter((m) => K(m.f) === K(login) && m.text !== null).slice(-10)
      .map((m) => ({ f: m.f, ts: m.ts, text: fileOf(m.text) ? '[файл] ' + fileOf(m.text).n : m.text }));
  }
  try {
    await api('/api/report', { login, reason, note, messages });
    if (isBlocked(login)) return toast('Жалоба отправлена администратору', 3000);
    infoSheet('Жалоба отправлена', `<p class="mute">Администратор рассмотрит её. Заблокировать ${esc(dn(login))}, чтобы он(а) больше не мог(ла) с вами связаться?</p>`,
      [{ label: 'Заблокировать', danger: true, on: () => setBlocked(login, true) }, { label: 'Не сейчас' }]);
  } catch (e) { toast(e.message); }
}
$('bMore').onclick = () => {
  if (!cur) return; const peer = cur.peer, b = isBlocked(peer), saved = inBook(peer);
  infoSheet(dn(peer), numOf(peer) && numOf(peer) !== dn(peer) ? `<p class="mute">Номер: ${esc(numOf(peer))}</p>` : '', [
    { label: saved ? 'Изменить имя' : 'Сохранить в контакты', primary: true, on: () => askName(peer) },
    saved ? { label: 'Удалить из контактов', on: () => removeContact(peer) } : null,
    { label: 'Пожаловаться', on: () => askReport(peer) },
    b ? { label: 'Разблокировать', primary: true, on: () => setBlocked(peer, false) } : { label: 'Заблокировать', danger: true, on: () => askBlock(peer) },
    { label: 'Закрыть' },
  ].filter(Boolean));
};
$('bUnblock').onclick = () => cur && setBlocked(cur.peer, false);
$('bBlocked').onclick = () => {
  if (!blocked.size) return toast('Вы никого не блокировали');
  infoSheet('Заблокированные', [...blocked].map((k) => `<div class="blk-row"><b>${esc(dn(k))}</b><span class="mute">${esc(numOf(k))}</span><button class="pill" data-unblock="${esc(k)}">Разблокировать</button></div>`).join(''), [{ label: 'Готово' }]);
};
$('infoBody').addEventListener('click', (e) => {
  const u = e.target.closest('[data-unblock]'); if (!u) return;
  setBlocked(u.dataset.unblock, false); u.closest('.blk-row').remove();
});

// ---------- документы: политика конфиденциальности и условия ----------
async function showDoc(kind) {
  try {
    const html = await (await fetch('/' + kind + '.html')).text();
    const doc = new DOMParser().parseFromString(html, 'text/html'), main = doc.querySelector('main');
    infoSheet(doc.title || '', `<div class="doc">${main ? main.innerHTML : ''}</div>`, [{ label: 'Закрыть', primary: true }]);
  } catch { toast('Не удалось открыть документ'); }
}
document.addEventListener('click', (e) => {
  const d = e.target.closest('[data-doc]'); if (!d) return;
  e.preventDefault(); showDoc(d.dataset.doc);
});

// ---------- удаление аккаунта ----------
$('bDelAcc').onclick = () => {
  infoSheet('Удалить аккаунт?', `<p>Будут безвозвратно удалены ваш профиль, контакты, вся переписка и отправленные файлы — у вас и у ваших собеседников. Восстановить их будет невозможно.</p>
    <input type="password" id="delPass" placeholder="Введите пароль для подтверждения" autocomplete="current-password">`,
    [{ label: 'Удалить навсегда', danger: true, on: async () => {
      const password = $('delPass').value;
      if (!password) return toast('Введите пароль');
      try { await api('/api/account/delete', { password }); toast('Аккаунт удалён', 3000); logout(true); }
      catch (e) { toast(e.message, 3500); }
    } }, { label: 'Отмена' }]);
};

// ---------- файлы (сквозное шифрование) ----------
// Сообщение о файле — обычное зашифрованное сообщение с текстом «HXF1:{...}»: в нём id файла на сервере,
// ключ и IV для расшифровки, имя, размер, тип и маленькое превью фото. Сам файл на сервере лежит зашифрованным.
const MAX_FILE_MB = 100;
const fileOf = (t) => { if (typeof t !== 'string' || !t.startsWith('HXF1:')) return null; try { return JSON.parse(t.slice(5)); } catch { return null; } };
const kindOf = (f) => (/^image\//.test(f.t) ? 'image' : /^video\//.test(f.t) ? 'video' : /^audio\//.test(f.t) ? 'audio' : 'file');
function previewOf(t) {
  const f = fileOf(t); if (!f) return t;
  return { image: '📷 Фото', video: '🎬 Видео', audio: '🎵 Аудио', file: '📎 ' + f.n }[kindOf(f)];
}
const fmtSize = (n) => (n < 1024 ? n + ' Б' : n < 1048576 ? Math.round(n / 1024) + ' КБ' : (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' МБ');
function fileHTML(f, m) {
  const bar = m.pending && !m.failed ? `<div class="fbar"><i style="width:${Math.round((m.progress || 0) * 100)}%"></i></div>` : '';
  const err = m.failed ? '<div class="ferr">Не отправлено — нажмите, чтобы повторить</div>' : '';
  if (typeof f.th === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(f.th)) return `<img class="thumb" src="${f.th}" alt="">${bar}${err}`;
  const icon = { video: '🎬', audio: '🎵' }[kindOf(f)];
  return `<div class="fcard"><div class="ficon">${icon ? `<span style="font-size:20px">${icon}</span>` : '<svg><use href="#i-doc"/></svg>'}</div>
    <div class="fi"><b>${esc(f.n || 'Файл')}</b><small>${fmtSize(f.s || 0)}${m.pending ? ' · отправка…' : ''}</small></div></div>${bar}${err}`;
}
let renderT; const renderSoon = () => { clearTimeout(renderT); renderT = setTimeout(() => cur && renderMsgs(), 120); };

// превью фото: до 320 px, JPEG — уходит внутри зашифрованного сообщения
async function makeThumb(file) {
  if (!/^image\/(jpeg|png|webp|gif|heic|heif)/.test(file.type)) return null;
  try {
    const url = URL.createObjectURL(file), img = new Image();
    await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = url; });
    const k = Math.min(1, 320 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
    for (const q of [0.6, 0.45, 0.3]) { const d = c.toDataURL('image/jpeg', q); if (d.length < 60000) return d; }
  } catch {}
  return null;
}
function uploadBlob(blob, peer, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/files?to=' + encodeURIComponent(peer.toLowerCase()));
    x.setRequestHeader('Authorization', 'Bearer ' + token); x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch {} x.status === 200 && j.id ? resolve(j) : reject(new Error(j.error || 'Не удалось отправить файл')); };
    x.onerror = () => reject(new Error('Нет соединения с сервером'));
    x.send(blob);
  });
}
async function sendFile(file, m) {
  if (!cur) return;
  const peer = cur.peer;
  if (file.size > MAX_FILE_MB * 1048576) return toast(`Файл больше ${MAX_FILE_MB} МБ`);
  if (!cur.pub) { cur.pub = await peerKey(peer, true).catch(() => null); if (!cur.pub) return toast('Собеседник ещё ни разу не входил — ключа шифрования пока нет'); }
  const pub = cur.pub;
  if (!m) { m = { cid: Math.random().toString(36).slice(2), f: me, ts: Date.now(), text: '', file: { n: file.name, s: file.size, t: file.type || '' }, pending: true, progress: 0, src: file }; cur.msgs.push(m); }
  m.failed = false; m.pending = true; m.progress = 0; renderMsgs(true);
  try {
    const th = await makeThumb(file); if (th) { m.file.th = th; renderSoon(); }
    const enc = await HX.sealFile(file, (p) => { m.progress = p * 0.25; renderSoon(); });
    const { id } = await uploadBlob(enc.blob, peer, (p) => { m.progress = 0.25 + p * 0.75; renderSoon(); });
    const info = { id, k: enc.k, iv: enc.iv, n: file.name, s: file.size, t: file.type || '' }; if (th) info.th = th;
    m.text = 'HXF1:' + JSON.stringify(info); m.file = info;
    const { iv, ct } = await HX.seal(pub, m.text);
    if (!send({ type: 'msg', to: peer, iv, ct, cid: m.cid })) throw new Error('Нет соединения, файл не отправлен');
    fileCache.set(id, file);
  } catch (e) { m.failed = true; toast(e.message, 3500); }
  renderMsgs();
}
$('bAttach').onclick = () => { if (!cur) return; $('fileIn').value = ''; $('fileIn').click(); };
$('fileIn').onchange = () => { for (const f of [...$('fileIn').files]) sendFile(f); };

// скачивание и расшифровка
const fileCache = new Map(); // id -> Blob (только в памяти, пока открыто приложение)
async function fetchFile(f) {
  if (fileCache.has(f.id)) return fileCache.get(f.id);
  toast('Загрузка…', 60000);
  try {
    const r = await fetch('/api/files/' + f.id, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Файл недоступен');
    const total = +r.headers.get('content-length') || 0, reader = r.body && r.body.getReader();
    let buf;
    if (reader && total) {
      buf = new Uint8Array(total); let off = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; buf.set(value, off); off += value.length; toast(`Загрузка… ${Math.round(off / total * 100)}%`, 60000); }
      buf = buf.buffer;
    } else buf = await r.arrayBuffer();
    const blob = await HX.openFile(buf, f.k, f.iv, f.t);
    if (blob.size < 60 * 1048576) fileCache.set(f.id, blob);
    $('toast').style.display = 'none';
    return blob;
  } catch (e) { toast(/operation/i.test(e.message) ? 'Файл повреждён или ключ не подходит' : e.message, 3500); throw e; }
}
// Сохранение на телефон: в приложениях — через мост частями (WebView не умеет скачивать blob:), иначе — обычная загрузка
async function saveBlob(blob, name, type) {
  if (AND && AND.fileBegin) {
    const sid = Math.random().toString(36).slice(2), STEP = 768 * 1024;
    if (AND.fileBegin(sid, name || 'file', type || 'application/octet-stream') === false) return toast('Разрешите доступ к памяти телефона и нажмите ещё раз', 4000);
    toast('Сохраняю…', 60000);
    for (let off = 0; off < blob.size; off += STEP) {
      const b64 = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.readAsDataURL(blob.slice(off, off + STEP)); });
      AND.fileChunk(sid, b64);
    }
    AND.fileEnd(sid); $('toast').style.display = 'none';
    return;
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name || 'file'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
let viewerUrl = null, viewerFile = null;
async function openFileMsg(m) {
  const f = m.file || fileOf(m.text); if (!f) return;
  if (m.failed && m.src) return sendFile(m.src, m);
  if (m.pending || !/^[a-f0-9]{32}$/.test(String(f.id || ''))) return;
  const blob = await fetchFile(f).catch(() => null); if (!blob) return;
  const kind = kindOf(f);
  if (kind === 'file') return saveBlob(blob, f.n, f.t);
  viewerFile = { blob, f }; if (viewerUrl) URL.revokeObjectURL(viewerUrl); viewerUrl = URL.createObjectURL(blob);
  $('vName').textContent = f.n || '';
  $('vBody').innerHTML = kind === 'image' ? `<img src="${viewerUrl}" alt="">` : kind === 'video' ? `<video src="${viewerUrl}" controls autoplay playsinline></video>` : `<audio src="${viewerUrl}" controls autoplay></audio>`;
  $('viewer').classList.add('on'); setBars(true);
}
function closeViewer() { if (!call) setBars(false); $('viewer').classList.remove('on'); $('vBody').innerHTML = ''; if (viewerUrl) URL.revokeObjectURL(viewerUrl); viewerUrl = null; viewerFile = null; }
$('vClose').onclick = closeViewer;
$('vSave').onclick = () => viewerFile && saveBlob(viewerFile.blob, viewerFile.f.n, viewerFile.f.t);
$('msgs').addEventListener('click', (e) => { const b = e.target.closest('[data-fi]'); if (b && cur) openFileMsg(cur.msgs[+b.dataset.fi]); });
let lastTyping = 0;
$('txt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && matchMedia('(min-width:800px)').matches) { e.preventDefault(); sendMsg(); }
});
function autosize() { const t = $('txt'); t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 130) + 'px'; }
$('txt').addEventListener('input', () => {
  autosize();
  if (cur && Date.now() - lastTyping > 2500) { lastTyping = Date.now(); send({ type: 'typing', to: cur.peer }); }
});

// ---------- уведомления ----------
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
function pushState() {
  if (AND) { $('pushState').textContent = window.HeraxosPlatform === 'ios' ? 'Тестовая версия: звонки приходят, пока приложение открыто' : 'Звонки и сообщения приходят через приложение Ahazang'; return; }
  const s = !('PushManager' in window) ? (isIOS && !standalone ? 'Сначала добавьте на экран «Домой»' : 'Не поддерживается этим браузером')
    : Notification.permission === 'granted' ? 'Включены' : Notification.permission === 'denied' ? 'Запрещены в настройках браузера' : 'Нажмите, чтобы включить';
  $('pushState').textContent = s;
  if (window.Notification && Notification.permission === 'granted') subscribePush();
}
async function enablePush() {
  if (isIOS && !standalone) return toast('Нажмите «Поделиться» → «На экран Домой», затем откройте Ahazang со значка', 5000);
  if (!('PushManager' in window)) return toast('Браузер не поддерживает уведомления');
  if ((await Notification.requestPermission()) === 'granted') { await subscribePush(); toast('Уведомления включены'); }
  pushState(); renderChats();
}
$('bPush').onclick = enablePush;
async function subscribePush() {
  try {
    const reg = await navigator.serviceWorker.ready, { key } = await api('/api/vapid');
    const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - key.length % 4) % 4)), (c) => c.charCodeAt(0));
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw }));
    await api('/api/subscribe', { sub: sub.toJSON() });
  } catch (e) { console.warn('push', e); }
}

// ---------- журнал звонков (только на этом устройстве) ----------
const callLog = () => JSON.parse(localStorage.getItem('hx_calls_' + me) || '[]');
function logCall(e) { const l = callLog(); l.unshift(e); localStorage.setItem('hx_calls_' + me, JSON.stringify(l.slice(0, 200))); }
function renderCalls() {
  const L = $('callList'), l = callLog();
  L.innerHTML = l.length ? '' : '<div class="empty-list">Звонков пока нет</div>';
  l.forEach((c) => {
    const missed = c.dir === 'missed', icon = c.dir === 'out' ? 'i-out' : 'i-in';
    const dur = c.dur ? ` · ${Math.floor(c.dur / 60)}:${pad(c.dur % 60)}` : '';
    const label = ({ out: 'Исходящий', in: 'Входящий', missed: 'Пропущенный' }[c.dir] || 'Звонок') + (c.group ? ' групповой' : '') + (c.video ? ' видеозвонок' : ' звонок');
    const d = document.createElement('div'); d.className = 'row';
    d.innerHTML = `${avaHTML(c.peer)}<div class="body"><div class="top"><b class="${missed ? 'miss' : ''}">${esc(String(c.peer).split(', ').map(dn).join(', '))}</b><time>${fmtList(c.ts)}</time></div>
      <div class="sub"><span><svg class="ic12 ${missed ? 'miss' : ''}" style="width:14px;height:14px"><use href="#${icon}"/></svg> ${label}${dur}</span></div></div>
      <div class="act"><button class="iconbtn"><svg><use href="#${c.video ? 'i-video' : 'i-phone'}"/></svg></button></div>`;
    d.onclick = () => { if (c.group) return toast('Групповой звонок: позвоните одному и добавьте остальных кнопкой «+»'); startCall(c.peer, c.video); }; L.appendChild(d);
  });
}

// ================= ЗВОНКИ (1:1 и групповые до 5 человек, каждый с каждым) =================
const Q = {
  low:    { w: 640,  h: 360,  fps: 24, br: 500_000,   label: '360p' },
  medium: { w: 960,  h: 540,  fps: 30, br: 1_200_000, label: '540p' },
  high:   { w: 1280, h: 720,  fps: 30, br: 2_500_000, label: '720p' },
  hd:     { w: 1920, h: 1080, fps: 30, br: 4_500_000, label: '1080p' },
};
// Это ПОТОЛОК. Реальный битрейт WebRTC подбирает сам по скорости канала: при слабом интернете
// сначала снижается битрейт, затем разрешение (частота кадров сохраняется), при хорошем — возвращается к 1080p.
// Звук: Opus 48 кГц, 64 кбит/с (для голоса больше не слышно разницы, зато меньше потерь),
// FEC + RED (повтор пакетов) — речь не «булькает» при потерях в мобильной сети.
const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000 };
const AUDIO_BR = 64_000;
const VIDEO_START_KBPS = 800; // старт с запасом для голоса; дальше WebRTC сам поднимает до 1080p, если канал позволяет
const MAX_CALL = 5;

function mungeOpus(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i); if (!m) return sdp;
  const pt = m[1], want = `minptime=20;useinbandfec=1;usedtx=0;stereo=0;sprop-stereo=0;maxplaybackrate=48000;sprop-maxcapturerate=48000;maxaveragebitrate=${AUDIO_BR};cbr=0`;
  const re = new RegExp(`a=fmtp:${pt} .*`, 'i');
  sdp = re.test(sdp) ? sdp.replace(re, `a=fmtp:${pt} ${want}`) : sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${want}`);
  // пакеты по 20 мс: устойчивее к потерям в мобильной сети, чем 10 мс
  return /a=ptime:/.test(sdp) ? sdp.replace(/a=ptime:\d+/g, 'a=ptime:20') : sdp.replace(/(a=rtpmap:\d+ opus\/48000\/2[^\r\n]*)/i, '$1\r\na=ptime:20');
}
function mungeVideoStart(sdp) {
  const pts = [], re = /a=rtpmap:(\d+) (VP8|VP9|H264)\/90000/gi; let m;
  while ((m = re.exec(sdp))) pts.push(m[1]);
  for (const pt of pts) {
    const f = new RegExp(`a=fmtp:${pt} (.*)`);
    if (f.test(sdp)) sdp = sdp.replace(f, (l, prm) => (/x-google-start-bitrate/.test(prm) ? l : `${l};x-google-start-bitrate=${VIDEO_START_KBPS}`));
    else sdp = sdp.replace(new RegExp(`(a=rtpmap:${pt} [^\\r\\n]+)`), `$1\r\na=fmtp:${pt} x-google-start-bitrate=${VIDEO_START_KBPS}`);
  }
  return sdp;
}
async function setLocal(pc, desc) { await pc.setLocalDescription({ type: desc.type, sdp: mungeVideoStart(mungeOpus(desc.sdp)) }); }

function preferCodecs(pc) {
  if (!window.RTCRtpReceiver || !RTCRtpReceiver.getCapabilities) return;
  for (const t of pc.getTransceivers()) {
    const kind = t.receiver.track && t.receiver.track.kind; if (!kind || !t.setCodecPreferences) continue;
    const caps = RTCRtpReceiver.getCapabilities(kind); if (!caps) continue;
    const order = kind === 'audio' ? ['audio/red', 'audio/opus'] : ['video/VP9', 'video/H264', 'video/VP8'];
    const rank = (c) => { const i = order.indexOf(c.mimeType); return i < 0 ? 99 : i; };
    // AV1 отключён: на части телефонов (особенно iPhone) с ним были сбои
    const list = [...caps.codecs].filter((c) => !/^video\/AV1$/i.test(c.mimeType));
    try { t.setCodecPreferences(list.sort((a, b) => rank(a) - rank(b))); } catch {}
  }
}
const camConstraints = (q, facing) => ({ facingMode: facing || 'user', width: { ideal: Q[q].w }, height: { ideal: Q[q].h }, frameRate: { ideal: Q[q].fps } });

// ---------- звук: разговорный динамик / громкая связь ----------
// Android-приложение: переключение через мост. iPhone (браузер): только режим «разговор», выбор вывода Apple не даёт.
const canRoute = !!(AND && AND.setAudioRoute);
function setRoute(r) {
  if (!call) return; call.route = r;
  if (canRoute) try { AND.setAudioRoute(r); } catch {}
  // как в WhatsApp: значок динамика всегда один; включена громкая связь — кнопка белая
  $('bSpeaker').classList.toggle('on', r === 'speaker');
  $('bSpeaker').innerHTML = '<svg><use href="#i-spk"/></svg>';
  $('bSpeaker').title = r === 'speaker' ? 'Громкая связь включена' : 'Громкая связь выключена';
  $('bSpeaker').setAttribute('aria-pressed', r === 'speaker');
}
function audioSessionCall() { try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch {} }
function audioSessionOff() { try { if (navigator.audioSession) navigator.audioSession.type = 'auto'; } catch {} }
$('bSpeaker').onclick = () => { if (!call) return; call.routeManual = true; setRoute(call.route === 'speaker' ? 'earpiece' : 'speaker'); toast(call.route === 'speaker' ? '🔊 Громкая связь' : '📱 Обычный режим (у уха)', 1200); };

// ---------- участники ----------
const K = (l) => String(l).toLowerCase();
function peerTile(login) {
  const t = document.createElement('div'); t.className = 'tile'; t.dataset.p = K(login);
  t.innerHTML = `<video autoplay playsinline muted></video><div class="tav"></div><div class="tname">${esc(dn(login))}</div><audio autoplay></audio>`;
  avatar(t.querySelector('.tav'), login);
  // незнакомый участник группового звонка: подтягиваем его номер
  if (!people.has(K(login))) ensurePeer(login).then(() => { t.querySelector('.tname').textContent = dn(login); avatar(t.querySelector('.tav'), login); if (call && call.peers.size + call.pending.size <= 1) layout(); });
  $('grid').appendChild(t); return t;
}
function getPeer(login) { return call && call.peers.get(K(login)); }
function newPeer(login) {
  const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  const p = { login, pc, ice: [], video: false, tile: null, connected: false };
  p.tile = call.pending.get(K(login)) || peerTile(login); p.tile.classList.remove('pend', 'joining'); call.pending.delete(K(login));
  p.vEl = p.tile.querySelector('video'); p.aEl = p.tile.querySelector('audio');
  pc.onicecandidate = (e) => e.candidate && send({ type: 'ice', id: call.id, to: login, candidate: e.candidate });
  pc.ontrack = (e) => {
    const tr = e.track;
    if (tr.kind === 'audio') { p.aEl.srcObject = new MediaStream([tr]); p.aEl.play().catch(() => {}); }
    else { p.vEl.srcObject = new MediaStream([tr]); p.vEl.play().catch(() => {}); tr.onunmute = tr.onmute = layout; }
  };
  pc.onconnectionstatechange = () => {
    if (!call || getPeer(login) !== p) return;
    const st = pc.connectionState; D('pc', login + ' ' + st);
    if (st === 'connected') {
      p.connected = true; p.lost = 0; clearTimeout(p.rt); p.rt = null;
      if (!call.t0) { call.t0 = Date.now(); startTimer(); }
      if (call.route) setRoute(call.route); // разговор соединился — ещё раз выбираем динамик (Android/iPhone могли перебить)
      send({ type: 'media', id: call.id, video: localVideoOn() });
      applySenderParams(p);
    } else if (st === 'disconnected' || st === 'failed') {
      // связь пропала (смена сети, туннель, лифт) — восстанавливаем, а не завершаем звонок
      p.connected = false; p.lost ||= Date.now();
      scheduleRestart(p, st === 'failed' ? 0 : 2500);
    }
    layout();
  };
  call.peers.set(K(login), p);
  return p;
}
// ---------- восстановление соединения (ICE restart) ----------
const RECOVER_MS = 60_000; // столько пытаемся восстановить связь, прежде чем завершить звонок
function scheduleRestart(p, delay) {
  if (p.rt) return;
  p.rt = setTimeout(() => {
    p.rt = null;
    if (!call || getPeer(p.login) !== p || p.pc.connectionState === 'connected') return;
    if (Date.now() - p.lost > RECOVER_MS) {
      toast(`Связь с ${dn(p.login)} потеряна`, 3500); closePeer(p.login);
      if (!call.peers.size && !call.pending.size) endCall(true);
      return;
    }
    restartIce(p);
    scheduleRestart(p, 8000); // повторяем, пока не соединимся
  }, delay);
}
// Новое предложение делает одна сторона (у кого логин «меньше»), вторая просит её об этом — так предложения не сталкиваются
async function restartIce(p) {
  if (!call || getPeer(p.login) !== p) return;
  if (!ws || ws.readyState !== 1) return; // сигнальное соединение вернётся — повторим в ws.onopen
  if (K(me) > K(p.login)) return send({ type: 'reneg', id: call.id, to: p.login });
  try {
    if (p.pc.signalingState === 'have-local-offer') await p.pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
    if (p.pc.signalingState !== 'stable') return;
    await setLocal(p.pc, await p.pc.createOffer({ iceRestart: true }));
    send({ type: 'offer', id: call.id, to: p.login, sdp: p.pc.localDescription });
  } catch (e) { console.warn('ice restart', e); }
}
function closePeer(login) {
  const p = getPeer(login); if (!p) return;
  clearTimeout(p.rt);
  try { p.pc.close(); } catch {}
  p.tile.remove(); call.peers.delete(K(login)); layout();
}
const localVideoOn = () => !!(call && call.stream && call.stream.getVideoTracks().some((t) => t.readyState === 'live' && t.enabled));

// Инициатор (новый участник) создаёт предложение каждому
async function offerTo(login) {
  const p = newPeer(login), s = call.stream;
  p.at = p.pc.addTransceiver(s.getAudioTracks()[0], { direction: 'sendrecv', streams: [s] });
  p.vt = p.pc.addTransceiver(s.getVideoTracks()[0] || 'video', { direction: 'sendrecv', streams: [s] });
  preferCodecs(p.pc);
  await setLocal(p.pc, await p.pc.createOffer());
  send({ type: 'offer', id: call.id, to: login, sdp: p.pc.localDescription });
}
async function answerFrom(login, sdp) {
  const p = getPeer(login) || newPeer(login), s = call.stream;
  await p.pc.setRemoteDescription(sdp);
  for (const t of p.pc.getTransceivers()) {
    const kind = t.receiver.track.kind; t.direction = 'sendrecv';
    const tr = kind === 'audio' ? s.getAudioTracks()[0] : s.getVideoTracks()[0] || null;
    await t.sender.replaceTrack(tr); try { t.sender.setStreams && t.sender.setStreams(s); } catch {}
    if (kind === 'audio') p.at = t; else p.vt = t;
  }
  preferCodecs(p.pc);
  await setLocal(p.pc, await p.pc.createAnswer());
  send({ type: 'answer', id: call.id, to: login, sdp: p.pc.localDescription });
  flushIce(p);
}
function flushIce(p) { p.ice.forEach((c) => p.pc.addIceCandidate(c).catch(() => {})); p.ice = []; }

async function applySenderParams(only) {
  if (!call) return;
  const group = call.peers.size > 1, q = Q[call.q];
  const vbr = group ? Math.min(q.br, 1_000_000) : q.br; // в группе экономим исходящий канал: видео до 540p
  for (const p of only ? [only] : call.peers.values()) for (const sd of p.pc.getSenders()) {
    if (!sd.track) continue;
    const prm = sd.getParameters(); if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}];
    if (sd.track.kind === 'audio') { prm.encodings[0].maxBitrate = AUDIO_BR; prm.encodings[0].priority = 'high'; prm.encodings[0].networkPriority = 'high'; }
    else {
      const h = (sd.track.getSettings && sd.track.getSettings().height) || q.h;
      prm.encodings[0].maxBitrate = vbr; prm.encodings[0].maxFramerate = q.fps;
      prm.encodings[0].scaleResolutionDownBy = group ? Math.max(1, h / 540) : 1;
      prm.degradationPreference = 'maintain-framerate';
    }
    // Safari может отклонить degradationPreference целиком — тогда применяем хотя бы битрейт и частоту кадров
    try { await sd.setParameters(prm); } catch { try { delete prm.degradationPreference; await sd.setParameters(prm); } catch {} }
  }
}

// ---------- раскладка экрана ----------
function layout() {
  if (!call) return;
  const peers = [...call.peers.values()], n = peers.length + call.pending.size;
  for (const p of peers) {
    const vt = p.vEl.srcObject && p.vEl.srcObject.getVideoTracks()[0];
    const on = p.video && vt && !vt.muted;
    p.tile.classList.toggle('v', !!on);
    p.tile.classList.toggle('wait', !p.connected);
  }
  const anyV = peers.some((p) => p.tile.classList.contains('v'));
  $('grid').dataset.n = Math.min(n, 4);
  const c = $('call');
  c.classList.toggle('multi', n >= 2);
  c.classList.toggle('one-v', n === 1 && anyV);
  c.classList.toggle('connected', peers.some((p) => p.connected));
  c.classList.toggle('video-on', anyV);
  const lv = localVideoOn();
  $('local').style.display = lv ? 'block' : 'none';
  $('bCam').classList.toggle('off', !lv);
  $('bFlip').style.display = lv ? '' : 'none';
  $('bQuality').style.display = lv || anyV ? '' : 'none';
  $('bAdd').style.display = call.dir === 'ring' ? 'none' : '';
  // кнопки прячутся только в видеозвонке; в аудиозвонке всегда на месте
  call.videoMode = (anyV || lv) && call.dir !== 'ring';
  if (!call.videoMode) showControls(false); else if (!call.uiTimer && !c.classList.contains('hide-ui')) scheduleHideUI();
  if (n <= 1) {
    const who = peers[0] ? peers[0].login : [...call.pending.values()][0]?.dataset.name || call.title;
    $('callName').textContent = dn(who); avatar($('callAva'), who);
  }
}

// ---------- кнопки звонка: нажатие по экрану прячет/показывает, в видео — прячутся сами через 5 с ----------
function scheduleHideUI() {
  clearTimeout(call && call.uiTimer);
  if (!call || !call.videoMode) return;
  call.uiTimer = setTimeout(() => { if (call && call.videoMode && !$('qMenu').classList.contains('on') && !$('addSheet').classList.contains('on')) $('call').classList.add('hide-ui'); if (call) call.uiTimer = null; }, 5000);
}
function showControls(autoHide) { $('call').classList.remove('hide-ui'); if (autoHide) scheduleHideUI(); else if (call) { clearTimeout(call.uiTimer); call.uiTimer = null; } }
$('call').addEventListener('click', (e) => {
  if (!call || !call.videoMode) return;
  if (e.target.closest('.ctrl,.ctop,.qmenu,.sheet,#local,button')) { scheduleHideUI(); return; }
  if ($('call').classList.contains('hide-ui')) showControls(true);
  else { clearTimeout(call.uiTimer); call.uiTimer = null; $('call').classList.add('hide-ui'); }
});
function setBars(dark) { try { AND && AND.setBars && AND.setBars(!!dark); } catch {} }

function showCallScreen(state) {
  setBars(true);
  const c = $('call'); c.classList.add('on');
  $('ctrlIn').classList.toggle('on', state === 'incoming');
  $('ctrlOn').classList.toggle('on', state !== 'incoming');
  $('bSpeaker').style.display = canRoute ? '' : 'none';
}

// Android: на время звонка служба получает права «микрофон/камера в фоне» — звонок не прерывается,
// когда вы переключаетесь на другое приложение (Яндекс Карты и т.п.)
function nativeCall(on) {
  if (AND && AND.callState) try { AND.callState(!!on, !!on && localVideoOn(), (on && call && call.id) || ''); } catch {}
}
async function getMedia(video) {
  return navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: video ? camConstraints(call.q, call.facing) : false });
}
function newCall(o) {
  qPrev.clear(); $('call').classList.remove('hide-ui');
  call = Object.assign({ peers: new Map(), pending: new Map(), q: localStorage.getItem('hx_q') || 'hd', facing: 'user', route: 'earpiece' }, o);
  $('grid').innerHTML = ''; $('cTimer').textContent = ''; $('qBadge').textContent = '';
  $('call').classList.remove('video-on', 'connected', 'multi', 'one-v');
  $('bMute').classList.remove('off'); $('bQuality').textContent = Q[call.q].label;
}
function pendingTile(login) {
  if (call.pending.has(K(login)) || getPeer(login)) return;
  const t = peerTile(login); t.classList.add('pend'); t.dataset.name = login; call.pending.set(K(login), t); layout();
}
function dropPending(login) { const t = call && call.pending.get(K(login)); if (t) { t.remove(); call.pending.delete(K(login)); layout(); } }

async function startCall(peer, video) {
  D('call-start', peer + (video ? ' video' : ' audio'));
  if (call) return;
  newCall({ dir: 'out', title: peer, video0: video });
  pendingTile(peer);
  $('callState').textContent = 'Вызов…'; showCallScreen('outgoing'); layout();
  audioSessionCall();
  try {
    call.stream = await getMedia(video);
    showLocal(); setRoute(video ? 'speaker' : 'earpiece'); nativeCall(true);
    send({ type: 'invite', to: peer, video });
  } catch (e) { D('call-out-err', errText(e)); toast('Нет доступа к микрофону/камере'); endCall(false); }
}
function showLocal() { $('local').srcObject = call.stream; layout(); }

let timer;
function startTimer() {
  clearInterval(timer);
  timer = setInterval(() => {
    if (!call || !call.t0) return;
    const s = Math.floor((Date.now() - call.t0) / 1000), t = `${Math.floor(s / 60)}:${pad(s % 60)}`;
    const lost = [...call.peers.values()].some((p) => p.lost);
    $('cTimer').textContent = lost ? 'Переподключение…' : t; if (call.peers.size <= 1) $('callState').textContent = lost ? 'Переподключение…' : t;
    if (s % 3 === 0) updateQBadge();
    if (s % 15 === 0) logQuality();
  }, 1000);
}

async function onSignal(m) {
  if (m.type !== 'ice') D('sig', m.type + (m.reason ? ' ' + m.reason : '') + (m.from ? ' от ' + m.from : ''));
  switch (m.type) {
    case 'invite': {
      if (call) { if (call.id !== m.id) send({ type: 'reject', id: m.id, reason: 'busy' }); return; }
      const others = (m.members || []).filter((x) => K(x) !== K(m.from));
      newCall({ id: m.id, dir: 'ring', title: m.from, offerVideo: m.video });
      remember({ login: m.from, num: m.fromNum });
      $('callName').textContent = dn(m.from); avatar($('callAva'), m.from);
      $('callState').textContent = others.length ? `Групповой звонок · ещё ${others.map(dn).join(', ')}` : (m.video ? 'Видеозвонок Ahazang…' : 'Аудиозвонок Ahazang…');
      $('wrapAcceptV').style.display = m.video ? '' : 'none';
      showCallScreen('incoming'); layout();
      if (autoAnswer && autoAnswer.id === m.id) { const v = autoAnswer.video; autoAnswer = null; accept(v && m.video); }
      else ring(true);
      return;
    }
    case 'calling': if (call && !call.id) { call.id = m.id; $('callState').textContent = 'Гудки…'; nativeCall(true); } return;
    case 'error': toast(m.text, 3500); if (call && !call.id) endCall(false); return;
  }
  if (!call || call.id !== m.id) return;
  switch (m.type) {
    case 'room': // мы вошли: соединяемся со всеми, кто уже в звонке
      $('callState').textContent = 'Соединение…';
      for (const l of m.members) offerTo(l).catch((e) => D('offer-err', errText(e)));
      layout(); break;
    case 'ringing': pendingTile(m.login); break;
    case 'joined': dropPending(m.login); if (!getPeer(m.login)) { pendingTile(m.login); call.pending.get(K(m.login)).classList.add('joining'); } $('callState').textContent = 'Соединение…'; break;
    case 'offer': await answerFrom(m.from, m.sdp).catch((e) => D('answer-err', errText(e))); break;
    case 'answer': { const p = getPeer(m.from); if (p && p.pc.signalingState === 'have-local-offer') { await p.pc.setRemoteDescription(m.sdp).catch((e) => console.warn(e)); flushIce(p); } break; }
    case 'reneg': { const p = getPeer(m.from); if (p) { p.lost ||= Date.now(); restartIce(p); } break; }
    case 'ice': { const p = getPeer(m.from); if (!p) return; if (p.pc.remoteDescription) p.pc.addIceCandidate(m.candidate).catch(() => {}); else p.ice.push(m.candidate); break; }
    case 'media': {
      const p = getPeer(m.from); if (p) { p.video = !!m.video; layout(); }
      // собеседник включил видео — переходим на громкую связь (если вы сами не переключали)
      if (m.video && !call.routeManual && call.route !== 'speaker') setRoute('speaker');
      break;
    }
    case 'quality': setQuality(m.q, m.from); break;
    case 'declined': dropPending(m.login); toast(m.reason === 'busy' ? `${dn(m.login)}: занято` : `${dn(m.login)} отклонил(а) звонок`); break;
    case 'noanswer': dropPending(m.login); toast(`${dn(m.login)} не отвечает`); break;
    case 'left': closePeer(m.login); dropPending(m.login); if (call.peers.size) toast(`${dn(m.login)} вышел(а) из звонка`); break;
    case 'hangup': {
      const r = m.reason;
      if (call.dir === 'ring' && r !== 'elsewhere') call.dir = 'missed';
      $('callState').textContent = { busy: 'Занято', rejected: 'Отклонено', noanswer: 'Нет ответа', elsewhere: 'Отвечено на другом устройстве', gone: 'Звонок уже завершён' }[r] || 'Звонок завершён';
      $('call').classList.remove('connected', 'video-on', 'multi', 'one-v');
      endCall(false, 1300, r === 'elsewhere');
      break;
    }
  }
}

async function accept(video) {
  D('accept', video ? 'video' : 'audio');
  ring(false);
  audioSessionCall();
  try {
    call.dir = 'in';
    call.stream = await getMedia(video); showLocal();
    setRoute(video || call.offerVideo ? 'speaker' : 'earpiece'); nativeCall(true);
    $('callState').textContent = 'Соединение…'; showCallScreen('active');
    send({ type: 'accept', id: call.id });
  } catch (e) { D('call-in-err', errText(e)); toast('Нет доступа к микрофону/камере'); send({ type: 'reject', id: call.id }); endCall(false); }
}
$('bAcceptA').onclick = () => accept(false);
$('bAcceptV').onclick = () => accept(true);
$('bDecline').onclick = () => { send({ type: 'reject', id: call.id }); call.dir = 'declined'; endCall(false); };
$('bHang').onclick = () => endCall(true);

function endCall(notify, delay = 0, noLog) {
  ring(false); clearInterval(timer);
  if (!call) return;
  if (notify && call.id) send({ type: 'hangup', id: call.id });
  const c = call; call = null;
  const names = [...c.peers.values()].map((p) => p.login);
  if (!noLog && c.dir !== 'declined') logCall({ peer: names.length ? names.join(', ') : c.title, video: !!(c.video0 || c.offerVideo), dir: c.dir === 'ring' ? 'missed' : c.dir, ts: Date.now(), dur: c.t0 ? Math.round((Date.now() - c.t0) / 1000) : 0, group: names.length > 1 });
  for (const p of c.peers.values()) { clearTimeout(p.rt); try { p.pc.close(); } catch {} }
  c.stream && c.stream.getTracks().forEach((t) => t.stop());
  if (canRoute) try { AND.setAudioRoute('off'); } catch {}
  nativeCall(false);
  audioSessionOff();
  setTimeout(() => {
    if (call) return;
    $('call').classList.remove('on', 'video-on', 'connected', 'multi', 'one-v', 'hide-ui'); setBars(false);
    $('qMenu').classList.remove('on'); $('addSheet').classList.remove('on'); $('grid').innerHTML = '';
    renderCalls();
    if (reloadAfterCall) hardReload();
  }, delay);
}

// ---------- кнопки во время звонка ----------
$('bMute').onclick = () => { const t = call && call.stream.getAudioTracks()[0]; if (!t) return; t.enabled = !t.enabled; $('bMute').classList.toggle('off', !t.enabled); };

// Включить / выключить камеру в любой момент разговора (без переподключения)
$('bCam').onclick = async () => {
  if (!call || !call.stream) return;
  const cur = call.stream.getVideoTracks()[0];
  if (cur) {
    cur.stop(); call.stream.removeTrack(cur);
    for (const p of call.peers.values()) p.vt && p.vt.sender.replaceTrack(null).catch(() => {});
  } else {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: camConstraints(call.q, call.facing) });
      const t = s.getVideoTracks()[0]; t.contentHint = 'motion'; call.stream.addTrack(t);
      for (const p of call.peers.values()) if (p.vt) { await p.vt.sender.replaceTrack(t).catch(() => {}); p.vt.direction = 'sendrecv'; }
      applySenderParams();
      if (!call.routeManual && call.route !== 'speaker') setRoute('speaker');
    } catch { return toast('Нет доступа к камере'); }
  }
  $('local').srcObject = call.stream; $('local').style.transform = call.facing === 'user' ? 'scaleX(-1)' : 'none';
  send({ type: 'media', id: call.id, video: localVideoOn() });
  nativeCall(true); layout();
};

$('bFlip').onclick = async () => {
  if (!call || !localVideoOn()) return;
  call.facing = call.facing === 'user' ? 'environment' : 'user';
  const old = call.stream.getVideoTracks()[0]; old && old.stop();
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { ...camConstraints(call.q, call.facing), facingMode: { exact: call.facing } } });
    const t = s.getVideoTracks()[0];
    call.stream.removeTrack(old); call.stream.addTrack(t);
    for (const p of call.peers.values()) p.vt && (await p.vt.sender.replaceTrack(t).catch(() => {}));
    $('local').srcObject = call.stream; $('local').style.transform = call.facing === 'user' ? 'scaleX(-1)' : 'none';
  } catch { toast('Не удалось переключить камеру'); }
};

async function setQuality(q, fromPeer) {
  if (!call || !Q[q]) return;
  call.q = q;
  const t = call.stream && call.stream.getVideoTracks()[0];
  if (t) try { await t.applyConstraints(camConstraints(q, call.facing)); } catch {}
  await applySenderParams();
  $('bQuality').textContent = Q[q].label;
  if (!fromPeer) send({ type: 'quality', id: call.id, q }); else toast(`${fromPeer} выбрал(а) качество ${Q[q].label}`);
  setTimeout(updateQBadge, 1500);
}
$('bQuality').onclick = (e) => {
  e.stopPropagation();
  document.querySelectorAll('#qMenu div').forEach((d) => d.classList.toggle('sel', d.dataset.q === call.q));
  $('qMenu').classList.toggle('on');
};
document.querySelectorAll('#qMenu div').forEach((d) => (d.onclick = () => { $('qMenu').classList.remove('on'); setQuality(d.dataset.q); }));
document.addEventListener('click', (e) => { if (!e.target.closest('#qMenu,#bQuality')) $('qMenu').classList.remove('on'); });

// Добавить участника (конференция до 5 человек)
$('bAdd').onclick = async () => {
  if (!call || !call.id) return;
  await loadUsers();
  const inCall = new Set([...call.peers.keys(), ...call.pending.keys()]);
  const free = users.filter((u) => !inCall.has(K(u.login)));
  const L = $('addList'); L.innerHTML = '';
  if (call.peers.size + call.pending.size + 1 >= MAX_CALL) L.innerHTML = '<div class="empty-list">В звонке уже 5 человек — это максимум</div>';
  else if (!free.length) L.innerHTML = '<div class="empty-list">Все ваши контакты уже в звонке</div>';
  else free.forEach((u) => {
    const k = K(u.login), d = document.createElement('div'); d.className = 'row';
    d.innerHTML = `${avaHTML(u.login, online.has(k))}<div class="body"><div class="top"><b>${esc(dn(u.login))}</b></div><div class="sub"><span class="${online.has(k) ? 'on' : ''}">${esc(fmtSeen(k))}</span></div></div><div class="act"><button class="pill ok">Позвать</button></div>`;
    d.onclick = () => { send({ type: 'invite', id: call.id, to: u.login, video: localVideoOn() }); $('addSheet').classList.remove('on'); toast('Вызываем ' + dn(u.login) + '…'); };
    L.appendChild(d);
  });
  $('addSheet').classList.add('on');
};
$('bAddClose').onclick = () => $('addSheet').classList.remove('on');

// Замер качества для журнала сервера: потери и рывки звука, задержка, путь (напрямую или через сервер)
const qPrev = new Map();
async function logQuality() {
  if (!call) return;
  for (const p of call.peers.values()) {
    try {
      const st = await p.pc.getStats(); let pair = null, aIn = null, vOut = null, vIn = null, mic = null;
      st.forEach((r) => {
        if (r.type === 'transport' && r.selectedCandidatePairId) pair = st.get(r.selectedCandidatePairId);
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && !pair) pair = r;
        if (r.type === 'inbound-rtp' && r.kind === 'audio') aIn = r;
        if (r.type === 'inbound-rtp' && r.kind === 'video') vIn = r;
        if (r.type === 'outbound-rtp' && r.kind === 'video') vOut = r;
        if (r.type === 'media-source' && r.kind === 'audio') mic = r;
      });
      const lc = pair && st.get(pair.localCandidateId), rc = pair && st.get(pair.remoteCandidateId);
      const prev = qPrev.get(p.login) || {}, rec = aIn ? aIn.packetsReceived : 0, lost = aIn ? aIn.packetsLost : 0;
      const dRec = rec - (prev.rec || 0), dLost = lost - (prev.lost || 0);
      qPrev.set(p.login, { rec, lost });
      const path = lc && rc ? (lc.candidateType === 'relay' || rc.candidateType === 'relay' ? 'через сервер' : 'напрямую') + '/' + (lc.relayProtocol || lc.protocol || '') : '?';
      D('quality', [p.login, path,
        'rtt ' + (pair && pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) + 'мс' : '?'),
        'звук: потери ' + (dRec + dLost > 0 ? (dLost / (dRec + dLost) * 100).toFixed(1) : '0') + '%, джиттер ' + (aIn && aIn.jitter != null ? Math.round(aIn.jitter * 1000) + 'мс' : '?'),
        'уровень: микрофон ' + (mic && mic.audioLevel != null ? mic.audioLevel.toFixed(3) : '?') + ', от собеседника ' + (aIn && aIn.audioLevel != null ? aIn.audioLevel.toFixed(3) : '?') + ', маршрут ' + (call.route || '?'),
        vIn && vIn.frameHeight ? 'видео приём ' + vIn.frameHeight + 'p ' + Math.round(vIn.framesPerSecond || 0) + 'к/с' : '',
        vOut && vOut.frameHeight ? 'видео отправка ' + vOut.frameHeight + 'p' : '',
        pair && pair.availableOutgoingBitrate ? 'канал ' + Math.round(pair.availableOutgoingBitrate / 1000) + 'кбит/с' : ''].filter(Boolean).join(' · '));
    } catch {}
  }
}
async function updateQBadge() {
  const p = call && [...call.peers.values()][0]; if (!p) return;
  let v = '', rtt = '', codec = '';
  try {
    const st = await p.pc.getStats();
    st.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video' && r.frameHeight && p.video) {
        v = `${r.frameHeight}p`;
        const c = r.codecId && st.get(r.codecId); if (c && c.mimeType) codec = c.mimeType.split('/')[1].toUpperCase();
      }
      if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime != null) rtt = `${Math.round(r.currentRoundTripTime * 1000)} мс`;
    });
  } catch {}
  $('qBadge').textContent = [v, codec, rtt].filter(Boolean).join(' · ');
}

function clearCallNotes() {
  navigator.serviceWorker && navigator.serviceWorker.ready.then((r) => r.getNotifications().then((ns) => ns.forEach((n) => n.data && n.data.kind === 'call' && n.close()))).catch(() => {});
}
// Рингтон входящего. В Android-приложении, пока оно свёрнуто, звонит только система (уведомление о звонке):
// страница в фоне может не успеть получить «звонок окончен», и её рингтон играл бы дальше.
// Когда приложение на экране — звонит страница, а системный рингтон этого вызова выключается.
let ringTimer;
function ring(on) {
  clearCallNotes(); clearTimeout(ringTimer);
  const a = $('ring');
  if (on && AND && document.hidden) { a.pause(); return; }
  // iPhone с CallKit: звонит системный экран звонка, страница молчит (иначе два рингтона)
  if (on && isIOSApp && serverVoip && voipToken) { a.pause(); return; }
  if (on) {
    a.currentTime = 0; a.play().catch(() => {}); navigator.vibrate && navigator.vibrate([800, 400, 800, 400, 800, 400, 800, 400, 800]);
    try { AND && AND.pageRinging && call && call.id && AND.pageRinging(call.id); } catch {}
    ringTimer = setTimeout(() => ring(false), 60000); // подстраховка: дольше минуты не звоним
  } else { a.pause(); navigator.vibrate && navigator.vibrate(0); }
}

// ---------- версии, обновления, «Что нового» ----------
const REPO = 'Arthuralend/Heraxos';
const APK_URL = `https://github.com/${REPO}/releases/latest/download/Ahazang.apk`;
const WHATS_NEW = [
  'У каждого теперь есть номер — смотрите его в «Настройках». Войти можно по логину или по номеру',
  'Контакты как в телефоне: добавьте человека по номеру и сохраните под своим именем — подтверждение не нужно',
  'Написать и позвонить можно по любому номеру; ненужный контакт можно удалить или заблокировать',
  'Свой 6-значный номер можно выбрать самому, если он свободен: «Настройки» → «Мой номер»',
  'Ваши прежние контакты перенесены и сохранены под их логинами — имена можно поменять',
];
const androidVersion = () => { try { return AND && AND.appVersion ? +AND.appVersion() || 0 : 0; } catch { return 0; } };
function infoSheet(title, html, actions) {
  $('infoTitle').textContent = title; $('infoBody').innerHTML = html;
  const A = $('infoActs'); A.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement(a.href ? 'a' : 'button');
    b.className = 'btn' + (a.danger ? ' danger' : a.primary ? '' : ' ghost'); b.textContent = a.label;
    if (a.href) { b.href = a.href; b.target = '_blank'; b.rel = 'noopener'; }
    b.onclick = () => { $('info').classList.remove('on'); a.on && a.on(); };
    A.appendChild(b);
  }
  $('info').classList.add('on');
}
$('info').onclick = (e) => { if (e.target === $('info')) $('info').classList.remove('on'); };
const listHTML = (items) => '<ul class="notes">' + items.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>';
function showWhatsNew() { infoSheet(`Что нового в Ahazang ${APP_VERSION}`, listHTML(WHATS_NEW), [{ label: 'Понятно', primary: true }]); }
function whatsNewOnce() {
  const seen = localStorage.getItem('hx_seen_ver');
  localStorage.setItem('hx_seen_ver', APP_VERSION);
  if (seen !== APP_VERSION && wasLoggedIn) setTimeout(showWhatsNew, 600);
}
$('bWhatsNew').onclick = showWhatsNew;
function showVersionInfo() {
  const av = androidVersion();
  $('verLine').textContent = `Ahazang · веб-версия ${APP_VERSION}` + (av ? ` · Android 1.0.${av}` : '');
}
// Android-приложение: проверяем выпуск на GitHub (раз в 6 часов) и показываем, что изменилось
function releaseNotes(body) {
  const text = String(body || '').split(/\n-{3,}\s*\n/)[0];
  return text.split('\n').map((l) => l.replace(/\*\*/g, '').trim()).filter((l) => /^[-*•]\s+/.test(l)).map((l) => l.replace(/^[-*•]\s+/, ''));
}
async function checkAppUpdate(manual) {
  const av = androidVersion(); if (!av) return;
  $('updRow').style.display = '';
  let rel = null;
  try { rel = JSON.parse(localStorage.getItem('hx_rel') || 'null'); } catch {}
  if (manual || !rel || Date.now() - (rel.at || 0) > 6 * 3600e3) {
    if (manual) $('updState').textContent = 'Проверяем…';
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
      const j = await r.json();
      const n = +((String(j.tag_name || '').match(/(\d+)$/) || [])[1] || 0);
      if (n) { rel = { n, notes: releaseNotes(j.body), at: Date.now() }; localStorage.setItem('hx_rel', JSON.stringify(rel)); }
    } catch {}
  }
  const has = rel && rel.n > av;
  $('updState').textContent = has ? `Доступна версия 1.0.${rel.n} — нажмите, чтобы посмотреть` : rel ? `У вас последняя версия (1.0.${av})` : 'Не удалось проверить — нет связи с GitHub';
  $('updRow').classList.toggle('hot', !!has);
  $('setBadge').style.display = has ? 'block' : 'none';
  const offer = () => infoSheet(`Доступна версия 1.0.${rel.n}`,
    (rel.notes.length ? '<p class="mute">Что изменилось:</p>' + listHTML(rel.notes) : '<p class="mute">Новая версия приложения Ahazang.</p>') +
    `<p class="mute small">У вас 1.0.${av}. Скачайте файл и откройте его — данные и вход сохранятся.</p>`,
    [{ label: 'Скачать обновление', primary: true, href: APK_URL }, { label: 'Позже' }]);
  $('updRow').onclick = () => (has ? offer() : checkAppUpdate(true));
  if (has && localStorage.getItem('hx_upd_shown') !== String(rel.n) && !call) { localStorage.setItem('hx_upd_shown', String(rel.n)); setTimeout(offer, 1500); }
}

// ---------- старт ----------
if (token && me) start(); else $('auth').classList.add('on');
