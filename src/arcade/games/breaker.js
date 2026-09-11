import { COLORS } from "../kit.js";

/**
 * Brick Breaker — Breakout, with a paddle made of hands.
 *
 *   open palm      the paddle follows it left and right
 *   two hands      the paddle STRETCHES between them. The one rule a mouse
 *                  could never have: hold your hands wide for a wide paddle,
 *                  but a wide stance is slow to move, so it is a real trade.
 *   pinch          launches the ball
 *   fist           makes the paddle sticky — the ball stops dead on it, and a
 *                  pinch fires it again from wherever it landed. The freestyle
 *                  fist "grabs", and here it grabs the ball.
 *
 * Bricks with a dot in them drop a capsule: multi-ball, wide paddle, slow
 * ball, or an extra life. Clear a wall and the next one is faster.
 */

const LAYOUTS = [
  ["2222222222", "1111111111", "11*1111*11", "1111111111"],
  ["....22....", "...1111...", "..11*111..", ".11111111.", "1111**1111"],
  ["2.2.2.2.2.", ".1*1.1.1*1", "1.1.1.1.1.", ".2.2.2.2.2", "1111111111"],
  ["..1....1..", "...1..1...", "..222222..", ".22*22*22.", "2222222222", "2.2....2.2"],
  ["2222222222", "2*......*2", "2.111111.2", "2.1*22*1.2", "2.111111.2", "2222222222"],
];

const ROW_COLORS = [COLORS.rose, COLORS.orange, COLORS.gold, COLORS.mint, COLORS.sky, COLORS.violet];

const POWERS = [
  { type: "multi", weight: 35, color: COLORS.sky, label: "multi-ball" },
  { type: "wide", weight: 30, color: COLORS.mint, label: "wide paddle" },
  { type: "slow", weight: 20, color: COLORS.violet, label: "slow ball" },
  { type: "life", weight: 15, color: COLORS.rose, label: "+1 life" },
];

const R = 0.13;
const MAX_BALLS = 8;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export default function breaker(ctx) {
  const { kit, input, sfx } = ctx;
  const safe = kit.safe;

  const fieldW = Math.min(kit.w * 0.9, kit.h * 1.5);
  const left = -fieldW / 2, right = fieldW / 2;
  const top = safe.top - 0.05;
  const brickW = fieldW / 10, brickH = 0.36;
  const padY = safe.bottom + 0.4, padH = 0.2;
  const BASE_W = fieldW * 0.17;
  const lostY = -kit.h / 2 - 0.3;

  kit.polyline([[left, lostY], [left, top], [right, top], [right, lostY]], 0xffffff, 0.5);
  kit.panel(0, (top + lostY) / 2, fieldW, top - lostY, 0x05080c, 0.22);

  let bricks = [];
  let balls = [];
  let items = [];
  let lives = 3;
  let score = 0;
  let wall = 1;
  let speed = 0;
  let wideUntil = 0, slowUntil = 0;
  let between = 0;              // seconds until the next wall is built
  let stuckSince = 0, hinted = false;
  let started = false;
  let over = false;
  let clock = performance.now();

  const paddle = { x: 0, w: BASE_W, mesh: kit.shape("box", COLORS.mint, { w: BASE_W, h: padH, d: 0.3 }), sticky: false };

  const baseSpeed = () => 5.6 + (wall - 1) * 0.55;

  function buildWall() {
    for (const b of bricks) kit.remove(b.mesh);
    bricks = [];
    const layout = LAYOUTS[(wall - 1) % LAYOUTS.length];
    layout.forEach((row, r) => {
      [...row].forEach((ch, c) => {
        if (ch === ".") return;
        const x = left + (c + 0.5) * brickW;
        const y = top - 0.35 - r * brickH;
        const color = ROW_COLORS[r % ROW_COLORS.length];
        const tough = ch === "2";
        const mesh = kit.shape(ch === "*" ? "circle" : "box", color, {
          w: ch === "*" ? brickH * 0.8 : brickW * 0.9,
          h: brickH * 0.78,
          style: tough ? "bright" : "solid",
        });
        mesh.position.x = x;
        mesh.position.y = y;
        // A power brick is a box with a glowing core, so it reads as a brick.
        if (ch === "*") {
          const shell = kit.shape("box", color, { w: brickW * 0.9, h: brickH * 0.78, style: "ghost" });
          shell.position.x = x;
          shell.position.y = y;
          mesh.userData.shell = shell;
        }
        bricks.push({ x, y, w: brickW * 0.9, h: brickH * 0.78, hp: tough ? 2 : 1, power: ch === "*", color, mesh, row: r });
      });
    });
    speed = baseSpeed();
  }

  function newBall(stuck = true, from = null) {
    if (balls.length >= MAX_BALLS) return null;
    const mesh = kit.shape("circle", COLORS.white, { w: R * 2, h: R * 2, style: "bright" });
    const ball = from
      ? { x: from.x, y: from.y, vx: from.vx, vy: from.vy, stuck: false, off: 0, mesh }
      : { x: paddle.x, y: padY + padH / 2 + R, vx: 0, vy: 0, stuck, off: 0, mesh };
    balls.push(ball);
    if (stuck) stuckSince = clock;
    return ball;
  }

  function launch(ball) {
    const hit = clamp(ball.off / (paddle.w / 2), -1, 1);
    const a = (Math.abs(hit) < 0.05 ? (Math.random() - 0.5) * 0.5 : hit * 0.7);
    ball.vx = Math.sin(a) * speed;
    ball.vy = Math.cos(a) * speed;
    ball.stuck = false;
    sfx.paddle();
  }

  // ---- paddle ----

  function steer(dt, now) {
    const hands = input.hands.filter((h) => !h.stale);
    let target = paddle.x, width = BASE_W;
    if (hands.length >= 2) {
      const xs = hands.map((h) => h.palm.x).sort((a, b) => a - b);
      const a = xs[0], b = xs[xs.length - 1];
      target = (a + b) / 2;
      width = clamp(b - a, BASE_W * 0.8, BASE_W * 2.4);
    } else if (hands.length === 1) {
      target = hands[0].palm.x;
    }
    if (now < wideUntil) width *= 1.5;
    width = Math.min(width, fieldW * 0.6);

    paddle.w += (width - paddle.w) * (1 - Math.exp(-dt * 10));
    const lim = right - paddle.w / 2;
    paddle.x += (clamp(target, -lim, lim) - paddle.x) * (1 - Math.exp(-dt * 22));
    paddle.x = clamp(paddle.x, -lim, lim);

    const sticky = input.hands.some((h) => h.fisting);
    paddle.sticky = sticky;
    paddle.mesh.position.x = paddle.x;
    paddle.mesh.position.y = padY;
    kit.size(paddle.mesh, paddle.w, padH, 0.3);
    kit.style(paddle.mesh, sticky ? COLORS.amber : COLORS.mint, sticky ? "bright" : "solid");
  }

  // ---- ball physics ----

  function stepBall(ball, dt, now) {
    if (ball.stuck) {
      ball.x = paddle.x + clamp(ball.off, -paddle.w / 2, paddle.w / 2);
      ball.y = padY + padH / 2 + R;
      return;
    }
    const want = speed * (now < slowUntil ? 0.62 : 1);
    const v = Math.hypot(ball.vx, ball.vy) || 1;
    ball.vx *= want / v;
    ball.vy *= want / v;
    // Never let a ball settle into a near-horizontal loop between the walls.
    if (Math.abs(ball.vy) < want * 0.28) {
      ball.vy = Math.sign(ball.vy || 1) * want * 0.28;
      ball.vx = Math.sign(ball.vx || 1) * Math.sqrt(want * want - ball.vy * ball.vy);
    }

    const steps = Math.max(1, Math.ceil((want * dt) / (R * 0.6)));
    const h = dt / steps;
    for (let s = 0; s < steps; s++) {
      ball.x += ball.vx * h;
      ball.y += ball.vy * h;

      if (ball.x - R < left) { ball.x = left + R; ball.vx = Math.abs(ball.vx); sfx.bounce(); }
      if (ball.x + R > right) { ball.x = right - R; ball.vx = -Math.abs(ball.vx); sfx.bounce(); }
      if (ball.y + R > top) { ball.y = top - R; ball.vy = -Math.abs(ball.vy); sfx.bounce(); }

      if (ball.vy < 0
          && ball.y - R <= padY + padH / 2 && ball.y + R >= padY - padH / 2
          && ball.x >= paddle.x - paddle.w / 2 - R && ball.x <= paddle.x + paddle.w / 2 + R) {
        if (paddle.sticky) {
          ball.stuck = true;
          ball.off = ball.x - paddle.x;
          stuckSince = now;
          sfx.lock();
          return;
        }
        const hit = clamp((ball.x - paddle.x) / (paddle.w / 2), -1, 1);
        const a = hit * 1.05;
        speed = Math.min(speed * 1.025, 11.5);
        ball.vx = Math.sin(a) * speed;
        ball.vy = Math.cos(a) * speed;
        ball.y = padY + padH / 2 + R;
        sfx.paddle();
      }

      for (const b of bricks) {
        if (b.hp <= 0) continue;
        const cx = clamp(ball.x, b.x - b.w / 2, b.x + b.w / 2);
        const cy = clamp(ball.y, b.y - b.h / 2, b.y + b.h / 2);
        const dx = ball.x - cx, dy = ball.y - cy;
        if (dx * dx + dy * dy > R * R) continue;
        // Bounce off whichever face it is least deep into.
        const ox = b.w / 2 + R - Math.abs(ball.x - b.x);
        const oy = b.h / 2 + R - Math.abs(ball.y - b.y);
        if (ox < oy) {
          const sx = Math.sign(ball.x - b.x) || 1;
          ball.vx = sx * Math.abs(ball.vx);
          ball.x += sx * ox;
        } else {
          const sy = Math.sign(ball.y - b.y) || 1;
          ball.vy = sy * Math.abs(ball.vy);
          ball.y += sy * oy;
        }
        hitBrick(b);
        break;
      }

      if (ball.y < lostY) { ball.dead = true; return; }
    }
  }

  function hitBrick(b) {
    b.hp--;
    if (b.hp > 0) {
      kit.style(b.mesh, b.color, "solid");
      score += 20;
      sfx.clink();
      return;
    }
    score += 50;
    sfx.brick(5 - b.row);
    kit.burst(b.x, b.y, b.color, 10, { speed: 3.5, size: 0.1, life: 0.5 });
    kit.remove(b.mesh);
    kit.remove(b.mesh.userData.shell);
    if (b.power) dropItem(b.x, b.y);
    if (!bricks.some((x) => x.hp > 0)) wallCleared();
  }

  function dropItem(x, y) {
    let roll = Math.random() * POWERS.reduce((n, p) => n + p.weight, 0);
    const power = POWERS.find((p) => (roll -= p.weight) < 0) ?? POWERS[0];
    const mesh = kit.shape("diamond", power.color, { w: 0.42, h: 0.42, style: "bright" });
    mesh.position.x = x;
    mesh.position.y = y;
    items.push({ x, y, power, mesh });
  }

  function collect(item, now) {
    const { type, label, color } = item.power;
    sfx.power();
    ctx.popAt(item.x, padY + 0.5, label, "good");
    kit.burst(item.x, padY, color, 12, { speed: 3 });
    if (type === "wide") wideUntil = now + 12000;
    if (type === "slow") slowUntil = now + 9000;
    if (type === "life") lives = Math.min(lives + 1, 5);
    if (type === "multi") {
      const live = balls.filter((b) => !b.stuck && !b.dead);
      const src = live[0] ?? balls[0];
      if (src?.stuck) launch(src);
      const base = live[0] ?? src;
      if (!base) return;
      for (const turn of [0.4, -0.4]) {
        const c = Math.cos(turn), s = Math.sin(turn);
        newBall(false, { x: base.x, y: base.y, vx: base.vx * c - base.vy * s, vy: base.vx * s + base.vy * c });
      }
    }
  }

  function wallCleared() {
    score += 500 * wall;
    ctx.banner(`wall ${wall} down`, "gold");
    sfx.win();
    between = 1.4;
    for (const b of balls) kit.remove(b.mesh);
    balls = [];
    for (const it of items) kit.remove(it.mesh);
    items = [];
  }

  function loseLife() {
    lives--;
    sfx.hurt();
    kit.burst(paddle.x, padY, COLORS.red, 16, { speed: 4 });
    if (lives <= 0) {
      over = true;
      sfx.lose();
      ctx.end({
        score,
        kicker: "out of balls",
        title: String(score),
        sub: `reached wall ${wall}`,
        rows: [{ label: "walls cleared", value: String(wall - 1) }],
      });
      return;
    }
    speed = baseSpeed();
    newBall(true);
    hinted = false;
  }

  function render() {
    for (const b of balls) {
      b.mesh.position.x = b.x;
      b.mesh.position.y = b.y;
    }
  }

  buildWall();
  newBall(true);

  return {
    update(dt, now) {
      clock = now;
      // The launch hint counts from when play began, not from when the board
      // was built behind the how-to card.
      if (!started) { started = true; stuckSince = now; }
      steer(dt, now);
      if (over) return render();

      if (between > 0) {
        between -= dt;
        if (between <= 0) {
          wall++;
          buildWall();
          newBall(true);
          ctx.banner(`wall ${wall}`, "", 1200);
        }
        return render();
      }

      if (input.anyJustPinch) for (const b of balls) if (b.stuck) launch(b);
      if (!hinted && balls.some((b) => b.stuck) && now - stuckSince > 2500) {
        hinted = true;
        ctx.banner("pinch to launch", "", 1600);
      }

      for (const b of balls) stepBall(b, dt, now);
      for (const b of balls.filter((x) => x.dead)) kit.remove(b.mesh);
      balls = balls.filter((b) => !b.dead);
      if (between > 0) return render();       // a hit this frame cleared the wall
      if (!balls.length) loseLife();

      for (const it of items) {
        it.y -= 2.4 * dt;
        it.mesh.position.y = it.y;
        it.mesh.rotation.z += dt * 3;
        if (Math.abs(it.y - padY) < 0.3 && Math.abs(it.x - paddle.x) < paddle.w / 2 + 0.2) {
          it.done = true;
          collect(it, now);
        } else if (it.y < lostY) it.done = true;
      }
      for (const it of items.filter((x) => x.done)) kit.remove(it.mesh);
      items = items.filter((it) => !it.done);

      render();
    },

    idle(dt, now) {
      clock = now;
      steer(dt, now);
      for (const b of balls) if (b.stuck) stepBall(b, dt, now);
      render();
    },

    cursors() {
      kit.beginCursors();
      for (const h of input.hands) {
        if (h.stale) continue;
        kit.cursor(h.palm.x, h.palm.y, { color: h.fisting ? COLORS.amber : COLORS.white, r: 0.26, opacity: 0.5 });
      }
      kit.endCursors();
    },

    stats: () => [
      { k: "score", v: score },
      { k: "wall", v: wall },
      { k: "lives", v: "●".repeat(Math.max(lives, 0)) || "—" },
    ],
  };
}
