/**
 * Sound effects, synthesized on the spot with Web Audio.
 *
 * No audio files: every sound is one or two oscillators or a burst of filtered
 * noise with a short envelope, so there is nothing to download, nothing to
 * decode, and the whole thing works offline like the rest of the app.
 *
 * Browsers only let a page make sound after the user has interacted with it.
 * The context is created lazily and resumed on the first pointer or key press;
 * by the time any gesture can happen the menu has already been clicked.
 */

const MASTER = 0.45;
/** Same sound again within this many ms is dropped, so a jittery gesture that
 *  flips state on consecutive frames cannot machine-gun a click. */
const REPEAT_MS = 70;

export function initSound({ isOn = () => true } = {}) {
  let ctx = null;
  let master = null;
  let noiseBuf = null;
  const lastAt = new Map();

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = MASTER;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }

  const unlock = () => { if (isOn()) ensure(); };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock);

  /** One enveloped oscillator, optionally gliding from `freq` to `to`. */
  function tone({ freq, to = freq, type = "sine", dur = 0.1, gain = 0.3, delay = 0, attack = 0.005 }) {
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** A burst of white noise through a sweeping low-pass: whooshes and pops. */
  function noise({ dur = 0.2, gain = 0.2, from = 4000, to = 300, delay = 0 }) {
    if (!noiseBuf) {
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(to, 20), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(g).connect(master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  const arpeggio = (notes, { step = 0.09, dur = 0.22, type = "triangle", gain = 0.22 } = {}) =>
    notes.forEach((freq, i) => tone({ freq, type, dur, gain, delay: i * step }));

  const SOUNDS = {
    // Shape picker ring landed.
    pick:    () => { tone({ freq: 880, dur: 0.07, gain: 0.18 }); tone({ freq: 1320, dur: 0.09, gain: 0.16, delay: 0.06 }); },
    // A ghost block appeared between your fingers.
    draft:   () => tone({ freq: 300, to: 520, dur: 0.1, gain: 0.14 }),
    // The ghost became a real block.
    commit:  () => { tone({ freq: 620, to: 930, type: "triangle", dur: 0.12, gain: 0.22 }); noise({ dur: 0.05, gain: 0.05, from: 6000, to: 2000 }); },
    // Hands landed on a block / let go of it.
    grab:    () => tone({ freq: 540, dur: 0.05, gain: 0.12 }),
    drop:    () => tone({ freq: 420, to: 340, dur: 0.07, gain: 0.12 }),
    // Something is now armed to be deleted.
    arm:     () => { tone({ freq: 240, type: "square", dur: 0.06, gain: 0.07 }); tone({ freq: 240, type: "square", dur: 0.06, gain: 0.07, delay: 0.09 }); },
    // One block gone.
    remove:  () => { noise({ dur: 0.22, gain: 0.18, from: 5000, to: 200 }); tone({ freq: 420, to: 110, dur: 0.2, gain: 0.12 }); },
    // Everything gone.
    wipe:    () => { noise({ dur: 0.45, gain: 0.24, from: 7000, to: 120 }); tone({ freq: 330, to: 55, type: "sawtooth", dur: 0.4, gain: 0.08 }); },
    // Countdown into a level, and the start.
    count:   () => tone({ freq: 660, dur: 0.12, gain: 0.18 }),
    go:      () => tone({ freq: 1320, dur: 0.25, type: "triangle", gain: 0.22 }),
    // Last seconds on the clock.
    tick:    () => tone({ freq: 1000, dur: 0.04, type: "square", gain: 0.05 }),
    solved:  () => arpeggio([523, 659, 784, 1047]),
    best:    () => { arpeggio([659, 784, 988, 1319], { step: 0.08 }); tone({ freq: 1760, dur: 0.4, gain: 0.1, delay: 0.34 }); },
    timeout: () => { tone({ freq: 220, to: 150, type: "sawtooth", dur: 0.35, gain: 0.1 }); tone({ freq: 165, to: 110, type: "sawtooth", dur: 0.45, gain: 0.08, delay: 0.18 }); },
    done:    () => arpeggio([392, 523, 659, 784], { step: 0.12, dur: 0.35 }),
  };

  function play(name) {
    if (!isOn() || !SOUNDS[name]) return;
    const now = performance.now();
    if (now - (lastAt.get(name) ?? 0) < REPEAT_MS) return;
    lastAt.set(name, now);
    try {
      if (!ensure()) return;
      SOUNDS[name]();
    } catch { /* audio is decoration; never let it break a frame */ }
  }

  return { play, names: Object.keys(SOUNDS) };
}
