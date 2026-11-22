// Ahazang — правила настольных игр: шахматы и русские шашки (+ простой соперник-компьютер).
// Чистая логика без интерфейса: работает и в приложении, и в node (для проверок).
(function (root) {
  'use strict';

  // =====================================================================
  // ШАХМАТЫ
  // Доска — массив из 64 клеток: 0 = a8 … 7 = h8, 56 = a1 … 63 = h1.
  // Фигуры: KQRBNP — белые, kqrbnp — чёрные, '.' — пусто.
  // =====================================================================
  const Chess = {};
  const FILES = 'abcdefgh';
  const sqName = (i) => FILES[i & 7] + (8 - (i >> 3));
  const sqIndex = (n) => (8 - +n[1]) * 8 + FILES.indexOf(n[0]);
  const isW = (p) => p >= 'A' && p <= 'Z';
  const colorOf = (p) => (p === '.' ? null : isW(p) ? 'w' : 'b');
  const KN = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
  const KG = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
  const DIAG = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const ORTH = [[-1, 0], [1, 0], [0, -1], [0, 1]];

  Chess.START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  Chess.fromFEN = (fen) => {
    const [pos, t, cs, ep, h, n] = fen.trim().split(/\s+/);
    const b = [];
    for (const ch of pos.replace(/\//g, '')) {
      if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) b.push('.');
      else b.push(ch);
    }
    return { b, t: t || 'w', c: cs && cs !== '-' ? cs : '', ep: ep && ep !== '-' ? sqIndex(ep) : -1, h: +h || 0, n: +n || 1 };
  };

  Chess.toFEN = (s) => {
    let out = '';
    for (let r = 0; r < 8; r++) {
      let e = 0;
      for (let c = 0; c < 8; c++) {
        const p = s.b[r * 8 + c];
        if (p === '.') e++; else { if (e) out += e; e = 0; out += p; }
      }
      if (e) out += e;
      if (r < 7) out += '/';
    }
    return `${out} ${s.t} ${s.c || '-'} ${s.ep >= 0 ? sqName(s.ep) : '-'} ${s.h} ${s.n}`;
  };

  // клетка sq бьётся фигурами цвета by?
  function attacked(b, sq, by) {
    const r = sq >> 3, c = sq & 7;
    const P = by === 'w' ? 'P' : 'p', N = by === 'w' ? 'N' : 'n', B = by === 'w' ? 'B' : 'b',
      R = by === 'w' ? 'R' : 'r', Q = by === 'w' ? 'Q' : 'q', K = by === 'w' ? 'K' : 'k';
    // пешки: белая бьёт вверх (r-1), значит атакует sq с r+1
    const pr = by === 'w' ? r + 1 : r - 1;
    if (pr >= 0 && pr < 8) {
      if (c > 0 && b[pr * 8 + c - 1] === P) return true;
      if (c < 7 && b[pr * 8 + c + 1] === P) return true;
    }
    for (const [dr, dc] of KN) { const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === N) return true; }
    for (const [dr, dc] of KG) { const rr = r + dr, cc = c + dc; if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === K) return true; }
    for (const [dr, dc] of DIAG) {
      let rr = r + dr, cc = c + dc;
      while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
        const p = b[rr * 8 + cc];
        if (p !== '.') { if (p === B || p === Q) return true; break; }
        rr += dr; cc += dc;
      }
    }
    for (const [dr, dc] of ORTH) {
      let rr = r + dr, cc = c + dc;
      while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
        const p = b[rr * 8 + cc];
        if (p !== '.') { if (p === R || p === Q) return true; break; }
        rr += dr; cc += dc;
      }
    }
    return false;
  }
  Chess.attacked = attacked;

  const kingSq = (b, side) => b.indexOf(side === 'w' ? 'K' : 'k');
  Chess.inCheck = (s, side = s.t) => { const k = kingSq(s.b, side); return k >= 0 && attacked(s.b, k, side === 'w' ? 'b' : 'w'); };

  // все ходы без учёта шаха своему королю
  function pseudo(s) {
    const b = s.b, me = s.t, out = [];
    const own = (p) => p !== '.' && colorOf(p) === me;
    const foe = (p) => p !== '.' && colorOf(p) !== me;
    const add = (f, t, extra) => out.push(Object.assign({ f, t, p: b[f], x: b[t] }, extra));
    for (let f = 0; f < 64; f++) {
      const p = b[f]; if (!own(p)) continue;
      const r = f >> 3, c = f & 7, u = p.toUpperCase();
      if (u === 'P') {
        const d = me === 'w' ? -1 : 1, startR = me === 'w' ? 6 : 1, lastR = me === 'w' ? 0 : 7;
        const r1 = r + d;
        if (r1 >= 0 && r1 < 8) {
          const t1 = r1 * 8 + c;
          const push = (t, extra) => {
            if (r1 === lastR) for (const pr of 'QRBN') add(f, t, Object.assign({ pr: me === 'w' ? pr : pr.toLowerCase() }, extra));
            else add(f, t, extra);
          };
          if (b[t1] === '.') {
            push(t1);
            const t2 = (r + 2 * d) * 8 + c;
            if (r === startR && b[t2] === '.') add(f, t2, { dbl: true });
          }
          for (const dc of [-1, 1]) {
            const cc = c + dc; if (cc < 0 || cc > 7) continue;
            const t = r1 * 8 + cc;
            if (foe(b[t])) push(t);
            else if (t === s.ep) add(f, t, { ep: true, x: me === 'w' ? 'p' : 'P' });
          }
        }
      } else if (u === 'N' || u === 'K') {
        for (const [dr, dc] of u === 'N' ? KN : KG) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || rr > 7 || cc < 0 || cc > 7) continue;
          const t = rr * 8 + cc;
          if (!own(b[t])) add(f, t);
        }
        if (u === 'K') {
          const opp = me === 'w' ? 'b' : 'w';
          const home = me === 'w' ? 60 : 4;
          if (f === home && !attacked(b, f, opp)) {
            const ks = me === 'w' ? 'K' : 'k', qs = me === 'w' ? 'Q' : 'q', rook = me === 'w' ? 'R' : 'r';
            if (s.c.includes(ks) && b[f + 1] === '.' && b[f + 2] === '.' && b[f + 3] === rook &&
              !attacked(b, f + 1, opp) && !attacked(b, f + 2, opp)) add(f, f + 2, { cs: 'K' });
            if (s.c.includes(qs) && b[f - 1] === '.' && b[f - 2] === '.' && b[f - 3] === '.' && b[f - 4] === rook &&
              !attacked(b, f - 1, opp) && !attacked(b, f - 2, opp)) add(f, f - 2, { cs: 'Q' });
          }
        }
      } else {
        const dirs = u === 'B' ? DIAG : u === 'R' ? ORTH : DIAG.concat(ORTH);
        for (const [dr, dc] of dirs) {
          let rr = r + dr, cc = c + dc;
          while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
            const t = rr * 8 + cc;
            if (own(b[t])) break;
            add(f, t);
            if (b[t] !== '.') break;
            rr += dr; cc += dc;
          }
        }
      }
    }
    return out;
  }

  // сделать ход → новое состояние (старое не меняется)
  Chess.make = (s, m) => {
    const b = s.b.slice(), me = s.t;
    b[m.t] = m.pr || b[m.f]; b[m.f] = '.';
    if (m.ep) b[m.t + (me === 'w' ? 8 : -8)] = '.';
    if (m.cs === 'K') { b[m.f + 1] = b[m.f + 3]; b[m.f + 3] = '.'; }
    if (m.cs === 'Q') { b[m.f - 1] = b[m.f - 4]; b[m.f - 4] = '.'; }
    let c = s.c;
    const strip = (chars) => { for (const ch of chars) c = c.replace(ch, ''); };
    if (m.p === 'K') strip('KQ'); if (m.p === 'k') strip('kq');
    for (const sq of [m.f, m.t]) {
      if (sq === 63) strip('K'); if (sq === 56) strip('Q');
      if (sq === 7) strip('k'); if (sq === 0) strip('q');
    }
    return {
      b, t: me === 'w' ? 'b' : 'w', c,
      ep: m.dbl ? (m.f + m.t) / 2 : -1,
      h: m.p.toUpperCase() === 'P' || m.x !== '.' ? 0 : s.h + 1,
      n: me === 'b' ? s.n + 1 : s.n,
    };
  };

  Chess.moves = (s) => pseudo(s).filter((m) => { const n = Chess.make(s, m); return !Chess.inCheck(n, s.t); });

  // запись хода (SAN): Nf3, exd5, O-O, e8=Q+, Qxf7#
  Chess.san = (s, m, legal) => {
    let out;
    if (m.cs) out = m.cs === 'K' ? 'O-O' : 'O-O-O';
    else {
      const u = m.p.toUpperCase(), cap = m.x !== '.' || m.ep;
      if (u === 'P') out = (cap ? FILES[m.f & 7] + 'x' : '') + sqName(m.t) + (m.pr ? '=' + m.pr.toUpperCase() : '');
      else {
        const same = (legal || Chess.moves(s)).filter((o) => o.p === m.p && o.t === m.t && o.f !== m.f);
        let dis = '';
        if (same.length) {
          const fileOk = !same.some((o) => (o.f & 7) === (m.f & 7)), rankOk = !same.some((o) => (o.f >> 3) === (m.f >> 3));
          dis = fileOk ? FILES[m.f & 7] : rankOk ? String(8 - (m.f >> 3)) : sqName(m.f);
        }
        out = u + dis + (cap ? 'x' : '') + sqName(m.t);
      }
    }
    const n = Chess.make(s, m);
    if (Chess.inCheck(n)) out += Chess.moves(n).length ? '+' : '#';
    return out;
  };

  // позиция для повторений (без счётчиков ходов)
  Chess.key = (s) => s.b.join('') + s.t + s.c + s.ep;

  // недостаточно материала для мата
  Chess.insufficient = (s) => {
    const rest = s.b.filter((p) => p !== '.' && p.toUpperCase() !== 'K');
    if (!rest.length) return true;
    if (rest.length === 1 && 'BbNn'.includes(rest[0])) return true;
    if (rest.every((p) => 'Bb'.includes(p))) {
      const colors = new Set();
      s.b.forEach((p, i) => { if ('Bb'.includes(p)) colors.add(((i >> 3) + (i & 7)) % 2); });
      return colors.size === 1;
    }
    return false;
  };

  /** Итог партии: null — продолжается; иначе { result: 'w'|'b'|'draw', reason } */
  Chess.outcome = (s, keys) => {
    const legal = Chess.moves(s);
    if (!legal.length) return Chess.inCheck(s) ? { result: s.t === 'w' ? 'b' : 'w', reason: 'mate' } : { result: 'draw', reason: 'stalemate' };
    if (Chess.insufficient(s)) return { result: 'draw', reason: 'material' };
    if (s.h >= 100) return { result: 'draw', reason: 'fifty' };
    if (keys) { const k = Chess.key(s); if (keys.filter((x) => x === k).length >= 3) return { result: 'draw', reason: 'repetition' }; }
    return null;
  };

  // perft — проверка генератора ходов
  Chess.perft = (s, d) => { if (!d) return 1; let n = 0; for (const m of Chess.moves(s)) n += Chess.perft(Chess.make(s, m), d - 1); return n; };

  // ---------- соперник-компьютер: альфа-бета на 3 полухода + взятия ----------
  const VAL = { P: 100, N: 320, B: 330, R: 500, Q: 900, K: 0 };
  // таблицы «где фигуре лучше стоять» (для белых, a8…h1)
  const PST = {
    P: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
    N: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
    B: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
    R: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
    Q: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
    K: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
  };
  function evaluate(s) { // с точки зрения стороны, которая ходит
    let sc = 0;
    for (let i = 0; i < 64; i++) {
      const p = s.b[i]; if (p === '.') continue;
      const u = p.toUpperCase();
      const v = VAL[u] + PST[u][isW(p) ? i : (7 - (i >> 3)) * 8 + (i & 7)];
      sc += isW(p) ? v : -v;
    }
    return s.t === 'w' ? sc : -sc;
  }
  const order = (ms) => ms.sort((a, b) => (b.x !== '.' ? VAL[b.x.toUpperCase()] * 10 - VAL[b.p.toUpperCase()] : 0) + (b.pr ? 800 : 0) -
    ((a.x !== '.' ? VAL[a.x.toUpperCase()] * 10 - VAL[a.p.toUpperCase()] : 0) + (a.pr ? 800 : 0)));
  function quiesce(s, alpha, beta, depth) {
    const stand = evaluate(s);
    if (stand >= beta) return beta;
    if (alpha < stand) alpha = stand;
    if (depth <= 0) return alpha;
    for (const m of order(Chess.moves(s).filter((m) => m.x !== '.'))) {
      const v = -quiesce(Chess.make(s, m), -beta, -alpha, depth - 1);
      if (v >= beta) return beta;
      if (v > alpha) alpha = v;
    }
    return alpha;
  }
  function search(s, depth, alpha, beta, ply) {
    const ms = Chess.moves(s);
    if (!ms.length) return Chess.inCheck(s) ? -100000 + ply : 0;
    if (depth === 0) return quiesce(s, alpha, beta, 4);
    for (const m of order(ms)) {
      const v = -search(Chess.make(s, m), depth - 1, -beta, -alpha, ply + 1);
      if (v >= beta) return beta;
      if (v > alpha) alpha = v;
    }
    return alpha;
  }
  /** Лучший ход для стороны, которая ходит. level: 1 — легко, 2 — средне, 3 — сложно */
  Chess.bestMove = (s, level = 2) => {
    const ms = order(Chess.moves(s));
    if (!ms.length) return null;
    const depth = level >= 3 ? 3 : level === 2 ? 2 : 1;
    // немного случайности, чтобы партии не повторялись; окно поиска шире на величину случайности,
    // иначе «отсечённый» ход мог бы случайно обойти лучший
    const noise = level === 1 ? 60 : 12;
    let best = null, bestV = -Infinity, alpha = -Infinity;
    for (const m of ms) {
      const exact = -search(Chess.make(s, m), depth - 1, -Infinity, -(alpha - noise), 1);
      const v = exact + (Math.abs(exact) > 50000 ? 0 : Math.random() * noise);
      if (v > bestV) { bestV = v; best = m; }
      if (exact > alpha) alpha = exact;
    }
    return best;
  };
  Chess.sqName = sqName;
  Chess.sqIndex = sqIndex;
  Chess.colorOf = colorOf;

  // =====================================================================
  // РУССКИЕ ШАШКИ
  // Те же 64 клетки; играют на тёмных ((r + c) % 2 === 1). w/b — простые, W/B — дамки.
  // Белые внизу и ходят вверх. Бить обязательно (назад тоже), можно выбрать любой вариант взятия,
  // но довести его до конца; дамка «летает»; ставшая дамкой во время взятия бьёт дальше как дамка.
  // =====================================================================
  const Dr = {};
  Dr.start = () => {
    const b = Array(64).fill('.');
    for (let i = 0; i < 64; i++) {
      const r = i >> 3, c = i & 7;
      if ((r + c) % 2 !== 1) continue;
      if (r < 3) b[i] = 'b'; else if (r > 4) b[i] = 'w';
    }
    return { b, t: 'w', quiet: 0 };
  };
  const side = (p) => (p === '.' ? null : p.toLowerCase());
  const inB = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8;

  function captures(b, from, piece, me) {
    const out = [];
    const king0 = piece === piece.toUpperCase();
    const walk = (sq, king, caps, path) => {
      const r = sq >> 3, c = sq & 7;
      let found = false;
      for (const [dr, dc] of DIAG) {
        if (king) {
          let rr = r + dr, cc = c + dc;
          while (inB(rr, cc) && (b[rr * 8 + cc] === '.' || rr * 8 + cc === from)) { rr += dr; cc += dc; }
          if (!inB(rr, cc)) continue;
          const mid = rr * 8 + cc;
          if (side(b[mid]) === me || caps.includes(mid)) continue;
          let lr = rr + dr, lc = cc + dc;
          while (inB(lr, lc) && (b[lr * 8 + lc] === '.' || lr * 8 + lc === from)) {
            found = true;
            walk(lr * 8 + lc, true, caps.concat(mid), path.concat(lr * 8 + lc));
            lr += dr; lc += dc;
          }
        } else {
          const mr = r + dr, mc = c + dc, lr = r + 2 * dr, lc = c + 2 * dc;
          if (!inB(lr, lc)) continue;
          const mid = mr * 8 + mc, land = lr * 8 + lc;
          if (b[mid] === '.' || side(b[mid]) === me || caps.includes(mid)) continue;
          if (b[land] !== '.' && land !== from) continue;
          found = true;
          const promo = (me === 'w' && lr === 0) || (me === 'b' && lr === 7);
          walk(land, promo, caps.concat(mid), path.concat(land));
        }
      }
      if (!found && caps.length) out.push({ f: from, t: sq, path, caps, king: king && !king0 });
    };
    walk(from, king0, [], [from]);
    return out;
  }

  Dr.moves = (s) => {
    const me = s.t, b = s.b, caps = [], quiet = [];
    for (let i = 0; i < 64; i++) {
      const p = b[i]; if (side(p) !== me) continue;
      caps.push(...captures(b, i, p, me));
    }
    if (caps.length) return caps;
    for (let i = 0; i < 64; i++) {
      const p = b[i]; if (side(p) !== me) continue;
      const r = i >> 3, c = i & 7, king = p === p.toUpperCase();
      for (const [dr, dc] of DIAG) {
        if (!king && dr !== (me === 'w' ? -1 : 1)) continue;
        let rr = r + dr, cc = c + dc;
        while (inB(rr, cc) && b[rr * 8 + cc] === '.') {
          const t = rr * 8 + cc;
          const promo = !king && ((me === 'w' && rr === 0) || (me === 'b' && rr === 7));
          quiet.push({ f: i, t, path: [i, t], caps: [], king: promo });
          if (!king) break;
          rr += dr; cc += dc;
        }
      }
    }
    return quiet;
  };

  Dr.make = (s, m) => {
    const b = s.b.slice();
    let p = b[m.f];
    b[m.f] = '.';
    for (const c of m.caps) b[c] = '.';
    if (m.king) p = p.toUpperCase();
    b[m.t] = p;
    return { b, t: s.t === 'w' ? 'b' : 'w', quiet: m.caps.length || p === p.toLowerCase() ? 0 : (s.quiet || 0) + 1 };
  };

  Dr.outcome = (s) => {
    if (!Dr.moves(s).length) return { result: s.t === 'w' ? 'b' : 'w', reason: s.b.some((p) => side(p) === s.t) ? 'blocked' : 'nopieces' };
    if ((s.quiet || 0) >= 30) return { result: 'draw', reason: 'kings' }; // 15 ходов каждой стороны только дамками без взятий
    return null;
  };

  Dr.notation = (m) => Chess.sqName(m.f) + (m.caps.length ? ':' + m.path.slice(1).map(Chess.sqName).join(':') : '-' + Chess.sqName(m.t));

  function drEval(s) {
    let sc = 0;
    for (let i = 0; i < 64; i++) {
      const p = s.b[i]; if (p === '.') continue;
      const r = i >> 3, c = i & 7;
      let v = p === 'w' || p === 'b' ? 100 : 300;
      if (p === 'w') v += (7 - r) * 4; if (p === 'b') v += r * 4;
      if (c > 1 && c < 6 && r > 1 && r < 6) v += 4;
      sc += side(p) === 'w' ? v : -v;
    }
    return s.t === 'w' ? sc : -sc;
  }
  function drSearch(s, d, a, be) {
    const ms = Dr.moves(s);
    if (!ms.length) return -100000 - d;
    if (d === 0) return drEval(s);
    for (const m of ms) {
      const v = -drSearch(Dr.make(s, m), d - 1, -be, -a);
      if (v >= be) return be;
      if (v > a) a = v;
    }
    return a;
  }
  Dr.bestMove = (s, level = 2) => {
    const ms = Dr.moves(s);
    if (!ms.length) return null;
    const depth = level >= 3 ? 6 : level === 2 ? 4 : 2;
    let best = null, bestV = -Infinity;
    for (const m of ms) {
      const v = -drSearch(Dr.make(s, m), depth - 1, -Infinity, Infinity) + Math.random() * (level === 1 ? 80 : 10);
      if (v > bestV) { bestV = v; best = m; }
    }
    return best;
  };

  root.HXChess = Chess;
  root.HXDraughts = Dr;
  if (typeof module !== 'undefined') module.exports = { Chess, Dr };
})(typeof window !== 'undefined' ? window : globalThis);
