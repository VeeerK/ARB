// @ts-nocheck — plain JavaScript; the shared level rules are untyped.
/**
 * submit-run: the only way a score reaches the leaderboards.
 *
 * 1. Checks who is calling (their Supabase session).
 * 2. Checks the result itself (verify.js): for levels and the daily, that the
 *    board really builds the level and the build history adds up.
 * 3. Records it through a database function only this service can call, which
 *    spends the run ticket, checks the timing, computes points and stars, and
 *    flags outliers.
 *
 * Deploy (from the repo root):
 *   node supabase/sync-shared.mjs
 *   npx supabase functions deploy submit-run --project-ref duonzrpqdtycexnevxri --no-verify-jwt
 *
 * --no-verify-jwt because the function checks the session itself (step 1),
 * which also works with Supabase's newer signing keys.
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { verifyLevel, verifyDaily, verifyScore } from "./verify.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const reply = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const admin = createClient(
  Deno.env.get("SUPABASE_URL"),
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "POST only" });

  try {
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: auth, error: authError } = await admin.auth.getUser(jwt);
    const user = auth?.user;
    if (authError || !user) return reply(401, { error: "Not signed in" });

    const body = await req.json();
    if (typeof body?.run !== "string") return reply(400, { error: "Missing run ticket" });

    let verdict;
    let call;
    if (body.kind === "level") {
      verdict = verifyLevel(body);
      call = () => admin.rpc("record_level", {
        p_user: user.id, p_run: body.run, p_level_id: body.level_id, p_seconds: body.seconds, p_flags: verdict.flags,
      });
    } else if (body.kind === "daily") {
      verdict = verifyDaily(body);
      call = () => admin.rpc("record_daily", {
        p_user: user.id, p_run: body.run, p_day: body.day, p_runs: verdict.runs, p_flags: verdict.flags,
      });
    } else if (body.kind === "score") {
      verdict = verifyScore(body);
      call = () => admin.rpc("record_score", {
        p_user: user.id, p_run: body.run, p_mode: body.mode, p_score: body.score, p_flags: verdict.flags,
      });
    } else {
      return reply(400, { error: "Unknown kind" });
    }

    if (!verdict.ok) return reply(422, { error: verdict.reason });
    const { data, error } = await call();
    if (error) return reply(422, { error: error.message });
    return reply(200, data);
  } catch (err) {
    return reply(400, { error: String(err?.message ?? err) });
  }
});
