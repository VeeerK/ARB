import * as THREE from "../../vendor/three/three.module.js";
import { COLORS } from "../arcade/kit.js";
import { shapeSvg } from "../levels.js";

/**
 * Balance scale: a beam on a pivot with a fixed weight on it, and you build
 * shapes and rest them on the beam until it sits level.
 *
 * No physics engine. A block's weight is its face area (a circle is π/4 of its
 * box, a triangle half), its pull is that weight times its distance from the
 * pivot, and the beam tilts toward whichever side pulls harder. That is the
 * lever rule and nothing else — enough to make "further out pulls harder" true
 * and visible, without blocks that slide, bounce or fall off.
 *
 * The one piece of real work is that blocks RIDE the beam. Everything is
 * worked out in the beam's own level frame (the "base" pose), and a block that
 * rests on the beam is drawn rotated with it. A block your hands are on is
 * left entirely to the builder; when you let go, wherever it ended up on screen
 * is turned back into the beam's frame, so placing a block onto a tilted beam
 * works the way it looks.
 */

export const BALANCE = {
  cells: 16,
  // Balanced when the leftover pull is within this fraction of the fixed
  // weights' total pull.
  tolerance: 0.1,
  maxTiltDeg: 14,
  // Leftover pull (same fraction) at which the beam is fully over.
  fullTiltAt: 0.5,
  // How quickly the beam swings toward its new angle, per second.
  ease: 5,
  // Longer than a level's hold: a beam easing THROUGH level must not count.
  holdFrames: 40,
};

const AREA = { box: 1, circle: Math.PI / 4, triangle: 0.5 };
const NAMES = { box: "square", circle: "circle", triangle: "triangle" };

/**
 * `c` is a weight's edge in grid cells; `arm` is its distance from the pivot as
 * a fraction of the beam's half-length, positive to one side. Each run picks
 * the side at random, so the empty side is not always the same hand.
 */
const ROUNDS = [
  { title: "First weight", brief: "Build shapes and rest them on the empty side until the beam is level.",
    par: 40, points: 200, presets: [{ kind: "box", c: 3, arm: 0.55 }] },
  { title: "Close and heavy", brief: "A bigger weight, nearer the middle. Level the beam.",
    par: 45, points: 240, presets: [{ kind: "box", c: 4, arm: 0.3 }] },
  { title: "Long lever", brief: "Far out, a weight pulls harder. Level the beam.",
    par: 50, points: 280, presets: [{ kind: "circle", c: 4, arm: 0.75 }] },
  { title: "Two on one side", brief: "Two weights on the same side. Level the beam.",
    par: 55, points: 320, presets: [{ kind: "box", c: 3, arm: 0.65 }, { kind: "triangle", c: 4, arm: 0.25 }] },
  { title: "Circles only", brief: "Level the beam using circles only.",
    par: 55, points: 340, only: "circle", presets: [{ kind: "box", c: 4, arm: 0.5 }] },
  { title: "One shot", brief: "Weights on both sides. Level the beam with a single shape.",
    par: 60, points: 400, max: 1, presets: [{ kind: "box", c: 3, arm: 0.7 }, { kind: "circle", c: 3, arm: -0.4 }] },
];

export function balanceLadder() {
  return ROUNDS.map((spec, i) => makeRound(spec, i));
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function makeRound(spec, i) {
  const flip = Math.random() < 0.5 ? -1 : 1;

  return {
    id: `balance-${i + 1}`,
    title: spec.title,
    brief: spec.brief,
    difficulty: i < 2 ? "easy" : i < 4 ? "medium" : "hard",
    par: spec.par,
    points: spec.points,
    holdFrames: BALANCE.holdFrames,

    setup(env) {
      const H = env.scene.planeH, W = env.scene.planeW;
      const g = this.geo = {
        H,
        step: H / BALANCE.cells,
        pivotY: -H * 0.27,
        half: Math.min(W * 0.43, H * 0.85),
        thick: H * 0.028,
      };
      g.top = g.pivotY + g.thick / 2;

      this.presets = spec.presets.map((p) => {
        const s = p.c * g.step;
        return { kind: p.kind, w: s, h: s, x: p.arm * flip * g.half, weight: AREA[p.kind] * s * s };
      });
      this.ref = this.presets.reduce((n, p) => n + Math.abs(p.weight * p.x), 0);
      const presetNet = this.presets.reduce((n, p) => n + p.weight * p.x, 0);
      this.lightSide = presetNet > 0 ? "left" : "right";
      this.ratio = this.ref ? presetNet / this.ref : 0;
      this.angle = 0;
      this.entries = new Map();   // block -> { base, rendered }
      this.counted = new Set();

      const kit = env.kit;
      // Beam and weights share one group turned about the pivot.
      this.group = new THREE.Group();
      this.group.position.set(0, g.pivotY, 0);
      kit.root.add(this.group);
      kit.shape("box", COLORS.white, { w: g.half * 2, h: g.thick, d: g.thick, parent: this.group });
      for (const p of this.presets) {
        const mesh = kit.shape(p.kind, 0xb8c2cc, { w: p.w, h: p.h, parent: this.group });
        mesh.position.x = p.x;
        mesh.position.y = g.thick / 2 + p.h / 2;
      }

      const fulcrum = kit.shape("triangle", COLORS.white, { w: H * 0.11, h: H * 0.11, style: "ghost" });
      fulcrum.position.set(0, g.pivotY - g.thick / 2 - H * 0.055, fulcrum.position.z);
      // Where level is, so a small tilt can be read against something.
      const guide = kit.dashes(-g.half, g.pivotY, g.half, g.pivotY, 28, 0xffffff, 0.25);
      this.fixed = [fulcrum, guide];
    },

    teardown(env) {
      env.kit.remove(this.group);
      for (const f of this.fixed ?? []) env.kit.remove(f);
      this.entries?.clear();
    },

    /** Turn a pose about the pivot. */
    _rotate(p, ang) {
      const c = Math.cos(ang), s = Math.sin(ang);
      const dx = p.x, dy = p.y - this.geo.pivotY;
      return { x: dx * c - dy * s, y: this.geo.pivotY + dx * s + dy * c, a: p.a + ang };
    },

    /** A block's box around it in some pose. */
    _extent(block, pose) {
      const w = block.mesh.scale.x, h = block.mesh.scale.y;
      const c = Math.abs(Math.cos(pose.a)), s = Math.abs(Math.sin(pose.a));
      const hx = (w * c + h * s) / 2, hy = (w * s + h * c) / 2;
      return { w, h, x: pose.x, hx, hy, bottom: pose.y - hy, topY: pose.y + hy };
    },

    /** Resting on a surface: touching it, or sunk into it a little. */
    _rests(bottom, surface, height) {
      const gap = bottom - surface;
      return gap >= -0.5 * height && gap <= Math.max(0.3 * height, this.geo.step);
    },

    _onScale(it, supports) {
      if (Math.abs(it.x) <= this.geo.half + it.hx * 0.5 && this._rests(it.bottom, this.geo.top, it.hy * 2)) return true;
      return supports.some((o) =>
        Math.abs(o.x - it.x) < (o.hx + it.hx) * 0.8 && this._rests(it.bottom, o.topY, it.hy * 2));
    },

    frame(dt, env) {
      const rig = env.rigs()[0];
      if (!rig || !this.geo) return;
      const builder = rig.builder;
      const blocks = builder.blocks;

      const busy = new Set();
      if (builder.grab) for (const b of blocks) busy.add(b);
      if (builder.hold) busy.add(builder.hold.block);
      if (builder.resize) busy.add(builder.resize.block);

      const live = new Set(blocks);
      for (const b of [...this.entries.keys()]) if (!live.has(b) || busy.has(b)) this.entries.delete(b);

      const supportsNow = [...this.entries]
        .filter(([b]) => this.counted.has(b))
        .map(([b, e]) => this._extent(b, e.base));

      for (const b of blocks) {
        if (busy.has(b)) continue;
        const m = b.mesh;
        const e = this.entries.get(b);
        const r = e?.rendered;
        if (r && Math.abs(m.position.x - r.x) < 1e-6 && Math.abs(m.position.y - r.y) < 1e-6
            && Math.abs(m.rotation.z - r.a) < 1e-6) continue;
        // New, or put down since last frame. If it reads as sitting on the
        // tilted beam, take it into the beam's frame; otherwise it stays put.
        const raw = { x: m.position.x, y: m.position.y, a: m.rotation.z };
        const level = this._rotate(raw, -this.angle);
        const onScale = this._onScale(this._extent(b, level), supportsNow);
        this.entries.set(b, { base: onScale ? level : raw, rendered: null });
      }

      // What rests on the scale, working up from the beam through stacks.
      const items = [...this.entries].map(([b, e]) => ({ b, e, ...this._extent(b, e.base) }));
      const counted = new Set();
      for (let pass = 0; pass < 6; pass++) {
        let grew = false;
        const supports = items.filter((o) => counted.has(o.b));
        for (const it of items) {
          if (counted.has(it.b) || !this._onScale(it, supports)) continue;
          counted.add(it.b);
          grew = true;
        }
        if (!grew) break;
      }
      this.counted = counted;

      let net = this.presets.reduce((n, p) => n + p.weight * p.x, 0);
      for (const it of items) if (counted.has(it.b)) net += AREA[it.b.kind] * it.w * it.h * it.x;
      this.ratio = this.ref ? net / this.ref : 0;

      // Heavier on the right turns the beam clockwise, which is negative.
      const target = -clamp(this.ratio / BALANCE.fullTiltAt, -1, 1) * (BALANCE.maxTiltDeg * Math.PI) / 180;
      this.angle += (target - this.angle) * Math.min(1, dt * BALANCE.ease);
      this.group.rotation.z = this.angle;

      for (const it of items) {
        const r = counted.has(it.b) ? this._rotate(it.e.base, this.angle) : it.e.base;
        it.b.mesh.position.x = r.x;
        it.b.mesh.position.y = r.y;
        it.b.mesh.rotation.z = r.a;
        it.e.rendered = r;
      }
    },

    check(blocks) {
      const n = this.counted.size;
      const pct = Math.round(Math.abs(this.ratio) * 100);
      const status = Math.abs(this.ratio) <= BALANCE.tolerance ? "level"
        : `${this.ratio > 0 ? "right" : "left"} +${pct}%`;
      const out = (ok, hint) => ({ ok, hint, have: n, need: 1, status });

      if (!blocks.length) return out(false, `Build a shape and rest it on the ${this.lightSide} side of the beam.`);
      if (!n) return out(false, "rest your shapes ON the beam — they only count once they sit on it");
      if (spec.only) {
        const wrong = [...this.counted].find((b) => b.kind !== spec.only);
        if (wrong) return out(false, `${NAMES[spec.only]}s only — take the ${NAMES[wrong.kind]} off the beam`);
      }
      if (spec.max && n > spec.max) {
        return out(false, `only ${spec.max} shape${spec.max > 1 ? "s" : ""} allowed on the beam`);
      }
      if (Math.abs(this.ratio) <= BALANCE.tolerance) return out(true, "");
      const heavy = this.ratio > 0 ? "right" : "left";
      const light = heavy === "right" ? "left" : "right";
      return out(false, `the ${heavy} side is ${pct}% too heavy — add weight on the ${light}, or slide shapes along`);
    },

    /** The goal card: the beam with the fixed weights, before any are added. */
    art() {
      let svg = `<line class="goal-shape" x1="10" y1="72" x2="110" y2="72" />`
        + `<polygon class="goal-shape" points="60,73 52,88 68,88" />`;
      if (this.geo) {
        for (const p of this.presets) {
          const s = Math.max(10, (p.w / this.geo.H) * 100);
          svg += shapeSvg(p.kind, 60 + (p.x / this.geo.half) * 50, 72 - s / 2, s);
        }
      }
      return `<svg viewBox="0 0 120 100" class="goal-svg" aria-hidden="true">${svg}</svg>`;
    },
  };
}
