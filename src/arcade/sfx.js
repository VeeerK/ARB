/**
 * Arcade sound: every effect is synthesised on the spot with WebAudio, so there
 * are no files to ship and nothing to load. Square and triangle waves on
 * purpose — they are what the games being borrowed from actually sounded like.
 *
 * Browsers refuse to start audio until the page has been clicked, so the
 * context is created lazily and `unlock()` is called from the menu click that
 * launches a game.
 */

import { settings, setSound } from "../settings.js";

let ctx = null;
let master = null;

// The app-wide Sound setting (Settings screen, M key) is the one switch. Read
// on every play, so flipping it mid-game takes effect on the next blip.
const isMuted = () => !settings.sound;

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

/** One enveloped oscillator, optionally sliding from `freq` to `to`. */
function tone({ freq = 440, to = null, dur = 0.1, type = "square", vol = 0.06, delay = 0 } = {}) {
  if (isMuted()) return;
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(to, 20), t + dur);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** A short burst of filtered noise — explosions and crunches. */
function noise({ dur = 0.2, vol = 0.08, cutoff = 1800, delay = 0 } = {}) {
  if (isMuted()) return;
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + delay;
  const len = Math.max(1, Math.floor(ac.sampleRate * dur));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = ac.createBufferSource();
  src.buffer = buf;
  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(cutoff, t);
  filter.frequency.exponentialRampToValueAtTime(120, t + dur);
  const gain = ac.createGain();
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(gain).connect(master);
  src.start(t);
}

const arp = (notes, step = 0.07, opts = {}) =>
  notes.forEach((freq, i) => tone({ freq, dur: step * 1.4, delay: i * step, ...opts }));

// Simon's four pads: the original toy's own notes (E4, C#4, A4, E3), which is
// why they sound "right" together in any order.
const PADS = [329.63, 277.18, 440, 164.81];

export const sfx = {
  unlock: () => { audio(); },
  get muted() { return isMuted(); },
  setMuted(on) { setSound(!on); },

  tick: () => tone({ freq: 660, dur: 0.07, type: "triangle", vol: 0.07 }),
  go: () => arp([523, 784], 0.08, { type: "triangle", vol: 0.08 }),
  move: () => tone({ freq: 220, dur: 0.03, vol: 0.025 }),
  rotate: () => tone({ freq: 440, to: 660, dur: 0.06, vol: 0.04 }),
  lock: () => tone({ freq: 140, to: 90, dur: 0.08, type: "triangle", vol: 0.09 }),
  slam: () => { tone({ freq: 300, to: 60, dur: 0.14, vol: 0.07 }); noise({ dur: 0.12, vol: 0.05, cutoff: 900 }); },
  clear: (n = 1) => arp([523, 659, 784, 1047].slice(0, Math.max(2, n + 1)), 0.06, { vol: 0.06 }),
  bounce: () => tone({ freq: 480, dur: 0.04, vol: 0.05 }),
  paddle: () => tone({ freq: 260, dur: 0.06, type: "triangle", vol: 0.09 }),
  brick: (row = 0) => tone({ freq: 620 + row * 60, dur: 0.05, vol: 0.05 }),
  clink: () => tone({ freq: 1400, to: 900, dur: 0.05, type: "triangle", vol: 0.05 }),
  shoot: () => tone({ freq: 900, to: 300, dur: 0.09, vol: 0.035 }),
  explode: () => noise({ dur: 0.25, vol: 0.09, cutoff: 2400 }),
  hurt: () => { tone({ freq: 200, to: 50, dur: 0.4, vol: 0.09 }); noise({ dur: 0.35, vol: 0.07, cutoff: 700 }); },
  power: () => arp([392, 523, 659, 784, 1047], 0.05, { type: "triangle", vol: 0.06 }),
  eat: () => tone({ freq: 520, to: 880, dur: 0.08, type: "triangle", vol: 0.07 }),
  pop: () => tone({ freq: 700 + Math.random() * 300, to: 1500, dur: 0.06, type: "triangle", vol: 0.07 }),
  smash: () => { noise({ dur: 0.18, vol: 0.1, cutoff: 1600 }); tone({ freq: 160, to: 70, dur: 0.12, vol: 0.07 }); },
  bad: () => tone({ freq: 160, to: 110, dur: 0.22, vol: 0.08 }),
  score: () => arp([659, 988], 0.07, { vol: 0.06 }),
  pad: (i) => tone({ freq: PADS[i % PADS.length], dur: 0.35, type: "triangle", vol: 0.12 }),
  win: () => arp([523, 659, 784, 1047, 784, 1047], 0.09, { type: "triangle", vol: 0.08 }),
  lose: () => arp([392, 330, 262, 196], 0.14, { type: "triangle", vol: 0.08 }),
};
