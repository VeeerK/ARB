import { TUNING, POSE } from "./gestures.js";
import { LM } from "./landmarks.js";

/**
 * Picking which shape the next block will be, by holding up fingers.
 *
 *   one finger   -> square      two -> circle      three -> triangle
 *
 * Held steady for `TUNING.picker.holdMs`, with a ring closing around your
 * fingers as it fills. The dwell is the whole point: a hand on its way into a
 * pinch passes through one and two fingers up every single time, so anything
 * that fired on sight of a count would change the shape constantly while you
 * were trying to build. A count you keep still for a second is one you meant.
 *
 * This reads the SAME `metrics.extension` the pose classifier does, rather than
 * inventing a second idea of what an extended finger is.
 */
export const SHAPES = ["box", "circle", "triangle"];
export const SHAPE_LABEL = { box: "square", circle: "circle", triangle: "triangle" };

const COUNTED = ["index", "middle", "ring", "pinky"];

export class ShapePicker {
  constructor({ onPick, shape = SHAPES[0], zone = null } = {}) {
    this.onPick = onPick || (() => {});
    // Two-player mode gives each half of the screen its own picker, so one
    // player holding up two fingers cannot change the other's shape.
    this.zone = zone;
    this.count = 0;        // fingers currently held up, 0 if nothing qualifies
    this.progress = 0;     // 0..1, how far the ring has closed
    this.point = null;     // normalized coords to draw the ring around
    this.flash = 0;        // 0..1, fades out after a pick lands
    this.shape = shape;    // what is selected right now
    // Treated as picked at load, so the starting shape is on cooldown too and
    // the ring does not fire on the count you already have.
    this.pickedAt = performance.now();
    this._at = 0;
  }

  /** Give up on any part-filled ring. Called when the hands are busy doing
   *  something else, so a half-drawn ring never survives to complete later. */
  reset() {
    this.count = 0;
    this.progress = 0;
    this.point = null;
  }

  update(hands, now) {
    if (this.zone) hands = hands.filter((h) => h.side === this.zone);
    const dt = this._at ? now - this._at : 0;
    this._at = now;
    this.flash = Math.max(0, this.flash - dt / TUNING.picker.flashMs);

    const hand = hands.find((h) => this._count(h) > 0);
    if (!hand) return this.reset();

    const count = this._count(hand);

    // Holding up the count for the shape you already have is not a request to
    // pick it again. Without this the ring restarts the moment it lands and
    // loops forever, reading as a progress bar that never finishes. A short
    // cooldown after each pick keeps re-picking possible without the loop;
    // any OTHER count is a real change and still starts its dwell at once.
    if (SHAPES[count - 1] === this.shape &&
        now - this.pickedAt < TUNING.picker.repickCooldownMs) {
      return this.reset();
    }

    this.point = this._centre(hand, count);

    // A changed count restarts the dwell rather than carrying its progress
    // over, so going one -> two does not instantly land on two.
    if (count !== this.count) {
      this.count = count;
      this.progress = 0;
      return;
    }

    this.progress = Math.min(1, this.progress + dt / TUNING.picker.holdMs);
    if (this.progress < 1) return;

    this.shape = SHAPES[count - 1];
    this.pickedAt = now;
    this.onPick(this.shape);
    this.flash = 1;
    this.reset();
  }

  /** Fingers held up, or 0 if this hand is not offering a count at all. */
  _count(hand) {
    const m = hand.metrics;
    // A pinch or a fist is a hand already doing something else, and a hand
    // riding out a dropout has frozen coordinates that would hold a dwell open.
    if (!m || hand.stale || hand.pose === POSE.PINCH || hand.pose === POSE.FIST) return 0;

    const up = COUNTED.filter((f) => m.extension[f] > TUNING.picker.extendedAbove);
    // Only the leading fingers count: index, then index+middle, then those
    // plus ring. A ring finger up on its own is a hand doing something else,
    // not a request for shape three.
    for (let i = 0; i < up.length; i++) if (up[i] !== COUNTED[i]) return 0;
    // Four up is an open palm, which already means "let go".
    return up.length >= 1 && up.length <= 3 ? up.length : 0;
  }

  /** Middle of the raised fingertips, so the ring closes around the fingers
   *  you are actually holding up rather than around the wrist. */
  _centre(hand, count) {
    const lms = hand.metrics.landmarks;
    if (!lms) return hand.metrics.palmPoint;
    const tips = [LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP].slice(0, count);
    let x = 0, y = 0;
    for (const t of tips) { x += lms[t].x; y += lms[t].y; }
    return { x: x / tips.length, y: y / tips.length };
  }
}
