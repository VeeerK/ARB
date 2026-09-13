import { SUPABASE_URL, SUPABASE_KEY, SUPABASE_JS } from "./config.js";
import { captchaToken } from "./captcha.js";

/**
 * The one Supabase client, and who the player is.
 *
 * Everyone who plays online or lands on a leaderboard gets an account — a GUEST
 * one (Supabase anonymous sign-in) until they choose otherwise. A guest has a
 * nickname and real scores; adding an email turns that same account into a
 * permanent one, so nothing is lost by starting as a guest.
 *
 * The library is not loaded until something needs it: opening the online
 * screens, submitting a score, or coming back with a session (or an email link)
 * already in hand.
 */

const PENDING_KEY = "arb.account.pending";   // email waiting on its confirmation link
const TRANSFER_KEY = "arb.account.guest";    // ticket to move a guest's scores into the account they sign in to
const DAY_MS = 24 * 60 * 60 * 1000;

let loading = null;
let sb = null;
let guest = null;              // one anonymous sign-in at a time
let token = null;              // latest access token, for keepalive requests on unload
const listeners = new Set();

let state = {
  user: null,        // Supabase user, or null before any session
  nickname: null,
  guest: true,       // anonymous account (or none yet)
  email: null,
  recovering: false, // arrived from a password-reset link or code
  verify: null,      // { type, email }: an emailed code waiting to be typed in
  offline: false,    // the library or the server could not be reached
};

export const account = () => state;

/** Called with the new state on every change. Returns an unsubscribe. */
export function onAccount(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(patch) {
  state = { ...state, ...patch };
  for (const fn of listeners) {
    try { fn(state); } catch (err) { console.error(err); }
  }
}

export function client() {
  loading ??= import(SUPABASE_JS)
    .then(({ createClient }) => {
      sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      });
      sb.auth.onAuthStateChange((event, session) => {
        token = session?.access_token ?? null;
        if (event === "PASSWORD_RECOVERY") emit({ recovering: true });
        // Calling back into Supabase from inside this callback deadlocks its
        // auth lock, so the profile read waits a tick.
        setTimeout(() => syncUser(session?.user ?? null), 0);
      });
      emit({ offline: false });
      return sb;
    })
    .catch((err) => {
      loading = null;
      emit({ offline: true });
      throw err;
    });
  return loading;
}

async function syncUser(user) {
  if (!user) {
    emit({ user: null, nickname: null, guest: true, email: null });
    return;
  }
  const base = { user, guest: !!user.is_anonymous, email: user.email || null };
  emit(base);
  if (!user.is_anonymous) await claimGuest();
  const { data, error } = await sb.from("profiles").select("nickname").eq("id", user.id).maybeSingle();
  if (!error) emit({ nickname: data?.nickname ?? null });
}

/** Load the client at boot only when there is a session to restore or an email
 *  link to finish — otherwise a visit that never goes online stays offline. */
export function resume() {
  let stored = false;
  try { stored = Object.keys(localStorage).some((k) => /^sb-.+-auth-token$/.test(k)); } catch { /* private mode */ }
  const fromLink = /access_token|error_description|type=recovery/.test(location.hash) || /[?&]code=/.test(location.search);
  if (stored || fromLink) client().catch(() => {});
}

/** The client with a session, signing in as a guest if there is none yet. */
export async function session() {
  const c = await client();
  const { data } = await c.auth.getSession();
  if (data.session) return c;
  guest ??= captchaToken().then((token) => c.auth.signInAnonymously({ options: { captchaToken: token ?? undefined } })).then(
    ({ error }) => { guest = null; if (error) throw error; },
    (err) => { guest = null; throw err; },
  );
  await guest;
  return c;
}

/** The signed-in user's id, making a guest account if needed. */
export async function userId() {
  const c = await session();
  const { data } = await c.auth.getSession();
  return data.session?.user?.id ?? null;
}

/**
 * Call a database function. Most need a session; leaderboards do not, and
 * reading one should not create an account.
 */
export async function rpc(name, args = {}, { signIn = true } = {}) {
  const c = signIn ? await session() : await client();
  const { data, error } = await c.rpc(name, args);
  if (error) throw new Error(error.message);
  return data;
}

/** Call an Edge Function as the signed-in player. */
export async function invoke(name, body) {
  const c = await session();
  const { data, error } = await c.functions.invoke(name, { body });
  if (error) {
    let message = error.message;
    try {
      const detail = await error.context?.json?.();
      if (detail?.error) message = detail.error;
    } catch { /* not JSON */ }
    throw new Error(message);
  }
  return data;
}

/** Best-effort call while the page is closing: fetch with keepalive outlives
 *  the page, where an awaited request would be cancelled. */
export function beacon(name, args = {}) {
  if (!token) return;
  fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    keepalive: true,
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  }).catch(() => {});
}

// ---- account --------------------------------------------------------------

const here = () => location.origin + location.pathname;

const pending = () => {
  try { return localStorage.getItem(PENDING_KEY)?.toLowerCase() ?? null; } catch { return null; }
};
const setPending = (email) => {
  try {
    if (email) localStorage.setItem(PENDING_KEY, email);
    else localStorage.removeItem(PENDING_KEY);
  } catch { /* private mode */ }
};

/** An error the account screen answers with a button: `has_account` (sign in
 *  instead) or `no_account` (sign up instead). */
const coded = (message, code) => Object.assign(new Error(message), { code });

/** Whether an email has a real account; null when the server can't say. */
async function accountExists(email) {
  try { return await rpc("account_exists", { p_email: email }, { signIn: false }); } catch { return null; }
}

/**
 * A guest signing in to an existing account brings their scores along. Before
 * signing in, the guest takes a one-use ticket; once the account is signed in,
 * `claimGuest` spends it. The ticket is kept in storage so an emailed link
 * opened later in this browser still carries it.
 */
async function holdGuest(c) {
  const { data } = await c.auth.getSession();
  if (!data.session?.user?.is_anonymous) return;
  const { data: ticket, error } = await c.rpc("start_guest_transfer");
  if (error || !ticket) return;
  try { localStorage.setItem(TRANSFER_KEY, JSON.stringify({ ticket, at: Date.now() })); } catch { /* private mode */ }
}

let claiming = false;
async function claimGuest() {
  let held = null;
  try { held = JSON.parse(localStorage.getItem(TRANSFER_KEY)); } catch { /* none */ }
  if (!held?.ticket || claiming) return;
  const drop = () => { try { localStorage.removeItem(TRANSFER_KEY); } catch { /* private mode */ } };
  if (Date.now() - held.at > DAY_MS) { drop(); return; }
  claiming = true;
  try {
    const { error } = await sb.rpc("claim_guest", { p_token: held.ticket });
    if (error) console.warn("guest scores:", error.message);
    drop();
  } catch (err) {
    console.warn("guest scores:", err);   // offline: try again on the next sign-in
  } finally {
    claiming = false;
  }
}

export async function setNickname(nickname) {
  const r = await rpc("set_nickname", { p_nickname: nickname });
  emit({ nickname: r.nickname });
  return r;
}

/** Ask Supabase to move the signed-in account to `email`. With "Confirm email"
 *  on it sends the "Change email address" template (a code and a link); with it
 *  off the email sticks at once. */
async function requestEmailChange(c, email) {
  const { data: updated, error } = await c.auth.updateUser({ email }, { emailRedirectTo: here() });
  if (error) {
    if (/already/i.test(error.message)) throw coded("This email already has an account.", "has_account");
    throw error;
  }
  const confirmed = updated?.user?.email?.toLowerCase() === email.toLowerCase();
  if (confirmed) await syncUser(updated.user);
  emit({ verify: confirmed ? null : { type: "email_change", email } });
  return { confirmed };
}

/**
 * Sign up. The account is made by adding an email to a guest (made here if
 * there isn't one yet), so a guest's nickname and scores are already in it.
 * Step one of two; `needsPassword()` asks for the password afterwards.
 *
 * With "Confirm email" on in Supabase, the email only sticks once the player
 * types the emailed code or clicks the emailed link; with it off, at once.
 * @returns {Promise<{confirmed: boolean}>} true when no email step is needed
 */
export async function register(email) {
  if (await accountExists(email)) throw coded("This email already has an account.", "has_account");
  const c = await session();
  const { data } = await c.auth.getUser();
  if (data.user && !data.user.is_anonymous) throw new Error("You're already signed in.");
  setPending(email);
  return requestEmailChange(c, email);
}

/** A signed-in account moving to a new email. With "Secure email change" on,
 *  both the old and the new address get a code, and both must be confirmed. */
export async function changeEmail(email) {
  const c = await client();
  const { data } = await c.auth.getUser();
  if (!data.user || data.user.is_anonymous) throw new Error("Sign in first.");
  if (data.user.email?.toLowerCase() === email.toLowerCase()) throw new Error("That's already your email.");
  return requestEmailChange(c, email);
}

/** Sign in with an emailed code or link instead of a password ("Magic link"
 *  template). Only for existing accounts. */
export async function emailSignIn(email) {
  if (await accountExists(email) === false) throw coded("This email doesn't have an account.", "no_account");
  const c = await client();
  await holdGuest(c);
  const token = await captchaToken();
  const { error } = await c.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: here(), captchaToken: token ?? undefined },
  });
  if (error && !/signups not allowed|not found/i.test(error.message)) throw error;
  emit({ verify: { type: "email", email } });
}

/**
 * Finish whichever emailed step is waiting, with the code from the email.
 * @returns {Promise<{done: boolean}>} false when another code is still needed
 *   (secure email change: the second address has not been confirmed yet)
 */
export async function verifyCode(code) {
  const v = state.verify;
  if (!v) throw new Error("Nothing is waiting on a code.");
  const token = String(code).replace(/\s+/g, "");
  if (!/^\d{6,10}$/.test(token)) throw new Error("Enter the code from the email.");
  const c = await client();

  if (v.type === "email_change") {
    let { error } = await c.auth.verifyOtp({ email: v.email, token, type: "email_change" });
    // Under secure email change the old address gets its own code.
    const current = state.user && !state.guest ? state.email : null;
    if (error && current && current.toLowerCase() !== v.email.toLowerCase()) {
      ({ error } = await c.auth.verifyOtp({ email: current, token, type: "email_change" }));
    }
    if (error) throw error;
    const { data } = await c.auth.getUser();
    if (data.user?.email?.toLowerCase() !== v.email.toLowerCase()) return { done: false };
    emit({ verify: null });
    await syncUser(data.user);
    return { done: true };
  }

  const { data, error } = await c.auth.verifyOtp({ email: v.email, token, type: v.type });
  if (error) throw error;
  emit({ verify: null, recovering: v.type === "recovery" });
  if (data?.user) await syncUser(data.user);
  return { done: true };
}

/** Send the waiting code again. */
export async function resendCode() {
  const v = state.verify;
  if (!v) return;
  if (v.type === "recovery") return forgotPassword(v.email);
  if (v.type === "email") return emailSignIn(v.email);
  const c = await client();
  return requestEmailChange(c, v.email);
}

export const cancelCode = () => emit({ verify: null });

/** Confirmed their email, but has no password yet. */
export const needsPassword = () =>
  !!state.recovering || (!!state.email && !state.guest && pending() === state.email.toLowerCase());

export async function setPassword(password) {
  const c = await client();
  const { error } = await c.auth.updateUser({ password });
  if (error) throw error;
  setPending(null);
  emit({ recovering: false });
}

export async function signIn(email, password) {
  if (await accountExists(email) === false) throw coded("This email doesn't have an account.", "no_account");
  const c = await client();
  await holdGuest(c);
  const token = await captchaToken();
  const { error } = await c.auth.signInWithPassword({ email, password, options: { captchaToken: token ?? undefined } });
  if (error) throw error;
}

export async function signOut() {
  const c = await client();
  setPending(null);
  emit({ verify: null, recovering: false });
  const { error } = await c.auth.signOut();
  if (error) throw error;
}

export async function forgotPassword(email) {
  if (await accountExists(email) === false) throw coded("This email doesn't have an account.", "no_account");
  const c = await client();
  await holdGuest(c);
  const token = await captchaToken();
  const { error } = await c.auth.resetPasswordForEmail(email, { redirectTo: here(), captchaToken: token ?? undefined });
  if (error) throw error;
  emit({ verify: { type: "recovery", email } });
}
