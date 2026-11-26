// Ahazang — «Эрудит»: составляйте слова (нарицательные существительные в начальной форме) на поле 15×15.
// Мешок с фишками тасуется из общего зерна (присылает пригласивший), ходы применяются одинаково у обоих.
// Словарь — erudit-words.txt (OpenCorpora, CC BY-SA), грузится при первом открытии игры.
(function () {
  'use strict';
  const N = 15, C = 7;
  const ALPHA = 'абвгдежзийклмнопрстуфхцчшщъыьэюя', CODE = 'abcdefghijklmnopqrstuvwxyzABCDEF';
  // буква: [количество, очки]
  const TILES = { а: [8, 1], б: [2, 3], в: [4, 1], г: [2, 3], д: [4, 2], е: [9, 1], ж: [1, 5], з: [2, 5], и: [6, 1], й: [1, 4], к: [4, 2], л: [4, 2], м: [3, 2], н: [5, 1], о: [10, 1], п: [4, 2], р: [5, 1], с: [5, 1], т: [5, 1], у: [4, 2], ф: [1, 10], х: [1, 5], ц: [1, 5], ч: [1, 5], ш: [1, 8], щ: [1, 10], ъ: [1, 10], ы: [2, 4], ь: [2, 3], э: [1, 8], ю: [1, 8], я: [2, 3], '*': [2, 0] };
  const VAL = (l) => (TILES[l] ? TILES[l][1] : 0);
  // премии: TW — слово ×3, DW — слово ×2, TL — буква ×3, DL — буква ×2
  const PREM = (() => {
    const m = new Array(N * N).fill('');
    const set = (list, t) => list.forEach(([r, c]) => { for (const [rr, cc] of [[r, c], [r, 14 - c], [14 - r, c], [14 - r, 14 - c], [c, r], [c, 14 - r], [14 - c, r], [14 - c, 14 - r]]) m[rr * N + cc] = t; });
    set([[0, 0], [0, 7]], 'TW');
    set([[1, 1], [2, 2], [3, 3], [4, 4], [7, 7]], 'DW');
    set([[1, 5], [5, 5]], 'TL');
    set([[0, 3], [2, 6], [3, 7], [6, 6]], 'DL');
    return m;
  })();
  const PLAB = { TW: 'слово<br>×3', DW: 'слово<br>×2', TL: 'буква<br>×3', DL: 'буква<br>×2' };

  // ---------- словарь ----------
  let DICT = null, dictP = null;
  function loadDict() {
    if (DICT) return Promise.resolve(DICT);
    dictP ||= fetch('/erudit-words.txt').then((r) => r.text()).then((t) => {
      const set = new Set(), map = {}; for (let i = 0; i < 32; i++) map[CODE[i]] = ALPHA[i];
      let prev = '';
      for (const line of t.split('\n')) {
        if (!line || line[0] === '#') continue;
        const k = +line[0], w = prev.slice(0, k) + [...line.slice(1)].map((ch) => map[ch] || ch).join('');
        set.add(w); prev = w;
      }
      DICT = set; return set;
    });
    return dictP;
  }

  // ---------- правила ----------
  function newGame(seed, rngOf, shuffle) {
    const bag = []; for (const [l, [n]] of Object.entries(TILES)) for (let i = 0; i < n; i++) bag.push(l);
    shuffle(bag, rngOf(seed));
    const G = { board: new Array(N * N).fill(null), bag, racks: { w: [], b: [] }, score: { w: 0, b: 0 }, t: 'w', passes: 0, n: 0, over: null, last: [] };
    for (let i = 0; i < C; i++) { G.racks.w.push(G.bag.pop()); G.racks.b.push(G.bag.pop()); }
    return G;
  }
  const other = (p) => (p === 'w' ? 'b' : 'w');
  const at = (G, r, c) => (r < 0 || c < 0 || r >= N || c >= N ? null : G.board[r * N + c]);

  /**
   * Проверить и посчитать ход. place: [{r,c,l,j}] (j — буква из звёздочки).
   * Возвращает { ok, err, words: [{w, score}], score, bad: [слова не из словаря] }
   */
  function evaluate(G, place, dict) {
    if (!place.length) return { ok: false, err: 'Выложите буквы' };
    const B = G.board.slice(), key = new Set();
    for (const p of place) { if (B[p.r * N + p.c] || key.has(p.r * N + p.c)) return { ok: false, err: 'Клетка занята' }; key.add(p.r * N + p.c); B[p.r * N + p.c] = { l: p.l, j: !!p.j }; }
    const rows = new Set(place.map((p) => p.r)), cols = new Set(place.map((p) => p.c));
    if (rows.size > 1 && cols.size > 1) return { ok: false, err: 'Буквы должны стоять в одну линию' };
    const hor = rows.size === 1 && (place.length > 1 || at({ board: B }, place[0].r, place[0].c - 1) || at({ board: B }, place[0].r, place[0].c + 1));
    // сплошная линия без пропусков
    const line = hor ? place.map((p) => p.c) : place.map((p) => p.r), fixed = hor ? place[0].r : place[0].c;
    const mn = Math.min(...line), mx = Math.max(...line);
    for (let k = mn; k <= mx; k++) if (!(hor ? B[fixed * N + k] : B[k * N + fixed])) return { ok: false, err: 'Между буквами не должно быть пустых клеток' };
    const first = !G.board.some(Boolean);
    if (first) { if (!key.has(7 * N + 7)) return { ok: false, err: 'Первое слово должно пройти через центр ★' }; if (place.length < 2) return { ok: false, err: 'Слово — хотя бы из двух букв' }; }
    else {
      const touches = place.some((p) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dr, dc]) => G.board[(p.r + dr) * N + (p.c + dc)] && p.r + dr >= 0 && p.r + dr < N && p.c + dc >= 0 && p.c + dc < N));
      if (!touches) return { ok: false, err: 'Слово должно касаться уже выложенных букв' };
    }
    const words = [];
    const scan = (r, c, dr, dc) => {
      while (at({ board: B }, r - dr, c - dc)) { r -= dr; c -= dc; }
      let w = '', s = 0, mult = 1, cells = [];
      while (at({ board: B }, r, c)) {
        const t = B[r * N + c], i = r * N + c, isNew = key.has(i); let v = t.j ? 0 : VAL(t.l);
        if (isNew) { if (PREM[i] === 'DL') v *= 2; if (PREM[i] === 'TL') v *= 3; if (PREM[i] === 'DW') mult *= 2; if (PREM[i] === 'TW') mult *= 3; }
        w += t.l; s += v; cells.push(i); r += dr; c += dc;
      }
      return { w, score: s * mult, cells };
    };
    const main = hor ? scan(place[0].r, place[0].c, 0, 1) : scan(place[0].r, place[0].c, 1, 0);
    if (main.w.length > 1) words.push(main);
    for (const p of place) { const x = hor ? scan(p.r, p.c, 1, 0) : scan(p.r, p.c, 0, 1); if (x.w.length > 1) words.push(x); }
    if (!words.length) return { ok: false, err: 'Слово — хотя бы из двух букв' };
    const bad = dict ? words.filter((x) => !dict.has(x.w)).map((x) => x.w) : [];
    let score = words.reduce((n, x) => n + x.score, 0);
    if (place.length === C) score += 15; // все 7 фишек — премия
    return { ok: !bad.length, err: bad.length ? `Нет в словаре: ${bad.map((x) => x.toUpperCase()).join(', ')}` : '', words, score, bad };
  }

  function applyPlay(G, p, place, score) {
    for (const t of place) {
      G.board[t.r * N + t.c] = { l: t.l, j: !!t.j };
      const rk = G.racks[p], i = rk.indexOf(t.j ? '*' : t.l); if (i >= 0) rk.splice(i, 1);
    }
    G.score[p] += score; G.passes = 0; G.last = place.map((t) => t.r * N + t.c);
    while (G.racks[p].length < C && G.bag.length) G.racks[p].push(G.bag.pop());
    if (!G.racks[p].length && !G.bag.length) return endGame(G, p);
    G.t = other(p); G.n++;
  }
  function applySwap(G, p, letters) {
    const rk = G.racks[p];
    if (letters.length && G.bag.length >= letters.length) {
      for (const l of letters) { const i = rk.indexOf(l); if (i >= 0) rk.splice(i, 1); }
      const back = letters.slice();
      for (let i = 0; i < back.length; i++) rk.push(G.bag.pop());
      // вернутые фишки кладём на дно мешка — порядок одинаков у обоих
      G.bag.unshift(...back);
    }
    G.passes++; G.last = [];
    if (G.passes >= 4) return endGame(G, null);
    G.t = other(p); G.n++;
  }
  function endGame(G, finisher) {
    for (const p of ['w', 'b']) {
      const left = G.racks[p].reduce((n, l) => n + VAL(l), 0);
      G.score[p] -= left; if (finisher && p !== finisher) G.score[finisher] += left;
    }
    G.over = { w: G.score.w, b: G.score.b };
    G.n++;
  }

  // ---------- компьютер: перебор слов из словаря по линиям поля ----------
  function aiMove(G, p, dict, level) {
    const rack = G.racks[p], jokers = rack.filter((l) => l === '*').length;
    const have = {}; for (const l of rack) if (l !== '*') have[l] = (have[l] || 0) + 1;
    const boardLetters = new Set(G.board.filter(Boolean).map((t) => t.l));
    const first = !G.board.some(Boolean);
    // слова, которые в принципе можно собрать: не больше 2 букв (или звёздочек) сверх руки
    const cand = [];
    for (const w of dict) {
      if (w.length > 9 || w.length < 2) continue;
      const need = {}; let miss = 0;
      for (const ch of w) { need[ch] = (need[ch] || 0) + 1; if (need[ch] > (have[ch] || 0)) { if (!boardLetters.has(ch) || first) miss++; else miss += 0.01; } }
      if (miss <= jokers + 0.5 && (first ? w.length <= rack.length : true)) cand.push(w);
    }
    let best = [], tries = 0;
    const lines = [];
    // только линии, где слово может коснуться уже выложенных букв (или центр — для первого хода)
    const rowBusy = (r) => r >= 0 && r < N && G.board.slice(r * N, r * N + N).some(Boolean);
    const colBusy = (c) => c >= 0 && c < N && [...Array(N)].some((_, r) => G.board[r * N + c]);
    for (let r = 0; r < N; r++) if (first ? r === 7 : rowBusy(r) || rowBusy(r - 1) || rowBusy(r + 1)) lines.push({ hor: true, k: r });
    for (let c = 0; c < N; c++) if (first ? c === 7 : colBusy(c) || colBusy(c - 1) || colBusy(c + 1)) lines.push({ hor: false, k: c });
    // длинные слова сначала — у них больше очков; при ограничении попыток не теряем лучшие
    cand.sort((a, b) => b.length - a.length);
    const limit = level >= 3 ? 40000 : 15000;
    for (const w of cand) {
      const L = w.length;
      for (const ln of lines) {
        for (let s = 0; s + L <= N; s++) {
          const cell = (i) => (ln.hor ? ln.k * N + s + i : (s + i) * N + ln.k);
          // соседи до и после слова должны быть пустыми
          const before = s - 1 >= 0 ? (ln.hor ? ln.k * N + s - 1 : (s - 1) * N + ln.k) : -1, after = s + L < N ? cell(L) : -1;
          if ((before >= 0 && G.board[before]) || (after >= 0 && G.board[after])) continue;
          let quick = true; for (let i = 0; i < L; i++) { const t = G.board[cell(i)]; if (t && t.l !== w[i]) { quick = false; break; } } if (!quick) continue;
          const left = { ...have }; let jk = jokers, place = [], ok = true, usesBoard = false;
          for (let i = 0; i < L; i++) {
            const ci = cell(i), t = G.board[ci];
            if (t) { if (t.l !== w[i]) { ok = false; break; } usesBoard = true; continue; }
            if (left[w[i]]) { left[w[i]]--; place.push({ r: (ci / N) | 0, c: ci % N, l: w[i] }); }
            else if (jk) { jk--; place.push({ r: (ci / N) | 0, c: ci % N, l: w[i], j: true }); }
            else { ok = false; break; }
          }
          if (!ok || !place.length || (!first && !usesBoard && !place.some((t) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dr, dc]) => at(G, t.r + dr, t.c + dc))))) continue;
          if (++tries > limit) break;
          const ev = evaluate(G, place, dict);
          if (ev.ok) best.push({ place, score: ev.score });
        }
      }
    }
    if (!best.length) return null;
    best.sort((a, b) => b.score - a.score);
    if (level >= 3) return best[0];
    if (level === 2) return best[Math.floor(Math.random() * Math.min(4, best.length))];
    return best[Math.floor(best.length * (0.3 + Math.random() * 0.7))] || best[best.length - 1];
  }

  // ---------- графика ----------
  const tileHTML = (l, j, cls = '', attrs = '') => `<div class="er-t ${j || l === '*' ? 'jk' : ''} ${cls}" ${attrs}><b>${l === '*' ? '★' : l.toUpperCase()}</b>${l === '*' || j ? '' : `<i>${VAL(l)}</i>`}</div>`;
  const ART = `<svg viewBox="0 0 100 100" class="art"><rect x="8" y="8" width="84" height="84" rx="10" fill="#efe3c6"/><g fill="#f7efdc" stroke="#c9b48a" stroke-width="1.5"><rect x="14" y="36" width="24" height="24" rx="4"/><rect x="40" y="36" width="24" height="24" rx="4"/><rect x="66" y="36" width="24" height="24" rx="4"/><rect x="40" y="10" width="24" height="24" rx="4"/><rect x="40" y="62" width="24" height="24" rx="4"/></g><g font-family="Georgia,serif" font-weight="700" font-size="17" fill="#3a2f22" text-anchor="middle"><text x="26" y="54">С</text><text x="52" y="54">Л</text><text x="78" y="54">О</text><text x="52" y="28">Ё</text><text x="52" y="80">Т</text></g></svg>`;

  window.HXG = window.HXG || {};
  window.HXG.erudit = {
    title: 'Эрудит', sub: 'Составляйте слова на поле — кто наберёт больше очков', art: ART,
    start(sess, api) {
      const solo = !sess.peer, my = sess.color, op = other(my);
      let G = null, dict = null, pend = [], selRack = -1, destroyed = false, ended = false, aiT = 0, seed = 0, swapMode = false, swapSel = new Set();

      api.frame('Эрудит', `<div class="er"><div class="er-view zoom"><div class="er-board"></div></div><div class="er-info"></div><div class="er-rack"></div></div>`, '');
      api.root.querySelector('.g-play').style.setProperty('--vs', 'clamp(70px, calc(100dvh - var(--sat) - var(--sab) - 650px), 124px)');
      const R = api.root, boardEl = R.querySelector('.er-board'), rackEl = R.querySelector('.er-rack'), info = R.querySelector('.er-info'), foot = R.querySelector('.gx-foot');
      for (let i = 0; i < N * N; i++) { const d = document.createElement('div'); d.className = 'er-c'; d.dataset.i = i; boardEl.appendChild(d); }
      // поле вдвое крупнее; двигается пальцем (прокрутка), кнопка 🔍 — показать целиком
      const view = R.querySelector('.er-view');
      let zoom = true;
      const fitFonts = () => boardEl.style.setProperty('--cs', boardEl.clientWidth / N + 'px');
      function setZoom(z, focus = 112) {
        zoom = z; view.classList.toggle('zoom', z); fitFonts();
        if (z) { const cs = boardEl.clientWidth / N, r = (focus / N) | 0, c = focus % N; view.scrollLeft = (c + 0.5) * cs - view.clientWidth / 2; view.scrollTop = (r + 0.5) * cs - view.clientHeight / 2; }
      }
      requestAnimationFrame(() => setZoom(true));
      window.addEventListener('resize', fitFonts);
      info.innerHTML = '<span class="mute">Загружаем словарь…</span>';

      const myRack = () => { // рука без выложенных в этом ходу фишек
        const rk = G.racks[my].slice(); for (const p of pend) { const i = rk.indexOf(p.j ? '*' : p.l); if (i >= 0) rk.splice(i, 1); } return rk;
      };
      function render() {
        if (!G) return;
        const prev = new Map(); R.querySelectorAll('.er [data-k]').forEach((e) => prev.set(e.dataset.k, e.getBoundingClientRect()));
        const pmap = new Map(pend.map((p) => [p.r * N + p.c, p]));
        const myTurn = G.t === my && !G.over;
        boardEl.querySelectorAll('.er-c').forEach((el, i) => {
          const t = G.board[i], p = pmap.get(i);
          el.className = 'er-c' + (PREM[i] ? ' ' + PREM[i] : '') + (i === 112 ? ' star' : '') + (G.last.includes(i) ? ' last' : '');
          el.innerHTML = t ? tileHTML(t.l, t.j, 'set') : p ? tileHTML(p.l, p.j, 'pend', `data-k="p${i}"`) : PREM[i] ? `<span>${i === 112 ? '★' : PLAB[PREM[i]]}</span>` : '';
        });
        const rk = myRack();
        rackEl.innerHTML = rk.map((l, k) => tileHTML(l, false, (selRack === k ? 'sel' : '') + (swapMode && swapSel.has(k) ? ' swap' : ''), `data-r="${k}" data-k="r${k}${l}"`)).join('');
        R.querySelectorAll('.er [data-k]').forEach((e) => { const r = prev.get(e.dataset.k); if (r) api.fly(e, r, 200); });
        // проверка хода на лету
        let ev = null;
        if (pend.length && dict) ev = evaluate(G, pend, dict);
        info.innerHTML = G.over ? '' : swapMode ? '<span class="mute">Отметьте фишки для обмена</span>'
          : ev ? (ev.ok ? `<span class="er-ok">+${ev.score} · ${ev.words.map((w) => w.w.toUpperCase()).join(', ')}</span>` : `<span class="er-bad">${ev.err}</span>`)
          : myTurn ? '<span class="mute">Нажмите фишку, затем клетку на поле</span>' : `<span class="mute">${solo ? 'Компьютер думает…' : 'Ход соперника'} · в мешке ${G.bag.length}</span>`;
        foot.innerHTML = G.over ? '' : !myTurn ? `<button class="pill" data-a="resign">${solo ? 'Новая партия' : 'Сдаться'}</button>`
          : swapMode ? `<button class="btn er-go" data-a="doswap">${swapSel.size ? `Обменять ${swapSel.size}` : 'Пропустить ход'}</button><button class="pill" data-a="noswap">Отмена</button>`
          : `<button class="btn er-go" data-a="play" ${ev && ev.ok ? '' : 'disabled'}>Сделать ход</button>${pend.length ? '<button class="pill" data-a="back">Вернуть</button>' : `<button class="pill" data-a="swap">Обмен / пас</button>`}<button class="pill" data-a="mix" title="Перемешать фишки">⤨</button><button class="pill" data-a="zoom" title="Масштаб">${zoom ? '🔍−' : '🔍+'}</button>`;
        foot.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => button(b.dataset.a)));
        const sc = (p) => `<span class="er-sc">${G.score[p]} очк.</span>`;
        api.bars(G.over ? null : myTurn ? 'me' : 'opp', G.over ? '' : myTurn ? 'Ваш ход' : '', G.over ? '' : !myTurn ? (solo ? 'Думает…' : 'Думает…') : '', sc(my), sc(op));
      }

      function button(a) {
        if (a === 'resign') return solo ? api.restart() : api.resign(() => { api.send({ k: 'resign' }); finish('lose', 'Вы сдались'); });
        if (a === 'back') { pend = []; selRack = -1; return render(); }
        if (a === 'zoom') { setZoom(!zoom); return render(); }
        if (a === 'mix') { const rk = G.racks[my]; api.shuffle(rk, Math.random); return render(); }
        if (a === 'swap') { if (G.bag.length < 7) { /* меняться нельзя — только пас */ } swapMode = true; swapSel.clear(); pend = []; return render(); }
        if (a === 'noswap') { swapMode = false; return render(); }
        if (a === 'doswap') {
          const rk = myRack(), letters = G.bag.length >= swapSel.size ? [...swapSel].map((k) => rk[k]) : [];
          swapMode = false; doAct({ t: 'swap', letters }); return;
        }
        if (a === 'play') {
          const ev = evaluate(G, pend, dict); if (!ev.ok) return;
          doAct({ t: 'play', place: pend.map((p) => ({ r: p.r, c: p.c, l: p.l, j: p.j ? 1 : 0 })), score: ev.score });
        }
      }

      function doAct(a, fromNet) {
        const p = fromNet ? op : my;
        if (G.t !== p || G.over) return;
        if (a.t === 'play') {
          const ev = evaluate(G, a.place, dict);
          if (!ev.ok && !fromNet) return;
          applyPlay(G, p, a.place, ev.words ? ev.score : a.score);
          api.sndCap();
        } else { applySwap(G, p, a.letters || []); api.beep(400, 0.06); }
        if (!fromNet) { pend = []; selRack = -1; if (!solo) api.send({ k: 'act', n: G.n, a }); }
        render();
        if (G.over) return finish(G.score[my] > G.score[op] ? 'win' : G.score[my] < G.score[op] ? 'lose' : 'draw', `Счёт ${G.score[my]} : ${G.score[op]}`);
        if (solo && G.t === op) aiTurn();
      }

      function aiTurn() {
        clearTimeout(aiT);
        aiT = setTimeout(() => {
          if (destroyed || !G || G.over || G.t !== op) return;
          const mv = aiMove(G, op, dict, sess.ai || 2);
          if (mv) { applyPlay(G, op, mv.place, mv.score); api.sndCap(); }
          else { const rk = G.racks[op]; applySwap(G, op, G.bag.length >= 7 ? rk.filter((l) => VAL(l) >= 5 || l === 'ъ' || l === 'ь').slice(0, 3) : []); }
          render();
          if (G.over) finish(G.score[my] > G.score[op] ? 'win' : G.score[my] < G.score[op] ? 'lose' : 'draw', `Счёт ${G.score[my]} : ${G.score[op]}`);
        }, 700);
      }

      // ---------- нажатия ----------
      rackEl.addEventListener('click', (e) => {
        const t = e.target.closest('.er-t'); if (!t || !G || G.t !== my || G.over) return;
        const k = +t.dataset.r;
        if (swapMode) { swapSel.has(k) ? swapSel.delete(k) : swapSel.add(k); return render(); }
        selRack = selRack === k ? -1 : k; api.beep(700, 0.03, 'sine', 0.05); render();
      });
      boardEl.addEventListener('click', (e) => {
        const c = e.target.closest('.er-c'); if (!c || !G || G.t !== my || G.over || swapMode) return;
        const i = +c.dataset.i, r = (i / N) | 0, col = i % N;
        const pi = pend.findIndex((p) => p.r * N + p.c === i);
        if (pi >= 0) { pend.splice(pi, 1); return render(); }               // вернуть фишку в руку
        if (!zoom && selRack < 0) { setZoom(true, i); return render(); }
        if (G.board[i] || selRack < 0) return;
        const l = myRack()[selRack]; if (!l) return;
        if (l === '*') return askJoker((x) => { pend.push({ r, c: col, l: x, j: true }); selRack = -1; api.sndMove(); render(); });
        pend.push({ r, c: col, l }); selRack = -1; api.sndMove(); render();
      });
      function askJoker(cb) {
        infoSheet('Какую букву обозначит звёздочка?', `<div class="er-abc">${[...ALPHA].map((x) => `<button data-l="${x}">${x.toUpperCase()}</button>`).join('')}</div>`, [{ label: 'Отмена' }]);
        document.querySelectorAll('.er-abc [data-l]').forEach((b) => (b.onclick = () => { document.getElementById('info').classList.remove('on'); cb(b.dataset.l); }));
      }

      function finish(res, why) { if (ended) return; ended = true; clearTimeout(aiT); render(); api.over(res, why); }

      function begin(s) {
        seed = s; G = newGame(s, api.rng, api.shuffle);
        loadDict().then((d) => { dict = d; if (destroyed) return; render(); if (solo && G.t === op) aiTurn(); }).catch(() => { info.innerHTML = '<span class="er-bad">Не удалось загрузить словарь</span>'; });
      }
      if (solo || sess.host) { const s = (Math.random() * 2 ** 31) | 0; begin(s); if (!solo) api.send({ k: 'init', seed: s }); }
      else { api.send({ k: 'hello' }); loadDict(); }

      return {
        onNet(m) {
          if (m.k === 'init' && !G) begin(+m.seed);
          else if (m.k === 'hello' && sess.host && G) api.send({ k: 'init', seed });
          else if (m.k === 'act' && G && m.a && m.n === G.n + 1) { const go = () => doAct(m.a, true); dict ? go() : loadDict().then((d) => { dict = d; go(); }); }
          else if (m.k === 'resign' && !ended) finish('win', 'Соперник сдался');
        },
        peerLeft() { if (!ended) finish('win', 'Соперник вышел'); },
        destroy() { destroyed = true; clearTimeout(aiT); },
      };
    },
  };
  if (typeof module !== 'undefined') module.exports = { newGame, evaluate, applyPlay, applySwap, aiMove, PREM, TILES };
})();
