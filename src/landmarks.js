/**
 * Raw landmark math. Nothing here classifies a gesture — it only produces the
 * numbers that gesture logic (step 2 onward) thresholds against, so thresholds
 * stay visible and tunable instead of hidden inside a "gesture name" black box.
 *
 * MediaPipe hand landmark indices:
 *   0 wrist
 *   1-4   thumb   (cmc, mcp, ip, tip)
 *   5-8   index   (mcp, pip, dip, tip)
 *   9-12  middle
 *   13-16 ring
 *   17-20 pinky
 */
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
};

/** Bone pairs, for drawing the skeleton. */
export const CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],          // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],          // index
  [9, 10], [10, 11], [11, 12],             // middle
  [13, 14], [14, 15], [15, 16],            // ring
  [0, 17], [17, 18], [18, 19], [19, 20],   // pinky
  [5, 9], [9, 13], [13, 17],               // palm knuckle bridge
];

export const FINGERS = {
  thumb:  { mcp: LM.THUMB_MCP,  pip: LM.THUMB_IP,   tip: LM.THUMB_TIP },
  index:  { mcp: LM.INDEX_MCP,  pip: LM.INDEX_PIP,  tip: LM.INDEX_TIP },
  middle: { mcp: LM.MIDDLE_MCP, pip: LM.MIDDLE_PIP, tip: LM.MIDDLE_TIP },
  ring:   { mcp: LM.RING_MCP,   pip: LM.RING_PIP,   tip: LM.RING_TIP },
  pinky:  { mcp: LM.PINKY_MCP,  pip: LM.PINKY_PIP,  tip: LM.PINKY_TIP },
};

export function dist3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.hypot(dx, dy, dz);
}

export function dist2(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * A per-hand length unit. Divide any raw distance by this and the result stops
 * depending on how close the hand is to the camera, which is what makes a
 * single pinch threshold work at any depth.
 *
 * The LARGEST of four palm spans, not just wrist -> middle knuckle. Projection
 * can only ever SHORTEN a length, never lengthen it, so with the hand turned
 * side-on the single old span foreshortened hard while the thumb-index gap did
 * not — every ratio measured against it inflated, and a pinch held sideways
 * read as wide open. Whichever span is currently most face-on wins, which is
 * as close to the hand's true size as a flat image can get. Frontally the
 * middle-knuckle span is the longest anyway, so nothing about the neutral pose
 * (or any threshold calibrated against it) moves.
 */
export function handScale(lms) {
  return palmSpan(lms, dist2);
}

function palmSpan(pts, dist) {
  const w = pts[LM.WRIST];
  return Math.max(
    dist(w, pts[LM.MIDDLE_MCP]),
    dist(w, pts[LM.INDEX_MCP]),
    dist(w, pts[LM.PINKY_MCP]),
    dist(pts[LM.INDEX_MCP], pts[LM.PINKY_MCP]),
    1e-6,
  );
}

/**
 * The thumb-to-index gap, as the CLOSEST approach between the two digits
 * rather than strictly tip to tip.
 *
 * People pinch on the pad of the finger, not its very end, and a hand seen
 * from the side hides the tips behind each other so the model places them
 * badly. Taking the smallest of three plausible contact pairs makes the number
 * report "these two are touching" in all of those cases, and costs almost
 * nothing when they are apart — an open hand has every pair wide.
 */
function pinchGapFrom(pts, dist) {
  return Math.min(
    dist(pts[LM.THUMB_TIP], pts[LM.INDEX_TIP]),
    dist(pts[LM.THUMB_TIP], pts[LM.INDEX_DIP]),
    dist(pts[LM.THUMB_IP], pts[LM.INDEX_TIP]),
  );
}

/**
 * A cheap sanity check that a detection is shaped like a hand at all.
 *
 * MediaPipe will occasionally fit the model to a face or a bunched-up shoulder
 * when the real hand leaves the frame, and downstream every one of those
 * frames is a phantom pinch or a scene grab nobody asked for. This does not
 * try to be a classifier — it only rejects geometry a hand cannot have: a palm
 * far from square, or fingers whose bones are absurd next to the palm.
 *
 * Every bound here is TIERED on whether this detection continues a hand that
 * was already being tracked a frame ago, because the two jobs are different.
 * Admitting a hand out of nothing is where a face fit gets in, so that stays
 * strict. Keeping a hand that the tracker has been following, has filters for
 * and has watched move continuously is a much easier claim to believe — and it
 * is the case the strict bounds were quietly breaking, because everything they
 * measure collapses when you turn your palm away from the camera:
 *
 *   - `score` is the handedness confidence, NOT a detection confidence. Edge-on
 *     a left hand and a right hand genuinely look alike, so the model reports
 *     something near 0.5 and means it. Gating EXISTENCE on it made a rotating
 *     hand disappear at exactly the angle where it is hardest to see.
 *   - palm width is the knuckle line, which is the first thing a roll
 *     foreshortens: turn side-on and it goes to almost nothing, correctly.
 *   - finger bones shorten the same way when the fingers point at the camera.
 */
export function looksLikeHand(lms, score = 1, { tracked = false } = {}) {
  if (!lms || lms.length < 21) return false;
  if (score < (tracked ? 0.2 : 0.55)) return false;

  const scale = handScale(lms);
  const width = dist2(lms[LM.INDEX_MCP], lms[LM.PINKY_MCP]) / scale;
  // A real palm is roughly as wide as it is long; edge-on it narrows to a
  // sliver, and it never gets much wider than it is long.
  if (width < (tracked ? 0.08 : 0.25) || width > 1.7) return false;

  const minBone = tracked ? 0.08 : 0.15;
  for (const f of [FINGERS.index, FINGERS.middle, FINGERS.ring, FINGERS.pinky]) {
    const bone = (dist2(lms[f.mcp], lms[f.pip]) + dist2(lms[f.pip], lms[f.tip])) / scale;
    if (bone < minBone || bone > 2.2) return false;
  }
  return true;
}

/**
 * How extended a finger is: tip distance from the wrist over the length of the
 * finger's own bones. ~1.0 straight, well under 1.0 curled into a fist.
 */
export function fingerExtension(lms, finger) {
  const bone = dist2(lms[LM.WRIST], lms[finger.mcp])
    + dist2(lms[finger.mcp], lms[finger.pip])
    + dist2(lms[finger.pip], lms[finger.tip]);
  return dist2(lms[LM.WRIST], lms[finger.tip]) / Math.max(bone, 1e-6);
}

/** Palm roll angle in radians, from the index knuckle -> pinky knuckle axis. */
export function palmAngle(lms) {
  const a = lms[LM.INDEX_MCP], b = lms[LM.PINKY_MCP];
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/**
 * Pinch gap measured in MediaPipe's metric world space (meters, wrist-origin,
 * true 3D) instead of the flattened image.
 *
 * This matters a lot: tilt your hand toward the camera and the thumb->index gap
 * gets foreshortened in the 2D image while the palm width barely changes, so the
 * image-space ratio reads far smaller than your fingers actually are. World
 * space has real depth, so the number means the same thing at any hand angle.
 *
 * Returns null when world landmarks aren't available; callers fall back to 2D.
 */
export function pinchWorld(world) {
  if (!world || world.length < 21) return null;
  return pinchGapFrom(world, dist3) / palmSpan(world, dist3);
}

/**
 * Where the thumb tip sits ALONG the index finger: its distance to the index
 * TIP over its distance to the index PIP (the middle knuckle).
 *
 *   pinch -> the thumb is on the index tip          -> ratio well under 1
 *   fist  -> the thumb lies across the middle       -> ratio around 1 or above
 *
 * This exists because the obvious signal does not work. A raw thumb-to-index
 * GAP cannot tell the two apart: in a natural fist the index tip folds into the
 * palm and the thumb comes to rest right next to it, so the gap is just as small
 * as a pinch. Only sticking the thumb out clear of the hand made the gap large,
 * which is not a fist anyone actually makes.
 *
 * Asking *where along the finger* the thumb sits separates them cleanly, and the
 * ratio has a second benefit: both distances are measured in the same small
 * patch of the image, so perspective foreshortening scales them together and
 * largely cancels — the same tilt that wrecks a raw gap barely moves this.
 */
export function thumbTipRatio(lms) {
  return tipRatioFrom(lms, dist2, handScale(lms));
}

/** Same ratio in metric world space, where nothing is foreshortened. */
export function thumbTipRatio3d(world) {
  if (!world || world.length < 21) return null;
  return tipRatioFrom(world, dist3, palmSpan(world, dist3));
}

function tipRatioFrom(pts, dist, scale) {
  const thumb = pts[LM.THUMB_TIP];
  const toTip = dist(thumb, pts[LM.INDEX_TIP]);
  const toPip = dist(thumb, pts[LM.INDEX_PIP]);
  // Floor the denominator: a thumb resting exactly on the PIP would otherwise
  // send the ratio to infinity and make the number useless to threshold.
  return toTip / Math.max(toPip, 0.15 * scale);
}

/**
 * How far the thumb tip sits from the palm center, in hand-scale units.
 * A thumb folded across a fist sits ON the palm; a pinching thumb is out at the
 * index tip, clear of it. Another candidate discriminator — which of these
 * actually separates a given hand is decided by ARB.calibrateFist(), not here.
 */
export function thumbToPalm(lms) {
  return dist2(lms[LM.THUMB_TIP], palmPoint(lms)) / handScale(lms);
}

export function thumbToPalm3d(world) {
  if (!world || world.length < 21) return null;
  return dist3(world[LM.THUMB_TIP], palmPoint(world)) / palmSpan(world, dist3);
}

/**
 * Palm center: wrist plus the four knuckles, averaged. This is the anchor a
 * fist moves by. The pinch midpoint is useless for a closed hand, and any
 * single landmark jitters — averaging five spreads that noise out, and the
 * knuckles are the landmarks the model is most confident about when the fingers
 * are curled and occluding each other.
 */
export function palmPoint(lms) {
  const ids = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];
  let x = 0, y = 0, z = 0;
  for (const i of ids) { x += lms[i].x; y += lms[i].y; z += lms[i].z ?? 0; }
  return { x: x / ids.length, y: y / ids.length, z: z / ids.length };
}

/** Midpoint of thumb tip and index tip — the natural "cursor" for a pinch. */
export function pinchPoint(lms) {
  const t = lms[LM.THUMB_TIP], i = lms[LM.INDEX_TIP];
  return { x: (t.x + i.x) / 2, y: (t.y + i.y) / 2, z: ((t.z ?? 0) + (i.z ?? 0)) / 2 };
}

/**
 * Every raw number a gesture rule might want, computed once per hand per frame.
 * Gesture logic in later steps reads these; it never re-derives them.
 */
export function handMetrics(lms, world) {
  const scale = handScale(lms);
  const extension = {};
  for (const [name, f] of Object.entries(FINGERS)) extension[name] = fingerExtension(lms, f);

  return {
    scale,
    // Thumb-tip <-> index-tip gap, in flat image space. Kept for reference and
    // as a fallback, but it foreshortens when the hand tilts.
    pinch: pinchGapFrom(lms, dist2) / scale,
    // Same gap in true 3D. This is the signal the detector actually uses.
    pinch3d: pinchWorld(world),
    pinchPoint: pinchPoint(lms),
    palmPoint: palmPoint(lms),
    // Kept on the metrics so anything downstream can reach a specific
    // landmark (the shape picker rings the raised fingertips) without
    // being handed the raw frame as well.
    landmarks: lms,
    // Candidate fist-vs-pinch discriminators. Both poses can be a closed hand
    // with identical finger curl, so the ONLY thing that differs is where the
    // thumb is; these are four different ways of asking that. ARB.calibrateFist()
    // measures all of them on a real hand and picks whichever separates best —
    // see TUNING.discriminator.
    tipRatio: thumbTipRatio(lms),
    tipRatio3d: thumbTipRatio3d(world),
    thumbToPalm: thumbToPalm(lms),
    thumbToPalm3d: thumbToPalm3d(world),
    extension,
    // Worst-case extension of the four fingers. `curl` (the mean) can look
    // closed while one finger is still sticking out; a fist has to satisfy
    // EVERY finger, so the max is the number the fist test thresholds against.
    curlMax: Math.max(extension.index, extension.middle, extension.ring, extension.pinky),
    // Mean extension of the four non-thumb fingers. The fist signal.
    curl: (extension.index + extension.middle + extension.ring + extension.pinky) / 4,
    palmAngle: palmAngle(lms),
  };
}
