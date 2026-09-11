import { COLORS } from "../kit.js";

/**
 * Pop Rush — whack-a-mole with the whole gesture set.
 *
 * Targets appear all over the frame and shrink away. Each asks for the
 * gesture that already means something to that kind of thing in freestyle:
 *
 *   bubble     pinch it          (a pinch on something picks it up)
 *   crate      close a fist on it (a fist grabs, and here it smashes)
 *   gold star  pinch it: +5 seconds
 *   red bomb   do NOT touch it: −5 seconds. Red always means "destroyed".
 *
 * Only the MOMENT a pinch or fist closes counts, so holding a pinch and
 * sweeping it across the screen pops nothing. Quick hits in a row build a
 * combo, up to five times the points.
 */

const ROUND = 45;
const TYPES = {
  bubble: { kind: "circle", color: COLORS.sky, r: 0.36, ttl: 2.6, points: 10, weight: 55, needs: "pinch" },
  crate: { kind: "box", color: COLORS.amber, r: 0.5, ttl: 3.0, points: 25, weight: 25, needs: "fist" },
  gold: { kind: "diamond", color: COLORS.gold, r: 0.32, ttl: 1.8, points: 30, weight: 6, needs: "pinch" },
  bomb: { kind: "circle", color: COLORS.red, r: 0.4, ttl: 3.2, points: 0, weight: 14, needs: null },
};
const MAX_ALIVE = 7;
const COMBO_WINDOW = 1.3;

export default function pop(ctx) {
  const { kit, input, sfx } = ctx;
  const safe = kit.safe;
  const xLim = Math.min(kit.w / 2 - 0.9, kit.h * 0.95);
  const yTop = safe.top - 0.6, yBot = safe.bottom + 0.6;

  let targets = [];
  let t = 0;
  let left = ROUND;
  let spawnIn = 0.4;
  let score = 0, popped = 0, combo = 0, maxCombo = 0, lastHit = -9;
  let over = false;

  function spawn() {
    const total = Object.values(TYPES).reduce((n, x) => n + x.weight, 0);
    let roll = Math.random() * total;
    const [type, spec] = Object.entries(TYPES).find(([, x]) => (roll -= x.weight) < 0);
    let x = 0, y = 0;
    for (let i = 0; i < 20; i++) {
      x = (Math.random() * 2 - 1) * xLim;
      y = yBot + Math.random() * (yTop - yBot);
      if (!targets.some((o) => Math.hypot(o.x - x, o.y - y) < o.r + spec.r + 0.3)) break;
    }
    const mesh = kit.shape(spec.kind, spec.color, { w: spec.r * 2, h: spec.r * 2, style: type === "bomb" ? "bright" : "solid" });
    mesh.position.x = x;
    mesh.position.y = y;
    const mark = type === "bomb" ? kit.ring(x, y, spec.r * 1.35, COLORS.red, 0.6) : null;
    targets.push({ type, spec, x, y, r: spec.r, mesh, mark, age: 0 });
  }

  function remove(o) {
    o.dead = true;
    kit.remove(o.mesh);
    kit.remove(o.mark);
  }

  function hit(o) {
    remove(o);
    if (o.type === "bomb") {
      left = Math.max(0, left - 5);
      combo = 0;
      sfx.hurt();
      kit.burst(o.x, o.y, COLORS.red, 26, { speed: 6 });
      ctx.popAt(o.x, o.y, "−5s", "bad");
      ctx.banner("boom", "bad", 700);
      return;
    }
    combo = t - lastHit < COMBO_WINDOW ? Math.min(combo + 1, 5) : 1;
    lastHit = t;
    maxCombo = Math.max(maxCombo, combo);
    popped++;
    const pts = o.spec.points * combo;
    score += pts;
    if (o.type === "gold") { left += 5; sfx.power(); }
    else if (o.type === "crate") sfx.smash();
    else sfx.pop();
    kit.burst(o.x, o.y, o.spec.color, o.type === "crate" ? 16 : 10, { speed: 4, kind: o.type === "crate" ? "box" : "box" });
    ctx.popAt(o.x, o.y, o.type === "gold" ? `+5s +${pts}` : combo > 1 ? `+${pts} ×${combo}` : `+${pts}`,
      o.type === "gold" ? "gold" : combo >= 3 ? "good" : "");
    if (combo === 5) ctx.banner("×5 combo", "gold", 700);
  }

  /** The nearest target within reach of a point, of the given kinds. */
  function nearest(p, reach, pred) {
    let best = null, bestD = Infinity;
    for (const o of targets) {
      if (o.dead || !pred(o)) continue;
      const d = Math.hypot(o.x - p.x, o.y - p.y);
      if (d < o.r * scaleOf(o) + reach && d < bestD) { best = o; bestD = d; }
    }
    return best;
  }

  /** Grows in, holds, shrinks away over the last 40% of its life. */
  function scaleOf(o) {
    const life = o.age / o.spec.ttl;
    if (o.age < 0.15) return 1 - Math.pow(1 - o.age / 0.15, 3);
    if (life > 0.6) return Math.max(0.05, 1 - (life - 0.6) / 0.4);
    return 1;
  }

  function end() {
    over = true;
    sfx.win();
    for (const o of targets) remove(o);
    targets = [];
    ctx.end({
      score, kicker: "time", title: String(score), sub: `${popped} hits · best combo ×${Math.max(maxCombo, 1)}`,
      rows: [{ label: "hits", value: String(popped) }, { label: "best combo", value: `×${Math.max(maxCombo, 1)}` }],
    });
  }

  return {
    update(dt) {
      if (over) return;
      t += dt;
      left -= dt;
      if (left <= 0) return end();

      spawnIn -= dt;
      const rate = 0.95 - 0.5 * Math.min(t / ROUND, 1);
      if (spawnIn <= 0) {
        spawnIn = rate * (0.7 + Math.random() * 0.6);
        if (targets.length < MAX_ALIVE) spawn();
      }

      for (const h of input.hands) {
        if (h.justPinch) {
          const o = nearest(h.pinch, 0.3, (x) => x.type !== "crate");
          if (o) hit(o);
        }
        if (h.justFist) {
          const o = nearest(h.palm, 0.45, (x) => x.type === "crate" || x.type === "bomb");
          if (o) hit(o);
        }
      }

      for (const o of targets) {
        if (o.dead) continue;
        o.age += dt;
        if (o.age >= o.spec.ttl) {
          remove(o);
          if (o.type !== "bomb") combo = 0;
          continue;
        }
        const s = scaleOf(o) * o.r * 2 * (o.type === "bomb" ? 1 + Math.sin(o.age * 12) * 0.06 : 1);
        kit.size(o.mesh, s, s);
        if (o.type === "gold") o.mesh.rotation.z += dt * 4;
        if (o.type === "crate") o.mesh.rotation.z = Math.sin(o.age * 5) * 0.08;
      }
      targets = targets.filter((o) => !o.dead);
      if (t - lastHit > COMBO_WINDOW && combo > 0) combo = 0;
    },

    cursors() {
      kit.beginCursors();
      for (const h of input.hands) {
        if (h.stale) continue;
        if (h.pinching) kit.cursor(h.pinch.x, h.pinch.y, { color: COLORS.sky, r: 0.2, opacity: 0.9 });
        else if (h.fisting) kit.cursor(h.palm.x, h.palm.y, { color: COLORS.amber, r: 0.5, opacity: 0.85 });
        else kit.cursor(h.palm.x, h.palm.y, { color: COLORS.white, r: 0.3, opacity: 0.45 });
      }
      kit.endCursors();
    },

    stats: () => [
      { k: "time", v: Math.max(0, Math.ceil(left)) },
      { k: "score", v: score },
      { k: "combo", v: combo > 1 ? `×${combo}` : "—" },
    ],
  };
}
