import { makeKit } from "./kit.js";
import { Input, LaneInput } from "./input.js";
import { sfx } from "./sfx.js";
import { initArcadeUI } from "./ui.js";
import { gameById, bestOf, recordBest } from "./catalog.js";
import blockfall from "./games/blockfall.js";
import breaker from "./games/breaker.js";
import invaders from "./games/invaders.js";
import pong from "./games/pong.js";
import snake from "./games/snake.js";
import simon from "./games/simon.js";
import pop from "./games/pop.js";

/**
 * The arcade: one run of one game, and everything around it that every game
 * shares — the how-to card, the countdown, pausing when your hands leave the
 * frame, the game-over card, best scores, sound.
 *
 * Phases:
 *   intro   — the controls card over a live board. Pinch (or click) to start.
 *   count   — 3, 2, 1. Also how a pause ends, so nobody resumes mid-flinch.
 *   play    — the game's own update runs.
 *   paused  — by the P key, or by the tracker losing every hand.
 *   over    — the result. Pinch to go again.
 *
 * A game is a function `(ctx) => instance`. The instance draws with `ctx.kit`,
 * reads `ctx.input`, and implements:
 *   update(dt, now)   the game, while it is being played
 *   idle(dt, now)     optional: keep the board animated while it is not
 *   cursors()         optional: draw hand markers, every frame in every phase
 *   stats()           [{ k, v }] for the top bar
 *   dispose()         optional: anything it made outside the kit
 * and calls `ctx.end({ score, title, sub, rows })` when it is over.
 */

const IMPL = { blockfall, breaker, invaders, pong, snake, simon, pop };

const COUNT_STEP_MS = 650;
const LOST_HANDS_MS = 900;     // no hand this long mid-game pauses it
const HANDS_BACK_MS = 450;     // a hand seen this long resumes it

/**
 * `report(event)` hears every game start and finish, for the leaderboards and
 * for online rooms:
 *   { type: "start", mode, players, online }
 *   { type: "end", mode, players, online, score, result }
 *
 * An online route (`route.online`) plays the same game with the social parts
 * taken out: no how-to card to pinch past (the room counts everyone in
 * together), no pausing by hand, and no "play again" — the room decides what
 * comes next. `route.net` is passed through to games that talk to the other
 * player (Air Pong).
 */
export function initArcade({ scene, onQuit, report = null }) {
  const kit = makeKit(scene);
  const input = new Input(scene);

  let def = null;
  let game = null;
  let players = 1;
  let split = false;          // two players on a one-player game: a board each
  let online = false;
  let net = null;
  let phase = "off";
  let phaseAt = 0;
  let lastNow = 0;
  let statsAt = 0;
  let shownCount = -1;
  let pauseReason = null;
  let handsBackAt = 0;

  const ui = initArcadeUI({
    onQuit: () => onQuit(),
    onGo: () => go(performance.now()),
    onPause: () => togglePause(performance.now()),
    onMute: () => toggleMute(),
  });
  ui.setMute(sfx.muted);

  const ctx = {
    kit, input, sfx, scene,
    get players() { return players; },
    get phase() { return phase; },
    get net() { return net; },
    get online() { return online; },
    banner: (text, tone, ms) => ui.banner(text, tone, ms),
    popAt: (x, y, text, tone) => ui.pop(kit.toCss(x, y), text, tone),
    mount: (el) => ui.mount(el),
    end: (result) => finish(result),
  };

  function build() {
    game?.dispose?.();
    kit.clear();
    ui.clearLayer();
    game = split ? splitGame() : IMPL[def.id](ctx);
  }

  /**
   * Two players, for a game written for one: a copy of the game on each half
   * of the screen, each with its own lane kit and only its own side's hands.
   * Returned as one game, so every phase above runs unchanged. A player who is
   * out waits; when both are, the higher score wins.
   */
  function splitGame() {
    kit.dashes(0, -kit.h / 2, 0, kit.h / 2, 32, 0xffffff, 0.4);
    let done = false;

    const lanes = ["left", "right"].map((zone, i) => {
      const laneKit = makeKit(scene, { lane: zone });
      const laneInput = new LaneInput(input, zone);
      laneInput.sync(laneKit.offset);
      const lane = { kit: laneKit, input: laneInput, result: null, game: null };
      lane.game = IMPL[def.id]({
        kit: laneKit, input: laneInput, sfx, scene,
        players: 1, player: i + 1, net: null, online: false,
        get phase() { return phase; },
        banner: (text, tone, ms) => ui.banner(`P${i + 1} · ${text}`, tone, ms),
        popAt: (x, y, text, tone) => ui.pop(laneKit.toCss(x, y), text, tone),
        mount: (el) => ui.mount(el, zone),
        end: (result) => laneOver(lane, i, result),
      });
      return lane;
    });

    function laneOver(lane, i, result = {}) {
      if (lane.result || done) return;
      lane.result = result;
      if (lanes.some((l) => !l.result)) {
        ui.banner(`player ${i + 1} is out`, "bad", 1600);
        return;
      }
      done = true;
      const scores = lanes.map((l) => Number(l.result.score) || 0);
      const winner = scores[0] === scores[1] ? 0 : scores[0] > scores[1] ? 1 : 2;
      sfx.win();
      finish({
        kicker: winner ? `player ${winner} wins` : "draw",
        title: `${scores[0]} – ${scores[1]}`,
        sub: def.name,
        rows: scores.map((s, j) => ({ label: `Player ${j + 1}`, value: String(s), win: winner === j + 1 })),
      });
    }

    // The top bar has room for a couple of numbers a side: the score, and
    // whatever says how close that player is to being out.
    const URGENT = ["lives", "tries", "time"];
    const laneStats = (lane, i) => {
      const list = lane.game.stats?.() ?? [];
      const score = list.find((s) => s.k === "score");
      const extra = list.find((s) => URGENT.includes(s.k)) ?? list.find((s) => s !== score && !s.html);
      return [score, extra].filter(Boolean)
        .map((s, j) => ({ ...s, k: `P${i + 1} ${s.k}`, cls: j === 0 ? `p${i + 1}` : "" }));
    };

    return {
      autoPause: lanes[0].game.autoPause,
      tick(dt) {
        for (const l of lanes) {
          l.kit.update(dt);
          l.input.sync(l.kit.offset);
        }
      },
      update(dt, now) {
        for (const l of lanes) {
          if (l.result) l.game.idle?.(dt, now);
          else l.game.update(dt, now);
        }
      },
      idle(dt, now) { for (const l of lanes) l.game.idle?.(dt, now); },
      cursors() { for (const l of lanes) l.game.cursors?.(); },
      stats: () => lanes.flatMap(laneStats),
      dispose() {
        for (const l of lanes) {
          l.game.dispose?.();
          l.kit.dispose();
        }
      },
    };
  }

  /** @param {{game:string, players?:1|2, online?:object, net?:object}} route */
  function start(route) {
    def = gameById(route.game);
    if (!def || !IMPL[def.id]) { console.warn("no such game", route.game); return false; }
    players = route.players === 2 ? 2 : 1;
    split = players === 2 && !def.versus;
    online = !!route.online;
    net = route.net ?? null;
    sfx.unlock();
    ui.open(def, players);
    build();
    lastNow = 0;
    if (online) {
      beginCount(performance.now(), true);
    } else {
      phase = "intro";
      phaseAt = performance.now();
      ui.intro(def, players === 1 ? bestOf(def.id) : 0);
    }
    return true;
  }

  function stop() {
    game?.dispose?.();
    game = null;
    kit.clear();
    phase = "off";
    online = false;
    net = null;
    ui.close();
  }

  /** @param {boolean} [fresh] a new game, not a pause ending: reported as a start */
  function beginCount(now, fresh = false) {
    if (fresh) {
      try { report?.({ type: "start", mode: def.id, players, online }); } catch (err) { console.warn(err); }
    }
    phase = "count";
    phaseAt = now;
    shownCount = -1;
    ui.setPaused(false);
  }

  function go(now) {
    if (phase === "intro") beginCount(now, true);
    else if (phase === "paused") beginCount(now);
    else if (phase === "over" && !online) again(now);
  }

  function again(now) {
    build();
    beginCount(now, true);
  }

  function pause(reason, now) {
    phase = "paused";
    phaseAt = now;
    pauseReason = reason;
    handsBackAt = 0;
    ui.setPaused(true);
    ui.paused(reason);
  }

  function togglePause(now) {
    if (online) return;
    if (phase === "play") pause("manual", now);
    else if (phase === "paused") beginCount(now);
  }

  function toggleMute() {
    sfx.setMuted(!sfx.muted);
    ui.setMute(sfx.muted);
  }

  function finish(result = {}) {
    if (phase === "over") return;
    const now = performance.now();
    phase = "over";
    phaseAt = now;
    const scored = players === 1 && !online && Number.isFinite(result.score);
    const best = scored && recordBest(def.id, result.score);
    const rows = [...(result.rows ?? [])];
    if (scored) rows.push({ label: "best", value: String(bestOf(def.id)), win: best });
    ui.gameOver({ ...result, rows: rows.length ? rows : null, best, again: !online });
    if (best) sfx.win();
    try {
      report?.({ type: "end", mode: def.id, players, online, score: result.score ?? null, result });
    } catch (err) { console.warn(err); }
  }

  /** Once per rendered frame with `gestures.hands`. */
  function frame(hands, now) {
    if (phase === "off" || !game) return;
    const dt = lastNow ? Math.min((now - lastNow) / 1000, 0.05) : 0;
    lastNow = now;

    input.update(hands, now);
    kit.update(dt);
    game.tick?.(dt);

    switch (phase) {
      case "intro":
        game.idle?.(dt, now);
        if (now - phaseAt > 700) {
          ui.showCta();
          if (input.anyJustPinch) beginCount(now, true);
        }
        break;

      case "count": {
        game.idle?.(dt, now);
        const n = 3 - Math.floor((now - phaseAt) / COUNT_STEP_MS);
        if (n <= 0) {
          phase = "play";
          phaseAt = now;
          // A game that starts with nobody in view should pause at once, but
          // one that starts with hands up must not pause on a stale clock.
          if (input.visible) input.lastSeenAt = now;
          ui.hideOverlay();
          sfx.go();
          break;
        }
        if (n !== shownCount) {
          shownCount = n;
          ui.countdown(n);
          sfx.tick();
        }
        break;
      }

      case "play":
        if (game.autoPause !== false && !net && now - input.lastSeenAt > LOST_HANDS_MS) {
          pause("hands", now);
          break;
        }
        game.update(dt, now);
        break;

      case "paused":
        game.idle?.(dt, now);
        if (pauseReason === "hands") {
          if (input.visible) {
            handsBackAt ||= now;
            if (now - handsBackAt > HANDS_BACK_MS) beginCount(now);
          } else handsBackAt = 0;
        } else if (now - phaseAt > 600) {
          ui.showCta();
          if (input.anyJustPinch) beginCount(now);
        }
        break;

      case "over":
        game.idle?.(dt, now);
        // Long enough that a hand still mid-pinch when the game ended (Pop
        // Rush ends mid-frenzy) cannot restart it by accident.
        if (!online && now - phaseAt > 2500) {
          ui.showCta();
          if (input.anyJustPinch) again(now);
        }
        break;
    }

    game?.cursors?.();
    if (game && now - statsAt > 100) {
      statsAt = now;
      ui.setStats(game.stats?.() ?? []);
      // Sound can be flipped from outside (the M key), so the button follows it.
      ui.setMute(sfx.muted);
    }
  }

  /** Keys while a game is up. Returns true when it used the key. */
  function key(e) {
    if (phase === "off") return false;
    const now = performance.now();
    if (e.key === "p" || e.key === "P") { togglePause(now); return true; }
    // M is left to main.js: it is the app-wide sound toggle, with its toast.
    if (e.key === " " || e.key === "Enter") {
      if (phase === "play") return false;
      go(now);
      return true;
    }
    return false;
  }

  return {
    start, stop, frame, key,
    get running() { return phase !== "off"; },
    get phase() { return phase; },
    get game() { return game; },
    get id() { return def?.id ?? null; },
    /** The number a live scoreboard shows: the game's own "score" stat. */
    get score() {
      const s = game?.stats?.().find((x) => x.k === "score");
      return Number.isFinite(+s?.v) ? +s.v : 0;
    },
    input, kit,
  };
}
