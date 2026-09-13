/**
 * What the arcade offers, for the menu to show: names, blurbs, the controls
 * card, little line drawings, and the best scores. No three.js and no game code
 * in here, so the menu can import it without pulling in a renderer.
 *
 * `controls` entries are `{ pose, text }`, where pose is one of the tutorial's
 * hand drawings: "pinch" | "fist" | "open" | 1 | 2 | 3.
 */

export const GAMES = [
  {
    id: "blockfall", section: "retro", after: "Tetris", name: "Blockfall",
    desc: "Pieces drop down a well. Pinch to carry one sideways, make a fist to spin it, pull down to drop it.",
    controls: [
      { pose: "pinch", text: "Pinch anywhere to grab the falling piece, then move sideways to carry it." },
      { pose: "fist", text: "Make a fist to rotate. Fist on the left of the well turns it left, on the right turns it right." },
      { pose: "pinch", text: "Pull your pinch down to drop it faster. Flick down fast to slam it into place." },
    ],
    chips: ["pinch · carry", "fist · rotate", "pull down · drop", "flick · slam"],
  },
  {
    id: "breaker", section: "retro", after: "Breakout", name: "Brick Breaker",
    desc: "Your palm is the paddle. Hold up both hands and the paddle stretches between them.",
    controls: [
      { pose: "open", text: "Move your hand left and right to steer the paddle." },
      { pose: "open", text: "Two hands up: the paddle stretches between them, up to three times as wide." },
      { pose: "pinch", text: "Pinch to launch the ball." },
      { pose: "fist", text: "Hold a fist and the paddle turns sticky — it catches the ball. Pinch to fire it again." },
    ],
    chips: ["palm · steer", "two hands · wider", "pinch · launch", "fist · catch"],
  },
  {
    id: "invaders", section: "retro", after: "Space Invaders", name: "Shape Invaders",
    desc: "Only the matching shape hits. Hold up 1, 2 or 3 fingers to pick your ammo.",
    controls: [
      { pose: 1, text: "One finger fires squares." },
      { pose: 2, text: "Two fingers fire circles." },
      { pose: 3, text: "Three fingers fire triangles. Your cannon follows your hand." },
      { pose: "fist", text: "Make a fist to raise a shield for a moment." },
    ],
    chips: ["1 · squares", "2 · circles", "3 · triangles", "fist · shield"],
  },
  {
    // `versus`: one shared board for two players. Every other game plays two
    // players as two boards side by side (arcade/index.js).
    id: "pong", section: "retro", after: "Pong", name: "Air Pong", players: [1, 2], versus: true,
    desc: "Raise and lower your hand to block. Pinch right before the ball hits to smash it back.",
    controls: [
      { pose: "open", text: "Move your hand up and down. Your paddle follows it." },
      { pose: "pinch", text: "Pinch just before the ball reaches you to smash it back harder." },
    ],
    chips: ["hand up/down · block", "pinch on contact · smash", "first to 7"],
  },
  {
    id: "snake", section: "retro", after: "Snake", name: "Glow Worm",
    desc: "The worm chases your fingertip. Eat the orbs, grow longer, don't bite your own tail.",
    controls: [
      { pose: 1, text: "Point with your index finger. The worm chases it." },
      { pose: "pinch", text: "Pinch to speed up." },
      { pose: "open", text: "Don't hit the walls or your own tail. Gold orbs are worth five." },
    ],
    chips: ["point · steer", "pinch · boost", "gold · ×5"],
  },
  {
    id: "simon", section: "challenge", after: "Simon", name: "Copycat",
    desc: "Watch the hand signs light up, then make them yourself in the same order. One more each round.",
    controls: [
      { pose: "open", text: "Watch the signs light up in order." },
      { pose: "pinch", text: "Then make each one yourself. Hold it until its pad lights up, then change." },
      { pose: 2, text: "The four signs are pinch, fist, open hand and peace. You get three mistakes." },
    ],
    chips: ["watch", "copy each sign", "3 mistakes"],
  },
  {
    id: "pop", section: "challenge", after: "Whack-a-Mole", name: "Pop Rush",
    desc: "45 seconds. Pinch bubbles, punch crates with a fist, grab gold for time, and leave the red bombs alone.",
    controls: [
      { pose: "pinch", text: "Pinch a bubble to pop it. Pinch a gold star for 5 more seconds." },
      { pose: "fist", text: "Close a fist over a crate to smash it." },
      { pose: "open", text: "Red bombs cost you 5 seconds. Pop quickly in a row for a combo." },
    ],
    chips: ["pinch · bubbles", "fist · crates", "gold · +5s", "red · avoid"],
  },
];

export const gameById = (id) => GAMES.find((g) => g.id === id) ?? null;

// ---- best scores ---------------------------------------------------------

const KEY = "arb.arcade.best.v1";

function readAll() {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}") ?? {}; } catch { return {}; }
}

export const bestOf = (id) => readAll()[id] ?? 0;

/** Store a score if it beats the old one. @returns {boolean} a new best */
export function recordBest(id, score) {
  const all = readAll();
  if (!(score > (all[id] ?? 0))) return false;
  all[id] = score;
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* private mode */ }
  return true;
}

// ---- card art ------------------------------------------------------------
//
// Line drawings on the level cards' 120x100 stage, using the same `goal-shape`
// stroke so the arcade reads as part of the same menu.

const r = (x, y, w, h) => `<rect class="goal-shape" x="${x}" y="${y}" width="${w}" height="${h}" rx="1.5" />`;
const c = (x, y, rad) => `<circle class="goal-shape" cx="${x}" cy="${y}" r="${rad}" />`;
const t = (x, y, s) =>
  `<polygon class="goal-shape" points="${x},${y - s / 2} ${x - s / 2},${y + s / 2} ${x + s / 2},${y + s / 2}" />`;
const ln = (x1, y1, x2, y2, extra = "") =>
  `<line class="goal-shape" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${extra} />`;

const ART = {
  blockfall: () => {
    const cell = 11;
    const at = (col, row) => r(28 + col * cell, 6 + row * cell, cell, cell);
    const well = `<path class="goal-shape" d="M26,4 V94 H94 V4" />`;
    const piece = [[2, 1], [3, 1], [4, 1], [3, 2]].map(([a, b]) => at(a, b)).join("");
    const stack = [[0, 7], [1, 7], [2, 7], [4, 7], [5, 7], [0, 6], [1, 6], [5, 6], [0, 5]]
      .map(([a, b]) => at(a, b)).join("");
    return well + piece + stack;
  },
  breaker: () => {
    let s = "";
    for (let row = 0; row < 3; row++) for (let col = 0; col < 6; col++) {
      if (row === 1 && (col === 2 || col === 3)) continue;
      s += r(12 + col * 16, 10 + row * 10, 14, 8);
    }
    return s + c(70, 62, 4) + r(44, 84, 34, 5) + ln(70, 62, 58, 80, 'stroke-dasharray="2 3"');
  },
  invaders: () =>
    r(18, 14, 14, 14) + c(52, 21, 7) + t(86, 21, 15) + c(35, 44, 7) + r(62, 37, 14, 14) +
    ln(60, 58, 60, 72, 'stroke-dasharray="3 3"') + t(60, 86, 16),
  pong: () =>
    r(10, 26, 5, 30) + r(105, 44, 5, 30) + c(64, 40, 4) +
    ln(60, 6, 60, 94, 'stroke-dasharray="4 5"') + ln(64, 40, 16, 56, 'stroke-dasharray="2 3" opacity="0.5"'),
  snake: () =>
    `<path class="goal-shape" d="M16,78 C30,78 30,52 48,52 S70,76 84,62 S88,30 72,26" stroke-width="5" stroke-linecap="round" opacity="0.55" />` +
    c(72, 26, 6) + c(98, 20, 4) + c(22, 26, 3),
  simon: () =>
    `<path class="goal-shape" d="M58,48 V12 A36,36 0 0 0 22,48 Z" /><path class="goal-shape" d="M62,48 V12 A36,36 0 0 1 98,48 Z" />` +
    `<path class="goal-shape" d="M58,52 V88 A36,36 0 0 1 22,52 Z" /><path class="goal-shape" d="M62,52 V88 A36,36 0 0 0 98,52 Z" />`,
  pop: () =>
    c(30, 30, 12) + c(80, 22, 8) + c(94, 62, 10) + r(34, 58, 26, 26) + ln(34, 58, 60, 84) + ln(60, 58, 34, 84) +
    t(70, 84, 12),
};

export const gameArt = (id) =>
  `<svg viewBox="0 0 120 100" class="goal-svg" aria-hidden="true">${ART[id]?.() ?? ""}</svg>`;
