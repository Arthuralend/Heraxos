// Ahazang — игры: шахматы, шашки и танки «Рубеж». Вдвоём (в том числе во время звонка — видно друг друга)
// или с компьютером. Ходы идут через сервер сообщениями type: 'game'.
(() => {
  'use strict';
  const Ch = window.HXChess, Dr = window.HXDraughts;
  const KK = (l) => String(l || '').toLowerCase();
  const rid = () => Math.random().toString(16).slice(2, 10) + Date.now().toString(16).slice(-6);
  const bridge = () => window.HeraxosAndroid || null;
  const call0 = (fn, ...a) => { try { const b = bridge(); return b && b[fn] ? b[fn](...a) : undefined; } catch { return undefined; } };

  const GAMES = {
    chess: { title: 'Шахматы', sub: 'Классика: мат, пат, рокировка, взятие на проходе', ai: true },
    checkers: { title: 'Шашки', sub: 'Русские шашки: бить обязательно, дамка ходит далеко', ai: true },
    tanks: { title: 'Танчики 3D', sub: 'Защитите штаб вдвоём: по сети друг с другом или одному', ai: false, solo: true },
  };

  // ---------- иконки ----------
  const PIECE = {
    p: '<circle cx="50" cy="35" r="13"/><path d="M38 52h24c-1 8 4 16 10 22H28c6-6 11-14 10-22z"/><rect x="34" y="47" width="32" height="7" rx="3.5"/><rect x="22" y="74" width="56" height="12" rx="5"/>',
    r: '<path d="M26 20h10v8h8v-8h12v8h8v-8h10v18H26z"/><rect x="29" y="38" width="42" height="7" rx="2"/><path d="M33 45h34l3 29H30z"/><rect x="22" y="74" width="56" height="12" rx="5"/>',
    n: '<path d="M30 74c0-10 5-17 13-23-6 1-11 5-15 8-4 3-9 1-9-4 0-3 2-6 4-9l9-14c4-8 11-14 19-16l2-8 6 9c11 5 17 19 17 35v22z"/><circle class="d" cx="40" cy="32" r="3"/><rect x="22" y="74" width="56" height="12" rx="5"/>',
    b: '<circle cx="50" cy="14" r="5"/><path d="M50 20c-11 9-16 18-15 26 1 7 7 10 15 10s14-3 15-10c1-8-4-17-15-26z"/><path class="d" d="M55 29 46 41" stroke-width="3.5" fill="none" stroke-linecap="round"/><rect x="36" y="55" width="28" height="6" rx="3"/><path d="M40 61h20c1 6 4 9 9 13H31c5-4 8-7 9-13z"/><rect x="22" y="74" width="56" height="12" rx="5"/>',
    q: '<circle cx="20" cy="22" r="5"/><circle cx="35" cy="14" r="5"/><circle cx="50" cy="10" r="5"/><circle cx="65" cy="14" r="5"/><circle cx="80" cy="22" r="5"/><path d="M28 56 20 26l12 15 3-22 8 20 7-24 7 24 8-20 3 22 12-15-8 30z"/><rect x="29" y="55" width="42" height="6" rx="3"/><path d="M33 61h34l3 13H30z"/><rect x="22" y="74" width="56" height="12" rx="5"/>',
    k: '<rect x="46" y="4" width="8" height="22" rx="2"/><rect x="39" y="10" width="22" height="8" rx="2"/><path d="M50 32c-5-6-12-8-18-6-8 3-10 13-4 24l2 6h40l2-6c6-11 4-21-4-24-6-2-13 0-18 6z"/><rect x="29" y="55" width="42" height="6" rx="3"/><path d="M33 61h34l3 13H30z"/><rect x="22" y="74" width="56" height="12" rx="5"/>',
  };
  const pieceSVG = (p) => `<svg class="pc ${p === p.toUpperCase() ? 'w' : 'b'}" viewBox="0 0 100 100">${PIECE[p.toLowerCase()]}</svg>`;
  const discSVG = (p) => `<svg class="disc ${p.toLowerCase() === 'w' ? 'w' : 'b'}" viewBox="0 0 100 100"><circle cx="50" cy="54" r="38" class="edge"/><circle cx="50" cy="48" r="38"/><circle cx="50" cy="48" r="27" class="ring"/>${p === p.toUpperCase() ? '<path class="crown" d="M32 58 28 38l11 9 11-15 11 15 11-9-4 20z"/>' : ''}</svg>`;
  const ART = {
    chess: `<svg viewBox="0 0 100 100" class="art"><rect x="8" y="8" width="84" height="84" rx="10" fill="#c7a07f"/><path d="M8 8h21v21H8zm42 0h21v21H50zM29 29h21v21H29zm42 0h21v21H71zM8 50h21v21H8zm42 0h21v21H50zM29 71h21v21H29zm42 0h21v21H71z" fill="#f2e8da"/><g transform="translate(22 14) scale(.58)" class="pc w">${PIECE.n}</g></svg>`,
    checkers: `<svg viewBox="0 0 100 100" class="art"><rect x="8" y="8" width="84" height="84" rx="10" fill="#f2e8da"/><path d="M29 8h21v21H29zm42 0h21v21H71zM8 29h21v21H8zm42 0h21v21H50zM29 50h21v21H29zm42 0h21v21H71zM8 71h21v21H8zm42 0h21v21H50z" fill="#c7a07f"/><g transform="translate(12 30) scale(.45)">${discSVG('b').replace(/<\/?svg[^>]*>/g, '')}</g><g transform="translate(44 44) scale(.45)">${discSVG('W').replace(/<\/?svg[^>]*>/g, '')}</g></svg>`,
    tanks: `<svg viewBox="0 0 100 100" class="art"><rect x="8" y="8" width="84" height="84" rx="10" fill="#2b2a27"/><rect x="14" y="62" width="72" height="10" fill="#a0522d" opacity=".9"/><rect x="14" y="74" width="72" height="10" fill="#8a4626" opacity=".9"/><g transform="translate(50 46)"><rect x="-24" y="-18" width="10" height="36" rx="3" fill="#5a4a3f"/><rect x="14" y="-18" width="10" height="36" rx="3" fill="#5a4a3f"/><rect x="-15" y="-14" width="30" height="28" rx="4" fill="#d97757"/><rect x="-9" y="-9" width="18" height="18" rx="5" fill="#c96442"/><rect x="-2.5" y="-32" width="5" height="24" rx="2" fill="#f2e8da"/></g></svg>`,
  };

  // ---------- звук (короткие синтезированные щелчки) ----------
  let ac = null;
  function beep(freq = 440, dur = 0.06, type = 'triangle', vol = 0.12) {
    try {
      ac ||= new (window.AudioContext || window.webkitAudioContext)();
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(vol, ac.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
      o.connect(g).connect(ac.destination); o.start(); o.stop(ac.currentTime + dur);
    } catch {}
  }
  const sndMove = () => beep(520, 0.05, 'triangle', 0.09);
  const sndCap = () => { beep(300, 0.08, 'square', 0.06); setTimeout(() => beep(220, 0.08, 'square', 0.05), 50); };
  const sndEnd = () => { beep(660, 0.12); setTimeout(() => beep(880, 0.18), 120); };
  window.HXBeep = beep;

  // ---------- состояние звонка (сообщает приложение) ----------
  const callState = { active: false, peer: '', camOn: false, remoteVideo: false };
  window.hxCallState = (o) => { Object.assign(callState, o || {}); refreshVideoUI(); };
  window.hxOpenGames = (peer) => openHub(peer || callState.peer || '');

  // ---------- корневой экран ----------
  const root = document.createElement('section');
  root.id = 'games';
  document.body.appendChild(root);
  let S = null;                 // текущая игра
  let waiting = null;           // отправленное приглашение
  let hubPeer = '';             // с кем собираемся играть (из звонка / меню)

  function show(html) { root.innerHTML = html; root.classList.add('on'); setBars(false); requestAnimationFrame(refreshVideoUI); }
  function closeAll() {
    if (S) leaveGame(true);
    root.classList.remove('on'); root.innerHTML = '';
    call0('setVideoSlots', '');
  }
  window.hxGamesOpen = () => root.classList.contains('on');
  window.hxGamesBack = () => {
    if (!root.classList.contains('on')) return false;
    if (S) { askLeave(); return true; }
    closeAll(); return true;
  };

  // ---------- центр игр ----------
  function openHub(peer) {
    hubPeer = peer || '';
    if (S) { toast('Сначала закончите текущую игру'); return; }
    const withWho = hubPeer ? `<div class="g-with">${avaHTML(hubPeer)}<span>Игра с <b>${esc(dn(hubPeer))}</b></span></div>` : '';
    show(`<header class="g-head"><button class="iconbtn" data-x="close" aria-label="Закрыть"><svg><use href="#i-back"/></svg></button><h2>Игры</h2></header>
      <div class="g-scroll">${withWho}
        <div class="g-cards">${Object.entries(GAMES).map(([k, g]) => `
          <button class="g-card" data-game="${k}">${ART[k]}<div><b>${g.title}</b><small>${g.sub}</small></div></button>`).join('')}
        </div>
        <p class="mute small center g-note">Во время звонка можно играть и видеть друг друга: откройте игры из звонка или позовите собеседника.</p>
      </div>`);
    root.querySelector('[data-x=close]').onclick = closeAll;
    root.querySelectorAll('[data-game]').forEach((b) => (b.onclick = () => pickOpponent(b.dataset.game)));
  }
  window.hxGames = openHub;

  async function pickOpponent(kind) {
    const g = GAMES[kind];
    if (hubPeer) return invite(kind, hubPeer);
    try { await loadUsers(); } catch {}
    const list = users.filter((u) => !isBlocked(u.login)).sort((a, b) => (online.has(KK(b.login)) - online.has(KK(a.login))));
    const callPeer = callState.active && callState.peer ? callState.peer : '';
    const rows = [];
    if (callPeer) rows.push(`<button class="g-opp hl" data-p="${esc(callPeer)}">${avaHTML(callPeer, true)}<div><b>${esc(dn(callPeer))}</b><small>Сейчас в звонке — будете видеть друг друга</small></div></button>`);
    if (g.ai) rows.push(`<div class="g-ai"><b>С компьютером</b><div class="g-lv"><button data-ai="1">Легко</button><button data-ai="2">Средне</button><button data-ai="3">Сложно</button></div></div>`);
    if (g.solo) rows.push(`<button class="g-opp" data-solo="1"><div class="ava g-solo">🎮</div><div><b>Играть одному</b><small>Тренировка против компьютерных танков</small></div></button>`);
    for (const u of list) {
      if (callPeer && KK(u.login) === KK(callPeer)) continue;
      const on = online.has(KK(u.login));
      rows.push(`<button class="g-opp" data-p="${esc(u.login)}">${avaHTML(u.login, on)}<div><b>${esc(dn(u.login))}</b><small class="${on ? 'on' : ''}">${on ? 'в сети' : 'не в сети — приглашение не дойдёт'}</small></div></button>`);
    }
    show(`<header class="g-head"><button class="iconbtn" data-x="back"><svg><use href="#i-back"/></svg></button><h2>${g.title}</h2></header>
      <div class="g-scroll"><p class="mute g-pick">С кем играть?</p>${rows.join('') || '<div class="empty-list">Добавьте контакты, чтобы играть вдвоём</div>'}</div>`);
    root.querySelector('[data-x=back]').onclick = () => openHub('');
    root.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => invite(kind, b.dataset.p)));
    root.querySelectorAll('[data-ai]').forEach((b) => (b.onclick = () => startGame({ id: rid(), kind, peer: '', ai: +b.dataset.ai, color: 'w', host: true })));
    root.querySelectorAll('[data-solo]').forEach((b) => (b.onclick = () => startGame({ id: rid(), kind, peer: '', ai: 0, color: 'w', host: true, solo: true })));
  }

  // ---------- приглашения ----------
  function gsend(o, sess = S) {
    if (!sess || !sess.peer) return;
    send(Object.assign({ type: 'game', to: sess.peer, g: sess.id }, o));
  }

  function invite(kind, peer, color = 'w') {
    if (!online.has(KK(peer))) toast(`${dn(peer)} сейчас не в сети — приглашение дойдёт, только если приложение открыто`, 3200);
    waiting = { id: rid(), kind, peer, color };
    send({ type: 'game', to: peer, g: waiting.id, k: 'invite', game: kind, color });
    show(`<div class="g-wait">${avaHTML(peer, true)}<h3>${esc(dn(peer))}</h3><p class="mute">Ждём ответа на приглашение<br>«${GAMES[kind].title}»…</p>
      <div class="g-dots"><i></i><i></i><i></i></div><button class="btn ghost" data-x="cancel">Отменить</button></div>`);
    root.querySelector('[data-x=cancel]').onclick = () => {
      if (waiting) send({ type: 'game', to: waiting.peer, g: waiting.id, k: 'cancel' });
      waiting = null; openHub(hubPeer);
    };
    clearTimeout(invite.t);
    invite.t = setTimeout(() => { if (waiting && waiting.id) { toast(`${dn(peer)} не ответил(а)`); send({ type: 'game', to: peer, g: waiting.id, k: 'cancel' }); waiting = null; openHub(hubPeer); } }, 60000);
  }

  let incoming = null;
  window.hxGame = (m) => {
    const from = m.from;
    remember({ login: from, num: m.fromNum });
    switch (m.k) {
      case 'invite': {
        // идущая партия с другим — «занят»; законченная (экран итога) не мешает реваншу
        if ((S && !S.finished && KK(S.peer) !== KK(from)) || waiting) return send({ type: 'game', to: from, g: m.g, k: 'decline', reason: 'busy' });
        incoming = m;
        try { navigator.vibrate && navigator.vibrate([80, 60, 80]); } catch {}
        beep(700, 0.12); setTimeout(() => beep(900, 0.14), 140);
        infoSheet(`${dn(from)} приглашает сыграть`, `<div class="g-invite">${ART[m.game] || ''}<b>${esc((GAMES[m.game] || {}).title || 'Игра')}</b></div>`, [
          { label: 'Играть', primary: true, on: () => acceptInvite(m) },
          { label: 'Отказаться', on: () => { send({ type: 'game', to: from, g: m.g, k: 'decline' }); incoming = null; } },
        ]);
        // если сейчас открыт экран звонка — приложение покажет приглашение поверх него
        call0('gameInvite', dn(from), (GAMES[m.game] || {}).title || 'Игра');
        return;
      }
      case 'join': { // соперник нажал «Играть» в приглашении из чата
        const inv = openInvites()[m.g];
        if (!inv || KK(inv.peer) !== KK(from) || Date.now() - inv.ts > INVITE_TTL) return send({ type: 'game', to: from, g: m.g, k: 'decline', reason: 'expired' });
        if ((S && !S.finished) || waiting) return send({ type: 'game', to: from, g: m.g, k: 'decline', reason: 'busy' });
        dropInvite(m.g);
        send({ type: 'game', to: from, g: m.g, k: 'go' });
        toast(`${dn(from)} принял(а) приглашение`, 2000);
        if (S) leaveGame(false);
        startGame({ id: m.g, kind: inv.kind, peer: from, color: inv.color, host: true });
        return;
      }
      case 'go':
        if (joining && joining.id === m.g) {
          const j = joining; joining = null; clearTimeout(joinT);
          if (S) leaveGame(false);
          startGame({ id: j.id, kind: j.kind, peer: from, color: j.color === 'w' ? 'b' : 'w', host: false });
        }
        return;
      case 'cancel':
        if (incoming && incoming.g === m.g) { incoming = null; $('info').classList.remove('on'); toast(`${dn(from)} отменил(а) приглашение`); }
        return;
      case 'accept':
        if (waiting && waiting.id === m.g) {
          const w = waiting; waiting = null; clearTimeout(invite.t);
          startGame({ id: w.id, kind: w.kind, peer: w.peer, color: w.color, host: true });
        } else if (openInvites()[m.g] && (!S || S.finished)) { // приняли живое приглашение, отправленное из чата
          const inv = openInvites()[m.g]; dropInvite(m.g);
          toast(`${dn(from)} принял(а) приглашение`, 2000);
          if (S) leaveGame(false);
          startGame({ id: m.g, kind: inv.kind, peer: from, color: inv.color, host: true });
        }
        return;
      case 'decline':
        if (joining && joining.id === m.g) {
          joining = null; clearTimeout(joinT);
          toast(m.reason === 'busy' ? `${dn(from)} сейчас играет в другую игру` : m.reason === 'expired' ? 'Приглашение уже недействительно — попросите прислать новое' : `${dn(from)} отказался(ась)`, 3200);
          closeAll();
          return;
        }
        if (waiting && waiting.id === m.g) {
          waiting = null; clearTimeout(invite.t);
          toast(m.reason === 'busy' ? `${dn(from)} сейчас играет в другую игру` : `${dn(from)} отказался(ась)`, 2800);
          openHub(hubPeer);
        }
        return;
      case 'offline':
        if (joining && joining.id === m.g) { joining = null; clearTimeout(joinT); toast(`${dn(from)} сейчас не в сети — откройте приглашение, когда он(а) будет в приложении`, 3500); closeAll(); return; }
        if (waiting && waiting.id === m.g) { waiting = null; clearTimeout(invite.t); toast(`${dn(from)} не в сети`, 2600); openHub(hubPeer); }
        else if (S && S.id === m.g) toast(`${dn(from)} не в сети — ход не дошёл`, 2600);
        return;
    }
    if (S && S.id === m.g && KK(from) === KK(S.peer)) {
      if (m.k === 'leave') {
        toast(`${dn(from)} вышел(а) из игры`, 2600);
        S.ctrl && S.ctrl.peerLeft && S.ctrl.peerLeft();
        return;
      }
      S.ctrl && S.ctrl.onNet && S.ctrl.onNet(m);
    }
  };

  // ответ на приглашение с экрана звонка (кнопки в приложении)
  window.hxGameAnswer = (yes) => {
    const m = incoming; if (!m) return;
    $('info').classList.remove('on');
    if (yes) acceptInvite(m);
    else { send({ type: 'game', to: m.from, g: m.g, k: 'decline' }); incoming = null; }
  };

  // ---------- приглашения через чат: карточка в переписке, действует сутки ----------
  const INVITE_TTL = 24 * 3600e3;
  const invKey = () => 'hx_ginv_' + me;
  function openInvites() { try { return JSON.parse(localStorage.getItem(invKey()) || '{}'); } catch { return {}; } }
  function saveInvites(o) {
    for (const [k, v] of Object.entries(o)) if (Date.now() - v.ts > INVITE_TTL) delete o[k];
    try { localStorage.setItem(invKey(), JSON.stringify(o)); } catch {}
  }
  function dropInvite(id) { const o = openInvites(); delete o[id]; saveInvites(o); }

  /** Отправить приглашение сообщением в чат (и сразу всплывающим окном, если человек в приложении) */
  window.hxChatInvite = async (peer, kind) => {
    const id = rid(), o = openInvites();
    o[id] = { kind, peer, color: 'w', ts: Date.now() }; saveInvites(o);
    const ok = await window.hxSendChatText(peer, 'HXG1:' + JSON.stringify({ g: kind, id, c: 'w' }));
    if (!ok) return;
    if (online.has(KK(peer))) send({ type: 'game', to: peer, g: id, k: 'invite', game: kind, color: 'w' });
    toast('Приглашение отправлено — игра начнётся, когда соперник нажмёт «Играть»', 2800);
  };

  /** Нажали «Играть» в карточке приглашения из чата */
  let joining = null, joinT = null;
  window.hxChatJoin = (from, inv, mine) => {
    if (mine) {
      if (!openInvites()[inv.id]) return toast('Это приглашение уже использовано — отправьте новое', 2400);
      return toast(`Ждём, когда ${dn(cur ? cur.peer : '')} нажмёт «Играть»`, 2400);
    }
    if (S && !S.finished) return toast('Сначала закончите текущую игру');
    if (!GAMES[inv.g]) return;
    joining = { id: inv.id, kind: inv.g, color: inv.c || 'w', peer: from };
    send({ type: 'game', to: from, g: inv.id, k: 'join', game: inv.g });
    show(`<div class="g-wait">${avaHTML(from, true)}<h3>${esc(dn(from))}</h3><p class="mute">Подключаемся к игре<br>«${GAMES[inv.g].title}»…</p>
      <div class="g-dots"><i></i><i></i><i></i></div><button class="btn ghost" data-x="cancel">Отменить</button></div>`);
    root.querySelector('[data-x=cancel]').onclick = () => { joining = null; clearTimeout(joinT); closeAll(); };
    clearTimeout(joinT);
    joinT = setTimeout(() => { if (joining) { joining = null; toast(`${dn(from)} не отвечает — возможно, приложение закрыто`, 3000); closeAll(); } }, 15000);
  };
  window.hxGameTitle = (k) => (GAMES[k] || {}).title || 'Игра';
  window.hxGameArt = (k) => ART[k] || '';

  function acceptInvite(m) {
    incoming = null;
    if (S) leaveGame(true);
    send({ type: 'game', to: m.from, g: m.g, k: 'accept' });
    startGame({ id: m.g, kind: m.game, peer: m.from, color: m.color === 'w' ? 'b' : 'w', host: false });
  }

  // ---------- общая игра ----------
  function startGame(sess) {
    S = sess;
    if (sess.kind === 'chess') S.ctrl = boardGame(sess, 'chess');
    else if (sess.kind === 'checkers') S.ctrl = boardGame(sess, 'checkers');
    else if (sess.kind === 'tanks') startTanks(sess);
  }

  function leaveGame(notify) {
    if (!S) return;
    if (notify && S.peer && !S.finished) gsend({ k: 'leave' });
    try { S.ctrl && S.ctrl.destroy && S.ctrl.destroy(); } catch {}
    S = null;
    call0('setVideoSlots', '');
  }

  function askLeave() {
    if (!S || S.finished || !S.peer) { leaveGame(true); openHub(''); return; }
    infoSheet('Выйти из игры?', '<p class="mute">Партия будет прервана.</p>', [
      { label: 'Выйти', danger: true, on: () => { leaveGame(true); openHub(''); } },
      { label: 'Остаться', primary: true },
    ]);
  }

  // ---------- полосы игроков с видео ----------
  function playerBar(who, login, label) {
    return `<div class="g-bar" data-who="${who}">
      <div class="vslot" data-who="${who}">${avaHTML(login || me, false)}</div>
      <div class="g-pl"><b>${esc(label)}</b><small class="g-st"></small><div class="g-caps"></div></div>
      ${who === 'me' ? callCtlHTML() : ''}
    </div>`;
  }

  /** Кнопки звонка в игре: позвонить / завершить, видео, микрофон */
  function callCtlHTML(extra = '') {
    return `<div class="g-cc ${extra}" hidden>
      <button data-cc="call" title="Позвонить"><svg><use href="#i-phone"/></svg></button>
      <button data-cc="cam" title="Видео"><svg><use href="#i-video"/></svg></button>
      <button data-cc="mic" title="Микрофон" hidden><svg><use href="#i-mic"/></svg></button></div>`;
  }
  const inCallWith = (peer) => callState.active && KK(callState.peer) === KK(peer);
  function callControls() {
    const box = root.querySelector('.g-cc'); if (!box) return;
    box.querySelector('[data-cc=call]').onclick = () => {
      if (!S || !S.peer) return;
      if (inCallWith(S.peer)) { call0('hangupCall'); return; }
      if (callState.active) return toast('Сейчас идёт другой звонок');
      call0('startCallStay', S.peer, dn(S.peer), false); toast('Звоним — играйте и разговаривайте', 2000);
    };
    box.querySelector('[data-cc=cam]').onclick = () => {
      if (!S || !S.peer) return;
      if (inCallWith(S.peer)) call0('gameCamera', !callState.camOn);
      else if (callState.active) toast('Сейчас идёт другой звонок');
      else { call0('startCallStay', S.peer, dn(S.peer), true); toast('Звоним с видео — будете видеть друг друга', 2200); }
    };
    box.querySelector('[data-cc=mic]').onclick = () => call0('gameMute', !callState.muted);
  }
  const camButton = callControls;

  /** Видео в игре: прямоугольники полос игроков отдаём приложению, оно рисует поверх них видео звонка */
  let lastSlots = '';
  function refreshVideoUI() {
    const open = root.classList.contains('on') && S && S.peer;
    const inCall = open && callState.active && KK(callState.peer) === KK(S.peer);
    const cc = root.querySelector('.g-cc');
    if (cc) {
      const canNative = typeof NATIVE !== 'undefined' && NATIVE;
      cc.hidden = !(open && canNative);
      const bc = cc.querySelector('[data-cc=call]'), bv = cc.querySelector('[data-cc=cam]'), bm = cc.querySelector('[data-cc=mic]');
      bc.classList.toggle('end', !!inCall);
      bc.innerHTML = `<svg><use href="#${inCall ? 'i-end' : 'i-phone'}"/></svg>`;
      bc.title = inCall ? 'Завершить звонок' : 'Позвонить';
      bv.classList.toggle('on', !!(inCall && callState.camOn));
      bv.title = inCall ? (callState.camOn ? 'Выключить видео' : 'Включить видео') : 'Видеозвонок — видеть друг друга';
      bm.hidden = !inCall;
      bm.classList.toggle('off', !!callState.muted);
      bm.title = callState.muted ? 'Включить микрофон' : 'Выключить микрофон';
    }
    root.querySelectorAll('.vslot').forEach((v) => v.classList.toggle('live', !!inCall && (v.dataset.who === 'me' ? callState.camOn : callState.remoteVideo)));
    let slots = '';
    if (inCall) {
      const r = (who) => { const el = root.querySelector(`.vslot[data-who=${who}]`); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
      slots = JSON.stringify({ peer: S.peer, remote: r('opp'), local: r('me') });
    }
    if (slots !== lastSlots) { lastSlots = slots; call0('setVideoSlots', slots); }
  }
  window.addEventListener('resize', () => setTimeout(refreshVideoUI, 60));

  // =====================================================================
  // Шахматы и шашки: доска, ходы, сеть, компьютер
  // =====================================================================
  function boardGame(sess, type) {
    const isChess = type === 'chess';
    const R = isChess ? Ch : Dr;
    const my = sess.color;
    let st = isChess ? Ch.fromFEN(Ch.START) : Dr.start();
    let hist = [], keys = isChess ? [Ch.key(st)] : [], legal = R.moves(st);
    let sel = -1, targets = [], last = null, over = null, flip = my === 'b', drag = null, pendingPromo = null, destroyed = false;
    const oppName = sess.peer ? dn(sess.peer) : `Компьютер · ${['', 'легко', 'средне', 'сложно'][sess.ai] || ''}`;
    const title = isChess ? 'Шахматы' : 'Шашки';

    show(`<header class="g-head"><button class="iconbtn" data-x="back"><svg><use href="#i-back"/></svg></button><h2>${title}</h2>
        <button class="iconbtn" data-x="flip" title="Повернуть доску">⇅</button></header>
      <div class="g-play">
        ${playerBar('opp', sess.peer || '', oppName)}
        <div class="g-board-wrap"><div class="g-board ${type}"></div><div class="g-promo" hidden></div><div class="g-over" hidden></div></div>
        ${playerBar('me', me, 'Вы')}
        <div class="g-moves"></div>
        <div class="g-acts">
          <button class="pill" data-x="resign">${sess.peer ? 'Сдаться' : 'Новая партия'}</button>
          ${sess.peer ? '<button class="pill" data-x="draw">Предложить ничью</button>' : ''}
        </div>
      </div>`);
    const boardEl = root.querySelector('.g-board');
    const sqEls = [];
    for (let i = 0; i < 64; i++) { const d = document.createElement('div'); d.className = 'sq'; boardEl.appendChild(d); sqEls.push(d); }
    if (!sess.peer) { const a = root.querySelector('.g-bar[data-who=opp] .vslot'); a.innerHTML = '<div class="ava g-solo">🤖</div>'; }
    root.querySelector('[data-x=back]').onclick = askLeave;
    root.querySelector('[data-x=flip]').onclick = () => { flip = !flip; render(); };
    root.querySelector('[data-x=resign]').onclick = () => {
      if (!sess.peer) { restartLocal(); return; }
      if (over) return;
      infoSheet('Сдаться?', '', [{ label: 'Сдаться', danger: true, on: () => { gsend({ k: 'resign' }); finish({ result: my === 'w' ? 'b' : 'w', reason: 'resign' }); } }, { label: 'Играть дальше', primary: true }]);
    };
    const drawBtn = root.querySelector('[data-x=draw]');
    if (drawBtn) drawBtn.onclick = () => { if (over) return; gsend({ k: 'draw?' }); toast('Предложение ничьей отправлено', 1800); };
    camButton();

    // клетка экрана → клетка доски (с учётом поворота)
    const vis = (i) => (flip ? 63 - i : i);
    const coord = (i) => {
      const r = i >> 3, c = i & 7;
      return { file: 'abcdefgh'[c], rank: 8 - r };
    };

    function render(anim) {
      const checkSq = isChess && Ch.inCheck(st) ? st.b.indexOf(st.t === 'w' ? 'K' : 'k') : -1;
      const mustMove = !isChess && legal.length && legal[0].caps.length && st.t === my && !over ? new Set(legal.map((m) => m.f)) : null;
      for (let v = 0; v < 64; v++) {
        const i = vis(v), el = sqEls[v], r = i >> 3, c = i & 7;
        const dark = (r + c) % 2 === 1;
        let cls = 'sq ' + (dark ? 'd' : 'l');
        if (last && (last[0] === i || last[1] === i)) cls += ' last';
        if (sel === i) cls += ' sel';
        if (checkSq === i) cls += ' check';
        if (mustMove && mustMove.has(i)) cls += ' must';
        const tg = targets.includes(i);
        if (tg) cls += st.b[i] !== '.' || (!isChess && false) ? ' tgt cap' : ' tgt';
        el.className = cls;
        const p = st.b[i];
        let html = p === '.' ? '' : isChess ? pieceSVG(p) : discSVG(p);
        // подписи полей по краю
        const vr = v >> 3, vc = v & 7, cd = coord(i);
        if (vc === 0) html += `<i class="cr">${cd.rank}</i>`;
        if (vr === 7) html += `<i class="cf">${cd.file}</i>`;
        el.innerHTML = html;
        el.dataset.i = i;
      }
      if (anim && last) {
        const to = sqEls[flip ? 63 - last[1] : last[1]], from = sqEls[flip ? 63 - last[0] : last[0]];
        const pc = to.querySelector('svg');
        if (pc && from) {
          const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
          try { pc.animate([{ transform: `translate(${a.left - b.left}px,${a.top - b.top}px)` }, { transform: 'none' }], { duration: 160, easing: 'ease-out' }); } catch {}
        }
      }
      renderBars();
      renderMoves();
    }

    function renderBars() {
      const turnMine = st.t === my && !over;
      const bars = { opp: root.querySelector('.g-bar[data-who=opp]'), me: root.querySelector('.g-bar[data-who=me]') };
      bars.me.classList.toggle('turn', turnMine);
      bars.opp.classList.toggle('turn', !turnMine && !over);
      bars.me.querySelector('.g-st').textContent = over ? '' : turnMine ? (Ch.inCheck && isChess && Ch.inCheck(st) ? 'Шах! Ваш ход' : 'Ваш ход') : '';
      bars.opp.querySelector('.g-st').textContent = over ? '' : !turnMine ? (sess.peer ? 'Думает…' : 'Компьютер думает…') : '';
      // съеденные фигуры
      const caps = { w: [], b: [] };
      if (isChess) {
        const full = { p: 8, n: 2, b: 2, r: 2, q: 1 }, count = {};
        for (const p of st.b) if (p !== '.') count[p] = (count[p] || 0) + 1;
        for (const [k, n] of Object.entries(full)) {
          for (let i = (count[k.toUpperCase()] || 0); i < n; i++) caps.b.push(k.toUpperCase()); // белые фигуры, взятые чёрными
          for (let i = (count[k] || 0); i < n; i++) caps.w.push(k);
        }
      } else {
        const wl = st.b.filter((p) => p.toLowerCase() === 'w').length, bl = st.b.filter((p) => p.toLowerCase() === 'b').length;
        for (let i = wl; i < 12; i++) caps.b.push('w');
        for (let i = bl; i < 12; i++) caps.w.push('b');
      }
      const html = (list) => list.map((p) => (isChess ? pieceSVG(p) : discSVG(p))).join('');
      bars.me.querySelector('.g-caps').innerHTML = html(caps[my]);
      bars.opp.querySelector('.g-caps').innerHTML = html(caps[my === 'w' ? 'b' : 'w']);
    }

    function renderMoves() {
      const el = root.querySelector('.g-moves');
      const fig = { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘' };
      const txt = (s) => (isChess ? s.replace(/^[KQRBN]/, (x) => fig[x]) : s);
      let h = '';
      for (let i = 0; i < hist.length; i += 2) h += `<span><i>${i / 2 + 1}.</i>${txt(hist[i].san)}${hist[i + 1] ? ' ' + txt(hist[i + 1].san) : ''}</span>`;
      el.innerHTML = h || `<span class="mute">${my === 'w' ? 'Вы играете белыми — ваш ход первый' : 'Вы играете чёрными'}</span>`;
      el.scrollLeft = el.scrollWidth;
    }

    function selectSq(i) {
      sel = i;
      targets = legal.filter((m) => m.f === i).map((m) => m.t);
      render();
    }

    function tap(i) {
      if (over || st.t !== my || pendingPromo) return;
      if (sel >= 0 && targets.includes(i)) return tryMove(sel, i);
      const p = st.b[i];
      const mine = isChess ? Ch.colorOf(p) === my : p !== '.' && p.toLowerCase() === my;
      if (mine && legal.some((m) => m.f === i)) selectSq(i);
      else if (mine) { sel = i; targets = []; render(); if (!isChess && legal.length && legal[0].caps.length) toast('Бить обязательно — выберите шашку, которая бьёт', 1800); }
      else { sel = -1; targets = []; render(); }
    }

    function tryMove(f, t) {
      const ms = legal.filter((m) => m.f === f && m.t === t);
      if (!ms.length) return;
      if (isChess && ms[0].pr) return askPromo(ms);
      play(ms[0], false);
    }

    function askPromo(ms) {
      pendingPromo = ms;
      const box = root.querySelector('.g-promo');
      box.hidden = false;
      box.innerHTML = '<b>Превратить пешку в</b><div>' + ms.map((m) => `<button data-pr="${m.pr}">${pieceSVG(m.pr)}</button>`).join('') + '</div>';
      box.querySelectorAll('button').forEach((b) => (b.onclick = () => {
        const m = ms.find((x) => x.pr === b.dataset.pr); box.hidden = true; pendingPromo = null; play(m, false);
      }));
    }

    function play(m, fromNet) {
      if (over) return;
      const san = isChess ? Ch.san(st, m, legal) : Dr.notation(m);
      const capture = isChess ? m.x !== '.' : m.caps.length > 0;
      st = R.make(st, m);
      if (isChess) keys.push(Ch.key(st));
      hist.push({ f: m.f, t: m.t, pr: m.pr || '', caps: m.caps || [], san });
      last = [m.f, m.t]; sel = -1; targets = [];
      legal = R.moves(st);
      (capture ? sndCap : sndMove)();
      if (!fromNet && sess.peer) gsend({ k: 'move', n: hist.length, m: { f: m.f, t: m.t, pr: m.pr || '', caps: m.caps || [] } });
      const o = isChess ? Ch.outcome(st, keys) : Dr.outcome(st);
      render(true);
      if (o) return finish(o);
      if (!sess.peer && st.t !== my) setTimeout(aiMove, 350);
    }

    function aiMove() {
      if (destroyed || over || st.t === my) return;
      const m = R.bestMove(st, sess.ai || 2);
      if (m) play(m, true);
    }

    function finish(o) {
      over = o; sess.finished = true;
      const won = o.result === my, draw = o.result === 'draw';
      const why = {
        mate: 'Мат', stalemate: 'Пат', material: 'Недостаточно фигур для мата', fifty: 'Правило 50 ходов', repetition: 'Троекратное повторение',
        resign: o.result === my ? 'Соперник сдался' : 'Вы сдались', agreed: 'Ничья по согласию', left: 'Соперник вышел',
        blocked: 'Нет ходов', nopieces: 'Все шашки взяты', kings: '15 ходов дамками без взятий',
      }[o.reason] || '';
      if (won || draw) sndEnd(); else beep(220, 0.3, 'sine', 0.1);
      const box = root.querySelector('.g-over');
      box.hidden = false;
      box.innerHTML = `<div class="g-over-card"><div class="g-res">${draw ? '½–½' : won ? '🏆' : '🏳️'}</div>
        <h3>${draw ? 'Ничья' : won ? 'Вы победили!' : 'Вы проиграли'}</h3><p class="mute">${why}</p>
        <div class="g-over-acts"><button class="btn" data-x="again">${sess.peer ? 'Реванш' : 'Ещё партию'}</button><button class="btn ghost" data-x="out">Выйти</button></div></div>`;
      box.querySelector('[data-x=out]').onclick = () => { leaveGame(false); openHub(''); };
      box.querySelector('[data-x=again]').onclick = () => {
        if (!sess.peer) return restartLocal(true);
        const peer = sess.peer, kind = sess.kind, color = my === 'w' ? 'b' : 'w';
        leaveGame(false); invite(kind, peer, color);
      };
      render();
    }

    function restartLocal(swap) {
      const color = swap ? (my === 'w' ? 'b' : 'w') : my;
      leaveGame(false);
      startGame({ id: rid(), kind: sess.kind, peer: '', ai: sess.ai, color, host: true });
    }

    // ---------- ввод: нажатие и перетаскивание ----------
    boardEl.addEventListener('pointerdown', (e) => {
      const sq = e.target.closest('.sq'); if (!sq) return;
      const i = +sq.dataset.i;
      const p = st.b[i];
      const mine = p !== '.' && (isChess ? Ch.colorOf(p) === my : p.toLowerCase() === my);
      if (mine && st.t === my && !over && legal.some((m) => m.f === i)) {
        drag = { i, x: e.clientX, y: e.clientY, moved: false, ghost: null, el: sq.querySelector('svg') };
        if (sel !== i) selectSq(i);
        try { boardEl.setPointerCapture(e.pointerId); } catch {}
      } else drag = null;
    });
    boardEl.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      if (!drag.moved) {
        drag.moved = true;
        const src = sqEls[flip ? 63 - drag.i : drag.i].querySelector('svg');
        if (!src) return;
        const size = sqEls[0].getBoundingClientRect().width * 1.15;
        drag.ghost = src.cloneNode(true);
        drag.ghost.classList.add('g-ghost');
        drag.ghost.style.width = drag.ghost.style.height = size + 'px';
        document.body.appendChild(drag.ghost);
        src.style.opacity = '.25';
      }
      if (drag.ghost) { const s = parseFloat(drag.ghost.style.width); drag.ghost.style.left = e.clientX - s / 2 + 'px'; drag.ghost.style.top = e.clientY - s * 0.75 + 'px'; }
    });
    const endDrag = (e) => {
      const d = drag; drag = null;
      if (!d) { const sq = e.target.closest && e.target.closest('.sq'); if (sq && e.type === 'pointerup') tap(+sq.dataset.i); return; }
      if (d.ghost) d.ghost.remove();
      if (!d.moved) { if (e.type === 'pointerup') tap(d.i === sel ? d.i : d.i); return; }
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const sq = under && under.closest && under.closest('.g-board .sq');
      if (sq && targets.includes(+sq.dataset.i)) tryMove(d.i, +sq.dataset.i);
      else render();
    };
    boardEl.addEventListener('pointerup', endDrag);
    boardEl.addEventListener('pointercancel', endDrag);

    // ---------- сеть ----------
    function findMove(mm) {
      return legal.find((m) => m.f === mm.f && m.t === mm.t && (m.pr || '') === (mm.pr || '') &&
        (isChess || (m.caps || []).join() === (mm.caps || []).join()));
    }
    function replay(list) {
      st = isChess ? Ch.fromFEN(Ch.START) : Dr.start(); keys = isChess ? [Ch.key(st)] : []; hist = []; legal = R.moves(st); over = null;
      for (const mm of list) {
        const m = findMove(mm); if (!m) break;
        const san = isChess ? Ch.san(st, m, legal) : Dr.notation(m);
        st = R.make(st, m); if (isChess) keys.push(Ch.key(st));
        hist.push({ f: m.f, t: m.t, pr: m.pr || '', caps: m.caps || [], san }); last = [m.f, m.t]; legal = R.moves(st);
      }
      render();
    }
    const ctrl = {
      onNet(m) {
        if (m.k === 'move') {
          if (m.n <= hist.length) return;                                  // повтор
          if (m.n !== hist.length + 1) return gsend({ k: 'sync?' });       // пропустили ход — просим всю партию
          const mv = findMove(m.m || {});
          if (!mv) return gsend({ k: 'sync?' });
          play(mv, true);
        } else if (m.k === 'sync?') gsend({ k: 'state', moves: hist.map((h) => ({ f: h.f, t: h.t, pr: h.pr, caps: h.caps })) });
        else if (m.k === 'state' && Array.isArray(m.moves) && m.moves.length > hist.length) replay(m.moves);
        else if (m.k === 'resign' && !over) finish({ result: my, reason: 'resign' });
        else if (m.k === 'draw?' && !over) infoSheet(`${dn(sess.peer)} предлагает ничью`, '', [
          { label: 'Согласиться', primary: true, on: () => { gsend({ k: 'draw-yes' }); finish({ result: 'draw', reason: 'agreed' }); } },
          { label: 'Играть дальше', on: () => gsend({ k: 'draw-no' }) },
        ]);
        else if (m.k === 'draw-yes' && !over) finish({ result: 'draw', reason: 'agreed' });
        else if (m.k === 'draw-no') toast('Соперник хочет играть дальше', 1800);
      },
      peerLeft() { if (!over) finish({ result: my, reason: 'left' }); },
      destroy() { destroyed = true; document.querySelectorAll('.g-ghost').forEach((g) => g.remove()); },
    };
    render();
    if (!sess.peer && st.t !== my) setTimeout(aiMove, 500);
    return ctrl;
  }

  // =====================================================================
  // «Танчики 3D» (игра из репозитория Tanks3D) — в окне-iframe; ходы и снимки поля идут через сервер
  // =====================================================================
  function startTanks(sess) {
    const role = !sess.peer ? 'solo' : sess.host ? 'host' : 'guest';
    show(`<div class="t3-root">
      ${sess.peer ? `<div class="t3-top">
        <div class="vslot t3-v" data-who="opp">${avaHTML(sess.peer, false)}</div>
        <div class="t3-names"><b>${esc(dn(sess.peer))}</b><small>${role === 'host' ? 'зелёный танк · вы — жёлтый' : 'жёлтый танк · вы — зелёный'}</small></div>
        ${callCtlHTML()}
        <div class="vslot t3-v" data-who="me">${avaHTML(me, false)}</div></div>` : ''}
      <iframe class="t3-frame" src="/tanks3d/index.html?embed=1&v=${typeof APP_VERSION !== 'undefined' ? APP_VERSION : 1}" allow="autoplay; fullscreen"></iframe></div>`);
    const fr = root.querySelector('.t3-frame');
    const post = (o) => { try { fr.contentWindow.postMessage(o, location.origin); } catch {} };
    const onMsg = (e) => {
      if (e.source !== fr.contentWindow || e.origin !== location.origin) return;
      const d = e.data || {};
      if (d.t === 'ready') post({ t: 'start', role });
      else if (d.t === 'send' && d.m && sess.peer) gsend(d.m, sess);
      else if (d.t === 'exit') { if (S === sess) { leaveGame(true); openHub(''); } }
    };
    window.addEventListener('message', onMsg);
    callControls();
    sess.ctrl = {
      onNet: (m) => post({ t: 'net', m }),
      peerLeft: () => post({ t: 'peerLeft' }),
      destroy: () => { window.removeEventListener('message', onMsg); try { fr.src = 'about:blank'; } catch {} },
    };
    refreshVideoUI();
  }


})();
