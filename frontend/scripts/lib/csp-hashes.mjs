// The CSP in vercel.json drops 'unsafe-inline' from script-src and pins every inline
// <script> a served page carries by its sha256. The venue's page (index.html) carries one,
// its JSON-LD, and so does every door page the build writes (scripts/render-bungalow-doors.mjs),
// each with its own. So the pins are computed, never typed: scripts/csp-hash.mjs writes
// them into vercel.json from here, the door build checks dist/ against them, and
// src/lib/siteIdentity.test.ts and src/lib/bungalowDoors.test.ts assert them both ways.
//
// What the pin is worth (measured 2026-09-30, Chromium 151 and WebKit 26.5): a browser
// never runs a JSON-LD block, so it never checks one against the CSP either; an unpinned
// one stays readable and logs nothing. The pins keep "every inline script is pinned"
// true without anyone having to reason about which inline scripts execute.
import { createHash } from 'node:crypto';

// `i` because HTML tag names are case-insensitive: a <SCRIPT> block must not slip past
// unpinned (CodeQL js/bad-tag-filter).
const SCRIPT = /<script(\s[^>]*)?>([\s\S]*?)<\/script(?:\s[^>]*)?>/gi;
const HASH = /^'sha256-[A-Za-z0-9+/]+=*'$/;

/** Every inline <script> body in a page, as the browser hashes it. Vercel serves the
 *  git checkout with LF endings, whatever the working copy has.
 *  @param {string} html
 *  @returns {string[]} */
export function inlineScriptBodies(html) {
  const bodies = [];
  for (const m of html.replace(/\r\n/g, '\n').matchAll(SCRIPT)) {
    if (/\bsrc\s*=/.test((m[1] ?? '').trim())) continue; // external: no body to pin
    bodies.push(m[2]);
  }
  return bodies;
}

/** The CSP source that pins one inline script body: 'sha256-…'.
 *  @param {string} body
 *  @returns {string} */
export const cspHash = (body) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;

/** The CSP sources that pin every inline script a page carries.
 *  @param {string} html
 *  @returns {string[]} */
export const pageHashes = (html) => inlineScriptBodies(html).map(cspHash);

/** The one Content-Security-Policy value in vercel.json.
 *  @param {string} vercelJson
 *  @returns {string} */
function cspValue(vercelJson) {
  const values = JSON.parse(vercelJson).headers
    .flatMap((rule) => rule.headers)
    .filter((h) => h.key.toLowerCase() === 'content-security-policy')
    .map((h) => h.value);
  if (values.length !== 1) throw new Error(`[csp] expected one Content-Security-Policy in vercel.json, got ${values.length}.`);
  return values[0];
}

/** The script-src directive's sources, in order.
 *  @param {string} csp
 *  @returns {string[]} */
const scriptSrc = (csp) => {
  const directives = csp.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0] === 'script-src');
  if (directives.length !== 1) throw new Error(`[csp] expected one script-src directive, got ${directives.length}.`);
  return directives[0].slice(1);
};

/** The sha256 sources vercel.json's script-src pins, in order.
 *  @param {string} vercelJson
 *  @returns {string[]} */
export const pinnedHashes = (vercelJson) => scriptSrc(cspValue(vercelJson)).filter((s) => HASH.test(s));

/** vercel.json with script-src pinning exactly `hashes`, in the order given and once each,
 *  right after 'self'. Every other source, and every other byte of the file, is kept.
 *  @param {string} vercelJson
 *  @param {string[]} hashes
 *  @returns {string} */
export function pinHashes(vercelJson, hashes) {
  const wanted = [...new Set(hashes)];
  for (const h of wanted) if (!HASH.test(h)) throw new Error(`[csp] not a sha256 source: ${h}`);
  const csp = cspValue(vercelJson);
  const directive = csp.split(';').find((d) => d.trim().startsWith('script-src '));
  const kept = scriptSrc(csp).filter((s) => !HASH.test(s));
  const at = kept.indexOf("'self'") + 1;
  const rebuilt = `script-src ${[...kept.slice(0, at), ...wanted, ...kept.slice(at)].join(' ')}`;
  const leading = directive.match(/^\s*/)[0];
  if (vercelJson.split(directive).length !== 2) throw new Error('[csp] the script-src directive is not unique in vercel.json.');
  const out = vercelJson.replace(directive, () => `${leading}${rebuilt}`);
  const pinned = pinnedHashes(out);
  if (pinned.join(' ') !== wanted.join(' ')) throw new Error('[csp] rewriting vercel.json did not pin what was asked.');
  return out;
}
