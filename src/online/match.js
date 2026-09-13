import { gameById } from "../arcade/catalog.js";
import { modeById } from "./modes.js";

/**
 * One online match: from the host's "start" to everyone back in the room.
 *
 * Nobody's game runs on anyone else's machine. The host sends a START with the
 * game, its settings and a seed; every player launches that game locally, and
 * the seed makes the build modes deal everyone the same targets. While they
 * play, each sends its score once a second; when a game ends it sends a FINAL.
 * The host closes the match once everyone still in the room has a final, and
 * the room goes back to its lobby.
 *
 * Air Pong is the exception that talks the whole way through: the two players
 * send the ball and paddles (see arcade/games/pong.js), over the same channel.
 *
 *   launch(route)   start the local game for a match (main.js)
 *   exit()          leave the match screens and return to the room (main.js)
 */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const HTML = `
  <div class="mt-board" data-board></div>
  <div class="play-over hidden" data-over>
    <div class="over-card">
      <div class="over-kicker" data-kicker>results</div>
      <div class="over-title" data-title></div>
      <div class="over-sub" data-sub></div>
      <div class="over-rows" data-rows></div>
      <div class="over-btns">
        <button class="menu-btn" data-back>back to room</button>
      </div>
    </div>
  </div>
`;

export function initMatch({ link, launch, exit }) {
  const root = document.createElement("div");
  root.id = "match";
  root.className = "hidden";
  root.innerHTML = HTML;
  document.body.appendChild(root);

  const q = (sel) => root.querySelector(sel);
  const over = q("[data-over]");
  let m = null;
  let starting = false;     // host: between "start" pressed and the match existing
  let sentAt = 0;
  let sentScore = null;
  let resultsTimer = 0;

  const nameOf = (uid) => m?.names?.[uid] ?? "player";

  /** Host only: everyone in the room plays the room's game, now. */
  async function start() {
    const room = link.room;
    if (!room || !link.isHost) return;
    const payload = {
      match: crypto.randomUUID(),
      mode: room.mode,
      settings: room.settings ?? {},
      seed: crypto.randomUUID(),
      order: room.players.map((p) => p.user_id),
      names: Object.fromEntries(room.players.map((p) => [p.user_id, p.nickname])),
    };
    // Without the flag, the room screen sees "playing" with no match yet and
    // resets the room to its lobby before the match can begin.
    starting = true;
    try {
      await link.setStatus("playing");
      link.send("start", payload);
      begin(payload);
    } finally {
      starting = false;
    }
  }

  function begin(p) {
    if (m?.id === p.match) return;
    // A player the host did not count in (joined mid-start) sits this one out.
    if (!p.order?.includes(link.me)) return;
    clearTimeout(resultsTimer);
    m = {
      id: p.match, mode: p.mode, order: p.order, names: p.names,
      scores: new Map(), finals: new Map(), done: false, ended: false,
    };
    sentAt = 0;
    sentScore = null;
    over.classList.add("hidden");
    root.classList.remove("hidden");
    document.body.classList.add("online-match");
    link.track({ phase: "playing" });
    paint();
    launch(routeFor(p));
  }

  function routeFor(p) {
    const online = { match: p.match, seed: p.seed, settings: p.settings ?? {} };
    if (!gameById(p.mode)) return { mode: "play", players: 1, kind: p.mode, online };
    const route = { mode: "arcade", game: p.mode, players: 1, online };
    if (p.mode === "pong") route.net = pongNet(p);
    return route;
  }

  function pongNet(p) {
    const [left, right] = p.order;
    return {
      side: left === link.me ? "left" : "right",
      names: [p.names[left], p.names[right]],
      to: Number(p.settings?.to) || 7,
      send: (msg) => link.send("pong", msg),
      listen: (fn) => link.on("event", (type, msg) => { if (type === "pong") fn(msg); }),
    };
  }

  /** Every rendered frame while a match game is up, with this player's score. */
  function frame(now, score) {
    if (!m || m.done) return;
    m.scores.set(link.me, score);
    if (now - sentAt < 1000) return;
    if (score === sentScore && now - sentAt < 4000) return;
    sentAt = now;
    sentScore = score;
    link.send("score", { match: m.id, user_id: link.me, score });
    paint();
  }

  /** This player's game is over. */
  function finish({ score = 0 } = {}) {
    if (!m || m.done) return;
    m.done = true;
    const fin = { match: m.id, user_id: link.me, score: Number(score) || 0 };
    m.finals.set(link.me, fin);
    m.scores.set(link.me, fin.score);
    link.send("final", fin);
    link.track({ phase: "done" });
    paint();
    settle();
    // Long enough to read your own game-over card first.
    const id = m.id;
    resultsTimer = setTimeout(() => { if (m?.id === id) showResults(); }, 2200);
  }

  /** Back to the room, whether or not the game finished. */
  function leave() {
    clearTimeout(resultsTimer);
    if (!m) return;
    if (!m.done) {
      link.send("final", { match: m.id, user_id: link.me, score: m.scores.get(link.me) ?? 0, left: true });
    }
    m = null;
    root.classList.add("hidden");
    over.classList.add("hidden");
    document.body.classList.remove("online-match");
    if (link.room) link.track({ phase: "lobby" });
  }

  /** Host: close the match once everyone still in the room is done. */
  function settle() {
    if (!m || m.ended || !link.isHost) return;
    const here = new Set((link.room?.players ?? []).map((p) => p.user_id));
    if (m.order.some((uid) => here.has(uid) && !m.finals.has(uid))) return;
    m.ended = true;
    link.send("end", { match: m.id });
    link.setStatus("lobby").catch((err) => console.warn("end match:", err.message));
    paint();
  }

  function standings() {
    return m.order
      .map((uid) => ({
        uid,
        name: nameOf(uid),
        score: m.finals.get(uid)?.score ?? m.scores.get(uid) ?? 0,
        final: m.finals.get(uid) ?? null,
      }))
      .sort((a, b) => b.score - a.score);
  }

  function paint() {
    if (!m) return;
    const list = standings();
    q("[data-board]").innerHTML = `
      <div class="mt-head"><span class="pl-k">${esc(modeById(m.mode)?.name ?? m.mode)}</span></div>
      ${list.map((s) => `
        <div class="mt-row${s.uid === link.me ? " me" : ""}">
          <span>${esc(s.name)}${s.final ? (s.final.left ? " · left" : " ✓") : ""}</span>
          <span class="mt-score">${s.score}</span>
        </div>`).join("")}`;
    if (!over.classList.contains("hidden")) showResults();
  }

  function showResults() {
    if (!m) return;
    const list = standings();
    const waiting = list.filter((s) => !s.final).length;
    const top = list[0];
    const tie = list.length > 1 && list[1].score === top.score;
    q("[data-kicker]").textContent = waiting ? "results so far" : "results";
    q("[data-title]").textContent = waiting
      ? `${waiting} still playing`
      : tie ? "Draw" : top.uid === link.me ? "You win" : `${top.name} wins`;
    q("[data-sub]").textContent = waiting ? "Scores update as players finish." : "";
    q("[data-rows]").innerHTML = list.map((s, i) => `
      <div class="over-row${!waiting && i === 0 && !tie ? " win" : ""}">
        <span>${i + 1}. ${esc(s.name)}${s.uid === link.me ? " (you)" : ""}</span>
        <span>${s.final ? (s.final.left ? `${s.score} · left` : s.score) : `playing · ${s.score}`}</span>
      </div>`).join("");
    over.classList.remove("hidden");
  }

  link.on("event", (type, p) => {
    if (type === "start") { begin(p); return; }
    if (!m || p?.match !== m.id) return;
    if (type === "score") {
      m.scores.set(p.user_id, p.score);
      paint();
    } else if (type === "final") {
      m.finals.set(p.user_id, p);
      paint();
      settle();
    } else if (type === "end") {
      m.ended = true;
      paint();
    }
  });

  // Someone leaving can be the last thing the match was waiting for, and a new
  // host inherits the job of closing it.
  link.on("room", (room) => {
    if (!m) return;
    if (!room) { leave(); return; }
    paint();
    settle();
  });

  q("[data-back]").addEventListener("click", () => exit());

  return {
    start, frame, finish, leave,
    get active() { return !!m || starting; },
  };
}
