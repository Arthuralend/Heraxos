// Ahazang — «Дурак» подкидной на двоих: 36 карт, козырь — нижняя карта колоды.
// Колода тасуется из общего зерна (его присылает пригласивший), дальше оба применяют одни и те же действия.
(function () {
  'use strict';
  const SUITS = ['♠', '♥', '♦', '♣'], RED = [false, true, true, false];
  const RANKS = { 6: '6', 7: '7', 8: '8', 9: '9', 10: '10', 11: 'В', 12: 'Д', 13: 'К', 14: 'Т' };
  const rk = (c) => c >> 2, st = (c) => c & 3;               // карта = ранг*4 + масть
  const other = (p) => (p === 'w' ? 'b' : 'w');

  // ---------- правила ----------
  function deal(seed, rngOf, shuffle) {
    const deck = []; for (let r = 6; r <= 14; r++) for (let s = 0; s < 4; s++) deck.push(r * 4 + s);
    shuffle(deck, rngOf(seed));
    const S = { deck, trump: st(deck[0]), trumpCard: deck[0], hands: { w: [], b: [] }, table: [], att: 'w', taking: false, out: null, log: 0 };
    for (let i = 0; i < 6; i++) { S.hands.w.push(S.deck.pop()); S.hands.b.push(S.deck.pop()); }
    // первым ходит тот, у кого младший козырь
    const low = (p) => Math.min(99, ...S.hands[p].filter((c) => st(c) === S.trump).map(rk));
    S.att = low('b') < low('w') ? 'b' : 'w';
    return S;
  }
  const def = (S) => other(S.att);
  const beats = (S, a, d) => (st(d) === st(a) ? rk(d) > rk(a) : st(d) === S.trump && st(a) !== S.trump);
  const openCount = (S) => S.table.filter((x) => x.d == null).length;
  const ranksOnTable = (S) => new Set(S.table.flatMap((x) => (x.d == null ? [rk(x.a)] : [rk(x.a), rk(x.d)])));
  function canAttack(S, p, c) {
    if (S.out || p !== S.att || !S.hands[p].includes(c)) return false;
    if (S.table.length >= 6) return false;
    if (openCount(S) + 1 > S.hands[def(S)].length) return false;
    return !S.table.length || ranksOnTable(S).has(rk(c));
  }
  const canDefend = (S, p, c, i) => !S.out && !S.taking && p === def(S) && S.hands[p].includes(c) && S.table[i] && S.table[i].d == null && beats(S, S.table[i].a, c);
  const canTake = (S, p) => !S.out && !S.taking && p === def(S) && openCount(S) > 0;
  const canBito = (S, p) => !S.out && !S.taking && p === S.att && S.table.length > 0 && openCount(S) === 0;
  const canGive = (S, p) => !S.out && S.taking && p === S.att;
  function refill(S, first) {
    for (const p of [first, other(first)]) while (S.hands[p].length < 6 && S.deck.length) S.hands[p].push(S.deck.pop());
  }
  function checkEnd(S) {
    if (S.deck.length) return;
    const w = S.hands.w.length, b = S.hands.b.length;
    if (!w && !b) S.out = { draw: true };
    else if (!w) S.out = { fool: 'b' };
    else if (!b) S.out = { fool: 'w' };
  }
  /** Применить действие. Возвращает true, если оно допустимо */
  function apply(S, p, a) {
    const rm = (c) => S.hands[p].splice(S.hands[p].indexOf(c), 1);
    if (a.t === 'att' && canAttack(S, p, a.c)) { rm(a.c); S.table.push({ a: a.c, d: null }); }
    else if (a.t === 'def' && canDefend(S, p, a.c, a.i)) { rm(a.c); S.table[a.i].d = a.c; if (!S.deck.length && !S.hands[p].length && openCount(S) === 0) { S.table = []; checkEnd(S); } }
    else if (a.t === 'take' && canTake(S, p)) S.taking = true;
    else if (a.t === 'bito' && canBito(S, p)) { S.table = []; refill(S, S.att); S.att = def(S); checkEnd(S); }
    else if (a.t === 'give' && canGive(S, p)) {
      const d = def(S); for (const x of S.table) { S.hands[d].push(x.a); if (x.d != null) S.hands[d].push(x.d); }
      S.table = []; S.taking = false; refill(S, S.att); checkEnd(S);
    } else return false;
    // атакующий выложил всё, а защитник всё отбил и карт больше нет — автоматически бито
    S.log++;
    return true;
  }

  // ---------- компьютер ----------
  const cost = (S, c) => rk(c) + (st(c) === S.trump ? 20 : 0);
  function aiAction(S, p, level) {
    const hand = S.hands[p].slice().sort((x, y) => cost(S, x) - cost(S, y));
    if (p === S.att) {
      const throwable = hand.filter((c) => canAttack(S, p, c));
      if (!S.table.length) return { t: 'att', c: level <= 1 ? throwable[Math.floor(Math.random() * Math.min(3, throwable.length))] : throwable[0] };
      // подкидываем дешёвые карты; козыри и тузы бережём, пока колода не кончилась
      const cheap = throwable.filter((c) => S.deck.length < 4 || (st(c) !== S.trump && rk(c) < (level >= 3 ? 12 : 14)));
      if (cheap.length && (level > 1 || Math.random() < 0.7)) return { t: 'att', c: cheap[0] };
      if (S.taking) return { t: 'give' };
      if (canBito(S, p)) return { t: 'bito' };
      return null;
    }
    if (S.taking) return null;
    const i = S.table.findIndex((x) => x.d == null); if (i < 0) return null;
    const opts = hand.filter((c) => beats(S, S.table[i].a, c));
    if (!opts.length) return { t: 'take' };
    const c = opts[0];
    // на «сложном» не тратим старшие козыри в начале игры на мелочь
    if (level >= 3 && st(c) === S.trump && rk(c) >= 12 && S.deck.length > 10 && S.table.length <= 2) return { t: 'take' };
    return { t: 'def', c, i };
  }

  // ---------- графика ----------
  const cardHTML = (c, cls = '') => `<div class="dk-card ${RED[st(c)] ? 'red' : ''} ${cls}" data-k="${c}"><b>${RANKS[rk(c)]}<i>${SUITS[st(c)]}</i></b><span>${SUITS[st(c)]}</span><b class="br">${RANKS[rk(c)]}<i>${SUITS[st(c)]}</i></b></div>`;
  const backHTML = (k, cls = '') => `<div class="dk-card back ${cls}" ${k != null ? `data-k="${k}"` : ''}></div>`;
  const ART = `<svg viewBox="0 0 100 100" class="art"><rect x="8" y="8" width="84" height="84" rx="10" fill="#2f6b4f"/><g transform="rotate(-14 40 56)"><rect x="20" y="26" width="34" height="48" rx="5" fill="#fff" stroke="#d8d2c4"/><text x="26" y="40" font-size="11" font-weight="700" fill="#c0392b">Т</text><text x="37" y="60" font-size="18" fill="#c0392b">♥</text></g><g transform="rotate(10 62 54)"><rect x="46" y="28" width="34" height="48" rx="5" fill="#fff" stroke="#d8d2c4"/><text x="52" y="42" font-size="11" font-weight="700" fill="#1d1d1d">К</text><text x="62" y="62" font-size="18" fill="#1d1d1d">♠</text></g></svg>`;

  window.HXG = window.HXG || {};
  window.HXG.durak = {
    title: 'Дурак', sub: 'Подкидной на двоих: отбейтесь и избавьтесь от карт', art: ART,
    start(sess, api) {
      const solo = !sess.peer, my = sess.color, op = other(my);
      let S = null, sel = -1, destroyed = false, aiT = 0, ended = false;

      api.frame('Дурак', `<div class="dk">
          <div class="dk-opp"></div>
          <div class="dk-mid"><div class="dk-deck"></div><div class="dk-table"></div></div>
          <div class="dk-hand"></div>
        </div>`, '');
      const R = api.root, oppEl = R.querySelector('.dk-opp'), deckEl = R.querySelector('.dk-deck'), tableEl = R.querySelector('.dk-table'), handEl = R.querySelector('.dk-hand'), foot = R.querySelector('.gx-foot');

      function start(seed) {
        S = deal(seed, api.rng, api.shuffle);
        render(); api.sndMove();
        if (solo) schedule();
      }

      function render() {
        if (!S) { handEl.innerHTML = '<div class="mute dk-wait">Раздаём карты…</div>'; api.bars(null, '', ''); return; }
        // запоминаем, где были карты, чтобы плавно перелететь
        const prev = new Map(); R.querySelectorAll('.dk [data-k]').forEach((e) => prev.set(e.dataset.k, e.getBoundingClientRect()));
        const deckRect = deckEl.getBoundingClientRect();
        const iAtt = S.att === my, iDef = !iAtt;
        // соперник: рубашки веером
        const oh = S.hands[op];
        oppEl.innerHTML = oh.map((c, k) => backHTML(c, '')).join('');
        oppEl.style.setProperty('--n', oh.length);
        // колода и козырь
        deckEl.innerHTML = S.deck.length ? `${cardHTML(S.trumpCard, 'trump')}${S.deck.length > 1 ? backHTML(null, 'pile') : ''}<em>${S.deck.length}</em>` : `<div class="dk-trump-only">${SUITS[S.trump]}</div>`;
        // стол
        tableEl.innerHTML = S.table.map((x, i) => `<div class="dk-pair ${x.d == null && iDef && !S.taking && sel >= 0 && beats(S, x.a, sel) ? 'target' : ''}" data-i="${i}">${cardHTML(x.a)}${x.d != null ? cardHTML(x.d, 'cover') : ''}</div>`).join('');
        // моя рука
        const hand = S.hands[my].slice().sort((x, y) => (st(x) === S.trump) - (st(y) === S.trump) || st(x) - st(y) || rk(x) - rk(y));
        const playable = (c) => (iAtt ? canAttack(S, my, c) : S.table.some((x, i) => canDefend(S, my, c, i)));
        handEl.innerHTML = hand.map((c) => cardHTML(c, (playable(c) ? 'can' : 'dim') + (sel === c ? ' sel' : ''))).join('');
        handEl.style.setProperty('--n', hand.length);
        // анимация перелёта
        R.querySelectorAll('.dk [data-k]').forEach((e) => { const r = prev.get(e.dataset.k) || (e.closest('.dk-deck') ? null : deckRect); if (r) api.fly(e, r); });
        // кнопки и подписи
        let btn = '';
        if (!S.out) {
          if (canBito(S, my)) btn = '<button class="btn dk-btn" data-a="bito">Бито</button>';
          else if (canGive(S, my)) btn = '<button class="btn dk-btn" data-a="give">Забирай</button>';
          else if (canTake(S, my)) btn = '<button class="btn ghost dk-btn" data-a="take">Беру</button>';
        }
        foot.innerHTML = btn + (S.out ? '' : `<button class="pill" data-a="resign">${solo ? 'Новая партия' : 'Сдаться'}</button>`);
        foot.querySelectorAll('[data-a]').forEach((b) => (b.onclick = () => {
          if (b.dataset.a === 'resign') return solo ? api.restart() : api.resign(() => { api.send({ k: 'resign' }); finish('lose', 'Вы сдались'); });
          act({ t: b.dataset.a });
        }));
        const meSt = S.out ? '' : iAtt ? (S.taking ? 'Подкиньте или «Забирай»' : S.table.length ? (openCount(S) ? 'Соперник отбивается' : 'Подкиньте или «Бито»') : 'Ваш ход') : S.taking ? 'Вы берёте' : openCount(S) ? 'Отбивайтесь' : 'Ждём…';
        const opSt = S.out ? '' : !iAtt ? (S.table.length ? 'Подкидывает…' : 'Ходит…') : S.taking ? 'Берёт' : openCount(S) ? 'Отбивается…' : '';
        const turn = S.out ? null : ((iAtt && (!S.table.length || !openCount(S) || S.taking)) || (iDef && openCount(S) && !S.taking)) ? 'me' : 'opp';
        api.bars(turn, meSt, opSt, `<span class="dk-cnt">карт: ${S.hands[my].length}</span>`, `<span class="dk-cnt">карт: ${S.hands[op].length}</span>`);
      }

      // ---------- мои действия ----------
      handEl.addEventListener('click', (e) => {
        const el = e.target.closest('.dk-card'); if (!el || !S || S.out) return;
        const c = +el.dataset.k;
        if (S.att === my) { if (canAttack(S, my, c)) act({ t: 'att', c }); return; }
        const targets = S.table.map((x, i) => i).filter((i) => canDefend(S, my, c, i));
        if (!targets.length) { sel = -1; render(); return; }
        if (targets.length === 1) return act({ t: 'def', c, i: targets[0] });
        sel = sel === c ? -1 : c; render();
      });
      tableEl.addEventListener('click', (e) => {
        const pr = e.target.closest('.dk-pair'); if (!pr || sel < 0) return;
        const i = +pr.dataset.i; if (canDefend(S, my, sel, i)) { const c = sel; sel = -1; act({ t: 'def', c, i }); }
      });

      function act(a, fromNet) {
        const p = fromNet ? op : my;
        if (!S || !apply(S, p, a)) return false;
        sel = -1;
        if (!fromNet && !solo) api.send({ k: 'act', n: S.log, a });
        if (a.t === 'att' || a.t === 'def') api.sndMove(); else if (a.t === 'take' || a.t === 'give') api.sndCap(); else api.beep(420, 0.06);
        render();
        if (S.out) return finish(S.out.draw ? 'draw' : S.out.fool === my ? 'lose' : 'win', S.out.draw ? 'Карты кончились у обоих одновременно' : S.out.fool === my ? 'Вы остались в дураках' : 'Соперник остался в дураках');
        if (solo) schedule();
        return true;
      }
      function schedule() {
        clearTimeout(aiT);
        aiT = setTimeout(() => {
          if (destroyed || !S || S.out) return;
          const a = aiAction(S, op, sess.ai || 2);
          if (a && apply(S, op, a)) {
            if (a.t === 'att' || a.t === 'def') api.sndMove(); else api.sndCap();
            render();
            if (S.out) return finish(S.out.draw ? 'draw' : S.out.fool === my ? 'lose' : 'win', S.out.draw ? 'Карты кончились у обоих одновременно' : S.out.fool === my ? 'Вы остались в дураках' : 'Соперник остался в дураках');
            schedule();
          }
        }, 750);
      }
      function finish(res, why) { if (ended) return; ended = true; clearTimeout(aiT); render(); api.over(res, why); }

      // раздача: пригласивший придумывает зерно и присылает его
      let seed = 0;
      if (solo || sess.host) { seed = (Math.random() * 2 ** 31) | 0; start(seed); if (!solo) api.send({ k: 'init', seed }); }
      else { render(); api.send({ k: 'hello' }); }

      return {
        onNet(m) {
          if (m.k === 'init' && !S) start(+m.seed);
          else if (m.k === 'hello' && sess.host && S) api.send({ k: 'init', seed });
          else if (m.k === 'act' && S && m.a) { if (m.n === S.log + 1) act(m.a, true); }
          else if (m.k === 'resign' && !ended) finish('win', 'Соперник сдался');
        },
        peerLeft() { if (!ended) finish('win', 'Соперник вышел'); },
        destroy() { destroyed = true; clearTimeout(aiT); },
      };
    },
  };
  if (typeof module !== 'undefined') module.exports = { deal, apply, aiAction, canAttack, canDefend };
})();
