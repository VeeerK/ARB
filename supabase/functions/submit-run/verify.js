import { ALL_LEVELS, PAR_TIMEOUT, checkBoard, dailyLadder } from "../_shared/levels.js";

/**
 * What the server checks before a leaderboard result is written. Plain
 * JavaScript with no Deno or Supabase in it, so it runs (and is tested) under
 * Node too.
 *
 *   ok: false  the result is impossible and is rejected outright
 *   flags      the result is possible but suspicious: it is stored, and held
 *              off the leaderboards until reviewed (admin.review in
 *              supabase/002_anticheat.sql)
 *
 * The level rules come from ../_shared/levels.js, a copy of src/levels.js made
 * by supabase/sync-shared.mjs, so the server judges a board by exactly the
 * rules the game used.
 */

const KINDS = new Set(["box", "circle", "triangle"]);
const MAX_BLOCKS = 12;
const MAX_TIMELINE = 400;

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const reject = (reason) => ({ ok: false, reason, flags: [] });

/** One solved level: { level_id, seconds, board, timeline }. */
export function verifyLevel({ level_id, seconds, board, timeline } = {}) {
  const level = ALL_LEVELS.find((l) => l.id === level_id);
  if (!level) return reject("Unknown level");
  if (!finite(seconds) || seconds < 0.5 || seconds > level.par * PAR_TIMEOUT) return reject("Invalid time");

  // The board: real shapes, sane sizes, and a build of this level.
  if (!Array.isArray(board) || !board.length || board.length > MAX_BLOCKS) return reject("Invalid board");
  for (const b of board) {
    if (!b || !KINDS.has(b.kind) || ![b.w, b.h, b.x, b.y, b.angle].every(finite)) return reject("Invalid board");
    if (b.w <= 0 || b.h <= 0 || b.w > 3 || b.h > 3 || Math.abs(b.x) > 6 || Math.abs(b.y) > 3) return reject("Invalid board");
  }
  if (!checkBoard(level, board).ok) return reject("That board doesn't build the level");

  // The history: how many blocks were on the board, and when. Every block on
  // the final board has to have been added at some point, one at a time.
  if (!Array.isArray(timeline) || !timeline.length || timeline.length > MAX_TIMELINE) return reject("Missing build history");
  const flags = new Set();
  let prevT = 0;
  let prevN = 0;
  let added = 0;
  let lastAddAt = null;
  for (const e of timeline) {
    if (!e || !finite(e.t) || !Number.isInteger(e.n) || e.t < prevT || e.n < 0 || e.n > 40) {
      return reject("Invalid build history");
    }
    if (e.n > prevN) {
      added += e.n - prevN;
      // t = 0 is what was already built during the countdown, which is allowed.
      if (e.t > 0) {
        if (e.n - prevN > 1) flags.add("burst");              // two blocks in one frame
        if (lastAddAt == null && e.t < 0.4) flags.add("instant");
        if (lastAddAt != null && e.t - lastAddAt < 0.2) flags.add("rapid");
        lastAddAt = e.t;
      }
    }
    prevT = e.t;
    prevN = e.n;
  }
  if (added < board.length || prevN !== board.length) return reject("Build history doesn't match the board");
  if (prevT > seconds + 1.5) return reject("Build history doesn't match the time");

  // A quarter of par is faster than any build seen in testing: possible, but
  // worth a look before it tops a board.
  if (seconds < level.par * 0.25) flags.add("fast");

  return { ok: true, flags: [...flags] };
}

/** A finished daily: { day, levels: [{ level_id, seconds, board, timeline }] }. */
export function verifyDaily({ day, levels } = {}) {
  if (typeof day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return reject("Invalid day");
  // The day's levels are drawn from a seed of the date, so the server can draw
  // them too and insist on exactly those.
  const want = dailyLadder(day).map((l) => l.id);
  if (!Array.isArray(levels) || levels.length !== want.length) return reject("Invalid daily result");

  const flags = new Set();
  const runs = [];
  for (let i = 0; i < want.length; i++) {
    const r = levels[i];
    if (!r || r.level_id !== want[i]) return reject("Those aren't that day's levels");
    if (r.seconds == null) {
      runs.push({ level_id: r.level_id, seconds: null });
      continue;
    }
    const v = verifyLevel(r);
    if (!v.ok) return v;
    for (const f of v.flags) flags.add(f);
    runs.push({ level_id: r.level_id, seconds: r.seconds });
  }
  return { ok: true, flags: [...flags], runs };
}

/** A game or challenge score: { mode, score }. Timing is checked in SQL. */
export function verifyScore({ mode, score } = {}) {
  if (typeof mode !== "string" || !/^[a-z]{2,20}$/.test(mode)) return reject("Unknown mode");
  if (!Number.isInteger(score) || score <= 0) return reject("Invalid score");
  return { ok: true, flags: [] };
}
