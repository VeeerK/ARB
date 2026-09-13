/**
 * Where the online features live. The key is Supabase's publishable key: it is
 * meant to ship in browser code, and every table behind it is locked down by
 * row level security, so it grants nothing a visitor should not have.
 */
export const SUPABASE_URL = "https://duonzrpqdtycexnevxri.supabase.co";
export const SUPABASE_KEY = "sb_publishable_o8hAVZo6oBn5Zq4LQUWiQA_Gc-Bzu24";

/**
 * Cloudflare Turnstile site key (public). Supabase Attack Protection checks a
 * captcha token on every sign-in once it is switched on there, so this must be
 * set BEFORE captcha is enabled in the dashboard. Empty = no captcha.
 */
export const TURNSTILE_SITE_KEY = "0x4AAAAAAEy0pT-W5jKE3eFT";

/** Loaded on first use, so the offline app never waits on the network. jsDelivr
 *  sends `Cross-Origin-Resource-Policy: cross-origin`, which the page's COEP
 *  header requires. */
export const SUPABASE_JS = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm";
