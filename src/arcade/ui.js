import { handGlyph } from "../tutorial.js";

/**
 * The arcade's chrome: a top bar with the game and its numbers, a strip of
 * control reminders along the bottom, banners and floating score pops, and one
 * card for every full-screen moment (how to play, countdown, pause, game over).
 *
 * Presentation only, the same split as play.js: it shows what it is told and
 * never decides anything. Styled from the same parts as Play mode — the bar,
 * the over-card, the hairlines — so the arcade is visibly the same app.
 */

const HTML = `
  <div class="arc-bar">
    <button class="play-quit" data-quit title="Back to the menu (Esc)">&larr; menu</button>
    <div class="arc-title">
      <span class="pl-k" data-tag></span>
      <span class="arc-name" data-name></span>
    </div>
    <div class="arc-stats" data-stats></div>
    <div class="arc-tools">
      <button class="arc-tool" data-pause title="Pause (P)">pause</button>
      <button class="arc-tool" data-mute title="Sound (M)">sound</button>
    </div>
  </div>

  <div class="arc-layer" data-layer></div>
  <div class="arc-banner" data-banner></div>
  <div class="arc-pops" data-pops></div>
  <div class="arc-help" data-help></div>

  <div class="play-over hidden" data-over>
    <div class="over-card" data-card>
      <div class="over-kicker" data-kicker></div>
      <div class="over-title" data-title></div>
      <div class="over-sub" data-sub></div>
      <div class="arc-howto hidden" data-howto></div>
      <div class="over-rows hidden" data-rows></div>
      <div class="arc-cta hidden" data-cta><span class="arc-dot"></span><span data-cta-text></span></div>
      <div class="over-btns hidden" data-btns>
        <button class="menu-btn ghost" data-menu>menu</button>
        <button class="menu-btn" data-go>start</button>
      </div>
    </div>
  </div>
`;

export function initArcadeUI({ onQuit, onGo, onPause, onMute }) {
  const root = document.createElement("div");
  root.id = "arcade";
  root.className = "hidden";
  root.innerHTML = HTML;
  document.body.appendChild(root);

  const q = (sel) => root.querySelector(sel);
  const over = q("[data-over]");
  const bannerEl = q("[data-banner]");
  let bannerTimer = 0;
  let lastStats = "";

  function open(def, players) {
    root.classList.remove("hidden");
    document.body.classList.add("arcade-up");
    q("[data-tag]").textContent = def.section === "challenge" ? "challenge" : `after ${def.after}`;
    q("[data-name]").textContent = def.name + (players === 2 ? " · 2P" : "");
    q("[data-help]").innerHTML = def.chips.map((c) => `<span class="arc-chip">${c}</span>`).join("");
    setStats([]);
    clearLayer();
    q("[data-pops]").textContent = "";
    bannerEl.classList.remove("show");
    setPaused(false);
  }

  function close() {
    root.classList.add("hidden");
    document.body.classList.remove("arcade-up");
    hideOverlay();
    clearLayer();
  }

  /** `[{ k, v, cls?, html? }]` — skipped when nothing changed, since this is
   *  called ten times a second and most of those frames are identical. */
  function setStats(list) {
    const html = list.map((s) => `
      <div class="arc-stat ${s.cls ?? ""}">
        <span class="pl-k">${s.k}</span>
        <span class="pl-v">${s.html ?? s.v}</span>
      </div>`).join("");
    if (html === lastStats) return;
    lastStats = html;
    q("[data-stats]").innerHTML = html;
  }

  /** A big word across the top of the play area: LEVEL 3, DOUBLE, SMASH. */
  function banner(text, tone = "", ms = 1300) {
    bannerEl.textContent = text;
    bannerEl.className = `arc-banner ${tone}`;
    void bannerEl.offsetWidth;          // restart the animation
    bannerEl.classList.add("show");
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => bannerEl.classList.remove("show"), ms);
  }

  /** "+100" floating up from a point on screen, in CSS pixels. */
  function pop(at, text, tone = "") {
    const el = document.createElement("div");
    el.className = `arc-pop ${tone}`;
    el.textContent = text;
    el.style.left = `${at.x}px`;
    el.style.top = `${at.y}px`;
    q("[data-pops]").appendChild(el);
    setTimeout(() => el.remove(), 950);
  }

  function card({ kicker = "", title = "", sub = "", howto = null, rows = null, cta = null,
                  go = null, menu = false, tone = "" }) {
    over.classList.remove("hidden");
    q("[data-card]").className = `over-card arc-over${tone ? ` ${tone}` : ""}`;
    q("[data-kicker]").textContent = kicker;
    q("[data-title]").textContent = title;
    q("[data-sub]").textContent = sub;

    const how = q("[data-howto]");
    how.classList.toggle("hidden", !howto);
    how.innerHTML = howto
      ? howto.map((c) => `<div class="arc-how"><span class="arc-glyph">${handGlyph(c.pose)}</span>
          <span class="arc-how-text">${c.text}</span></div>`).join("")
      : "";

    const rowsEl = q("[data-rows]");
    rowsEl.classList.toggle("hidden", !rows);
    rowsEl.innerHTML = rows
      ? rows.map((r) => `<div class="over-row${r.win ? " win" : ""}"><span>${r.label}</span><span>${r.value}</span></div>`).join("")
      : "";

    q("[data-cta-text]").textContent = cta ?? "";
    q("[data-cta]").classList.add("hidden");
    q("[data-cta]").dataset.has = cta ? "1" : "";

    q("[data-btns]").classList.toggle("hidden", !(go || menu));
    q("[data-go]").textContent = go ?? "";
    q("[data-go]").classList.toggle("hidden", !go);
  }

  /** The hands-free prompt only appears once it would actually be read. */
  function showCta() {
    const el = q("[data-cta]");
    if (el.dataset.has) el.classList.remove("hidden");
  }

  const hideOverlay = () => over.classList.add("hidden");

  function intro(def, best) {
    card({
      kicker: def.section === "challenge" ? "challenge" : `after ${def.after}`,
      title: def.name,
      sub: best ? `your best: ${best}` : def.desc,
      howto: def.controls,
      cta: "pinch to start",
      go: "start",
      menu: true,
      tone: "intro",
    });
  }

  const countdown = (n) =>
    card({ kicker: "get ready", title: n > 0 ? String(n) : "go", tone: "count" });

  function paused(reason) {
    const hands = reason === "hands";
    card({
      kicker: "paused",
      title: hands ? "Hands up" : "Paused",
      sub: hands ? "Lost sight of your hands. Raise one into view and the game carries on."
                 : "Take a breather.",
      cta: hands ? null : "pinch to resume",
      go: "resume",
      menu: true,
    });
  }

  function gameOver({ kicker = "game over", title = "", sub = "", rows = null, best = false, tone = "done" }) {
    card({
      kicker: best ? "new best!" : kicker,
      title, sub, rows,
      cta: "pinch to play again",
      go: "play again",
      menu: true,
      tone: best ? `${tone} best` : tone,
    });
  }

  const layer = q("[data-layer]");
  const mount = (el) => layer.appendChild(el);
  function clearLayer() { layer.textContent = ""; }

  const setMute = (muted) => {
    const b = q("[data-mute]");
    b.textContent = muted ? "sound off" : "sound on";
    b.classList.toggle("off", muted);
  };
  const setPaused = (on) => { q("[data-pause]").textContent = on ? "resume" : "pause"; };

  q("[data-quit]").addEventListener("click", () => onQuit());
  q("[data-menu]").addEventListener("click", () => onQuit());
  q("[data-go]").addEventListener("click", () => onGo());
  q("[data-pause]").addEventListener("click", () => onPause());
  q("[data-mute]").addEventListener("click", () => onMute());

  return {
    open, close, setStats, banner, pop, intro, countdown, paused, gameOver, showCta,
    hideOverlay, mount, clearLayer, setMute, setPaused,
    isOpen: () => !root.classList.contains("hidden"),
  };
}
