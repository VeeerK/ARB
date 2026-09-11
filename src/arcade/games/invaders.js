import { COLORS, KIND_COLOR } from "../kit.js";
import { SHAPE_LABEL } from "../../picker.js";

/**
 * Shape Invaders — Space Invaders, where the ammo is a hand sign.
 *
 * The invaders are the app's own three shapes, and a shot only destroys the
 * shape it matches. You choose what you fire the way you choose what you draw
 * in freestyle — fingers up:
 *
 *   1 finger   squares      2 fingers   circles      3 fingers   triangles
 *
 * Holding the count up IS the trigger: the cannon auto-fires for as long as
 * the fingers stay up, and follows the hand across the bottom of the screen. A
 * wrong shape clinks off harmlessly, so the game is reading the formation and
 * switching fingers fast, not mashing a button.
 *
 *   fist       raises a shield over the cannon for a moment (then recharges)
 *
 * The saucer that crosses the top is a wildcard: any shape brings it down.
 */

const KINDS = ["box", "circle", "triangle"];
const COLS = 7;
const S = 0.48;                 // invader size
const FIRE_EVERY = 0.32;
const SHIELD_TIME = 1.8, SHIELD_COOLDOWN = 4.5;

export default function invaders(ctx) {
  const { kit, input, sfx } = ctx;
  const safe = kit.safe;

  const fieldW = Math.min(kit.w * 0.9, kit.h * 1.6);
  const left = -fieldW / 2, right = fieldW / 2;
  const cannonY = safe.bottom + 0.3;
  const ufoY = safe.top - 0.3;
  const gapX = Math.min(1.0, (fieldW * 0.62) / (COLS - 1));
  const gapY = 0.72;

  kit.polyline([[left, cannonY - 0.3], [right, cannonY - 0.3]], 0xffffff, 0.35);

  let wave = 1;
  let rows = 3;
  let army = [];
  let ox = 0, oy = 0, dir = 1;
  let bullets = [], shots = [];
  let ufo = null, ufoIn = 16;
  let lives = 3, score = 0;
  let fireCd = 0, enemyCd = 1.5;
  let shieldT = 0, shieldCd = 0, invuln = 0;
  let between = 0;
  let over = false;
  let noFingersFor = 0, hinted = false;
  let ammo = null;

  const cannon = { x: 0, mesh: kit.shape("triangle", COLORS.white, { w: 0.62, h: 0.5, d: 0.35 }) };
  const shield = kit.ring(0, cannonY, 0.75, COLORS.sky, 0.75);
  shield.visible = false;

  function buildWave() {
    for (const inv of army) kit.remove(inv.mesh);
    army = [];
    rows = Math.min(3 + Math.floor((wave - 1) / 2), 5);
    const y0 = ufoY - 0.75;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < COLS; c++) {
        const kind = KINDS[Math.floor(Math.random() * 3)];
        const mesh = kit.shape(kind, KIND_COLOR[kind], { w: S, h: S });
        army.push({ kind, r, c, mesh, flash: 0, alive: true, x: 0, y: 0, y0 });
      }
    }
    ox = 0; oy = 0; dir = 1;
    placeArmy(0);
  }

  function placeArmy(t) {
    for (const inv of army) {
      if (!inv.alive) continue;
      inv.x = (inv.c - (COLS - 1) / 2) * gapX + ox;
      inv.y = inv.y0 - inv.r * gapY + oy;
      inv.mesh.position.x = inv.x;
      inv.mesh.position.y = inv.y + Math.sin(t * 4 + inv.c) * 0.03;
      inv.mesh.rotation.z = Math.sin(t * 3 + inv.r + inv.c * 0.7) * 0.12;
      kit.style(inv.mesh, inv.flash > 0 ? COLORS.white : KIND_COLOR[inv.kind], inv.flash > 0 ? "bright" : "solid");
    }
  }

  function march(dt) {
    const alive = army.filter((a) => a.alive);
    const total = army.length || 1;
    const speed = 0.5 * (1 + 2.2 * (1 - alive.length / total)) * (1 + 0.18 * (wave - 1));
    ox += dir * speed * dt;
    let minX = Infinity, maxX = -Infinity;
    for (const a of alive) {
      const x = (a.c - (COLS - 1) / 2) * gapX + ox;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
    if (maxX + S / 2 > right && dir > 0) { dir = -1; oy -= 0.26; ox -= maxX + S / 2 - right; }
    if (minX - S / 2 < left && dir < 0) { dir = 1; oy -= 0.26; ox += left - (minX - S / 2); }
  }

  function kill(inv) {
    inv.alive = false;
    kit.remove(inv.mesh);
    kit.burst(inv.x, inv.y, KIND_COLOR[inv.kind], 14, { speed: 4, kind: inv.kind });
    const pts = (rows - inv.r) * 10 * wave;
    score += pts;
    sfx.explode();
    ctx.popAt(inv.x, inv.y, `+${pts}`);
    if (!army.some((a) => a.alive)) {
      score += 250 * wave;
      ctx.banner(`wave ${wave} cleared`, "gold");
      sfx.win();
      between = 1.6;
      for (const b of bullets) kit.remove(b.mesh);
      for (const s of shots) kit.remove(s.mesh);
      bullets = [];
      shots = [];
    }
  }

  function hurt() {
    if (invuln > 0) return;
    lives--;
    invuln = 1.6;
    sfx.hurt();
    kit.burst(cannon.x, cannonY, COLORS.red, 20, { speed: 5 });
    if (lives <= 0) end("shot down");
  }

  function end(kicker) {
    if (over) return;
    over = true;
    sfx.lose();
    ctx.end({
      score, kicker, title: String(score), sub: `reached wave ${wave}`,
      rows: [{ label: "waves cleared", value: String(wave - 1) }],
    });
  }

  // ---- the cannon ----

  function aim(dt) {
    // The hand showing fingers is the one aiming; otherwise any hand.
    const hand = input.hands.find((h) => !h.stale && h.fingers > 0) ?? input.primary();
    if (hand) {
      const lim = right - 0.35;
      const tx = Math.max(-lim, Math.min(lim, hand.palm.x));
      cannon.x += (tx - cannon.x) * (1 - Math.exp(-dt * 16));
    }
    ammo = hand && hand.fingers > 0 ? KINDS[hand.fingers - 1] : null;
    cannon.mesh.position.x = cannon.x;
    cannon.mesh.position.y = cannonY;
    kit.style(cannon.mesh, ammo ? KIND_COLOR[ammo] : COLORS.white, ammo ? "bright" : "solid");
    cannon.mesh.visible = invuln <= 0 || Math.floor(invuln * 12) % 2 === 0;
    shield.position.x = cannon.x;
    return hand;
  }

  buildWave();

  return {
    update(dt, now) {
      const t = now / 1000;
      const hand = aim(dt);
      if (over) return placeArmy(t);

      if (between > 0) {
        between -= dt;
        if (between <= 0) {
          wave++;
          buildWave();
          ctx.banner(`wave ${wave}`, "", 1200);
          sfx.power();
        }
        return;
      }

      invuln = Math.max(0, invuln - dt);
      fireCd -= dt;
      shieldCd = Math.max(0, shieldCd - dt);
      shieldT = Math.max(0, shieldT - dt);

      // Fingers up is the trigger.
      if (ammo && fireCd <= 0) {
        fireCd = FIRE_EVERY;
        const mesh = kit.shape(ammo, KIND_COLOR[ammo], { w: 0.22, h: 0.22, style: "bright" });
        bullets.push({ x: cannon.x, y: cannonY + 0.35, kind: ammo, mesh });
        sfx.shoot();
      }
      noFingersFor = ammo ? 0 : noFingersFor + dt;
      if (!hinted && noFingersFor > 3 && hand) {
        hinted = true;
        ctx.banner("hold up 1, 2 or 3 fingers to fire", "", 2200);
      }

      if (input.hands.some((h) => h.justFist) && shieldCd <= 0) {
        shieldT = SHIELD_TIME;
        shieldCd = SHIELD_COOLDOWN;
        sfx.rotate();
      }
      shield.visible = shieldT > 0 && (shieldT > 0.4 || Math.floor(shieldT * 16) % 2 === 0);

      march(dt);
      for (const inv of army) inv.flash = Math.max(0, inv.flash - dt);
      placeArmy(t);

      // Player bullets.
      for (const b of bullets) {
        b.y += 8.5 * dt;
        b.mesh.position.x = b.x;
        b.mesh.position.y = b.y;
        b.mesh.rotation.z += dt * 8;
        if (b.y > safe.top + 0.2) { b.done = true; continue; }

        if (ufo && Math.abs(b.x - ufo.x) < 0.5 && Math.abs(b.y - ufoY) < 0.3) {
          b.done = true;
          const pts = 100 * (2 + Math.floor(Math.random() * 3));
          score += pts;
          kit.burst(ufo.x, ufoY, COLORS.rose, 26, { speed: 5, kind: "diamond" });
          ctx.banner(`saucer +${pts}`, "gold", 1100);
          sfx.explode();
          kit.remove(ufo.mesh);
          ufo = null;
          continue;
        }

        for (const inv of army) {
          if (!inv.alive || Math.abs(b.x - inv.x) > S / 2 + 0.08 || Math.abs(b.y - inv.y) > S / 2 + 0.08) continue;
          b.done = true;
          if (inv.kind === b.kind) kill(inv);
          else { inv.flash = 0.14; sfx.clink(); }
          break;
        }
        if (between > 0) break;
      }
      for (const b of bullets.filter((x) => x.done)) kit.remove(b.mesh);
      bullets = bullets.filter((b) => !b.done && between <= 0);
      if (between > 0) return;

      // Enemy fire, from the lowest invader in a random column.
      enemyCd -= dt;
      if (enemyCd <= 0) {
        enemyCd = Math.max(0.45, 1.5 - wave * 0.12) * (0.6 + Math.random() * 0.8);
        const alive = army.filter((a) => a.alive);
        if (alive.length) {
          const col = alive[Math.floor(Math.random() * alive.length)].c;
          const shooter = alive.filter((a) => a.c === col).sort((a, b) => b.r - a.r)[0];
          const mesh = kit.shape("diamond", COLORS.red, { w: 0.18, h: 0.3, style: "bright" });
          shots.push({ x: shooter.x, y: shooter.y - S / 2, mesh, vy: 3 + wave * 0.25 });
        }
      }
      for (const s of shots) {
        s.y -= s.vy * dt;
        s.mesh.position.x = s.x;
        s.mesh.position.y = s.y;
        if (s.y < cannonY - 0.6) { s.done = true; continue; }
        if (shieldT > 0 && Math.hypot(s.x - cannon.x, s.y - cannonY) < 0.8) {
          s.done = true;
          sfx.clink();
          kit.burst(s.x, s.y, COLORS.sky, 6, { speed: 2.5 });
          continue;
        }
        if (Math.abs(s.x - cannon.x) < 0.32 && Math.abs(s.y - cannonY) < 0.28) {
          s.done = true;
          hurt();
        }
      }
      for (const s of shots.filter((x) => x.done)) kit.remove(s.mesh);
      shots = shots.filter((s) => !s.done);

      // The saucer.
      ufoIn -= dt;
      if (!ufo && ufoIn <= 0) {
        const from = Math.random() < 0.5 ? -1 : 1;
        ufo = { x: from * (right + 0.6), dir: -from, mesh: kit.shape("diamond", COLORS.rose, { w: 0.9, h: 0.36, style: "bright" }) };
        ufoIn = 14 + Math.random() * 10;
      }
      if (ufo) {
        ufo.x += ufo.dir * 2.3 * dt;
        ufo.mesh.position.x = ufo.x;
        ufo.mesh.position.y = ufoY + Math.sin(t * 6) * 0.05;
        if (Math.abs(ufo.x) > right + 0.8) { kit.remove(ufo.mesh); ufo = null; }
      }

      // Invaded.
      if (army.some((a) => a.alive && a.y - S / 2 < cannonY + 0.4)) end("invaded");
    },

    idle(dt, now) {
      aim(dt);
      placeArmy(now / 1000);
    },

    stats: () => [
      { k: "score", v: score },
      { k: "wave", v: wave },
      { k: "lives", v: "●".repeat(Math.max(lives, 0)) || "—" },
      { k: "ammo", v: ammo ? SHAPE_LABEL[ammo] : "—" },
      { k: "shield", v: shieldT > 0 ? "up" : shieldCd > 0 ? `${Math.ceil(shieldCd)}s` : "ready" },
    ],
  };
}
