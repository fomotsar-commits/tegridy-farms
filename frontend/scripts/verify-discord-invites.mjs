#!/usr/bin/env node
/**
 * CI: every Discord invite the site ships must be permanent and the venue's own server.
 * Answer eleven, ruling 1. The rule and its reasons live in scripts/lib/discord-invites.mjs;
 * this script only finds the invites, asks Discord, and exits non-zero on any failure.
 *
 * Run in the "Lint, Type Check & Test" job of .github/workflows/ci.yml, NOT in the build:
 * a Discord outage must not stop a production deploy, but it must stop a merge that
 * would ship an invite nobody could resolve. With no invite in the source it makes no
 * network call at all and passes.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shippedFiles, invitesInFiles, resolveInvite, judgeInvite, VENUE_DISCORD_GUILD } from './lib/discord-invites.mjs';

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const found = invitesInFiles(shippedFiles(FRONTEND), FRONTEND);

if (found.size === 0) {
  console.log(`[discord-invites] No Discord invite ships. Nothing to resolve. (Expected server when one does: "${VENUE_DISCORD_GUILD}".)`);
  process.exit(0);
}

let failed = 0;
for (const [code, files] of found) {
  const verdict = judgeInvite(code, await resolveInvite(code));
  console.log(`[discord-invites] ${verdict.ok ? 'OK  ' : 'FAIL'} ${verdict.line}  (in ${files.join(', ')})`);
  if (!verdict.ok) failed += 1;
}
if (failed > 0) {
  console.error(`[discord-invites] ${failed} of ${found.size} invite(s) failed. A permanent invite comes from the server's owner, made in Discord's own settings.`);
  process.exit(1);
}
