import { HandTracker } from "./hand-tracking.js";
import { Overlay2D } from "./overlay2d.js";
import { GestureEngine, TUNING, POSE } from "./gestures.js";
import { Scene } from "./scene.js";
import { Builder } from "./builder.js";
import { ShapePicker, SHAPE_LABEL } from "./picker.js";
import { initTutorial } from "./tutorial.js";
import { initMenu } from "./menu.js";
import { initPlay } from "./play.js";
import { initSession } from "./session.js";
import { loadSettings, settings, setLight, setSnap, setSound } from "./settings.js";
import { initRingLight } from "./ringlight.js";
import { initSound } from "./sound.js";
import { ladder, mixedLadder, dailyLadder, todayKey, memoryLadder } from "./levels.js";
import { copyLadder } from "./modes/copy.js";
import { balanceLadder } from "./modes/balance.js";

/** Challenge modes: each a solo run over a ladder drawn fresh every start. */
const CHALLENGE_LADDERS = { memory: memoryLadder, copy: () => copyLadder(), balance: balanceLadder };
import { initArcade } from "./arcade/index.js";
import { gameById } from "./arcade/catalog.js";

const el = {
  video: document.getElementById("webcam"),
  overlay: document.getElementById("overlay2d"),
  gate: document.getElementById("gate"),
  gateNote: document.getElementById("gate-note"),
  gateMode: document.getElementById("gate-mode"),
  gateBack: document.getElementById("gate-back"),
  toMenu: document.getElementById("to-menu"),
  start: document.getElementById("start"),
  status: document.getElementById("s-status"),
  fps: document.getElementById("s-fps"),
  hands: document.getElementById("s-hands"),
  metrics: document.getElementById("s-metrics"),
  three: document.getElementById("three"),
  blocks: document.getElementById("s-blocks"),
  action: document.getElementById("s-action"),
  shape: document.getElementById("s-shape"),
  options: document.getElementById("s-options"),
  toast: document.getElementById("toast"),
};

// Block colours come out of storage before anything is built, so the first
// block of the session is already in the player's own colour.
loadSettings();

// The screen as a lamp, for players in a dim room. Owned here rather than by
// the tracker because it is not a tracking setting — it is the room.
const ringLight = initRingLight({ level: settings.light, onChange: setLight });

// Every effect goes through here, and it checks the setting itself on each
// play, so turning sound off takes effect mid-sound-storm.
const sound = initSound({ isOn: () => settings.sound });

const overlay = new Overlay2D(el.overlay);
const scene = new Scene(el.three);

/**
 * A "rig" is one player: the builder that owns their blocks and the shape
 * picker that answers only to their hands. Freestyle and one-player run a
 * single rig with no zone — every hand, every block. Two-player runs two, one
 * per half of the screen, and the split is enforced inside Builder (see its
 * `zone` option) rather than by anything here.
 */
const makeRig = ({ zone = null, theme = "p1" } = {}) => {
  const builder = new Builder(scene, {
    zone, theme,
    snap: () => settings.snap,
    onEvent: (type) => sound.play(type),
  });
  const picker = new ShapePicker({
    zone,
    shape: builder.shape,
    onPick: (shape) => {
      builder.shape = shape;
      sound.play("pick");
      console.log(`%c${zone ?? "solo"} shape -> ${SHAPE_LABEL[shape]}`, "color:#5fa");
    },
  });
  return { builder, picker, zone };
};

const solo = makeRig();
const builder = solo.builder;      // what the HUD, the tutorial and ARB mean
const picker = solo.picker;

/** The rigs being driven this frame. Swapped wholesale on a route change. */
let rigs = [solo];
const useRigs = (next) => {
  rigs = next;
  overlay.pickers = next.map((r) => r.picker);
  overlay.zones = next.length > 1;
};
useRigs(rigs);

// The HUD is a fixed panel whose height depends on what is in it, and in
// two-player it shares a corner with player 1's score panel. Publishing its
// measured height lets the stylesheet move that panel clear of it, without
// either side hard-coding a number that goes stale the moment a row is added.
const hudEl = document.getElementById("hud");
function syncHudHeight() {
  // Border box, not content box: what has to be cleared is the outer edge,
  // padding and hairline included. A collapsed panel measures zero and is
  // ignored — the value only has to be right while the panel is up.
  const h = hudEl.getBoundingClientRect().height;
  if (h) document.documentElement.style.setProperty("--hud-h", `${h}px`);
}
window.addEventListener("resize", syncHudHeight);

// The tutorial and the HUD's collapse toggle. Everything it needs already
// exists in the DOM; it only owns the panel it creates.
const tutorial = initTutorial({
  // The tutorial only READS these: each practice step waits on the same state
  // the HUD shows, so it can never accept a gesture the app itself rejected.
  api: { builder, picker },
  hud: hudEl,
  openBtn: document.getElementById("tut-open"),
  closeBtn: document.getElementById("hud-close"),
  reopenBtn: document.getElementById("hud-open"),
  // Every route in and out of the panel — the header toggle, the hamburger,
  // and the H key — comes back through here.
  onHud: (open) => { if (open) syncHudHeight(); },
});
let hudAt = 0;

const POSE_COLOR = { pinch: "#5fa", fist: "#fc6", open: "#7fd4ff", none: "#789" };

const gestures = new GestureEngine({
  onPose: (state, { from, to }) => {
    const m = state.metrics;
    console.log(
      `%c${state.handedness.padEnd(5)} ${from} -> ${to}`,
      `color:${POSE_COLOR[to] ?? "#789"}`,
      m ? { gap2d: +m.pinch.toFixed(3), gap3d: m.pinch3d?.toFixed(3) ?? null,
            curlMax: +m.curlMax.toFixed(3), curlMean: +m.curl.toFixed(3) }
        : "(hand left the frame)",
    );
  },
});

const tracker = new HandTracker({
  video: el.video,
  numHands: 2,
  onStatus: (s) => { el.status.textContent = s; },
  onFrame: (frame) => {
    gestures.update(frame);          // must run first: stamps pose onto hands
    scene.setVideoSize(frame.videoW, frame.videoH);
    for (const rig of rigs) {
      // The engine list, not frame.hands — see Builder. Each rig filters it
      // down to its own zone itself, so both players are driven from one pass
      // over one set of hands.
      rig.builder.update(gestures.hands);
      // Only offer the picker when that player's hands are not already
      // building. A dwell that survived into the middle of a drag would change
      // the shape out from under whatever they were doing.
      if (rig.builder.busy) rig.picker.reset();
      else rig.picker.update(gestures.hands, frame.now);
    }
    tutorial.frame();                // after builder.update: reads this frame
    session.frame(frame.now);        // after the builders: judges what they built
    arcade.frame(gestures.hands, frame.now);   // before render: it moves meshes
    // The grid only shows while snap is on AND hands are on something: that is
    // when you are aiming, and the rest of the time it is lines over your face.
    scene.setGrid(settings.snap && rigs.some((r) => r.builder.busy), TUNING.snap.cells);
    scene.render();
    overlay.draw(frame);
    if (frame.now - hudAt > 120) {   // throttle DOM writes, not the tracking
      hudAt = frame.now;
      updateHud(frame);
    }
  },
});

function updateHud(frame) {
  el.fps.textContent = frame.fps.toFixed(0);
  const stale = gestures.hands.filter((h) => h.stale).length;
  // `dropped` counts detections thrown out as physically impossible — the
  // signature of the model sliding the skeleton onto your face. Shown because
  // a number that climbs only while your hand is over your face explains a
  // stutter that would otherwise look like the app failing at random.
  const dropped = frame.rejected ? ` · ${frame.rejected} dropped` : "";
  el.hands.textContent = (stale ? `${frame.hands.length} (+${stale} held)` : String(frame.hands.length)) + dropped;
  // Every rig on screen, so two-player shows the whole board rather than one
  // half of it.
  const count = rigs.reduce((n, r) => n + r.builder.blocks.length, 0);
  const drawing = rigs.some((r) => r.builder.draft);
  el.blocks.textContent = drawing ? `${count} +drawing` : String(count);

  const live = rigs.find((r) => r.builder.busy) ?? rigs[0];
  if (live) {
    const b = live.builder;
    el.action.textContent = b.wipeState ?? b.status ?? "—";
    const doomed = b.grab?.armed || b.hold?.doomed || b.resize?.armed;
    // The one HUD value that changes colour, and only for the state that
    // matters: something is armed to be destroyed.
    el.action.style.color = doomed ? "var(--warn)" : "var(--ink)";
    el.shape.textContent = SHAPE_LABEL[b.shape] ?? b.shape;
  } else {
    // The arcade drives no builder at all.
    el.action.textContent = arcade.running ? `arcade · ${arcade.phase}` : "—";
    el.action.style.color = "var(--ink)";
  }
  el.options.textContent = `${settings.snap ? "on" : "off"} · ${settings.sound ? "on" : "off"}`;

  el.metrics.textContent = gestures.hands.map(fmtHand).join("\n") || "no hand in view";
}

// Raw numbers, on screen, so thresholds can be tuned against what you see.
function fmtHand(h) {
  const m = h.metrics;
  if (!m) return `${h.handedness} —`;
  const e = m.extension;
  return [
    `${h.handedness.padEnd(5)} ${h.pose.toUpperCase().padEnd(5)}${h.stale ? " (held)" : ""}`,
    `      gap 2d ${m.pinch.toFixed(3)}  3d ${m.pinch3d == null ? " --- " : m.pinch3d.toFixed(3)}`,
    `      curl mean ${m.curl.toFixed(3)}  max ${m.curlMax.toFixed(3)}`,
    `      ext i${e.index.toFixed(2)} m${e.middle.toFixed(2)} r${e.ring.toFixed(2)} p${e.pinky.toFixed(2)}`,
  ].join("\n");
}

// ---- routing ------------------------------------------------------------
//
// One camera and one scene serve every mode, so a route change is a change of
// *chrome*, never a teardown: the tracker keeps running, and switching back to
// the menu simply hides the mode's UI. What each route needs from the camera is
// identical, so the gate is asked for once per session and never again.

const GATE_COPY = {
  freestyle: "Free build. Pinch with both hands and pull apart.",
  tutorial: "The tutorial walks you through every gesture, one at a time.",
  play1: "One player. A run of tasks, each one harder than the last.",
  play2: "Two players, one camera — left half and right half of the frame.",
  rush: "Shape rush. Build fast — every shape you finish adds time to the clock.",
  daily: "Today's daily challenge. Five levels, the same for everyone.",
  memory: "Memory. Study the target, then build it once the picture is gone.",
  copy: "Copy the shape. Fill each outline on screen with a matching block.",
  balance: "Balance scale. Rest shapes on the beam until it sits level.",
};

const copyFor = (route) => {
  if (route.mode === "arcade") {
    const g = gameById(route.game);
    return g ? `${g.name}. ${g.desc}` : "Arcade.";
  }
  return route.mode === "play"
    ? GATE_COPY[route.kind ?? (route.players === 2 ? "play2" : "play1")]
    : GATE_COPY[route.mode];
};

let route = null;       // the mode currently on screen, null while in the menu
let wanted = null;      // the route waiting on the camera gate
let versus = null;      // the two zone rigs, while a two-player game is up

const menu = initMenu({ onLaunch: (r) => enter(r) });
const play = initPlay({ onQuit: () => toMenu(), onAgain: () => session.again() });
// The run itself: levels, clock, scoring, and the two-player race. It reads
// the rigs it is given and writes to `play`; nothing else in here knows the
// rules.
const session = initSession({ scene, play, sound });
// The retro games and side quests. They share the camera, the scene and the
// gestures, but build nothing: while one is up no rig is driven at all.
const arcade = initArcade({ scene, onQuit: () => toMenu() });

/** Freestyle's blocks survive a trip to the menu, but not on top of a game. */
function showBoard(visible) {
  for (const b of solo.builder.blocks) b.group.visible = visible;
}

/** Enter a route, stopping at the camera gate the first time through. */
function enter(r) {
  if (!tracker.running) {
    wanted = r;
    el.gateMode.textContent = copyFor(r);
    el.gate.classList.remove("hidden");
    return;
  }
  route = r;
  el.gate.classList.add("hidden");
  // A run wants the frame, not the diagnostics: Play starts with the panel
  // collapsed to its hamburger (H brings it back), and in two-player it is
  // sitting in player 1'"'"'s corner besides. Every other route opens it, because
  // freestyle and the tutorial are read off it.
  const isArcade = r.mode === "arcade";
  if (r.mode === "play" || isArcade) tutorial.hideHud();
  else { tutorial.showHud(); syncHudHeight(); }

  const twoPlayer = (r.mode === "play" || isArcade) && r.players === 2;
  // Four hands instead of two, and a hand identified by its side of the frame
  // as well as its handedness — otherwise two people's right hands are one
  // hand that keeps teleporting across the divider.
  tracker.setNumHands(twoPlayer ? 4 : 2);
  tracker.splitZones = twoPlayer;
  showBoard(!isArcade);

  if (isArcade) {
    if (versus) {
      versus.forEach((rig) => rig.builder.clear());
      versus = null;
    }
    useRigs([]);
  } else if (twoPlayer) {
    // A fresh board per game. Whatever was built in another mode belongs to
    // neither player and would sit in someone's half.
    solo.builder.clear();
    versus?.forEach((rig) => rig.builder.clear());
    versus = [
      makeRig({ zone: "left", theme: "p1" }),
      makeRig({ zone: "right", theme: "p2" }),
    ];
    useRigs(versus);
  } else {
    if (versus) {
      versus.forEach((rig) => rig.builder.clear());
      versus = null;
    }
    useRigs([solo]);
    if (r.mode === "play") solo.builder.clear();
  }

  if (r.mode === "play" && r.kind === "rush") {
    session.start({ players: 1, rigs, kind: "rush" });
  } else if (r.mode === "play" && r.kind === "daily") {
    // The date is fixed when the run starts, so a run that crosses midnight
    // stays on — and is recorded against — the day it began.
    const date = todayKey();
    session.start({ players: 1, rigs, kind: "daily", ladder: dailyLadder(date), date });
  } else if (r.mode === "play" && CHALLENGE_LADDERS[r.kind]) {
    session.start({ players: 1, rigs, kind: r.kind, ladder: CHALLENGE_LADDERS[r.kind] });
  } else if (r.mode === "play") {
    // Solo plays a difficulty straight through from wherever you chose to
    // start. Versus gets a FUNCTION, not a list: its ladder is an assortment
    // drawn fresh, and "play again" should draw again rather than replay.
    const list = r.players === 2 ? mixedLadder : ladder(r.difficulty ?? "easy", r.from ?? 0);
    session.start({ players: r.players, rigs, ladder: list });
  }
  else { session.stop(); play.close(); }
  if (isArcade) arcade.start(r);
  else arcade.stop();
  if (r.mode === "tutorial") tutorial.open(0);
}

/** Leave whatever is up and go back to the menu. The scene is left alone —
 *  coming back to freestyle should find your blocks where you left them. */
function toMenu() {
  route = null;
  wanted = null;
  if (versus) {
    versus.forEach((rig) => rig.builder.clear());
    versus = null;
  }
  useRigs([solo]);
  tracker.setNumHands(2);
  tracker.splitZones = false;
  tutorial.close();
  session.stop();
  play.close();
  arcade.stop();
  showBoard(true);
  el.gate.classList.add("hidden");
  menu.open();
}

el.start.addEventListener("click", async () => {
  el.start.disabled = true;
  try {
    await tracker.start();
    el.gate.classList.add("hidden");
    const r = wanted ?? { mode: "freestyle" };
    wanted = null;
    enter(r);
  } catch (err) {
    console.error(err);
    el.status.textContent = "failed";
    el.gateNote.textContent = describe(err);
  } finally {
    el.start.disabled = false;
  }
});

el.gateBack.addEventListener("click", toMenu);
el.toMenu.addEventListener("click", toMenu);

menu.open();

// The menu is up: lift the boot screen off it.
const boot = document.getElementById("boot");
boot.classList.add("done");
setTimeout(() => boot.remove(), 500);   // after the fade; transitionend skips hidden tabs

function describe(err) {
  if (err?.name === "NotAllowedError") return "Camera permission denied — allow it in the address bar, then retry.";
  if (err?.name === "NotFoundError") return "No camera found.";
  if (err?.name === "NotReadableError") return "Camera is in use by another app (Zoom, Teams, OBS…). Close it and retry.";
  if (!window.isSecureContext) return "Needs http://localhost or https — file:// blocks getUserMedia().";
  return `${err?.name ?? "Error"}: ${err?.message ?? err}`;
}

// Background tabs get throttled to ~1fps, which looks like broken tracking.
document.addEventListener("visibilitychange", () => {
  if (document.hidden && tracker.running) el.status.textContent = "tab hidden — throttled";
  else if (tracker.running) el.status.textContent = "tracking";
});

// Debug toggles.
window.addEventListener("keydown", (e) => {
  // The tutorial owns the keyboard while it is up, so reading it cannot
  // silently wipe the scene behind it.
  if (tutorial.isModal()) return;
  // Esc backs out of a mode, but only from a mode: in the menu it means
  // nothing, and the tutorial handles its own Esc above.
  if (e.key === "Escape" && route) { toMenu(); return; }
  if (menu.isOpen()) return;
  if (route?.mode === "arcade" && arcade.key(e)) { e.preventDefault(); return; }
  if (e.key === "d") overlay.visible = !overlay.visible;
  if (e.key === "l") ringLight.step();
  if (e.key === "g") {
    setSnap(!settings.snap);
    toast(`grid snap ${settings.snap ? "on" : "off"}`);
  }
  if (e.key === "m") {
    setSound(!settings.sound);
    toast(`sound ${settings.sound ? "on" : "off"}`);
  }
  // Undo and clear act on every rig on screen: in two-player mode there is no
  // one board to take an action back from.
  if (e.key === "u") for (const rig of rigs) rig.builder.undo();
  if (e.key === "c") for (const rig of rigs) rig.builder.clear();
});

/** A one-line confirmation for a keyboard toggle, since the HUD is often
 *  collapsed during a run and a silent toggle looks like a dead key. */
let toastTimer = 0;
function toast(text) {
  el.toast.textContent = text;
  el.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.add("hidden"), 1400);
}

/**
 * Samples several signals off the live hand for a few seconds at once.
 *
 * All signals in ONE pass deliberately: each call wraps `tracker.onFrame`, so
 * two overlapping samplers restore the hook in the wrong order and leave a
 * wrapper installed for the rest of the session.
 */
function sample(seconds, picks) {
  const out = {};
  for (const k of Object.keys(picks)) out[k] = [];

  const prev = tracker.onFrame;
  tracker.onFrame = (frame) => {
    prev(frame);
    const h = frame.hands[0];
    if (!h) return;
    for (const [k, fn] of Object.entries(picks)) {
      const v = fn(h.metrics);
      if (Number.isFinite(v)) out[k].push(v);
    }
  };

  return new Promise((resolve) => setTimeout(() => {
    tracker.onFrame = prev;
    resolve(out);
  }, seconds * 1000));
}

const range = (a) => a.length
  ? { min: +Math.min(...a).toFixed(3), max: +Math.max(...a).toFixed(3),
      mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3), n: a.length }
  : "NO SAMPLES";

const ranges = (raw) => Object.fromEntries(
  Object.entries(raw).map(([k, v]) => [k, range(v)]));

/**
 * Pinch calibration: hold a pinch, then open wide.  await ARB.calibrate(4)
 */
async function calibrate(seconds = 4) {
  console.log(`sampling ${seconds}s — pinch fully closed, then open wide…`);
  const out = ranges(await sample(seconds, {
    gap2d: (m) => m.pinch,
    gap3d: (m) => m.pinch3d ?? NaN,
  }));
  console.table(out);
  console.log({ ...out, currentThresholds: { ...TUNING.pinch } });
  return out;
}

/**
 * Fist calibration — the one that matters for grabbing, because the fist
 * thresholds are the only ones in TUNING never measured on a real hand.
 *
 * Hold ONE pose for the whole sample. What you want to see:
 *   fist   ->  curlMax well under TUNING.fist.enterCurl (0.62)
 *          AND gap2d well over TUNING.fist.minGap (0.55)
 *   pinch  ->  gap2d under TUNING.pinch.enter2d (0.30)
 * If your fist's gap2d does not clear 0.55 the classifier reads it as a
 * near-pinch and will never grab. Lower TUNING.fist.minGap to sit between your
 * two measured values, or lay your thumb further across your fingers.
 */
async function calibratePose(seconds = 4) {
  console.log(`sampling ${seconds}s — hold ONE pose (fist, or pinch) and keep still…`);
  const out = ranges(await sample(seconds, {
    gap2d: (m) => m.pinch,
    curlMax: (m) => m.curlMax,
    curlMean: (m) => m.curl,
  }));
  console.table(out);
  console.log("fist needs: curlMax <", TUNING.fist.enterCurl,
              "AND gap2d >", TUNING.fist.minGap);
  return out;
}

/** Candidate fist-vs-pinch signals, all measured, best one wins. */
const CANDIDATES = ["tipRatio", "tipRatio3d", "thumbToPalm", "thumbToPalm3d", "pinch", "pinch3d"];

const countdown = async (label, secs = 3) => {
  for (let i = secs; i > 0; i--) {
    console.log(`%c${label} in ${i}…`, "color:#7fd4ff;font-size:13px");
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`%cSAMPLING — hold it`, "color:#5fa;font-size:13px");
};

/**
 * Picks the fist-vs-pinch discriminator by measuring YOUR hand.
 *
 *   await ARB.calibrateFist()
 *
 * Samples a pinch, then a natural fist, and scores every candidate signal by
 * its separation margin: the gap between the two poses' ranges, over their
 * combined spread. Above ~0.3 the poses do not overlap at all and the signal is
 * safe; at or below 0 they overlap and no threshold on it can work.
 *
 * This exists because the fist/pinch boundary could not be settled by argument.
 * Finger curl was measured doing nothing, and the raw thumb gap only worked
 * with the thumb stuck out. Rather than guess a third time, measure all of them.
 */
async function calibrateFist(seconds = 4) {
  console.log("%cFist calibration — two samples.", "color:#7fd4ff;font-weight:bold");

  await countdown("hold a PINCH (thumb on index tip)");
  const pinch = await sample(seconds, pickAll());
  await countdown("now hold your NATURAL FIST (thumb wherever it falls)");
  const fist = await sample(seconds, pickAll());

  const scored = CANDIDATES.map((name) => {
    const p = pinch[name], f = fist[name];
    if (!p.length || !f.length) return { name, margin: -Infinity, note: "no samples" };
    const pLo = Math.min(...p), pHi = Math.max(...p);
    const fLo = Math.min(...f), fHi = Math.max(...f);
    // Positive only when the two ranges are genuinely disjoint.
    const gap = fLo - pHi;                       // fist above pinch
    const spread = Math.max(pHi - pLo + fHi - fLo, 1e-6);
    return { name, margin: +(gap / spread).toFixed(3),
             pinch: `${pLo.toFixed(3)}..${pHi.toFixed(3)}`,
             fist: `${fLo.toFixed(3)}..${fHi.toFixed(3)}`,
             mid: +((pHi + fLo) / 2).toFixed(3), pHi, fLo };
  }).sort((a, b) => b.margin - a.margin);

  console.table(scored.map(({ name, margin, pinch: p, fist: f }) => ({ signal: name, margin, pinch: p, fist: f })));

  const best = scored[0];
  if (!best || best.margin <= 0) {
    console.warn("%cNo signal separates your two poses — they overlap on every "
      + "candidate. Make the fist more distinct (thumb further across the "
      + "fingers) and run again.", "color:#ff6a7c");
    return scored;
  }

  // Thresholds land ON the measured edges, not at the midpoint: that keeps the
  // dead band as wide as the data allows instead of splitting it arbitrarily.
  TUNING.discriminator.signal = best.name;
  TUNING.discriminator.pinchBelow = +(best.pHi + (best.fLo - best.pHi) * 0.33).toFixed(3);
  TUNING.discriminator.fistAbove = +(best.pHi + (best.fLo - best.pHi) * 0.67).toFixed(3);
  console.log(`%cApplied: ${best.name}  pinch<${TUNING.discriminator.pinchBelow} `
    + `fist>${TUNING.discriminator.fistAbove}  (margin ${best.margin})`,
    "color:#5fa;font-weight:bold");
  console.log("Paste into TUNING.discriminator in src/gestures.js to keep it:",
    JSON.stringify(TUNING.discriminator));
  return scored;
}

const pickAll = () => Object.fromEntries(
  CANDIDATES.map((n) => [n, (m) => m[n] ?? NaN]));

// Live threshold tuning from the console, e.g.
//   ARB.tuning.filter.beta = 2      // snap harder to fast motion
//   ARB.tuning.fist.minGap = 0.45   // if your fist is not being recognized
window.ARB = { tracker, overlay, gestures, scene, builder, picker, tutorial, menu, play,
               session, arcade, ringLight, sound, rigs: () => rigs, versus: () => versus,
               tuning: TUNING, POSE, settings,
               calibrate, calibratePose, calibrateFist };
