/**
 * What the player has achieved, remembered on this device.
 *
 *   levels  — per level id: best points, best time, most stars, plays
 *   rush    — best Shape Rush score
 *   daily   — per date: best score and the stars from that run
 *
 * Only one-player runs write here. Two players share one camera and one
 * device, so there is no single person a record would belong to.
 */

const KEY = "arb.progress.v1";
/** Daily results older than this many entries are dropped, oldest first. */
const DAILY_KEEP = 60;

/**
 * Stars for a solve, from how it compares with the level's par:
 *   1 — built it at all
 *   2 — at or under par
 *   3 — in `three` of par or less (par is already "a competent player")
 */
export const STARS = { three: 0.6 };

export function starsFor(level, seconds) {
  if (seconds == null) return 0;
  if (seconds <= level.par * STARS.three) return 3;
  if (seconds <= level.par) return 2;
  return 1;
}

export const starText = (n, of = 3) => "★".repeat(Math.max(0, n)) + "☆".repeat(Math.max(0, of - n));

const empty = () => ({ levels: {}, rush: { best: 0, runs: 0 }, daily: {}, modes: {} });
let state = empty();
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    state = {
      levels: saved.levels ?? {},
      rush: { ...empty().rush, ...(saved.rush ?? {}) },
      daily: saved.daily ?? {},
      modes: saved.modes ?? {},
    };
  } catch { state = empty(); }
}
load();

function commit() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ }
  for (const fn of listeners) fn();
}

export const onProgressChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

export const levelRecord = (id) => state.levels[id] ?? null;

/**
 * Save a solve.
 * @returns {{stars:number, newBest:boolean, hadBefore:boolean}} `newBest` only
 *   counts when there was a previous record to beat.
 */
export function recordLevel(level, { points, seconds }) {
  const prev = state.levels[level.id] ?? null;
  const stars = starsFor(level, seconds);
  state.levels[level.id] = {
    best: Math.max(prev?.best ?? 0, points),
    time: prev?.time == null ? +seconds.toFixed(1) : Math.min(prev.time, +seconds.toFixed(1)),
    stars: Math.max(prev?.stars ?? 0, stars),
    plays: (prev?.plays ?? 0) + 1,
  };
  commit();
  return { stars, hadBefore: !!prev, newBest: !!prev && points > prev.best };
}

/** Stars earned across a set of level ids. */
export const starsIn = (ids) => ids.reduce((n, id) => n + (state.levels[id]?.stars ?? 0), 0);

export const rushBest = () => state.rush.best;

export function recordRush(score) {
  const prev = state.rush.best;
  state.rush = { best: Math.max(prev, score), runs: state.rush.runs + 1 };
  commit();
  return { best: state.rush.best, newBest: score > 0 && score > prev };
}

/** Best run score for a challenge mode: memory, copy, balance. */
export const modeBest = (kind) => state.modes[kind]?.best ?? 0;

export function recordMode(kind, score) {
  const prev = modeBest(kind);
  state.modes[kind] = { best: Math.max(prev, score), runs: (state.modes[kind]?.runs ?? 0) + 1 };
  commit();
  return { best: state.modes[kind].best, newBest: score > 0 && score > prev };
}

export const dailyRecord = (date) => state.daily[date] ?? null;

export function recordDaily(date, { score, stars }) {
  const prev = state.daily[date] ?? null;
  if (!prev || score > prev.score) state.daily[date] = { score, stars };
  const dates = Object.keys(state.daily).sort();
  for (const d of dates.slice(0, Math.max(0, dates.length - DAILY_KEEP))) delete state.daily[d];
  commit();
  return { best: state.daily[date].score, newBest: !!prev && score > prev.score };
}

export function resetProgress() {
  state = empty();
  commit();
}
