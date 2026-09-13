import * as acct from "./client.js";

/**
 * The account panel, shown in Settings › Account: sign up or sign in, the
 * emailed code, choosing a password and, once signed in, the profile.
 *
 * Presentation and input only; the account itself lives in client.js.
 *
 *   beforeSignOut()  runs first when signing out (leaves an online room)
 */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const PERSON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0Z" /></svg>`;
const WHY = { email_change: "to confirm it's yours", recovery: "to reset your password", email: "to sign you in" };

export function mountAccount(el, { beforeSignOut = async () => {} } = {}) {
  const ui = {
    tab: "signup",     // which form a signed-out player sees
    email: "",         // typed so far, kept across repaints and tab switches
    offer: null,       // { text, to }: "this email already has an account" and the like
    editEmail: false,  // the change-email row is open
    flash: null,       // { text, tone } shown once, by the next paint
  };

  const visible = () => !el.closest(".hidden");

  function paint() {
    const a = acct.account();
    el.innerHTML = `<div class="acct">${identity(a)}<div class="acct-main">${main(a)}</div></div>`;
    if (ui.flash) say(ui.flash.text, ui.flash.tone);
    ui.flash = null;
    el.querySelector("[data-autofocus]")?.focus({ preventScroll: true });
  }

  function say(text, tone = "") {
    const msg = el.querySelector("[data-msg]");
    if (!msg) return;
    msg.textContent = text;
    msg.className = `acct-msg ${tone}`;
  }

  /** Repaint, then show `text` under the form that is up. */
  function after(text = "", tone = "ok") {
    ui.flash = text ? { text, tone } : null;
    paint();
  }

  // ---- pieces ----

  function identity(a) {
    const signedIn = !!a.user && !a.guest;
    const name = a.user ? a.nickname ?? "Guest" : "Not signed in";
    const sub = signedIn ? esc(a.email ?? "")
      : a.user ? "Playing as a guest. Your scores are saved, but only accounts are ranked."
      : "You can play as a guest any time. Sign up to keep your scores.";
    const badge = a.offline ? "offline" : signedIn ? "account" : a.user ? "guest" : "";
    return `
      <aside class="acct-id">
        <span class="acct-avatar${a.user ? "" : " empty"}">${a.user ? esc(name[0].toUpperCase()) : PERSON}</span>
        <div class="acct-who">
          <span class="acct-name">${esc(name)}</span>
          <span class="acct-sub">${sub}</span>
          ${badge ? `<span class="acct-badge${signedIn ? " fill" : ""}">${badge}</span>` : ""}
        </div>
        ${signedIn ? "" : `
        <ul class="acct-perks">
          <li>Ranked on every leaderboard</li>
          <li>Your nickname, kept for you</li>
          <li>Sign in on any device</li>
        </ul>`}
      </aside>`;
  }

  function main(a) {
    if (a.verify) return codeForm(a.verify);
    if (acct.needsPassword()) return passwordForm(a);
    if (a.user && !a.guest) return profile(a);
    return authForm(a);
  }

  function authForm(a) {
    const up = ui.tab === "signup";
    const lead = up
      ? (a.user ? "Your guest nickname and scores come with you." : "Get ranked on the leaderboards and keep your progress.")
      : (a.user ? "Your guest scores move into your account." : "Sign in to pick up where you left off.");
    const offer = ui.offer ? `
        <div class="acct-offer" role="alert">
          <span>${esc(ui.offer.text)}</span>
          <button type="button" data-auth-tab="${ui.offer.to}">${ui.offer.to === "signin" ? "Sign in instead" : "Sign up instead"} &rarr;</button>
        </div>` : "";
    return `
      <form class="acct-form" data-act="${up ? "register" : "signin"}" data-auth>
        <div class="acct-switch" role="tablist">
          <button type="button" role="tab" aria-selected="${up}" class="${up ? "on" : ""}" data-auth-tab="signup">Sign up</button>
          <button type="button" role="tab" aria-selected="${!up}" class="${up ? "" : "on"}" data-auth-tab="signin">Sign in</button>
        </div>
        <div class="acct-heading">
          <h2 class="acct-h">${up ? "Create your account" : "Welcome back"}</h2>
          <p class="acct-p">${lead}</p>
        </div>
        <label class="acct-field">
          <span class="acct-label">Email</span>
          <input class="acct-input" type="email" name="email" value="${esc(ui.email)}" autocomplete="email" placeholder="you@example.com" required>
        </label>
        ${up ? "" : `
        <label class="acct-field">
          <span class="acct-label">Password</span>
          <input class="acct-input" type="password" name="password" autocomplete="current-password" required>
        </label>`}
        ${offer}
        <button class="acct-primary">${up ? "Continue" : "Sign in"}</button>
        ${up ? `
        <p class="acct-fine">We'll email you a code to confirm it's you. Then you pick a password.</p>` : `
        <div class="acct-links"><button type="button" class="acct-link" data-forgot>Forgot password?</button></div>
        <div class="acct-or">or</div>
        <button type="button" class="acct-secondary" data-email-code>Email me a sign-in code</button>`}
        <p class="acct-msg" data-msg></p>
      </form>`;
  }

  const codeForm = (v) => `
      <form class="acct-form" data-act="code">
        <div class="acct-heading">
          <h2 class="acct-h">Check your email</h2>
          <p class="acct-p">We sent a code to <strong>${esc(v.email)}</strong> ${WHY[v.type]}. Type it below, or use the link in the email.</p>
        </div>
        <label class="acct-field">
          <span class="acct-label">Code</span>
          <input class="acct-input acct-code" name="code" inputmode="numeric" maxlength="10" autocomplete="one-time-code" spellcheck="false" required data-autofocus>
        </label>
        <button class="acct-primary">Confirm</button>
        <div class="acct-links">
          <button type="button" class="acct-link" data-code-cancel>&larr; Back</button>
          <button type="button" class="acct-link" data-code-resend>Send a new code</button>
        </div>
        <p class="acct-msg" data-msg></p>
        <p class="acct-fine">Nothing there? Check your spam folder.</p>
      </form>`;

  const passwordForm = (a) => `
      <form class="acct-form" data-act="password">
        <div class="acct-heading">
          <h2 class="acct-h">${a.recovering ? "Choose a new password" : "Pick a password"}</h2>
          <p class="acct-p">${a.recovering ? "You're signed in. Set a new password to finish." : "Your email is confirmed. Add a password so you can sign in on any device."}</p>
        </div>
        <label class="acct-field">
          <span class="acct-label">Password</span>
          <input class="acct-input" type="password" name="password" minlength="8" autocomplete="new-password" placeholder="At least 8 characters" required data-autofocus>
        </label>
        <button class="acct-primary">Save password</button>
        <p class="acct-msg" data-msg></p>
      </form>`;

  const profile = (a) => `
      <div class="acct-profile">
        <h2 class="acct-h">Your account</h2>
        <div class="acct-list">
          <form class="acct-row" data-act="nick">
            <span class="acct-label">Nickname</span>
            <input class="acct-input" name="nick" maxlength="16" value="${esc(a.nickname ?? "")}" autocomplete="nickname" spellcheck="false" required>
            <button class="acct-small">Save</button>
          </form>
          ${ui.editEmail ? `
          <form class="acct-row" data-act="change-email">
            <span class="acct-label">New email</span>
            <input class="acct-input" type="email" name="email" autocomplete="email" placeholder="new@example.com" required data-autofocus>
            <span class="acct-row-btns">
              <button type="button" class="acct-small" data-edit-email="0">Cancel</button>
              <button class="acct-small solid">Send code</button>
            </span>
          </form>` : `
          <div class="acct-row">
            <span class="acct-label">Email</span>
            <span class="acct-row-v">${esc(a.email ?? "")}</span>
            <button type="button" class="acct-small" data-edit-email="1">Change</button>
          </div>`}
          <div class="acct-row">
            <span class="acct-label">Password</span>
            <span class="acct-row-v acct-dots">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</span>
            <button type="button" class="acct-small" data-reset-password>Reset</button>
          </div>
        </div>
        <p class="acct-msg" data-msg></p>
        <button type="button" class="acct-signout" data-signout>Sign out</button>
      </div>`;

  /** Signing up with an email that has an account, or signing in with one that
   *  doesn't: say so, with a button to the other form. */
  function offerSwitch(err) {
    if (err?.code !== "has_account" && err?.code !== "no_account") return false;
    ui.offer = { text: err.message, to: err.code === "has_account" ? "signin" : "signup" };
    paint();
    return true;
  }

  // ---- input ----

  el.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = Object.fromEntries(new FormData(form));
    const act = form.dataset.act;
    const button = form.querySelector("button:not([type=button])");
    if (button) button.disabled = true;
    try {
      if (act === "register") {
        ui.offer = null;
        await acct.register(String(data.email).trim());
        after();
      } else if (act === "signin") {
        ui.offer = null;
        await acct.signIn(String(data.email).trim(), String(data.password));
        after();
      } else if (act === "code") {
        const type = acct.account().verify?.type;
        const { done } = await acct.verifyCode(String(data.code));
        if (!done) after("Code accepted. Now enter the code sent to your other email address.");
        else after(acct.needsPassword() || type === "email" ? "" : "Email confirmed.");
      } else if (act === "password") {
        await acct.setPassword(String(data.password));
        after("Password saved.");
      } else if (act === "nick") {
        const nick = String(data.nick ?? "").trim();
        if (!/^[A-Za-z0-9_]{3,16}$/.test(nick)) throw new Error("Nicknames are 3–16 letters, numbers or _.");
        await acct.setNickname(nick);
        after("Nickname saved.");
      } else if (act === "change-email") {
        const { confirmed } = await acct.changeEmail(String(data.email).trim());
        ui.editEmail = false;
        after(confirmed ? "Email changed." : "");
      }
    } catch (err) {
      if (!((act === "register" || act === "signin") && offerSwitch(err))) say(friendly(err), "err");
    } finally {
      if (button?.isConnected) button.disabled = false;
    }
  });

  el.addEventListener("input", (e) => {
    if (e.target.matches('[data-auth] [name="email"]')) ui.email = e.target.value;
  });

  el.addEventListener("click", async (e) => {
    const t = e.target;
    const tab = t.closest("[data-auth-tab]")?.dataset.authTab;
    if (tab) { ui.tab = tab; ui.offer = null; paint(); return; }
    const edit = t.closest("[data-edit-email]");
    if (edit) { ui.editEmail = edit.dataset.editEmail === "1"; paint(); return; }
    if (t.closest("[data-code-cancel]")) { acct.cancelCode(); paint(); return; }

    const btn = t.closest("[data-forgot], [data-email-code], [data-reset-password], [data-code-resend], [data-signout]");
    if (!btn) return;
    btn.disabled = true;
    try {
      if (btn.matches("[data-signout]")) {
        await beforeSignOut();
        await acct.signOut();
        Object.assign(ui, { tab: "signin", offer: null, editEmail: false });
        after();
      } else if (btn.matches("[data-code-resend]")) {
        await acct.resendCode();
        say("New code sent.", "ok");
      } else if (btn.matches("[data-reset-password]")) {
        await acct.forgotPassword(acct.account().email);
        after();
      } else {
        const email = btn.closest("form")?.querySelector('[name="email"]')?.value.trim();
        if (!email) {
          say("Type your email first.", "err");
          el.querySelector('[name="email"]')?.focus();
          return;
        }
        ui.offer = null;
        if (btn.matches("[data-forgot]")) await acct.forgotPassword(email);
        else await acct.emailSignIn(email);
        after();
      }
    } catch (err) {
      if (!offerSwitch(err)) say(friendly(err), "err");
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  });

  acct.onAccount(() => { if (visible()) paint(); });

  return {
    paint,
    /** The panel came into view: paint, and load the client to learn who is signed in. */
    open() {
      paint();
      acct.client().catch(() => {});
    },
  };
}

/** Database and auth errors, in words a player can act on. */
export function friendly(err) {
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
