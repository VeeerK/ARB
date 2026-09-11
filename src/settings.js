/**
 * Player-chosen block colours, and the one place they are remembered.
 *
 * Three colours describe a player's blocks, and they are the three the game
 * actually says something with:
 *
 *   blocks   — a block sitting there, yours
 *   holding  — a block your hands are on right now
 *   deleting — a block that is about to be wiped
 *
 * Everything else (edges, glow, the draft outline you are dragging out) is
 * derived, because those are readability, not identity: a player picks what
 * their blocks ARE, not eight shades of it.
 *
 * Player 2 defaults to the opposite of player 1 — the same colours turned half
 * way round the wheel — so two people never have to negotiate a palette before
 * they can play, and never end up in two greens they cannot tell apart at the
 * divider. Turning that off hands them their own three swatches.
 *
 * Nothing here draws. It owns the values, persists them, and pushes them into
 * the two places that render colour: the three.js block themes, and the CSS
 * custom properties the HUD and split-screen panels are painted from.
 */

import { setThemeColors } from "./scene.js";

const KEY = "arb.settings.v1";

/** The colours the game shipped with, as the reset target. */
export const DEFAULTS = {
  p1: { idle: "#7cf0c4", held: "#ffc464", doomed: "#ff5a6e" },
  // Deliberately the wheel-opposite of p1's greens and ambers, which is also
  // what `oppositeOf` produces — so "custom" starts where "auto" left off.
  p2: { idle: "#c98cff", held: "#ffb0e6", doomed: "#ff5a6e" },
  autoP2: true,
  // Index into ringlight.js's LEVELS: off. A player's room does not change
  // between sessions, so the lamp they needed last night is the one they want
  // tonight — but it starts off, because a screen that lights up on its own
  // the first time you open a page is alarming.
  light: 0,
  // Game options. Sound starts on; grid snap starts off, because free placement
  // is how the game was designed to feel and snap is a helper you opt into.
  sound: true,
  snap: false,
};

export const SWATCH_KEYS = ["idle", "held", "doomed"];

export const SWATCH_LABEL = {
  idle: "Blocks",
  held: "Holding",
  doomed: "Deleting",
};

export const SWATCH_NOTE = {
  idle: "A block of yours, sitting on the plane.",
  held: "A block your hands are on.",
  doomed: "A block that is about to be wiped.",
};

/** A palette of ready-made picks, so nobody has to fight a colour wheel. */
export const PRESETS = [
  { name: "Mint",   idle: "#7cf0c4", held: "#ffc464", doomed: "#ff5a6e" },
  { name: "Sky",    idle: "#66d9ff", held: "#ffd166", doomed: "#ff5a6e" },
  { name: "Violet", idle: "#c98cff", held: "#ffb0e6", doomed: "#ff5a6e" },
  { name: "Amber",  idle: "#ffc35c", held: "#8cf0ff", doomed: "#ff5a6e" },
  { name: "Rose",   idle: "#ff8fb1", held: "#9df0a0", doomed: "#ff3b52" },
  { name: "Lime",   idle: "#c4f75e", held: "#8ac4ff", doomed: "#ff5a6e" },
];

// ---- colour maths --------------------------------------------------------

const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function hexToRgb(hex) {
  const n = parseInt(String(hex).replace("#", ""), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

const toHex = ({ r, g, b }) =>
  "#" + [r, g, b].map((v) => Math.round(clamp01(v / 255) * 255).toString(16).padStart(2, "0")).join("");

/** 0xRRGGBB, which is what three.js wants. */
export const hexToInt = (hex) => parseInt(String(hex).replace("#", ""), 16) | 0;

function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0))
          : max === g ? (b - r) / d + 2
          : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

function hslToRgb({ h, s, l }) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
                  : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/** Half a turn round the wheel: player 2's colour, given player 1's. */
export function oppositeOf(hex) {
  const hsl = rgbToHsl(hexToRgb(hex));
  return toHex(hslToRgb({ ...hsl, h: hsl.h + 180 }));
}

/**
 * The same hue, pulled dark and saturated enough to read as text and hairlines
 * on the app's light chrome. The blocks glow over a webcam image and want to be
 * pale; the UI does not, and a pale mint label on paper is unreadable.
 */
function forUI(hex) {
  const hsl = rgbToHsl(hexToRgb(hex));
  return toHex(hslToRgb({ h: hsl.h, s: Math.max(hsl.s, 0.45), l: Math.min(hsl.l, 0.38) }));
}

// ---- the settings themselves --------------------------------------------

const clone = (v) => JSON.parse(JSON.stringify(v));

let state = clone(DEFAULTS);
const listeners = new Set();

/** Player 2's palette as it actually renders: mirrored, or their own picks. */
export function paletteFor(player) {
  if (player === 1) return { ...state.p1 };
  if (!state.autoP2) return { ...state.p2 };
  return {
    idle: oppositeOf(state.p1.idle),
    held: oppositeOf(state.p1.held),
    // Never mirrored. "About to be deleted" has to mean the same thing on both
    // halves of the screen, or the warning is just another player's colour.
    doomed: state.p1.doomed,
  };
}

export const settings = {
  get all() { return clone(state); },
  get autoP2() { return state.autoP2; },
  get p1() { return { ...state.p1 }; },
  get light() { return state.light; },
  get sound() { return state.sound; },
  get snap() { return state.snap; },
  /** What player 2 renders as, mirrored or not — the UI shows this, not the raw pick. */
  get p2() { return paletteFor(2); },
  /** Player 2's own stored picks, which sit dormant while `autoP2` is on. */
  get p2custom() { return { ...state.p2 }; },
};

/** Change one swatch, or the mirroring flag. Persists and repaints. */
export function setColor(player, key, hex) {
  if (!SWATCH_KEYS.includes(key)) return;
  const slot = player === 2 ? "p2" : "p1";
  state[slot] = { ...state[slot], [key]: hex };
  commit();
}

/** Which ring-light step is showing. Stored, not applied — the lamp owns that. */
export function setLight(level) {
  state.light = Math.max(0, Number(level) | 0);
  save();
}

/** Game options. Not colours, so they notify listeners without repainting. */
export function setSound(on) {
  state.sound = !!on;
  save();
  for (const fn of listeners) fn(settings.all);
}

export function setSnap(on) {
  state.snap = !!on;
  save();
  for (const fn of listeners) fn(settings.all);
}

export function setAutoP2(on) {
  // Leaving auto: keep what was on screen, so the toggle never moves a colour.
  if (state.autoP2 && !on) state.p2 = paletteFor(2);
  state.autoP2 = !!on;
  commit();
}

export function resetColors() {
  // Colours only: the ring light is a room, not a palette, and the button that
  // resets one has no business turning off the other. Same for game options.
  state = { ...clone(DEFAULTS), light: state.light, sound: state.sound, snap: state.snap };
  commit();
}

/** Called whenever anything changes, plus once at boot. */
export const onSettingsChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

function commit() {
  save();
  apply();
  for (const fn of listeners) fn(settings.all);
}

/** Push the current colours into three.js and into the stylesheet. */
export function apply() {
  const toInts = (p) => ({
    idle: hexToInt(p.idle),
    held: hexToInt(p.held),
    doomed: hexToInt(p.doomed),
    // The draft you are dragging out is the block you are about to make, so it
    // is that player's colour — one notch lighter is the ghost material's job.
    ghost: hexToInt(p.idle),
  });
  const p1 = paletteFor(1), p2 = paletteFor(2);
  setThemeColors("p1", toInts(p1));
  setThemeColors("p2", toInts(p2));

  const root = document.documentElement.style;
  root.setProperty("--p1", forUI(p1.idle));
  root.setProperty("--p2", forUI(p2.idle));
  root.setProperty("--warn", forUI(p1.doomed));
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ }
}

/** Read whatever was stored and apply it. Safe to call once, at boot. */
export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      state = {
        p1: { ...DEFAULTS.p1, ...(saved.p1 ?? {}) },
        p2: { ...DEFAULTS.p2, ...(saved.p2 ?? {}) },
        autoP2: saved.autoP2 ?? DEFAULTS.autoP2,
        light: saved.light ?? DEFAULTS.light,
        sound: saved.sound ?? DEFAULTS.sound,
        snap: saved.snap ?? DEFAULTS.snap,
      };
    }
  } catch { state = clone(DEFAULTS); }
  apply();
  return settings.all;
}
