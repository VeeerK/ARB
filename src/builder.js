import { Block, AXIS } from "./scene.js";
import { TUNING, POSE } from "./gestures.js";

/**
 * What the poses build.
 *
 *   two PINCHes on empty space     ->  draws a new block between the fingertips
 *   two PINCHes on a block         ->  reshapes THAT block instead
 *   either hand opens              ->  the block is committed / released
 *
 *   ONE FIST on a block            ->  picks up THAT block alone; it follows
 *                                      your hand round the screen
 *   ONE PINCH on a block           ->  turns it. The first clear motion locks
 *                                      the axis: up/down tilts, left/right
 *                                      spins, a circle steers (tilt and spin
 *                                      only where `tilt` allows)
 *   open that hand                 ->  puts it down
 *   ...at the edge of the frame    ->  throws it away instead
 *
 *   two FISTs                      ->  grabs every block: moves, steers and
 *                                      zooms them about the midpoint of the fists
 *   open the hands                 ->  everything locks where it is
 *
 *   two FISTs touching             ->  arms a wipe (blocks turn red)
 *   then open                      ->  deletes everything
 *   pull the fists apart instead   ->  disarms, back to normal
 *
 * This lives apart from gestures.js because it is about *what a pose builds*,
 * not about recognizing one. gestures.js stays a pure "what shape is the hand"
 * layer.
 */
export class Builder {
  /**
   * @param {Scene} scene shared by every builder on screen
   * @param {object} [opts]
   * @param {"left"|"right"|null} [opts.zone] half of the screen this builder
   *   owns, for two-player mode. With a zone set it only ever sees the hands in
   *   that half, and only ever owns the blocks it made itself — which is the
   *   whole of "you cannot touch the other player's blocks": there is no rule
   *   forbidding it, the other player's blocks are simply not in this list.
   *   A block that crosses the divider is destroyed; see `_enforceZone`.
   * @param {"p1"|"p2"} [opts.theme] block colours (scene.js THEMES)
   * @param {() => boolean} [opts.snap] whether grid snap is on right now. A
   *   function, not a flag, so toggling it mid-game reaches every builder.
   * @param {() => boolean} [opts.tilt] whether a pinch may tilt and spin a
   *   block out of the build plane, or only steer it. Off wherever something
   *   judges blocks as flat shapes facing the camera (levels, challenges).
   * @param {(type: string) => void} [opts.onEvent] told when something worth a
   *   sound happens: draft, commit, grab, drop, arm, remove, wipe.
   */
  constructor(scene, { zone = null, theme = "p1", snap = null, tilt = null, onEvent = null } = {}) {
    this.scene = scene;
    this.zone = zone;
    this.theme = theme;
    this.snapOn = snap ?? (() => false);
    this.tiltOn = tilt ?? (() => false);
    this.onEvent = onEvent;
    this.blocks = [];
    this.draft = null;      // ghost Block being drawn, if any
    this.resize = null;     // existing block being reshaped by two pinches
    this.grab = null;       // active fist grab: anchor, span, per-block origins
    this.hold = null;       // ONE block carried by ONE hand: moved, or turned
    // Set when a two-hand pinch ends, cleared when both hands open. Stops one
    // long pinch from immediately spawning a second block.
    this.rearming = false;
    // Which shape the next drawn block will be. Set by the finger-count
    // picker (see picker.js); everything after that treats all shapes alike.
    this.shape = "box";
    // The same idea for the hold. Any two-handed work that ends with one hand
    // still pinching leaves that hand sitting on the block it was just drawing
    // or resizing — without this, letting go of one hand would silently pick
    // that block up.
    this.holdLock = false;
    // What has happened, oldest first, so it can be taken back. See `undo`.
    this.history = [];
  }

  /** Call once per frame with `gestures.hands` (NOT frame.hands — that one
   *  omits hands riding out a tracking dropout, which would drop the grab). */
  update(hands) {
    // In two-player mode a hand belongs to whichever half of the screen it is
    // in, and this builder never sees the other half's. Reaching across the
    // divider therefore hands your arm to the other player's builder rather
    // than granting you access to their blocks — the zone owns the space, not
    // the person.
    if (this.zone) hands = hands.filter((h) => h.side === this.zone);

    this._frame(hands);
    if (this.zone) this._enforceZone();
  }

  _frame(hands) {
    // A held block outranks everything. While one hand is on one block, that
    // hand steers it and nothing else; see `_holdFrame` for the two handovers.
    if (this.hold) {
      this._holdFrame(hands);
      if (this.hold) return;
    }

    const fists = hands.filter((h) => h.pose === POSE.FIST && h.palmPoint);
    const pinches = hands.filter((h) => h.pose === POSE.PINCH && h.pinchPoint);

    // The scene grab takes two fists to start, but carries on while either is
    // still closed: hands open, and drop out of tracking, one at a time, and
    // neither should turn a scene grab into a single-block carry.
    if (this.grab) {
      if (fists.length) {
        this._grabbing(fists, hands);
        return;
      }
      // At the edge, a fist opening passes through a shape that is neither
      // (POSE.NONE). Wait for the open rather than reading that as the tracker
      // losing the hands, which would put everything down instead of deleting.
      if (this.grab.edge && hands.some((h) => h.pose === POSE.NONE)) return;
      this._releaseGrab(hands.some((h) => h.pose === POSE.OPEN));
    }

    // A fist outranks a pinch: while anything is grabbed, nothing is drawn.
    if (fists.length >= 2) {
      this._endPinchWork();
      this._grabbing(fists, hands);
      return;
    }
    if (fists.length === 1) {
      this._endPinchWork();
      // On a block it carries that block. On empty space it does nothing.
      this._startHold(fists[0], "move");
      if (this.hold) return;
    }

    this._pinching(pinches, fists.length > 0);
  }

  // ---- pinch: draw a new block, or reshape an existing one ---------------

  _pinching(pinches, anyFist = false) {
    if (pinches.length < 2) {
      // Ends any two-handed work FIRST, so the frame a resize or a draft
      // finishes is the frame holdLock/rearming go up — and the hand still
      // pinching cannot immediately pick up what it was just holding.
      this._endPinchWork();
      if (pinches.length === 1) this._startHold(pinches[0], "turn");
      else if (!anyFist) {
        // Every hand open: the next pick-up is a fresh one.
        this.rearming = false;
        this.holdLock = false;
      }
      return;
    }

    const [a, b] = pinches;
    const wa = this.scene.toWorld(a.pinchPoint.x, a.pinchPoint.y);
    const wb = this.scene.toWorld(b.pinchPoint.x, b.pinchPoint.y);

    if (!this.draft && !this.resize) {
      // Landing both pinches on an existing block means "reshape this one".
      // The cost of that rule is that you cannot draw a new block on top of an
      // old one — reshaping the thing under your fingers is the far commoner
      // intent, and the alternative (a modifier pose) is worse.
      const target = this._blockUnder(wa, wb);
      if (target) this._startResize(target, wa, wb);
      else if (!this.rearming) this._startDraft(a.pinchPoint, b.pinchPoint);
    }

    if (this.resize) {
      this._applyResize(wa, wb);
      this._armCrush(a, b);
    }
    else if (this.draft) {
      this.draft.setCorners(wa, wb, {
        minSize: TUNING.box.minSize, depthRatio: TUNING.box.depthRatio,
      });
    }
  }

  /** Smallest block whose face both pinches are on. Smallest, so that a pinch
   *  inside a big block that also holds a small one picks the small one. */
  _blockUnder(wa, wb) {
    const m = TUNING.box.grabMargin;
    return this.blocks
      .filter((blk) => blk.contains(wa, m) && blk.contains(wb, m))
      .sort((p, q) => p.rect.w * p.rect.h - q.rect.w * q.rect.h)[0] ?? null;
  }

  _startDraft(pa, pb) {
    const gap = Math.hypot(pa.x - pb.x, pa.y - pb.y);
    if (gap > TUNING.box.spawnGap) return;   // hands not brought together yet
    this.draft = new Block({ ghost: true, kind: this.shape, theme: this.theme });
    this.scene.add(this.draft.group);
    this._emit("draft");
  }

  /**
   * Remember where on the block each pinch landed, as a fraction of the block's
   * own width and height. Reshaping then keeps those two spots under those two
   * fingertips — so grabbing anywhere works and the block does not jump to meet
   * your fingers the instant you touch it.
   */
  _startResize(block, wa, wb) {
    const r = block.rect;
    const w = Math.max(r.w, 1e-6), h = Math.max(r.h, 1e-6);
    // Fractions are taken in the BLOCK's frame, not the world's, so a block you
    // have spun still stretches along its own edges. `toLocal` puts the origin
    // at the centre, so the near edge sits at -w/2 rather than at rect.minX.
    // With no rotation this is arithmetically the same numbers as before.
    const la = block.toLocal(wa), lb = block.toLocal(wb);
    this.resize = {
      block, w, h,
      gap: null, maxGap: 0, startGap: null, nearFrames: 0, tinyFrames: 0, armed: false,
      ua: (la.x + w / 2) / w, va: (la.y + h / 2) / h,
      ub: (lb.x + w / 2) / w, vb: (lb.y + h / 2) / h,
    };
    block.setState("held");
    this._emit("grab");
  }

  _applyResize(wa, wb) {
    const R = this.resize;
    const la = R.block.toLocal(wa), lb = R.block.toLocal(wb);
    const x = solveAxis(R.ua, R.ub, la.x, lb.x, R.w);
    const y = solveAxis(R.va, R.vb, la.y, lb.y, R.h);
    // The local frame is re-read from the block's current centre each frame,
    // and setLocalRect adds that same centre back on — the two cancel, so this
    // does not feed its own output back in and drift.
    R.block.setLocalRect(x.min, y.min, x.size, y.size, {
      minSize: TUNING.box.minSize, depthRatio: TUNING.box.depthRatio,
    });
  }

  /** Two pinches ended: commit a draft, or let go of a resized block. */
  _endPinchWork() {
    if (this.resize) {
      const { block, armed } = this.resize;
      this.resize = null;
      this.holdLock = true;
      if (armed) this._remove(block);
      else {
        block.setState("idle");
        this._snap(block);
        this._emit("drop");
      }
    }
    if (this.draft) this._commit();   // sets `rearming`, which also blocks a hold
  }

  /** Turn the draft into a kept block, or discard it if it never grew. */
  _commit() {
    const draft = this.draft;
    this.rearming = true;

    const { w, h } = draft.size ?? { w: 0, h: 0 };
    if (Math.max(w, h) < TUNING.box.minCommit) return this._discardDraft();
    this.draft = null;

    // Rebuild as a solid block at the draft's final transform. Cheaper in code
    // than mutating a dozen material fields, and keeps ghost/solid styling in
    // one place (the Block constructor).
    const solid = new Block({ kind: draft.kind, theme: this.theme });
    solid.group.position.copy(draft.group.position);
    solid.group.scale.copy(draft.group.scale);
    solid.size = draft.size;

    this.scene.remove(draft.group);
    draft.dispose();
    this.scene.add(solid.group);
    this.blocks.push(solid);
    this._snap(solid);
    this._record({ kind: "add", id: solid.id });
    this._emit("commit");
  }

  /** Throw away the in-progress ghost without keeping anything. */
  _discardDraft() {
    if (!this.draft) return;
    this.scene.remove(this.draft.group);
    this.draft.dispose();
    this.draft = null;
  }

  // ---- one hand, one block: carry it, turn it, or throw it away -----------

  /**
   * One hand on a block picks up THAT block, alone, and the pose it lands with
   * says what for: a FIST carries it, a PINCH turns it. Opening the hand puts
   * it down.
   *
   * The same hand can switch between the two mid-hold, and the hold survives
   * the transitions between them (POSE.NONE): closing a pinch into a fist
   * passes through a shape that is neither, and dropping the block there would
   * make the switch unreachable.
   */
  _startHold(hand, mode) {
    // Not straight after two-handed work — the leftover hand is still sitting
    // on the block it was drawing or resizing.
    if (this.rearming || this.holdLock) return;
    const pt = mode === "move" ? hand.palmPoint : hand.pinchPoint;
    const p = this.scene.toWorld(pt.x, pt.y);
    // `_blockUnder` wants two points; one hand is both of them. That reuses
    // the same catch margin and the same smallest-block-wins rule as a resize,
    // so what you can pick up is exactly what you can reshape.
    const block = this._blockUnder(p, p);
    if (!block) return;
    this.hold = { block, handedness: hand.handedness, doomed: false };
    this._rebase(mode, p, hand.handedness);
    this._emit("grab");
  }

  /**
   * The held block's frame, run before any other gesture. Clears `this.hold`
   * when the hold ends.
   *
   * Only the hand that picked the block up steers it. The other hand is free,
   * with two exceptions that hand the block over: a second pinch makes it a
   * resize, and a second fist beside a carrying fist makes it the two-fist
   * scene grab — both hands rarely close on the same frame, so the first fist
   * often lands on a block on its way to grabbing everything.
   */
  _holdFrame(hands) {
    const H = this.hold;
    const owner = hands.find((h) => h.handedness === H.handedness);

    // Hand gone for longer than the grace window. Put the block down where it
    // is — NOT a delete unless some hand is plainly open. See `_endHold`.
    if (!owner) return this._endHold(hands.some((h) => h.pose === POSE.OPEN));
    if (owner.pose === POSE.OPEN) return this._endHold(true);

    // Quiet handovers: whatever takes over makes its own sound, and a drop
    // between two grabs is noise. No snap either — the block is still in hand.
    const secondFist = hands.some((h) => h !== owner && h.pose === POSE.FIST && h.palmPoint);
    if (owner.pose === POSE.FIST && secondFist) return this._endHold(false, { handover: true });
    if (hands.filter((h) => h.pose === POSE.PINCH && h.pinchPoint).length >= 2) {
      return this._endHold(false, { handover: true });
    }

    if (owner.pose === POSE.FIST && owner.palmPoint) {
      const p = this.scene.toWorld(owner.palmPoint.x, owner.palmPoint.y);
      if (H.mode !== "move") this._rebase("move", p, owner.handedness);
      this._moveFrame(p);
    } else if (owner.pose === POSE.PINCH && owner.pinchPoint) {
      const p = this.scene.toWorld(owner.pinchPoint.x, owner.pinchPoint.y);
      if (H.mode !== "turn") this._rebase("turn", p, owner.handedness);
      this._turnFrame(p);
    } else {
      // Mid-transition between poses. Keep the block, but sit still: the hand
      // is halfway between shapes and neither tracking point means anything.
      return;
    }
    this._markDoomed();
  }

  /** (Re)set the hold's reference frame for a mode, so nothing jumps. */
  _rebase(mode, p, tracking) {
    const H = this.hold, c = H.block.mesh.position;
    H.mode = mode;
    H.tracking = tracking;
    H.frames = 0;
    H.live = false;
    // Carrying: see `_moveFrame`.
    H.slack = 0;
    H.origin = { x: c.x, y: c.y };             // where the block started
    H.offset = { x: c.x - p.x, y: c.y - p.y }; // hand -> block, held fixed
    // Turning: see `_turnFrame`.
    H.start = { x: p.x, y: p.y };              // where the motion began
    H.seg = { x: p.x, y: p.y };                // start of the current segment
    H.heading = null;                          // direction of the last segment
    H.path = 0;                                // travel so far
    H.bend = 0;                                // swing of direction before the lock
    H.prevAng = null;                          // last angle of the pinch about the centre
    H.orbit = 0;                               // total swing of that angle
    H.orbitSlack = 0;                          // pre-lock swing, taken back gradually
    H.shown = 0;                               // turn actually applied
    H.axis = null;
    H.lockAt = null;
    H.q0 = null;
  }

  /**
   * The block follows the hand, keeping the exact spot you grabbed under your
   * fingertip — that is all `offset` is. Movement is in the build plane only,
   * for the same reason a drawn block's depth is not read from the hand:
   * fingertip z is far too noisy to drive a dimension you can see.
   */
  _moveFrame(p) {
    const H = this.hold;
    const want = { x: p.x + H.offset.x, y: p.y + H.offset.y };
    const dx = want.x - H.origin.x, dy = want.y - H.origin.y;
    const dist = Math.hypot(dx, dy);
    if (!this._engaged(dist, TUNING.hold.moveDeadZone)) return;

    // Hold the dead zone back as an offset along the direction of travel, then
    // decay it: the block starts from where it was instead of snapping by the
    // whole threshold, and within a few frames your grip is exact rather than
    // trailing by a fixed distance for the whole drag.
    H.slack *= TUNING.hold.slackDecay;
    const k = H.slack / Math.max(dist, 1e-6);
    H.block.mesh.position.x = want.x - dx * k;
    H.block.mesh.position.y = want.y - dy * k;
  }

  /**
   * A pinch turns the block about a WORLD axis, picked by the hand's first
   * clear motion and locked until the pinch lets go:
   *
   *   straight up/down      ->  x: tilts it toward or away from you
   *   straight left/right   ->  y: spins it like a turntable
   *   curving               ->  z: steers it like a wheel
   *
   * Locked because a circle is made of up, down, left and right: read all three
   * at once and every steer would wobble the block on the other two. Nothing
   * turns until the hand has travelled `turnLock`, which is also the dead zone
   * that lets one pinch become the first half of a two-pinch resize without
   * the block turning while the second hand arrives.
   *
   * "Curving" is how far the direction of travel has swung by then (`bend`),
   * read over short segments so tracker jitter cannot fake a curve.
   *
   * Steering is a wheel gripped where you pinched: the turn is how far the
   * angle from the block's centre to your fingertip has swung (`orbit`), so the
   * spot you pinched follows your fingertip round, degree for degree, and winds
   * past a full turn either way. That swing is tracked from the first settled
   * frame, but the part spent reaching the lock is held back as slack and
   * decayed away, like the carry's dead zone: no jump at the lock, and within
   * a few frames the grip is exact.
   *
   * Where `tilt` is off, every lock is a steer.
   */
  _turnFrame(p) {
    const H = this.hold, T = TUNING.hold, c = H.block.mesh.position;
    const rx = p.x - c.x, ry = p.y - c.y, ang = Math.atan2(ry, rx);
    if (++H.frames <= T.confirmFrames) {
      // The pose is still settling; the motion starts from where it settles.
      H.start = { x: p.x, y: p.y };
      H.seg = { x: p.x, y: p.y };
      H.prevAng = ang;
      return;
    }

    // Near the centre the angle is mostly noise. `prevAng` still tracks it, so
    // coming out the far side does not read as a sudden half-turn; the noise
    // just never reaches the block.
    if (H.prevAng != null && Math.hypot(rx, ry) >= T.minRadius) {
      H.orbit += wrapPi(ang - H.prevAng);
    }
    H.prevAng = ang;

    const sx = p.x - H.seg.x, sy = p.y - H.seg.y, len = Math.hypot(sx, sy);
    if (len >= T.turnSegment && !H.axis) {
      const heading = Math.atan2(sy, sx);
      H.bend += H.heading == null ? 0 : wrapPi(heading - H.heading);
      H.heading = heading;
      H.seg = { x: p.x, y: p.y };
      H.path += len;
    }

    if (!H.axis) {
      if (H.path < T.turnLock) return;
      const dx = p.x - H.start.x, dy = p.y - H.start.y;
      H.axis = !this.tiltOn() || Math.abs(H.bend) >= T.curveRad ? "z"
             : Math.abs(dy) >= Math.abs(dx) ? "x" : "y";
      H.lockAt = { x: p.x, y: p.y };
      H.orbitSlack = H.orbit;
      H.q0 = H.block.mesh.quaternion.clone();
      H.live = true;
    }

    if (H.axis === "z") {
      H.orbitSlack *= T.slackDecay;
      H.shown = H.orbit - H.orbitSlack;
    } else {
      // Signs make the front face follow the hand: up rolls it upward (the top
      // tips away), right swings it to face right.
      const target = H.axis === "x" ? -(p.y - H.lockAt.y) * T.tiltPerUnit
                   : (p.x - H.lockAt.x) * T.tiltPerUnit;
      H.shown += (target - H.shown) * T.turnEase;
    }
    H.block.turnWorld(AXIS[H.axis], H.shown, H.q0);
  }

  /** Shared gate for both modes: enough frames in this pose, and enough travel
   *  to mean it. Arms `slack` with the dead zone it just spent. */
  _engaged(magnitude, deadZone) {
    const H = this.hold;
    H.frames++;
    if (H.live) return true;
    if (H.frames < TUNING.hold.confirmFrames) return false;
    if (magnitude < deadZone) return false;
    H.slack = deadZone;
    H.live = true;
    return true;
  }

  /** Red while the block is far enough into the margin that letting go would
   *  delete it. Live feedback rather than an armed state, because unlike the
   *  wipe this one is undone simply by carrying the block back inside. */
  _markDoomed() {
    const H = this.hold;
    const was = H.doomed;
    H.doomed = this.scene.edgeDistance(H.block.mesh.position) < TUNING.hold.edgeMargin;
    if (H.doomed && !was) this._emit("arm");
    H.block.setState(H.doomed ? "doomed" : H.live ? "held" : "idle");
  }

  /**
   * @param {boolean} deliberate the hand OPENED, rather than the tracker
   *   losing it. Deleting is irreversible, so only a deliberate release can do
   *   it: dropouts are constant (see `graceMs`), and one at the edge of the
   *   frame would otherwise silently eat the block. The cost is that flinging
   *   a block off-screen leaves it parked at the edge instead of deleting it,
   *   since your hand leaves the frame before it can open.
   */
  _endHold(deliberate, { handover = false } = {}) {
    const H = this.hold;
    this.hold = null;
    // One block per grab. Open your hand fully to take another, so a hold that
    // ended because a second hand arrived cannot restart when it leaves.
    this.holdLock = true;
    if (deliberate && H.doomed) return this._remove(H.block);
    H.block.setState("idle");
    if (handover) return;
    this._snap(H.block);
    this._emit("drop");
  }

  // ---- fists: move and zoom ----------------------------------------------

  _grabbing(fists, hands = fists) {
    // A hand held through a tracking dropout has FROZEN coordinates. Moving the
    // scene from them would translate and zoom using a position that is no
    // longer true — the grab survives the dropout, but the motion pauses until
    // the hand is really seen again.
    //
    // The wipe still counts, though: fists touching is exactly when the tracker
    // drops one, and the frozen position is where it last really was — touching.
    if (fists.some((f) => f.stale)) {
      if (this.grab) {
        this._armWipe(this._wipePair(fists, hands));
        this._markGrabDoom();
      }
      return;
    }

    const anchor = this._anchor(fists);
    const span = this._span(fists);

    if (!this.grab || this.grab.hands !== fists.length) {
      if (!this.grab && this.blocks.length) this._emit("grab");
      // One fist and two fists are different transforms; re-baseline on every
      // change, or bringing up a second hand would snap the scene.
      this._baseline(anchor, span, fists.length);
    } else if (this.grab.settle > 0) {
      // Still settling. Keep re-baselining so a hand that is still on its way
      // into position cannot drag everything along with it.
      this.grab.settle--;
      this.grab.anchor = anchor;
      this.grab.span = span;
      this.grab.scale = 1;
      this.grab.steer = 0;
      this.grab.wheel = null;
      this.grab.order = null;
      this._recordOrigins();
    }

    const s = this._scale(span);
    const rot = this._steer(fists);
    for (let i = 0; i < this.blocks.length; i++) {
      const origin = this.grab.origins[i];
      if (origin) this.blocks[i].transformAbout(origin, this.grab.anchor, anchor, s, rot);
    }

    this._armWipe(this._wipePair(fists, hands));
    this._markGrabDoom();
  }

  /**
   * Scale from how much FURTHER APART the fists are than at the baseline — a
   * difference, not a ratio. See TUNING.zoom.doublePerUnits for why: a ratio
   * divides by the starting separation and a small one sends the scene to a
   * clamp.
   */
  _scale(span) {
    const g = this.grab;
    if (span == null || g.span == null) { g.scale = 1; return 1; }

    const target = clamp(
      2 ** ((span - g.span) / TUNING.zoom.doublePerUnits),
      TUNING.zoom.min, TUNING.zoom.max,
    );
    // Ease toward it, so nothing that jolts the measured span in one frame can
    // arrive as an instant jump.
    const step = 1 + TUNING.zoom.maxStepPerFrame;
    g.scale = clamp(target, g.scale / step, g.scale * step);
    return g.scale;
  }

  _baseline(anchor, span, hands) {
    const armed = this.grab?.armed ?? false;
    const edge = this.grab?.edge ?? false;
    this.grab = {
      anchor, span, hands, armed, edge,
      scale: 1,
      settle: TUNING.grab.settleFrames,
      steer: 0,          // total turn of the wheel since this grab began
      wheel: null,       // last angle of the line between the fists
      // Which hand is on which end of the wheel, fixed for the life of the
      // grab. Deciding it per frame from whoever is currently left would flip
      // the sign the moment your hands crossed, or the tracker relabelled one.
      order: null,
      gap: this.grab?.gap ?? null,
      maxGap: this.grab?.maxGap ?? 0,
      nearFrames: this.grab?.nearFrames ?? 0,
      touch: this.grab?.touch ?? TUNING.wipe.gap,
      origins: [],
    };
    this._recordOrigins();
    for (const b of this.blocks) b.setState(armed || edge ? "doomed" : "held");
  }

  /** Freeze where every block is right now; the transform is relative to this. */
  _recordOrigins() {
    this.grab.origins = this.blocks.map((b) => ({
      position: b.group.position.clone(),
      scale: b.group.scale.clone(),
      // Each block's OWN orientation, so steering adds to it instead of
      // erasing it — including any tilt it was given in freestyle.
      angle: b.angle,
      quaternion: b.mesh.quaternion.clone(),
    }));
  }

  /**
   * Two fists as a steering wheel: the angle of the line between them turns
   * the whole scene about the same midpoint it is already moving and scaling
   * about. Right fist up and left fist down turns it anticlockwise, exactly as
   * a wheel would.
   *
   * The ends of the wheel are pinned to specific hands at the start of the
   * grab, by which one is on the left THEN. Working it out per frame from
   * whoever is currently leftmost would flip the sign the instant your hands
   * crossed — the scene would snap half a turn at the moment you were steering
   * hardest.
   *
   * Like every other angle here the turn is accumulated per frame rather than
   * measured from the start, so the wheel winds past a full turn in either
   * direction instead of folding over at ±180°.
   */
  _steer(fists) {
    const g = this.grab;
    if (fists.length < 2) return g.steer;

    if (!g.order) {
      const [p, q] = fists.map((f) => this.scene.toWorld(f.palmPoint.x, f.palmPoint.y));
      g.order = p.x <= q.x ? [fists[0].handedness, fists[1].handedness]
                           : [fists[1].handedness, fists[0].handedness];
    }
    const left = fists.find((f) => f.handedness === g.order[0]);
    const right = fists.find((f) => f.handedness === g.order[1]);
    if (!left || !right) return g.steer;

    const a = this.scene.toWorld(left.palmPoint.x, left.palmPoint.y);
    const b = this.scene.toWorld(right.palmPoint.x, right.palmPoint.y);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const step = g.wheel == null ? 0 : wrapPi(angle - g.wheel);
    g.wheel = angle;

    // Fists too close together: the line between them is noise. Keep tracking
    // the angle so re-separating does not read as a sudden lurch, but do not
    // let that noise reach the scene.
    if (Math.hypot(b.x - a.x, b.y - a.y) >= TUNING.grab.steerMinSpan) g.steer += step;
    return g.steer;
  }

  /** Midpoint of the fists, in world space on the build plane. */
  _anchor(fists) {
    let x = 0, y = 0;
    for (const f of fists) { x += f.palmPoint.x; y += f.palmPoint.y; }
    return this.scene.toWorld(x / fists.length, y / fists.length);
  }

  /** World distance between two fists — the zoom handle. Null for one fist. */
  _span(fists) {
    if (fists.length < 2) return null;
    const a = this.scene.toWorld(fists[0].palmPoint.x, fists[0].palmPoint.y);
    const b = this.scene.toWorld(fists[1].palmPoint.x, fists[1].palmPoint.y);
    return Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1e-6);
  }

  /**
   * Squeeze the block you are resizing down to nothing and letting go deletes
   * it — the wipe's bargain, applied to one block instead of the scene.
   *
   * Deliberately the RAW pinch points, not the smoothed ones the resize itself
   * is driven from. Smoothing exists to stop a rendered corner from jittering;
   * a proximity test is a discrete decision, and inheriting the filter's lag
   * armed the wipe a beat late — after the hands had already opened.
   */
  _armCrush(a, b) {
    const R = this.resize;
    const pa = a.metrics?.pinchPoint ?? a.pinchPoint;
    const pb = b.metrics?.pinchPoint ?? b.pinchPoint;
    const gap = Math.hypot(pa.x - pb.x, pa.y - pb.y);
    R.gap = gap;
    R.maxGap = Math.max(R.maxGap, gap);
    if (R.startGap == null) R.startGap = gap;

    if (R.armed) {
      if (gap <= TUNING.crush.disarm) return;
      R.armed = false;
      R.nearFrames = 0;
      R.block.setState("held");
      return;
    }

    // A single dropped frame at this range is ordinary — the two hands are
    // nearly touching, which is the tracker's worst case — so a near-miss
    // costs one frame of progress rather than all of it. A genuine pull-apart
    // still unwinds the count in a few frames.
    R.nearFrames = gap <= TUNING.crush.gap
      ? R.nearFrames + 1
      : Math.max(0, R.nearFrames - 1);

    // The block cannot get any smaller. Squeezing past that point has no other
    // possible meaning, and it is the state people actually end up in when
    // they try to crush something: a tiny block that would not die.
    const size = R.block.size ?? { w: Infinity, h: Infinity };
    const bottomed = Math.max(size.w, size.h) <= TUNING.box.minSize * 1.05;
    R.tinyFrames = bottomed ? R.tinyFrames + 1 : 0;

    // Seen apart first, then held together — the same two preconditions as the
    // wipe. `shrinkTo` is the second way to satisfy the first one, for hands
    // that were already close when they landed on a small block.
    const cameApart = R.maxGap >= TUNING.crush.armFrom
      || gap <= R.startGap * TUNING.crush.shrinkTo;
    const squeezed = R.nearFrames >= TUNING.crush.confirmFrames
      || R.tinyFrames >= TUNING.crush.tinyFrames;
    if (!cameApart || !squeezed) return;

    R.armed = true;
    R.block.setState("doomed");
    this._emit("arm");
  }

  /**
   * Two fists seen apart and then brought together to touching arms the wipe;
   * separating again disarms it. Reversibility matters now that two fists also
   * zoom — you pass through "fists close" on every shrink, so a one-way arm
   * would turn ordinary zooming into a scene deleted the moment you opened up.
   */
  _armWipe(pair) {
    // Do NOT reset progress when a hand goes missing. Two hands held close
    // together is one of the tracker's worst cases, so the frame where the
    // fists finally touch is exactly the frame most likely to drop one of
    // them — zeroing here made the last step the least likely to complete.
    if (pair.length < 2) return;
    const g = this.grab, W = TUNING.wipe;

    // Deliberately the RAW palm points, not the smoothed ones used for the
    // grab anchor. Smoothing exists to stop a rendered cursor from jittering;
    // a proximity test is a discrete decision, and inheriting the filter's lag
    // meant the wipe armed a beat late — after the hands had already opened.
    const pa = pair[0].metrics?.palmPoint ?? pair[0].palmPoint;
    const pb = pair[1].metrics?.palmPoint ?? pair[1].palmPoint;
    const gap = Math.hypot(pa.x - pb.x, pa.y - pb.y);

    // "Touching" in image distance depends on how far you stand from the
    // camera: close up, touching fists have their palm centres well past any
    // fixed number. So the thresholds grow with the size of the hands.
    const scale = ((pair[0].metrics?.scale ?? 0) + (pair[1].metrics?.scale ?? 0)) / 2;
    const touch = Math.max(W.gap, W.gapPerScale * scale);
    const release = Math.max(W.disarm, W.disarmPerScale * scale);
    g.gap = gap;
    g.touch = touch;
    g.maxGap = Math.max(g.maxGap, gap);

    if (g.armed) {
      if (gap <= release) return;
      g.armed = false;
      g.nearFrames = 0;
      return;
    }

    // A dropped or jittery frame this close together is ordinary, so a
    // near-miss costs one frame of progress rather than all of it.
    g.nearFrames = gap <= touch ? g.nearFrames + 1 : Math.max(0, g.nearFrames - 1);
    // Seen apart first — but only clearly further than touching, not the
    // full `armFrom`. Grabbing with the fists already fairly close and pushing
    // them together is the commonest way to do this, and it never got there.
    if (g.maxGap < Math.min(W.armFrom, touch * W.apartRatio)) return;
    if (g.nearFrames < W.confirmFrames) return;

    g.armed = true;
    this._emit("arm");
  }

  /**
   * The two hands to measure the wipe between. Normally the two fists; but
   * when one fist is lost into a shape that is neither (fists pressed together
   * hide each other's fingers), the hand still tracked there counts too. An
   * open hand or a pinch never does — those are someone letting go.
   */
  _wipePair(fists, hands) {
    if (fists.length >= 2) return fists;
    return hands
      .filter((h) => h.palmPoint && (h.pose === POSE.FIST || h.pose === POSE.NONE))
      .slice(0, 2);
  }

  /**
   * Whole-scene version of carrying one block off the edge: while everything
   * is grabbed, the middle of all the blocks sitting in the edge margin turns
   * them all red, and opening the hands there deletes them. The middle rather
   * than any one block, so zooming in — which pushes outlying blocks off-screen
   * — cannot condemn them.
   */
  _markGrabDoom() {
    const g = this.grab;
    const was = g.edge;
    if (this.blocks.length) {
      let x = 0, y = 0;
      for (const b of this.blocks) { x += b.mesh.position.x; y += b.mesh.position.y; }
      const n = this.blocks.length;
      g.edge = this.scene.edgeDistance({ x: x / n, y: y / n }) < TUNING.hold.edgeMargin;
    } else {
      g.edge = false;
    }
    if (g.edge && !was && !g.armed) this._emit("arm");
    const state = g.armed || g.edge ? "doomed" : "held";
    for (const b of this.blocks) b.setState(state);
  }

  /**
   * Every fist opened: drop the blocks where they are, or wipe them.
   * @param {boolean} deliberate a hand OPENED, rather than the tracker losing
   *   them. The edge delete needs it, for the same reason as `_endHold`'s: hands
   *   carried to the edge of the frame leave it, and that must not eat a scene.
   */
  _releaseGrab(deliberate = false) {
    const { armed, edge } = this.grab;
    this.grab = null;
    if (armed || (edge && deliberate)) {
      if (this.blocks.length) this._emit("wipe");
      this.clear();
      return;
    }
    for (const b of this.blocks) {
      b.setState("idle");
      this._snap(b);
    }
    if (this.blocks.length) this._emit("drop");
  }

  // ---- grid snap ---------------------------------------------------------

  /**
   * Settle a block onto the grid: size to whole cells, angle to the nearest
   * `TUNING.snap.angleDeg`, and its outline's left and bottom edges onto grid
   * lines. Called only on release — see TUNING.snap.
   *
   * The edges placed are those of the box AROUND the block, measured along the
   * world axes. For an unturned (or quarter-turned) block that is its own
   * outline; for a tilted one it at least puts neighbouring tilted blocks on
   * the same lines, which is what stacking needs.
   */
  _snap(block) {
    if (!this.snapOn()) return;
    const step = this.scene.planeH / TUNING.snap.cells;
    const m = block.mesh;

    const w = Math.max(step, Math.round(m.scale.x / step) * step);
    const h = Math.max(step, Math.round(m.scale.y / step) * step);
    const d = Math.max(((w + h) / 2) * TUNING.box.depthRatio, TUNING.box.minSize);
    const q = (TUNING.snap.angleDeg * Math.PI) / 180;
    // A block tilted out of the plane (freestyle) keeps its orientation: the
    // angle grid only means anything for a block facing the camera.
    const flat = Math.abs(m.rotation.x) < 1e-6 && Math.abs(m.rotation.y) < 1e-6;
    const angle = flat ? Math.round(m.rotation.z / q) * q : 0;

    const c = Math.abs(Math.cos(angle)), s = Math.abs(Math.sin(angle));
    const hx = (w * c + h * s) / 2, hy = (w * s + h * c) / 2;
    const x = Math.round((m.position.x - hx) / step) * step + hx;
    const y = Math.round((m.position.y - hy) / step) * step + hy;

    m.scale.set(w, h, d);
    if (flat) m.rotation.z = angle;
    m.position.set(x, y, -d / 2);
    block.size = { w, h, d };

    // Rounding can nudge a block half a cell over the divider. Push it back a
    // whole cell at a time rather than letting the zone rule delete it.
    if (this.zone) {
      const dir = this.zone === "left" ? -1 : 1;
      for (let i = 0; i < 4 && this._overshoot(block, dir) > 1e-6; i++) m.position.x += dir * step;
    }
  }

  _emit(type) {
    try { this.onEvent?.(type); } catch { /* feedback must never break building */ }
  }

  // ---- editing -----------------------------------------------------------

  /** Remove one block, wherever it sits, and let go of every reference to it.
   *  Carrying a block off the edge deletes it out of the middle of the list,
   *  so this cannot be the old pop-the-tail. */
  _remove(block, { record = true } = {}) {
    const i = this.blocks.indexOf(block);
    if (i < 0) return;
    if (record) {
      this._record({ kind: "remove", specs: [this._spec(block, i)] });
      this._emit("remove");
    }
    this.blocks.splice(i, 1);
    this.scene.remove(block.group);
    block.dispose();
    // Origins are indexed in step with `blocks`; drop the same slot to match.
    this.grab?.origins.splice(i, 1);
    if (this.resize?.block === block) this.resize = null;
    if (this.hold?.block === block) this.hold = null;
  }

  // ---- the divider -------------------------------------------------------

  /**
   * Keeps every block this builder owns on its own side of the screen.
   *
   * The divider is the middle of the build plane, which is world x = 0 (see
   * Scene.toWorld — the plane is centred on the camera axis), so "my side" is
   * one sign of x and nothing else has to be measured.
   *
   * Two bands, because a block that simply vanished the instant it touched an
   * invisible line would read as a bug:
   *
   *   within `warn` of the line   -> turns red. You are about to lose it.
   *   actually across it          -> destroyed, wherever it came from.
   *
   * Deliberately applied to blocks BEING drawn and carried as well as to
   * settled ones: the case this exists for is somebody drawing one enormous
   * shape and shoving it into the opponent's half, and waiting for release
   * would let that shape sit there covering their board in the meantime.
   */
  _enforceZone() {
    const dir = this.zone === "left" ? -1 : 1;   // the side x is allowed to be
    const { grace, warn } = TUNING.zone;

    // The draft is a ghost: it has no colour states to warn with, so it is only
    // ever destroyed, and only once it is properly across.
    if (this.draft && this._overshoot(this.draft, dir) > grace) this._discardDraft();

    for (const block of [...this.blocks]) {
      const over = this._overshoot(block, dir);
      if (over > grace) { this._remove(block); continue; }
      // Never argue with a doom the gestures themselves set (a crush, a carry
      // to the edge, an armed wipe): that one is about to happen anyway.
      if (this._doomedByGesture(block)) continue;
      block.setState(over > -warn ? "doomed" : this._restingState(block));
    }
  }

  /**
   * How far a block reaches past the divider, in world units. Negative while it
   * is entirely on its own side.
   *
   * The half-width is the block's extent along the WORLD x axis, which for a
   * spun block is not its own width — a square turned 45 degrees reaches
   * further sideways than its edge is long. Same projection three.js would use
   * for a bounding box, done in 2D because everything lives on one plane.
   */
  _overshoot(block, dir) {
    const s = block.mesh.scale, a = block.mesh.rotation.z;
    const halfX = (Math.abs(s.x * Math.cos(a)) + Math.abs(s.y * Math.sin(a))) / 2;
    // Signed distance from the divider to the block's leading edge, positive
    // once that edge is on the wrong side.
    return -dir * block.mesh.position.x + halfX;
  }

  /** True while some other rule has already condemned this block. */
  _doomedByGesture(block) {
    return (this.hold?.block === block && this.hold.doomed)
        || (this.resize?.block === block && this.resize.armed)
        || !!this.grab?.armed
        || !!this.grab?.edge;
  }

  /** What a block should look like when the divider has no opinion about it. */
  _restingState(block) {
    return (this.hold?.block === block || this.resize?.block === block) ? "held" : "idle";
  }

  // ---- history -----------------------------------------------------------
  //
  // Undo covers what blocks EXIST: every block made, and every block destroyed
  // — crushed, carried off the edge, or wiped. It deliberately does not cover
  // moving, turning or resizing: those are continuous, you can see the result
  // while you do it, and the way to take one back is to do it again. A delete
  // is the opposite on both counts, which is exactly why it needs an undo.

  /** Enough to rebuild a block exactly as it was, after its mesh is gone. */
  _spec(block, index) {
    const m = block.mesh;
    return {
      id: block.id,
      index,
      kind: block.kind,
      position: m.position.clone(),
      scale: m.scale.clone(),
      quaternion: m.quaternion.clone(),
      size: block.size ? { ...block.size } : null,
    };
  }

  /** Put a block back where it was, keeping its identity so any older history
   *  entry that refers to it still finds it. */
  _restore(spec) {
    const block = new Block({ kind: spec.kind, theme: this.theme });
    block.id = spec.id;
    block.mesh.position.copy(spec.position);
    block.mesh.scale.copy(spec.scale);
    block.mesh.quaternion.copy(spec.quaternion);
    if (spec.size) block.size = { ...spec.size };
    this.scene.add(block.group);
    // Back at its old index, so undoing a wipe returns the scene in order
    // rather than reversed.
    this.blocks.splice(Math.min(spec.index, this.blocks.length), 0, block);
    // A grab in progress indexes its origins in step with `blocks`, and a block
    // appearing in the middle shifts every one of them out of alignment.
    // Re-freezing where everything is now costs the grab nothing: the
    // transform is relative to those origins either way.
    if (this.grab) this._recordOrigins();
    return block;
  }

  _record(op) {
    this.history.push(op);
    // Bounded, because the history holds geometry specs and a long session
    // would otherwise grow one forever.
    if (this.history.length > 100) this.history.shift();
  }

  /**
   * Take back the last thing that happened.
   *
   * Entries can go stale — an `add` whose block was deleted later has already
   * been undone by that delete — so this walks back until it finds one that
   * still means something rather than doing nothing and looking broken.
   */
  undo() {
    while (this.history.length) {
      const op = this.history.pop();

      if (op.kind === "add") {
        const block = this.blocks.find((b) => b.id === op.id);
        if (!block) continue;                    // already gone; keep looking
        this._remove(block, { record: false });
        return true;
      }

      for (const spec of op.specs) this._restore(spec);
      return true;
    }
    return false;
  }

  clear() {
    // The draft too, not just the committed blocks — otherwise clearing while
    // mid-pull leaves the ghost alive in the scene and it commits itself as a
    // surprise extra block the moment you open your hands.
    this._discardDraft();
    this.resize = null;
    this.hold = null;
    if (!this.blocks.length) return;

    // ONE history entry for the whole wipe, so undoing it brings everything
    // back at once. Wiping is a single act; taking it back block by block
    // would be a punishment for using it.
    const specs = this.blocks.map((b, i) => this._spec(b, i));
    this._record({ kind: "remove", specs });
    for (const block of [...this.blocks]) this._remove(block, { record: false });
  }

  // ---- HUD ---------------------------------------------------------------

  /** Anything at all under way. The shape picker sits out while this is
   *  true, so a dwell cannot land mid-build. */
  get busy() {
    return !!(this.grab || this.hold || this.resize || this.draft);
  }

  /** What the hands are currently doing to the scene. */
  get status() {
    if (this.grab?.armed) return "WIPE — open to delete";
    if (this.grab?.edge) return "at the edge — open to DELETE ALL, carry back to keep";
    if (this.grab) {
      const deg = (this.grab.steer * 180) / Math.PI;
      const zoom = this.grab.hands >= 2
        ? (Math.abs(deg) >= 1 ? ` (zoom · steer ${deg.toFixed(0)}°)` : " (zoom)")
        : "";
      return `holding ${this.blocks.length}${zoom}`;
    }
    if (this.hold) return this._holdStatus();
    if (this.resize?.armed) return "CRUSHED — let go to delete";
    if (this.resize) {
      const g = this.resize;
      return g.maxGap < TUNING.crush.armFrom
        ? "resizing"
        : `resizing · gap ${g.gap.toFixed(2)} (squeeze to ${TUNING.crush.gap} to delete)`;
    }
    if (this.draft) return "drawing";
    return null;
  }

  /** What the one held block is doing. The delete warning outranks the rest:
   *  it is the only part of this that cannot be undone. */
  _holdStatus() {
    const H = this.hold;
    if (H.doomed) return "at the edge — open to DELETE, carry back to keep";
    if (H.mode === "turn") {
      if (!H.axis) return "pinching — move to turn";
      const verb = { x: "tilting", y: "spinning", z: "steering" }[H.axis];
      return `${verb} ${((H.shown * 180) / Math.PI).toFixed(0)}°`;
    }
    if (!H.live) return "holding — move to carry";
    return "carrying a block";
  }

  /**
   * Why the wipe has or has not armed. A gesture with two preconditions fails
   * silently otherwise — you cannot tell "never got far enough apart" from
   * "never got close enough" without seeing the numbers.
   */
  get wipeState() {
    if (!this.grab || this.grab.gap == null || this.grab.hands < 2) return null;
    const { gap, maxGap, armed, edge, touch } = this.grab;
    if (armed) return "ARMED — open to delete, separate to cancel";
    if (edge) return null;   // `status` says it
    const apart = Math.min(TUNING.wipe.armFrom, touch * TUNING.wipe.apartRatio);
    if (maxGap < apart) {
      return `apart ${maxGap.toFixed(2)}/${apart.toFixed(2)} — spread fists first`;
    }
    return `zoom · gap ${gap.toFixed(2)} (touch at ${touch.toFixed(2)} to wipe)`;
  }
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** Fold an angle into (-π, π]. Applied to the per-frame STEP, which is what
 *  lets the running total wind past a full turn without ever wrapping. */
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * Solve one axis of a two-finger reshape.
 *
 * Each pinch sits at a known fraction along the axis (`ra`, `rb`), so two live
 * positions determine both the size and the origin — unless the two fractions
 * are nearly equal, in which case the fingers say nothing about this axis's
 * length and it is translated at its existing size instead. Without that guard
 * the size is a division by ~zero and the block explodes.
 */
function solveAxis(ra, rb, a, b, currentSize) {
  const spread = rb - ra;
  if (Math.abs(spread) < TUNING.box.minAxisSpread) {
    const size = currentSize;
    return { size, min: ((a - ra * size) + (b - rb * size)) / 2 };
  }
  const size = Math.max((b - a) / spread, TUNING.box.minSize);
  return { size, min: a - ra * size };
}
