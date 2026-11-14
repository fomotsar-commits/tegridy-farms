// Writes dist/pools/index.html, after `vite build`: the stock shell with the pools page's own
// first frame in place of the venue's. Vercel serves that file at /pools before the SPA rewrite,
// so the page's heading is painted before the app's script lands (law 2, as a door's is).
// FAIL-LOUD: every transform matches exactly once or the build dies. Plain JS (no TS loader
// here); src/components/PoolsFrame.test.tsx pins the frame to the page and to React's fallback.
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageHashes, pinnedHashes } from './lib/csp-hashes.mjs';

const DIST = resolve(process.cwd(), 'dist');

/** PoolsPage's own heading, word for word. */
export const POOLS_HEADING = 'Liquidity pools.';
/** LpDoorFrame's line while the door waits for its pool. */
export const DOOR_WAITING = 'Reading this pool from the chain…';
/** The door is drawn only while LP_WRITES (lib/launcher/solana/lpWriteFlag.ts) is not 'off'. */
export const LP_DOOR = true;

// The frame's own rules, inline: the app's stylesheets load after #root (vite.config.ts,
// first-frame-stylesheets), so nothing of theirs has arrived when this is painted. Each value
// is the one PoolsPage's classes compute to; PoolsFrame.test.tsx names the class for each.
// Above the page in the app and not here: the bar (56px and its 1px edge, plus the top inset),
// Bayla's line (65px, BaylaLine.tsx) and the host's pt-14. Where her line stands down, and
// where task=add draws the door, theme-init.js says so before the paint (data-pools-frame).
export const FRAME_CSS =
  // The body's own text rules ride here (index.css lands later): "tnum" alone moves the door's line.
  '.pools-frame{padding-top:calc(57px + 65px + 3.5rem + env(safe-area-inset-top,0px));-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;font-feature-settings:"tnum" 1}' +
  'html[data-pools-frame] .pools-frame{padding-top:calc(57px + 3.5rem + env(safe-area-inset-top,0px))}' +
  '.pf-root{position:relative;min-height:100vh}' +
  '.pf-bg{position:fixed;inset:0;z-index:0;background:#060c1a}' +
  '.pf-col{position:relative;z-index:10;box-sizing:border-box;max-width:900px;margin:0 auto;padding:2rem 1rem 4rem}' +
  '.pf-hero{margin:0 0 1.5rem}' +
  ".pf-h1{margin:0 0 .75rem;color:#fff;font-family:'Archivo','Helvetica Neue',Arial,sans-serif;font-weight:900;font-size:1.875rem;line-height:1.2;letter-spacing:.01em;text-shadow:0 2px 8px rgba(0,0,0,1),0 0 16px rgba(0,0,0,0.7)}" +
  '.pf-door{display:none;position:relative;box-sizing:border-box;overflow:hidden;isolation:isolate;margin:0 0 1.5rem;padding:1.25rem;border:1px solid rgba(255,255,255,0.12);border-radius:1rem;background:rgba(6,12,26,0.6)}' +
  'html[data-pools-frame="door"] .pf-door{display:block}' +
  ".pf-door p{margin:0;color:rgba(255,255,255,0.7);font-family:'Inter',system-ui,sans-serif;font-weight:400;font-size:13px;line-height:1.5;text-shadow:0 1px 4px rgba(0,0,0,0.9),0 0 12px rgba(0,0,0,0.6)}" +
  '@media (min-width:768px){.pf-col{padding-left:1.5rem;padding-right:1.5rem}.pf-h1{font-size:3rem;line-height:1}}';

/** The LP door's waiting card, hidden unless the address asks for an add. */
const doorCard = () =>
  `<section class="pf-door" aria-label="Add liquidity"><p role="status">${DOOR_WAITING}</p></section>`;

/** The pools page's first frame, between the markers the shell's own frame sits in. */
export function poolsFrame() {
  return (
    '<!-- first-frame --><div id="first-frame"><div class="pools-frame"><div class="pf-root">' +
    '<div class="pf-bg"></div>' +
    `<div class="pf-col">${LP_DOOR ? doorCard() : ''}` +
    `<div class="pf-hero"><h1 class="pf-h1" elementtiming="first-frame-h1">${POOLS_HEADING}</h1></div>` +
    '</div></div></div></div><!-- /first-frame -->'
  );
}

/** What a crawler reads: one frame, its one h1 the page's heading, no heading naming the venue. */
function checkPage(out) {
  const fail = (why) => {
    throw new Error(`[pools-frame] ${why}`);
  };
  const frames = out.match(/<!-- first-frame -->[\s\S]*?<!-- \/first-frame -->/g) ?? [];
  if (frames.length !== 1) fail(`expected one first-frame block, got ${frames.length}.`);
  const h1s = out.match(/<h1[\s>][\s\S]*?<\/h1>/g) ?? [];
  if (h1s.length !== 1 || !h1s[0].endsWith(`>${POOLS_HEADING}</h1>`) || !frames[0].includes(h1s[0])) {
    fail("the page's one h1 is not the frame's heading.");
  }
  if (/<h[1-6][\s>](?:(?!<\/h[1-6]>)[\s\S])*MEMETICS\.FINANCE/i.test(out)) fail('a heading names MEMETICS.FINANCE.');
}

export function transform(html) {
  let out = html;
  const swap = (label, pattern, replacement) => {
    const count = (out.match(new RegExp(pattern.source, 'g')) ?? []).length;
    if (count !== 1) {
      throw new Error(
        `[pools-frame] expected exactly one match for ${label}, got ${count}. index.html changed shape; update this script deliberately.`,
      );
    }
    // A function replacer: a `$&` in a field is text, never a pattern.
    out = out.replace(pattern, typeof replacement === 'function' ? replacement : () => replacement);
  };
  // The venue's frame out, the page's in. The attribute means "a static frame is on screen":
  // index.html's CSS shows it, theme-init keeps it, and the first route skips its fade-in.
  swap('first frame', /<!-- first-frame -->[\s\S]*?<!-- \/first-frame -->/, poolsFrame());
  swap('<html>', /<html lang="en">/, '<html lang="en" data-first-frame="venue">');
  swap('frame styles', /<\/style>/, `${FRAME_CSS}</style>`);
  // The no-script heading becomes a paragraph, so the page's own is the only h1.
  swap('no-script heading', /(<noscript>(?:(?!<\/noscript>)[\s\S])*?)<h1 style="([^"]*)">([^<]*)<\/h1>/,
    (_all, before, style, text) => `${before}<p style="${style};font-weight:700">${text}</p>`);
  checkPage(out);
  return out;
}

// Run only when launched, not when a test imports this. Compare real paths: a mismatch
// must never skip the page silently (as scripts/render-bungalow-doors.mjs).
const cliPath = (p) => { const r = realpathSync(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
const self = fileURLToPath(import.meta.url);
const launched = process.argv[1] && basename(process.argv[1]) === basename(self);
if (launched && cliPath(resolve(process.argv[1])) !== cliPath(self)) {
  throw new Error(`[pools-frame] launched as ${process.argv[1]} but this file is ${self}: refusing to skip the page.`);
}
if (launched) {
  const shellPath = resolve(DIST, 'index.html');
  if (!existsSync(shellPath)) throw new Error('[pools-frame] dist/index.html not found: run after `vite build`.');
  const page = transform(readFileSync(shellPath, 'utf8'));
  // The page carries the shell's inline scripts and no other: each must already be pinned.
  const pinned = new Set(pinnedHashes(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8')));
  for (const hash of pageHashes(page)) {
    if (!pinned.has(hash)) throw new Error(`[pools-frame] vercel.json's CSP does not pin the page's inline script ${hash}.`);
  }
  mkdirSync(resolve(DIST, 'pools'), { recursive: true });
  writeFileSync(resolve(DIST, 'pools', 'index.html'), page);
  console.log('[pools-frame] wrote dist/pools/index.html');
}
