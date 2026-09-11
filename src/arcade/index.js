import { makeKit } from "./kit.js";
import { Input } from "./input.js";
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

export function initArcade({ scene, onQuit }) {
  const kit = makeKit(scene);
  const input = new Input(scene);

  let def = null;
  let game = null;
  let players = 1;
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
    banner: (text, tone, ms) => ui.banner(text, tone, ms),
    popAt: (x, y, text, tone) => ui.pop(kit.toCss(x, y), text, tone),
    mount: (el) => ui.mount(el),
    end: (result) => finish(result),
  };

  function build() {
    game?.dispose?.();
    kit.clear();
    ui.clearLayer();
    game = IMPL[def.id](ctx);
  }

  /** @param {{game:string, players?:1|2}} route */
  function start(route) {
    def = gameById(route.game);
    if (!def || !IMPL[def.id]) { console.warn("no such game", route.game); return false; }
    players = route.players === 2 ? 2 : 1;
    sfx.unlock();
    ui.open(def, players);
    build();
    phase = "intro";
    phaseAt = performance.now();
    lastNow = 0;
    ui.intro(def, players === 1 ? bestOf(def.id) : 0);
    return true;
  }

  function stop() {
    game?.dispose?.();
    game = null;
    kit.clear();
    phase = "off";
    ui.close();
  }

  function beginCount(now) {
    phase = "count";
    phaseAt = now;
    shownCount = -1;
    ui.setPaused(false);
  }

  function go(now) {
    if (phase === "intro") beginCount(now);
    else if (phase === "paused") beginCount(now);
    else if (phase === "over") again(now);
  }

  function again(now) {
    build();
    beginCount(now);
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
    const scored = players === 1 && Number.isFinite(result.score);
    const best = scored && recordBest(def.id, result.score);
    const rows = [...(result.rows ?? [])];
    if (scored) rows.push({ label: "best", value: String(bestOf(def.id)), win: best });
    ui.gameOver({ ...result, rows: rows.length ? rows : null, best });
    if (best) sfx.win();
  }

  /** Once per rendered frame with `gestures.hands`. */
  function frame(hands, now) {
    if (phase === "off" || !game) return;
    const dt = lastNow ? Math.min((now - lastNow) / 1000, 0.05) : 0;
    lastNow = now;

    input.update(hands, now);
    kit.update(dt);

    switch (phase) {
      case "intro":
        game.idle?.(dt, now);
        if (now - phaseAt > 700) {
          ui.showCta();
          if (input.anyJustPinch) beginCount(now);
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
        if (game.autoPause !== false && now - input.lastSeenAt > LOST_HANDS_MS) {
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
        if (now - phaseAt > 2500) {
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
    input, kit,
  };
}
