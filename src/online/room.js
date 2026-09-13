import { client, userId, beacon, account } from "./client.js";
import * as api from "./api.js";

/**
 * The room you are in, kept live.
 *
 * Two sources, for two kinds of truth:
 *   the database  — who is in the room, who hosts, its game and settings. Read
 *                   back after every change and on a slow heartbeat, which is
 *                   also what keeps you in the room (miss 90 seconds of
 *                   heartbeats and the server drops you).
 *   a channel     — Supabase Realtime on "room:<id>", private to members. Fast
 *                   and lossy: presence (who is connected, camera on, in game)
 *                   and broadcasts (start, live scores, Pong's ball).
 *
 * A broadcast of "room" tells everyone to re-read the database; presence
 * changes do the same, so a join or a leave shows up everywhere within a beat.
 *
 * Events out:
 *   on("room", (room | null, reason))   reason: joined | sync | left | kicked | dropped
 *   on("presence", peers)               [{ user_id, nickname, camera, phase }]
 *   on("event", (type, payload))        every broadcast the room does not handle itself
 */

const HEARTBEAT_MS = 20000;

export function createRoomLink() {
  let room = null;
  let me = null;
  let channel = null;
  let beat = 0;
  let refreshTimer = 0;
  let peers = [];
  let presence = { camera: false, phase: "lobby" };
  const handlers = { room: new Set(), presence: new Set(), event: new Set() };

  function emit(kind, ...args) {
    for (const fn of handlers[kind]) {
      try { fn(...args); } catch (err) { console.error(err); }
    }
  }

  function on(kind, fn) {
    handlers[kind].add(fn);
    return () => handlers[kind].delete(fn);
  }

  /** Take a room read from the database as the truth. */
  async function adopt(next, reason) {
    const prev = room;
    room = next ?? null;
    if (!room) {
      await closeChannel();
      clearInterval(beat);
      peers = [];
      emit("presence", peers);
    } else if (prev?.id !== room.id) {
      await closeChannel();
      openChannel(room.id);
      clearInterval(beat);
      beat = setInterval(refresh, HEARTBEAT_MS);
    }
    emit("room", room, reason);
    return room;
  }

  async function openChannel(id) {
    const sb = await client();
    // Private channels check the realtime.messages policies against this token.
    await sb.realtime.setAuth();
    const ch = sb.channel(`room:${id}`, {
      config: { private: true, broadcast: { self: false }, presence: { key: me } },
    });
    channel = ch;
    ch.on("broadcast", { event: "*" }, ({ event, payload }) => onBroadcast(event, payload ?? {}))
      .on("presence", { event: "sync" }, () => {
        if (channel !== ch) return;
        peers = Object.values(ch.presenceState()).map((metas) => metas[metas.length - 1]);
        emit("presence", peers);
        scheduleRefresh();
      })
      .subscribe((status, err) => {
        if (channel !== ch) return;
        if (status === "SUBSCRIBED") ch.track(presencePayload());
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") console.warn("room channel:", status, err ?? "");
      });
  }

  async function closeChannel() {
    const ch = channel;
    channel = null;
    if (!ch) return;
    try {
      const sb = await client();
      await sb.removeChannel(ch);
    } catch { /* already gone */ }
  }

  function onBroadcast(event, payload) {
    if (event === "room") { scheduleRefresh(); return; }
    if (event === "kick") {
      if (payload.user_id === me) adopt(null, "kicked");
      else scheduleRefresh();
      return;
    }
    emit("event", event, payload);
  }

  const presencePayload = () => ({ user_id: me, nickname: account().nickname, ...presence });

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 350);
  }

  async function refresh() {
    if (!room) return;
    try {
      const next = await api.roomHeartbeat();
      if (!room) return;                       // left while the request was out
      await adopt(next, next ? "sync" : "dropped");
    } catch (err) {
      console.warn("room heartbeat:", err.message);
    }
  }

  /** Tell everyone else to re-read the room. */
  const announce = () => send("room", {});

  function send(event, payload = {}) {
    if (!channel) return;
    channel.send({ type: "broadcast", event, payload }).catch?.(() => {});
  }

  async function enter(promise) {
    me ??= await userId();
    return adopt(await promise, "joined");
  }

  window.addEventListener("pagehide", () => { if (room) beacon("leave_room"); });

  return {
    on,
    send,

    quick: (modes) => enter(api.quickMatch(modes)),
    create: (opts) => enter(api.createRoom(opts)),
    join: (code) => enter(api.joinRoom(code)),

    async update(patch) {
      const next = await api.updateRoom(room.id, patch);
      announce();
      return adopt(next, "sync");
    },

    async setStatus(status) {
      if (!room) return null;
      const next = await api.setRoomStatus(room.id, status);
      announce();
      return adopt(next, "sync");
    },

    async kick(userIdToKick) {
      const next = await api.kickPlayer(room.id, userIdToKick);
      send("kick", { user_id: userIdToKick });
      return adopt(next, "sync");
    },

    async leave() {
      if (!room) return;
      try { await api.leaveRoom(); } catch (err) { console.warn("leave room:", err.message); }
      await adopt(null, "left");
    },

    /** Update what this player shows everyone else: camera on, in game. */
    track(patch) {
      presence = { ...presence, ...patch };
      if (channel) channel.track(presencePayload());
    },

    refresh,
    get room() { return room; },
    get peers() { return peers; },
    get me() { return me; },
    get isHost() { return !!room && room.host_id === me; },
  };
}
