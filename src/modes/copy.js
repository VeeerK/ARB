import { COLORS } from "../arcade/kit.js";
import { shapeSvg } from "../levels.js";

/**
 * Copy the shape: outlines are drawn on the build plane, and you fill each one
 * with a block of the same kind, size, position and angle.
 *
 * Unlike a level, which only cares how shapes RELATE ("the head on the body"),
 * this checks absolute placement against a target that is visibly on screen —
 * so it asks for precision rather than for reading a brief. Tolerances are
 * still loose enough for a webcam: the outline glows green when a block is
 * close enough, which is the whole of the feedback a player needs.
 *
 * A round is the same shape as a level as far as session.js is concerned
 * (title, brief, par, points), plus hooks: `setup` draws the outlines, `check`
 * judges the board, `teardown` removes them, `art` draws the goal card.
 */

export const COPY = {
  rounds: 8,
  // Outlines are laid out on the same grid grid-snap uses, so turning snap on
  // helps rather than fights.
  cells: 16,
  // How far a block's centre may be from its outline's: this fraction of the
  // plane height, or `posTolOfSize` of the outline's longest edge if larger.
  posTol: 0.07,
  posTolOfSize: 0.3,
  // Largest ratio between a block's edge and the outline's, either way.
  sizeRatio: 1.35,
  angleTol: 20,
  holdFrames: 20,
};

const KINDS = ["box", "circle", "triangle"];
const NAMES = { box: "square", circle: "circle", triangle: "triangle" };

/** A fresh run of rounds: one outline, then two, then three with tilts. */
export function copyLadder(total = COPY.rounds) {
  return Array.from({ length: total }, (_, i) => makeRound(i));
}

function makeRound(i) {
  const parts = i < 2 ? 1 : i < 5 ? 2 : 3;
  const tilt = i >= 3;
  return {
    id: `copy-${i + 1}`,
    title: `Outline ${i + 1}`,
    brief: "Fill the outline — same shape, same size, same spot.",
    difficulty: i < 3 ? "easy" : i < 6 ? "medium" : "hard",
    par: 16 + parts * 16 + (tilt ? 8 : 0),
    points: 120 + parts * 80 + (tilt ? 40 : 0),
    holdFrames: COPY.holdFrames,
    targets: [],
    meshes: [],
    matched: [],

    setup(env) {
      // Laid out now rather than when the run starts, so a window resized
      // between rounds still gets outlines that fit it.
      this.targets = layout(parts, tilt, env.scene.planeW, env.scene.planeH);
      this.meshes = this.targets.map((t) => drawTarget(env.kit, t));
      this.matched = this.targets.map(() => false);
      const n = this.targets.length;
      this.brief = n === 1
        ? "Fill the outline — same shape, same size, same spot."
        : `Fill all ${n} outlines — same shapes, sizes, spots${tilt ? " and angles" : ""}.`;
    },

    teardown(env) {
      for (const mesh of this.meshes) env.kit.remove(mesh);
      this.meshes = [];
    },

    art() { return artFor(this.targets); },

    check(blocks, planeH, env) {
      const T = this.targets;
      const need = T.length;
      const out = (ok, hint, status) => ({ ok, hint, have: blocks.length, need, status });
      const m = blocks.map((b) => ({
        kind: b.kind,
        x: b.mesh.position.x, y: b.mesh.position.y,
        w: b.mesh.scale.x, h: b.mesh.scale.y,
        a: (b.mesh.rotation.z * 180) / Math.PI,
      }));

      // Pair each outline with the nearest unused block of its kind, nearest
      // pairs first. With at most three outlines greedy is as good as exact.
      const pairs = [];
      T.forEach((t, i) => m.forEach((b, j) => {
        if (b.kind === t.kind) pairs.push({ i, j, d: Math.hypot(b.x - t.x, b.y - t.y) });
      }));
      pairs.sort((p, q) => p.d - q.d);
      const blockFor = new Array(need).fill(null);
      const used = new Set();
      for (const p of pairs) {
        if (blockFor[p.i] != null || used.has(p.j)) continue;
        blockFor[p.i] = p.j;
        used.add(p.j);
      }

      let hint = null;
      let done = 0;
      T.forEach((t, i) => {
        const j = blockFor[i];
        const problem = j == null ? missing(t, need, planeH) : judge(t, m[j], planeH);
        if (!problem) done++;
        if (!problem !== this.matched[i]) {
          this.matched[i] = !problem;
          if (this.meshes[i]) env.kit.style(this.meshes[i], problem ? COLORS.white : COLORS.mint, "ghost");
          if (!problem) env.sound?.play("pick");
        }
        hint ??= problem;
      });

      const status = `${done}/${need}`;
      if (!blocks.length) {
        return out(false, need === 1
          ? "Pick the shape with your fingers, then draw it inside the outline."
          : "Fill every outline with a matching shape.", status);
      }
      if (hint) return out(false, hint, status);
      const extra = m.length - used.size;
      if (extra > 0) return out(false, `${extra} extra shape${extra > 1 ? "s" : ""} — clear ${extra > 1 ? "them" : "it"}`, status);
      return out(true, "", status);
    },
  };
}

/** Random outlines that fit the plane clear of the top bar and hint strip,
 *  never touching each other. */
function layout(parts, tilt, W, H) {
  const step = H / COPY.cells;
  const xMax = Math.min(W / 2 - step, H * 0.8);
  const yMin = -H * 0.36, yMax = H * 0.2;
  const out = [];

  for (let n = 0; n < 240 && out.length < parts; n++) {
    const kind = KINDS[Math.floor(Math.random() * KINDS.length)];
    // Later tries shrink the range, so a crowded plane still fills up.
    const range = n > 140 ? 2 : 4;
    const w = (3 + Math.floor(Math.random() * range)) * step;
    const h = kind === "circle" ? w : (3 + Math.floor(Math.random() * range)) * step;
    const angle = tilt && kind !== "circle" && Math.random() < 0.5 ? 45 : 0;
    const rad = (angle * Math.PI) / 180;
    const c = Math.abs(Math.cos(rad)), s = Math.abs(Math.sin(rad));
    const hx = (w * c + h * s) / 2, hy = (w * s + h * c) / 2;
    if (2 * hx > 2 * xMax || 2 * hy > yMax - yMin) continue;

    const rx = -xMax + hx + Math.random() * (2 * xMax - 2 * hx);
    const ry = yMin + hy + Math.random() * (yMax - yMin - 2 * hy);
    const x = Math.round((rx - hx) / step) * step + hx;
    const y = Math.round((ry - hy) / step) * step + hy;
    if (x - hx < -xMax - 1e-6 || x + hx > xMax + 1e-6 || y - hy < yMin - 1e-6 || y + hy > yMax + 1e-6) continue;

    const clear = out.every((o) =>
      Math.abs(o.x - x) >= o.hx + hx + step || Math.abs(o.y - y) >= o.hy + hy + step);
    if (clear) out.push({ kind, w, h, angle, x, y, hx, hy });
  }
  return out;
}

function drawTarget(kit, t) {
  const mesh = kit.shape(t.kind, COLORS.white, { w: t.w, h: t.h, style: "ghost" });
  mesh.position.x = t.x;
  mesh.position.y = t.y;
  // A hair behind the plane, so a block drawn exactly over it wins the depth
  // test instead of flickering with it.
  mesh.position.z -= 0.02;
  mesh.rotation.z = (t.angle * Math.PI) / 180;
  return mesh;
}

const angDiff = (a, b, period) => {
  const d = (((a - b) % period) + period) % period;
  return Math.min(d, period - d);
};

function where(t, need, planeH) {
  if (need === 1) return "the outline";
  if (t.x < -planeH * 0.25) return "the left outline";
  if (t.x > planeH * 0.25) return "the right outline";
  return "the middle outline";
}

const missing = (t, need, planeH) => `draw a ${NAMES[t.kind]} in ${where(t, need, planeH)}`;

/** What is wrong with this block as a fill for this outline, or null. */
function judge(t, b, planeH) {
  const name = NAMES[t.kind];
  const tol = Math.max(COPY.posTol * planeH, COPY.posTolOfSize * Math.max(t.w, t.h));
  if (Math.hypot(b.x - t.x, b.y - t.y) > tol) return `move the ${name} into its outline`;

  // A rectangle turned a quarter is the same outline as its edges swapped.
  const variants = [{ w: b.w, h: b.h, a: b.a }];
  if (t.kind === "box") variants.push({ w: b.h, h: b.w, a: b.a + 90 });
  const period = t.kind === "box" ? 180 : 360;

  let best = null;
  for (const v of variants) {
    const size = Math.max(v.w / t.w, t.w / v.w, v.h / t.h, t.h / v.h);
    const turn = t.kind === "circle" ? 0 : angDiff(v.a, t.angle, period);
    const cost = (size - 1) * 60 + turn;
    if (!best || cost < best.cost) best = { v, size, turn, cost };
  }

  if (best.size > COPY.sizeRatio) {
    const area = best.v.w * best.v.h, want = t.w * t.h;
    if (area < want / COPY.sizeRatio) return `make the ${name} bigger`;
    if (area > want * COPY.sizeRatio) return `make the ${name} smaller`;
    return `stretch the ${name} to the outline's shape`;
  }
  if (best.turn > COPY.angleTol) return `turn the ${name} to match its outline`;
  return null;
}

/** The goal card: the outlines, fitted to the card rather than to the screen. */
function artFor(targets) {
  if (!targets.length) return `<svg viewBox="0 0 120 100" class="goal-svg" aria-hidden="true"></svg>`;
  const minX = Math.min(...targets.map((t) => t.x - t.hx)), maxX = Math.max(...targets.map((t) => t.x + t.hx));
  const minY = Math.min(...targets.map((t) => t.y - t.hy)), maxY = Math.max(...targets.map((t) => t.y + t.hy));
  const k = Math.min(104 / (maxX - minX), 84 / (maxY - minY));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  // SVG's y points down, so a turn on screen is the opposite sign in the card.
  const svg = targets.map((t) =>
    shapeSvg(t.kind, 60 + (t.x - cx) * k, 50 - (t.y - cy) * k, t.w * k, -t.angle, t.h * k)).join("");
  return `<svg viewBox="0 0 120 100" class="goal-svg" aria-hidden="true">${svg}</svg>`;
}
