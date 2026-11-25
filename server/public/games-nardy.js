// Ahazang — правила длинных нард. Поле — 24 пункта по кругу (абсолютные номера 0..23).
// Каждый игрок идёт по своему пути 0..23 («относительные» номера): 0 — голова, 18..23 — дом.
// Белые: относительный = абсолютный; чёрные: сдвиг на 12. Оба ходят в одну сторону.
(function (root) {
  'use strict';
  const OFF = { w: 0, b: 12 };
  const other = (p) => (p === 'w' ? 'b' : 'w');
  const toAbs = (p, r) => (r + OFF[p]) % 24;
  const toRel = (p, a) => (a - OFF[p] + 24) % 24;

  /** Начальная позиция: по 15 шашек на голове */
  function start() {
    const c = new Array(24).fill(0), o = new Array(24).fill('');
    c[toAbs('w', 0)] = 15; o[toAbs('w', 0)] = 'w';
    c[toAbs('b', 0)] = 15; o[toAbs('b', 0)] = 'b';
    return { c, o, off: { w: 0, b: 0 }, t: 'w', turns: { w: 0, b: 0 } };
  }
  const clone = (s) => ({ c: s.c.slice(), o: s.o.slice(), off: { ...s.off }, t: s.t, turns: { ...s.turns } });

  // все ли шашки игрока в доме (18..23 относительных)
  function allHome(s, p) {
    for (let a = 0; a < 24; a++) if (s.o[a] === p && s.c[a] && toRel(p, a) < 18) return false;
    return true;
  }

  // правило блока: нельзя ставить 6 подряд, если впереди блока нет ни одной шашки соперника
  function badPrime(s, p) {
    const q = other(p);
    let run = 0;
    for (let r = 0; r < 24; r++) {
      const a = toAbs(p, r);
      run = s.o[a] === p && s.c[a] ? run + 1 : 0;
      if (run >= 6) {
        // блок — относительные пункты r-5..r игрока p; в координатах соперника
        const qs = []; for (let k = r - 5; k <= r; k++) qs.push(toRel(q, toAbs(p, k)));
        const max = Math.max(...qs), wraps = qs.includes(23) && qs.includes(0);
        if (wraps) return true;
        let ahead = false;
        for (let a = 0; a < 24; a++) if (s.o[a] === q && s.c[a] && toRel(q, a) > max) { ahead = true; break; }
        if (!ahead) return true;
      }
    }
    return false;
  }

  /** Один шаг: шашка с относительного пункта r на кубик d. Возвращает {f, t, d} (t = 24 — выброс) или null */
  function stepOK(s, p, r, d, headUsed, headLimit) {
    const a = toAbs(p, r);
    if (s.o[a] !== p || !s.c[a]) return null;
    if (r === 0 && headUsed >= headLimit) return null;
    const t = r + d;
    if (t < 24) {
      const b = toAbs(p, t);
      if (s.c[b] && s.o[b] !== p) return null;
      return { f: r, t, d };
    }
    if (!allHome(s, p)) return null;
    if (t === 24) return { f: r, t: 24, d };
    for (let k = 18; k < r; k++) { const b = toAbs(p, k); if (s.o[b] === p && s.c[b]) return null; }
    return { f: r, t: 24, d };
  }

  function apply(s, p, m) {
    const n = clone(s), a = toAbs(p, m.f);
    n.c[a]--; if (!n.c[a]) n.o[a] = '';
    if (m.t >= 24) n.off[p]++;
    else { const b = toAbs(p, m.t); n.c[b]++; n.o[b] = p; }
    return n;
  }

  const key = (s) => s.c.join(',') + s.o.join('') + s.off.w + '/' + s.off.b;

  /**
   * Все допустимые варианты хода целиком (с учётом обязательного использования максимума кубиков).
   * Возвращает { seqs: [[{f,t,d}..]..], max }
   */
  function turnSeqs(s, dice) {
    const p = s.t;
    const doubles = dice[0] === dice[1];
    const list = doubles ? [dice[0], dice[0], dice[0], dice[0]] : [dice[0], dice[1]];
    // голова: одна шашка за ход; в первый ход с 6-6, 4-4, 3-3 — две
    const headLimit = s.turns[p] === 0 && doubles && [6, 4, 3].includes(dice[0]) ? 2 : 1;
    const out = []; let best = 0; const seen = new Set();
    function rec(st, left, head, path) {
      let moved = false;
      const tried = new Set();
      for (let i = 0; i < left.length; i++) {
        const d = left[i]; if (tried.has(d)) continue; tried.add(d);
        for (let r = 0; r < 24; r++) {
          const m = stepOK(st, p, r, d, head, headLimit); if (!m) continue;
          const n = apply(st, p, m);
          if (badPrime(n, p)) continue;
          moved = true;
          const rest = left.slice(0, i).concat(left.slice(i + 1));
          const k = key(n) + '|' + rest.join('') + '|' + (head + (r === 0 ? 1 : 0));
          if (seen.has(k)) continue; seen.add(k);
          rec(n, rest, head + (r === 0 ? 1 : 0), path.concat([m]));
        }
      }
      if (!moved && path.length) {
        if (path.length > best) { best = path.length; out.length = 0; }
        if (path.length === best) out.push(path);
      }
    }
    rec(s, list, 0, []);
    let seqs = out;
    // можно сыграть только один кубик — обязан больший, если возможно
    if (!doubles && best === 1) {
      const hi = Math.max(...list);
      if (seqs.some((q) => q[0].d === hi)) seqs = seqs.filter((q) => q[0].d === hi);
    }
    return { seqs, max: best, headLimit };
  }

  /** Сколько ещё шагов можно сделать оставшимися кубиками (максимум) */
  function depth(s, p, left, head, headLimit, memo) {
    if (!left.length) return 0;
    const k = key(s) + '|' + left.slice().sort().join('') + '|' + head;
    if (memo.has(k)) return memo.get(k);
    let best = 0; const tried = new Set();
    for (let i = 0; i < left.length && best < left.length; i++) {
      const d = left[i]; if (tried.has(d)) continue; tried.add(d);
      for (let r = 0; r < 24 && best < left.length; r++) {
        const m = stepOK(s, p, r, d, head, headLimit); if (!m) continue;
        const n = apply(s, p, m); if (badPrime(n, p)) continue;
        const rest = left.slice(0, i).concat(left.slice(i + 1));
        best = Math.max(best, 1 + depth(n, p, rest, head + (r === 0 ? 1 : 0), headLimit, memo));
      }
    }
    memo.set(k, best);
    return best;
  }

  /**
   * Допустимые следующие шаги (для игрока): left — оставшиеся кубики, head — сколько уже снято с головы.
   * first — это первый шаг хода (для правила «если играется один кубик — обязан больший»).
   */
  function nextSteps(s, left, head, headLimit, first) {
    const p = s.t, memo = new Map(), cand = [];
    let bestL = 0; const tried = new Set();
    for (let i = 0; i < left.length; i++) {
      const d = left[i]; if (tried.has(d)) continue; tried.add(d);
      for (let r = 0; r < 24; r++) {
        const m = stepOK(s, p, r, d, head, headLimit); if (!m) continue;
        const n = apply(s, p, m); if (badPrime(n, p)) continue;
        const rest = left.slice(0, i).concat(left.slice(i + 1));
        const L = 1 + depth(n, p, rest, head + (r === 0 ? 1 : 0), headLimit, memo);
        cand.push({ m, L }); bestL = Math.max(bestL, L);
      }
    }
    let out = cand.filter((x) => x.L === bestL).map((x) => x.m);
    if (first && bestL === 1 && left.length === 2 && left[0] !== left[1]) {
      const hi = Math.max(...left);
      if (out.some((m) => m.d === hi)) out = out.filter((m) => m.d === hi);
    }
    return out;
  }
  const headLimitFor = (s, dice) => (s.turns[s.t] === 0 && dice[0] === dice[1] && [6, 4, 3].includes(dice[0]) ? 2 : 1);

  function outcome(s) {
    for (const p of ['w', 'b']) if (s.off[p] === 15) return { result: p, reason: s.off[other(p)] === 0 ? 'mars' : 'oin' };
    return null;
  }

  // сумма очков до конца (меньше — лучше)
  function pips(s, p) {
    let n = 0;
    for (let a = 0; a < 24; a++) if (s.o[a] === p) n += s.c[a] * (24 - toRel(p, a));
    return n;
  }

  /** Компьютер: оценивает итоговые позиции всех вариантов хода */
  function bestSeq(s, dice, level) {
    const { seqs } = turnSeqs(s, dice);
    if (!seqs.length) return [];
    const p = s.t, q = other(p);
    let best = null, bestV = -1e9;
    for (const seq of seqs) {
      let n = s; for (const m of seq) n = apply(n, p, m);
      let v = -pips(n, p) * 1.0 + n.off[p] * 6;
      // занятые пункты на пути соперника мешают ему (особенно перед его домом)
      for (let a = 0; a < 24; a++) {
        if (n.o[a] !== p || !n.c[a]) continue;
        const rq = toRel(q, a), rp = toRel(p, a);
        if (rq >= 1 && rq <= 17) v += 1.5 + (rq >= 12 ? 1.5 : 0);
        if (rp === 0) v -= 0.3 * n.c[a];                     // не держать всё на голове
        if (n.c[a] > 4 && rp > 0) v -= (n.c[a] - 4) * 0.8;   // большие стопки
      }
      if (level <= 1) v += Math.random() * 25; else if (level === 2) v += Math.random() * 6;
      if (v > bestV) { bestV = v; best = seq; }
    }
    return best;
  }

  const Nardy = { start, clone, toAbs, toRel, other, apply, turnSeqs, nextSteps, headLimitFor, outcome, pips, bestSeq, allHome };
  root.HXNardy = Nardy;
  if (typeof module !== 'undefined') module.exports = Nardy;
})(typeof window !== 'undefined' ? window : globalThis);
