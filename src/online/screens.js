import { ALL_LEVELS, DIFFICULTIES, DIFFICULTY_LABEL, todayKey } from "../levels.js";
import * as acct from "./client.js";
import * as api from "./api.js";
import { MODES, GROUPS, modeById, RANKED, maxFor, minFor, fillSettings, settingsText } from "./modes.js";

/**
 * The online screens: account, quick match, room browser, room creation, the
 * room lobby and the leaderboards. Built on the start menu's parts (the same
 * grid, heads, segmented controls and buttons), so going online reads as more
 * of the same app.
 *
 * Presentation and input only, the way menu.js is. Rooms live in room.js, a
 * match in match.js, and starting a game in main.js.
 *
 *   camera   { ready(), enable() } — the room shows who is ready to play
 *   onExit() back to the start menu
 */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const GUEST_NAME = /^Player[0-9a-f]{6,8}$/i;
const QUICK_KEY = "arb.online.quick";
const ROOMS_POLL_MS = 5000;
/** How your own row reads when it is not (yet) ranked. */
const STATUS_NOTE = { guest: " · guest, not ranked", review: " · under review", hidden: " · hidden" };

const HTML = `
  <div class="menu-wrap">
    <div class="menu-brand">
      <img class="menu-mark" src="./assets/logo-mark.svg" alt="" width="40" height="42" />
      <h1>Air Blocks</h1>
      <p class="menu-tag">Online. Play together, climb the boards.</p>
    </div>

    <section class="menu-screen" data-screen="hub">
      <div class="menu-head">
        <button class="menu-back" data-exit>&larr; back</button>
        <span class="menu-crumb">online</span>
        <span class="ol-me" data-me></span>
      </div>
      <form class="ol-panel ol-prompt hidden" data-act="nick" data-name-prompt>
        <span class="ol-title">Pick a nickname</span>
        <span class="ol-form-row">
          <input class="ol-input" name="nick" maxlength="16" placeholder="nickname" autocomplete="nickname" required>
          <button class="menu-btn">save</button>
        </span>
        <span class="ol-note" data-note="prompt">It shows on leaderboards and in rooms. 3–16 letters, numbers or _.</span>
      </form>
      <div class="menu-grid">
        <button class="menu-card" data-show="quick">
          <span class="mc-key">01</span>
          <span class="mc-name">Quick match</span>
          <span class="mc-desc">Pick the games you're up for. Jump into the fullest open room, or open one.</span>
        </button>
        <button class="menu-card" data-show="browse">
          <span class="mc-key">02</span>
          <span class="mc-name">Rooms</span>
          <span class="mc-desc">Browse public rooms, or join a friend's with their code.</span>
        </button>
        <button class="menu-card" data-show="create">
          <span class="mc-key">03</span>
          <span class="mc-name">Create a room</span>
          <span class="mc-desc">Public or private. You pick the game, the players and the rules.</span>
        </button>
        <button class="menu-card" data-show="boards">
          <span class="mc-key">04</span>
          <span class="mc-name">Leaderboards</span>
          <span class="mc-desc">The level ladder, today's daily, and every game's best.</span>
        </button>
      </div>
      <p class="menu-fine" data-note="hub"></p>
    </section>

    <section class="menu-screen hidden" data-screen="quick">
      <div class="menu-head">
        <button class="menu-back" data-back="hub">&larr; back</button>
        <span class="menu-crumb">quick match</span>
      </div>
      <p class="menu-fine play-note">Tick every game you'd play. You join the open public room with the most players, or start a new one for others to find.</p>
      <div class="ol-panel"><div class="ol-chips" data-quick></div></div>
      <div class="menu-actions">
        <button class="menu-btn" data-quick-go>Find a match</button>
        <span class="ol-note" data-note="quick"></span>
      </div>
    </section>

    <section class="menu-screen hidden" data-screen="browse">
      <div class="menu-head">
        <button class="menu-back" data-back="hub">&larr; back</button>
        <span class="menu-crumb">rooms</span>
        <form class="ol-form-row ol-join" data-act="join">
          <input class="ol-input code" name="code" maxlength="6" placeholder="code" autocomplete="off" spellcheck="false" required>
          <button class="menu-btn">join</button>
        </form>
      </div>
      <p class="ol-note err hidden" data-note="join"></p>
      <div class="ol-table" data-rooms></div>
      <p class="menu-fine">Private rooms never show here: you need their code.</p>
    </section>

    <section class="menu-screen hidden" data-screen="create">
      <div class="menu-head">
        <button class="menu-back" data-back="hub">&larr; back</button>
        <span class="menu-crumb">create a room</span>
      </div>
      <div class="ol-panel ol-form" data-create></div>
      <div class="menu-actions">
        <button class="menu-btn" data-create-go>Create room</button>
        <span class="ol-note" data-note="create"></span>
      </div>
    </section>

    <section class="menu-screen hidden" data-screen="room">
      <div class="menu-head">
        <button class="menu-back" data-leave>&larr; leave room</button>
        <span class="menu-crumb" data-room-vis>room</span>
        <span class="ol-code-wrap">
          <span class="ol-code" data-room-code>——————</span>
          <button class="menu-btn ghost" data-copy="code">copy code</button>
          <button class="menu-btn ghost" data-copy="link">copy link</button>
        </span>
      </div>
      <div class="ol-room">
        <div class="ol-panel">
          <div class="ol-panel-head">
            <span class="ol-title">Players</span>
            <span class="ol-label" data-room-count></span>
          </div>
          <div class="ol-players" data-players></div>
        </div>
        <div class="ol-panel ol-form" data-room-form></div>
      </div>
      <div class="menu-actions">
        <button class="menu-btn ghost hidden" data-camera>enable camera</button>
        <button class="menu-btn" data-start>Start game</button>
        <span class="ol-note" data-note="room"></span>
      </div>
    </section>

    <section class="menu-screen hidden" data-screen="boards">
      <div class="menu-head">
        <button class="menu-back" data-back="hub">&larr; back</button>
        <span class="menu-crumb">leaderboards</span>
        <div class="seg" data-board-tabs>
          <button class="seg-btn" data-board-tab="ladder">Levels</button>
          <button class="seg-btn" data-board-tab="daily">Daily</button>
          <button class="seg-btn" data-board-tab="games">Games</button>
        </div>
      </div>
      <div class="ol-filters" data-board-filters></div>
      <p class="ol-note" data-note="boards"></p>
      <div class="ol-table" data-board></div>
    </section>

    <section class="menu-screen hidden" data-screen="account">
      <div class="menu-head">
        <button class="menu-back" data-back="hub">&larr; back</button>
        <span class="menu-crumb">account</span>
      </div>
      <div class="ol-account" data-account></div>
    </section>
  </div>
`;

export function initOnline({ link, match, camera, onExit }) {
  const root = document.createElement("div");
  root.id = "online";
  root.className = "hidden";
  root.innerHTML = HTML;
  document.body.appendChild(root);

  const q = (sel) => root.querySelector(sel);
  const screens = [...root.querySelectorAll(".menu-screen")];
  let current = "hub";
  let roomsTimer = 0;
  let boardTicket = 0;

  const draft = { mode: "ladder", visibility: "private", max: 8, settings: fillSettings("ladder") };
  const board = { tab: "ladder", diff: "all", level: "", day: todayKey(), mode: "rush" };
  let quick = new Set(readQuick());
  // Account screen: which form shows, the email typed so far (kept across
  // repaints and tab switches), and a "sign in instead?" style prompt.
  const auth = { tab: "signup", email: "", offer: null };

  function note(name, text = "", error = false) {
    const el = q(`[data-note="${name}"]`);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("err", !!error);
    if (name === "join") el.classList.toggle("hidden", !text);
  }

  function show(name) {
    current = name;
    for (const s of screens) s.classList.toggle("hidden", s.dataset.screen !== name);
    clearInterval(roomsTimer);
    if (name === "hub") paintHub();
    if (name === "quick") paintQuick();
    if (name === "browse") { note("join"); loadRooms(); roomsTimer = setInterval(loadRooms, ROOMS_POLL_MS); }
    if (name === "create") paintCreate();
    if (name === "room") { note("room"); paintRoom(); }
    if (name === "boards") paintBoards();
    if (name === "account") paintAccount();
  }

  // ---- hub & account chip ----

  function paintHub() {
    const a = acct.account();
    // No guest is made just for looking around: one is made when you first
    // play, join a room or sign up.
    q("[data-me]").innerHTML = (a.user
      ? `<span>${esc(a.nickname ?? "…")}</span><span class="ol-badge">${a.guest ? "guest" : "account"}</span>`
      : "") + `<button class="menu-btn ghost" data-show="account">${a.user && !a.guest ? "account" : "sign up / sign in"}</button>`;
    const prompt = q("[data-name-prompt]");
    prompt.classList.toggle("hidden", !(a.nickname && GUEST_NAME.test(a.nickname)));
    note("hub", a.offline ? "Can't reach the server. Check your connection and try again." : "");
  }

  acct.onAccount(() => {
    if (!isOpen()) return;
    if (current === "hub") paintHub();
    if (current === "account") paintAccount();
  });

  // ---- create / room settings form ----

  function formHtml(f, editable, form) {
    const attrs = (field, value, disabled = false) =>
      `data-form="${form}" data-field="${field}" data-value="${esc(value)}"${!editable || disabled ? " disabled" : ""}`;
    const seg = (field, options, value, isDisabled = () => false) => `
      <div class="seg">${options.map(([v, label]) => `
        <button class="seg-btn${String(v) === String(value) ? " on" : ""}" ${attrs(field, v, isDisabled(v))}>${esc(label)}</button>`).join("")}
      </div>`;
    const mode = modeById(f.mode);
    const max = maxFor(f.mode);
    return `
      <div class="ol-field">
        <span class="ol-label">Game</span>
        <div>
          <div class="ol-chips">${GROUPS.map((g) => `
            <span class="ol-group">${g.label}</span>
            ${MODES.filter((m) => m.group === g.id).map((m) => `
              <button class="ol-chip${m.id === f.mode ? " on" : ""}" ${attrs("mode", m.id)}>${esc(m.name)}</button>`).join("")}`).join("")}
          </div>
          <p class="ol-note ol-blurb">${esc(mode?.blurb ?? "")}</p>
        </div>
      </div>
      <div class="ol-field">
        <span class="ol-label">Room</span>
        ${seg("visibility", [["public", "Public"], ["private", "Private"]], f.visibility)}
      </div>
      <div class="ol-field">
        <span class="ol-label">Players</span>
        ${seg("max", [2, 3, 4, 5, 6, 7, 8].map((n) => [n, String(n)]), f.max, (n) => n > max)}
      </div>
      ${(mode?.settings ?? []).map((s) => `
        <div class="ol-field">
          <span class="ol-label">${esc(s.label)}</span>
          ${seg(`s:${s.key}`, s.options, f.settings[s.key])}
        </div>`).join("")}`;
  }

  function applyField(f, field, value) {
    if (field === "mode") {
      f.mode = value;
      f.settings = fillSettings(value);
      f.max = Math.max(2, Math.min(f.max, maxFor(value)));
    } else if (field === "visibility") {
      f.visibility = value;
    } else if (field === "max") {
      f.max = Math.max(2, Math.min(Number(value), maxFor(f.mode)));
    } else if (field.startsWith("s:")) {
      f.settings = fillSettings(f.mode, { ...f.settings, [field.slice(2)]: value });
    }
  }

  function paintCreate() {
    draft.max = Math.min(draft.max, maxFor(draft.mode));
    q("[data-create]").innerHTML = formHtml(draft, true, "create");
  }

  const roomForm = (r) => ({
    mode: r.mode, visibility: r.visibility, max: r.max_players, settings: fillSettings(r.mode, r.settings),
  });

  // ---- room ----

  function paintRoom() {
    const room = link.room;
    if (!room) return;
    const host = link.isHost;
    const peers = link.peers;
    const peerOf = (uid) => peers.find((p) => p.user_id === uid);

    q("[data-room-code]").textContent = room.code;
    q("[data-room-vis]").textContent = `${room.visibility} room`;
    q("[data-room-count]").textContent = `${room.player_count} / ${room.max_players}`;

    const rows = room.players.map((p) => {
      const peer = peerOf(p.user_id);
      const status = !peer ? "connecting" : peer.phase === "playing" ? "in game" : peer.phase === "done" ? "finished" : peer.camera ? "ready" : "no camera yet";
      return `
        <div class="ol-player">
          <span class="ol-dot${peer?.camera ? " ready" : peer ? " on" : ""}"></span>
          <span class="ol-nick">${esc(p.nickname)}${p.user_id === link.me ? " <em>(you)</em>" : ""}</span>
          ${p.user_id === room.host_id ? `<span class="ol-badge fill">host</span>` : ""}
          <span class="ol-status">${status}</span>
          ${host && p.user_id !== link.me ? `<button class="menu-btn ghost" data-kick="${esc(p.user_id)}">kick</button>` : ""}
        </div>`;
    });
    for (let i = room.players.length; i < room.max_players; i++) {
      rows.push(`<div class="ol-player empty"><span class="ol-dot"></span><span class="ol-nick">open slot</span></div>`);
    }
    q("[data-players]").innerHTML = rows.join("");

    q("[data-room-form]").innerHTML = formHtml(roomForm(room), host && room.status === "lobby", "room");

    const ready = camera.ready();
    q("[data-camera]").classList.toggle("hidden", ready);
    const start = q("[data-start]");
    const min = minFor(room.mode);
    start.classList.toggle("hidden", !host);
    start.disabled = room.status !== "lobby" || room.player_count < min;
    start.textContent = room.status === "playing" ? "Game in progress" : "Start game";

    if (!q('[data-note="room"]').classList.contains("err")) {
      note("room", host
        ? room.player_count < min
          ? `${modeById(room.mode)?.name} needs ${min} players. Share the code.`
          : `${modeById(room.mode)?.name}${settingsText(room.mode, room.settings) ? ` · ${settingsText(room.mode, room.settings)}` : ""}. Start when everyone's in.`
        : "Waiting for the host to start.");
    }

    // A host who inherits a room mid-match, or came back without one, frees
    // the room for the next game.
    if (host && room.status === "playing" && !match.active) {
      link.setStatus("lobby").catch(() => {});
    }
  }

  link.on("room", (room, reason) => {
    if (!isOpen()) return;
    if (!room) {
      if (current === "room") {
        show("hub");
        if (reason === "kicked") note("hub", "The host removed you from the room.", true);
        if (reason === "dropped") note("hub", "Lost the connection to the room.", true);
      }
      return;
    }
    if (current === "room") paintRoom();
  });
  link.on("presence", () => { if (isOpen() && current === "room") paintRoom(); });

  async function enterRoom(promise, noteName) {
    note(noteName, "Connecting…");
    try {
      await promise;
      show("room");
    } catch (err) {
      note(noteName, friendly(err), true);
    }
  }

  // ---- quick match ----

  function readQuick() {
    try {
      const saved = JSON.parse(localStorage.getItem(QUICK_KEY) || "null");
      if (Array.isArray(saved) && saved.length) return saved.filter((id) => modeById(id));
    } catch { /* fall through */ }
    return ["ladder", "rush"];
  }

  function paintQuick() {
    q("[data-quick]").innerHTML = GROUPS.map((g) => `
      <span class="ol-group">${g.label}</span>
      ${MODES.filter((m) => m.group === g.id).map((m) => `
        <button class="ol-chip${quick.has(m.id) ? " on" : ""}" data-quick-mode="${m.id}">${esc(m.name)}</button>`).join("")}`).join("");
    q("[data-quick-go]").disabled = !quick.size;
  }

  // ---- browse ----

  async function loadRooms() {
    const el = q("[data-rooms]");
    if (!el.children.length) el.innerHTML = `<div class="ol-empty">Looking for rooms…</div>`;
    try {
      const rooms = await api.listRooms();
      if (current !== "browse") return;
      el.innerHTML = rooms.length
        ? `<div class="ol-row head c-rooms"><span>game</span><span>host</span><span>players</span><span></span></div>` +
          rooms.map((r) => {
            const full = r.player_count >= r.max_players;
            return `
              <div class="ol-row c-rooms">
                <span class="ol-cell"><span class="ol-strong">${esc(modeById(r.mode)?.name ?? r.mode)}</span>
                  <span class="ol-sub">${esc(settingsText(r.mode, r.settings) || modeById(r.mode)?.blurb || "")}</span></span>
                <span class="ol-cell">${esc(r.host)}</span>
                <span class="ol-val">${r.player_count}/${r.max_players}</span>
                <button class="menu-btn${full ? " ghost" : ""}" data-join="${esc(r.code)}"${full ? " disabled" : ""}>${full ? "full" : "join"}</button>
              </div>`;
          }).join("")
        : `<div class="ol-empty">No public rooms right now. Create one, or use Quick match to open one for others.</div>`;
    } catch (err) {
      if (current === "browse") el.innerHTML = `<div class="ol-empty">Couldn't load rooms. ${esc(friendly(err))}</div>`;
    }
  }

  // ---- leaderboards ----

  function paintBoards() {
    for (const b of q("[data-board-tabs]").children) b.classList.toggle("on", b.dataset.boardTab === board.tab);
    const f = q("[data-board-filters]");
    if (board.tab === "ladder") {
      const levels = ALL_LEVELS.filter((l) => board.diff === "all" || l.difficulty === board.diff);
      if (board.level && !levels.some((l) => l.id === board.level)) board.level = "";
      f.innerHTML = `
        <div class="seg">${["all", ...DIFFICULTIES].map((d) => `
          <button class="seg-btn${board.diff === d ? " on" : ""}" data-board-diff="${d}">${d === "all" ? "All" : DIFFICULTY_LABEL[d]}</button>`).join("")}
        </div>
        <select class="ol-input" data-board-level>
          <option value="">Overall · stars then points</option>
          ${levels.map((l) => `<option value="${l.id}"${l.id === board.level ? " selected" : ""}>${esc(l.packName)} · ${esc(l.title)}${board.diff === "all" ? ` (${l.difficulty})` : ""}</option>`).join("")}
        </select>`;
    } else if (board.tab === "daily") {
      const today = todayKey();
      f.innerHTML = `
        <button class="menu-btn ghost" data-board-day="-1">&larr; earlier</button>
        <span class="ol-day">${board.day === today ? "today" : esc(board.day)}</span>
        <button class="menu-btn ghost" data-board-day="1"${board.day >= today ? " disabled" : ""}>later &rarr;</button>`;
    } else {
      f.innerHTML = `<div class="ol-chips">${MODES.filter((m) => RANKED.has(m.id)).map((m) => `
        <button class="ol-chip${m.id === board.mode ? " on" : ""}" data-board-mode="${m.id}">${esc(m.name)}</button>`).join("")}</div>`;
    }
    loadBoard();
  }

  async function loadBoard() {
    const ticket = ++boardTicket;
    const el = q("[data-board]");
    el.innerHTML = `<div class="ol-empty">Loading…</div>`;
    try {
      let head, rows;
      if (board.tab === "ladder" && board.level) {
        const data = await api.levelBoard(board.level);
        head = ["#", "player", "time", "points"];
        rows = data.map((r) => [r.rank, r.nickname, `${Number(r.best_time).toFixed(1)}s`, r.best_points, r]);
      } else if (board.tab === "ladder") {
        const data = await api.ladderBoard(board.diff === "all" ? null : board.diff);
        head = ["#", "player", "stars", "points"];
        rows = data.map((r) => [r.rank, r.nickname, `★ ${r.stars}`, r.points, r]);
      } else if (board.tab === "daily") {
        const data = await api.dailyBoard(board.day);
        head = ["#", "player", "built", "score"];
        rows = data.map((r) => [r.rank, r.nickname, `${r.built}/5`, r.score, r]);
      } else {
        const data = await api.modeBoard(board.mode);
        head = ["#", "player", "runs", "best"];
        rows = data.map((r) => [r.rank, r.nickname, r.runs, r.best, r]);
      }
      if (ticket !== boardTicket) return;
      const me = acct.account();
      note("boards", me.guest
        ? "Only players with an account are ranked. Your guest scores are saved, and count once you sign up."
        : "");
      if (!rows.length) {
        el.innerHTML = `<div class="ol-empty">${board.tab === "daily" ? "Nobody has finished this daily yet." : "No scores yet. Be the first."}</div>`;
        return;
      }
      // Reporting takes a real account, so a report cannot come from a
      // throwaway guest.
      const canReport = !!me.user && !me.guest;
      let prev = 0;
      el.innerHTML = `<div class="ol-row head c-board">${head.map((h) => `<span>${h}</span>`).join("")}</div>` +
        rows.map(([rank, name, a, b, r]) => {
          const gap = prev > 0 && (rank == null || rank > prev + 1);
          if (rank != null) prev = rank;
          const tag = r.is_me ? ` <em>(you${STATUS_NOTE[r.status] ?? ""})</em>` : "";
          const report = canReport && !r.is_me ? `<button class="ol-report" data-report="${esc(name)}">report</button>` : "";
          return `
            <div class="ol-row c-board${r.is_me ? " me" : ""}${gap ? " gap" : ""}">
              <span class="ol-num">${rank ?? "—"}</span>
              <span class="ol-cell ol-name-cell"><span class="ol-nick">${esc(name)}${tag}</span>${report}</span>
              <span class="ol-val soft">${esc(a)}</span>
              <span class="ol-val">${esc(b)}</span>
            </div>`;
        }).join("");
    } catch (err) {
      if (ticket === boardTicket) el.innerHTML = `<div class="ol-empty">Couldn't load the leaderboard. ${esc(friendly(err))}</div>`;
    }
  }

  const shiftDay = (key, days) => {
    const [y, m, d] = key.split("-").map(Number);
    return todayKey(new Date(y, m - 1, d + days));
  };

  // ---- account ----

  function paintAccount() {
    const a = acct.account();
    const signedIn = !!a.user && !a.guest;
    const panels = [];
    if (a.user) {
      panels.push(`
      <form class="ol-panel" data-act="nick">
        <span class="ol-title">Nickname</span>
        <span class="ol-form-row">
          <input class="ol-input" name="nick" maxlength="16" value="${esc(a.nickname ?? "")}" autocomplete="nickname" required>
          <button class="menu-btn">save</button>
        </span>
        <span class="ol-note" data-note="nick">3–16 letters, numbers or _. Shown on leaderboards and in rooms.</span>
      </form>`);
    }

    if (a.verify) {
      const why = { email_change: "to confirm it", recovery: "to reset your password", email: "to sign in" }[a.verify.type];
      panels.push(`
        <form class="ol-panel" data-act="code">
          <span class="ol-title">Check your email</span>
          <span class="ol-note">We sent a code and a link to <strong>${esc(a.verify.email)}</strong> ${why}. Type the code here, or click the link in the email. Not there? Check spam.</span>
          <span class="ol-form-row">
            <input class="ol-input code" name="code" inputmode="numeric" maxlength="10" placeholder="code" autocomplete="one-time-code" spellcheck="false" required>
            <button class="menu-btn">confirm</button>
            <button type="button" class="menu-btn ghost" data-code-resend>send again</button>
            <button type="button" class="menu-btn ghost" data-code-cancel>cancel</button>
          </span>
          <span class="ol-note" data-note="code"></span>
        </form>`);
    }

    if (acct.needsPassword()) {
      panels.push(`
        <form class="ol-panel" data-act="password">
          <span class="ol-title">Set a password</span>
          <span class="ol-note">${a.recovering ? "Choose a new password." : "Your email is added. Set a password so you can sign in on other devices."}</span>
          <span class="ol-form-row">
            <input class="ol-input" type="password" name="password" minlength="8" placeholder="password (8+ characters)" autocomplete="new-password" required>
            <button class="menu-btn">save password</button>
          </span>
          <span class="ol-note" data-note="password"></span>
        </form>`);
    }

    if (!signedIn && !a.verify) {
      const up = auth.tab === "signup";
      const guestNote = a.user
        ? (up ? "You're playing as a guest. Sign up and your nickname and scores come with you."
              : "Your guest scores move into your account when you sign in.")
        : (up ? "Create an account to get on the leaderboards." : "Welcome back.");
      const offer = auth.offer ? `
          <span class="ol-form-row">
            <span class="ol-note err">${esc(auth.offer.text)}</span>
            <button type="button" class="menu-btn" data-auth-tab="${auth.offer.to}">${auth.offer.to === "signin" ? "sign in instead" : "sign up instead"}</button>
          </span>` : "";
      const email = `<input class="ol-input" type="email" name="email" placeholder="email" autocomplete="email" value="${esc(auth.email)}" required>`;
      panels.push(`
        <form class="ol-panel" data-act="${up ? "register" : "signin"}" data-auth>
          <div class="seg ol-tabs">
            <button type="button" class="seg-btn${up ? " on" : ""}" data-auth-tab="signup">Sign up</button>
            <button type="button" class="seg-btn${up ? "" : " on"}" data-auth-tab="signin">Sign in</button>
          </div>
          <span class="ol-note">${guestNote}</span>
          ${up ? `
          <span class="ol-form-row">
            ${email}
            <button class="menu-btn">sign up</button>
          </span>
          <span class="ol-note">We email you a code and a link to confirm it's yours. Then you pick a password.</span>` : `
          <span class="ol-form-row">
            ${email}
            <input class="ol-input" type="password" name="password" placeholder="password" autocomplete="current-password" required>
            <button class="menu-btn">sign in</button>
          </span>
          <span class="ol-form-row">
            <button type="button" class="menu-btn ghost" data-email-code>email me a code or link</button>
            <button type="button" class="menu-btn ghost" data-forgot>forgot password?</button>
          </span>`}
          ${offer}
          <span class="ol-note" data-note="${up ? "register" : "signin"}"></span>
        </form>`);
    } else if (signedIn) {
      panels.push(`
        <div class="ol-panel">
          <span class="ol-title">Signed in</span>
          <span class="ol-note">${esc(a.email ?? "")}</span>
          <span class="ol-form-row">
            <button class="menu-btn ghost" data-reset-password>reset password</button>
            <button class="menu-btn ghost" data-signout>sign out</button>
          </span>
          <span class="ol-note" data-note="signed"></span>
        </div>
        <form class="ol-panel" data-act="change-email">
          <span class="ol-title">Change email</span>
          <span class="ol-form-row">
            <input class="ol-input" type="email" name="email" placeholder="new email" autocomplete="email" required>
            <button class="menu-btn">change email</button>
          </span>
          <span class="ol-note" data-note="change-email">We email a code to confirm the new address.</span>
        </form>`);
    }
    q("[data-account]").innerHTML = panels.join("");
  }

  // ---- input ----

  root.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = Object.fromEntries(new FormData(form));
    const button = form.querySelector("button:not([type=button])");
    const act = form.dataset.act;
    const say = (text, error = false) => {
      const target = act === "nick" && form.matches("[data-name-prompt]") ? "prompt" : act;
      note(target, text, error);
    };
    if (button) button.disabled = true;
    try {
      if (act === "nick") {
        const nick = String(data.nick ?? "").trim();
        if (!/^[A-Za-z0-9_]{3,16}$/.test(nick)) throw new Error("Use 3–16 letters, numbers or _.");
        await acct.setNickname(nick);
        say("Saved.");
        link.track({});
        if (current === "hub") paintHub();
      } else if (act === "join") {
        await enterRoom(link.join(String(data.code).trim().toUpperCase()), "join");
      } else if (act === "register") {
        auth.offer = null;
        await acct.register(String(data.email).trim());
        paintAccount();
      } else if (act === "change-email") {
        const { confirmed } = await acct.changeEmail(String(data.email).trim());
        paintAccount();
        if (confirmed) note("signed", "Email changed.");
      } else if (act === "code") {
        const type = acct.account().verify?.type;
        const { done } = await acct.verifyCode(String(data.code));
        paintAccount();
        if (!done) {
          note("code", "Code accepted. Now enter the code sent to your other email address.");
        } else if (!acct.needsPassword()) {
          note("signed", type === "email" ? "Signed in." : "Email confirmed.");
        }
      } else if (act === "signin") {
        auth.offer = null;
        await acct.signIn(String(data.email).trim(), String(data.password));
        say("Signed in.");
      } else if (act === "password") {
        await acct.setPassword(String(data.password));
        paintAccount();
        note("nick", "Password saved.");
      }
    } catch (err) {
      if (!((act === "register" || act === "signin") && offerSwitch(err))) say(friendly(err), true);
    } finally {
      if (button) button.disabled = false;
    }
  });

  /** Signing up with an email that has an account, or signing in with one that
   *  doesn't: say so, with a button to the other form. */
  function offerSwitch(err) {
    if (err?.code !== "has_account" && err?.code !== "no_account") return false;
    auth.offer = { text: err.message, to: err.code === "has_account" ? "signin" : "signup" };
    paintAccount();
    return true;
  }

  root.addEventListener("input", (e) => {
    if (e.target.matches('[data-auth] [name="email"]')) auth.email = e.target.value;
  });

  root.addEventListener("click", async (e) => {
    const t = e.target;
    const showTo = t.closest("[data-show]")?.dataset.show;
    if (showTo) { show(showTo); return; }
    const back = t.closest("[data-back]")?.dataset.back;
    if (back) { show(back); return; }
    if (t.closest("[data-exit]")) { onExit(); return; }

    const field = t.closest("[data-field]");
    if (field && !field.disabled) {
      const raw = field.dataset.value;
      const value = /^\d+$/.test(raw) ? Number(raw) : raw;
      if (field.dataset.form === "create") {
        applyField(draft, field.dataset.field, value);
        paintCreate();
      } else if (field.dataset.form === "room" && link.isHost) {
        const f = roomForm(link.room);
        applyField(f, field.dataset.field, value);
        note("room");
        link.update(f).catch((err) => note("room", friendly(err), true));
      }
      return;
    }

    const quickMode = t.closest("[data-quick-mode]")?.dataset.quickMode;
    if (quickMode) {
      if (quick.has(quickMode)) quick.delete(quickMode); else quick.add(quickMode);
      try { localStorage.setItem(QUICK_KEY, JSON.stringify([...quick])); } catch { /* private mode */ }
      paintQuick();
      return;
    }
    if (t.closest("[data-quick-go]")) {
      const btn = t.closest("[data-quick-go]");
      btn.disabled = true;
      btn.textContent = "Searching…";
      await enterRoom(link.quick([...quick]), "quick");
      btn.disabled = false;
      btn.textContent = "Find a match";
      return;
    }

    const join = t.closest("[data-join]")?.dataset.join;
    if (join) { await enterRoom(link.join(join), "join"); return; }

    if (t.closest("[data-create-go]")) {
      const btn = t.closest("[data-create-go]");
      btn.disabled = true;
      await enterRoom(link.create(draft), "create");
      btn.disabled = false;
      return;
    }

    if (t.closest("[data-leave]")) {
      await link.leave();
      show("hub");
      return;
    }
    const kick = t.closest("[data-kick]")?.dataset.kick;
    if (kick) { link.kick(kick).catch((err) => note("room", friendly(err), true)); return; }

    const copy = t.closest("[data-copy]");
    if (copy && link.room) {
      const text = copy.dataset.copy === "link"
        ? `${location.origin}${location.pathname}?room=${link.room.code}`
        : link.room.code;
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = "copied";
      } catch {
        copy.textContent = text;
      }
      setTimeout(() => { copy.textContent = copy.dataset.copy === "link" ? "copy link" : "copy code"; }, 1600);
      return;
    }

    if (t.closest("[data-camera]")) {
      const btn = t.closest("[data-camera]");
      btn.disabled = true;
      try {
        await camera.enable();
        link.track({ camera: true });
      } catch (err) {
        note("room", `Camera: ${err?.message ?? err}`, true);
      } finally {
        btn.disabled = false;
        paintRoom();
      }
      return;
    }

    if (t.closest("[data-start]")) {
      note("room");
      match.start().catch((err) => note("room", friendly(err), true));
      return;
    }

    const reportBtn = t.closest("[data-report]");
    if (reportBtn) {
      reportBtn.disabled = true;
      const where = board.tab === "ladder" ? board.level || `ladder:${board.diff}`
        : board.tab === "daily" ? `daily:${board.day}` : `game:${board.mode}`;
      try {
        await api.reportPlayer(reportBtn.dataset.report, where);
        reportBtn.textContent = "reported";
      } catch (err) {
        reportBtn.textContent = friendly(err);
      }
      return;
    }

    const tab = t.closest("[data-board-tab]")?.dataset.boardTab;
    if (tab) { board.tab = tab; paintBoards(); return; }
    const diff = t.closest("[data-board-diff]")?.dataset.boardDiff;
    if (diff) { board.diff = diff; paintBoards(); return; }
    const day = t.closest("[data-board-day]")?.dataset.boardDay;
    if (day) {
      const next = shiftDay(board.day, Number(day));
      board.day = next > todayKey() ? todayKey() : next;
      paintBoards();
      return;
    }
    const bmode = t.closest("[data-board-mode]")?.dataset.boardMode;
    if (bmode) { board.mode = bmode; paintBoards(); return; }

    if (t.closest("[data-signout]")) {
      if (link.room) await link.leave();
      try { await acct.signOut(); } catch (err) { console.warn(err); }
      auth.tab = "signin";
      auth.offer = null;
      paintAccount();
      if (current === "hub") paintHub();
      return;
    }
    const authTab = t.closest("[data-auth-tab]")?.dataset.authTab;
    if (authTab) {
      auth.tab = authTab;
      auth.offer = null;
      paintAccount();
      return;
    }
    const emailStep = t.closest("[data-forgot], [data-email-code]");
    if (emailStep) {
      const email = emailStep.closest("form")?.querySelector('[name="email"]')?.value.trim();
      if (!email) { note("signin", "Type your email first.", true); return; }
      emailStep.disabled = true;
      auth.offer = null;
      try {
        if (emailStep.matches("[data-forgot]")) await acct.forgotPassword(email);
        else await acct.emailSignIn(email);
        paintAccount();
      } catch (err) {
        if (!offerSwitch(err)) note("signin", friendly(err), true);
      } finally {
        emailStep.disabled = false;
      }
      return;
    }
    if (t.closest("[data-reset-password]")) {
      const btn = t.closest("[data-reset-password]");
      btn.disabled = true;
      try {
        await acct.forgotPassword(acct.account().email);
        paintAccount();
      } catch (err) {
        note("signed", friendly(err), true);
      } finally {
        btn.disabled = false;
      }
      return;
    }
    if (t.closest("[data-code-cancel]")) { acct.cancelCode(); paintAccount(); return; }
    if (t.closest("[data-code-resend]")) {
      const btn = t.closest("[data-code-resend]");
      btn.disabled = true;
      try {
        await acct.resendCode();
        note("code", "Sent again.");
      } catch (err) {
        note("code", friendly(err), true);
      } finally {
        btn.disabled = false;
      }
    }
  });

  root.addEventListener("change", (e) => {
    if (e.target.matches("[data-board-level]")) {
      board.level = e.target.value;
      loadBoard();
    }
  });

  // Esc steps back a screen, like the start menu. From the room it does not:
  // leaving a room should never be one stray keypress.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !isOpen()) return;
    if (e.target.matches?.("input, select")) { e.target.blur(); return; }
    const back = q(`[data-screen="${current}"] [data-back]`)?.dataset.back;
    if (back) show(back);
    else if (current === "hub") onExit();
  });

  function open(screen = "hub") {
    root.classList.remove("hidden");
    document.body.classList.add("menu-up");
    const target = link.room ? "room" : screen === "room" ? "hub" : screen;
    show(target);
    // Show who is signed in, without making a guest just for opening this.
    acct.client().then(() => { if (current === "hub") paintHub(); }).catch(() => paintHub());
  }

  function close() {
    clearInterval(roomsTimer);
    root.classList.add("hidden");
  }

  function isOpen() {
    return !root.classList.contains("hidden");
  }

  /** Join from an invite link (?room=CODE). */
  async function joinCode(code) {
    open("browse");
    await enterRoom(link.join(code), "join");
  }

  return { open, close, isOpen, joinCode };
}

/** Database and auth errors, in words a player can act on. */
function friendly(err) {
  const msg = String(err?.message ?? err ?? "");
  if (/Failed to fetch|NetworkError|Load failed|dynamically imported/i.test(msg)) return "Can't reach the server.";
  if (/Invalid login credentials/i.test(msg)) return "Wrong email or password.";
  if (/Email not confirmed/i.test(msg)) return "Confirm your email first — check your inbox.";
  if (/rate limit/i.test(msg)) return "Too many emails sent. Try again in a while.";
  if (/token has expired|otp_expired|invalid.*(token|otp)|otp.*invalid/i.test(msg)) return "That code is wrong or has expired.";
  if (/only request this after (\d+) seconds/i.test(msg)) return `Wait ${msg.match(/after (\d+) seconds/i)[1]} seconds before sending another email.`;
  if (/Anonymous sign-ins are disabled/i.test(msg)) return "Guest play is switched off on the server.";
  return msg || "Something went wrong.";
}
