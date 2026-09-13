import { TURNSTILE_SITE_KEY } from "./config.js";

/**
 * Captcha tokens for sign-ins, from Cloudflare Turnstile.
 *
 * Supabase wants a fresh, one-use token with every sign-in call (guest,
 * password, password reset), so one is fetched per call rather than kept. The
 * widget is invisible for almost everyone; only a visitor Turnstile is unsure
 * about sees a checkbox, in a small card at the bottom of the screen.
 *
 * The script loads on first use, like the Supabase client. Cloudflare sends it
 * with `Cross-Origin-Resource-Policy: cross-origin`, which the page's COEP
 * header requires.
 */

const SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const TIMEOUT_MS = 60000;

let loading = null;

function load() {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SRC;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Captcha failed to load")));
    script.onerror = () => { loading = null; reject(new Error("Captcha failed to load")); };
    document.head.appendChild(script);
  });
  return loading;
}

function card() {
  let el = document.getElementById("captcha");
  if (!el) {
    el = document.createElement("div");
    el.id = "captcha";
    el.innerHTML = `<span class="ol-note">Quick check that you're a person</span><div data-slot></div>`;
    document.body.appendChild(el);
  }
  return el;
}

/** A one-use token, or null when no site key is configured. */
export async function captchaToken() {
  if (!TURNSTILE_SITE_KEY) return null;
  const turnstile = await load();
  const el = card();
  const slot = document.createElement("div");
  el.querySelector("[data-slot]").appendChild(slot);

  return new Promise((resolve, reject) => {
    let id = null;
    const timer = setTimeout(() => done(new Error("Captcha timed out. Try again.")), TIMEOUT_MS);
    function done(err, token) {
      clearTimeout(timer);
      el.classList.remove("ask");
      try { if (id != null) turnstile.remove(id); } catch { /* already gone */ }
      slot.remove();
      if (err) reject(err); else resolve(token);
    }
    id = turnstile.render(slot, {
      sitekey: TURNSTILE_SITE_KEY,
      appearance: "interaction-only",
      callback: (token) => done(null, token),
      "error-callback": () => { done(new Error("Captcha check failed. Try again.")); return true; },
      "expired-callback": () => done(new Error("Captcha expired. Try again.")),
      "timeout-callback": () => done(new Error("Captcha timed out. Try again.")),
      "before-interactive-callback": () => el.classList.add("ask"),
      "after-interactive-callback": () => el.classList.remove("ask"),
    });
  });
}
