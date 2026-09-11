import { OneEuroPoint } from "./filters.js";

/**
 * Pose classification + the thresholds it uses. Reads ONLY the raw numbers from
 * landmarks.js — no hidden classifier, every decision is a visible comparison.
 *
 * A hand is in exactly ONE pose per frame. That mutual exclusivity is the point:
 * a closed fist and a pinch look almost identical in mean finger curl, so if
 * they were independent tests they would both fire and the app would try to draw
 * a block and grab the scene at the same time. They are separated by the
 * thumb-to-index gap instead, which is small in a pinch (the tips touch) and
 * large in a fist (the thumb lies across curled fingers), with a wide dead band
 * between the two.
 */
export const POSE = { NONE: "none", OPEN: "open", PINCH: "pinch", FIST: "fist" };

export const TUNING = {
  /**
   * Two signals, each used for what it measures well. Measured on the real
   * camera (ARB.calibrate), same hand, same session:
   *
   *            pinched   open     separation
   *   2d       0.124     1.134    9x     <- crisp, but foreshortens on tilt
   *   3d       0.367     1.210    3.3x   <- honest on tilt, never closes fully
   *
   * ENTRY uses 2d, because 2d actually bottoms out when the fingers touch and
   * gives a 9x margin. 3d floors around 0.37 even when squeezing hard, so no
   * entry threshold on 3d can separate a pinch from a near-pinch.
   *
   * RELEASE uses either signal, whichever fires first. 2d alone was the sticky
   * bug: tilt the hand toward the camera and the gap foreshortens to ~0.42 with
   * the fingers clearly apart. 3d does not foreshorten, so it catches exactly
   * the case 2d misses.
   */
  pinch: {
    enter2d: 0.30,   // below this (image space) -> pinch starts
    // ...OR below this in world space. 2d is the crisper signal and stays the
    // primary one, but it is measured in the flat image, and a hand held
    // EDGE-ON hides the thumb behind the index: the model puts the tips a long
    // way apart, 2d never gets near 0.30, and a pinch you are plainly making
    // is not seen at all. World space has the depth that view is missing, so
    // it catches exactly that case. Well under the ~1.0 an open hand reads, so
    // it cannot invent a pinch on its own — and the thumb discriminator still
    // has to agree either way.
    enter3d: 0.55,
    // A CEILING on the whole release path below. Whatever the world-space
    // signal thinks, fingers this far apart in the image are not pinching, and
    // the pinch ends on the next frame with nothing allowed to veto it.
    //
    // This exists because the two-signal release could hold a pinch open to a
    // 2d gap of 0.6 — twice the gap that starts one — whenever the 3d signal
    // was slow to agree that the fingers had parted. A release that lags that
    // far behind your hand is worse than an occasional early one: you have
    // already let go, and the block is still following you.
    //
    // Sits just above `enter2d` rather than exactly on it: identical numbers
    // leave no dead band at all and the pose would chatter on and off while
    // your fingers hover at the threshold.
    hardExit2d: 0.34,
    exit2d: 0.45,    // above this (image space) -> pinch ends
    exit3d: 0.85,    // above this (world space) alone -> pinch ends
    // A pinch entered on the 3d signal must be releasable on it too, or the
    // 2d gap — which was already past `exit2d` the whole time, because that is
    // why 3d was needed — would end the pinch on the very next frame. So the
    // 2d release only counts when 3d agrees the fingers have at least started
    // to part.
    exit3dSoft: 0.62,
  },

  /**
   * Fist vs pinch. This is the hard one, and the reason it is a named,
   * swappable "discriminator" rather than a fixed threshold:
   *
   * Measured on a real hand, pinch vs fist —
   *          curlMax   gap2d
   *   pinch  0.479     0.146
   *   fist   0.560     0.575
   *
   * Finger curl does not separate them AT ALL (the fist is actually the less
   * curled of the two). A pinch here is geometrically a fist with the thumb
   * moved onto the index tip, so the only thing that differs is where the thumb
   * sits — and the raw gap only reports that if the thumb is stuck right out of
   * the hand, which is not a fist anyone makes naturally.
   *
   * So the signal is chosen by measurement rather than by argument. Run:
   *
   *   await ARB.calibrateFist()      // hold a pinch, then your natural fist
   *
   * It samples every candidate in `metrics`, ranks them by how cleanly they
   * split your two poses, and writes the winner and its thresholds back here.
   *
   *   signal      which metric to threshold
   *   pinchBelow  under this -> pinch
   *   fistAbove   over this  -> fist (the dead band between is deliberate)
   */
  discriminator: {
    signal: "tipRatio",
    pinchBelow: 0.55,
    fistAbove: 0.70,
  },

  /**
   * A fist also has to be a closed hand. Kept deliberately loose — per the table
   * above this test cannot do the separating, it only rules out an open palm.
   */
  fist: {
    enterCurl: 0.70,
    exitCurl: 0.80,
  },

  /** Open palm = neutral. Mean finger extension, so one lazy finger is fine. */
  open: {
    enterCurl: 0.85,
    exitCurl: 0.75,
  },

  /**
   * Two-handed box drawing. Pinch with both hands close together to spawn a
   * block, then pull apart: each pinch stays welded to its own corner of the
   * block front face.
   */
  box: {
    // How close the two pinch points must be, in normalized image distance, for
    // a fresh block to spawn. Deliberately generous — the hands only have to be
    // near each other, not touching.
    spawnGap: 0.22,
    // The three remaining numbers are WORLD units, not normalized ones. The
    // build plane is ~8.3 units tall whatever the window size (fixed FOV and
    // camera distance in scene.js), so 1.0 is roughly an eighth of the screen
    // height. Mixing the two scales up is the easy mistake here.
    //
    // Smallest edge a block may have while being drawn. Keeps a just-spawned
    // block visible instead of a degenerate sliver.
    minSize: 0.12,
    // On release, a block whose largest face edge is under this is thrown away
    // rather than kept, so a double-pinch you never pulled apart does not
    // litter the scene. Only has to beat the "hands never moved" case: a block
    // spawned at the tightest usable gap comes out around 0.6 units wide.
    minCommit: 0.9,
    // Block depth as a fraction of its average face edge. 1.0 -> a cube when the
    // face is square.
    depthRatio: 0.75,
    // World units of slop around a block's face when deciding whether a pinch
    // has landed ON it. Without this you have to hit inside the edge exactly,
    // which no hand tracker is steady enough to do.
    grabMargin: 0.35,
    // Two pinches at nearly the same relative position along an axis say
    // nothing about that axis's length (the width is not determined by them),
    // so below this separation the axis is translated instead of stretched.
    minAxisSpread: 0.15,
  },

  /**
   * Two-player mode: the screen is split down the middle and each player owns
   * one half. Both numbers are WORLD units on the build plane, the same scale
   * as everything in `box`.
   */
  zone: {
    // How far a block may poke over the divider before it is destroyed. Not
    // zero: a block parked exactly on the line would otherwise be deleted by a
    // pixel of tracking jitter.
    grace: 0.06,
    // How close to the divider a block turns red. Wide enough to be a warning
    // you can act on — roughly a finger's width of travel before it is gone.
    warn: 0.5,
  },

  /**
   * Two fists brought together, then opened, deletes everything. Both numbers
   * are normalized image distance between the two palm centers. The hands must
   * be seen APART first (`armFrom`) before closing to within `gap` — otherwise
   * simply making two fists side by side would arm a delete you never asked for.
   */
  wipe: {
    // Normalized image distance between the palm centers.
    //
    // These are tight ON PURPOSE. Two fists now also mean "zoom", so the whole
    // range from wide apart to nearly closed is ordinary scaling — a delete can
    // only be the extreme end of it. `gap` is therefore knuckles-actually-
    // touching, not merely close.
    //
    // Coords are over the FULL camera frame, which is wider than the cropped
    // part you see on screen, so hands that look far apart score lower than you
    // would guess. armFrom was originally 0.35, which two raised hands barely
    // reach, and that alone stopped the wipe from ever arming.
    armFrom: 0.24,
    // 0.09 was measurably too strict in use: fists side by side did not reach
    // it, so the wipe rarely armed. Raised to a distance two fists actually
    // reach when held next to each other.
    gap: 0.13,
    // Pull back past this and the wipe DISARMS again. Essential now that you
    // pass through "fists close" whenever you zoom in: arming has to be
    // reversible, or every shrink would end in a deleted scene. Moves in step
    // with `gap` — the band between them is the hysteresis, and narrowing it
    // would make the red state flicker on and off at the boundary.
    disarm: 0.20,
    // Frames the fists must stay touching before it arms. Longer than the other
    // confirmations because this is the one irreversible gesture.
    confirmFrames: 5,
  },

  /**
   * Two-fist zoom. The distance between the fists scales everything about their
   * midpoint: spread to grow, close to shrink. Clamped per grab so one
   * over-enthusiastic pull cannot send the scene to a pixel or off to infinity;
   * let go and grab again to keep going.
   */
  zoom: {
    /**
     * Scale is EXPONENTIAL in how much further apart the fists are than when
     * the zoom started — not the ratio of the two spans.
     *
     * The ratio is what a zoom obviously wants, and it is a trap. It divides by
     * the starting separation, so if the second fist happens to be recognized
     * while your hands are near each other, that divisor is tiny and every
     * later movement is multiplied out of all proportion — the scene slams into
     * a clamp. Measured: a baseline taken with fists touching, followed by an
     * ordinary spread, hit the 5x ceiling; the same thing in reverse is the
     * "everything suddenly went really small" glitch.
     *
     * A difference has no divisor, so a bad baseline costs a bounded, gentle
     * error instead of an unbounded one: being 1 unit off is 15% of scale, not
     * a multiple. It also behaves the same everywhere — spreading your hands a
     * given distance always scales by the same factor, wherever you started.
     */
    doublePerUnits: 5.0,   // world units of extra separation that doubles it
    min: 0.2,
    max: 5.0,
    // Largest fraction the scale may move in a single frame. A safety net for
    // anything that can jolt the measured span in one step — the clamps above
    // bound where it can end up, this bounds how fast it gets there.
    maxStepPerFrame: 0.08,
  },

  grab: {
    /**
     * Frames after the number of fists changes during which the transform is
     * re-baselined every frame, pinning it to identity.
     *
     * Bringing up a second fist moves the anchor from one hand to the midpoint
     * of both, and a hand that is still arriving keeps dragging that midpoint —
     * so the scene crept toward the newly-closed hand. Nothing moves until the
     * new hand has settled.
     */
    settleFrames: 5,
    // Two fists also STEER: the angle of the line between them turns the whole
    // scene, like a wheel. Below this separation in world units that angle is
    // mostly tracker noise — two fists a hand's width apart swing the line
    // wildly for a few pixels of jitter — so those frames are ignored rather
    // than fed into the scene.
    steerMinSpan: 1.2,
  },

  /**
   * 1-Euro filter on the pinch/palm cursors. A fixed EMA has to choose between
   * jitter at rest and lag in motion; this picks its cutoff per frame based on
   * how fast the hand is actually moving.
   *
   *   minCutoff  lower = steadier when the hand is still, but adds lag
   *   beta       higher = snaps harder to fast motion. THIS is the knob for
   *              "I have to move slowly or it falls apart".
   *   dCutoff    smoothing on the speed ESTIMATE. The paper's 1.0 needs ~10
   *              frames to notice a sudden move, which is long enough to see
   *              on a gesture; 3.0 reacts in two or three.
   *
   * beta is FAR larger than the values quoted in the paper, and has to be: the
   * paper filters screen pixels, where a moving hand clocks hundreds of units
   * per second, while these are normalized 0..1 frame coords where the same
   * hand clocks 1-3. beta multiplies that speed, so it has to scale with it.
   * Tuned by sweeping the grid against a simulated reach — see the numbers in
   * the README. At beta 1 this filter was three times LAGGIER than the plain
   * exponential average it replaced.
   */
  // The CURSOR filter, applied to the pinch and palm points after the
  // landmarks themselves have already been smoothed (stabilize.js). Less
  // aggressive than it was for exactly that reason: two filters in series add
  // their lag, and the at-rest jitter this one used to carry alone is now
  // dealt with upstream, closer to where it enters.
  filter: { minCutoff: 4.0, beta: 30, dCutoff: 3.0 },

  /**
   * How long a pose survives the hand vanishing from the tracker, in ms.
   *
   * MediaPipe drops a hand for a frame or two constantly — motion blur, a hand
   * crossing your face, a dim room. Without this, every one of those dropouts
   * ended the gesture: the block being drawn committed itself mid-pull, and a
   * held grab let go. Long enough to ride out a dropout, short enough that
   * genuinely lowering your hand still releases promptly.
   */
  graceMs: 200,

  /**
   * Holding up fingers to pick the shape the next block will be drawn as:
   * one square, two circle, three triangle.
   */
  /**
   * Squeezing a block you are resizing down to nothing deletes it. The same
   * bargain as the two-fist wipe, one level down: that one throws the scene
   * away, this one throws away the single block between your fingers.
   *
   * All three are normalized image distance between the two PINCH points, and
   * all three have to hold the same shape as `wipe` for the same reasons — you
   * pass through "fingers fairly close" on every shrink, so a delete can only
   * be the extreme end of that range, and arming has to be reversible or every
   * shrink would end in a deleted block.
   */
  crush: {
    // The fingertips must be seen APART first, so simply starting a resize
    // with your hands already together cannot arm a delete you never asked
    // for. Lower than `wipe.armFrom` because two pinching hands on one block
    // are inherently closer together than two fists.
    armFrom: 0.28,
    // Grabbing a small block starts with your hands ALREADY closer than
    // `armFrom`, and they can only get closer from there — so that gate alone
    // could never be satisfied and the delete was unreachable for exactly the
    // blocks people try to crush. Closing to this fraction of wherever the
    // resize started is the same evidence of intent: you squeezed, hard.
    shrinkTo: 0.5,
    // Fingertips effectively meeting. Still well under the gap that SPAWNS a
    // block (box.spawnGap, 0.22) so ordinary shrinking does not arm, but no
    // longer tighter than two pinching hands can actually reach before the
    // tracker starts losing one of them behind the other.
    gap: 0.13,
    // Pull back past this and it disarms again. The band between this and
    // `gap` is the hysteresis; narrowing it makes the red state flicker at the
    // boundary.
    disarm: 0.19,
    // Frames held together before it arms. Matches the wipe: this is the other
    // gesture that cannot be undone.
    confirmFrames: 4,
    // The block bottoming out at `box.minSize` is the other way of saying the
    // same thing: it cannot get smaller, so continuing to squeeze can only
    // mean delete. Held this many frames, it arms on its own — which is the
    // case that used to just sit there as a tiny block that would not go.
    tinyFrames: 10,
  },

  picker: {
    // `metrics.extension` is ~1.0 for a straight finger and well under for a
    // curled one. Deliberately high: a half-curled finger is not being held
    // up on purpose, and counting it would flicker between two shapes.
    extendedAbove: 0.85,
    // How long the count must stay steady before it lands, in ms. A hand on
    // its way into a pinch passes through one and two fingers up every time,
    // so nothing may fire on sight of a count — this dwell is what separates
    // "meant it" from "passing through".
    holdMs: 1000,
    // How long the ring lingers after a pick lands, purely as confirmation.
    flashMs: 450,
    // After a pick, how long the SAME count is ignored, in ms. Stops the ring
    // from re-arming on the shape you are already holding. A different count
    // is unaffected and lands after the usual dwell.
    repickCooldownMs: 10000,
  },

  /**
   * One hand on one block. Pinch it and it follows your hand; close that same
   * hand into a fist and you turn it instead; open your hand to let go. Carry
   * it to the edge of the frame first and letting go throws it away.
   *
   * The fist here is deliberately NOT the grab-everything fist: while a block
   * is held, that hand's pose steers the block and nothing else. Closing your
   * hand to rotate must not yank the whole scene along with it.
   */
  hold: {
    // Rotation only. World units from the block's centre to the palm. Closer
    // in than this, the ANGLE from centre to hand is mostly tracker noise (a
    // 1px wobble near the middle swings it wildly), so those frames are
    // ignored rather than fed to the block.
    minRadius: 0.4,
    // How far the hand must travel before the block starts following, in world
    // units, and radians it must swing before the block starts turning. These
    // guard the one genuinely ambiguous case left: a single pinch on a block
    // is a drag, but it is ALSO the first half of the two-pinch resize of that
    // same block, and the second hand takes a moment to arrive. Hold
    // reasonably still while it does and the block will not budge.
    moveDeadZone: 0.25,
    turnDeadZone: 0.12,
    // ...and then the block takes that slop back. It engages with zero jump
    // (it would otherwise snap by a whole dead zone), and this decays the
    // offset away per frame, so within a few frames the spot you grabbed is
    // exactly under your hand rather than trailing it forever. 1.0 keeps the
    // offset permanently; 0 gives the snap back.
    slackDecay: 0.85,
    // Frames in a pose before it takes hold. Also charged again on every
    // switch between moving and turning, because closing a pinch into a fist
    // moves the tracked point from your fingertip to your palm and the frames
    // in between are a mess.
    confirmFrames: 3,
    // How close to the edge of the frame a held block's centre has to be for
    // letting go to delete it, as a fraction of the frame. 0.5 would be dead
    // centre; 0 is exactly on an edge. At 0.07 you have to carry the block
    // properly into the margin, well past anywhere you would leave one.
    //
    // The block turns red the whole time it is in there, which is the only
    // reason a destructive action can hang off simply opening your hand — the
    // same bargain the two-fist wipe makes.
    edgeMargin: 0.07,
  },

  /**
   * Grid snap, when it is switched on in Settings (or with G). Blocks settle
   * onto the grid the moment you LET GO — never while your hands are on them,
   * because a block that jumps in steps under your fingertips stops feeling
   * attached to them.
   */
  snap: {
    // Grid cells across the build plane's HEIGHT. The plane is a fixed height in
    // world units, so one cell is the same size on every screen; 16 makes a
    // cell 1/16 of the screen, finer than the smallest size a level asks for.
    cells: 16,
    // Turned blocks settle to the nearest multiple of this, which is what lets
    // a "turn it about 45 degrees" level land exactly.
    angleDeg: 15,
  },
};

/**
 * Decides this frame's pose from the metrics, with hysteresis against the pose
 * already held. Order matters: pinch is tested first because it is the tighter,
 * less ambiguous shape.
 */
function classify(m, current) {
  const gap2 = m.pinch;
  const gap3 = m.pinch3d;

  // The chosen discriminator, with a fallback if this hand/frame has no world
  // landmarks and the chosen signal is a 3D one.
  const d = TUNING.discriminator;
  const signal = m[d.signal] ?? m.tipRatio;

  // The discriminator only guards the PINCH gate here, and a 2D one
  // foreshortens on exactly the tilted hands this gate exists to catch — so
  // when a world-space twin of the chosen signal exists, whichever of the two
  // is more willing to call it a pinch is used. The fist gate below keeps the
  // calibrated signal alone: loosening that one would let pinches fall into
  // grabs, which is the expensive mistake.
  const twin = d.signal.endsWith("3d") ? null : m[`${d.signal}3d`];
  const pinchSignal = twin == null ? signal : Math.min(signal, twin);

  if (current === POSE.PINCH) {
    // Three ways out, and the first one answers to nothing else: the image-space
    // gap alone, past the ceiling, ends the pinch. The other two are the old
    // pair — a wide world-space gap on its own, or the softer 2d threshold once
    // 3d agrees the fingers have started to part — and they exist for hands
    // held edge-on, where the flat image hides the gap the world sees.
    const ceiling = gap2 > TUNING.pinch.hardExit2d;
    const released2d = gap2 > TUNING.pinch.exit2d;
    const parting3d = gap3 == null || gap3 > TUNING.pinch.exit3dSoft;
    const released3d = gap3 != null && gap3 > TUNING.pinch.exit3d;
    if (!(ceiling || released3d || (released2d && parting3d))) return POSE.PINCH;
  } else if ((gap2 < TUNING.pinch.enter2d
              || (gap3 != null && gap3 < TUNING.pinch.enter3d))
             && pinchSignal < d.pinchBelow) {
    return POSE.PINCH;
  }

  if (current === POSE.FIST) {
    // Looser on both counts while holding, so a grab does not flicker off.
    if (m.curlMax < TUNING.fist.exitCurl && signal > d.fistAbove * 0.8) return POSE.FIST;
  } else if (m.curlMax < TUNING.fist.enterCurl && signal > d.fistAbove) {
    return POSE.FIST;
  }

  const openAt = current === POSE.OPEN ? TUNING.open.exitCurl : TUNING.open.enterCurl;
  if (m.curl > openAt) return POSE.OPEN;

  return POSE.NONE;
}

/** Per-hand pose + smoothed cursors. One instance per tracked hand identity —
 *  handedness, or handedness plus side of the frame in two-player mode. */
class HandState {
  constructor(handedness, key = handedness) {
    this.handedness = handedness;
    this.key = key;
    // Which half of the screen the hand is in, restated every frame. Play mode
    // routes a hand to a player by this, so it has to follow the hand rather
    // than be frozen at the identity it was created with.
    this.side = null;
    this.pose = POSE.NONE;
    this.candidate = POSE.NONE;
    this.frames = 0;
    this.startedAt = 0;
    this.lastSeen = 0;
    this.stale = false;      // held through a tracking dropout, coords frozen
    this.metrics = null;
    this.pinchPoint = null;  // smoothed, normalized coords
    this.palmPoint = null;
    this._pinchFilter = new OneEuroPoint(TUNING.filter);
    this._palmFilter = new OneEuroPoint(TUNING.filter);
  }

  /** @returns {{from:string,to:string}|null} pose change committed this frame */
  observe(metrics, now) {
    this.metrics = metrics;
    this.lastSeen = now;
    this.stale = false;

    const t = now / 1000;
    this.pinchPoint = this._pinchFilter.filter(metrics.pinchPoint, t);
    this.palmPoint = this._palmFilter.filter(metrics.palmPoint, t);

    const wants = classify(metrics, this.pose);

    if (wants === this.candidate) this.frames++;
    else { this.candidate = wants; this.frames = 1; }

    // NONE is the transitional shape between two poses; leaving a pose for it
    // needs no confirmation, but committing to a real pose does.
    const needed = wants === POSE.NONE ? 1 : 2;
    if (wants !== this.pose && this.frames >= needed) {
      const from = this.pose;
      this.pose = wants;
      this.startedAt = now;
      return { from, to: wants };
    }
    return null;
  }

  /** Hand is not in this frame. Keep the pose alive briefly; see graceMs. */
  hold(now) {
    this.stale = true;
    return now - this.lastSeen <= TUNING.graceMs;
  }

  get duration() { return performance.now() - this.startedAt; }
}

/**
 * Tracks pose across frames, keyed by handedness so a hand keeps its state even
 * when MediaPipe reorders the detection array between frames.
 *
 * `engine.hands` is the output everything downstream should read — it includes
 * hands currently riding out a tracking dropout, which `frame.hands` does not.
 */
export class GestureEngine {
  constructor({ onPose } = {}) {
    this.states = new Map();
    this.hands = [];
    this.onPose = onPose || (() => {});
  }

  update(frame) {
    const seen = new Set();

    for (const hand of frame.hands) {
      const key = hand.key ?? hand.handedness;
      seen.add(key);

      let state = this.states.get(key);
      if (!state) {
        state = new HandState(hand.handedness, key);
        this.states.set(key, state);
      }

      state.side = hand.side ?? null;
      const change = state.observe(hand.metrics, frame.now);
      hand.state = state;   // the 2D overlay reads pose off the live hand
      if (change) this.onPose(state, change);
    }

    for (const [key, state] of this.states) {
      if (seen.has(key)) continue;
      if (state.hold(frame.now)) continue;   // still inside the grace window
      if (state.pose !== POSE.NONE) this.onPose(state, { from: state.pose, to: POSE.NONE });
      this.states.delete(key);
    }

    this.hands = [...this.states.values()];
  }
}
