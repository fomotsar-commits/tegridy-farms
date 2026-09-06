/**
 * Fail the build if package.json declares an npm lifecycle hook.
 *
 * WHY THIS EXISTS. frontend/.npmrc sets `ignore-scripts=true`, deliberately, so
 * that transitive dependencies cannot execute install hooks next to deploy
 * credentials. npm applies that setting to OUR OWN `pre*`/`post*` hooks too: it
 * skips them, silently, everywhere — CI, Vercel and local alike.
 *
 * On 2026-09-04 the image-derivative generator was wired as `"prebuild"`. It
 * therefore never ran on Vercel. `public/_derived` was never created, but the
 * manifest is committed, so the bundle advertised `/_derived/…` srcset
 * candidates for files that were not deployed. Vercel answers an unknown path
 * with index.html at HTTP 200 rather than 404, which an <img> cannot decode:
 * 72 of 124 images broken across 8 routes, and nothing failed anywhere to say so.
 *
 * The hook was removed. It came back within a day, in #418, when an older branch
 * was rebased over the fix and its stale package.json won. Nobody noticed,
 * because a hook that does nothing looks exactly like a hook that works. That is
 * what this guard is for: the prohibition was written in three places and
 * enforced in none.
 *
 * Put build steps in the `build` chain explicitly, where ignore-scripts has no say.
 *
 * WHAT COUNTS AS A HOOK. `preX`/`postX` only bind when `X` is another script, so
 * `precommit` with no `commit` script is inert and is NOT flagged — flagging it
 * would train people to ignore this check. npm's own lifecycle names bind
 * regardless of what else is declared, so those are always flagged.
 */
import { readFileSync } from 'node:fs';

const NPM_LIFECYCLES = new Set([
  'preinstall', 'install', 'postinstall',
  'prepublish', 'prepublishOnly', 'postpublish',
  'prepare', 'prepack', 'postpack',
  'preversion', 'version', 'postversion',
  'prerestart', 'restart', 'postrestart',
  'prestop', 'stop', 'poststop',
  'preshrinkwrap', 'shrinkwrap', 'postshrinkwrap',
]);

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const scripts = pkg.scripts ?? {};
const names = new Set(Object.keys(scripts));

const offenders = [];
for (const name of names) {
  if (NPM_LIFECYCLES.has(name)) {
    offenders.push([name, 'an npm built-in lifecycle script']);
  } else if (name.startsWith('pre') && names.has(name.slice(3))) {
    offenders.push([name, `runs automatically before "${name.slice(3)}"`]);
  } else if (name.startsWith('post') && names.has(name.slice(4))) {
    offenders.push([name, `runs automatically after "${name.slice(4)}"`]);
  }
}

if (offenders.length > 0) {
  console.error('\u2716 package.json declares npm lifecycle hook(s):\n');
  for (const [name, why] of offenders) {
    console.error(`    "${name}"  \u2014 ${why}`);
    console.error(`        ${JSON.stringify(scripts[name])}`);
  }
  console.error('\n  .npmrc sets ignore-scripts=true, so npm SKIPS these — silently, on');
  console.error('  Vercel and in CI. A "prebuild" hook this way once shipped a manifest');
  console.error('  advertising image files that were never built: 72 of 124 images broken');
  console.error('  in production, with nothing failing to report it.');
  console.error('\n  Fix: call the step explicitly from the "build" chain instead.');
  process.exit(1);
}

console.log(`\u2714 no npm lifecycle hooks in package.json (${names.size} scripts checked)`);
