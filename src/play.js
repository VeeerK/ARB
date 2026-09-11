/**
 * The in-session chrome for Play mode — one-player and two-player.
 *
 * Presentation only. It knows how to SHOW a level, a clock, a score and a
 * verdict; it never decides any of them. session.js owns the run and calls in
 * here, which keeps the one question that matters — "has this player built the
 * thing?" — in a single place with the rules, instead of spread across the UI.
 *
 * Two-player is a split of the OVERLAY, not of the scene: one camera, one
 * three.js canvas, a solid divider down the middle and a panel on each side.
 * Whoever is on the left plays into the left half of the frame; builder.js
 * enforces that boundary. It is the cheapest thing that can work on a single
 * webcam, and it is why the mode asks phones to turn sideways first.
 */

const HTML = `
  <div class="play-bar">
    <button class="play-quit" title="Back to the menu (Esc)">&larr; menu</button>
    <div class="play-level">
      <span class="pl-k" data-level-label>level</span>
      <span class="pl-v" data-level>1</span>
      <div class="pl-dots" data-dots></div>
    </div>
    <div class="play-clock" data-clock>0:00</div>
    <span class="play-bonus" data-bonus aria-live="polite"></span>
    <div class="play-total" data-total-wrap>
      <span class="pl-k">score</span>
      <span class="pl-v" data-total>0</span>
    </div>
  </div>

  <!-- What to build, in the middle at the top: both players read the same
       card, because both are racing the same target. -->
  <div class="play-goal" data-goal>
    <div class="goal-art" data-art></div>
    <div class="goal-text">
      <div class="goal-title">
        <span data-title>—</span>
        <span class="goal-diff" data-diff></span>
      </div>
      <div class="goal-brief" data-brief>—</div>
    </div>
  </div>

  <!-- Solo: one hint line, low and centred so it never sits over your hands. -->
  <div class="play-hint" data-solo>
    <span class="ph-v" data-solo-hint>—</span>
  </div>

  <!-- Versus: a divider plus a mirrored panel per side. -->
  <div class="play-split hidden" data-split>
    <div class="ps-line"></div>
    <div class="ps-side left">
      <div class="ps-name">Player 1</div>
      <div class="ps-score" data-score="1">0</div>
      <div class="ps-wins"><span data-wins="1">0</span> rounds</div>
      <div class="ps-state" data-state="1">ready</div>
    </div>
    <div class="ps-side right">
      <div class="ps-name">Player 2</div>
      <div class="ps-score" data-score="2">0</div>
      <div class="ps-wins"><span data-wins="2">0</span> rounds</div>
      <div class="ps-state" data-state="2">ready</div>
    </div>
    <div class="ps-hints">
      <div class="ps-hint left" data-hint="1">—</div>
      <div class="ps-hint right" data-hint="2">—</div>
    </div>
  </div>

  <!-- One overlay for every full-screen moment: the countdown into a level,
       the verdict after one, and the summary at the end. They are mutually
       exclusive by nature, so they share the layer rather than racing for it. -->
  <div class="play-over hidden" data-over>
    <div class="over-card" data-over-card>
      <div class="over-kicker" data-over-kicker></div>
      <div class="over-title" data-over-title></div>
      <div class="over-sub" data-over-sub></div>
      <div class="over-art hidden" data-over-art></div>
      <div class="over-rows hidden" data-over-rows></div>
      <div class="over-btns hidden" data-over-btns>
        <button class="menu-btn ghost" data-over-menu>menu</button>
        <button class="menu-btn ghost hidden" data-over-share>copy result</button>
        <button class="menu-btn" data-over-again>play again</button>
      </div>
    </div>
  </div>
`;

export function initPlay({ onQuit, onAgain }) {
  const root = document.createElement("div");
  root.id = "play";
  root.className = "hidden";
  root.innerHTML = HTML;
  document.body.appendChild(root);

  const q = (sel) => root.querySelector(sel);
  const dots = q("[data-dots]");
  const over = q("[data-over]");
  let players = 1;

  /**
   * @param {number} levels how many dots to draw; 0 for a run without an end
   * @param {{label?: string}} [opts] what the counter in the top bar is called
   */
  function open(count = 1, levels = 1, { label = "level" } = {}) {
    players = count === 2 ? 2 : 1;
    q("[data-level-label]").textContent = label;
    dots.classList.toggle("hidden", !levels);
    setClockWarn(false);
    root.classList.remove("hidden");
    root.classList.toggle("versus", players === 2);
    q("[data-split]").classList.toggle("hidden", players === 1);
    q("[data-solo]").classList.toggle("hidden", players === 2);
    q("[data-total-wrap]").classList.toggle("hidden", players === 2);
    document.body.classList.add("play-up");

    // One dot per level, rebuilt per run: the ladder can be a different length
    // in a different mode.
    dots.textContent = "";
    for (let i = 0; i < levels; i++) {
      const d = document.createElement("i");
      d.className = "pl-dot";
      dots.appendChild(d);
    }
    setClock(0);
    setTotal(0);
    for (const p of [1, 2]) { setScore(p, 0); setWins(p, 0); setState(p, "ready"); setHint(p, "—"); }
    hideOverlay();
  }

  function close() {
    root.classList.add("hidden");
    document.body.classList.remove("play-up");
  }

  /** The level card: picture, name, and the one-line brief. */
  function setGoal(level, art, index, total) {
    q("[data-art]").innerHTML = art;
    q("[data-title]").textContent = level.title;
    // Which of the three variants of this theme you are being asked for. In
    // two-player the ladder mixes difficulties, so this is the only thing on
    // screen that says the round just got harder.
    const diff = q("[data-diff]");
    diff.textContent = level.difficulty ?? "";
    diff.className = `goal-diff${level.difficulty ? ` ${level.difficulty}` : " hidden"}`;
    q("[data-brief]").textContent = level.brief;
    q("[data-goal]").classList.remove("recall");
    q("[data-level]").textContent = total ? `${index + 1}/${total}` : String(index + 1);
    [...dots.children].forEach((d, i) => {
      d.classList.toggle("past", i < index);
      d.classList.toggle("on", i === index);
    });
  }

  /** Memory mode: the picture and the brief give way to a question mark. The
   *  next setGoal puts them back. */
  function setGoalHidden(hidden) {
    if (!hidden) return;
    q("[data-goal]").classList.add("recall");
    q("[data-art]").innerHTML = `<span class="goal-q" aria-hidden="true">?</span>`;
    q("[data-brief]").textContent = "Build it from memory.";
  }

  /** Seconds in, mm:ss out. Counting up or down is the caller's business. */
  function setClock(seconds) {
    const s = Math.max(0, Math.round(seconds));
    q("[data-clock]").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  /** The last few seconds: the clock goes red. */
  function setClockWarn(on) {
    q("[data-clock]").classList.toggle("warn", !!on);
  }

  /** A short "+12s" that floats up beside the clock and fades. */
  function bonus(text) {
    const el = q("[data-bonus]");
    el.textContent = text;
    el.classList.remove("pop");
    void el.offsetWidth;          // restart the animation if it is mid-flight
    el.classList.add("pop");
  }

  const setTotal = (v) => { q("[data-total]").textContent = String(v); };

  const put = (sel, value) => {
    const el = root.querySelector(sel);
    if (el) el.textContent = String(value);
  };

  /** In one-player mode player 1 is also the total in the top bar. */
  const setScore = (player, value) => {
    put(`[data-score="${player}"]`, value);
    if (players === 1 && player === 1) setTotal(value);
  };
  const setWins = (player, value) => put(`[data-wins="${player}"]`, value);
  const setState = (player, text) => put(`[data-state="${player}"]`, text);

  /** What this player still has to fix. The solo layout has one of these; the
   *  versus layout has one per side, each under that player's own half. */
  function setHint(player, text) {
    if (players === 1) { if (player === 1) put("[data-solo-hint]", text); return; }
    put(`[data-hint="${player}"]`, text);
  }

  /** Mark a side as solved / racing, for the colour band round its panel. */
  function setSolved(player, solved) {
    root.querySelector(`.ps-side.${player === 1 ? "left" : "right"}`)
      ?.classList.toggle("solved", !!solved);
  }

  // ---- the full-screen moments ----

  let shareText = "";

  function overlay({ kicker = "", title = "", sub = "", rows = null, buttons = false, share = "", art = "", tone = "" }) {
    shareText = share;
    const artEl = q("[data-over-art]");
    artEl.classList.toggle("hidden", !art);
    artEl.innerHTML = art;
    const shareBtn = q("[data-over-share]");
    shareBtn.classList.toggle("hidden", !share);
    shareBtn.textContent = "copy result";
    over.classList.remove("hidden");
    q("[data-over-card]").className = `over-card${tone ? ` ${tone}` : ""}`;
    q("[data-over-kicker]").textContent = kicker;
    q("[data-over-title]").textContent = title;
    q("[data-over-sub]").textContent = sub;

    const rowsEl = q("[data-over-rows]");
    rowsEl.classList.toggle("hidden", !rows);
    rowsEl.innerHTML = rows
      ? rows.map((r) => `<div class="over-row${r.win ? " win" : ""}">
            <span>${r.label}</span><span>${r.value}</span></div>`).join("")
      : "";

    q("[data-over-btns]").classList.toggle("hidden", !buttons);
  }

  const hideOverlay = () => over.classList.add("hidden");

  /** The 3-2-1 into a level. Big, and nothing else on screen. */
  const countdown = (n, sub = "") =>
    overlay({ kicker: "get ready", title: n > 0 ? String(n) : "go", sub, tone: "count" });

  q(".play-quit").addEventListener("click", () => onQuit());
  q("[data-over-menu]").addEventListener("click", () => onQuit());
  q("[data-over-again]").addEventListener("click", () => onAgain?.());
  q("[data-over-share]").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.textContent = (await copy(shareText)) ? "copied" : "copy failed";
  });

  return {
    open, close, setGoal, setGoalHidden, setClock, setClockWarn, bonus, setTotal, setScore, setWins, setState,
    setHint, setSolved, overlay, hideOverlay, countdown,
    isOpen: () => !root.classList.contains("hidden"),
    get players() { return players; },
  };
}

/** Clipboard, with the old select-and-copy fallback for http:// on a LAN. */
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { /* nothing left to try */ }
    area.remove();
    return ok;
  }
}
