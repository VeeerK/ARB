import {
  LEVELS, checkLevel, scoreFor, levelArt, TOLERANCE, PAR_TIMEOUT, RUSH, rushLevel, rushBonus, studySeconds, withSeed, boardOf,
} from "./levels.js";
import {
  recordLevel, recordRush, recordDaily, dailyRecord, recordMode, starsFor, starText,
} from "./progress.js";
import { makeKit, COLORS } from "./arcade/kit.js";

/**
 * A run of Play mode: the ladder of levels, the clock, the scoring, and — in
 * two-player — the race between the two halves of the screen.
 *
 * One state machine drives every mode, because they only differ in how a level
 * ENDS and what comes after it:
 *
 *   ladder  — solo or versus. Each level has its own clock; solo ends a level
 *             when you build it or time runs out, versus the moment either
 *             player builds it.
 *   daily   — a solo ladder of today's five levels, with a shareable result.
 *   rush    — one shared clock for the whole run, targets without end, and
 *             every solve adds time. The run ends when the clock does.
 *   memory  — a ladder; the target is shown, then hidden while you build.
 *   copy    — rounds of outlines on screen to fill exactly (modes/copy.js).
 *   balance — rounds of a seesaw to level (modes/balance.js).
 *
 * Every mode but the daily can be raced by two players: first to build each
 * round takes it. Copy and balance give each player the same round in their
 * own half of the screen.
 *
 * A level is usually a spec for checkLevel, but it may bring its own hooks —
 * `setup(env)`, `frame(dt, env)`, `check(blocks, planeH, env)`, `teardown(env)`,
 * `art()` and `holdFrames` — which is how copy and balance fit the same run.
 *
 * Everything else — the countdown, the target card, the hold before a solve
 * counts, the speed multiplier — is shared, so the modes cannot drift apart in
 * feel or in fairness.
 *
 * Phases:
 *   count   — 3, 2, 1 over the target card (in memory: the study time). Boards
 *             are cleared here, so nobody starts a level with the last one
 *             still standing.
 *   play    — the clock runs; every frame both boards are checked.
 *   verdict — a level just ended; the result is on screen for a beat.
 *   done    — the run is over; totals, and a way back.
 */

const COUNT_MS = 3000;      // 3, 2, 1
const VERDICT_MS = 2400;    // how long a result stays up
const RUSH_VERDICT_MS = 1100; // shorter in a rush: the clock is paused, but pace matters
const TICK_MS = 100;        // clock redraw interval; not the check rate
const WARN_S = 5;           // the last seconds tick and the clock turns red

/** Modes with a run score saved per mode, and what their summary calls them. */
const CHALLENGES = { memory: "Memory", copy: "Copy the shape", balance: "Balance scale" };
const COUNTER = { rush: "shape", daily: "daily", memory: "round", copy: "round", balance: "round" };

/**
 * `report(event)` hears about results, for the leaderboards and for online
 * rooms. It is told, never asked: nothing here waits on it.
 *   { type: "start", kind, date, players }
 *   { type: "levelStart", kind, level }                        solo ladder / daily
 *   { type: "level", kind, level, seconds, board, timeline }  a solo ladder or daily solve
 *   { type: "end", kind, score, wins, date, runs }             runs: daily only
 *
 * `board` is the solved board as numbers (levels.js boardOf) and `timeline` is
 * how many blocks were on it and when ([{ t, n }], t in seconds from "go").
 * Together they are the proof the server re-checks before a solve is ranked.
 */
export function initSession({ scene, play, sound = null, report = null }) {
  const sfx = (name) => sound?.play(name);
  const tell = (event) => { try { report?.(event); } catch (err) { console.warn(err); } };
  // Target outlines, the balance beam, and solve sparks: drawn on the same
  // plane as the blocks, with the arcade's kit, and cleared with the run.
  const kit = makeKit(scene);

  let on = false;
  let rigs = [];
  let players = 1;
  let kind = "ladder";
  let date = null;          // daily: which day's challenge this is
  let levels = LEVELS;
  let source = LEVELS;   // the ladder, or the function that makes one
  let index = 0;
  let phase = "count";
  let phaseAt = 0;          // when the current phase started
  let frameAt = 0;
  let tickAt = 0;
  let shownCount = 0;       // last number the countdown put on screen
  let lastTick = null;      // last whole second the warning tick sounded for
  let clockLeft = 0;        // rush: seconds on the shared clock as this level began
  let staged = [];          // per player: { lv, env } whose setup() has run and teardown() has not
  let seed = null;          // online: every random draw in the run follows this
  /** Per level, solo only: { stars, points, seconds } for the summary. */
  let results = [];
  /** Per player, indexed 0..players-1. */
  let state = [];

  /**
   * What a level's hooks get, per player. `lane` is the part of the plane that
   * player builds in: all of it solo, their own half in two-player.
   */
  const envFor = (p) => ({
    scene, kit, sound,
    rigs: () => (rigs[p] ? [rigs[p]] : []),
    lane: players === 2
      ? { x: ((p === 0 ? -1 : 1) * scene.planeW) / 4, w: scene.planeW / 2 }
      : { x: 0, w: scene.planeW },
  });

  const fresh = () => ({ score: 0, wins: 0, streak: 0, solvedAt: null, hint: "", timeline: [], lastN: 0 });
  const level = () => levels[index];
  const rush = () => kind === "rush";
  const artFor = (lv) => (typeof lv.art === "function" ? lv.art() : levelArt(lv));
  const holdFor = (lv) => lv.holdFrames ?? TOLERANCE.holdFrames;
  /** Seeded runs draw each piece from its own tag, so a player who is two
   *  levels ahead cannot shift what anyone else is dealt. */
  const draw = (tag, fn) => (seed == null ? fn() : withSeed(`${seed}:${tag}`, fn));

  /** The build history starts at "go", with whatever is already on the board
   *  (blocks drawn during the countdown are allowed, and marked t = 0). */
  function startTimeline() {
    for (let p = 0; p < players; p++) {
      const n = rigs[p]?.builder.blocks.length ?? 0;
      state[p].timeline = [{ t: 0, n }];
      state[p].lastN = n;
    }
  }

  function unstage() {
    for (const st of staged) st.lv.teardown?.(st.env);
    staged = [];
  }

  /**
   * @param {object} opts
   * @param {1|2} [opts.players]
   * @param {object[]} opts.rigs
   * @param {object[]|function} [opts.ladder] the levels to play, or a function
   *   that produces them. A function is drawn fresh on every start, so "play
   *   again" gets a new assortment rather than a replay. Ignored by rush.
   * @param {"ladder"|"daily"|"rush"|"memory"|"copy"|"balance"} [opts.kind]
   * @param {string} [opts.date] daily only: the YYYY-MM-DD the ladder was drawn for
   * @param {string} [opts.seed] online: makes every player's draw the same
   */
  function start({ players: count = 1, rigs: list, ladder = LEVELS, kind: k = "ladder", date: d = null, seed: s = null }) {
    unstage();
    kit.clear();
    on = true;
    kind = k;
    date = d;
    // The daily is one player's run; everything else can be raced.
    players = k === "daily" || count !== 2 ? 1 : 2;
    // Two players are dealt the same rounds, so both halves draw from one seed.
    seed = s ?? (players === 2 ? Math.random().toString(36).slice(2) : null);
    rigs = list;
    source = ladder;
    if (rush()) {
      levels = [draw("rush-0", () => rushLevel(0))];
      clockLeft = RUSH.start;
    } else {
      levels = typeof ladder === "function" ? draw("ladder", ladder) : ladder;
    }
    index = 0;
    results = [];
    frameAt = 0;
    state = Array.from({ length: players }, fresh);
    play.open(players, rush() ? 0 : levels.length, { label: COUNTER[kind] ?? "level" });
    tell({ type: "start", kind, date, players });
    beginLevel(performance.now());
  }

  function stop() {
    on = false;
    unstage();
    kit.clear();
    play.hideOverlay();
    play.setClockWarn(false);
  }

  /** @param {boolean} [count] run the 3-2-1 first. A rush only counts in once. */
  function beginLevel(now, { count = true } = {}) {
    unstage();
    phase = count ? "count" : "play";
    phaseAt = now;
    shownCount = 0;
    tickAt = 0;
    lastTick = null;
    // A clean board per level. Without this you could hand in the previous
    // level's snowman, and "too many shapes" would fire on every level after
    // the first.
    for (const rig of rigs) rig.builder.clear();
    for (const s of state) { s.streak = 0; s.solvedAt = null; s.hint = ""; }
    for (let p = 0; p < players; p++) {
      play.setState(p + 1, count ? "ready" : "building");
      play.setSolved(p + 1, false);
      play.setHint(p + 1, "—");
    }
    const lv = level();
    // A level with hooks keeps its round on itself, so player 2 gets their own
    // copy. Both set up from the same tag, so both are dealt the same round.
    staged = Array.from({ length: players }, (_, p) => ({
      lv: p && lv.setup ? Object.create(lv) : lv,
      env: envFor(p),
    }));
    for (const st of staged) if (st.lv.setup) draw(`setup-${index}`, () => st.lv.setup(st.env));
    if (!count) startTimeline();
    if (players === 1 && (kind === "ladder" || kind === "daily")) tell({ type: "levelStart", kind, level: lv });
    play.setGoal(lv, artFor(lv), index, rush() ? 0 : levels.length);
    play.setClock(rush() ? clockLeft : limit(lv));
    if (!count) play.hideOverlay();
  }

  const limit = (lv) => Math.round(lv.par * PAR_TIMEOUT);

  /** Called once per rendered frame while a run is up. */
  function frame(now) {
    if (!on) return;
    const dt = frameAt ? Math.min((now - frameAt) / 1000, 0.05) : 0;
    frameAt = now;
    kit.update(dt);
    if (phase !== "done") for (const st of staged) st.lv.frame?.(dt, st.env);
    if (phase === "count") return counting(now);
    if (phase === "play") return playing(now);
    if (phase === "verdict" && now - phaseAt > (rush() ? RUSH_VERDICT_MS : VERDICT_MS)) return advance(now);
  }

  function counting(now) {
    const lv = level();
    const total = lv.memory ? studySeconds(lv) * 1000 : COUNT_MS;
    const left = total - (now - phaseAt);
    if (left <= 0) {
      phase = "play";
      phaseAt = now;
      tickAt = 0;
      play.hideOverlay();
      if (lv.memory) {
        // Anything built while the picture was up does not count.
        for (const rig of rigs) rig.builder.clear();
        play.setGoalHidden(true);
      }
      for (let p = 0; p < players; p++) play.setState(p + 1, "building");
      startTimeline();
      sfx("go");
      return;
    }
    // Only when the digit actually changes: the overlay rewrites its card, and
    // doing that sixty times a second for the same "3" is pure churn.
    const n = Math.ceil(left / 1000);
    if (n !== shownCount) {
      shownCount = n;
      if (lv.memory) {
        play.overlay({ kicker: "memorize this", title: String(n), sub: lv.brief, art: artFor(lv), tone: "study" });
      } else {
        play.countdown(n, lv.brief);
      }
      if (n <= 3) sfx("count");
    }
  }

  function playing(now) {
    const lv = level();
    const elapsed = (now - phaseAt) / 1000;
    const left = (rush() ? clockLeft : limit(lv)) - elapsed;

    if (now - tickAt > TICK_MS) {
      tickAt = now;
      play.setClock(Math.max(0, left));
      play.setClockWarn(left <= WARN_S);
    }
    const whole = Math.ceil(left);
    if (left > 0 && whole <= WARN_S && whole !== lastTick) {
      lastTick = whole;
      sfx("tick");
    }

    for (let p = 0; p < players; p++) {
      const s = state[p];
      if (s.solvedAt) continue;

      const blocks = rigs[p].builder.blocks;
      if (blocks.length !== s.lastN && s.timeline.length < 400) {
        s.lastN = blocks.length;
        s.timeline.push({ t: +elapsed.toFixed(2), n: blocks.length });
      }
      const own = staged[p] ?? { lv, env: envFor(p) };
      const res = own.lv.check ? own.lv.check(blocks, scene.planeH, own.env) : checkLevel(lv, blocks, scene.planeH);
      // A board is only solved once it has been RIGHT for a stretch, not for
      // one frame. Blocks pass through correct-looking positions constantly
      // while being carried, and a race decided by a shape in transit would be
      // decided by luck.
      s.streak = res.ok ? s.streak + 1 : 0;

      // From memory, the checker's hints would give the answer away ("you need
      // 2 circles"), so only the count of what you have placed is shown.
      let hint = res.hint;
      let status = res.status ?? `${res.have}/${res.need}`;
      if (lv.memory && !res.ok) {
        hint = res.have ? `from memory — ${res.have} shape${res.have === 1 ? "" : "s"} placed` : "build it from memory";
        status = `${res.have} placed`;
      }

      if (s.hint !== hint) {
        s.hint = hint;
        play.setHint(p + 1, hint || "looks right — hold it…");
      }
      if (res.ok && s.streak < holdFor(lv)) play.setState(p + 1, "checking…");
      else if (!res.ok) play.setState(p + 1, status);

      if (s.streak >= holdFor(lv)) {
        // Credit the moment the board first became correct, not the moment the
        // hold finished, so the wait costs nobody points and — in a race — the
        // faster builder wins even if the other's hold completed on the same
        // frame.
        s.solvedAt = elapsed - (holdFor(lv) / 30);
        return solved(now, p);
      }
    }

    if (left <= 0) timeout(now);
  }

  function solved(now, p) {
    const lv = level();
    const s = state[p];
    const elapsed = (now - phaseAt) / 1000;
    const seconds = Math.max(s.solvedAt, 0.5);
    const { points, mult } = scoreFor(lv, seconds);
    s.score += points;
    s.wins += 1;
    play.setScore(p + 1, s.score);
    play.setWins(p + 1, s.wins);
    play.setState(p + 1, "solved");
    play.setSolved(p + 1, true);
    play.setClockWarn(false);
    for (const b of rigs[p].builder.blocks) kit.burst(b.mesh.position.x, b.mesh.position.y, COLORS.mint, 10);

    const secs = `${Math.max(s.solvedAt, 0).toFixed(1)}s`;
    phase = "verdict";
    phaseAt = now;

    if (rush()) {
      // The clock pauses through the verdict: bank what was left, plus the bonus.
      const bonus = rushBonus(lv);
      clockLeft = Math.min(RUSH.max, Math.max(0, clockLeft - elapsed) + bonus);
      play.setClock(clockLeft);
      play.bonus(`+${bonus}s`);
      sfx("solved");
      play.overlay({
        kicker: players === 2 ? `player ${p + 1} builds shape ${index + 1}` : `shape ${index + 1} built`,
        title: `+${points}`,
        sub: `${lv.title} in ${secs} · +${bonus}s on the clock`,
        tone: "good",
      });
      return;
    }

    let kicker = players === 2 ? `player ${p + 1} takes the round` : "solved";
    let sub = `${lv.title} in ${secs} · ${mult}x speed`;
    let cue = "solved";
    if (players === 1) {
      let stars;
      const board = boardOf(rigs[p].builder.blocks, scene.planeH);
      const timeline = s.timeline;
      // Only the level ladders keep per-level records. Memory reuses the same
      // level ids, and a solve from memory should not overwrite a level's
      // stars as if it were an ordinary one.
      if (kind === "ladder" || kind === "daily") {
        const rec = recordLevel(lv, { points, seconds });
        stars = rec.stars;
        if (rec.newBest) { kicker = "new best"; cue = "best"; }
        tell({ type: "level", kind, level: lv, seconds, board, timeline });
      } else {
        stars = starsFor(lv, seconds);
      }
      results[index] = { stars, points, seconds, board, timeline };
      sub = `${starText(stars)}   ${sub}`;
    }
    sfx(cue);
    play.overlay({ kicker, title: `+${points}`, sub, tone: "good" });
  }

  function timeout(now) {
    play.setClockWarn(false);
    sfx("timeout");
    if (rush()) {
      play.setClock(0);
      return finish();
    }
    const lv = level();
    phase = "verdict";
    phaseAt = now;
    results[index] = { stars: 0, points: 0, seconds: null };
    for (let p = 0; p < players; p++) play.setState(p + 1, "missed");
    play.overlay({
      kicker: "out of time",
      title: "0",
      // From memory, show what it was: a miss you cannot see is a miss you
      // cannot learn from.
      sub: lv.memory ? `${lv.title} — this is what it was` : `${lv.title} — no points this round`,
      art: lv.memory ? artFor(lv) : "",
      tone: "bad",
    });
  }

  function advance(now) {
    if (rush()) {
      const prev = level();
      levels.push(draw(`rush-${index + 1}`, () => rushLevel(index + 1, prev)));
      index += 1;
      return beginLevel(now, { count: false });
    }
    if (index + 1 >= levels.length) return finish();
    index += 1;
    beginLevel(now);
  }

  function finish() {
    phase = "done";
    play.setClockWarn(false);
    const [a, b] = state;
    tell({
      type: "end", kind, date, players, score: a.score, wins: a.wins, levels: levels.length,
      runs: kind === "daily"
        ? levels.map((lv, i) => ({
          level_id: lv.id,
          seconds: results[i]?.seconds ?? null,
          board: results[i]?.board ?? null,
          timeline: results[i]?.timeline ?? null,
        }))
        : null,
    });

    // Records are one player's: a race goes to the two-player summary below.
    if (rush() && players === 1) {
      const rec = recordRush(a.score);
      sfx(rec.newBest ? "best" : "done");
      play.overlay({
        kicker: rec.newBest ? "new best" : "time's up",
        title: `${a.score} points`,
        sub: `${a.wins} shape${a.wins === 1 ? "" : "s"} built`,
        rows: [{ label: "Best", value: `${rec.best} pts`, win: rec.newBest }],
        buttons: true,
        tone: "done",
      });
      return;
    }

    const stars = levels.map((_, i) => results[i]?.stars ?? 0);
    const starTotal = stars.reduce((n, v) => n + v, 0);

    if (kind === "daily") {
      const hadBefore = !!dailyRecord(date);
      const rec = recordDaily(date, { score: a.score, stars });
      sfx(rec.newBest ? "best" : "done");
      play.overlay({
        kicker: rec.newBest ? "new best today" : `daily · ${date}`,
        title: `${a.score} points`,
        sub: `${a.wins} of ${levels.length} built`,
        rows: [
          ...levels.map((lv, i) => ({ label: `${i + 1}. ${lv.title}`, value: starText(stars[i]) })),
          ...(hadBefore ? [{ label: "Today's best", value: `${rec.best} pts`, win: rec.newBest }] : []),
        ],
        buttons: true,
        share: shareText(a.score, a.wins, stars),
        tone: "done",
      });
      return;
    }

    if (CHALLENGES[kind] && players === 1) {
      const rec = recordMode(kind, a.score);
      sfx(rec.newBest ? "best" : "done");
      play.overlay({
        kicker: rec.newBest ? "new best" : `${CHALLENGES[kind]} complete`,
        title: `${a.score} points`,
        sub: `${a.wins} of ${levels.length} rounds`,
        rows: [
          { label: "Stars", value: `${starTotal} / ${levels.length * 3}` },
          { label: "Best", value: `${rec.best} pts`, win: rec.newBest },
        ],
        buttons: true,
        tone: "done",
      });
      return;
    }

    const rows = state.map((s, i) => ({
      label: players === 2 ? `Player ${i + 1} · ${s.wins} round${s.wins === 1 ? "" : "s"}`
                           : `${s.wins} of ${levels.length} levels`,
      value: `${s.score} pts`,
      win: players === 2 && s.score === Math.max(...state.map((x) => x.score))
           && state.filter((x) => x.score === s.score).length === 1,
    }));
    if (players === 1) rows.push({ label: "Stars", value: `${starTotal} / ${levels.length * 3}` });

    const title = players === 2
      ? (a.score === b.score ? "Draw" : `Player ${a.score > b.score ? 1 : 2} wins`)
      : `${a.score} points`;

    sfx("done");
    play.overlay({
      kicker: rush() ? "time's up" : "run complete",
      title,
      sub: players === 2 ? "" : `${a.wins} of ${levels.length} levels built`,
      rows,
      buttons: true,
      tone: "done",
    });
  }

  /** The daily result as plain text, one star row per level — safe to paste
   *  anywhere, and it gives nothing away about how the levels were built. */
  function shareText(score, built, stars) {
    return [
      `Air Blocks daily · ${date}`,
      `${score} pts · ${built}/${levels.length} built`,
      stars.map((n) => starText(n)).join(" "),
    ].join("\n");
  }

  return {
    start,
    stop,
    frame,
    /** Restart the same run with the same rigs — the summary's "play again". */
    again: () => start({ players, rigs, ladder: source, kind, date }),
    get running() { return on; },
    get phase() { return phase; },
    get kind() { return kind; },
    get level() { return on ? level() : null; },
    get scores() { return state.map((s) => s.score); },
    kit,
  };
}
