import { COLORS } from "../kit.js";
import { paletteFor, hexToInt } from "../../settings.js";

/**
 * Air Pong — Pong, with your hand as the paddle.
 *
 * One player plays the left paddle against the computer. Two players split the
 * camera exactly as Play mode's versus does: whoever is on the left half of the
 * frame is the left paddle. Paddles are in each player's own block colour from
 * Settings, so it is always obvious whose side is whose.
 *
 *   hand up/down    the paddle follows your palm
 *   pinch           a SMASH, but only if the pinch lands in the moment before
 *                   the ball reaches you. Pinching early does nothing, so it is
 *                   a timing shot rather than a button to hold.
 *
 * First to seven. Every return is a little faster than the last.
 */

const WIN_AT = 7;
const R = 0.14;
const SMASH_WINDOW_MS = 420;
const SMASH_BOOST = 1.5;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export default function pong(ctx) {
  const { kit, input, sfx } = ctx;
  const safe = kit.safe;
  const versus = ctx.players === 2;

  const fieldW = Math.min(kit.w * 0.88, kit.h * 1.9);
  const top = safe.top - 0.05, bot = safe.bottom + 0.05;
  const midY = (top + bot) / 2, fieldH = top - bot;
  const padX = fieldW / 2 - 0.35, padW = 0.22, padH = fieldH * 0.21;

  kit.panel(0, midY, fieldW, fieldH, 0x05080c, 0.22);
  kit.polyline([[-fieldW / 2, top], [fieldW / 2, top]], 0xffffff, 0.5);
  kit.polyline([[-fieldW / 2, bot], [fieldW / 2, bot]], 0xffffff, 0.5);
  kit.dashes(0, bot, 0, top, 14, 0xffffff, 0.3);

  const c1 = hexToInt(paletteFor(1).idle), c2 = versus ? hexToInt(paletteFor(2).idle) : COLORS.rose;

  const paddles = [
    { side: "left", x: -padX, y: midY, color: c1, pinchAt: -1e9, mesh: null, human: true },
    { side: "right", x: padX, y: midY, color: c2, pinchAt: -1e9, mesh: null, human: versus },
  ];
  for (const p of paddles) {
    p.mesh = kit.shape("box", p.color, { w: padW, h: padH, d: 0.3 });
    p.mesh.position.x = p.x;
  }

  const ball = { x: 0, y: midY, vx: 0, vy: 0, speed: 6.2, smash: false, mesh: kit.shape("circle", COLORS.white, { w: R * 2, h: R * 2, style: "bright" }) };
  const points = [0, 0];
  let serveIn = 1.0, serveDir = Math.random() < 0.5 ? -1 : 1;
  let rally = 0;
  let cpuAim = 0;
  let over = false;

  const handFor = (p) => (versus ? input.primary(p.side) : input.primary());

  function movePaddles(dt, now) {
    for (const p of paddles) {
      let target = p.y;
      if (p.human) {
        const hand = handFor(p);
        if (hand) target = hand.palm.y;
        if (versus ? input.side(p.side).some((h) => h.justPinch) : input.anyJustPinch) p.pinchAt = now;
      } else {
        // The computer: tracks the ball when it is coming, drifts home when it
        // is not, and is slower and less exact than it could be.
        const coming = ball.vx > 0;
        target = coming ? ball.y + cpuAim : midY;
        const max = (3.4 + Math.min(rally, 12) * 0.16) * dt;
        const k = clamp(target - p.y, -max, max);
        target = p.y + k;
      }
      const lim = fieldH / 2 - padH / 2;
      target = clamp(target, midY - lim, midY + lim);
      p.y = p.human ? p.y + (target - p.y) * (1 - Math.exp(-dt * 18)) : target;
      p.mesh.position.y = p.y;
      const hot = p.human && now - p.pinchAt < SMASH_WINDOW_MS;
      kit.style(p.mesh, p.color, hot ? "bright" : "solid");
    }
  }

  function serve() {
    const a = (Math.random() - 0.5) * 0.8;
    ball.x = 0;
    ball.y = midY;
    ball.speed = 6.2;
    ball.smash = false;
    ball.vx = Math.cos(a) * ball.speed * serveDir;
    ball.vy = Math.sin(a) * ball.speed;
    rally = 0;
    sfx.go();
  }

  function paddleHit(p, now) {
    const hit = clamp((ball.y - p.y) / (padH / 2), -1, 1);
    const a = hit * 0.9;
    rally++;
    ball.speed = Math.min(6.2 * Math.pow(1.05, rally), 13);
    const smash = p.human ? now - p.pinchAt < SMASH_WINDOW_MS : rally > 3 && Math.random() < 0.12;
    ball.smash = smash;
    const spd = ball.speed * (smash ? SMASH_BOOST : 1);
    const dirX = p.side === "left" ? 1 : -1;
    ball.vx = Math.cos(a) * spd * dirX;
    ball.vy = Math.sin(a) * spd;
    ball.x = p.x + dirX * (padW / 2 + R);
    cpuAim = (Math.random() - 0.5) * padH * 0.9;
    if (smash) {
      p.pinchAt = -1e9;
      sfx.smash();
      ctx.banner("smash!", "gold", 700);
      kit.burst(ball.x, ball.y, p.color, 18, { speed: 5 });
    } else sfx.paddle();
  }

  function scored(side) {
    const who = side === "left" ? 0 : 1;
    points[who]++;
    sfx.score();
    kit.burst(ball.x > 0 ? fieldW / 2 : -fieldW / 2, ball.y, paddles[who].color, 24, { speed: 5 });
    const label = versus ? `P${who + 1}` : who === 0 ? "you" : "cpu";
    ctx.popAt(0, midY + fieldH * 0.3, `${label} +1`, who === 0 ? "good" : "bad");
    // Serve toward whoever just lost the point.
    serveDir = who === 0 ? 1 : -1;
    serveIn = 1.0;
    ball.vx = 0;
    ball.vy = 0;
    ball.x = 0;
    ball.y = midY;

    if (points[who] >= WIN_AT) {
      over = true;
      const [a, b] = points;
      if (versus) {
        sfx.win();
        ctx.end({ kicker: "match point", title: `Player ${who + 1} wins`, sub: `${a} – ${b}`,
                  rows: [{ label: "Player 1", value: String(a), win: a > b }, { label: "Player 2", value: String(b), win: b > a }] });
      } else {
        if (who === 0) sfx.win(); else sfx.lose();
        ctx.end({
          score: who === 0 ? 1000 + (WIN_AT - b) * 100 : a * 100,
          kicker: who === 0 ? "you win" : "cpu wins",
          title: `${a} – ${b}`,
          sub: who === 0 ? "Clean hands." : "Pinch right before contact to smash it past the cpu.",
        });
      }
    }
  }

  function step(dt, now) {
    const steps = Math.max(1, Math.ceil((Math.hypot(ball.vx, ball.vy) * dt) / (R * 0.6)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      ball.x += ball.vx * h;
      ball.y += ball.vy * h;
      if (ball.y + R > top) { ball.y = top - R; ball.vy = -Math.abs(ball.vy); sfx.bounce(); }
      if (ball.y - R < bot) { ball.y = bot + R; ball.vy = Math.abs(ball.vy); sfx.bounce(); }

      for (const p of paddles) {
        const toward = p.side === "left" ? ball.vx < 0 : ball.vx > 0;
        if (!toward) continue;
        const face = p.side === "left" ? p.x + padW / 2 : p.x - padW / 2;
        const reached = p.side === "left" ? ball.x - R <= face : ball.x + R >= face;
        const notPast = Math.abs(ball.x - p.x) < padW / 2 + R + 0.25;
        if (reached && notPast && Math.abs(ball.y - p.y) <= padH / 2 + R) paddleHit(p, now);
      }

      if (ball.x < -fieldW / 2 - 0.4) return scored("right");
      if (ball.x > fieldW / 2 + 0.4) return scored("left");
    }
  }

  function render(now) {
    ball.mesh.position.x = ball.x;
    ball.mesh.position.y = ball.y;
    kit.style(ball.mesh, ball.smash ? COLORS.gold : COLORS.white, "bright");
    ball.mesh.visible = serveIn <= 0 || Math.floor(now / 120) % 2 === 0;
  }

  return {
    update(dt, now) {
      movePaddles(dt, now);
      if (over) return render(now);
      if (serveIn > 0) {
        serveIn -= dt;
        if (serveIn <= 0) serve();
      } else {
        step(dt, now);
        if (ball.smash && Math.random() < 0.5) kit.burst(ball.x, ball.y, COLORS.gold, 1, { speed: 0.6, size: 0.08, life: 0.3 });
      }
      render(now);
    },

    idle(dt, now) {
      movePaddles(dt, now);
      render(now);
    },

    cursors() {
      kit.beginCursors();
      for (const p of paddles) {
        if (!p.human) continue;
        const hand = handFor(p);
        if (hand && !hand.stale) kit.cursor(hand.palm.x, hand.palm.y, { color: p.color, r: 0.26, opacity: 0.6 });
      }
      kit.endCursors();
    },

    stats: () => (versus
      ? [{ k: "P1", v: points[0], cls: "p1" }, { k: "to", v: WIN_AT }, { k: "P2", v: points[1], cls: "p2" }]
      : [{ k: "you", v: points[0], cls: "p1" }, { k: "to", v: WIN_AT }, { k: "cpu", v: points[1] }]),
  };
}
