import { rpc, invoke } from "./client.js";

/**
 * The database functions, one wrapper each, named for what they do. Argument
 * names match supabase/schema.sql and supabase/002_anticheat.sql.
 *
 * Scores are never written straight to the database. A run asks for a ticket
 * when it starts (the server notes the time), and its result goes to the
 * submit-run Edge Function, which re-checks the proof and then records it. The
 * server works out points and stars itself.
 */

const LIMIT = 50;

// ---- scores -----------------------------------------------------------------

/**
 * A ticket for one run: mode is "level", "daily" or a game mode id.
 * @returns {Promise<{run: string|null, ranked: boolean}>} ranked is false for a
 *   repeat attempt at a daily
 */
export const startRun = (mode, { levelId = null, day = null } = {}) =>
  rpc("start_run", { p_mode: mode, p_level_id: levelId, p_day: day });

/**
 *   { kind: "level", run, level_id, seconds, board, timeline }
 *   { kind: "daily", run, day, levels: [{ level_id, seconds, board, timeline }] }
 *   { kind: "score", run, mode, score }
 */
export const submitRun = (body) => invoke("submit-run", body);

export const reportPlayer = (nickname, board) =>
  rpc("report_player", { p_nickname: nickname, p_board: board, p_reason: null });

// ---- leaderboards -----------------------------------------------------------

const board = (name, args) => rpc(name, { ...args, p_limit: LIMIT }, { signIn: false });

export const ladderBoard = (difficulty = null) => board("get_ladder_board", { p_difficulty: difficulty });
export const levelBoard = (levelId) => board("get_level_board", { p_level_id: levelId });
export const dailyBoard = (day) => board("get_daily_board", { p_day: day });
export const modeBoard = (mode) => board("get_mode_board", { p_mode: mode });

// ---- rooms ------------------------------------------------------------------

export const listRooms = (modes = null) => rpc("list_public_rooms", { p_modes: modes }, { signIn: false });

export const createRoom = ({ mode, visibility, max, settings }) =>
  rpc("create_room", { p_mode: mode, p_visibility: visibility, p_max_players: max, p_settings: settings });

export const joinRoom = (code) => rpc("join_room", { p_code: code });
export const quickMatch = (modes) => rpc("quick_match", { p_modes: modes });
export const leaveRoom = () => rpc("leave_room");
export const roomHeartbeat = () => rpc("room_heartbeat");

export const updateRoom = (roomId, { mode = null, visibility = null, max = null, settings = null } = {}) =>
  rpc("update_room", {
    p_room_id: roomId, p_mode: mode, p_visibility: visibility, p_max_players: max, p_settings: settings,
  });

export const setRoomStatus = (roomId, status) => rpc("set_room_status", { p_room_id: roomId, p_status: status });
export const kickPlayer = (roomId, userId) => rpc("kick_player", { p_room_id: roomId, p_user_id: userId });
