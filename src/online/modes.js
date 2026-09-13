import { GAMES } from "../arcade/catalog.js";

/**
 * What a room can play, and what its host can tune. Ids match the
 * `game_modes` table in supabase/schema.sql.
 *
 * `settings` entries are one segmented control each: `options` are
 * [value, label] and the first is the default unless `def` says otherwise.
 */

export const MODES = [
  {
    id: "ladder", group: "build", name: "Level race",
    blurb: "Everyone builds the same levels. Faster builds score more.",
    settings: [
      { key: "difficulty", label: "Difficulty", options: [["mixed", "Mixed"], ["easy", "Easy"], ["medium", "Medium"], ["hard", "Hard"]] },
      { key: "levels", label: "Levels", options: [[3, "3"], [5, "5"], [10, "10"]], def: 5 },
    ],
  },
  { id: "rush", group: "build", name: "Shape rush", blurb: "Same targets, your own clock. Highest score when it runs out." },
  { id: "memory", group: "build", name: "Memory", blurb: "Study the target, then build it from memory." },
  {
    id: "copy", group: "build", name: "Copy the shape", blurb: "Fill each outline exactly.",
    settings: [{ key: "rounds", label: "Rounds", options: [[4, "4"], [8, "8"], [12, "12"]], def: 8 }],
  },
  { id: "balance", group: "build", name: "Balance scale", blurb: "Level the beam with your shapes." },
  ...GAMES.map((g) => ({
    id: g.id,
    group: "arcade",
    name: g.name,
    blurb: g.id === "pong" ? "One on one, live. First to the target wins." : "Everyone plays their own game. Highest score wins.",
    min: g.id === "pong" ? 2 : 1,
    max: g.id === "pong" ? 2 : 8,
    settings: g.id === "pong"
      ? [{ key: "to", label: "Points to win", options: [[5, "5"], [7, "7"], [11, "11"]], def: 7 }]
      : [],
  })),
];

export const GROUPS = [
  { id: "build", label: "Build" },
  { id: "arcade", label: "Arcade" },
];

export const modeById = (id) => MODES.find((m) => m.id === id) ?? null;

/** Modes with a high-score leaderboard (see `game_modes.ranked`). */
export const RANKED = new Set(["rush", "memory", "copy", "balance", "blockfall", "breaker", "invaders", "snake", "simon", "pop"]);

export const maxFor = (id) => modeById(id)?.max ?? 8;
export const minFor = (id) => modeById(id)?.min ?? 1;

/** A mode's settings with every default filled in and nothing foreign kept. */
export function fillSettings(id, settings = {}) {
  const out = {};
  for (const s of modeById(id)?.settings ?? []) {
    const allowed = s.options.map(([v]) => v);
    const want = settings?.[s.key];
    out[s.key] = allowed.some((v) => String(v) === String(want))
      ? allowed.find((v) => String(v) === String(want))
      : s.def ?? allowed[0];
  }
  return out;
}

/** "Mixed · 5 levels", for a room card. */
export function settingsText(id, settings = {}) {
  const filled = fillSettings(id, settings);
  return (modeById(id)?.settings ?? [])
    .map((s) => {
      const label = s.options.find(([v]) => String(v) === String(filled[s.key]))?.[1] ?? filled[s.key];
      return /^\d+$/.test(label) ? `${label} ${s.label.toLowerCase()}` : label;
    })
    .join(" · ");
}
