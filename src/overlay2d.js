import { CONNECTIONS, LM } from "./landmarks.js";
import { POSE } from "./gestures.js";
import { SHAPES, SHAPE_LABEL } from "./picker.js";
import { coverMapping, toPixels, fitCanvas } from "./viewport.js";

const TIP_INDICES = new Set([LM.THUMB_TIP, LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP, LM.PINKY_TIP]);

/**
 * Debug view of the raw tracking output: 21 dots + skeleton per hand, drawn in
 * the same mirrored, cover-cropped space as the video. This layer is purely
 * diagnostic — it stays available (toggleable) once 3D lands.
 */
export class Overlay2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.visible = true;
    // Set by main.js: one per active builder. The shape rings are NOT debug
    // output, so unlike everything else here they keep drawing when the
    // overlay is toggled off.
    this.pickers = [];
    // Two-player mode. Hands are then coloured by which half of the screen
    // they are in rather than by pose, so each player can pick their own
    // skeleton out at a glance — which is the thing you need to know before
    // you can tell whose blocks are whose.
    this.zones = false;
  }

  draw(frame) {
    const { ctx } = this;
    const { cssW, cssH } = fitCanvas(this.canvas, ctx);
    ctx.clearRect(0, 0, cssW, cssH);

    const map = coverMapping(frame.videoW, frame.videoH, cssW, cssH);
    for (const pk of this.pickers) this._shapeRing(ctx, map, frame, pk);
    if (!this.visible) return;

    for (const hand of frame.hands) {
      const pts = hand.landmarks.map((p) => toPixels(map, frame.videoW, frame.videoH, p.x, p.y));
      // Pose overrides handedness color, so what the classifier decided is
      // visible at a glance instead of only in the HUD text.
      const pose = hand.state?.pose;
      // With two players, WHOSE hand this is outranks what it is doing: the
      // pose is still shown by the pinch line and the palm ring below, but the
      // skeleton stays the player's colour so it never reads as the other
      // player's hand mid-gesture. Matched to the block themes in scene.js.
      const hue = this.zones ? (hand.side === "left" ? 158 : 282)
        : pose === POSE.FIST ? 35
        : pose === POSE.PINCH ? 145
        : hand.handedness === "Left" ? 190 : 280;

      ctx.lineWidth = 2.5;
      ctx.strokeStyle = `hsla(${hue}, 100%, 65%, 0.55)`;
      ctx.beginPath();
      for (const [a, b] of CONNECTIONS) {
        ctx.moveTo(pts[a].x, pts[a].y);
        ctx.lineTo(pts[b].x, pts[b].y);
      }
      ctx.stroke();

      ctx.shadowBlur = 12;
      ctx.shadowColor = `hsla(${hue}, 100%, 60%, 0.9)`;
      pts.forEach((p, i) => {
        const isTip = TIP_INDICES.has(i);
        ctx.beginPath();
        ctx.arc(p.x, p.y, isTip ? 6 : 4, 0, Math.PI * 2);
        ctx.fillStyle = isTip ? "#ffffff" : `hsl(${hue}, 100%, 72%)`;
        ctx.fill();
      });
      ctx.shadowBlur = 0;

      const who = this.zones ? `${hand.side === "left" ? "P1" : "P2"} ` : "";
      this._label(ctx, pts[LM.WRIST],
        `${who}${hand.handedness} ${pose ?? "-"} ${(hand.score * 100) | 0}%`, hue);
      this._pinchGap(ctx, pts, hand, map, frame);
      if (pose === POSE.FIST) this._palm(ctx, hand, map, frame);
    }
  }

  /**
   * Thumb-tip <-> index-tip segment, colored by the pinch state machine:
   * white/dashed while open, solid green while a pinch is committed.
   */
  _pinchGap(ctx, pts, hand, map, frame) {
    const a = pts[LM.THUMB_TIP], b = pts[LM.INDEX_TIP];
    const active = hand.state?.pose === POSE.PINCH;

    ctx.save();
    if (active) {
      ctx.strokeStyle = "rgba(90, 255, 160, 0.95)";
      ctx.lineWidth = 3;
      ctx.shadowBlur = 10;
      ctx.shadowColor = "rgba(90, 255, 160, 0.9)";
    } else {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = 1.5;
    }
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();

    // The smoothed pinch cursor — this is the point that will drive the cube.
    if (active && hand.state.pinchPoint) {
      const p = hand.state.pinchPoint;
      const c = toPixels(map, frame.videoW, frame.videoH, p.x, p.y);
      ctx.save();
      ctx.strokeStyle = "rgba(90, 255, 160, 0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "rgba(90, 255, 160, 0.85)";
      ctx.beginPath();
      ctx.arc(c.x, c.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    this._text(ctx, mid.x + 8, mid.y - 8, hand.metrics.pinch.toFixed(2),
      active ? "rgba(90,255,160,0.95)" : "rgba(255,255,255,0.8)");
  }

  /** The grab anchor — the point every block follows while a fist is held. */
  _palm(ctx, hand, map, frame) {
    const p = hand.state.palmPoint;
    if (!p) return;
    const c = toPixels(map, frame.videoW, frame.videoH, p.x, p.y);
    ctx.save();
    ctx.strokeStyle = "rgba(255, 196, 100, 0.95)";
    ctx.lineWidth = 2.5;
    ctx.shadowBlur = 12;
    ctx.shadowColor = "rgba(255, 196, 100, 0.9)";
    ctx.beginPath();
    ctx.arc(c.x, c.y, 22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The shape picker's ring, closing around the fingers you are holding up.
   *
   * Drawn here rather than in the HUD because it has to sit ON your hand: the
   * whole gesture is "hold this up and wait", and a progress bar in the corner
   * would mean watching one place while holding still in another.
   */
  _shapeRing(ctx, map, frame, pk) {
    if (!pk || (!pk.point && pk.flash <= 0)) return;
    if (!pk.point) return;

    const c = toPixels(map, frame.videoW, frame.videoH, pk.point.x, pk.point.y);
    const done = pk.flash > 0;
    const t = done ? 1 : pk.progress;
    // Cinches inward as it fills, so the ring reads as closing on the choice
    // rather than merely being painted in.
    const r = 70 - 14 * t + (done ? 26 * (1 - pk.flash) : 0);
    const hue = done ? 145 : 190;

    ctx.save();
    ctx.lineCap = "round";

    ctx.beginPath();
    ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
    ctx.lineWidth = 5;
    ctx.strokeStyle = `hsla(${hue}, 90%, 70%, ${done ? 0.10 * pk.flash : 0.16})`;
    ctx.stroke();

    if (t > 0) {
      ctx.beginPath();
      // From twelve o'clock, clockwise ON SCREEN. The canvas is CSS-mirrored,
      // so that is anticlockwise in these coordinates.
      ctx.arc(c.x, c.y, r, -Math.PI / 2, -Math.PI / 2 - t * Math.PI * 2, true);
      ctx.lineWidth = 6;
      ctx.shadowBlur = 16;
      ctx.shadowColor = `hsl(${hue}, 100%, 60%)`;
      ctx.strokeStyle = `hsla(${hue}, 100%, 72%, ${done ? pk.flash : 0.95})`;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    const label = SHAPE_LABEL[SHAPES[pk.count - 1]] ?? "";
    if (label) {
      this._text(ctx, c.x + 26, c.y - r - 12, `${pk.count} · ${label}`,
                 `hsla(${hue}, 100%, 80%, ${done ? pk.flash : 0.9})`);
    }
    ctx.restore();
  }

  _label(ctx, p, text, hue) {
    this._text(ctx, p.x + 10, p.y + 18, text, `hsl(${hue}, 100%, 78%)`);
  }

  /** Text has to be un-mirrored, since the whole canvas is flipped in CSS. */
  _text(ctx, x, y, text, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(-1, 1);
    ctx.font = "12px ui-monospace, Menlo, Consolas, monospace";
    ctx.textAlign = "right";
    ctx.fillStyle = color;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }
}
