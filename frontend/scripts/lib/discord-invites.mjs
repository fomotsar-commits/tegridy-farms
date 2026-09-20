/**
 * NO DISCORD INVITE SHIPS UNLESS DISCORD SAYS IT IS PERMANENT AND OURS
 * (Jungle Bay Island, wave seven, answer eleven, ruling 1).
 *
 * Why this exists. The footer linked discord.gg/junglebay for weeks after the invite
 * had died (Discord answers "Unknown Invite", code 10006), and the fix proposed for it
 * carried an invite that Discord says expires on 2026-10-17: the same dead link again,
 * thirty days later. A vanity or an invite can die at any time and nothing in a build
 * notices, so the venue asks Discord itself, every CI run, for every invite it ships.
 *
 * THE RULE, per invite found anywhere in shipped source:
 *   - Discord must answer 200 for GET /api/v10/invites/<code>?with_expiration=true;
 *   - `expires_at` must be null (Discord's word for a permanent invite);
 *   - the guild must be the one the owners named: VENUE_DISCORD_GUILD.
 * Anything else fails, INCLUDING an answer we could not read (a 429 that outlasts one
 * retry, a 5xx, a network error). An invite nobody could resolve does not ship.
 *
 * WHERE INVITES COME FROM. Never from a claude: the island's law is that links are
 * never seat-minted. The owner of the "memetics.finance" server creates a permanent
 * invite in Discord's own server settings and hands it to the operator directly, who
 * pastes it into SOCIAL_LINKS (src/lib/constants.ts). This file only checks.
 *
 * Pure except resolveInvite(), which takes its fetch as an argument so the tests in
 * scripts/discord-invites.test.mjs never touch the network.
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * THE VENUE'S SERVER, BY ID.
 *
 * Answer eleven wrote the rule as "the guild must be the one the owners named", and named
 * it "memetics.finance". When the owner's permanent invite arrived on 2026-09-19 the API
 * answered with the guild's real display name, "Jungle Bay" — the same server, under the
 * name it has always had. A name is a label: the owner can change it, and a stranger can
 * copy it. Gating on it would have failed this genuine invite while passing any impostor
 * server someone had named "memetics.finance".
 *
 * So the gate reads the snowflake, which is the identity and cannot be forged, and the
 * NAME is carried into the verdict line as a fact to be read rather than a thing to match.
 * This is stricter than the ruling asked for, not looser.
 */
export const VENUE_DISCORD_GUILD_ID = '910243729997168721';

/** What that server calls itself today. Reported, never matched on. */
export const VENUE_DISCORD_GUILD = 'Jungle Bay';

/** discord.gg/<code>, discord.com/invite/<code>, discordapp.com/invite/<code>. */
const INVITE_RE = /https?:\/\/(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]+)/gi;

/** Every invite code a piece of text links to, in order, without repeats. */
export function findInviteCodes(text) {
  const out = [];
  for (const m of text.matchAll(INVITE_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/**
 * Discord's answer, judged. `answer` is `{ status, body }` from resolveInvite, or
 * `{ error }` when there was no answer at all.
 */
export function judgeInvite(code, answer, expectedGuildId = VENUE_DISCORD_GUILD_ID) {
  const label = `discord.gg/${code}`;
  if (!answer || answer.error) {
    return { ok: false, line: `${label}: could not be resolved (${answer?.error ?? 'no answer'}). An invite nobody could resolve does not ship.` };
  }
  const { status, body } = answer;
  if (status === 404 || body?.code === 10006) {
    return { ok: false, line: `${label}: Discord answers "Unknown Invite". The invite is dead.` };
  }
  if (status !== 200) {
    return { ok: false, line: `${label}: Discord answered ${status}, so it could not be resolved. An invite nobody could resolve does not ship.` };
  }
  if (!body || !('expires_at' in body)) {
    return { ok: false, line: `${label}: Discord's answer carries no expires_at, so nobody can say it is permanent.` };
  }
  if (body.expires_at !== null) {
    return { ok: false, line: `${label}: expires at ${body.expires_at}. Only a permanent invite (expires_at null) ships.` };
  }
  // THE IDENTITY, NOT THE LABEL. An impostor can call a server anything; it cannot own
  // our snowflake. The name is read out afterwards so the CI log still says, in Discord's
  // own words, which server the invite opens.
  const guildId = body.guild?.id ?? null;
  const guildName = body.guild?.name ?? null;
  if (guildId !== expectedGuildId) {
    return {
      ok: false,
      line: `${label}: resolves to guild ${guildId ?? 'unknown'} ("${guildName}"), not the venue's ${expectedGuildId}.`,
    };
  }
  return { ok: true, line: `${label}: guild "${guildName}" (${guildId}), expires_at null.` };
}

/** One GET, with a single retry when Discord rate-limits us. */
export async function resolveInvite(code, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const url = `https://discord.com/api/v10/invites/${encodeURIComponent(code)}?with_expiration=true`;
  const once = async () => {
    const res = await fetchImpl(url, { headers: { 'User-Agent': 'memetics.finance CI (invite check)' } });
    let body = null;
    try { body = await res.json(); } catch { /* a non-JSON answer is judged by its status */ }
    return { status: res.status, body };
  };
  try {
    let answer = await once();
    if (answer.status === 429) {
      const wait = Math.min(10, Number(answer.body?.retry_after) || 2);
      await sleep(wait * 1000);
      answer = await once();
    }
    return answer;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

const SOURCE_EXT = /\.(?:ts|tsx|js|jsx|mjs|json|css)$/;
// `csv` because public/sample-collection.csv is downloaded by users from the upload
// wizard: a link in a file the site hands out is a link the site ships.
const PUBLIC_EXT = /\.(?:html|txt|json|webmanifest|xml|js|svg|css|csv)$/;
const API_EXT = /\.(?:js|mjs|ts)$/;
const TEST_FILE = /\.test\.[a-z]+$/;

function walk(dir, keep, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '_derived') continue;
      walk(p, keep, acc);
    } else if (keep(p)) acc.push(p);
  }
  return acc;
}

/**
 * Every file the site ships text from, tests excluded: the app source, index.html,
 * public/ (service workers and SVGs included), the serverless api/, the deploy config
 * (vercel.json redirects are links too: a /discord short link would ship an invite), the
 * edge middleware that answers unfurlers, and the build scripts that write text into dist/.
 */
export function shippedFiles(frontendRoot) {
  const src = walk(join(frontendRoot, 'src'), (p) => SOURCE_EXT.test(p) && !TEST_FILE.test(p));
  const pub = walk(join(frontendRoot, 'public'), (p) => PUBLIC_EXT.test(p));
  const api = walk(join(frontendRoot, 'api'), (p) => API_EXT.test(p) && !TEST_FILE.test(p) && !/[\\/]__tests__[\\/]/.test(p));
  // scripts/addresses.json is here because it is an INPUT to shipped text, not a
  // script: scripts/llms-txt.mjs reads it as the ledger and renders it into
  // dist/llms.txt. Scanning the writer while leaving its source unread is the
  // hole this list closes.
  const single = ['index.html', 'vercel.json', 'middleware.js', 'scripts/render-bungalow-doors.mjs', 'scripts/llms-txt.mjs', 'scripts/addresses.json']
    .map((f) => join(frontendRoot, f))
    .filter((f) => {
      try { return statSync(f).isFile(); } catch { return false; }
    });
  return [...src, ...pub, ...api, ...single];
}

/** code -> the files (relative, forward slashes) that link to it. */
export function invitesInFiles(files, root) {
  const found = new Map();
  for (const f of files) {
    for (const code of findInviteCodes(readFileSync(f, 'utf8'))) {
      const at = relative(root, f).split(sep).join('/');
      found.set(code, [...(found.get(code) ?? []), at]);
    }
  }
  return found;
}
