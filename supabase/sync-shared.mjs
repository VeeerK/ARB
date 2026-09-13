/**
 * Copies the game's level rules into the Edge Functions, so the server checks a
 * board with exactly the code the game used. Run before every deploy of
 * submit-run, and after any change to src/levels.js:
 *
 *   node supabase/sync-shared.mjs
 */
import { copyFileSync, mkdirSync } from "node:fs";

const src = new URL("../src/levels.js", import.meta.url);
const dir = new URL("./functions/_shared/", import.meta.url);
mkdirSync(dir, { recursive: true });
copyFileSync(src, new URL("levels.js", dir));
console.log("src/levels.js -> supabase/functions/_shared/levels.js");
