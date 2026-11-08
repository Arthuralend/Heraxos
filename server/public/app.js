// Heraxos — клиент
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let token = localStorage.getItem('hx_token'), me = localStorage.getItem('hx_me');
let ws, iceServers = [], users = [], chats = [], cur = null, call = null;
const peerKeys = new Map(), online = new Set(), lastSeen = new Map();
// Android-приложение Heraxos (WebView) даёт мост window.HeraxosAndroid
const AND = window.HeraxosAndroid || null;
if (/Android/i.test(navigator.userAgent) && !AND) document.documentElement.classList.add('is-android');
const _qs = new URLSearchParams(location.search);
let autoAnswer = _qs.get('answer') ? { id: _qs.get('call'), video: _qs.get('answer') === 'video' } : null;
window.hxAnswer = (id, video) => { if (call && call.id === id && call.dir === 'in' && !call.pc) accept(!!video); else autoAnswer = { id, video: !!video }; };
window.hxBack = () => { if (call) return true; if ($('qMenu').classList.contains('on')) { $('qMenu').classList.remove('on'); return true; } if (cur && !matchMedia('(min-width:800px)').matches) { closeChat(); return true; } return false; };

// ---------- утилиты ----------
const COLORS = ['#e57373', '#f06292', '#ba68c8', '#9575cd', '#7986cb', '#4fc3f7', '#4db6ac', '#81c784', '#ffb74d', '#a1887f', '#90a4ae', '#d81e1e'];
function avatar(el, login, isOnline) {
  let h = 0; for (const c of login) h = (h * 31 + c.charCodeAt(0)) | 0;
  el.style.background = COLORS[Math.abs(h) % COLORS.length];
  el.innerHTML = esc(login[0].toUpperCase()) + (isOnline ? '<i></i>' : '');
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
  $('aerr').textContent = '';
  if (!login || !password) return ($('aerr').textContent = 'Введите логин и пароль');
  if (reg && password !== $('rPass2').value) return ($('aerr').textContent = 'Пароли не совпадают');
  const btn = reg ? $('bReg') : $('bLogin'); btn.disabled = true;
  $('aerr').textContent = reg ? 'Создаём ключи шифрования…' : 'Вход…';
  try {
    const j = await api('/api/' + kind, { login, password });
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
  if (!silent) api('/api/logout', {}).catch(() => {});
  if (me) localStorage.removeItem('hx_k_' + me);
  if (AND) try { AND.clearSession(); } catch {}
  localStorage.removeItem('hx_token'); token = null; ws && ws.close(); ws = null;
  $('app').classList.remove('on'); $('auth').classList.add('on');
}
$('bOut').onclick = () => confirm('Выйти из Heraxos на этом устройстве?') && logout();

// ---------- запуск ----------
async function start() {
  const local = localStorage.getItem('hx_k_' + me);
  if (!local) return logout(true);
  await HX.load(local);
  if (AND) try { AND.setSession(token, me); } catch {}
  $('auth').classList.remove('on'); $('app').classList.add('on');
  $('meName').textContent = me; avatar($('meAva'), me);
  $('defQuality').value = localStorage.getItem('hx_q') || 'medium';
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
    navigator.serviceWorker.addEventListener('message', (e) => e.data && e.data.open && openChat(e.data.open));
  }
  iceServers = await api('/api/ice').catch(() => []);
  connect(); await Promise.all([loadUsers(), loadChats()]); renderCalls(); setInterval(loadUsers, 30000);
  pushState();
  const q = _qs.get('chat');
  if (location.search) history.replaceState(null, '', '/');
  if (q) openChat(q);
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
function connect() {
  if (!token) return;
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?token=' + token);
  ws.onopen = () => { $('connState').textContent = 'в сети'; };
  ws.onclose = (e) => { $('connState').textContent = 'нет соединения…'; if (e.code === 4001) return logout(true); if (token) setTimeout(connect, 2000); };
  ws.onmessage = (e) => onWS(JSON.parse(e.data));
}
const send = (m) => { if (!ws || ws.readyState !== 1) return false; ws.send(JSON.stringify(m)); return true; };
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !token) return;
  if (!ws || ws.readyState > 1) connect();
  loadChats(); if (cur) markRead();
});

async function onWS(m) {
  switch (m.type) {
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
      if (m.request) toast(m.request + ' хочет добавить вас в контакты', 4000);
      if (m.accepted) toast(m.accepted + ' принял(а) вашу заявку', 4000);
      loadUsers(); loadChats();
      if (cur && !users.some((u) => u.login.toLowerCase() === cur.peer.toLowerCase())) setTimeout(() => cur && !users.some((u) => u.login.toLowerCase() === cur.peer.toLowerCase()) && closeChat(), 800);
      return;
    default: return onSignal(m);
  }
}

// ---------- контакты (по взаимному согласию) ----------
let requests = [], sentReq = [];
async function loadUsers() {
  try {
    const j = await api('/api/contacts');
    users = j.contacts; requests = j.requests; sentReq = j.sent;
    users.forEach((u) => { const k = u.login.toLowerCase(); u.online ? online.add(k) : online.delete(k); if (u.lastSeen) lastSeen.set(k, u.lastSeen); });
    const rb = $('reqBadge'); rb.textContent = requests.length; rb.style.display = requests.length ? 'block' : 'none';
    renderUsers(); renderChats();
  } catch {}
}
function contactRow(login, actions) {
  const k = login.toLowerCase(), d = document.createElement('div'); d.className = 'row';
  d.innerHTML = `${avaHTML(login, online.has(k))}<div class="body"><div class="top"><b>${esc(login)}</b></div><div class="sub"><span></span></div></div><div class="act">${actions}</div>`;
  return d;
}
function renderUsers() {
  const L = $('userList'); L.innerHTML = '';
  if (requests.length) {
    L.insertAdjacentHTML('beforeend', `<div class="section">Заявки в контакты · ${requests.length}</div>`);
    requests.forEach((r) => {
      const d = contactRow(r, '<button class="pill ok" data-a="acc">Принять</button><button class="pill" data-a="dec">✕</button>');
      d.querySelector('.sub span').textContent = 'хочет добавить вас';
      d.onclick = async (e) => {
        const a = e.target.closest('[data-a]'); if (!a) return;
        await api('/api/contacts/' + (a.dataset.a === 'acc' ? 'accept' : 'decline'), { login: r }).catch((x) => toast(x.message));
        if (a.dataset.a === 'acc') toast(r + ' теперь в ваших контактах'); loadUsers(); loadChats();
      };
      L.appendChild(d);
    });
  }
  if (sentReq.length) {
    L.insertAdjacentHTML('beforeend', `<div class="section">Ожидают подтверждения</div>`);
    sentReq.forEach((r) => {
      const d = contactRow(r, '<button class="pill" data-a="cancel">Отменить</button>');
      d.querySelector('.sub span').textContent = 'заявка отправлена';
      d.onclick = async (e) => { if (!e.target.closest('[data-a]')) return; await api('/api/contacts/cancel', { login: r }).catch(() => {}); loadUsers(); };
      L.appendChild(d);
    });
  }
  L.insertAdjacentHTML('beforeend', `<div class="section">Мои контакты${users.length ? ' · ' + users.length : ''}</div>`);
  if (!users.length) L.insertAdjacentHTML('beforeend', '<div class="empty-list">Контактов пока нет.<br>Введите точный логин человека выше и нажмите «Добавить». Когда он примет заявку, вы сможете переписываться и звонить.</div>');
  users.forEach((u) => {
    const k = u.login.toLowerCase();
    const d = contactRow(u.login, '<button class="iconbtn" data-a="v"><svg><use href="#i-video"/></svg></button><button class="iconbtn" data-a="a"><svg><use href="#i-phone"/></svg></button><button class="iconbtn dim" data-a="x" title="Удалить из контактов">⋯</button>');
    const st = d.querySelector('.sub span'); st.textContent = fmtSeen(k); if (online.has(k)) st.className = 'on';
    d.onclick = async (e) => {
      const a = e.target.closest('[data-a]'); if (!a) return openChat(u.login);
      e.stopPropagation();
      if (a.dataset.a === 'x') { if (confirm(`Удалить ${u.login} из контактов? Переписка и звонки станут недоступны, пока вы снова не добавите друг друга.`)) { await api('/api/contacts/' + encodeURIComponent(k), null, 'DELETE').catch(() => {}); if (cur && cur.peer.toLowerCase() === k) closeChat(); loadUsers(); loadChats(); } return; }
      startCall(u.login, a.dataset.a === 'v');
    };
    L.appendChild(d);
  });
}
$('fAdd').onsubmit = async (e) => {
  e.preventDefault();
  const login = $('addLogin').value.trim(); if (!login) return;
  try {
    const r = await api('/api/contacts/add', { login });
    $('addLogin').value = '';
    toast(r.status === 'contact' ? login + ' добавлен в контакты' : 'Заявка отправлена. ' + login + ' появится в контактах после подтверждения', 3500);
    loadUsers(); loadChats();
  } catch (x) { toast(x.message); }
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
    for (const c of chats) { c.preview = await decryptMsg(c.peer, c.last); const k = c.peer.toLowerCase(); c.online ? online.add(k) : online.delete(k); }
    renderChats();
  } catch {}
}
function renderChats() {
  const q = $('qChats').value.trim().toLowerCase(), L = $('chatList');
  let total = 0; L.innerHTML = '';
  if (!AND && (window.Notification && Notification.permission === 'default' || (isIOS && !standalone))) {
    const b = document.createElement('div'); b.className = 'e2e-note'; b.style.margin = '6px 16px 8px'; b.style.cursor = 'pointer';
    b.innerHTML = isIOS && !standalone ? '📲 Добавьте Heraxos на экран «Домой» (Поделиться → На экран «Домой»), чтобы получать звонки и сообщения' : '🔔 Нажмите, чтобы включить уведомления о звонках и сообщениях';
    b.onclick = enablePush; L.appendChild(b);
  }
  const list = chats.filter((c) => c.peer.toLowerCase().includes(q));
  list.forEach((c) => {
    total += c.unread;
    const mine = c.last.f.toLowerCase() === me.toLowerCase();
    const tick = mine ? (c.last.ts <= c.peerRead ? TICK2 : TICK1) + ' ' : '';
    const prev = c.preview === null ? '🔒 Сообщение недоступно' : c.preview;
    const d = document.createElement('div'); d.className = 'row' + (cur && cur.peer === c.peer ? ' sel' : '');
    d.innerHTML = `${avaHTML(c.peer, online.has(c.peer.toLowerCase()))}<div class="body"><div class="top"><b>${esc(c.peer)}</b><time class="${c.unread ? 'unr' : ''}">${fmtList(c.last.ts)}</time></div>
      <div class="sub"><span>${tick}${esc(prev)}</span>${c.unread ? `<b class="badge">${c.unread}</b>` : ''}</div></div>`;
    d.onclick = () => openChat(c.peer); L.appendChild(d);
  });
  const withChat = new Set(chats.map((c) => c.peer.toLowerCase()));
  const rest = users.filter((u) => !withChat.has(u.login.toLowerCase()) && u.login.toLowerCase().includes(q))
    .sort((a, b) => online.has(b.login.toLowerCase()) - online.has(a.login.toLowerCase()) || a.login.localeCompare(b.login));
  if (rest.length) {
    L.insertAdjacentHTML('beforeend', `<div class="section">Контакты · ${rest.length}</div>`);
    rest.forEach((u) => {
      const k = u.login.toLowerCase(), d = document.createElement('div'); d.className = 'row';
      d.innerHTML = `${avaHTML(u.login, online.has(k))}<div class="body"><div class="top"><b>${esc(u.login)}</b></div><div class="sub"><span class="${online.has(k) ? 'on' : ''}">${esc(fmtSeen(k))}</span></div></div>
        <div class="act"><button class="iconbtn" data-a="v"><svg><use href="#i-video"/></svg></button><button class="iconbtn" data-a="a"><svg><use href="#i-phone"/></svg></button></div>`;
      d.onclick = (e) => { const a = e.target.closest('[data-a]'); if (a) { e.stopPropagation(); return startCall(u.login, a.dataset.a === 'v'); } openChat(u.login); };
      L.appendChild(d);
    });
  }
  if (!list.length && !rest.length) L.insertAdjacentHTML('beforeend', `<div class="empty-list">${q ? 'Никого не найдено' : 'Здесь появятся ваши контакты.<br>Добавьте человека по логину во вкладке «Контакты».'}</div>`);
  const ub = $('unreadBadge'); ub.textContent = total; ub.style.display = total ? 'block' : 'none';
  if (navigator.setAppBadge) total ? navigator.setAppBadge(total).catch(() => {}) : navigator.clearAppBadge().catch(() => {});
}
$('qChats').oninput = renderChats;

// ---------- переписка ----------
async function openChat(peer) {
  const u = users.find((x) => x.login.toLowerCase() === peer.toLowerCase());
  if (!u) { await loadUsers(); if (!users.some((x) => x.login.toLowerCase() === peer.toLowerCase())) return toast('Этот пользователь не в ваших контактах'); return openChat(peer); }
  peer = u.login;
  cur = { peer, msgs: [], peerRead: 0, pub: null };
  document.querySelector('#tabbar button[data-tab=chats]').click();
  $('chat').classList.add('has'); $('app').classList.add('in-chat');
  $('cPeer').textContent = peer; avatar($('cAva'), peer); updateHeadStatus();
  $('msgs').innerHTML = ''; renderChats();
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

function updateHeadStatus() { if (cur) $('cStatus').textContent = fmtSeen(cur.peer.toLowerCase()); }

function renderMsgs(scroll) {
  const box = $('msgs'), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  let html = '<div class="e2e-note">🔒 Сообщения защищены сквозным шифрованием. Никто, кроме вас и собеседника, включая администратора, не может их прочитать.</div>';
  let lastDay = '', lastF = '';
  for (const m of cur.msgs) {
    const day = fmtDay(m.ts); if (day !== lastDay) { html += `<div class="day"><span>${day}</span></div>`; lastDay = day; lastF = ''; }
    const mine = m.f.toLowerCase() === me.toLowerCase();
    const st = !mine ? '' : m.pending ? CLOCK : m.ts <= cur.peerRead ? TICK2 : TICK1;
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
  if (AND) { $('pushState').textContent = 'Звонки и сообщения приходят через приложение Heraxos'; return; }
  const s = !('PushManager' in window) ? (isIOS && !standalone ? 'Сначала добавьте на экран «Домой»' : 'Не поддерживается этим браузером')
    : Notification.permission === 'granted' ? 'Включены' : Notification.permission === 'denied' ? 'Запрещены в настройках браузера' : 'Нажмите, чтобы включить';
  $('pushState').textContent = s;
  if (window.Notification && Notification.permission === 'granted') subscribePush();
}
async function enablePush() {
  if (isIOS && !standalone) return toast('Нажмите «Поделиться» → «На экран Домой», затем откройте Heraxos со значка', 5000);
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
    const label = { out: 'Исходящий', in: 'Входящий', missed: 'Пропущенный' }[c.dir] + (c.video ? ' видеозвонок' : ' звонок');
    const d = document.createElement('div'); d.className = 'row';
    d.innerHTML = `${avaHTML(c.peer)}<div class="body"><div class="top"><b class="${missed ? 'miss' : ''}">${esc(c.peer)}</b><time>${fmtList(c.ts)}</time></div>
      <div class="sub"><span><svg class="ic12 ${missed ? 'miss' : ''}" style="width:14px;height:14px"><use href="#${icon}"/></svg> ${label}${dur}</span></div></div>
      <div class="act"><button class="iconbtn"><svg><use href="#${c.video ? 'i-video' : 'i-phone'}"/></svg></button></div>`;
    d.onclick = () => startCall(c.peer, c.video); L.appendChild(d);
  });
}

// ================= ЗВОНКИ =================
// Качество видео: по умолчанию «среднее», можно повысить во время звонка
const Q = {
  low:    { w: 640,  h: 360,  fps: 24, br: 450_000,   label: '360p' },
  medium: { w: 960,  h: 540,  fps: 30, br: 1_000_000, label: '540p' },
  high:   { w: 1280, h: 720,  fps: 30, br: 2_000_000, label: '720p' },
  hd:     { w: 1920, h: 1080, fps: 30, br: 4_000_000, label: '1080p' },
};
// Звук: Opus 48 кГц, 128 кбит/с, FEC (устойчивость к потерям), без DTX
const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, sampleRate: 48000, sampleSize: 16 };
const AUDIO_BR = 128_000;

function mungeOpus(sdp) {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i); if (!m) return sdp;
  const pt = m[1], want = `minptime=10;useinbandfec=1;usedtx=0;stereo=0;sprop-stereo=0;maxplaybackrate=48000;sprop-maxcapturerate=48000;maxaveragebitrate=${AUDIO_BR};cbr=0`;
  const re = new RegExp(`a=fmtp:${pt} .*`, 'i');
  return re.test(sdp) ? sdp.replace(re, `a=fmtp:${pt} ${want}`) : sdp.replace(m[0], `${m[0]}\r\na=fmtp:${pt} ${want}`);
}
async function setLocal(pc, desc) { await pc.setLocalDescription({ type: desc.type, sdp: mungeOpus(desc.sdp) }); }

function preferCodecs(pc) {
  if (!window.RTCRtpReceiver || !RTCRtpReceiver.getCapabilities) return;
  for (const t of pc.getTransceivers()) {
    const kind = t.receiver.track && t.receiver.track.kind; if (!kind || !t.setCodecPreferences) continue;
    const caps = RTCRtpReceiver.getCapabilities(kind); if (!caps) continue;
    const order = kind === 'audio' ? ['audio/opus'] : ['video/VP9', 'video/H264', 'video/VP8'];
    const rank = (c) => { const i = order.indexOf(c.mimeType); return i < 0 ? 99 : i; };
    try { t.setCodecPreferences([...caps.codecs].sort((a, b) => rank(a) - rank(b))); } catch {}
  }
}

async function getMedia(video) {
  const q = Q[localStorage.getItem('hx_q') || 'medium'];
  return navigator.mediaDevices.getUserMedia({
    audio: AUDIO,
    video: video ? { facingMode: 'user', width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: q.fps } } : false,
  });
}

function callUI(state) {
  const c = $('call'); c.classList.add('on');
  c.classList.toggle('connected', state === 'connected');
  $('ctrlIn').classList.toggle('on', state === 'incoming');
  $('ctrlOn').classList.toggle('on', state !== 'incoming');
  const v = call && call.video;
  ['bQuality', 'bCam', 'bFlip'].forEach((id) => ($(id).style.display = v ? '' : 'none'));
}

async function startCall(peer, video) {
  if (call) return;
  call = { peer, video, dir: 'out', pendingIce: [], q: localStorage.getItem('hx_q') || 'medium' };
  $('callName').textContent = peer; avatar($('callAva'), peer); $('callState').textContent = 'Вызов…';
  $('remote').srcObject = null; $('call').classList.remove('video-on'); callUI('outgoing');
  try {
    call.stream = await getMedia(video); showLocal();
    send({ type: 'invite', to: peer, video });
  } catch (e) { toast('Нет доступа к микрофону/камере'); endCall(false); }
}

function showLocal() {
  const v = call.video && call.stream.getVideoTracks().length;
  $('local').srcObject = v ? call.stream : null; $('local').style.display = v ? 'block' : 'none';
  if (v) { $('call').classList.add('video-on'); call.stream.getVideoTracks()[0].contentHint = 'motion'; }
  $('bQuality').textContent = Q[call.q].label.replace('p', '');
}

function makePC() {
  const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  call.stream.getTracks().forEach((t) => pc.addTrack(t, call.stream));
  if (!call.stream.getVideoTracks().length && call.remoteVideo) pc.addTransceiver('video', { direction: 'recvonly' });
  preferCodecs(pc);
  pc.onicecandidate = (e) => e.candidate && send({ type: 'ice', id: call.id, candidate: e.candidate });
  pc.ontrack = (e) => {
    $('remote').srcObject = e.streams[0] || new MediaStream([e.track]);
    if (e.track.kind === 'video') {
      const on = () => $('call').classList.add('video-on'), off = () => !call?.video && $('call').classList.remove('video-on');
      e.track.onunmute = on; e.track.onmute = off; e.track.onended = off; if (!e.track.muted) on();
    }
  };
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') { if (!call.t0) { call.t0 = Date.now(); startTimer(); } callUI('connected'); applySenderParams(); }
    if (s === 'disconnected') $('callState').textContent = 'Переподключение…';
    if (s === 'failed') { $('callState').textContent = 'Переподключение…'; pc.restartIce && pc.restartIce(); }
  };
  return pc;
}

async function applySenderParams() {
  if (!call || !call.pc) return;
  for (const s of call.pc.getSenders()) {
    if (!s.track) continue;
    const p = s.getParameters(); if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    if (s.track.kind === 'audio') { p.encodings[0].maxBitrate = AUDIO_BR; p.encodings[0].priority = 'high'; p.encodings[0].networkPriority = 'high'; }
    else { p.encodings[0].maxBitrate = Q[call.q].br; p.encodings[0].maxFramerate = Q[call.q].fps; p.degradationPreference = 'balanced'; }
    try { await s.setParameters(p); } catch (e) { console.warn('params', e); }
  }
}

async function setQuality(q, fromPeer) {
  if (!call || !Q[q]) return;
  call.q = q;
  const t = call.stream && call.stream.getVideoTracks()[0];
  if (t) try { await t.applyConstraints({ width: { ideal: Q[q].w }, height: { ideal: Q[q].h }, frameRate: { ideal: Q[q].fps } }); } catch {}
  await applySenderParams();
  $('bQuality').textContent = Q[q].label.replace('p', '');
  if (!fromPeer) send({ type: 'quality', id: call.id, q }); else toast('Собеседник выбрал качество ' + Q[q].label);
  setTimeout(updateQBadge, 1500);
}
$('bQuality').onclick = (e) => {
  e.stopPropagation();
  document.querySelectorAll('#qMenu div').forEach((d) => d.classList.toggle('sel', d.dataset.q === call.q));
  $('qMenu').classList.toggle('on');
};
document.querySelectorAll('#qMenu div').forEach((d) => (d.onclick = () => { $('qMenu').classList.remove('on'); setQuality(d.dataset.q); }));
document.addEventListener('click', () => $('qMenu').classList.remove('on'));

async function updateQBadge() {
  if (!call || !call.pc) return;
  let txt = '', rtt = '';
  try {
    const st = await call.pc.getStats();
    st.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video' && r.frameHeight) txt = `${r.frameHeight}p · ${Math.round(r.framesPerSecond || 0)} fps`;
      if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime != null) rtt = `${Math.round(r.currentRoundTripTime * 1000)} мс`;
      if (r.type === 'inbound-rtp' && r.kind === 'audio' && !txt) txt = 'Opus HD';
    });
  } catch {}
  $('qBadge').textContent = [txt, rtt].filter(Boolean).join(' · ');
}

let timer;
function startTimer() {
  clearInterval(timer);
  timer = setInterval(() => {
    if (!call || !call.t0) return;
    const s = Math.floor((Date.now() - call.t0) / 1000); $('callState').textContent = `${Math.floor(s / 60)}:${pad(s % 60)}`;
    if (s % 3 === 0) updateQBadge();
  }, 1000);
}

async function onSignal(m) {
  switch (m.type) {
    case 'invite':
      if (call) { if (call.id !== m.id) send({ type: 'reject', id: m.id, reason: 'busy' }); return; }
      call = { id: m.id, peer: m.from, video: m.video, remoteVideo: m.video, dir: 'in', pendingIce: [], q: localStorage.getItem('hx_q') || 'medium' };
      $('callName').textContent = m.from; avatar($('callAva'), m.from);
      $('callState').textContent = m.video ? 'Видеозвонок Heraxos…' : 'Аудиозвонок Heraxos…';
      $('remote').srcObject = null; $('call').classList.remove('video-on');
      $('wrapAcceptV').style.display = m.video ? '' : 'none';
      callUI('incoming');
      if (autoAnswer && autoAnswer.id === m.id) { const v = autoAnswer.video; autoAnswer = null; accept(v && m.video); }
      else ring(true);
      break;
    case 'calling': if (call) { call.id = m.id; $('callState').textContent = 'Гудки…'; } break;
    case 'accept':
      if (!call || call.id !== m.id) return;
      $('callState').textContent = 'Соединение…';
      call.pc = makePC();
      await setLocal(call.pc, await call.pc.createOffer());
      send({ type: 'offer', id: call.id, sdp: call.pc.localDescription }); call.ready = true;
      break;
    case 'offer':
      if (!call || call.id !== m.id) return;
      await call.pc.setRemoteDescription(m.sdp);
      await setLocal(call.pc, await call.pc.createAnswer());
      send({ type: 'answer', id: call.id, sdp: call.pc.localDescription }); flushIce();
      break;
    case 'answer':
      if (!call || call.id !== m.id) return;
      await call.pc.setRemoteDescription(m.sdp); flushIce(); break;
    case 'ice':
      if (!call || call.id !== m.id) return;
      if (call.pc && call.pc.remoteDescription) call.pc.addIceCandidate(m.candidate).catch(() => {});
      else call.pendingIce.push(m.candidate);
      break;
    case 'quality': if (call && call.id === m.id) setQuality(m.q, true); break;
    case 'reject': case 'hangup': {
      if (!call || call.id !== m.id) return;
      const r = m.reason;
      if (call.dir === 'in' && !call.t0 && r !== 'elsewhere') call.dir = 'missed';
      $('callState').textContent = r === 'busy' ? 'Занято' : m.type === 'reject' ? 'Отклонено' : r === 'noanswer' ? 'Нет ответа' : r === 'elsewhere' ? 'Отвечено на другом устройстве' : 'Звонок завершён';
      endCall(false, 1300, r === 'elsewhere'); break;
    }
    case 'error': toast(m.text); endCall(false); break;
  }
}
function flushIce() { call.pendingIce.forEach((c) => call.pc.addIceCandidate(c).catch(() => {})); call.pendingIce = []; }

async function accept(video) {
  ring(false);
  try {
    call.video = video; call.stream = await getMedia(video); showLocal();
    $('callState').textContent = 'Соединение…'; callUI('outgoing');
    call.pc = makePC(); send({ type: 'accept', id: call.id });
  } catch (e) { toast('Нет доступа к микрофону/камере'); send({ type: 'reject', id: call.id }); endCall(false); }
}
$('bAcceptA').onclick = () => accept(false);
$('bAcceptV').onclick = () => accept(true);
$('bDecline').onclick = () => { send({ type: 'reject', id: call.id }); endCall(false); };
$('bHang').onclick = () => endCall(true);

function endCall(notify, delay = 0, noLog) {
  ring(false); clearInterval(timer);
  if (!call) return;
  if (notify && call.id) send({ type: 'hangup', id: call.id });
  const c = call; call = null;
  if (!noLog) logCall({ peer: c.peer, video: !!(c.video || c.remoteVideo), dir: c.dir, ts: Date.now(), dur: c.t0 ? Math.round((Date.now() - c.t0) / 1000) : 0 });
  c.pc && c.pc.close(); c.stream && c.stream.getTracks().forEach((t) => t.stop());
  setTimeout(() => { if (!call) { $('call').classList.remove('on', 'video-on', 'connected'); $('qMenu').classList.remove('on'); renderCalls(); } }, delay);
}

$('bMute').onclick = () => { const t = call && call.stream.getAudioTracks()[0]; if (!t) return; t.enabled = !t.enabled; $('bMute').classList.toggle('off', !t.enabled); };
$('bCam').onclick = () => { const t = call && call.stream.getVideoTracks()[0]; if (!t) return; t.enabled = !t.enabled; $('bCam').classList.toggle('off', !t.enabled); $('local').style.visibility = t.enabled ? 'visible' : 'hidden'; };
let facing = 'user';
$('bFlip').onclick = async () => {
  if (!call || !call.video) return;
  facing = facing === 'user' ? 'environment' : 'user';
  const q = Q[call.q], old = call.stream.getVideoTracks()[0];
  old && old.stop();
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { exact: facing }, width: { ideal: q.w }, height: { ideal: q.h } } });
    const nt = s.getVideoTracks()[0];
    const sender = call.pc && call.pc.getSenders().find((x) => x.track === old || (x.track && x.track.kind === 'video'));
    sender && (await sender.replaceTrack(nt));
    call.stream.removeTrack(old); call.stream.addTrack(nt);
    $('local').srcObject = call.stream; $('local').style.transform = facing === 'user' ? 'scaleX(-1)' : 'none';
  } catch { toast('Не удалось переключить камеру'); }
};

function clearCallNotes() {
  navigator.serviceWorker && navigator.serviceWorker.ready.then((r) => r.getNotifications().then((ns) => ns.forEach((n) => n.data && n.data.kind === 'call' && n.close()))).catch(() => {});
}
function ring(on) {
  clearCallNotes();
  const a = $('ring');
  if (on) { a.currentTime = 0; a.play().catch(() => {}); navigator.vibrate && navigator.vibrate([500, 300, 500, 300, 500, 300, 500]); }
  else { a.pause(); navigator.vibrate && navigator.vibrate(0); }
}

// ---------- старт ----------
if (token && me) start(); else $('auth').classList.add('on');
