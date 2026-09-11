import { POSE, TUNING } from "../gestures.js";
import { LM } from "../landmarks.js";

/**
 * The hands, restated in the terms a game wants.
 *
 * gestures.js answers "what shape is this hand"; a game wants "where is it on
 * the board, and did it just START pinching". This turns `gestures.hands` into
 * one small record per hand per frame, in world units on the build plane, with
 * the edges (pose began this frame) worked out once here rather than in every
 * game.
 *
 * It deliberately invents no new recognition. Poses are exactly the ones the
 * builder reads, and the finger count is the shape picker's own rule — so a
 * gesture that works in freestyle works identically in every game.
 */

const COUNTED = ["index", "middle", "ring", "pinky"];

/** The picker's rule: leading fingers only, 1..3, and never while pinching or
 *  making a fist. Four up is an open palm, which is its own gesture. */
export function fingerCount(state) {
  const m = state.metrics;
  if (!m || state.stale || state.pose === POSE.PINCH || state.pose === POSE.FIST) return 0;
  const up = COUNTED.filter((f) => m.extension[f] > TUNING.picker.extendedAbove);
  for (let i = 0; i < up.length; i++) if (up[i] !== COUNTED[i]) return 0;
  return up.length >= 1 && up.length <= 3 ? up.length : 0;
}

export class Input {
  constructor(scene) {
    this.scene = scene;
    this.hands = [];
    this.visible = 0;          // non-stale hands this frame
    this.lastSeenAt = 0;       // last frame any hand was really in view
    this._mem = new Map();     // per hand key: last pose, finger dwell, tip filter
  }

  update(raw, now) {
    const out = [];
    const keys = new Set();

    for (const h of raw) {
      if (!h.palmPoint || !h.pinchPoint) continue;
      const key = h.key ?? h.handedness;
      keys.add(key);

      let mem = this._mem.get(key);
      if (!mem) {
        mem = { pose: POSE.NONE, poseAt: now, count: 0, countAt: now, steady: 0, tip: null };
        this._mem.set(key, mem);
      }

      const pose = h.pose;
      const changed = pose !== mem.pose;
      if (changed) { mem.pose = pose; mem.poseAt = now; }

      // Finger count, with a short dwell of its own. Much shorter than the
      // picker's full second: a game can afford a wrong count for a frame far
      // more than a drawing tool can, but not one that flickers every frame.
      const count = fingerCount(h);
      if (count !== mem.count) { mem.count = count; mem.countAt = now; }
      if (now - mem.countAt >= 160) mem.steady = count;
      if (count === 0 && now - mem.countAt >= 90) mem.steady = 0;

      // The index fingertip, lightly smoothed. The pinch and palm points are
      // already filtered upstream; this one is not, and a pointer that shivers
      // makes steering feel broken.
      const lm = h.metrics?.landmarks?.[LM.INDEX_TIP];
      if (lm && !h.stale) {
        mem.tip = mem.tip
          ? { x: mem.tip.x + (lm.x - mem.tip.x) * 0.45, y: mem.tip.y + (lm.y - mem.tip.y) * 0.45 }
          : { x: lm.x, y: lm.y };
      }

      const w = (p) => {
        const v = this.scene.toWorld(p.x, p.y);
        return { x: v.x, y: v.y };
      };

      out.push({
        key,
        side: h.side ?? null,
        pose,
        stale: !!h.stale,
        palm: w(h.palmPoint),
        pinch: w(h.pinchPoint),
        tip: mem.tip ? w(mem.tip) : w(h.pinchPoint),
        fingers: mem.steady,
        poseAt: mem.poseAt,
        // Edges fire only on a live frame: a hand frozen through a dropout has
        // not done anything new.
        justPinch: changed && pose === POSE.PINCH && !h.stale,
        justFist: changed && pose === POSE.FIST && !h.stale,
        justOpen: changed && pose === POSE.OPEN && !h.stale,
        pinching: pose === POSE.PINCH,
        fisting: pose === POSE.FIST,
        open: pose === POSE.OPEN,
      });
    }

    for (const key of [...this._mem.keys()]) if (!keys.has(key)) this._mem.delete(key);

    this.hands = out;
    this.visible = out.filter((h) => !h.stale).length;
    if (this.visible) this.lastSeenAt = now;
    return out;
  }

  /** Hands in one half of the screen, for two-player games. */
  side(zone) {
    return zone ? this.hands.filter((h) => h.side === zone) : this.hands;
  }

  /** The first live hand, or a held one if that is all there is. */
  primary(zone = null) {
    const list = this.side(zone);
    return list.find((h) => !h.stale) ?? list[0] ?? null;
  }

  get anyJustPinch() { return this.hands.some((h) => h.justPinch); }
}
