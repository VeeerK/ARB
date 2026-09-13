import { FilesetResolver, HandLandmarker } from "../vendor/tasks-vision/vision_bundle.mjs";
import { handMetrics, looksLikeHand, LM } from "./landmarks.js";
import { HandStabilizer } from "./stabilize.js";

const WASM_DIR = "./vendor/tasks-vision/wasm";
/** How long a hand's last known position stays available to the identity latch
 *  after it stops being detected. Matches CONTINUITY.resetAfterMs. */
const PREV_GRACE_MS = 400;
const MODEL_URL = "./models/hand_landmarker.task";

/**
 * Owns the camera stream and the MediaPipe detector, and pushes one frame of
 * hand data per animation frame to `onFrame`. Everything downstream (2D debug
 * overlay now, three.js scene later) is just a consumer of that frame object.
 */
export class HandTracker {
  constructor({ video, numHands = 2, onFrame, onStatus = () => {} }) {
    this.video = video;
    this.numHands = numHands;
    this.onFrame = onFrame;
    this.onStatus = onStatus;
    this.landmarker = null;
    this.stream = null;
    this.running = false;
    this._lastVideoTime = -1;
    this._rafId = 0;
    this._lastFrame = null;
    this._fps = 0;
    this._lastTs = 0;
    // Smoothing and the physical-plausibility gate, both per hand. See
    // stabilize.js: this is what keeps a hand held over your face from
    // flickering between poses.
    this._stab = new HandStabilizer();
    // Opt-in preprocessing: see `enhance`. Off by default because it costs a
    // full-frame copy per frame and the win depends on your camera and light.
    this.enhance = false;
    this._work = null;
    /**
     * Two-player mode. When set, a hand is identified by its handedness AND
     * which half of the frame it is in, so two people's right hands are two
     * different hands rather than one that keeps teleporting. Off by default:
     * with one player, crossing the middle of the frame would otherwise reset
     * that hand's filters and pose mid-gesture.
     */
    this.splitZones = false;
    // Last frame's wrists, for the side hysteresis in `_sideOf`.
    this._prev = [];
  }

  async start() {
    this.onStatus("requesting camera…");
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    await new Promise((res) => {
      if (this.video.videoWidth) return res();
      this.video.addEventListener("loadeddata", res, { once: true });
    });

    this.onStatus("loading model…");
    const fileset = await FilesetResolver.forVisionTasks(WASM_DIR);
    try {
      this.landmarker = await this._create(fileset, "GPU");
    } catch (err) {
      // No WebGL, a blocklisted driver, or a GPU the delegate cannot use.
      // Slower on the CPU, but tracking beats an error screen.
      console.warn("GPU delegate failed, falling back to CPU:", err);
      this.onStatus("loading model (CPU)…");
      this.landmarker = await this._create(fileset, "CPU");
    }

    this.running = true;
    this.onStatus("tracking");
    this._loop();
  }

  _create(fileset, delegate) {
    return HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: "VIDEO",
      numHands: this.numHands,
      // Detection stays strict (this is what decides a hand EXISTS), but
      // presence and tracking are loosened: those two gate whether an
      // already-found hand is still there frame to frame, and at 0.5 they drop
      // the hand on motion blur, on a dim frame, and when it crosses your face.
      // Losing the hand costs a whole gesture; a slightly noisier landmark for
      // a frame or two costs nothing the 1-Euro filter cannot absorb.
      // Lowered along with the tiered shape gate in `looksLikeHand`: this is
      // the bar for finding a hand from scratch, which is what has to be
      // cleared every time a turned hand is lost outright and has to be picked
      // up again. The strict tier of the shape gate is now the thing keeping
      // face fits out, so this no longer has to do that job as well.
      minHandDetectionConfidence: 0.4,
      minHandPresenceConfidence: 0.3,
      minTrackingConfidence: 0.3,
    });
  }

  /**
   * Two players need up to four hands. Changed live rather than at construction
   * so switching modes does not rebuild the detector (and re-download nothing,
   * but re-initialize the GPU delegate, which stalls for a second).
   */
  async setNumHands(n) {
    if (n === this.numHands) return;
    this.numHands = n;
    if (!this.landmarker) return;   // picked up when start() builds it
    try {
      await this.landmarker.setOptions({ numHands: n });
    } catch (err) {
      console.warn("could not change numHands live:", err);
    }
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._rafId);
    this.stream?.getTracks().forEach((t) => t.stop());
  }

  _loop = () => {
    if (!this.running) return;
    this._rafId = requestAnimationFrame(this._loop);

    const now = performance.now();
    if (this._lastTs) {
      const inst = 1000 / Math.max(now - this._lastTs, 1e-3);
      // Background tabs get throttled hard; the EMA keeps the readout honest
      // instead of spiking when the tab is refocused.
      this._fps = this._fps ? this._fps * 0.9 + inst * 0.1 : inst;
    }
    this._lastTs = now;

    // MediaPipe rejects a repeated timestamp, so only detect on a fresh frame.
    if (this.video.currentTime !== this._lastVideoTime && this.video.videoWidth) {
      this._lastVideoTime = this.video.currentTime;
      const result = this.landmarker.detectForVideo(this._source(), now);
      this._lastFrame = this._pack(result, now);
    }

    if (this._lastFrame) this.onFrame({ ...this._lastFrame, fps: this._fps, now });
  };

  /**
   * Raw detections -> the hands the rest of the app sees.
   *
   * Three filters, cheapest and most decisive first, because every one of them
   * is defending the same thing: a bad fit downstream is a pinch you did not
   * make. Anything dropped here simply does not appear in the frame, which the
   * gesture engine already treats as a momentary dropout rather than as the
   * hand being lowered.
   */
  /**
   * What the detector actually looks at.
   *
   * A hand in front of your own face is the model's worst case: same skin,
   * same light, and no edge between the two for it to find. Pushing contrast
   * and saturation up before detection gives that edge a little more to be,
   * which is the only lever available from this side of the model — it cannot
   * be retrained, and no threshold downstream can recover an edge the model
   * never saw.
   *
   * It is a whole extra frame copy per frame, and whether it pays depends on
   * your camera and your room, so it is opt-in rather than assumed:
   *
   *   ARB.tracker.enhance = true
   *
   * Watch the fps and the dropped count in the HUD to see whether it helped.
   */
  _source() {
    if (!this.enhance) return this.video;

    const w = this.video.videoWidth, h = this.video.videoHeight;
    if (!this._work || this._work.canvas.width !== w || this._work.canvas.height !== h) {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      // `willReadFrequently` off on purpose: this canvas is only ever drawn to
      // and handed on, never read back, so the GPU path is the right one.
      this._work = { canvas, ctx: canvas.getContext("2d") };
    }

    const { canvas, ctx } = this._work;
    ctx.filter = "contrast(1.25) saturate(1.35)";
    ctx.drawImage(this.video, 0, 0, w, h);
    return canvas;
  }

  _pack(result, now) {
    // Best fits first, so when two detections compete for one identity — the
    // same hand found twice, or four hands in a two-player game — the one the
    // model is surest about wins the slot.
    const raw = [];
    for (let i = 0; i < (result.landmarks || []).length; i++) {
      const landmarks = result.landmarks[i];
      const score = result.handednesses?.[i]?.[0]?.score ?? 0;
      // 0. Is this the hand that was here last frame? Everything below is
      //    lenient if so — see `_continuationOf`.
      const prev = this._continuationOf(landmarks);
      // 1. Is this shaped like a hand at all, or did the model fit a face?
      if (!looksLikeHand(landmarks, score, { tracked: !!prev })) continue;
      raw.push({
        landmarks,
        score,
        // "Left"/"Right" as MediaPipe sees the *unmirrored* camera image.
        handedness: result.handednesses?.[i]?.[0]?.categoryName ?? "Unknown",
        world: result.worldLandmarks?.[i],
        prev,
      });
    }
    raw.sort((a, b) => b.score - a.score);

    const kept = [];
    const perSide = { left: 0, right: 0 };
    // One hand from last frame can only continue into one detection in this
    // one; best fit first (raw is score-sorted) gets to claim it.
    const claimed = new Set();

    for (const det of raw) {
      // 2. The same hand, found twice. With four hands allowed, MediaPipe will
      // sometimes return two boxes over one hand; downstream they become two
      // players fighting over one set of fingers.
      if (kept.some((k) => this._samePlace(k.landmarks, det.landmarks))) continue;

      const side = this._sideOf(det.landmarks);
      // 3. Nobody has three hands. A cap per side means a face, a passer-by or
      // a reflection cannot take a player's slot away from them.
      if (this.splitZones) {
        if (perSide[side] >= 2) continue;
      } else if (kept.length >= this.numHands) break;

      // Identity comes from where the hand WAS, not from what the classifier
      // called it this frame. Turned edge-on, "Left" and "Right" look the same
      // and MediaPipe's label flips — and every downstream cache is keyed on
      // it, so a flip silently becomes: filters reset, pose forgotten, and the
      // block this hand was carrying dropped by an owner that no longer
      // matches. A hand that was here a frame ago keeps its old label.
      const keyFor = (h) => (this.splitZones ? `${h}@${side}` : h);
      let handedness = det.handedness;
      if (det.prev && !claimed.has(det.prev)
          // Never latch onto an identity another hand in this frame already
          // holds: two hands sharing one key is worse than a wrong label.
          && !kept.some((k) => k.key === keyFor(det.prev.handedness))) {
        claimed.add(det.prev);
        handedness = det.prev.handedness;
      }

      const hand = {
        handedness,
        side,
        // What every per-hand cache downstream is keyed by: filters, pose
        // state, grab ownership.
        key: keyFor(handedness),
        score: det.score,
        landmarks: det.landmarks,                     // normalized 0..1, image space
        worldLandmarks: det.world,                    // metric, wrist-origin
      };

      // 4. Could a real hand have got here from where it was last frame?
      // 5. Smooth all 21 landmarks, so POSE stops shivering along with them.
      const steady = this._stab.accept(hand, now);
      if (!steady) continue;

      hand.landmarks = steady.landmarks;
      hand.worldLandmarks = steady.worldLandmarks;
      hand.metrics = handMetrics(steady.landmarks, steady.worldLandmarks);
      perSide[side]++;
      kept.push(hand);
    }

    this._stab.prune(now);
    // Remembered for the side hysteresis and the identity latch next frame.
    const fresh = kept.map((h) => ({
      // Mirrored, because `_sideOf` asks which half of the SCREEN a hand is in.
      x: 1 - h.landmarks[LM.WRIST].x,
      y: h.landmarks[LM.WRIST].y,
      // Unmirrored, because `_continuationOf` compares against raw detections.
      wrist: h.landmarks[LM.WRIST],
      span: h.metrics.scale,
      handedness: h.handedness,
      side: h.side,
      seenAt: now,
    }));

    // A hand dropped for a frame or two — by the continuity gate, by a blurred
    // frame, by the model losing it mid-turn — must not lose its identity, or
    // the latch would break in exactly the moment it exists for. Its last known
    // position is carried for a grace window instead, so when the hand comes
    // back it comes back as itself. The same window the stabilizer uses before
    // it calls a hand new (CONTINUITY.resetAfterMs).
    const stale = (this._prev ?? []).filter(
      (p) => p.seenAt && now - p.seenAt < PREV_GRACE_MS
        && !fresh.some((f) => f.handedness === p.handedness && f.side === p.side));
    this._prev = fresh.concat(stale);

    return {
      hands: kept,
      rejected: this._stab.rejected,
      videoW: this.video.videoWidth,
      videoH: this.video.videoHeight,
      t: now,
    };
  }

  /**
   * The hand from last frame that this detection continues, if any.
   *
   * Purely positional, and that is the point: it is the one thing about a hand
   * that a rotation cannot change. Between two frames a wrist moves a little;
   * meanwhile the palm can foreshorten to nothing, the fingers can vanish
   * behind each other and the handedness label can flip outright. So position
   * is what says "this is still your hand", and having said it, the shape gate
   * relaxes and the old identity carries over.
   *
   * Measured in palm spans so the window is the same however near the camera
   * the hand is. Wide enough for a fast hand at 60fps, far tighter than the
   * distance to a face fit somewhere else in the frame.
   */
  _continuationOf(landmarks) {
    const w = landmarks[LM.WRIST];
    let best = null, bestD = Infinity;
    for (const prev of this._prev ?? []) {
      const d = Math.hypot(prev.wrist.x - w.x, prev.wrist.y - w.y) / Math.max(prev.span, 1e-6);
      if (d < bestD) { bestD = d; best = prev; }
    }
    return bestD < 1.2 ? best : null;
  }

  /** Two detections close enough to be the same hand seen twice. Measured in
   *  palm spans so it holds however near the camera the hand is. */
  _samePlace(a, b) {
    const wa = a[LM.WRIST], wb = b[LM.WRIST];
    const span = Math.max(
      Math.hypot(a[LM.MIDDLE_MCP].x - wa.x, a[LM.MIDDLE_MCP].y - wa.y), 1e-6);
    return Math.hypot(wa.x - wb.x, wa.y - wb.y) < span * 0.9;
  }

  /**
   * Which half of the SCREEN a hand is in. The view is mirrored, so a landmark
   * at x = 0.2 is drawn on the right.
   *
   * With hysteresis, because in two-player mode this decides WHOSE hand it is:
   * a hand working right against the divider would otherwise flicker between
   * players, and each flicker is a new identity with cold filters and no pose.
   * Inside the band it keeps whatever the nearest hand was last frame, so only
   * a real crossing changes sides.
   */
  _sideOf(landmarks) {
    const w = landmarks[LM.WRIST];
    const x = 1 - w.x;
    if (x < 0.45) return "left";
    if (x > 0.55) return "right";

    let best = null, bestD = 0.16;   // normalized frame distance
    for (const prev of this._prev ?? []) {
      const d = Math.hypot(prev.x - x, prev.y - w.y);
      if (d < bestD) { bestD = d; best = prev; }
    }
    return best?.side ?? (x < 0.5 ? "left" : "right");
  }
}
