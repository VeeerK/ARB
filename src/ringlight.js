/**
 * The ring light: the screen itself as a lamp.
 *
 * Hand tracking is a camera problem before it is a gesture problem. In a dim
 * room the webcam gives up long before the model does — the exposure climbs,
 * the frame turns to noise, and hands come and go at random. The one light
 * source every player already has pointed at their face is the display they
 * are looking at, so this floods its edges with white and leaves the middle
 * clear for the build plane.
 *
 * Edges rather than a full-screen wash on purpose: the wash would have to be
 * dim enough to see the game through, which is too dim to light a face, while
 * a bright border can go to full white without covering anything you are
 * working on. It sits under the panels and over the video, and never takes a
 * pointer event.
 *
 * Three steps, not a slider: off, soft, bright. What a player actually decides
 * is "the room is fine / a bit dark / very dark", and a continuous control
 * would be a thing to fiddle with mid-game rather than an answer to that.
 */

// `solid` is how far the band stays pure white before it starts to fade;
// `width` is where the fade reaches nothing. Both as a fraction of the screen.
const LEVELS = [
  { name: "off",    solid: "0%", width: "0%",  alpha: 0 },
  // A thin core and a wide fall-off: a lift for a room that is dim rather than
  // dark, and gentle enough not to read as part of the game.
  { name: "soft",   solid: "2%", width: "13%", alpha: 0.55 },
  // A real lamp. The core is as wide as it can be before it starts washing out
  // blocks at the edge of the plane, which is where the carry-it-off-the-edge
  // delete lives.
  { name: "bright", solid: "5%", width: "15%", alpha: 1 },
];

export const LIGHT_LEVELS = LEVELS.map((l) => l.name);

export function initRingLight({ level = 0, onChange } = {}) {
  const light = document.createElement("div");
  light.id = "ringlight";
  light.setAttribute("aria-hidden", "true");
  document.body.appendChild(light);

  const btn = document.createElement("button");
  btn.id = "light-btn";
  btn.type = "button";
  btn.innerHTML = `<span class="lb-sun" aria-hidden="true"></span><span class="lb-v"></span>`;
  document.body.appendChild(btn);

  let at = clamp(level);

  function paint() {
    const l = LEVELS[at];
    light.style.setProperty("--ring-s", l.solid);
    light.style.setProperty("--ring-w", l.width);
    light.style.setProperty("--ring-a", String(l.alpha));
    light.classList.toggle("on", at > 0);
    btn.classList.toggle("on", at > 0);
    btn.querySelector(".lb-v").textContent = l.name;
    btn.title = `Ring light: ${l.name} — lights your face with the screen (L)`;
    btn.setAttribute("aria-label", `Ring light: ${l.name}`);
  }

  /** Off -> soft -> bright -> off. One button, so it has to be a cycle. */
  function step() {
    at = (at + 1) % LEVELS.length;
    paint();
    onChange?.(at);
  }

  function set(next) {
    at = clamp(next);
    paint();
  }

  btn.addEventListener("click", step);
  paint();

  // The button hides with the rest of the in-app chrome while the menu is up;
  // that is one CSS rule on `body.menu-up`, not a thing to drive from here.
  return { step, set, get level() { return at; } };
}

const clamp = (i) => Math.max(0, Math.min(Number(i) | 0, LEVELS.length - 1));
