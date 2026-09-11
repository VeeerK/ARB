import { OneEuroPoint } from "./filters.js";
import { LM, dist2 } from "./landmarks.js";

/**
 * Keeps the landmark stream honest when the model is guessing.
 *
 * The case this exists for is a hand held IN FRONT OF YOUR FACE. Same skin,
 * same lighting, no edge for the model to lock onto, so the fit stops being a
 * hand and starts being a compromise between a hand and a cheek: landmarks
 * shiver in place, the palm inflates and deflates frame to frame, and every so
 * often the whole skeleton slides off onto the face and back. Downstream that
 * reads as pinches you did not make and blocks that jump.
 *
 * Two defences, in order:
 *
 *   1. CONTINUITY. A hand is a physical object: between two frames it can move
 *      a certain distance and no further, and it cannot change size at all.
 *      A fit that violates either did not track your hand — it jumped to
 *      something else — so the frame is thrown away and the hand is treated as
 *      momentarily missing, which the grace window already handles gracefully.
 *   2. SMOOTHING, on all 21 landmarks rather than only on the two cursor
 *      points. The cursors were smooth already; the POSE was not, because it is
 *      computed from raw landmarks, which is why a hand over the face flickered
 *      between poses while its dot sat still.
 *
 * Both are per hand, keyed by handedness, and both reset when a hand has been
 * gone long enough that the next sighting is a new hand rather than the same
 * one moved.
 */

/** Smoother at rest than the cursor filter: at-rest shiver is the whole
 *  problem here, and pose thresholds care about the value, not the lag. */
export const LANDMARK_FILTER = { minCutoff: 1.6, beta: 22, dCutoff: 3.0 };

export const CONTINUITY = {
  // Palm spans per second the wrist may travel. A fast reach across the frame
  // is around 4; the skeleton landing on your face from where your hand was is
  // far more. Generous on purpose — rejecting a real fast hand costs a gesture,
  // and the size test below is the one that catches most bad fits anyway.
  spansPerSecond: 14,
  // How much the palm may grow or shrink per second, as a ratio. Your hand
  // does not change size; this is only wide enough to allow the apparent
  // change from moving toward or away from the camera quickly.
  growthPerSecond: 3.5,
  // Consecutive rejections before the stabilizer gives up and re-seeds on
  // whatever it is being shown. Without this, one genuinely instant move (the
  // tracker re-acquiring your hand somewhere else entirely) would be refused
  // forever and the hand would never come back.
  maxRejects: 5,
  // A hand unseen for longer than this is a new hand, not the same one moved.
  resetAfterMs: 400,
};

class HandFilter {
  constructor() {
    this.image = Array.from({ length: 21 }, () => new OneEuroPoint(LANDMARK_FILTER));
    this.world = Array.from({ length: 21 }, () => new OneEuroPoint(LANDMARK_FILTER));
    this.wrist = null;    // last accepted, filtered
    this.span = null;     // last accepted palm span
    this.rejects = 0;
    this.seenAt = 0;
  }
}

export class HandStabilizer {
  constructor() {
    this.hands = new Map();
    // Frames dropped as implausible, for the HUD. Worth surfacing: a number
    // that climbs while your hand is over your face is the difference between
    // "the app is broken" and "the model cannot see it there".
    this.rejected = 0;
  }

  /**
   * Drop filters for hands that are long gone. Two-player mode keys these by
   * side of the frame as well as handedness, so the map grows every time
   * somebody swaps places; without this it would keep a filter for every
   * identity ever seen and hand back stale continuity data on a re-entry.
   */
  prune(now) {
    for (const [key, f] of this.hands) {
      if (now - f.seenAt > CONTINUITY.resetAfterMs * 4) this.hands.delete(key);
    }
  }

  /**
   * @returns {{landmarks:Array, worldLandmarks:Array}|null} smoothed landmarks,
   * or null if this detection failed the continuity test and should be treated
   * as a dropped frame.
   */
  accept(hand, now) {
    // `key` is handedness alone with one player, handedness + side of the
    // frame with two — see HandTracker.splitZones. Two people's right hands
    // must not share one filter, or each would be judged as the other jumping
    // across the frame and thrown out by the continuity test below.
    const key = hand.key ?? hand.handedness;
    let f = this.hands.get(key);
    if (!f || now - f.seenAt > CONTINUITY.resetAfterMs) {
      f = new HandFilter();
      this.hands.set(key, f);
    }

    const lms = hand.landmarks;
    const span = palmSpan(lms);
    const wrist = lms[LM.WRIST];
    const dt = f.seenAt ? Math.min(Math.max((now - f.seenAt) / 1000, 1 / 240), 1 / 5) : null;

    if (dt !== null && f.wrist && f.span) {
      const jumped = dist2(wrist, f.wrist) / f.span > CONTINUITY.spansPerSecond * dt;
      const ratio = span / f.span;
      const grew = Math.max(ratio, 1 / ratio) - 1 > CONTINUITY.growthPerSecond * dt;
      if ((jumped || grew) && f.rejects < CONTINUITY.maxRejects) {
        f.rejects++;
        this.rejected++;
        return null;
      }
    }

    f.rejects = 0;
    f.seenAt = now;

    const t = now / 1000;
    const landmarks = lms.map((p, i) => f.image[i].filter(p, t));
    const worldLandmarks = hand.worldLandmarks?.map((p, i) => f.world[i].filter(p, t));

    f.wrist = landmarks[LM.WRIST];
    f.span = palmSpan(landmarks);
    return { landmarks, worldLandmarks };
  }
}

/** The same rotation-robust span landmarks.js normalizes by, kept local so the
 *  gate measures in exactly the units the metrics downstream will use. */
function palmSpan(lms) {
  const w = lms[LM.WRIST];
  return Math.max(
    dist2(w, lms[LM.MIDDLE_MCP]),
    dist2(w, lms[LM.INDEX_MCP]),
    dist2(w, lms[LM.PINKY_MCP]),
    dist2(lms[LM.INDEX_MCP], lms[LM.PINKY_MCP]),
    1e-6,
  );
}
