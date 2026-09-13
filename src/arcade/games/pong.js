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
 * Online (`ctx.net`), the two players are on two machines, and EACH PLAYER
 * DECIDES THE HITS ON THEIR OWN PADDLE. Deciding them all on one machine meant
 * the other player's paddle always arrived a network delay late, and a ball
 * blocked on their screen still went through. Instead:
 *
 *   host (left)   serves, keeps the score, and sends the state ~15 times a
 *                 second. Its ball bounces off its own paddle as usual; when
 *                 the ball reaches the guest's paddle it WAITS there for the
 *                 guest's verdict (a short hitch on the host's screen).
 *   guest (right) runs the ball itself between host hits, so it can judge its
 *                 own paddle with no delay, and sends "hit" (with the new ball)
 *                 or "miss". Smash timing is judged there too.
 *
 * Every hit or serve bumps a `volley` number, so a message about an older
 * volley that arrives late is ignored rather than rewinding the ball.
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
const VERDICT_MS = 900;       // online host: longest wait for the guest's hit or miss

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export default function pong(ctx) {
  const { kit, input, sfx } = ctx;
  const safe = kit.safe;
  const net = ctx.net ?? null;
  const versus = ctx.players === 2 || !!net;
  const host = !net || net.side === "left";      // serves and keeps the score
  const winAt = net?.to ?? WIN_AT;

  const fieldW = Math.min(kit.w * 0.88, kit.h * 1.9);
  const top = safe.top - 0.05, bot = safe.bottom + 0.05;
  const midY = (top + bot) / 2, fieldH = top - bot;
  const padX = fieldW / 2 - 0.35, padW = 0.22, padH = fieldH * 0.21;
  const goal = fieldW / 2 + 0.4;

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
  const toNet = {
    x: (x) => +(x / (fieldW / 2)).toFixed(4),
    y: (y) => +((y - midY) / (fieldH / 2)).toFixed(4),
    vy: (vy) => +(vy / (fieldH / 2)).toFixed(4),
  };
  const fromNet = {
    x: (v) => v * (fieldW / 2),
    y: (v) => midY + v * (fieldH / 2),
    vy: (v) => v * (fieldH / 2),
  };
  const remote = { y: 0 };          // the other player's paddle, normalised
  let sentAt = 0;
  let heardAt = performance.now();
  let volley = 0;                   // bumped by every serve and every hit
  let waitingSince = null;          // host: ball parked at the guest's paddle
  let missSent = false;             // guest: told the host the ball got past
  const mine = (p) => !net || p.side === net.side;
  const nameOf = (who) => String(net?.names?.[who] ?? `P${who + 1}`).slice(0, 12);
  /** Whether this machine judges hits on paddle `p`. Offline: all of them. */
  const judges = (p) => !net || mine(p);
  const towardGuest = () => ball.vx > 0;

  const ballMsg = () => ({
    bx: toNet.x(ball.x), by: toNet.y(ball.y), vx: toNet.x(ball.vx), vy: toNet.vy(ball.vy),
    sm: ball.smash, r: rally,
  });

  function adoptBall(m) {
    ball.x = fromNet.x(m.bx);
    ball.y = fromNet.y(m.by);
    ball.vx = fromNet.x(m.vx);
    ball.vy = fromNet.vy(m.vy);
    ball.smash = !!m.sm;
    rally = m.r ?? rally;
  }

  const unlisten = net?.listen((m) => {
    heardAt = performance.now();
    if (m.t === "paddle") remote.y = m.y;
    else if (m.t === "state" && !host) applyState(m);
    else if (m.t === "hit" && host) guestHit(m);
    else if (m.t === "miss" && host) guestMissed(m);
  });

  function sendState(now, force = false) {
    if (!net || (!force && now - sentAt < SEND_MS)) return;
    sentAt = now;
    const own = paddles.find(mine);
    if (!host) { net.send({ t: "paddle", y: toNet.y(own.y) }); return; }
    net.send({ t: "state", ...ballMsg(), v: volley, p: points, y: toNet.y(own.y), s: serveIn > 0, o: over });
  }

  /** Guest: the host's view of the game. The ball is only taken from it when
   *  the host has served or hit since; otherwise the guest's own ball, which
   *  is ahead of any packet, is the better one. */
  function applyState(m) {
    remote.y = m.y;
    if (m.s) {
      serveIn = 1;
      ball.x = 0; ball.y = midY; ball.vx = 0; ball.vy = 0; ball.smash = false;
      missSent = false;
    } else {
      serveIn = 0;
    }
    if (!m.s && m.v > volley) {
      const wasTowardMe = ball.vx > 0;
      volley = m.v;
      adoptBall(m);
      missSent = false;
      // A host return, heard here as the ball turning round.
      if (!wasTowardMe && ball.vx > 0 && rally > 0) {
        if (ball.smash) sfx.smash(); else sfx.paddle();
      }
    }
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

  /** Host: the guest returned the ball. */
  function guestHit(m) {
    if (over || serveIn > 0 || !towardGuest() || m.v !== volley + 1) return;
    volley = m.v;
    waitingSince = null;
    adoptBall(m);
    ball.speed = Math.min(6.2 * Math.pow(1.05, rally), 13);
    const p = paddles[1];
    if (ball.smash) {
      sfx.smash();
      ctx.banner("smash!", "gold", 700);
      kit.burst(ball.x, ball.y, p.color, 18, { speed: 5 });
    } else sfx.paddle();
  }

  /** Host: the ball got past the guest. */
  function guestMissed(m) {
    if (over || serveIn > 0 || !towardGuest() || m.v !== volley) return;
    waitingSince = null;
    scored("left", performance.now());
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
        if (pinched) p.pinchAt = now;
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
    volley++;
    sfx.go();
  }

  function paddleHit(p, now) {
    const hit = clamp((ball.y - p.y) / (padH / 2), -1, 1);
    const a = hit * 0.9;
    rally++;
    volley++;
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
    // The guest's own return goes straight to the host, ahead of the next
    // state packet: the host is holding the ball until it hears.
    if (net && !host) net.send({ t: "hit", v: volley, ...ballMsg() });
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
    waitingSince = null;
    if (net) sendState(now, true);

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

  /**
   * Move the ball one frame. Bounces off walls always, and off the paddles
   * this machine judges. What happens at each end:
   *   offline          a point, as ever
   *   host, own end    a point to the guest
   *   host, guest end  the ball parks at the guest's paddle to await a verdict
   *   guest, own end   past the paddle: tell the host it was a miss
   *   guest, host end  the ball stops at the host's paddle until the host's
   *                    next packet says what happened
   */
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
        if (!reached) continue;

        if (!judges(p)) {
          // The other machine's paddle: stop in front of it and wait.
          ball.x = face + (p.side === "left" ? R : -R);
          if (host && waitingSince == null) waitingSince = now;
          return;
        }
        const notPast = Math.abs(ball.x - p.x) < padW / 2 + R + 0.25;
        if (notPast && Math.abs(ball.y - p.y) <= padH / 2 + R) { paddleHit(p, now); break; }
        // Clean past the guest's own paddle: the host hears it now, not at
        // the goal line, so its wait is as short as it can be.
        if (net && !host && mine(p) && !notPast && !missSent) {
          missSent = true;
          net.send({ t: "miss", v: volley });
        }
      }

      if (ball.x < -goal) {
        if (net && !host) { ball.x = -goal; return; }
        return scored("right", now);
      }
      if (ball.x > goal) {
        if (net) { ball.x = goal; return; }       // guest: the host scores it when it hears
        return scored("left", now);
      }
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
      sendState(now);
      if (over) return render(now);
      if (net && now - heardAt > SILENT_MS) {
        over = true;
        endOnline("The other player dropped out.");
        return render(now);
      }
      if (!host) {
        if (serveIn <= 0) step(dt, now);
        return render(now);
      }
      if (serveIn > 0) {
        serveIn -= dt;
        if (serveIn <= 0) serve();
      } else if (waitingSince != null) {
        // Parked at the guest's paddle. A guest this far behind has missed.
        if (now - waitingSince > VERDICT_MS) {
          waitingSince = null;
          scored("left", now);
        }
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
