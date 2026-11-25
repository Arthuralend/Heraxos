// Ahazang — «Морской бой»: поле 10×10, флот 4-3-3-2-2-2-1-1-1-1, корабли не касаются друг друга.
// Вдвоём: каждый расставляет флот у себя (соперник его не видит), выстрел → ответ «мимо / ранил / убил».
(function () {
  'use strict';
  const N = 10, FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
  const COLS = 'АБВГДЕЖЗИК';
  const idx = (x, y) => y * N + x;

  /** Случайная расстановка флота (корабли не касаются даже углами) */
  function placeFleet(rnd = Math.random) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const busy = new Uint8Array(N * N), ships = [];
      let ok = true;
      for (const len of FLEET) {
        let placed = false;
        for (let t = 0; t < 300 && !placed; t++) {
          const hor = rnd() < 0.5, x0 = Math.floor(rnd() * (hor ? N - len + 1 : N)), y0 = Math.floor(rnd() * (hor ? N : N - len + 1));
          const cells = []; for (let k = 0; k < len; k++) cells.push(hor ? idx(x0 + k, y0) : idx(x0, y0 + k));
          if (cells.some((c) => busy[c])) continue;
          ships.push({ cells, hits: 0 });
          for (const c of cells) {
            const cx = c % N, cy = (c / N) | 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
              const nx = cx + dx, ny = cy + dy; if (nx >= 0 && ny >= 0 && nx < N && ny < N) busy[idx(nx, ny)] = 1;
            }
          }
          placed = true;
        }
        if (!placed) { ok = false; break; }
      }
      if (ok) return ships;
    }
    return null;
  }
  const around = (cells) => {
    const out = new Set(), own = new Set(cells);
    for (const c of cells) {
      const cx = c % N, cy = (c / N) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = cx + dx, ny = cy + dy; if (nx >= 0 && ny >= 0 && nx < N && ny < N && !own.has(idx(nx, ny))) out.add(idx(nx, ny));
      }
    }
    return [...out];
  };

  // ---------- компьютер: «охота» по шахматке + добивание раненого ----------
  function aiShot(view, level) {
    // view[c]: 0 — неизвестно, 1 — мимо, 2 — ранен, 3 — убит/рядом с убитым
    const wounded = []; for (let c = 0; c < N * N; c++) if (view[c] === 2) wounded.push(c);
    const free = (c) => c >= 0 && c < N * N && view[c] === 0;
    if (wounded.length && (level >= 2 || Math.random() < 0.6)) {
      const xs = wounded.map((c) => c % N), ys = wounded.map((c) => (c / N) | 0);
      let cand = [];
      if (wounded.length > 1 && ys.every((y) => y === ys[0])) {
        const y = ys[0], mn = Math.min(...xs), mx = Math.max(...xs);
        if (mn > 0) cand.push(idx(mn - 1, y)); if (mx < N - 1) cand.push(idx(mx + 1, y));
      } else if (wounded.length > 1 && xs.every((x) => x === xs[0])) {
        const x = xs[0], mn = Math.min(...ys), mx = Math.max(...ys);
        if (mn > 0) cand.push(idx(x, mn - 1)); if (mx < N - 1) cand.push(idx(x, mx + 1));
      } else {
        const c = wounded[0], x = c % N, y = (c / N) | 0;
        if (x > 0) cand.push(idx(x - 1, y)); if (x < N - 1) cand.push(idx(x + 1, y));
        if (y > 0) cand.push(idx(x, y - 1)); if (y < N - 1) cand.push(idx(x, y + 1));
      }
      cand = cand.filter(free);
      if (cand.length) return cand[Math.floor(Math.random() * cand.length)];
    }
    let pool = [];
    for (let c = 0; c < N * N; c++) if (free(c) && (level < 3 || ((c % N) + ((c / N) | 0)) % 2 === 0)) pool.push(c);
    if (!pool.length) for (let c = 0; c < N * N; c++) if (free(c)) pool.push(c);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  const ART = `<svg viewBox="0 0 100 100" class="art"><defs><linearGradient id="sw" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5aa9d6"/><stop offset="1" stop-color="#2b6f9e"/></linearGradient></defs><rect x="8" y="8" width="84" height="84" rx="10" fill="url(#sw)"/><path d="M8 70q10-6 21 0t21 0 21 0 21 0v22H8z" fill="#1f5c86" opacity=".6"/><path d="M22 56h50l-7 11H30z" fill="#e9eef2"/><rect x="38" y="44" width="18" height="12" rx="2" fill="#cfd8df"/><rect x="45" y="34" width="4" height="10" fill="#9aa8b3"/><circle cx="73" cy="30" r="8" fill="#ff7a45"/><circle cx="73" cy="30" r="4" fill="#ffd26a"/></svg>`;

  window.HXG = window.HXG || {};
  window.HXG.sea = {
    title: 'Морской бой', sub: 'Найдите и потопите флот соперника — 10 кораблей', art: ART,
    start(sess, api) {
      const solo = !sess.peer;
      const firstMine = sess.color === 'w';
      let mine = placeFleet(), myGrid = new Uint8Array(N * N);   // по моему полю: 0 пусто, 1 мимо, 2 попал
      let enemyView = new Uint8Array(N * N);                         // что знаю о поле соперника: 0/1 мимо/2 ранен/3 убит/4 точно пусто
      let enemyShips = [];                                           // потопленные корабли соперника (клетки)
      let aiFleet = solo ? placeFleet() : null, aiView = new Uint8Array(N * N);
      let phase = 'place', meReady = false, oppReady = solo, turn = '', over = false, destroyed = false, view = 'own', shotN = 0, waitRes = false;
      let lastShot = -1, lastIn = -1;

      api.frame('Морской бой', `<div class="sea-tabs" hidden><button data-v="enemy">Поле соперника</button><button data-v="own">Моё поле</button></div>
        <div class="sea-wrap"><div class="sea-lbl sea-top">${[...COLS].map((c) => `<i>${c}</i>`).join('')}</div><div class="sea-lbl sea-left">${[...Array(N)].map((_, i) => `<i>${i + 1}</i>`).join('')}</div><div class="sea"></div></div>
        <div class="sea-mini" hidden></div>`,
        `<button class="pill" data-x="shuffle">🔀 Перемешать</button><button class="btn sea-go" data-x="ready">В бой!</button>`);
      const R = api.root, grid = R.querySelector('.sea'), mini = R.querySelector('.sea-mini'), foot = R.querySelector('.gx-foot');
      for (let c = 0; c < N * N; c++) { const d = document.createElement('div'); d.className = 'sc'; d.dataset.c = c; grid.appendChild(d); }
      for (let c = 0; c < N * N; c++) { const d = document.createElement('div'); d.className = 'sc'; mini.appendChild(d); }
      R.querySelectorAll('.sea-tabs button').forEach((b) => (b.onclick = () => { view = b.dataset.v; render(); }));

      const shipAt = (ships, c) => ships.find((s) => s.cells.includes(c));
      const alive = (ships) => ships.filter((s) => s.hits < s.cells.length).length;
      function shipCls(ships, c) {
        const s = shipAt(ships, c); if (!s) return '';
        const k = s.cells.indexOf(c), n = s.cells.length, hor = n > 1 && s.cells[1] - s.cells[0] === 1;
        return ' ship' + (n === 1 ? ' s1' : (hor ? ' h' : ' v') + (k === 0 ? ' a' : k === n - 1 ? ' z' : ' m'));
      }
      function paint(el, c, mode) {
        let cls = 'sc';
        if (mode === 'own') {
          cls += shipCls(mine, c);
          if (myGrid[c] === 1) cls += ' miss'; else if (myGrid[c] === 2) cls += ' hit' + (shipAt(mine, c).hits === shipAt(mine, c).cells.length ? ' sunk' : '');
          if (c === lastIn) cls += ' last';
        } else {
          const v = enemyView[c];
          if (v === 3) cls += shipCls(enemyShips, c) + ' hit sunk';
          else if (v === 2) cls += ' hit';
          else if (v === 1) cls += ' miss';
          else if (v === 4) cls += ' near';
          else if (turn === 'me' && !over && !waitRes) cls += ' aim';
          if (c === lastShot) cls += ' last';
          if (over && v !== 3 && enemyShips.revealed) { cls += shipCls(enemyShips.revealed, c); }
        }
        el.className = cls;
      }
      function render() {
        const battle = phase === 'battle';
        R.querySelector('.sea-tabs').hidden = !battle;
        const showEnemy = battle && view === 'enemy';
        R.querySelectorAll('.sea-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.v === view));
        grid.classList.toggle('enemy', showEnemy);
        grid.querySelectorAll('.sc').forEach((el, c) => paint(el, c, showEnemy ? 'enemy' : 'own'));
        mini.hidden = !battle;
        mini.querySelectorAll('.sc').forEach((el, c) => paint(el, c, showEnemy ? 'own' : 'enemy'));
        const fleetDots = (ships, total) => `<span class="sea-fl">🚢 ${total} из 10</span>`;
        if (phase === 'place') {
          api.bars(null, meReady ? 'Готов, ждём соперника…' : 'Расставьте корабли', oppReady ? (solo ? '' : 'Готов') : 'Расставляет корабли…');
          foot.innerHTML = meReady ? '<span class="mute">Ждём, когда соперник расставит флот…</span>' : `<button class="pill" data-x="shuffle">🔀 Перемешать</button><button class="btn sea-go" data-x="ready">В бой!</button>`;
          const sh = foot.querySelector('[data-x=shuffle]'), rd = foot.querySelector('[data-x=ready]');
          if (sh) sh.onclick = () => { mine = placeFleet(); api.beep(500, 0.04); render(); };
          if (rd) rd.onclick = ready;
        } else {
          const enemyLeft = 10 - enemyShips.length;
          api.bars(over ? null : turn, over ? '' : turn === 'me' ? 'Ваш выстрел' : '', over ? '' : turn === 'opp' ? (solo ? 'Компьютер целится…' : 'Целится…') : '',
            fleetDots(mine, alive(mine)), fleetDots(null, enemyLeft));
          foot.innerHTML = over ? '' : `<button class="pill" data-x="resign">${solo ? 'Новая партия' : 'Сдаться'}</button>`;
          const rs = foot.querySelector('[data-x=resign]');
          if (rs) rs.onclick = () => (solo ? api.restart() : api.resign(() => { api.send({ k: 'resign', ships: mine.map((s) => s.cells) }); finish(false, 'Вы сдались'); }));
        }
      }

      function ready() {
        meReady = true; api.beep(660, 0.08);
        if (!solo) api.send({ k: 'ready' });
        maybeStart(); render();
      }
      function maybeStart() {
        if (!meReady || !oppReady || phase !== 'place') return;
        phase = 'battle'; turn = firstMine ? 'me' : 'opp'; view = turn === 'me' ? 'enemy' : 'own';
        api.sndEnd(); render();
        if (solo && turn === 'opp') setTimeout(aiTurn, 900);
      }

      // ---------- мои выстрелы ----------
      grid.addEventListener('click', (e) => {
        const el = e.target.closest('.sc'); if (!el || phase !== 'battle' || view !== 'enemy' || turn !== 'me' || over || waitRes) return;
        const c = +el.dataset.c; if (enemyView[c]) return;
        lastShot = c; waitRes = true; splash(el, 'shot'); api.beep(240, 0.09, 'sawtooth', 0.05);
        if (solo) setTimeout(() => onResult(c, defend(aiFleet, aiView, c)), 380);
        else api.send({ k: 'shot', n: ++shotN, c });
        render();
      });
      // ответ на выстрел по полю (своему или компьютера)
      function defend(ships, gridArr, c) {
        const s = shipAt(ships, c);
        if (!s) { gridArr[c] = 1; return { r: 'miss' }; }
        if (gridArr[c] === 2) return { r: 'hit' };
        gridArr[c] = 2; s.hits++;
        if (s.hits === s.cells.length) return { r: 'sunk', cells: s.cells, lost: alive(ships) === 0 };
        return { r: 'hit' };
      }
      function onResult(c, res) {
        waitRes = false;
        if (res.r === 'miss') { enemyView[c] = 1; api.beep(180, 0.12, 'sine', 0.06); turn = 'opp'; setTimeout(() => { if (!over && turn === 'opp') { view = 'own'; render(); } }, 700); }
        else if (res.r === 'hit') { enemyView[c] = 2; api.sndCap(); }
        else if (res.r === 'sunk') {
          const cells = res.cells || [c]; enemyShips.push({ cells, hits: cells.length });
          for (const x of cells) enemyView[x] = 3; for (const x of around(cells)) if (!enemyView[x]) enemyView[x] = 4;
          api.sndCap(); setTimeout(() => api.beep(140, 0.25, 'sawtooth', 0.06), 120);
          if (res.lost) { if (res.ships) enemyShips.revealed = res.ships.map((cs) => ({ cells: cs, hits: 0 })); finish(true, 'Весь флот соперника потоплен'); }
        }
        render();
        const el = grid.querySelector(`.sc[data-c="${c}"]`); if (el && view === 'enemy') splash(el, res.r);
        if (solo && turn === 'opp' && !over) setTimeout(aiTurn, 1200);
      }

      // ---------- выстрелы по мне ----------
      function incoming(c) {
        const res = defend(mine, myGrid, c); lastIn = c;
        if (view !== 'own') { view = 'own'; }
        render();
        const el = grid.querySelector(`.sc[data-c="${c}"]`); if (el) splash(el, res.r);
        if (res.r === 'miss') { turn = 'me'; api.beep(180, 0.12, 'sine', 0.06); setTimeout(() => { if (!over && turn === 'me') { view = 'enemy'; render(); } }, 800); }
        else { api.sndCap(); if (res.lost) { res.ships = mine.map((s) => s.cells); setTimeout(() => finish(false, 'Ваш флот потоплен'), 600); } }
        render();
        return res;
      }
      function aiTurn() {
        if (destroyed || over || turn !== 'opp') return;
        const c = aiShot(aiView.view || (aiView.view = new Uint8Array(N * N)), sess.ai || 2);
        const res = incoming(c), v = aiView.view;
        if (res.r === 'miss') v[c] = 1;
        else if (res.r === 'hit') v[c] = 2;
        else { for (const x of res.cells) v[x] = 3; for (const x of around(res.cells)) if (!v[x]) v[x] = 3; }
        if (!over && turn === 'opp') setTimeout(aiTurn, 850);
      }

      function splash(el, kind) {
        const f = document.createElement('i'); f.className = 'sea-fx ' + kind; el.appendChild(f);
        setTimeout(() => f.remove(), 900);
      }
      function finish(won, why) {
        if (over) return; over = true; turn = '';
        if (!won && !solo) api.send({ k: 'fleet', ships: mine.map((s) => s.cells) });
        if (won && !solo) api.send({ k: 'fleet', ships: mine.map((s) => s.cells) });
        if (solo && !won) enemyShips.revealed = aiFleet;
        view = won ? 'enemy' : 'own'; render();
        api.over(won ? 'win' : 'lose', why);
      }

      render();
      return {
        onNet(m) {
          if (m.k === 'ready') { oppReady = true; maybeStart(); render(); }
          else if (m.k === 'shot' && phase === 'battle' && turn === 'opp' && !over) { const res = incoming(+m.c); api.send({ k: 'res', n: m.n, c: +m.c, ...res }); }
          else if (m.k === 'res' && waitRes && +m.c === lastShot) onResult(+m.c, m);
          else if (m.k === 'fleet' && Array.isArray(m.ships)) { enemyShips.revealed = m.ships.map((cs) => ({ cells: cs, hits: 0 })); if (view === 'enemy') render(); }
          else if (m.k === 'resign' && !over) { if (Array.isArray(m.ships)) enemyShips.revealed = m.ships.map((cs) => ({ cells: cs, hits: 0 })); finish(true, 'Соперник сдался'); }
        },
        peerLeft() { if (!over) finish(true, 'Соперник вышел'); },
        destroy() { destroyed = true; },
      };
    },
  };
  if (typeof module !== 'undefined') module.exports = { placeFleet, aiShot };
})();
