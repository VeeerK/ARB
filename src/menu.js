/**
 * The start menu, and the routing between every top-level mode.
 *
 * The app used to have exactly one screen, so `#gate` (enable camera) was the
 * whole front door. Now the front door is a menu and the camera gate is a step
 * *inside* whichever route you picked — nothing asks for the camera until you
 * have chosen something that needs it.
 *
 * This file owns only presentation: which panel is visible, what it says, and
 * which route the click means. It never touches the tracker, the builder, or
 * the scene. `onLaunch(route)` hands the chosen route back to main.js, which is
 * the only place that knows how to actually start anything.
 *
 * A route is `{ mode, ... }`:
 *   { mode: "freestyle" }                             — the open canvas
 *   { mode: "play", players: 1, difficulty, from }     — a solo run, from a level
 *   { mode: "play", players: 2 }                       — a versus run (mixed ladder)
 *   { mode: "play", players: 1, kind: "rush" }         — shape rush
 *   { mode: "play", players: 1, kind: "daily" }        — today's daily challenge
 *   { mode: "play", players: 1, kind: "memory" | "copy" | "balance" } — challenges
 *   { mode: "tutorial" }                               — freestyle, tutorial opened
 */

import {
  PACKS, ALL_LEVELS, DIFFICULTIES, DIFFICULTY_LABEL, levelAt, levelArt, shapeSvg, todayKey,
} from "./levels.js";
import {
  settings, setColor, setAutoP2, resetColors, onSettingsChange, setSound, setSnap,
  SWATCH_KEYS, SWATCH_LABEL, SWATCH_NOTE, PRESETS,
} from "./settings.js";
import {
  levelRecord, starsIn, starText, rushBest, dailyRecord, modeBest, resetProgress, onProgressChange,
} from "./progress.js";
import { GAMES, gameArt, bestOf } from "./arcade/catalog.js";

// ---- the play screen's contents -------------------------------------------

const TABS = [
  { id: "levels", label: "Levels", note: "Build the target shown at the top. Faster builds earn more stars." },
  { id: "challenge", label: "Challenges", note: "Short runs with one twist each. Bests are saved on this device." },
  { id: "arcade", label: "Arcade", note: "Classic games, re-ruled for your hands · pinch to start · P pause · Esc menu" },
];

const svg = (inner) => `<svg viewBox="0 0 120 100" class="goal-svg" aria-hidden="true">${inner}</svg>`;
const line = (x1, y1, x2, y2, extra = "") =>
  `<line class="goal-shape" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" ${extra} />`;
const dashed = (shape) => shape.replace(" />", ' stroke-dasharray="3 4" />');

/** Card art for the modes that are not arcade games, on the same 120x100 stage. */
const MODE_ART = {
  solo: () => levelArt(levelAt(5, "medium")),
  versus: () => svg(
    shapeSvg("box", 32, 70, 30) + shapeSvg("circle", 32, 42, 22) +
    line(60, 8, 60, 92, 'stroke-dasharray="4 5"') +
    shapeSvg("box", 88, 70, 30) + shapeSvg("triangle", 88, 42, 24)),
  daily: () => svg(
    `<rect class="goal-shape" x="26" y="18" width="68" height="68" rx="3" />` +
    line(26, 36, 94, 36) + line(44, 10, 44, 24) + line(76, 10, 76, 24) +
    shapeSvg("box", 46, 52, 12) + shapeSvg("circle", 74, 52, 12) + shapeSvg("triangle", 46, 72, 12)),
  rush: () => svg(
    `<circle class="goal-shape" cx="60" cy="56" r="34" />` +
    line(60, 56, 60, 32) + line(60, 56, 78, 64) + line(52, 12, 68, 12) + line(60, 12, 60, 22)),
  memory: () => svg(shapeSvg("circle", 60, 34, 26) + dashed(shapeSvg("box", 60, 72, 36))),
  copy: () => svg(dashed(shapeSvg("box", 56, 50, 52)) + shapeSvg("box", 64, 58, 44)),
  balance: () => svg(
    line(12, 64, 108, 56) + `<polygon class="goal-shape" points="60,61 50,82 70,82" />` +
    shapeSvg("box", 26, 51, 22, -4.8) + shapeSvg("circle", 92, 49, 16)),
};

const best = (k, v) => (v ? { k, v } : null);

/**
 * Every card on the play screen, in order. `go` routes through the click
 * switch below; `game` launches an arcade-engine game straight from the
 * catalog, which decides its tab by `section`.
 */
const PLAY_ITEMS = [
  { tab: "levels", go: "solo", key: "1P · 30 levels", name: "One player",
    desc: "Ten themes in three difficulties. Pick a level and play on from there.",
    art: MODE_ART.solo,
    best: () => best("stars", `${starsIn(ALL_LEVELS.map((l) => l.id))}/${ALL_LEVELS.length * 3}`) },
  { tab: "levels", go: "versus", key: "2P · split screen", name: "Two players",
    desc: "A fresh mix of levels every game, climbing easy to hard. Left half against right.",
    art: MODE_ART.versus },
  { tab: "levels", go: "daily", key: "5 levels · daily", name: "Daily challenge",
    desc: "The same five levels for everyone today. Share your stars.",
    art: MODE_ART.daily,
    best: () => best("today", dailyRecord(todayKey())?.score) },
  { tab: "challenge", go: "rush", key: "timed", name: "Shape rush",
    desc: "Beat the clock. Every shape you build adds time back.",
    art: MODE_ART.rush, best: () => best("best", rushBest()) },
  { tab: "challenge", go: "memory", key: "8 rounds", name: "Memory",
    desc: "See the target for a few seconds, then build it with the picture hidden.",
    art: MODE_ART.memory, best: () => best("best", modeBest("memory")) },
  { tab: "challenge", go: "copy", key: "8 rounds", name: "Copy the shape",
    desc: "Fill each outline on screen exactly: shape, size, spot and angle.",
    art: MODE_ART.copy, best: () => best("best", modeBest("copy")) },
  { tab: "challenge", go: "balance", key: "6 rounds", name: "Balance scale",
    desc: "Build shapes on a seesaw until the beam is level. Further out pulls harder.",
    art: MODE_ART.balance, best: () => best("best", modeBest("balance")) },
  ...GAMES.map((g) => ({
    tab: g.section === "retro" ? "arcade" : "challenge",
    game: g.id, key: `after ${g.after}`, name: g.name, desc: g.desc,
    art: () => gameArt(g.id), best: () => best("best", bestOf(g.id)),
    versus: g.players?.includes(2),
  })),
];

function playCard(it) {
  const b = it.best?.();
  const body = `
    <span class="ac-art">${it.art()}</span>
    <span class="ac-body">
      <span class="mc-key">${it.key}</span>
      <span class="ac-name">${it.name}</span>
      <span class="ac-desc">${it.desc}</span>
      ${it.versus ? `<span class="ac-modes">
        <button class="ac-mode" data-game="${it.game}" data-players="1">1P vs cpu</button>
        <button class="ac-mode" data-game="${it.game}" data-players="2">2P split screen</button>
      </span>` : ""}
    </span>
    <span class="ac-best">${b ? `<span class="mc-key">${b.k}</span>${b.v}` : ""}</span>`;
  // A card with its own mode buttons cannot itself be a button.
  if (it.versus) return `<div class="ac-card has-modes">${body}</div>`;
  const route = it.game ? `data-game="${it.game}" data-players="1"` : `data-go="${it.go}"`;
  return `<button class="ac-card" ${route}>${body}</button>`;
}

const MENU_HTML = `
  <div class="menu-wrap">
    <div class="menu-brand">
      <img class="menu-mark" src="./assets/logo-mark.svg" alt="" width="40" height="42" />
      <h1>Air Blocks</h1>
      <p class="menu-tag">Hand-tracked block building. No controller, no mouse.</p>
    </div>

    <!-- Every screen ships in the DOM and is toggled, rather than re-rendered,
         so going back never rebuilds a panel mid-animation. -->
    <section class="menu-screen" data-screen="home">
      <div class="menu-grid">
        <button class="menu-card" data-go="freestyle">
          <span class="mc-key">01</span>
          <span class="mc-name">Freestyle</span>
          <span class="mc-desc">Open canvas. Build whatever, no rules, no timer.</span>
        </button>
        <button class="menu-card" data-go="play">
          <span class="mc-key">02</span>
          <span class="mc-name">Play</span>
          <span class="mc-desc">Levels, challenges and arcade games. Solo or head-to-head.</span>
        </button>
        <button class="menu-card" data-go="tutorial">
          <span class="mc-key">03</span>
          <span class="mc-name">Tutorial</span>
          <span class="mc-desc">Learn every gesture, one at a time, with your own hands.</span>
        </button>
        <button class="menu-card" data-go="settings">
          <span class="mc-key">04</span>
          <span class="mc-name">Settings</span>
          <span class="mc-desc">Your block colours, for one player and for two.</span>
        </button>
        <button class="menu-card" data-go="online">
          <span class="mc-key">05</span>
          <span class="mc-name">Online</span>
          <span class="mc-desc">Rooms with friends, or a quick match with anyone.</span>
        </button>
        <button class="menu-card" data-go="boards">
          <span class="mc-key">06</span>
          <span class="mc-name">Leaderboards</span>
          <span class="mc-desc">The level ladder, today's daily, and every game's best.</span>
        </button>
      </div>
      <p class="menu-fine">Chrome or Edge recommended &middot; your camera feed never leaves your machine</p>
    </section>

    <!-- Everything playable, on one screen. Three tabs sort it by what you are
         doing — building a target, a short twist on building, or a game — and
         every card has the same parts: art, name, blurb, best. The grid is
         rebuilt from PLAY_ITEMS on every paint, because the bests change every
         time a run ends. -->
    <section class="menu-screen hidden" data-screen="play">
      <div class="menu-head">
        <button class="menu-back" data-back="home">&larr; back</button>
        <span class="menu-crumb">play</span>
        <div class="seg" data-tabs role="tablist"></div>
      </div>
      <p class="menu-fine play-note" data-tab-note></p>
      <div class="play-tabs" data-play-grid></div>
    </section>

    <!-- Level select: ten themes down the page, three difficulties across the
         top. The difficulty is a property of the whole screen rather than of a
         card, because it is the thing you change most and re-picking it on
         every card would be ten clicks to answer one question. -->
    <section class="menu-screen hidden" data-screen="levels">
      <div class="menu-head">
        <button class="menu-back" data-back="play">&larr; back</button>
        <span class="menu-crumb">one player</span>
        <span class="menu-stars" data-stars></span>
        <div class="seg" data-diffs></div>
      </div>
      <div class="lv-grid" data-levels></div>
      <div class="menu-actions">
        <button class="menu-btn" data-run-all>Run all ten &rarr;</button>
        <span class="menu-fine">Picking a level starts the run there and carries on to level 10.</span>
      </div>
    </section>

    <section class="menu-screen hidden" data-screen="settings">
      <div class="menu-head">
        <button class="menu-back" data-back="home">&larr; back</button>
        <span class="menu-crumb">settings</span>
      </div>
      <div class="set-game">
        <label class="set-opt">
          <input type="checkbox" data-opt="sound">
          <span class="sw-text">
            <span class="sw-name">Sound</span>
            <span class="sw-note">Pops, clicks and chimes. M turns it on or off in game.</span>
          </span>
        </label>
        <label class="set-opt">
          <input type="checkbox" data-opt="snap">
          <span class="sw-text">
            <span class="sw-name">Grid snap</span>
            <span class="sw-note">Blocks settle onto a grid when you let go. G turns it on or off in game.</span>
          </span>
        </label>
        <div class="set-opt set-reset">
          <span class="sw-text">
            <span class="sw-name">Progress</span>
            <span class="sw-note">Stars, best scores and daily results on this device.</span>
          </span>
          <button class="menu-btn ghost" data-reset-progress>reset</button>
        </div>
      </div>
      <div class="set-cols">
        <div class="set-col" data-player="1">
          <div class="set-head">
            <span class="set-who">Player 1</span>
            <span class="set-note">your blocks</span>
          </div>
          <div class="set-swatches" data-swatches="1"></div>
          <div class="set-presets" data-presets="1"></div>
        </div>
        <div class="set-col" data-player="2">
          <div class="set-head">
            <span class="set-who">Player 2</span>
            <label class="set-toggle">
              <input type="checkbox" data-auto-p2 checked>
              <span>mirror player 1</span>
            </label>
          </div>
          <div class="set-swatches" data-swatches="2"></div>
          <div class="set-presets" data-presets="2"></div>
          <p class="menu-fine" data-p2-note>
            Player 2 gets the opposite of player 1 — same colours, half a turn round
            the wheel. Untick to choose their own.
          </p>
        </div>
      </div>
      <div class="menu-actions">
        <button class="menu-btn ghost" data-reset-colors>Reset to defaults</button>
        <span class="menu-fine">Saved on this device. Deleting stays red for both players.</span>
      </div>
    </section>
  </div>

  <!-- Phones hold the split-screen two-player layout badly in portrait: each
       half ends up a letterbox with no room for a pair of hands. The prompt is
       a suggestion, not a wall — "play anyway" is always right there. -->
  <div class="menu-rotate hidden" data-rotate>
    <div class="rot-card">
      <div class="rot-icon" aria-hidden="true">
        <svg viewBox="0 0 120 90" class="rot-svg">
          <rect class="rot-phone" x="44" y="8" width="32" height="58" rx="5" />
          <rect class="rot-phone rot-ghost" x="26" y="26" width="58" height="32" rx="5"
                transform="translate(18 0)" />
          <path class="rot-arrow" d="M30,70 A34,34 0 0 1 90,70" />
        </svg>
      </div>
      <div class="rot-title">Turn your phone sideways</div>
      <p class="rot-body">Two players share the screen left and right. Landscape gives each side room for a hand.</p>
      <div class="rot-btns">
        <button class="menu-btn ghost" data-rot-cancel>back</button>
        <button class="menu-btn" data-rot-go>play anyway</button>
      </div>
    </div>
  </div>
`;

export function initMenu({ onLaunch, onOnline = null }) {
  const root = document.createElement("div");
  root.id = "menu";
  root.innerHTML = MENU_HTML;
  document.body.appendChild(root);

  const q = (sel) => root.querySelector(sel);
  const screens = [...root.querySelectorAll(".menu-screen")];
  const rotate = q("[data-rotate]");
  let pending = null;           // route waiting on the rotate prompt
  let difficulty = "easy";      // the level screen's current tab

  function show(name) {
    for (const s of screens) s.classList.toggle("hidden", s.dataset.screen !== name);
  }

  // ---- level select ----

  const diffBar = q("[data-diffs]");
  diffBar.innerHTML = DIFFICULTIES.map((d) =>
    `<button class="seg-btn" data-diff="${d}">${DIFFICULTY_LABEL[d]}</button>`).join("");

  const levelGrid = q("[data-levels]");

  function paintLevels() {
    for (const b of diffBar.children) b.classList.toggle("on", b.dataset.diff === difficulty);
    levelGrid.dataset.diff = difficulty;
    const ids = PACKS.map((_, i) => levelAt(i, difficulty).id);
    q("[data-stars]").textContent = `★ ${starsIn(ids)} / ${ids.length * 3}`;
    levelGrid.innerHTML = PACKS.map((pack, i) => {
      const lv = levelAt(i, difficulty);
      const rec = levelRecord(lv.id);
      return `
        <button class="lv-card${rec ? " done" : ""}" data-level="${i}">
          <span class="lv-n">${String(i + 1).padStart(2, "0")}</span>
          <span class="lv-art">${levelArt(lv)}</span>
          <span class="lv-body">
            <span class="lv-name">${lv.title}</span>
            <span class="lv-brief">${lv.brief}</span>
          </span>
          <span class="lv-side">
            <span class="lv-stars" title="${rec ? `best ${rec.time}s` : "not built yet"}">${starText(rec?.stars ?? 0)}</span>
            <span class="lv-pts">${rec ? `best ${rec.best}` : lv.points}</span>
          </span>
        </button>`;
    }).join("");
  }
  paintLevels();

  // ---- play: tabs of cards ----

  let tab = TABS[0].id;
  const tabBar = q("[data-tabs]");
  tabBar.innerHTML = TABS.map((t) =>
    `<button class="seg-btn" role="tab" data-tab="${t.id}">${t.label}</button>`).join("");

  function paintPlay() {
    for (const b of tabBar.children) {
      const on = b.dataset.tab === tab;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    }
    // Every tab is rendered, stacked in one cell, and only the chosen one is
    // visible: the stack is as tall as the longest tab, so switching never
    // makes the centred menu jump.
    q("[data-play-grid]").innerHTML = TABS.map((t) => `
      <div class="ac-grid${t.id === tab ? "" : " off"}" role="tabpanel">
        ${PLAY_ITEMS.filter((it) => it.tab === t.id).map(playCard).join("")}
      </div>`).join("");
    q("[data-tab-note]").textContent = TABS.find((t) => t.id === tab).note;
  }
  paintPlay();

  onProgressChange(() => { paintLevels(); paintPlay(); });

  const soloRoute = (from) => ({ mode: "play", players: 1, difficulty, from });

  // ---- settings ----

  function swatchRow(player, key, value, disabled) {
    return `
      <label class="sw ${disabled ? "off" : ""}">
        <input type="color" value="${value}" data-swatch="${player}:${key}" ${disabled ? "disabled" : ""}>
        <span class="sw-text">
          <span class="sw-name">${SWATCH_LABEL[key]}</span>
          <span class="sw-note">${SWATCH_NOTE[key]}</span>
        </span>
        <span class="sw-hex">${value}</span>
      </label>`;
  }

  // Built once. Every later change PATCHES these nodes rather than re-rendering
  // them: a native colour picker fires `input` continuously while it is open,
  // and rebuilding the row you are dragging would tear the picker out from
  // under your cursor on the first tick.
  for (const player of [1, 2]) {
    const palette = player === 1 ? settings.p1 : settings.p2;
    q(`[data-swatches="${player}"]`).innerHTML =
      SWATCH_KEYS.map((k) => swatchRow(player, k, palette[k], false)).join("");
    q(`[data-presets="${player}"]`).innerHTML = PRESETS.map((p) => `
      <button class="preset" data-preset="${player}:${p.name}" title="${p.name}">
        <i style="background:${p.idle}"></i><i style="background:${p.held}"></i>
      </button>`).join("");
  }

  function paintSettings() {
    q('[data-opt="sound"]').checked = settings.sound;
    q('[data-opt="snap"]').checked = settings.snap;
    const auto = settings.autoP2;
    q("[data-auto-p2]").checked = auto;
    q("[data-p2-note]").classList.toggle("hidden", !auto);
    root.querySelector('.set-col[data-player="2"]').classList.toggle("mirrored", auto);

    for (const player of [1, 2]) {
      const palette = player === 1 ? settings.p1 : settings.p2;
      // Player 2's swatches show the mirrored colours while auto is on, but
      // cannot be edited: what you would be editing is player 1's pick.
      const locked = player === 2 && auto;
      for (const key of SWATCH_KEYS) {
        const input = q(`[data-swatch="${player}:${key}"]`);
        if (!input) continue;
        if (input.value.toLowerCase() !== palette[key].toLowerCase()) input.value = palette[key];
        input.disabled = locked;
        input.closest(".sw").classList.toggle("off", locked);
        input.closest(".sw").querySelector(".sw-hex").textContent = palette[key];
      }
      for (const btn of root.querySelectorAll(`[data-preset^="${player}:"]`)) btn.disabled = locked;
    }
  }
  paintSettings();
  onSettingsChange(paintSettings);

  root.addEventListener("input", (e) => {
    const swatch = e.target.dataset?.swatch;
    if (!swatch) return;
    const [player, key] = swatch.split(":");
    setColor(Number(player), key, e.target.value);
  });

  root.addEventListener("change", (e) => {
    if (e.target.matches("[data-auto-p2]")) setAutoP2(e.target.checked);
    if (e.target.matches('[data-opt="sound"]')) setSound(e.target.checked);
    if (e.target.matches('[data-opt="snap"]')) setSnap(e.target.checked);
  });

  // Resetting progress cannot be undone, so it takes two presses: the first
  // arms the button and says so, and it disarms itself if you walk away.
  const resetBtn = q("[data-reset-progress]");
  let resetTimer = 0;
  function disarmReset() {
    clearTimeout(resetTimer);
    resetBtn.textContent = "reset";
    resetBtn.classList.remove("armed");
  }

  // ---- routing ----

  // A phone in portrait. Width is the real test — a narrow window on a desktop
  // splits just as badly — but the *advice* only makes sense where the device
  // can actually turn, so coarse pointers only.
  const wantsRotate = () =>
    window.matchMedia("(pointer: coarse)").matches
    && window.innerHeight > window.innerWidth;

  function askRotate(route) {
    pending = route;
    rotate.classList.remove("hidden");
  }

  // The screen a run was started from, so leaving the run lands back on the
  // same tab or level list instead of at the top of the menu.
  let returnTo = "home";
  const current = () => screens.find((s) => !s.classList.contains("hidden"))?.dataset.screen ?? "home";

  function launch(route) {
    returnTo = current();
    pending = null;
    rotate.classList.add("hidden");
    close();
    onLaunch(route);
  }

  root.addEventListener("click", (e) => {
    const go = e.target.closest("[data-go]")?.dataset.go;
    const back = e.target.closest("[data-back]")?.dataset.back;

    if (back) { show(back); return; }
    const pickTab = e.target.closest("[data-tab]")?.dataset.tab;
    if (pickTab) { tab = pickTab; paintPlay(); return; }
    if (e.target.closest("[data-rot-cancel]")) {
      pending = null;
      rotate.classList.add("hidden");
      return;
    }
    if (e.target.closest("[data-rot-go]")) { if (pending) launch(pending); return; }

    const game = e.target.closest("[data-game]");
    if (game) {
      const route = { mode: "arcade", game: game.dataset.game, players: Number(game.dataset.players) === 2 ? 2 : 1 };
      if (route.players === 2 && wantsRotate()) askRotate(route);
      else launch(route);
      return;
    }

    const diff = e.target.closest("[data-diff]")?.dataset.diff;
    if (diff) { difficulty = diff; paintLevels(); return; }

    const card = e.target.closest("[data-level]");
    if (card) { launch(soloRoute(Number(card.dataset.level))); return; }
    if (e.target.closest("[data-run-all]")) { launch(soloRoute(0)); return; }

    const preset = e.target.closest("[data-preset]")?.dataset.preset;
    if (preset) {
      const [player, name] = preset.split(":");
      const p = PRESETS.find((x) => x.name === name);
      if (p) for (const k of SWATCH_KEYS) setColor(Number(player), k, p[k]);
      return;
    }
    if (e.target.closest("[data-reset-colors]")) { resetColors(); return; }
    if (e.target.closest("[data-reset-progress]")) {
      if (resetBtn.classList.contains("armed")) {
        resetProgress();
        disarmReset();
        resetBtn.textContent = "cleared";
      } else {
        resetBtn.textContent = "press again to erase";
        resetBtn.classList.add("armed");
        clearTimeout(resetTimer);
        resetTimer = setTimeout(disarmReset, 3000);
      }
      return;
    }

    switch (go) {
      case "play":      paintPlay(); show("play"); break;
      case "settings":  show("settings"); break;
      case "online":    close(); onOnline?.("hub"); break;
      case "boards":    close(); onOnline?.("boards"); break;
      case "freestyle": launch({ mode: "freestyle" }); break;
      case "tutorial":  launch({ mode: "tutorial" }); break;
      case "solo":      show("levels"); break;
      case "rush":      launch({ mode: "play", players: 1, kind: "rush" }); break;
      case "daily":     launch({ mode: "play", players: 1, kind: "daily" }); break;
      case "memory":
      case "copy":
      case "balance":   launch({ mode: "play", players: 1, kind: go }); break;
      case "versus": {
        const route = { mode: "play", players: 2 };
        if (wantsRotate()) askRotate(route);
        else launch(route);
        break;
      }
    }
  });

  // Turning the phone while the prompt is up answers it, so nobody has to
  // dismiss a hint they have already acted on.
  window.addEventListener("orientationchange", () => {
    if (pending && !wantsRotate()) setTimeout(() => pending && launch(pending), 250);
  });

  // Esc steps back one screen (or dismisses the rotate prompt). Only while the
  // menu is up: in a mode, main.js owns Esc.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || root.classList.contains("hidden")) return;
    if (!rotate.classList.contains("hidden")) {
      pending = null;
      rotate.classList.add("hidden");
      return;
    }
    const back = screens.find((s) => s.dataset.screen === current())?.querySelector("[data-back]")?.dataset.back;
    if (back) show(back);
  });

  function open(screen = returnTo) {
    show(screen);
    // The date may have rolled over, and a run may have set a new best.
    paintLevels();
    paintPlay();
    disarmReset();
    pending = null;
    rotate.classList.add("hidden");
    root.classList.remove("hidden");
    document.body.classList.add("menu-up");
  }

  function close() {
    root.classList.add("hidden");
    document.body.classList.remove("menu-up");
  }

  return {
    open,
    close,
    isOpen: () => !root.classList.contains("hidden"),
  };
}
