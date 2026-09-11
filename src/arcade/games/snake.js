import { COLORS } from "../kit.js";

/**
 * Glow Worm — Snake, steered by pointing.
 *
 * A grid and four arrow keys make no sense for a hand, so the worm moves freely
 * and CHASES your index fingertip, turning toward it no faster than a worm
 * can. That turn limit is the whole game: point somewhere sharp and it swings
 * wide, so threading your own tail means planning the curve.
 *
 *   point       the worm heads for your fingertip
 *   pinch       boost — faster, and the pinch point becomes the target
 *
 * Eat orbs to grow. Gold orbs are worth five and do not wait around. Touching
 * the border or your own body ends the run.
 */

const GAP = 0.2;             // spacing between body segments, world units
const TURN = 4.4;            // radians per second
const START_LEN = 8;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

const mixHex = (a, b, t) => {
  const ch = (s) => Math.round(((a >> s) & 255) + ((((b >> s) & 255) - ((a >> s) & 255)) * t)) << s;
  return ch(16) | ch(8) | ch(0);
};

export default function snake(ctx) {
  const { kit, input, sfx } = ctx;
  const safe = kit.safe;
  const left = -kit.w / 2 + 0.45, right = kit.w / 2 - 0.45;
  const top = safe.top - 0.05, bot = safe.bottom + 0.05;
  const midY = (top + bot) / 2;

  kit.panel(0, midY, right - left, top - bot, 0x05080c, 0.2);
  kit.rect(0, midY, right - left, top - bot, 0xffffff, 0.5);

  const head = { x: 0, y: midY - 0.8, a: Math.PI / 2 };
  let path = [];
  for (let d = 0; d <= START_LEN * GAP + 0.2; d += 0.04) path.push({ x: head.x, y: head.y - d });
  let length = START_LEN;
  let speed = 2.5;
  let score = 0, eaten = 0;
  let over = false;
  let target = null;
  let boosting = false;

  const segs = [];
  const headMesh = kit.shape("circle", COLORS.mint, { w: 0.36, h: 0.36, style: "bright" });

  let food = null, gold = null;

  function freeSpot() {
    for (let i = 0; i < 30; i++) {
      const x = left + 0.6 + Math.random() * (right - left - 1.2);
      const y = bot + 0.6 + Math.random() * (top - bot - 1.2);
      if (Math.hypot(x - head.x, y - head.y) < 1.2) continue;
      if (path.some((p) => Math.hypot(p.x - x, p.y - y) < 0.45)) continue;
      return { x, y };
    }
    return { x: 0, y: midY };
  }

  function placeFood() {
    if (food) kit.remove(food.mesh);
    const p = freeSpot();
    food = { ...p, mesh: kit.shape("circle", COLORS.sky, { w: 0.3, h: 0.3, style: "bright" }) };
    food.mesh.position.set(p.x, p.y, food.mesh.position.z);
  }

  function placeGold() {
    const p = freeSpot();
    gold = { ...p, ttl: 6, mesh: kit.shape("diamond", COLORS.gold, { w: 0.42, h: 0.42, style: "bright" }) };
    gold.mesh.position.x = p.x;
    gold.mesh.position.y = p.y;
  }

  /** Positions along the trail, one per body segment, GAP apart. */
  function bodyPoints() {
    const out = [];
    let want = GAP, acc = 0;
    for (let i = 1; i < path.length && out.length < length; i++) {
      const a = path[i - 1], b = path[i];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      while (acc + d >= want && out.length < length) {
        const t = (want - acc) / (d || 1);
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        want += GAP;
      }
      acc += d;
    }
    return out;
  }

  function trimPath() {
    const keep = (length + 2) * GAP;
    let acc = 0;
    for (let i = 1; i < path.length; i++) {
      acc += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
      if (acc > keep) { path.length = i + 1; return; }
    }
  }

  function render(t) {
    headMesh.position.x = head.x;
    headMesh.position.y = head.y;
    headMesh.rotation.z = head.a;
    const pts = bodyPoints();
    for (let i = 0; i < pts.length; i++) {
      let m = segs[i];
      const k = i / Math.max(pts.length - 1, 1);
      const s = 0.3 - 0.12 * k;
      if (!m) { m = kit.shape("circle", COLORS.mint, { w: s, h: s }); segs.push(m); }
      m.visible = true;
      kit.size(m, s, s);
      kit.style(m, over ? COLORS.red : mixHex(COLORS.mint, boosting ? COLORS.amber : COLORS.sky, k), "solid");
      m.position.x = pts[i].x;
      m.position.y = pts[i].y;
    }
    for (let i = pts.length; i < segs.length; i++) segs[i].visible = false;
    kit.style(headMesh, over ? COLORS.red : boosting ? COLORS.amber : COLORS.mint, "bright");

    if (food) {
      const s = 0.3 + Math.sin(t * 6) * 0.04;
      kit.size(food.mesh, s, s);
    }
    if (gold) {
      gold.mesh.rotation.z = t * 3;
      gold.mesh.visible = gold.ttl > 1.5 || Math.floor(gold.ttl * 8) % 2 === 0;
    }
    return pts;
  }

  function die(why) {
    over = true;
    sfx.hurt();
    for (const p of bodyPoints()) kit.burst(p.x, p.y, COLORS.red, 1, { speed: 2.5, size: 0.1 });
    kit.burst(head.x, head.y, COLORS.red, 20, { speed: 4 });
    setTimeout(() => sfx.lose(), 250);
    ctx.end({
      score, kicker: why, title: String(score), sub: `${eaten} orb${eaten === 1 ? "" : "s"} · length ${length}`,
      rows: [{ label: "length", value: String(length) }],
    });
  }

  placeFood();

  return {
    update(dt, now) {
      const t = now / 1000;
      if (over) return render(t);

      const hand = input.hands.find((h) => !h.stale) ?? null;
      boosting = !!hand?.pinching;
      target = hand ? (hand.pinching ? hand.pinch : hand.tip) : null;

      if (target) {
        const dx = target.x - head.x, dy = target.y - head.y;
        // Right on top of the fingertip the direction to it is noise; hold course.
        if (Math.hypot(dx, dy) > 0.2) {
          const turn = wrapPi(Math.atan2(dy, dx) - head.a);
          head.a += clamp(turn, -TURN * dt, TURN * dt);
        }
      }

      const v = speed * (boosting ? 1.75 : 1);
      head.x += Math.cos(head.a) * v * dt;
      head.y += Math.sin(head.a) * v * dt;
      if (Math.hypot(head.x - path[0].x, head.y - path[0].y) >= 0.03) path.unshift({ x: head.x, y: head.y });
      else path[0] = { x: head.x, y: head.y };
      trimPath();

      if (head.x < left || head.x > right || head.y < bot || head.y > top) return die("hit the wall");

      const pts = render(t);
      for (let i = 4; i < pts.length; i++) {
        if (Math.hypot(pts[i].x - head.x, pts[i].y - head.y) < 0.17) return die("bit your tail");
      }

      if (food && Math.hypot(food.x - head.x, food.y - head.y) < 0.4) {
        eaten++;
        length += 3;
        score += 10;
        speed = Math.min(speed + 0.06, 4.8);
        sfx.eat();
        kit.burst(food.x, food.y, COLORS.sky, 10, { speed: 3 });
        ctx.popAt(food.x, food.y, "+10");
        placeFood();
        if (!gold && Math.random() < 0.22) placeGold();
      }
      if (gold) {
        gold.ttl -= dt;
        if (Math.hypot(gold.x - head.x, gold.y - head.y) < 0.45) {
          eaten++;
          length += 5;
          score += 50;
          sfx.power();
          kit.burst(gold.x, gold.y, COLORS.gold, 18, { speed: 4, kind: "diamond" });
          ctx.popAt(gold.x, gold.y, "+50", "gold");
          kit.remove(gold.mesh);
          gold = null;
        } else if (gold.ttl <= 0) {
          kit.remove(gold.mesh);
          gold = null;
        }
      }
    },

    idle(dt, now) {
      const hand = input.hands.find((h) => !h.stale);
      target = hand ? (hand.pinching ? hand.pinch : hand.tip) : null;
      render(now / 1000);
    },

    cursors() {
      kit.beginCursors();
      if (target && !over) kit.cursor(target.x, target.y, { color: boosting ? COLORS.amber : COLORS.white, r: 0.2, opacity: 0.7 });
      kit.endCursors();
    },

    stats: () => [
      { k: "score", v: score },
      { k: "length", v: length },
      { k: "speed", v: `${(speed / 2.5).toFixed(1)}×` },
    ],
  };
}
