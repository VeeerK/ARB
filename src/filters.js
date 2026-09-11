/**
 * The 1-Euro filter (Casiez, Roussel & Vogel, 2012).
 *
 * A fixed exponential average has to pick one compromise: smooth enough to kill
 * jitter when the hand is still, and that same constant is far too heavy when
 * the hand moves fast — which is exactly the "I have to move slowly or it falls
 * apart" feel. 1-Euro removes the compromise by making the cutoff frequency a
 * function of speed: heavy smoothing at rest, almost none while moving.
 *
 * Inputs here are normalized landmark coords (0..1 across the camera frame) and
 * seconds, so "speed" is frame-widths per second — roughly 0.2 at rest and 2-5
 * during a fast reach. `beta` is the knob that matters; see TUNING.filter.
 */

const alpha = (cutoff, dt) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

class LowPass {
  constructor() { this.y = null; }
  filter(x, a) {
    this.y = this.y === null ? x : a * x + (1 - a) * this.y;
    return this.y;
  }
  get initialized() { return this.y !== null; }
}

class OneEuroScalar {
  constructor(cfg) {
    this.cfg = cfg;
    this.x = new LowPass();
    this.dx = new LowPass();
    this.tPrev = null;
    this.xPrev = null;
  }

  filter(value, t) {
    const { minCutoff, beta, dCutoff } = this.cfg;
    if (this.tPrev === null) {
      this.tPrev = t;
      this.xPrev = value;
      return this.x.filter(value, 1);
    }
    // A stalled tab or a dropped frame can hand us a huge or zero dt; clamp it
    // so the derivative estimate cannot explode.
    const dt = Math.min(Math.max(t - this.tPrev, 1 / 240), 1 / 5);
    this.tPrev = t;

    const speed = (value - this.xPrev) / dt;
    this.xPrev = value;
    const edx = this.dx.filter(speed, alpha(dCutoff, dt));
    const cutoff = minCutoff + beta * Math.abs(edx);
    return this.x.filter(value, alpha(cutoff, dt));
  }
}

/** 1-Euro over a {x, y, z} point. One filter per axis, one shared config. */
export class OneEuroPoint {
  constructor(cfg) {
    this.fx = new OneEuroScalar(cfg);
    this.fy = new OneEuroScalar(cfg);
    this.fz = new OneEuroScalar(cfg);
  }
  filter(p, t) {
    return {
      x: this.fx.filter(p.x, t),
      y: this.fy.filter(p.y, t),
      z: this.fz.filter(p.z ?? 0, t),
    };
  }
}
