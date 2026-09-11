import { COLORS } from "../kit.js";
import { handGlyph } from "../../tutorial.js";

/**
 * Copycat — Simon, with hand signs for pads.
 *
 * The toy's four coloured buttons become four gestures the app already knows,
 * each with the tone the original pad played:
 *
 *   pinch     fist     open hand     peace (two fingers)
 *
 * Watch the sequence light up, then make it back. Each sign has to be HELD for
 * a moment to count, and you have to change sign between steps — which is
 * what lets a sequence ask for the same gesture twice in a row. A wrong sign
 * only counts once it is held deliberately, so passing through an open hand on
 * the way from a fist to a pinch is never a mistake.
 *
 * Three strikes, and a strike replays the round rather than ending it.
 */

const PADS = [
  { pose: "pinch", name: "pinch", color: COLORS.mint },
  { pose: "fist", name: "fist", color: COLORS.amber },
  { pose: "open", name: "open hand", color: COLORS.sky },
  { pose: 2, name: "peace", color: COLORS.violet },
];

const HOLD_OK = 0.26;       // seconds a right sign must be held
const HOLD_WRONG = 0.8;     // ...and a wrong one, before it is a mistake
const STEP_TIMEOUT = 6;
const STRIKES = 3;

const hex = (n) => `#${n.toString(16).padStart(6, "0")}`;

/** Which pad this hand is making, or null. */
function signOf(hand) {
  if (!hand || hand.stale) return null;
  if (hand.fingers === 2) return 3;
  if (hand.pinching) return 0;
  if (hand.fisting) return 1;
  if (hand.open && hand.fingers === 0) return 2;
  return null;
}

export default function simon(ctx) {
  const { kit, input, sfx } = ctx;

  const el = document.createElement("div");
  el.className = "simon";
  el.innerHTML = `
    <div class="simon-status" data-status>watch</div>
    <div class="simon-pads">
      ${PADS.map((p, i) => `
        <div class="simon-pad" data-pad="${i}" style="--pad:${hex(p.color)}">
          <div class="simon-glyph">${handGlyph(p.pose)}</div>
          <div class="simon-name">${p.name}</div>
        </div>`).join("")}
    </div>
    <div class="simon-steps" data-steps></div>
    <div class="simon-see" data-see></div>`;
  ctx.mount(el);
  const padEls = [...el.querySelectorAll("[data-pad]")];
  const statusEl = el.querySelector("[data-status]");
  const stepsEl = el.querySelector("[data-steps]");
  const seeEl = el.querySelector("[data-see]");

  const seq = [];
  let round = 0, score = 0, strikes = 0;
  let state = "show";           // show | input | good | bad | done
  let t = 0, stateT = 0;
  let at = 0;                   // next step to make
  let cur = null, curT = 0, consumed = false;
  let stepT = 0;
  let lit = -1;
  let litUntil = 0;
  let lastShown = -1;

  const light = (i, secs) => { lit = i; litUntil = t + secs; };

  function paint() {
    padEls.forEach((p, i) => {
      p.classList.toggle("lit", i === lit && t < litUntil);
      p.classList.toggle("wrong", state === "bad");
      p.classList.toggle("seen", state === "input" && i === cur);
    });
    stepsEl.innerHTML = seq.map((_, i) =>
      `<i class="${state === "input" || state === "good" ? (i < at ? "done" : i === at ? "on" : "") : ""}"></i>`).join("");
    seeEl.textContent = cur == null ? "" : `seeing: ${PADS[cur].name}`;
  }

  function nextRound() {
    round++;
    // Never the same sign three times running: that is a test of the
    // tracker's patience rather than of memory.
    let pick;
    do pick = Math.floor(Math.random() * PADS.length);
    while (seq.length >= 2 && seq[seq.length - 1] === pick && seq[seq.length - 2] === pick);
    seq.push(pick);
    if (round === 1) {
      let second;
      do second = Math.floor(Math.random() * PADS.length); while (second === pick);
      seq.push(second);
    }
    show();
  }

  function show() {
    state = "show";
    stateT = t;
    lastShown = -1;
    at = 0;
    statusEl.textContent = "watch";
  }

  const onTime = () => Math.max(0.3, 0.62 - round * 0.025);
  const GAP = 0.2;

  function startInput() {
    state = "input";
    stateT = t;
    stepT = t;
    at = 0;
    consumed = cur != null;     // whatever you were holding while watching does not count
    statusEl.textContent = "your turn";
  }

  function mistake() {
    strikes++;
    state = "bad";
    stateT = t;
    sfx.bad();
    statusEl.textContent = strikes >= STRIKES ? "out of tries" : `not that one — ${STRIKES - strikes} left`;
    if (strikes >= STRIKES) {
      state = "done";
      setTimeout(() => sfx.lose(), 300);
      ctx.end({
        score, kicker: "copycat", title: String(score),
        sub: `longest sequence: ${Math.max(seq.length - 1, 0)}`,
        rows: [{ label: "rounds", value: String(round - 1) }],
      });
    }
  }

  nextRound();
  paint();

  return {
    // Watching needs no hands, so the arcade's "hands gone" pause would fire
    // every time you lowered them to watch. Timeouts cover a walk-away.
    autoPause: false,

    update(dt) {
      t += dt;
      const g = signOf(input.primary());
      if (g !== cur) { cur = g; curT = t; consumed = false; }

      if (state === "show") {
        const slot = onTime() + GAP;
        const i = Math.floor((t - stateT - 0.5) / slot);
        if (i >= 0 && i < seq.length && i !== lastShown) {
          lastShown = i;
          light(seq[i], onTime());
          sfx.pad(seq[i]);
        }
        if (t - stateT - 0.5 > seq.length * slot) startInput();
      } else if (state === "input") {
        const held = t - curT;
        if (cur != null && !consumed) {
          if (cur === seq[at] && held >= HOLD_OK) {
            consumed = true;
            light(cur, 0.35);
            sfx.pad(cur);
            at++;
            stepT = t;
            if (at >= seq.length) {
              state = "good";
              stateT = t;
              score += seq.length * 50;
              statusEl.textContent = "yes!";
              ctx.banner(`${seq.length} in a row`, "good", 900);
            }
          } else if (cur !== seq[at] && held >= HOLD_WRONG) {
            consumed = true;
            mistake();
          }
        }
        if (state === "input" && t - stepT > STEP_TIMEOUT) mistake();
      } else if (state === "good") {
        if (t - stateT > 1.0) { sfx.score(); nextRound(); }
      } else if (state === "bad") {
        if (t - stateT > 1.3) show();
      }
      paint();
    },

    idle() { paint(); },

    cursors() {
      kit.beginCursors();
      const h = input.primary();
      if (h && !h.stale) {
        const g = signOf(h);
        kit.cursor(h.palm.x, h.palm.y, { color: g == null ? COLORS.white : PADS[g].color, r: 0.34, opacity: 0.7 });
      }
      kit.endCursors();
    },

    stats: () => [
      { k: "round", v: Math.max(round, 1) },
      { k: "score", v: score },
      { k: "tries", v: "●".repeat(Math.max(STRIKES - strikes, 0)) || "—" },
    ],

    dispose() { el.remove(); },
  };
}
