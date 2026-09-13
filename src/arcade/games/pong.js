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
 * Online (`ctx.net`), the two players are on two machines. The left player is
 * the HOST: their game runs the ball and the score, and sends the state about
 * fifteen times a second. The right player sends their paddle and their
 * pinches, and draws the ball from what arrives, coasting it in between.
 * Everything on the wire is normalised to the field (-1..1 on both axes), so
 * two screens of different shapes still agree on where the ball is.
 *
 *   hand up/down    the paddle follows your palm
 *   pinch           a SMASH, but only if the pinch lands in the moment before
 *                   the ball reaches you. Pinching early does nothing, so it is
 *                   a timing shot rather than a button to hold.
 *
 * First to seven (online: the room's choice). Every return is a little faster
 * than the last.
 */

const WIN_AT = 7;
const R = 0.14;
const SMASH_WINDOW_MS = 420;
const SMASH_BOOST = 1.5;
const SEND_MS = 66;
const SILENT_MS = 6000;       // online: the other player is gone after this long

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export default function pong(ctx) {
  const { kit, input, sfx } = ctx;
  const safe = kit.safe;
  const net = ctx.net ?? null;
  const versus = ctx.players === 2 || !!net;
  const host = !net || net.side === "left";      // runs the ball
  const winAt = net?.to ?? WIN_AT;

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

  // ---- online ----
  const toNet = { x: (x) => +(x / (fieldW / 2)).toFixed(4), y: (y) => +((y - midY) / (fieldH / 2)).toFixed(4) };
  const fromNet = { x: (v) => v * (fieldW / 2), y: (v) => midY + v * (fieldH / 2) };
  const remote = { y: 0 };          // the other player's paddle, normalised
  let sentAt = 0;
  let heardAt = performance.now();
  const mine = (p) => !net || p.side === net.side;
  const nameOf = (who) => String(net?.names?.[who] ?? `P${who + 1}`).slice(0, 12);

  const unlisten = net?.listen((m) => {
    heardAt = performance.now();
    if (m.t === "paddle") remote.y = m.y;
    else if (m.t === "pinch") paddles.find((p) => !mine(p)).pinchAt = performance.now();
    else if (m.t === "state" && !host) applyState(m);
  });

  function sendState(now, force = false) {
    if (!net || (!force && now - sentAt < SEND_MS)) return;
    sentAt = now;
    const own = paddles.find(mine);
    if (!host) { net.send({ t: "paddle", y: toNet.y(own.y) }); return; }
    net.send({
      t: "state", bx: toNet.x(ball.x), by: toNet.y(ball.y),
      vx: toNet.x(ball.vx), vy: +(ball.vy / (fieldH / 2)).toFixed(4),
      sm: ball.smash, p: points, y: toNet.y(own.y), s: serveIn > 0, o: over,
    });
  }

  function applyState(m) {
    const vx = fromNet.x(m.vx), vy = m.vy * (fieldH / 2);
    // The host decides every hit; the guest hears it as the ball turning round.
    if (ball.vx && vx && Math.sign(vx) !== Math.sign(ball.vx)) {
      if (m.sm) sfx.smash(); else sfx.paddle();
    }
    ball.x = fromNet.x(m.bx);
    ball.y = fromNet.y(m.by);
    ball.vx = vx;
    ball.vy = vy;
    ball.smash = m.sm;
    remote.y = m.y;
    serveIn = m.s ? 1 : 0;
    for (const who of [0, 1]) {
      if (m.p[who] !== points[who]) {
        points[who] = m.p[who];
        sfx.score();
        const own = paddles[who].side === net.side;
        ctx.popAt(0, midY + fieldH * 0.3, `${own ? "you" : nameOf(who)} +1`, own ? "good" : "bad");
      }
    }
    if (m.o && !over) { over = true; endOnline(); }
  }

  function endOnline(sub = null) {
    const me = net.side === "left" ? 0 : 1;
    const won = points[me] > points[1 - me];
    if (won) sfx.win(); else sfx.lose();
    ctx.end({
      score: points[me],
      kicker: won ? "you win" : "you lose",
      title: `${points[0]} – ${points[1]}`,
      sub: sub ?? `${nameOf(0)} vs ${nameOf(1)}`,
      rows: [0, 1].map((i) => ({ label: nameOf(i), value: String(points[i]), win: points[i] > points[1 - i] })),
    });
  }

  // ---- the game ----
  const handFor = (p) => (net ? input.primary() : versus ? input.primary(p.side) : input.primary());

  function movePaddles(dt, now) {
    for (const p of paddles) {
      let target = p.y;
      if (net && !mine(p)) {
        target = fromNet.y(remote.y);
      } else if (p.human) {
        const hand = handFor(p);
        if (hand) target = hand.palm.y;
        const pinched = versus && !net ? input.side(p.side).some((h) => h.justPinch) : input.anyJustPinch;
        if (pinched) {
          p.pinchAt = now;
          net?.send({ t: "pinch" });
        }
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

  function scored(side, now) {
    const who = side === "left" ? 0 : 1;
    points[who]++;
    sfx.score();
    kit.burst(ball.x > 0 ? fieldW / 2 : -fieldW / 2, ball.y, paddles[who].color, 24, { speed: 5 });
    const label = net ? (mine(paddles[who]) ? "you" : nameOf(who)) : versus ? `P${who + 1}` : who === 0 ? "you" : "cpu";
    const good = net ? mine(paddles[who]) : who === 0;
    ctx.popAt(0, midY + fieldH * 0.3, `${label} +1`, good ? "good" : "bad");
    // Serve toward whoever just lost the point.
    serveDir = who === 0 ? 1 : -1;
    serveIn = 1.0;
    ball.vx = 0;
    ball.vy = 0;
    ball.x = 0;
    ball.y = midY;

    if (points[who] >= winAt) {
      over = true;
      const [a, b] = points;
      if (net) {
        sendState(now, true);
        endOnline();
      } else if (versus) {
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

      if (ball.x < -fieldW / 2 - 0.4) return scored("right", now);
      if (ball.x > fieldW / 2 + 0.4) return scored("left", now);
    }
  }

  /** The guest's ball between packets: straight lines and wall bounces only.
   *  Paddles and scoring are the host's call. */
  function coast(dt) {
    ball.x = clamp(ball.x + ball.vx * dt, -fieldW / 2 - 0.4, fieldW / 2 + 0.4);
    ball.y += ball.vy * dt;
    if (ball.y + R > top) { ball.y = top - R; ball.vy = -Math.abs(ball.vy); }
    if (ball.y - R < bot) { ball.y = bot + R; ball.vy = Math.abs(ball.vy); }
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
      sendState(now);
      if (over) return render(now);
      if (net && now - heardAt > SILENT_MS) {
        over = true;
        endOnline("The other player dropped out.");
        return render(now);
      }
      if (!host) {
        if (serveIn <= 0) coast(dt);
        return render(now);
      }
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
      sendState(now);
      render(now);
    },

    cursors() {
      kit.beginCursors();
      for (const p of paddles) {
        if (!p.human || !mine(p)) continue;
        const hand = handFor(p);
        if (hand && !hand.stale) kit.cursor(hand.palm.x, hand.palm.y, { color: p.color, r: 0.26, opacity: 0.6 });
      }
      kit.endCursors();
    },

    stats: () => (net
      ? [{ k: nameOf(0), v: points[0], cls: "p1" }, { k: "to", v: winAt }, { k: nameOf(1), v: points[1], cls: "p2" }]
      : versus
        ? [{ k: "P1", v: points[0], cls: "p1" }, { k: "to", v: WIN_AT }, { k: "P2", v: points[1], cls: "p2" }]
        : [{ k: "you", v: points[0], cls: "p1" }, { k: "to", v: WIN_AT }, { k: "cpu", v: points[1] }]),

    dispose() { unlisten?.(); },
  };
}
