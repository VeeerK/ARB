import { COLORS } from "../kit.js";

/**
 * Blockfall — Tetris, rebuilt around the hands.
 *
 * The rules are the familiar ones: seven pieces from a shuffled bag, clear full
 * rows, the well speeds up every eight lines, and it is over when a new piece
 * has nowhere to go. What changed is how you hold a piece, and every change
 * borrows a gesture the app already means something by:
 *
 *   pinch          grabs the falling piece — from ANYWHERE, not just on it.
 *                  Pieces are small and fast; aiming a fingertip at one would
 *                  make the game about the tracker instead of the stacking.
 *   move sideways  carries it, a column at a time. Relative to where you
 *                  pinched, so your hand never has to be over the well.
 *   pull down      drags it down (it will not come back up — gravity).
 *   flick down     slams it to the floor.
 *   fist           turns it: a fresh fist is a quarter turn.
 *                  A fist left of the well turns it left, right of it turns it
 *                  right, so direction needs no second gesture.
 */

const COLS = 10;
const ROWS = 16;

const SHAPES = {
  I: { n: 4, cells: [[1, 0], [1, 1], [1, 2], [1, 3]], color: 0x66e6ff },
  O: { n: 2, cells: [[0, 0], [0, 1], [1, 0], [1, 1]], color: COLORS.gold },
  T: { n: 3, cells: [[0, 1], [1, 0], [1, 1], [1, 2]], color: COLORS.violet },
  S: { n: 3, cells: [[0, 1], [0, 2], [1, 0], [1, 1]], color: 0x7cf0a4 },
  Z: { n: 3, cells: [[0, 0], [0, 1], [1, 1], [1, 2]], color: 0xff6a7c },
  J: { n: 3, cells: [[0, 0], [1, 0], [1, 1], [1, 2]], color: COLORS.blue },
  L: { n: 3, cells: [[0, 2], [1, 0], [1, 1], [1, 2]], color: COLORS.orange },
};

const LINE_POINTS = [0, 100, 300, 500, 800];
const LINE_WORD = ["", "", "double", "triple", "BLOCKFALL!"];
const LOCK_DELAY = 0.5;          // seconds a grounded piece can still be moved
const MAX_LOCK_RESETS = 15;      // ...and how many moves can buy more time
const CLEAR_TIME = 0.3;
const SPAWN_GUARD_MS = 160;      // a new piece ignores the pull for this long
const LINES_PER_LEVEL = 8;

// Wall kicks: where to try a rotation when it does not fit in place. Sideways
// first, then up, which covers the floor and the stack beside you.
const KICKS = [[0, 0], [0, 1], [0, -1], [0, 2], [0, -2], [-1, 0], [-1, 1], [-1, -1]];

const shuffle = (a) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export default function blockfall(ctx) {
  const { kit, input, sfx } = ctx;

  // ---- layout ----
  const safe = kit.safe;
  const cell = Math.min((safe.top - safe.bottom - 0.2) / ROWS, (kit.w * 0.6) / COLS);
  const bottom = safe.bottom + 0.08;
  const wellW = COLS * cell, wellH = ROWS * cell;
  const STEP = cell * 1.15;       // hand travel per column / per row pulled

  const cellPos = (r, c) => ({ x: (c - COLS / 2 + 0.5) * cell, y: bottom + (ROWS - r - 0.5) * cell });

  kit.panel(0, bottom + wellH / 2, wellW, wellH, 0x05080c, 0.34);
  kit.rect(0, bottom + wellH / 2, wellW + 0.06, wellH + 0.06, 0xffffff, 0.55);
  for (let c = 1; c < COLS; c++) {
    const x = (c - COLS / 2) * cell;
    kit.polyline([[x, bottom], [x, bottom + wellH]], 0xffffff, 0.05);
  }

  // ---- state ----
  let board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  let meshes = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  let bag = [];
  let next = null;
  let piece = null;
  let score = 0, lines = 0, level = 1;
  let fallAcc = 0, lockTimer = 0, lockResets = 0;
  let grab = null;
  let requireRelease = null;    // a hand that slammed must let go before grabbing again
  let clearing = null;
  let over = false;
  let clock = performance.now();
  let spawnGuardUntil = 0;

  const size = cell * 0.92;
  const pieceMeshes = [0, 1, 2, 3].map(() => kit.shape("box", 0xffffff, { w: size, h: size }));
  const ghostMeshes = [0, 1, 2, 3].map(() => kit.shape("box", 0xffffff, { w: size, h: size, style: "ghost" }));

  const draw = () => {
    if (!bag.length) bag = shuffle(Object.keys(SHAPES));
    return bag.pop();
  };

  function collides(cells, row, col) {
    for (const [r, c] of cells) {
      const R = row + r, C = col + c;
      if (C < 0 || C >= COLS || R >= ROWS) return true;
      if (R >= 0 && board[R][C] != null) return true;
    }
    return false;
  }

  const grounded = () => collides(piece.cells, piece.row + 1, piece.col);

  function spawn() {
    const type = next ?? draw();
    next = draw();
    const s = SHAPES[type];
    piece = {
      type, n: s.n, color: s.color, snap: true,
      cells: s.cells.map(([r, c]) => [r, c]),
      row: type === "I" ? -1 : 0,
      col: Math.floor((COLS - s.n) / 2),
    };
    for (const m of pieceMeshes) kit.style(m, s.color, "solid");
    for (const m of ghostMeshes) kit.style(m, s.color, "ghost");
    fallAcc = 0; lockTimer = 0; lockResets = 0;
    spawnGuardUntil = clock + SPAWN_GUARD_MS;
    if (grab) rebaseGrab();
    if (collides(piece.cells, piece.row, piece.col)) gameOver();
  }

  function rebaseGrab() {
    const h = input.hands.find((x) => x.key === grab.key);
    if (!h) return;
    grab.x0 = h.pinch.x;
    grab.y0 = h.pinch.y;
    grab.col0 = piece.col;
    grab.pulled = 0;
    grab.trail = [];
  }

  function tryMove(dr, dc) {
    if (collides(piece.cells, piece.row + dr, piece.col + dc)) return false;
    piece.row += dr;
    piece.col += dc;
    return true;
  }

  /** A move or turn on the floor buys the piece a little more time, up to a
   *  limit, so it can be slid into a gap but not held up forever. */
  function lockReset() {
    if (lockTimer > 0 && lockResets < MAX_LOCK_RESETS) { lockTimer = 0; lockResets++; }
  }

  function rotate(dir) {
    if (piece.type === "O") { sfx.rotate(); return; }
    const n = piece.n;
    const turned = piece.cells.map(([r, c]) => (dir > 0 ? [c, n - 1 - r] : [n - 1 - c, r]));
    for (const [dr, dc] of KICKS) {
      if (collides(turned, piece.row + dr, piece.col + dc)) continue;
      piece.cells = turned;
      piece.row += dr;
      piece.col += dc;
      sfx.rotate();
      lockReset();
      if (grab) { grab.col0 = piece.col; rebaseX(); }
      return;
    }
  }

  function rebaseX() {
    const h = input.hands.find((x) => x.key === grab.key);
    if (h) { grab.x0 = h.pinch.x; grab.col0 = piece.col; }
  }

  function hardDrop() {
    let d = 0;
    while (tryMove(1, 0)) d++;
    score += d * 2;
    sfx.slam();
    for (const [r, c] of piece.cells) {
      const p = cellPos(piece.row + r, piece.col + c);
      kit.burst(p.x, p.y - cell / 2, piece.color, 3, { speed: 2.5, size: 0.07, life: 0.35 });
    }
    lock();
  }

  function lock() {
    for (const [r, c] of piece.cells) {
      const R = piece.row + r, C = piece.col + c;
      if (R < 0) return gameOver();         // locked above the top: topped out
      board[R][C] = piece.color;
      const m = kit.shape("box", piece.color, { w: size, h: size });
      const p = cellPos(R, C);
      m.position.x = p.x;
      m.position.y = p.y;
      m.userData.ty = p.y;
      m.userData.base = piece.color;
      meshes[R][C] = m;
    }
    sfx.lock();
    piece.hidden = true;

    const full = [];
    for (let r = 0; r < ROWS; r++) if (board[r].every((v) => v != null)) full.push(r);
    if (!full.length) return spawn();

    const n = full.length;
    const gained = LINE_POINTS[n] * level;
    score += gained;
    lines += n;
    clearing = { rows: full, t: 0 };
    sfx.clear(n);
    const mid = cellPos(full[Math.floor(n / 2)], COLS / 2);
    ctx.popAt(mid.x, mid.y, `+${gained}`, n >= 4 ? "gold" : "good");
    if (LINE_WORD[n]) ctx.banner(LINE_WORD[n], n >= 4 ? "gold" : "good");

    const nextLevel = 1 + Math.floor(lines / LINES_PER_LEVEL);
    if (nextLevel > level) {
      level = nextLevel;
      setTimeout(() => { if (!over) { ctx.banner(`level ${level}`, "", 1400); sfx.power(); } }, 500);
    }
  }

  /** Remove the cleared rows and let everything above them fall. */
  function collapse() {
    const full = new Set(clearing.rows);
    for (const r of full) {
      for (let c = 0; c < COLS; c++) {
        const m = meshes[r][c];
        if (!m) continue;
        kit.burst(m.position.x, m.position.y, m.userData.base, 3, { speed: 3.5, size: 0.1, life: 0.5 });
        kit.remove(m);
      }
    }
    const nb = [], nm = [];
    for (let i = 0; i < full.size; i++) { nb.push(Array(COLS).fill(null)); nm.push(Array(COLS).fill(null)); }
    for (let r = 0; r < ROWS; r++) {
      if (full.has(r)) continue;
      nb.push(board[r]);
      nm.push(meshes[r]);
    }
    board = nb;
    meshes = nm;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) if (meshes[r][c]) meshes[r][c].userData.ty = cellPos(r, c).y;
    }
    clearing = null;
  }

  function gameOver() {
    if (over) return;
    over = true;
    piece.hidden = true;
    grab = null;
    for (const row of meshes) for (const m of row) if (m) kit.style(m, COLORS.red, "solid");
    sfx.lose();
    ctx.end({
      score,
      kicker: "topped out",
      title: `${score}`,
      sub: `${lines} line${lines === 1 ? "" : "s"} · level ${level}`,
      rows: [{ label: "lines", value: String(lines) }, { label: "level", value: String(level) }],
    });
  }

  // ---- hands ----

  function handle(now) {
    // Turning: every fresh fist is one quarter turn.
    for (const h of input.hands) if (h.justFist) rotate(h.palm.x < 0 ? -1 : 1);

    if (requireRelease && !input.hands.some((h) => h.key === requireRelease && h.pinching)) {
      requireRelease = null;
    }

    if (grab) {
      const h = input.hands.find((x) => x.key === grab.key);
      if (!h || !h.pinching) grab = null;
    }
    if (!grab) {
      const h = input.hands.find((x) => x.pinching && !x.stale && x.key !== requireRelease);
      if (!h) return;
      grab = { key: h.key, x0: h.pinch.x, y0: h.pinch.y, col0: piece.col, pulled: 0, trail: [] };
    }

    const h = input.hands.find((x) => x.key === grab.key);
    if (h.stale) return;     // frozen through a dropout: hold still, do not guess

    if (now < spawnGuardUntil) { rebaseGrab(); return; }

    // Sideways, a column at a time, stopping at walls and the stack. When it
    // stops, the reference moves with it, so reversing responds at once rather
    // than after unwinding the distance you pushed into the wall.
    const target = grab.col0 + Math.round((h.pinch.x - grab.x0) / STEP);
    let moved = false;
    while (piece.col !== target) {
      if (!tryMove(0, Math.sign(target - piece.col))) {
        grab.x0 = h.pinch.x - (piece.col - grab.col0) * STEP;
        break;
      }
      moved = true;
    }
    if (moved) { sfx.move(); lockReset(); }

    // Down only. Raising the hand re-anchors instead of lifting the piece.
    if (grab.y0 - h.pinch.y < grab.pulled * STEP) grab.y0 = h.pinch.y + grab.pulled * STEP;
    const want = Math.floor((grab.y0 - h.pinch.y) / STEP);
    while (grab.pulled < want) {
      grab.pulled++;
      if (tryMove(1, 0)) { score += 1; fallAcc = 0; }
      else { grab.y0 = h.pinch.y + grab.pulled * STEP; break; }
    }

    // The slam: a fast downward flick, measured over the last fifth of a second.
    grab.trail.push({ t: now, y: h.pinch.y });
    while (grab.trail.length > 1 && now - grab.trail[0].t > 200) grab.trail.shift();
    const flick = grab.trail[0].y - h.pinch.y;
    if (flick > Math.max(2.1, STEP * 5)) {
      requireRelease = grab.key;
      grab = null;
      hardDrop();
    }
  }

  // ---- drawing ----

  function render(dt) {
    const k = 1 - Math.exp(-dt * 26);
    const showPiece = piece && !piece.hidden && !over;

    for (let i = 0; i < 4; i++) {
      const m = pieceMeshes[i], g = ghostMeshes[i];
      if (!showPiece) { m.visible = false; g.visible = false; continue; }
      const [r, c] = piece.cells[i];
      const R = piece.row + r;
      const p = cellPos(R, piece.col + c);
      if (piece.snap) { m.position.x = p.x; m.position.y = p.y; }
      else {
        m.position.x += (p.x - m.position.x) * k;
        m.position.y += (p.y - m.position.y) * k;
      }
      m.visible = R >= 0;
    }
    if (showPiece) {
      piece.snap = false;
      let drop = piece.row;
      while (!collides(piece.cells, drop + 1, piece.col)) drop++;
      for (let i = 0; i < 4; i++) {
        const [r, c] = piece.cells[i];
        const p = cellPos(drop + r, piece.col + c);
        ghostMeshes[i].position.x = p.x;
        ghostMeshes[i].position.y = p.y;
        ghostMeshes[i].visible = drop !== piece.row && drop + r >= 0;
      }
      // Grabbed pieces glow brighter, so you can see the pinch took hold.
      const st = grab ? "bright" : "solid";
      for (const m of pieceMeshes) kit.style(m, piece.color, st);
    }

    for (const row of meshes) for (const m of row) {
      if (m && m.userData.ty != null) m.position.y += (m.userData.ty - m.position.y) * k;
    }

    if (clearing) {
      const on = Math.floor(clearing.t / 0.07) % 2 === 0;
      for (const r of clearing.rows) for (const m of meshes[r]) {
        if (m) kit.style(m, on ? 0xffffff : m.userData.base, on ? "bright" : "solid");
      }
    }
  }

  next = draw();
  spawn();

  return {
    update(dt, now) {
      clock = now;
      if (over) return render(dt);
      if (clearing) {
        clearing.t += dt;
        if (clearing.t >= CLEAR_TIME) { collapse(); spawn(); }
        return render(dt);
      }

      handle(now);
      if (over || piece.hidden) return render(dt);

      const interval = Math.max(0.05, 0.8 * Math.pow(0.8, level - 1));
      if (!grounded()) {
        lockTimer = 0;
        fallAcc += dt;
        while (fallAcc >= interval) {
          fallAcc -= interval;
          if (!tryMove(1, 0)) break;
        }
      } else {
        fallAcc = 0;
        lockTimer += dt;
        if (lockTimer >= LOCK_DELAY || lockResets >= MAX_LOCK_RESETS && lockTimer >= 0.1) lock();
      }
      render(dt);
    },

    idle(dt, now) { clock = now; render(dt); },

    cursors() {
      kit.beginCursors();
      for (const h of input.hands) {
        if (h.stale) continue;
        const held = grab?.key === h.key;
        const p = h.pinching ? h.pinch : h.palm;
        kit.cursor(p.x, p.y, {
          color: held ? COLORS.amber : h.fisting ? COLORS.violet : h.pinching ? COLORS.mint : COLORS.white,
          r: h.pinching ? 0.2 : 0.3,
          opacity: held ? 0.95 : 0.6,
        });
      }
      kit.endCursors();
    },

    stats: () => [
      { k: "score", v: score },
      { k: "lines", v: lines },
      { k: "level", v: level },
      { k: "next", html: nextSvg(next) },
    ],
  };
}

function nextSvg(type) {
  const s = SHAPES[type];
  if (!s) return "";
  const hex = `#${s.color.toString(16).padStart(6, "0")}`;
  const rects = s.cells.map(([r, c]) =>
    `<rect x="${c * 8 + 1}" y="${r * 8 + 1}" width="7" height="7" rx="1" fill="${hex}" stroke="rgba(0,0,0,.35)" stroke-width=".6" />`).join("");
  return `<svg class="arc-next" viewBox="0 0 34 18" aria-hidden="true">${rects}</svg>`;
}
