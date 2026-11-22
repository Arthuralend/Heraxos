// Ahazang — «Рубеж»: 3D-танки вдвоём против вражеской колонны. Защитите ядро!
// Поле 13×13 клеток (каждая делится на 2×2 кирпичика). Хозяин игры (пригласивший) считает всю игру
// и 15 раз в секунду рассылает снимок; второй игрок отправляет только нажатия пульта.
(() => {
  'use strict';
  let THREE = null;
  const N = 26;                          // клеток по стороне (полклетки поля)
  const E = 0, BR = 1, ST = 2, WA = 3, FO = 4, CO = 5;
  const UP = 0, RT = 1, DN = 2, LT = 3;
  const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
  const CORE = { x: 12, y: 24 };          // ядро: клетки 12..13 × 24..25
  const P_SPAWN = [{ x: 9, y: 25 }, { x: 17, y: 25 }];
  const E_SPAWN = [{ x: 1, y: 1 }, { x: 13, y: 1 }, { x: 25, y: 1 }];
  const ENEMIES_PER_LEVEL = 20;
  const TYPES = { // скорость (клеток/с), прочность, скорость снаряда, пауза между выстрелами
    p: { v: 5.2, hp: 1, bv: 17, cd: 0.32 },
    basic: { v: 3.6, hp: 1, bv: 12, cd: 1.6 },
    fast: { v: 6.4, hp: 1, bv: 13, cd: 1.8 },
    power: { v: 4.0, hp: 1, bv: 19, cd: 1.1 },
    heavy: { v: 3.0, hp: 4, bv: 13, cd: 1.4 },
  };
  const BONUSES = ['shield', 'freeze', 'life', 'fort', 'bomb'];
  const BONUS_ICON = { shield: '🛡', freeze: '⏸', life: '♥', fort: '🧱', bomb: '💥' };

  function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  // ---------------------------------------------------------------- карта
  /** Новая карта (своя для каждого уровня): симметричные стены, сталь, вода, лес, крепость вокруг ядра */
  function makeMap(seed) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const R = rng(seed + attempt * 7919);
      const m = new Uint8Array(N * N);
      const setT = (tx, ty, v, mask = 15) => { // тайл 2×2 клетки; mask — какие четверти
        const q = [[0, 0], [1, 0], [0, 1], [1, 1]];
        q.forEach(([dx, dy], i) => { if (mask & (1 << i)) m[(ty * 2 + dy) * N + tx * 2 + dx] = v; });
      };
      const density = 0.36 + R() * 0.12;
      for (let ty = 1; ty <= 10; ty++) for (let tx = 0; tx <= 6; tx++) {
        if (R() > density) continue;
        const r = R();
        let v = BR, mask = 15;
        if (r < 0.07) v = ST;
        else if (r < 0.13) v = WA;
        else if (r < 0.22) v = FO;
        else if (r < 0.45) mask = [3, 12, 5, 10][Math.floor(R() * 4)]; // полкирпича
        setT(tx, ty, v, mask);
        const mx = 12 - tx; // зеркально
        if (mx !== tx) setT(mx, ty, v, v === BR && mask !== 15 ? ({ 5: 10, 10: 5, 3: 3, 12: 12 }[mask]) : mask);
      }
      // свободные места: появление врагов (верх), игроков (низ), проход к ядру
      for (const s of E_SPAWN) for (let y = 0; y < 3; y++) for (let x = s.x - 1; x <= s.x + 1; x++) if (x >= 0 && x < N) m[y * N + x] = E;
      for (let y = 21; y < N; y++) for (let x = 0; x < N; x++) m[y * N + x] = E;
      // крепость вокруг ядра
      for (let y = 22; y < N; y++) for (let x = 10; x <= 15; x++) m[y * N + x] = BR;
      for (let y = 24; y < N; y++) for (let x = 12; x <= 13; x++) m[y * N + x] = CO;
      // немного стен снизу по бокам
      for (const x0 of [2, 3, 22, 23]) for (let y = 21; y <= 22; y++) m[y * N + x0] = R() < 0.6 ? BR : E;
      for (const p of P_SPAWN) for (let y = 23; y < N; y++) for (let x = p.x - 1; x <= p.x + 1; x++) if (m[y * N + x] !== CO) m[y * N + x] = E;
      for (let y = 22; y < N; y++) for (let x = 10; x <= 15; x++) if (!(x >= 11 && x <= 14 && y >= 23)) m[y * N + x] = BR;
      for (let y = 23; y < N; y++) for (let x = 11; x <= 14; x++) if (!(x >= 12 && x <= 13 && y >= 24)) m[y * N + x] = BR;
      if (reachable(m)) return m;
    }
    return new Uint8Array(N * N);
  }
  // можно ли от каждого места появления врагов дойти до ядра (кирпич можно пробить, сталь и вода — нет)
  function reachable(m) {
    const ok = (x, y) => x >= 0 && y >= 0 && x < N - 1 && y < N - 1 &&
      [m[y * N + x], m[y * N + x + 1], m[(y + 1) * N + x], m[(y + 1) * N + x + 1]].every((v) => v !== ST && v !== WA);
    for (const s of E_SPAWN) {
      const seen = new Uint8Array(N * N), q = [[s.x - 1, s.y - 1]];
      seen[(s.y - 1) * N + s.x - 1] = 1;
      let found = false;
      while (q.length && !found) {
        const [x, y] = q.shift();
        if (y >= 20) { found = true; break; }
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d], ny = y + DY[d];
          if (nx < 0 || ny < 0 || nx >= N || ny >= N || seen[ny * N + nx] || !ok(nx, ny)) continue;
          seen[ny * N + nx] = 1; q.push([nx, ny]);
        }
      }
      if (!found) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- игра (у хозяина)
  function Game(seed, two) {
    const g = {
      lv: 1, seed, map: makeMap(seed), mv: 1, tanks: [], bullets: [], fx: [], bonus: null,
      left: ENEMIES_PER_LEVEL, spawned: 0, spawnT: 1, state: 'play', stateT: 0, freezeT: 0, fortT: 0,
      lives: [3, two ? 3 : 0], kills: [0, 0], nextId: 1, R: rng(seed ^ 0x5bd1e995), two,
    };
    g.players = [null, null];
    const spawnPlayer = (i, shield = 3) => {
      const p = P_SPAWN[i];
      const t = { id: g.nextId++, team: 'p', pi: i, type: 'p', x: p.x, y: p.y, dir: UP, hp: 1, shield, cd: 0, bullet: 0, moving: false, input: { d: -1, f: 0 } };
      g.tanks.push(t); g.players[i] = t;
    };
    spawnPlayer(0); if (two) spawnPlayer(1);
    g.respawn = [0, 0];

    const cell = (x, y) => (x < 0 || y < 0 || x >= N || y >= N ? ST : g.map[y * N + x]);
    const blocks = (v) => v === BR || v === ST || v === WA || v === CO;
    const boxFree = (x, y, self) => {
      if (x < 1 || y < 1 || x > N - 1 || y > N - 1) return false;
      const x0 = Math.floor(x - 0.98), x1 = Math.floor(x + 0.98 - 1e-6), y0 = Math.floor(y - 0.98), y1 = Math.floor(y + 0.98 - 1e-6);
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) if (blocks(cell(xx, yy))) return false;
      for (const o of g.tanks) {
        if (o === self || o.dead) continue;
        if (Math.abs(o.x - x) < 1.9 && Math.abs(o.y - y) < 1.9 && !(Math.abs(o.x - self.x) < 1.9 && Math.abs(o.y - self.y) < 1.9)) return false;
      }
      return true;
    };
    const fx = (k, x, y, s = 1) => g.fx.push([k, +x.toFixed(2), +y.toFixed(2), s]);
    const setCell = (x, y, v) => { if (x >= 0 && y >= 0 && x < N && y < N && g.map[y * N + x] !== v) { g.map[y * N + x] = v; g.mv++; } };

    const tryMove = (t, d, dist) => {
      if (t.dir !== d) {
        // поворот: выравниваем по сетке полклетки, чтобы легко проезжать в проходы
        if (d === UP || d === DN) t.x = Math.round(t.x); else t.y = Math.round(t.y);
        t.dir = d;
      }
      const nx = t.x + DX[d] * dist, ny = t.y + DY[d] * dist;
      if (boxFree(nx, ny, t)) { t.x = nx; t.y = ny; return true; }
      return false;
    };

    const fire = (t) => {
      if (t.cd > 0 || t.bullet >= 1) return;
      const T = TYPES[t.type];
      t.cd = T.cd; t.bullet++;
      g.bullets.push({ x: t.x + DX[t.dir] * 1.0, y: t.y + DY[t.dir] * 1.0, dir: t.dir, v: T.bv, team: t.team, owner: t, power: t.type === 'power' || (t.team === 'p' && t.star) });
      fx('shot', t.x, t.y, t.team === 'p' ? t.pi : 2);
    };

    const kill = (t, by) => {
      t.dead = true;
      fx('boom', t.x, t.y, 2);
      if (t.team === 'e') {
        g.left--;
        if (by && by.team === 'p') g.kills[by.pi]++;
        if (t.carrier) dropBonus();
      } else {
        g.players[t.pi] = null;
        g.respawn[t.pi] = 1.6;
      }
    };
    const dropBonus = () => {
      for (let i = 0; i < 30; i++) {
        const x = 2 + Math.floor(g.R() * 22), y = 2 + Math.floor(g.R() * 18);
        g.bonus = { k: BONUSES[Math.floor(g.R() * BONUSES.length)], x, y, t: 15 };
        return;
      }
    };
    const takeBonus = (p) => {
      const b = g.bonus; g.bonus = null;
      fx('bonus', b.x, b.y, 1);
      if (b.k === 'shield') p.shield = 10;
      else if (b.k === 'freeze') g.freezeT = 8;
      else if (b.k === 'life') g.lives[p.pi]++;
      else if (b.k === 'bomb') for (const t of g.tanks) if (t.team === 'e' && !t.dead) kill(t, p);
      else if (b.k === 'fort') { g.fortT = 15; fort(ST); }
    };
    // стены вокруг ядра: на время бонуса — сталь, потом снова кирпич
    const fort = (v) => { for (let y = 22; y < N; y++) for (let x = 10; x <= 15; x++) if (!(x >= 12 && x <= 13 && y >= 24)) setCell(x, y, v); };

    const spawnEnemy = () => {
      const free = E_SPAWN.filter((s) => g.tanks.every((t) => t.dead || Math.abs(t.x - s.x) > 2 || Math.abs(t.y - s.y) > 2));
      if (!free.length) return false;
      const s = free[Math.floor(g.R() * free.length)];
      const n = g.spawned;
      const lvMix = Math.min(g.lv - 1, 6);
      const r = g.R();
      const type = r < 0.12 + lvMix * 0.05 ? 'heavy' : r < 0.32 + lvMix * 0.06 ? 'fast' : r < 0.5 + lvMix * 0.06 ? 'power' : 'basic';
      g.tanks.push({ id: g.nextId++, team: 'e', type, x: s.x, y: s.y, dir: DN, hp: TYPES[type].hp, cd: 1 + g.R(), bullet: 0, spawnT: 1.0, ai: 0, carrier: [3, 10, 17].includes(n) });
      fx('spawn', s.x, s.y, 1);
      g.spawned++;
      return true;
    };

    g.step = (dt) => {
      if (g.state === 'pause') return;
      if (g.state === 'clear' || g.state === 'over') { g.stateT -= dt; if (g.state === 'clear' && g.stateT <= 0) g.nextLevel(); return; }
      if (g.freezeT > 0) g.freezeT -= dt;
      if (g.fortT > 0) { g.fortT -= dt; if (g.fortT <= 0) fort(BR); }
      if (g.bonus) { g.bonus.t -= dt; if (g.bonus.t <= 0) g.bonus = null; }
      // появление врагов
      const alive = g.tanks.filter((t) => t.team === 'e' && !t.dead).length;
      g.spawnT -= dt;
      if (g.spawnT <= 0 && g.spawned < ENEMIES_PER_LEVEL && alive < (g.two ? 6 : 4)) { if (spawnEnemy()) g.spawnT = Math.max(1.2, 3 - g.lv * 0.2); else g.spawnT = 0.5; }
      // возрождение игроков
      for (const i of [0, 1]) {
        if (g.players[i] || !(i === 0 || g.two)) continue;
        if (g.respawn[i] > 0) { g.respawn[i] -= dt; if (g.respawn[i] <= 0) { if (g.lives[i] > 1) { g.lives[i]--; spawnPlayer(i); fx('spawn', P_SPAWN[i].x, P_SPAWN[i].y, 1); } else g.lives[i] = 0; } }
      }
      // танки
      for (const t of g.tanks) {
        if (t.dead) continue;
        t.cd = Math.max(0, t.cd - dt);
        if (t.shield > 0) t.shield -= dt;
        if (t.spawnT > 0) { t.spawnT -= dt; continue; }
        const v = TYPES[t.type].v * dt;
        if (t.team === 'p') {
          const d = t.input.d;
          t.moving = d >= 0 && tryMove(t, d, v);
          if (d >= 0 && !t.moving && t.dir !== d) t.dir = d;
          if (t.input.f) fire(t);
          if (g.bonus && Math.abs(g.bonus.x + 0.5 - t.x) < 1.6 && Math.abs(g.bonus.y + 0.5 - t.y) < 1.6) takeBonus(t);
        } else {
          if (g.freezeT > 0) continue;
          t.ai -= dt;
          const moved = tryMove(t, t.dir, v);
          if (!moved || t.ai <= 0) {
            t.ai = 0.6 + g.R() * 2.2;
            const r = g.R();
            // чаще едут вниз к ядру, иногда — к ближайшему игроку
            const target = r < 0.35 ? { x: CORE.x + 1, y: CORE.y } : r < 0.55 ? (g.players.find(Boolean) || { x: CORE.x, y: CORE.y }) : null;
            if (target && g.R() < 0.7) {
              const dx = target.x - t.x, dy = target.y - t.y;
              t.dir = Math.abs(dx) > Math.abs(dy) * (0.6 + g.R()) ? (dx > 0 ? RT : LT) : dy > 0 ? DN : UP;
            } else {
              const w = g.R();
              t.dir = w < 0.45 ? DN : w < 0.65 ? LT : w < 0.85 ? RT : UP;
            }
            if (t.dir === UP || t.dir === DN) t.x = Math.round(t.x); else t.y = Math.round(t.y);
          }
          if (t.cd <= 0 && g.R() < 0.04) { fire(t); t.cd = TYPES[t.type].cd * (0.7 + g.R() * 0.8); }
        }
      }
      // снаряды
      for (const b of g.bullets) {
        if (b.dead) continue;
        const steps = Math.ceil((b.v * dt) / 0.25);
        for (let s = 0; s < steps && !b.dead; s++) {
          b.x += DX[b.dir] * (b.v * dt) / steps; b.y += DY[b.dir] * (b.v * dt) / steps;
          if (b.x < 0 || b.y < 0 || b.x > N || b.y > N) { b.dead = true; fx('hit', Math.min(Math.max(b.x, 0), N), Math.min(Math.max(b.y, 0), N), 0.5); break; }
          // клетки на пути снаряда (ширина — две клетки, как ширина танка)
          const cx = Math.floor(b.x), cy = Math.floor(b.y);
          const pair = b.dir === UP || b.dir === DN ? [[Math.round(b.x) - 1, cy], [Math.round(b.x), cy]] : [[cx, Math.round(b.y) - 1], [cx, Math.round(b.y)]];
          let hitWall = false;
          for (const [x, y] of pair) {
            const v = cell(x, y);
            if (v === BR) { setCell(x, y, E); hitWall = true; }
            else if (v === ST) { if (b.power) setCell(x, y, E); hitWall = true; }
            else if (v === CO) { hitWall = true; coreHit(); }
          }
          if (hitWall) { b.dead = true; fx('hit', b.x, b.y, 0.6); break; }
          // танки
          for (const t of g.tanks) {
            if (t.dead || t.team === b.team || t.spawnT > 0) continue;
            if (Math.abs(t.x - b.x) < 1 && Math.abs(t.y - b.y) < 1) {
              b.dead = true;
              if (t.shield > 0) { fx('hit', b.x, b.y, 0.6); break; }
              t.hp--; t.flash = 0.15;
              if (t.hp <= 0) kill(t, b.owner); else fx('hit', b.x, b.y, 0.8);
              break;
            }
          }
          // встречные снаряды гасят друг друга
          if (!b.dead) for (const o of g.bullets) if (o !== b && !o.dead && o.team !== b.team && Math.abs(o.x - b.x) < 0.7 && Math.abs(o.y - b.y) < 0.7) { o.dead = b.dead = true; fx('hit', b.x, b.y, 0.4); }
        }
        if (b.dead && b.owner) b.owner.bullet = Math.max(0, b.owner.bullet - 1);
      }
      g.bullets = g.bullets.filter((b) => !b.dead);
      g.tanks = g.tanks.filter((t) => !t.dead);
      // итог уровня
      if (g.left <= 0 && g.state === 'play') { g.state = 'clear'; g.stateT = 4; fx('clear', 13, 13, 1); }
      const anyPlayer = g.players.some(Boolean) || g.respawn.some((r, i) => r > 0 && g.lives[i] > 1);
      if (!anyPlayer && g.state === 'play') over('lives');
    };
    const coreHit = () => {
      if (g.state !== 'play') return;
      for (let y = 24; y < N; y++) for (let x = 12; x <= 13; x++) g.map[y * N + x] = E;
      g.mv++; g.coreDead = true;
      fx('boom', 13, 25, 4);
      over('core');
    };
    const over = (why) => { g.state = 'over'; g.why = why; };
    g.nextLevel = () => {
      g.lv++; g.map = makeMap(g.seed + g.lv * 1013); g.mv++;
      g.tanks = []; g.bullets = []; g.bonus = null; g.left = ENEMIES_PER_LEVEL; g.spawned = 0; g.spawnT = 1.5; g.state = 'play'; g.freezeT = 0; g.fortT = 0; g.coreDead = false;
      g.players = [null, null];
      if (g.lives[0] > 0) spawnPlayer(0);
      if (g.two && g.lives[1] > 0) spawnPlayer(1);
    };
    g.togglePause = () => { if (g.state === 'play') g.state = 'pause'; else if (g.state === 'pause') g.state = 'play'; };
    g.snapshot = (withMap) => ({
      k: 'snap', lv: g.lv, mv: g.mv, m: withMap ? Array.from(g.map).join('') : undefined,
      t: g.tanks.map((t) => [t.id, t.type, Math.round(t.x * 100), Math.round(t.y * 100), t.dir, t.team === 'p' ? t.pi : -1,
        (t.shield > 0 ? 1 : 0) | (t.spawnT > 0 ? 2 : 0) | (t.carrier ? 4 : 0) | (t.flash > 0 ? 8 : 0) | (t.moving || (t.team === 'e' && g.freezeT <= 0) ? 16 : 0), t.hp]),
      b: g.bullets.map((b) => [Math.round(b.x * 100), Math.round(b.y * 100), b.dir]),
      fx: g.fx.splice(0),
      bo: g.bonus ? [g.bonus.k, g.bonus.x, g.bonus.y] : null,
      h: { lives: g.lives, left: g.left, state: g.state, why: g.why || '', freeze: g.freezeT > 0, kills: g.kills, core: !g.coreDead },
    });
    return g;
  }

  // ---------------------------------------------------------------- 3D
  function View(canvas) {
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1f1d1b);
    const cam = new THREE.PerspectiveCamera(38, 1, 0.5, 200);
    scene.add(new THREE.HemisphereLight(0xfff3e4, 0x2b2622, 1.15));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(-8, 22, 12); scene.add(sun);

    // земля с сеткой
    const tex = (() => {
      const c = document.createElement('canvas'); c.width = c.height = 512;
      const x = c.getContext('2d');
      x.fillStyle = '#3b352f'; x.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 600; i++) { x.fillStyle = `rgba(255,240,220,${Math.random() * 0.035})`; x.fillRect(Math.random() * 512, Math.random() * 512, 3, 3); }
      x.strokeStyle = 'rgba(255,235,210,.06)'; x.lineWidth = 2;
      for (let i = 0; i <= 13; i++) { const p = (i / 13) * 512; x.beginPath(); x.moveTo(p, 0); x.lineTo(p, 512); x.stroke(); x.beginPath(); x.moveTo(0, p); x.lineTo(512, p); x.stroke(); }
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    })();
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(N, N), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.position.set(N / 2, 0, N / 2); scene.add(ground);
    // рамка поля
    const rim = new THREE.Mesh(new THREE.BoxGeometry(N + 1.2, 0.6, N + 1.2), new THREE.MeshStandardMaterial({ color: 0x2a2622 }));
    rim.position.set(N / 2, -0.32, N / 2); scene.add(rim);

    const box = new THREE.BoxGeometry(1, 1, 1);
    const mk = (color, max, opts = {}) => {
      const mat = new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.8 }, opts));
      const m = new THREE.InstancedMesh(box, mat, max); m.count = 0; scene.add(m); return m;
    };
    const bricks = mk(0xffffff, N * N), steel = mk(0x9aa1a8, N * N, { metalness: 0.55, roughness: 0.35 }),
      water = mk(0x3f86b0, N * N, { transparent: true, opacity: 0.82, roughness: 0.15, metalness: 0.1 }),
      forest = new THREE.InstancedMesh(new THREE.ConeGeometry(0.62, 1.5, 6), new THREE.MeshStandardMaterial({ color: 0x5b8a52, roughness: 0.9, transparent: true, opacity: 0.93 }), N * N);
    forest.count = 0; scene.add(forest);
    const coreG = new THREE.Group();
    const coreGem = new THREE.Mesh(new THREE.OctahedronGeometry(0.85), new THREE.MeshStandardMaterial({ color: 0xd97757, emissive: 0xc96442, emissiveIntensity: 0.65, roughness: 0.25, metalness: 0.2 }));
    coreGem.position.y = 1.15;
    const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1, 0.5, 8), new THREE.MeshStandardMaterial({ color: 0x5a524a }));
    pedestal.position.y = 0.25;
    coreG.add(pedestal, coreGem); coreG.position.set(13, 0, 25); scene.add(coreG);

    const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(), C = new THREE.Color();
    let mapKey = '';
    function setMap(map) {
      const key = map.join ? map.join('') : String(map);
      if (key === mapKey) return; mapKey = key;
      let nb = 0, ns = 0, nw = 0, nf = 0;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        const v = +key[y * N + x];
        if (v === BR) {
          S.set(0.96, 0.9, 0.96); V.set(x + 0.5, 0.45, y + 0.5); M4.compose(V, Q, S); bricks.setMatrixAt(nb, M4);
          const k = ((x * 7 + y * 13) % 5) / 5; C.setRGB(0.70 + k * 0.08, 0.33 + k * 0.05, 0.20 + k * 0.03, THREE.SRGBColorSpace); bricks.setColorAt(nb, C); nb++;
        } else if (v === ST) { S.set(0.98, 1.0, 0.98); V.set(x + 0.5, 0.5, y + 0.5); M4.compose(V, Q, S); steel.setMatrixAt(ns++, M4); }
        else if (v === WA) { S.set(1, 0.12, 1); V.set(x + 0.5, 0.06, y + 0.5); M4.compose(V, Q, S); water.setMatrixAt(nw++, M4); }
        else if (v === FO) { S.set(1, 1, 1); V.set(x + 0.5, 0.75, y + 0.5); M4.compose(V, Q, S); forest.setMatrixAt(nf++, M4); }
      }
      bricks.count = nb; steel.count = ns; water.count = nw; forest.count = nf;
      for (const m of [bricks, steel, water, forest]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
      const core = key[24 * N + 12] === String(CO);
      coreGem.visible = core;
      pedestal.material.color.setHex(core ? 0x5a524a : 0x2b2724);
    }

    // танки
    const COLORS = { p0: 0xe07a55, p1: 0x72b07c, basic: 0xd2ccc1, fast: 0xe6c98c, power: 0xb9b3ab, heavy: 0x8a857e };
    const tankObjs = new Map();
    function tankMesh(kind) {
      const g = new THREE.Group();
      const col = COLORS[kind] || 0x999999;
      const body = new THREE.MeshStandardMaterial({ color: col, roughness: 0.55, metalness: 0.15 });
      const dark = new THREE.MeshStandardMaterial({ color: 0x2c2825, roughness: 0.9 });
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 1.86), dark); tl.position.set(-0.72, 0.25, 0);
      const tr = tl.clone(); tr.position.x = 0.72;
      const hull = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.5, 1.5), body); hull.position.y = 0.48;
      const tur = new THREE.Mesh(kind === 'heavy' ? new THREE.BoxGeometry(0.9, 0.42, 0.9) : new THREE.CylinderGeometry(0.42, 0.48, 0.38, 12), body); tur.position.y = 0.92;
      const gun = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 1.05, 8), new THREE.MeshStandardMaterial({ color: 0xf2e8da, roughness: 0.4 }));
      gun.rotation.x = Math.PI / 2; gun.position.set(0, 0.95, -0.72);
      g.add(tl, tr, hull, tur, gun);
      if (kind === 'p0' || kind === 'p1') { // флажок-метка игрока
        const f = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.6, 0.06), dark); f.position.set(0.35, 1.3, 0.45);
        const fl = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.2, 0.03), new THREE.MeshStandardMaterial({ color: kind === 'p0' ? 0xf2e8da : 0xe3efe2, emissive: col, emissiveIntensity: 0.4 }));
        fl.position.set(0.52, 1.52, 0.45); g.add(f, fl);
      }
      const shield = new THREE.Mesh(new THREE.SphereGeometry(1.35, 16, 12), new THREE.MeshStandardMaterial({ color: 0xbfe0ff, emissive: 0x6fb3ff, emissiveIntensity: 0.6, transparent: true, opacity: 0.22 }));
      shield.position.y = 0.6; shield.visible = false; g.add(shield);
      const spawn = new THREE.Mesh(new THREE.OctahedronGeometry(1.1, 0), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffe2c4, emissiveIntensity: 1, transparent: true, opacity: 0.8, wireframe: true }));
      spawn.position.y = 0.8; spawn.visible = false; g.add(spawn);
      g.userData = { body, shield, spawn, col, tracks: [tl, tr] };
      scene.add(g);
      return g;
    }
    const bulletGeo = new THREE.SphereGeometry(0.3, 10, 8);
    const bulletMat = new THREE.MeshStandardMaterial({ color: 0xfff1dc, emissive: 0xffc9a0, emissiveIntensity: 1 });
    const bulletPool = [];
    const bonusMesh = new THREE.Group();
    const bonusBox = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 1.2), new THREE.MeshStandardMaterial({ color: 0xf2e8da, emissive: 0xd97757, emissiveIntensity: 0.55, roughness: 0.3 }));
    bonusBox.position.y = 1; bonusMesh.add(bonusBox); bonusMesh.visible = false; scene.add(bonusMesh);
    const booms = [];
    function boom(x, y, s, color = 0xffa560) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 10), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.2, transparent: true, opacity: 0.95 }));
      m.position.set(x, 0.7, y); scene.add(m); booms.push({ m, t: 0, s });
    }

    function resize(w, h) {
      r.setSize(w, h, false);
      cam.aspect = w / h;
      // наклонная камера; расстояние подбираем, чтобы поле целиком помещалось по ширине
      // крутой наклон (~68°): поле крупнее на узком экране, но объём стен и танков виден
      const tilt = 1.19;
      const fit = (N + 2) / 2 / Math.tan((cam.fov * Math.PI) / 360) / Math.min(1, cam.aspect);
      cam.position.set(N / 2, Math.sin(tilt) * fit, N / 2 + Math.cos(tilt) * fit + 0.6);
      cam.lookAt(N / 2, 0, N / 2 + 0.6);
      cam.updateProjectionMatrix();
    }

    let tPrev = performance.now();
    function draw(state) { // state: { tanks:[{id,kind,x,y,dir,flags,hp}], bullets:[{x,y}], bonus }
      const now = performance.now(), dt = Math.min(0.05, (now - tPrev) / 1000); tPrev = now;
      const seen = new Set();
      for (const t of state.tanks) {
        seen.add(t.id);
        let o = tankObjs.get(t.id);
        if (!o) { o = tankMesh(t.kind); tankObjs.set(t.id, o); o.position.set(t.x, 0, t.y); o.rotation.y = -t.dir * Math.PI / 2; }
        o.position.x += (t.x - o.position.x) * Math.min(1, dt * 18);
        o.position.z += (t.y - o.position.z) * Math.min(1, dt * 18);
        let target = -t.dir * Math.PI / 2, cur = o.rotation.y;
        let d = ((target - cur + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
        o.rotation.y = cur + d * Math.min(1, dt * 16);
        const u = o.userData;
        u.shield.visible = !!(t.flags & 1); if (u.shield.visible) u.shield.material.opacity = 0.16 + 0.1 * Math.sin(now / 90);
        u.spawn.visible = !!(t.flags & 2); if (u.spawn.visible) { u.spawn.rotation.y += dt * 6; u.spawn.scale.setScalar(0.6 + 0.4 * Math.abs(Math.sin(now / 120))); }
        for (const ch of o.children) if (ch !== u.spawn) ch.visible = !(t.flags & 2) && (ch !== u.shield || u.shield.visible);
        const blink = t.flags & 4 ? Math.sin(now / 110) > 0 : false;
        u.body.color.setHex(blink ? 0xe0533f : t.kind === 'heavy' && t.hp > 1 ? [0x8a857e, 0x9d978e, 0xb3aca2, 0xcfc7ba][Math.min(3, t.hp - 1)] : u.col);
        u.body.emissive.setHex(t.flags & 8 ? 0x663322 : 0x000000);
        if (t.flags & 16) for (const tr of u.tracks) tr.position.y = 0.25 + Math.sin(now / 40 + tr.position.x) * 0.02;
      }
      for (const [id, o] of tankObjs) if (!seen.has(id)) { scene.remove(o); tankObjs.delete(id); }
      while (bulletPool.length < state.bullets.length) { const m = new THREE.Mesh(bulletGeo, bulletMat); scene.add(m); bulletPool.push(m); }
      bulletPool.forEach((m, i) => { const b = state.bullets[i]; m.visible = !!b; if (b) m.position.set(b.x, 0.95, b.y); });
      if (state.bonus) {
        bonusMesh.visible = Math.sin(now / 160) > -0.6;
        bonusMesh.position.set(state.bonus[1] + 0.5, 0, state.bonus[2] + 0.5);
        bonusBox.rotation.y += dt * 2; bonusBox.position.y = 1 + Math.sin(now / 250) * 0.2;
      } else bonusMesh.visible = false;
      coreGem.rotation.y += dt * 1.2; coreGem.position.y = 1.15 + Math.sin(now / 400) * 0.08;
      water.material.opacity = 0.75 + Math.sin(now / 500) * 0.07;
      for (let i = booms.length - 1; i >= 0; i--) {
        const b = booms[i]; b.t += dt;
        const k = b.t / (0.35 + b.s * 0.12);
        b.m.scale.setScalar(0.4 + k * b.s * 1.6); b.m.material.opacity = Math.max(0, 1 - k);
        if (k >= 1) { scene.remove(b.m); b.m.geometry.dispose(); b.m.material.dispose(); booms.splice(i, 1); }
      }
      r.render(scene, cam);
    }
    return { setMap, draw, resize, boom, dispose: () => { r.dispose(); r.forceContextLoss && r.forceContextLoss(); } };
  }

  // ---------------------------------------------------------------- звук
  let actx = null;
  function noise(dur = 0.25, vol = 0.18) {
    try {
      actx ||= new (window.AudioContext || window.webkitAudioContext)();
      const len = actx.sampleRate * dur, buf = actx.createBuffer(1, len, actx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
      const s = actx.createBufferSource(), g = actx.createGain(), f = actx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 900; g.gain.value = vol;
      s.buffer = buf; s.connect(f).connect(g).connect(actx.destination); s.start();
    } catch {}
  }

  // ---------------------------------------------------------------- экран и пульт
  function start(el, o) {
    const sess = o.sess, host = sess.host !== false, two = !!sess.peer;
    const myIdx = host ? 0 : 1;
    el.innerHTML = `
      <div class="t-top">
        <div class="t-side">${two ? `<div class="vslot t-v" data-who="opp"></div>` : ''}<div class="t-pl"><b class="t-n0"></b><span class="t-l0"></span></div></div>
        <div class="t-mid"><b class="t-lv">Уровень 1</b><span class="t-left"></span></div>
        <div class="t-side r"><div class="t-pl"><b class="t-n1"></b><span class="t-l1"></span></div>${two ? `<div class="vslot t-v" data-who="me"></div>` : ''}</div>
      </div>
      <div class="t-stage"><canvas></canvas><div class="t-msg" hidden></div>${o.callCtlHTML('t-cc')}</div>
      <div class="t-pad">
        <div class="t-dpad" aria-label="Крестовина"><i class="u"></i><i class="r"></i><i class="d"></i><i class="l"></i><b></b></div>
        <div class="t-meta"><div class="t-brand">РУБЕЖ</div><div class="t-sel"><button data-x="select">ВЫХОД</button><button data-x="start">ПАУЗА</button></div></div>
        <div class="t-ab"><div><button class="t-btn" data-f="2">Б</button><span>ОЧЕРЕДЬ</span></div><div><button class="t-btn" data-f="1">А</button><span>ОГОНЬ</span></div></div>
      </div>`;
    const names = [host ? 'Вы' : o.peerName, host ? o.peerName : 'Вы'];
    el.querySelector('.t-n0').textContent = names[0] || 'Вы';
    el.querySelector('.t-n1').textContent = two ? names[1] : '';
    // аватар соперника в окне видео (пока видео нет)
    el.querySelectorAll('.vslot').forEach((v) => { const who = v.dataset.who === 'opp' ? sess.peer : o.me; v.innerHTML = `<div class="ava">${(dn(who) || '?').slice(0, 1).toUpperCase()}</div>`; avatar(v.firstChild, who); });
    o.camButton();
    const canvas = el.querySelector('canvas'), stage = el.querySelector('.t-stage'), msg = el.querySelector('.t-msg');
    const view = View(canvas);
    const fit = () => { const b = stage.getBoundingClientRect(); view.resize(Math.max(50, b.width), Math.max(50, b.height)); o.refreshVideoUI(); };
    const ro = new ResizeObserver(fit); ro.observe(stage); fit();

    // ---- ввод ----
    const input = { d: -1, f: 0, turbo: 0 };
    const dpad = el.querySelector('.t-dpad');
    let dpadId = null;
    const dirFrom = (e) => {
      const b = dpad.getBoundingClientRect(), x = e.clientX - (b.left + b.width / 2), y = e.clientY - (b.top + b.height / 2);
      if (Math.hypot(x, y) < 10) return -1;
      return Math.abs(x) > Math.abs(y) ? (x > 0 ? RT : LT) : y > 0 ? DN : UP;
    };
    const setDir = (d) => { if (d !== input.d) { input.d = d; dpad.dataset.d = d; push(); if (d >= 0) try { navigator.vibrate && navigator.vibrate(6); } catch {} } };
    dpad.addEventListener('pointerdown', (e) => { e.preventDefault(); dpadId = e.pointerId; try { dpad.setPointerCapture(e.pointerId); } catch {} setDir(dirFrom(e)); });
    dpad.addEventListener('pointermove', (e) => { if (e.pointerId === dpadId) setDir(dirFrom(e)); });
    const dEnd = (e) => { if (e.pointerId === dpadId) { dpadId = null; setDir(-1); } };
    dpad.addEventListener('pointerup', dEnd); dpad.addEventListener('pointercancel', dEnd);
    el.querySelectorAll('.t-btn').forEach((b) => {
      const on = (v) => (e) => { e.preventDefault(); if (v) try { b.setPointerCapture(e.pointerId); } catch {} b.classList.toggle('on', v); if (b.dataset.f === '2') input.turbo = v ? 1 : 0; else input.f = v ? 1 : 0; push(); if (v) try { navigator.vibrate && navigator.vibrate(12); } catch {} };
      b.addEventListener('pointerdown', on(true)); b.addEventListener('pointerup', on(false)); b.addEventListener('pointercancel', on(false));
      b.addEventListener('contextmenu', (e) => e.preventDefault());
    });
    const keys = {};
    const kd = (e) => {
      const k = { ArrowUp: UP, ArrowRight: RT, ArrowDown: DN, ArrowLeft: LT, KeyW: UP, KeyD: RT, KeyS: DN, KeyA: LT }[e.code];
      if (k !== undefined) { keys[e.code] = e.type === 'keydown'; const act = Object.entries(keys).filter(([, v]) => v).map(([c]) => ({ ArrowUp: UP, ArrowRight: RT, ArrowDown: DN, ArrowLeft: LT, KeyW: UP, KeyD: RT, KeyS: DN, KeyA: LT })[c]); setDir(act.length ? act[act.length - 1] : -1); e.preventDefault(); }
      if (e.code === 'Space' || e.code === 'KeyJ') { input.f = e.type === 'keydown' ? 1 : 0; push(); e.preventDefault(); }
    };
    window.addEventListener('keydown', kd); window.addEventListener('keyup', kd);
    el.querySelector('[data-x=select]').onclick = () => o.askLeave();
    el.querySelector('[data-x=start]').onclick = () => { if (host) game && game.togglePause(); else o.send({ k: 'pause' }); };

    let lastSent = '', lastSendT = 0;
    function push() { // ввод второго игрока → хозяину
      if (host) return;
      const s = `${input.d}|${input.f || input.turbo}`;
      if (s === lastSent && performance.now() - lastSendT < 150) return;
      lastSent = s; lastSendT = performance.now();
      o.send({ k: 'in', d: input.d, f: input.f || input.turbo ? 1 : 0 });
    }

    // ---- игра ----
    const pendingFx = [];
    let game = null, snaps = [], lastMapV = -1, map = null, hud = null, destroyed = false, peerGone = false, ended = false;
    if (host) game = Game(Math.floor(Math.random() * 1e9), two);
    let acc = 0, last = performance.now(), snapAt = 0, mapAt = 0, turboT = 0, curLv = 1;

    function applyFx(list) {
      for (const [k, x, y, s] of list || []) {
        if (k === 'boom') { view.boom(x, y, s, 0xffa560); noise(0.35 + s * 0.08, 0.22); try { navigator.vibrate && s >= 2 && navigator.vibrate(30); } catch {} }
        else if (k === 'hit') view.boom(x, y, s * 0.6, 0xffe0b0);
        else if (k === 'shot') window.HXBeep && HXBeep(s === myIdx ? 760 : 520, 0.05, 'square', s === myIdx ? 0.05 : 0.025);
        else if (k === 'bonus') { window.HXBeep && (HXBeep(880, 0.08), setTimeout(() => HXBeep(1180, 0.12), 90)); }
        else if (k === 'spawn') view.boom(x, y, 0.8, 0xfff4e6);
      }
    }

    function frame() {
      if (destroyed) return;
      const now = performance.now();
      if (host && game) {
        acc += Math.min(0.1, (now - last) / 1000); last = now;
        const me0 = game.players[0];
        turboT -= 1 / 60;
        if (me0) me0.input = { d: input.d, f: input.f || (input.turbo && turboT <= 0 ? 1 : 0) };
        if (input.turbo && turboT <= 0) turboT = 0.12;
        while (acc >= 1 / 60) {
          game.step(1 / 60);
          for (const t of game.tanks) if (t.flash) t.flash = Math.max(0, t.flash - 1 / 60);
          acc -= 1 / 60;
        }
        const snap = game.snapshot(false);
        applyFx(snap.fx.slice());
        if (two && !peerGone) {
          pendingFx.push(...snap.fx);
          if (now - snapAt > 66) { // ~15 снимков в секунду
            const withMap = game.mv !== lastMapV || now - mapAt > 2000;
            const out = game.snapshot(withMap); out.fx = pendingFx.splice(0);
            if (withMap) { lastMapV = game.mv; mapAt = now; }
            o.send(out); snapAt = now;
          }
        }
        render({ lv: game.lv, mv: game.mv, map: game.map, t: snap.t, b: snap.b, bo: snap.bo, h: snap.h });
      } else if (snaps.length) {
        // второй игрок: плавно между двумя последними снимками
        // показываем с задержкой в один снимок: от предпоследнего к последнему
        const s1 = snaps[snaps.length - 1], s0 = snaps.length > 1 ? snaps[snaps.length - 2] : s1;
        const span = Math.max(30, s1.at - s0.at), k = Math.min(1, (now - s1.at) / span);
        const prev = new Map(s0.t.map((t) => [t[0], t]));
        const t = s1.t.map((x) => { const p = prev.get(x[0]); if (!p) return x; const c = x.slice(); c[2] = p[2] + (x[2] - p[2]) * k; c[3] = p[3] + (x[3] - p[3]) * k; return c; });
        render({ lv: s1.lv, map, t, b: s1.b, bo: s1.bo, h: s1.h });
        if (input.turbo && performance.now() - lastSendT > 120) { lastSent = ''; push(); }
      } else {
        msg.hidden = false; msg.innerHTML = `<b>Подключаемся к игре…</b><small>${esc(o.peerName || '')} запускает поле</small>`;
      }
      requestAnimationFrame(frame);
    }

    function render(s) {
      if (s.map) view.setMap(s.map);
      const tanks = s.t.map(([id, type, x, y, dir, pi, flags, hp]) => ({ id, kind: pi >= 0 ? 'p' + pi : type, x: x / 100, y: y / 100, dir, flags, hp }));
      view.draw({ tanks, bullets: s.b.map(([x, y]) => ({ x: x / 100, y: y / 100 })), bonus: s.bo });
      const h = s.h;
      curLv = s.lv;
      if (JSON.stringify(h) + s.lv !== hud) {
        hud = JSON.stringify(h) + s.lv;
        el.querySelector('.t-lv').textContent = 'Уровень ' + s.lv;
        el.querySelector('.t-left').innerHTML = '<i class="t-ico"></i>×' + h.left;
        el.querySelector('.t-l0').innerHTML = `<i class="t-heart">♥</i>${Math.max(0, h.lives[0])} · ${h.kills[0]} подбито`;
        el.querySelector('.t-l1').innerHTML = two ? `<i class="t-heart g">♥</i>${Math.max(0, h.lives[1])} · ${h.kills[1]} подбито` : '';
        if (h.state === 'pause') { msg.hidden = false; msg.innerHTML = '<b>Пауза</b><small>Нажмите «ПАУЗА», чтобы продолжить</small>'; }
        else if (h.state === 'clear') { msg.hidden = false; msg.innerHTML = `<b>Уровень ${s.lv} пройден!</b><small>Новое поле через пару секунд…</small>`; window.HXBeep && (HXBeep(660, 0.12), setTimeout(() => HXBeep(990, 0.2), 140)); }
        else if (h.state === 'over') { showOver(h); }
        else if (!peerGone) msg.hidden = true;
      }
    }

    function showOver(h) {
      if (ended) return; ended = true; sess.finished = true;
      msg.hidden = false;
      msg.innerHTML = `<b>${h.why === 'core' ? 'Ядро разрушено' : 'Танки закончились'}</b><small>Уровень ${curLv} · подбито: ${h.kills[0] + h.kills[1]}</small>
        <div class="t-acts"><button class="btn" data-x="again">Ещё раз</button><button class="btn ghost" data-x="out">Выйти</button></div>`;
      msg.querySelector('[data-x=again]').onclick = () => o.again();
      msg.querySelector('[data-x=out]').onclick = () => o.exit();
      noise(0.8, 0.25);
    }

    requestAnimationFrame(frame);

    return {
      onNet(m) {
        if (host) {
          if (m.k === 'in' && game) { const p = game.players[1]; const inp = { d: [-1, 0, 1, 2, 3].includes(m.d) ? m.d : -1, f: m.f ? 1 : 0 }; if (p) p.input = inp; game.p2input = inp; }
          if (m.k === 'pause' && game) game.togglePause();
          if (m.needMap) lastMapV = -1; // второй игрок без поля — отправим его снова
        } else if (m.k === 'snap') {
          if (m.m && m.m.length === N * N) { map = m.m; }
          m.at = performance.now();
          snaps.push(m); if (snaps.length > 3) snaps.shift();
          applyFx(m.fx);
          if (!map) o.send({ k: 'in', d: input.d, f: 0, needMap: 1 });
        }
      },
      peerLeft() {
        peerGone = true;
        if (host) { o.toast('Второй игрок вышел — играйте дальше одни', 2600); if (game && game.players[1]) { game.players[1].dead = true; game.players[1] = null; game.lives[1] = 0; } }
        else { msg.hidden = false; msg.innerHTML = `<b>${esc(o.peerName)} закрыл(а) игру</b><div class="t-acts"><button class="btn" data-x="out">Выйти</button></div>`; msg.querySelector('[data-x=out]').onclick = () => o.exit(); sess.finished = true; }
      },
      destroy() { destroyed = true; ro.disconnect(); window.removeEventListener('keydown', kd); window.removeEventListener('keyup', kd); view.dispose(); },
    };
  }

  window.HXTanks = {
    ready: async () => { if (!THREE) THREE = await import('/vendor/three.module.min.js'); },
    start,
    _test: { makeMap, Game, reachable },
  };
})();
