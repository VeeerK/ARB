import { TUNING } from "./gestures.js";

/**
 * The in-app tutorial, and the HUD's collapse toggle.
 *
 * Two halves per step, and the second is the point:
 *
 *   1. DEMO — a card explains the gesture and animates hands doing it to an
 *      actual block, because every gesture here is defined by what it does to
 *      one.
 *   2. PRACTICE — the card gets out of the way, shrinking to a strip at the
 *      top of the screen so the camera and your own hands are visible, and the
 *      step does not advance until you have really done the thing.
 *
 * "Really done" is deliberately strict: carrying a block means the block moved,
 * turning it means it turned, grabbing the scene means the scene went
 * somewhere. Passing on the first frame a gesture is merely RECOGNIZED teaches
 * nothing — you would be waved through before finding out what the gesture
 * feels like. `skip` is always there for when the tracking will not cooperate,
 * because a tutorial you cannot escape is worse than no tutorial.
 */

// ---- the drawing kit -----------------------------------------------------
//
// A 400x140 stage, symmetric about x=200 so every scene sits centred in the
// card. A hand occupies a 100-wide box but only really fills x≈5..95 of it,
// which is what the layout constants below are spaced against.

const STAGE_W = 400, HAND_W = 100, MID = STAGE_W / 2;
const FINGER_X = { index: 28, middle: 42, ring: 56, pinky: 70 };
const FINGERS = ["index", "middle", "ring", "pinky"];

const bar = (x, y, w, h) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${w / 2}" />`;

/**
 * `pose` is one of: 1 | 2 | 3 (fingers up), "pinch", "fist", "open".
 *
 * A pinch is drawn as two thick digits CURVING toward each other with a lit
 * gap between the tips. The earlier version left the index straight, which
 * read as a finger pointing up with a dot on it — the exact opposite of the
 * closing motion the gesture is.
 */
function hand(pose, { flip = false } = {}) {
  const up = typeof pose === "number" ? FINGERS.slice(0, pose)
           : pose === "open" ? FINGERS : [];

  if (pose === "pinch") {
    let curled = "";
    for (const f of ["middle", "ring", "pinky"]) {
      const x = FINGER_X[f];
      curled += bar(x, 46, 11, (f === "pinky" ? 62 : 58) - 46);
    }
    return wrap(flip, `
      <rect class="palm" x="22" y="52" width="56" height="48" rx="19" />
      ${curled}
      <path class="digit" d="M33,62 C33,44 31,32 22,30" />
      <path class="digit thumb" d="M31,80 C22,68 15,54 20,45" />
      <circle class="spark" cx="21" cy="37" r="7.5" />`);
  }

  let fingers = "";
  for (const f of FINGERS) {
    const x = FINGER_X[f];
    // The pinky sits lower and shorter, which is the difference between
    // reading as a hand and reading as a fork.
    const base = f === "pinky" ? 62 : 58;
    const top = f === "pinky" ? 26 : 14;
    fingers += up.includes(f) ? bar(x, top, 11, base - top) : bar(x, 44, 11, base - 44);
  }

  // Thumb: swung out for a count or an open hand, laid across the fingers for
  // a fist.
  const thumb = pose === "fist"
    ? `<g transform="rotate(-96 26 74)">${bar(20, 46, 11, 30)}</g>`
    : `<g transform="rotate(-28 26 74)">${bar(20, 42, 11, 34)}</g>`;

  return wrap(flip, `
    <rect class="palm" x="22" y="50" width="56" height="50" rx="19" />
    ${thumb}${fingers}`);
}

/**
 * A flipped hand still occupies [0, HAND_W]: mirror about the box, not the
 * origin, so the positions below can be read as plain left-to-right spans.
 *
 * The glyph is drawn thumb-on-the-left, i.e. as a RIGHT hand seen palm-on. So
 * the hand on the LEFT of a two-hand scene is the flipped one — that is what
 * turns its pinch inward, toward the block the two hands are working on,
 * instead of out at the edge of the card.
 */
const wrap = (flip, body) =>
  `<g class="hand" transform="translate(${flip ? HAND_W : 0},0) scale(${flip ? -1 : 1},1)">${body}</g>`;

/** One hand on its own, for other screens that name a gesture (the arcade's
 *  controls cards and Copycat's pads). Same drawing as the tutorial's. */
export const handGlyph = (pose) =>
  `<svg class="tut-svg" viewBox="0 6 100 100" preserveAspectRatio="xMidYMid meet"
    xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${hand(pose)}</svg>`;

/**
 * A scene is a list of hands, blocks and rings.
 *
 * The position goes on an OUTER group and the animation on an INNER one: a CSS
 * `transform` REPLACES an element's transform attribute, so animating the same
 * group that carries `translate(x,0)` silently drops every hand back to x=0 —
 * which is why the hands used to pile up on the left and swap sides.
 */
function scene(items, { small = false } = {}) {
  const body = items.map((it) => {
    if (it.blk) {
      const [x, y, w, h] = it.blk;
      return `<g class="slot ${it.anim || ""}"><rect class="blk ${it.cls || ""}"
        x="${x}" y="${y}" width="${w}" height="${h}" rx="3" /></g>`;
    }
    if (it.ring) {
      const [cx, cy, r] = it.ring;
      return `<g class="slot"><circle class="ring" cx="${cx}" cy="${cy}" r="${r}" /></g>`;
    }
    // `swap` cross-fades a second pose in the same place: that is how a step
    // shows a change of POSE rather than only a change of place.
    const inner = it.swap
      ? `<g class="swap-a">${hand(it.hand, it)}</g><g class="swap-b">${hand(it.swap, it)}</g>`
      : hand(it.hand, it);
    return `<g transform="translate(${it.x},0)"><g class="slot ${it.anim || ""}">${inner}</g></g>`;
  }).join("");

  return `<svg class="tut-svg${small ? " small" : ""}" viewBox="0 0 ${STAGE_W} 140"
    preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
    <g transform="translate(0,8)">${body}</g></svg>`;
}

// Hand positions. `NEAR_*` are the closed-up starting places for gestures that
// open outward; `WIDE_*` the spread ones for gestures that close inward. Both
// keep the two hands clear of each other at every point of their animation.
const NEAR_L = 105, NEAR_R = 195;
const WIDE_L = 30, WIDE_R = 270;
const SOLO = MID - HAND_W / 2;

// One block, centred. Scenes that need several fan out from it.
const BLOCK = [165, 32, 70, 62];

// ---- the steps -----------------------------------------------------------
//
// `test` gets the snapshot taken when practice began, a `seen` object the
// frame loop fills in, and the live app. It returns true only once the gesture
// has had its actual EFFECT, not merely been recognized.

const cool = Math.round(TUNING.picker.repickCooldownMs / 1000);

// How far a block must travel before "carry" counts, as a multiple of its own
// width. Under half a width is indistinguishable from the wobble of holding
// still, and would pass the moment you gripped it.
const CARRY_WIDTHS = 0.9;
const PAN_WIDTHS = 0.6;
const TURN_RADS = 0.3;      // ~17°, past any tremor
const RESIZE_RATIO = 0.25;  // a size change you can see

const STEPS = [
  {
    title: "Pick a shape",
    body: `Hold up <b>1</b>, <b>2</b> or <b>3</b> fingers and keep your hand still. A ring
      closes around your fingers, and when it completes the shape is set:
      <b>1 square</b>, <b>2 circle</b>, <b>3 triangle</b>.
      <span class="note">Already on that shape? It will not ask again for ${cool}s, which
      is why no ring appears. Any other count still lands right away.</span>`,
    art: [
      { ring: [MID, 44, 46] },
      { hand: 1, x: SOLO, anim: "bob", swap: 2 },
    ],
    // Not "hold up two": whichever shape is selected is on cooldown, so naming
    // one count could ask for the one gesture that cannot land.
    ask: "Hold up 1, 2 or 3 fingers and keep still until the ring closes",
    test: (s, seen) => seen.picked,
  },
  {
    title: "Draw a block",
    body: `<b>Pinch with both hands</b> in empty space, then pull them apart. The block
      is drawn between your two pinch points, in whichever shape you picked, and
      it lands the moment you open your hands.`,
    art: [
      { blk: BLOCK, anim: "grow" },
      { hand: "pinch", x: NEAR_L, flip: true, anim: "pull-l" },
      { hand: "pinch", x: NEAR_R, anim: "pull-r" },
    ],
    ask: "Pinch both hands in empty space, pull apart, then let go",
    test: (s, seen, api) => api.builder.blocks.length > s.blocks,
  },
  {
    title: "Resize one",
    body: `Land <b>both pinches on a block you already made</b> and it reshapes that
      block instead of drawing a new one. Move your hands apart or together and
      the block follows.`,
    art: [
      { blk: BLOCK, anim: "breathe" },
      { hand: "pinch", x: WIDE_L + 40, flip: true, anim: "sqz-l" },
      { hand: "pinch", x: WIDE_R - 40, anim: "sqz-r" },
    ],
    ask: "Pinch both hands onto a block and change its size",
    needsBlock: true,
    test: (s, seen) => seen.resized,
  },
  {
    title: "Carry a block",
    body: `<b>Close one hand into a fist on a block</b> and it goes wherever your hand
      goes. Open that hand to put it down again.`,
    art: [
      { blk: BLOCK, anim: "carry-blk" },
      { hand: "fist", x: SOLO, anim: "carry-hand" },
    ],
    ask: "Make a fist on a block and carry it somewhere else",
    needsBlock: true,
    test: (s, seen) => seen.carried,
  },
  {
    title: "Turn it",
    body: `<b>Pinch a block with one hand</b> and move that hand. Your first clear
      motion picks the turn: <b>up or down</b> tilts it toward or away from you,
      <b>left or right</b> spins it like a turntable, and <b>a circle</b> steers it
      like a wheel. Let go to pick again.`,
    art: [
      { blk: BLOCK, anim: "spin" },
      { hand: "pinch", x: SOLO, anim: "twist" },
    ],
    ask: "Pinch a block with one hand and move your hand in a circle",
    needsBlock: true,
    test: (s, seen) => seen.turned,
  },
  {
    title: "Delete one",
    body: `Two ways. <b>Squeeze both pinches shut</b> on a block until it turns red, and
      it is crushed. Or <b>carry it to the edge</b> of the frame and open your hand
      to drop it out of the world.`,
    art: [
      { blk: BLOCK, anim: "crush", cls: "doom" },
      { hand: "pinch", x: WIDE_L, flip: true, anim: "shut-l" },
      { hand: "pinch", x: WIDE_R, anim: "shut-r" },
    ],
    ask: "Get rid of one block — squeeze it shut, or carry it off the edge",
    needsBlock: true,
    test: (s, seen, api) => api.builder.blocks.length < s.blocks,
  },
  {
    title: "Move the world",
    body: `<b>Two fists</b> grab every block at once, so you can swing the whole scene
      around. Pull them apart to zoom in, push them together to zoom out, and tilt
      them like a steering wheel to turn everything. Carry it all to the edge and
      open your hands to delete it.`,
    art: [
      { blk: [150, 30, 44, 40], anim: "pan" },
      { blk: [206, 52, 44, 40], anim: "pan" },
      { hand: "fist", x: WIDE_L + 15, flip: true, anim: "pull2-l" },
      { hand: "fist", x: WIDE_R - 15, anim: "pull2-r" },
    ],
    ask: "Close both fists and move the whole scene across",
    needsBlock: true,
    test: (s, seen) => seen.panned,
  },
  {
    title: "Wipe it clean",
    body: `Bring <b>both fists together until they touch</b> — every block turns red —
      then <b>open both hands</b> to wipe them all. Changed your mind? Pull your
      fists apart before opening and nothing happens.`,
    art: [
      { blk: [150, 30, 44, 40], anim: "vanish", cls: "doom" },
      { blk: [206, 52, 44, 40], anim: "vanish", cls: "doom" },
      { hand: "fist", x: WIDE_L, flip: true, anim: "meet-l", swap: "open" },
      { hand: "fist", x: WIDE_R, anim: "meet-r", swap: "open" },
    ],
    ask: "Touch both fists together until the blocks turn red",
    needsBlock: true,
    test: (s, seen, api) => seen.armed || api.builder.blocks.length < s.blocks,
  },
  {
    title: "That is everything",
    body: `<b>U</b> undo the last block &middot; <b>C</b> clear everything &middot;
      <b>D</b> show or hide the landmark overlay &middot; <b>H</b> hide or show the panel.
      <span class="note">Nothing leaves your machine: the camera is read in the browser
      and never uploaded. Reopen this any time from <b>? tutorial</b>.</span>`,
    art: [{ hand: "open", x: SOLO, anim: "bob" }],
    // No practice: there is nothing to do with your hands here.
  },
];

// ---- watching the app ----------------------------------------------------

/** Where a block is and how big, in the one frame every test compares in. */
const snapshotOf = (block) => ({
  x: block.mesh.position.x,
  y: block.mesh.position.y,
  q: block.mesh.quaternion.clone(),
  w: Math.max(block.mesh.scale.x, 1e-6),
  h: Math.max(block.mesh.scale.y, 1e-6),
});

const moved = (from, block) =>
  Math.hypot(block.mesh.position.x - from.x, block.mesh.position.y - from.y) / from.w;

// ---- wiring --------------------------------------------------------------

export function initTutorial({ hud, openBtn, closeBtn, reopenBtn, api, onHud }) {
  const root = document.createElement("div");
  root.id = "tut";
  root.className = "hidden";
  root.innerHTML = `
    <div class="tut-card" role="dialog" aria-modal="true" aria-label="Tutorial">
      <button class="tut-x" aria-label="Close tutorial">&times;</button>
      <div class="tut-art"></div>
      <div class="tut-step"></div>
      <h2 class="tut-title"></h2>
      <p class="tut-body"></p>
      <div class="tut-nav">
        <div class="tut-dots"></div>
        <button class="tut-skip">skip</button>
        <button class="tut-go"></button>
      </div>
    </div>`;

  // The practice strip. Deliberately a separate element pinned to the top, not
  // the card moved: during practice the whole point is that the camera is
  // unobstructed, so this stays narrow and out of the middle.
  const live = document.createElement("div");
  live.id = "tut-live";
  live.className = "hidden";
  live.innerHTML = `
    <div class="live-art"></div>
    <div class="live-text">
      <div class="live-title"></div>
      <div class="live-ask"></div>
    </div>
    <div class="live-btns">
      <button class="live-again" title="Show the demo again">replay</button>
      <button class="live-skip">skip &rarr;</button>
    </div>`;

  document.body.appendChild(root);
  document.body.appendChild(live);

  const q = (s) => root.querySelector(s);
  const l = (s) => live.querySelector(s);

  const dots = STEPS.map((_, i) => {
    const d = document.createElement("button");
    d.className = "tut-dot";
    d.setAttribute("aria-label", `Step ${i + 1}`);
    d.addEventListener("click", () => demo(i));
    q(".tut-dots").appendChild(d);
    return d;
  });

  let at = 0;
  let mode = "off";          // off | demo | practice | passed
  let snap = null;           // scene state when practice began
  let seen = {};             // what has happened since
  let passedAt = 0;

  // ---- demo phase ----
  function demo(i) {
    at = Math.max(0, Math.min(STEPS.length - 1, i));
    const s = STEPS[at];
    mode = "demo";
    live.classList.add("hidden");
    root.classList.remove("hidden");

    q(".tut-art").innerHTML = scene(s.art);
    q(".tut-step").textContent = `${at + 1} / ${STEPS.length}`;
    q(".tut-title").textContent = s.title;
    q(".tut-body").innerHTML = s.body;
    q(".tut-go").innerHTML = s.test ? "let me try &rarr;" : "done";
    q(".tut-skip").classList.toggle("hidden", !s.test);
    dots.forEach((d, j) => {
      d.classList.toggle("on", j === at);
      d.classList.toggle("past", j < at);
    });
  }

  // ---- practice phase ----
  function practice() {
    const s = STEPS[at];
    if (!s.test) return close();

    mode = "practice";
    root.classList.add("hidden");
    live.classList.remove("hidden");
    live.classList.remove("passed");

    l(".live-art").innerHTML = scene(s.art, { small: true });
    l(".live-title").textContent = `${at + 1}/${STEPS.length}  ${s.title}`;
    l(".live-ask").textContent = s.ask;

    // Everything the tests compare against is captured here, so "one more block
    // than before" cannot be satisfied by blocks that already existed.
    snap = { blocks: api.builder.blocks.length, pickedAt: api.picker.pickedAt };
    seen = { picked: false, resized: false, carried: false, turned: false,
             panned: false, armed: false, refs: {} };
  }

  function pass() {
    mode = "passed";
    passedAt = performance.now();
    live.classList.add("passed");
    l(".live-ask").textContent = "got it";
  }

  /**
   * Called once per tracked frame. Polls state rather than subscribing: the
   * builder already exposes what is happening right now, and a poll cannot
   * miss a gesture that starts and ends between two callbacks.
   */
  function frame() {
    if (mode === "passed") {
      // A beat on "got it" before moving on, so the success is legible.
      if (performance.now() - passedAt > 900) demo(at + 1);
      return;
    }
    if (mode !== "practice") return;

    const step = STEPS[at];
    const b = api.builder;

    if (api.picker.pickedAt !== snap.pickedAt) seen.picked = true;
    if (b.grab?.armed) seen.armed = true;

    // Each of these needs a REFERENCE taken when the gesture starts and
    // compared while it lasts — the effect is a change, and a change needs
    // both ends. `ref` is dropped the moment the gesture does, so a second
    // attempt measures itself and not the sum of the first.
    track("resize", b.resize?.block, (ref, blk) => {
      const dw = Math.abs(blk.mesh.scale.x - ref.w) / ref.w;
      const dh = Math.abs(blk.mesh.scale.y - ref.h) / ref.h;
      if (Math.max(dw, dh) > RESIZE_RATIO) seen.resized = true;
    });

    track("hold", b.hold?.block, (ref, blk) => {
      if (moved(ref, blk) > CARRY_WIDTHS) seen.carried = true;
      // Any axis counts: a tilt is as much a turn as a steer.
      if (ref.q.angleTo(blk.mesh.quaternion) > TURN_RADS) seen.turned = true;
    });

    // A scene grab moves every block, so any one of them reports the pan.
    track("pan", b.grab ? b.blocks[0] : null, (ref, blk) => {
      if (moved(ref, blk) > PAN_WIDTHS) seen.panned = true;
    });

    if (step.test(snap, seen, api)) {
      if (at >= STEPS.length - 1) return close();
      pass();
    } else {
      // A step that needs something to act on says so, rather than leaving you
      // performing a gesture at an empty scene wondering why nothing passes.
      const short = step.needsBlock && b.blocks.length === 0;
      l(".live-ask").textContent = short
        ? "draw a block first — pinch both hands and pull apart"
        : step.ask;
    }
  }

  /**
   * Hold a reference snapshot for as long as one block stays the subject of one
   * kind of gesture. Keyed per gesture: a single shared reference would be
   * cleared by whichever tracker ran last with nothing to watch, wiping out the
   * measurement the active gesture was in the middle of making.
   */
  function track(key, block, measure) {
    if (!block) { seen.refs[key] = null; return; }
    const held = seen.refs[key];
    if (!held || held.block !== block) {
      seen.refs[key] = { block, ref: snapshotOf(block) };
      return;
    }
    measure(held.ref, block);
  }

  const isOpen = () => mode !== "off";
  const open = (from = 0) => demo(from);
  function close() {
    mode = "off";
    root.classList.add("hidden");
    live.classList.add("hidden");
  }

  q(".tut-x").addEventListener("click", close);
  q(".tut-go").addEventListener("click", () =>
    (STEPS[at].test ? practice() : close()));
  q(".tut-skip").addEventListener("click", () =>
    (at >= STEPS.length - 1 ? close() : demo(at + 1)));
  l(".live-again").addEventListener("click", () => demo(at));
  l(".live-skip").addEventListener("click", () =>
    (at >= STEPS.length - 1 ? close() : demo(at + 1)));
  // Clicking the backdrop closes; clicking the card itself must not.
  root.addEventListener("click", (e) => { if (e.target === root) close(); });

  openBtn?.addEventListener("click", () => open(0));

  // ---- HUD collapse ----
  // Two controls rather than one that moves: the panel's own toggle lives in
  // its header, and a standalone hamburger takes the same corner once the panel
  // is gone, so the thing you click is always where the panel was.
  const setHud = (want) => {
    hud.classList.toggle("collapsed", !want);
    reopenBtn.classList.toggle("hidden", want);
    closeBtn.setAttribute("aria-expanded", String(want));
    // The panel is fixed over the scene, so its size is other layouts'"'"'
    // business — announced rather than measured behind their backs.
    onHud?.(want);
  };
  closeBtn?.addEventListener("click", () => setHud(false));
  reopenBtn?.addEventListener("click", () => setHud(true));

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (isOpen()) close(); return; }
    if (mode === "demo") {
      if (e.key === "ArrowRight") demo(at + 1);
      else if (e.key === "ArrowLeft") demo(at - 1);
      return;
    }
    // Nothing on this page takes typed input, so a bare key is safe.
    if (e.key === "h" || e.key === "H") setHud(hud.classList.contains("collapsed"));
  });

  return {
    open,
    close,
    frame,
    isOpen,
    /** True only while a modal is covering the view — the practice strip is
     *  not modal, so the app's own keys keep working under it. */
    isModal: () => mode === "demo",
    showHud: () => setHud(true),
    /** Collapse the panel to its hamburger — what a run does on the way in. */
    hideHud: () => setHud(false),
  };
}
