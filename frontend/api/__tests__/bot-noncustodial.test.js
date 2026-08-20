// THE ONE LINE NO REVENUE ARGUMENT CROSSES.
//
// Trojan and Banana Gun cleared enormous volume on the Telegram-bot surface, and
// both were exploited through keys their servers held or derived. This venue's bot
// answers questions and hands back links; the capability to sign is absent rather
// than disabled. That is a property of the code, and a property nobody checks is a
// property that lasts until the first person in a hurry.
//
// So this file is the check, and `frontend/supabase/migrations/020_telegram_links.sql`
// names it in its own header. It scans FOUR surfaces:
//
//   bot/**                                    the service
//   frontend/api/_lib/botLink.js              its only server endpoint
//   frontend/src/components/bot/**            the browser half
//   supabase/migrations/020_telegram_links.sql  the table
//
// It lives here, in the frontend suite, on purpose. The bot has its own vitest
// project (see src/test/vitestCollection.test.ts) which a change to the API or the
// migration would not run — and those two are exactly where a "just store the key
// server-side, it's encrypted" edit would land.
//
// WHY IT MATCHES CONSTRUCTS AND NOT WORDS. Every file scanned here TALKS about
// private keys constantly: the guard that warns a user who pasted one, the panel
// copy that promises we never ask, this comment. A word-list scan over prose would
// either fail on all of it or be defanged into uselessness. So the patterns below
// look for key material in the two places it can only appear as code — a package
// that can produce a signature, and an identifier being assigned one.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API = join(HERE, '..');
const FRONTEND = join(API, '..');
const REPO = join(FRONTEND, '..');
const BOT = join(REPO, 'bot');

const BOT_LINK = join(API, '_lib', 'botLink.js');
const MIGRATION = join(FRONTEND, 'supabase', 'migrations', '020_telegram_links.sql');
const COMPONENTS = join(FRONTEND, 'src', 'components', 'bot');

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      walk(p, acc);
    } else if (/\.(js|mjs|ts|tsx)$/.test(e.name)) {
      acc.push(p);
    }
  }
  return acc;
}

const scanned = [...walk(BOT), BOT_LINK, ...walk(COMPONENTS)];

const rel = (p) => p.slice(REPO.length + 1).split('\\').join('/');

/** Comments are prose about keys. Code is not. Strip the first, scan the second. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/**
 * Packages that can turn a secret into a signature.
 *
 * A bot that imports none of these cannot sign, whatever else it does — which is a
 * stronger statement than any amount of care inside a file that imports one.
 */
const SIGNING_PACKAGES = [
  'ethers',
  'viem/accounts',
  'bip39',
  '@scure/bip39',
  '@scure/bip32',
  'hdkey',
  'ethereumjs-wallet',
  '@solana/web3.js',
  'ed25519-hd-key',
  'keythereum',
  'web3',
];

/** Constructs that produce, unlock or use a signing key. */
const KEY_CONSTRUCTS = [
  /new\s+Wallet\s*\(/,
  /Wallet\.(fromPhrase|fromEncryptedJson|createRandom)\s*\(/,
  /HDNodeWallet\./,
  /privateKeyToAccount\s*\(/,
  /mnemonicToAccount\s*\(/,
  /mnemonicToSeed(Sync)?\s*\(/,
  /generateMnemonic\s*\(/,
  /Keypair\.(fromSecretKey|fromSeed|generate)\s*\(/,
  /\.signTransaction\s*\(/,
  /\.signTypedData\s*\(/,
  /\.sendTransaction\s*\(/,
  /createECDH\s*\(/,
  /generateKeyPair(Sync)?\s*\(/,
];

/**
 * Identifiers being ASSIGNED key material — a variable, a property, a column.
 *
 * Deliberately case-sensitive and in the casings real code uses. `SECRET_SHAPES`
 * and `looksLikeMnemonic` in bot/src/secretGuard.js are the point of that file, not
 * a violation of it, and a case-insensitive pattern would flag them and teach the
 * next person to weaken this list.
 */
const KEY_ASSIGNMENTS = [
  /\bprivateKey\s*[:=]/,
  /\bprivate_key\s*[:=]/,
  /\bprivKey\s*[:=]/,
  /\bmnemonic\s*[:=]/,
  /\bseedPhrase\s*[:=]/,
  /\bseed_phrase\s*[:=]/,
  /\bsecretKey\s*[:=]/,
  /\bsecret_key\s*[:=]/,
  /\bkeystore\s*[:=]/,
  /\bencryptedKey\s*[:=]/,
];

describe('the bot cannot sign, because nothing it loads can', () => {
  it('scans a real set of files — an empty scan would pass vacuously', () => {
    expect(scanned.length).toBeGreaterThan(8);
    expect(scanned.some((p) => p.startsWith(BOT))).toBe(true);
    expect(existsSync(BOT_LINK)).toBe(true);
  });

  it('imports no package that can produce a signature', () => {
    const offenders = [];
    for (const file of scanned) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const pkg of SIGNING_PACKAGES) {
        // Import position only: naming a package in a string is not loading it.
        if (new RegExp(`from\\s+['"]${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(src)) {
          offenders.push(`${rel(file)} imports ${pkg}`);
        }
      }
    }
    expect(offenders, 'a signing library reached the bot surface').toEqual([]);
  });

  it('contains no construct that creates, unlocks or uses a key', () => {
    const offenders = [];
    for (const file of scanned) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const pattern of KEY_CONSTRUCTS) {
        if (pattern.test(src)) offenders.push(`${rel(file)} matches ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('assigns key material to no variable, property or field', () => {
    const offenders = [];
    for (const file of scanned) {
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const pattern of KEY_ASSIGNMENTS) {
        if (pattern.test(src)) offenders.push(`${rel(file)} matches ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('takes no npm dependency at all, so no postinstall can reach the bot secret', () => {
    // The transport is ~120 lines of fetch against a documented HTTP API instead
    // of grammY precisely so this assertion can exist. See bot/src/telegram.js.
    const pkg = JSON.parse(readFileSync(join(BOT, 'package.json'), 'utf8'));
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.devDependencies ?? {}).toEqual({});
  });
});

describe('the table has nowhere to put a key', () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  // `--` comments in this migration explain at length why the columns are absent.
  const ddl = sql.replace(/--[^\n]*/g, ' ');

  it('declares no key-shaped column', () => {
    for (const pattern of KEY_ASSIGNMENTS) {
      expect(ddl, `020_telegram_links.sql matches ${pattern}`).not.toMatch(pattern);
    }
    for (const word of ['private_key', 'mnemonic', 'seed', 'keystore', 'encrypted']) {
      expect(ddl.toLowerCase(), `column-ish "${word}" appeared in the DDL`).not.toContain(word);
    }
  });

  it('stores the Telegram id only as a digest, and constrains it to one', () => {
    expect(ddl).toMatch(/chat_ref\s+text\s+NOT NULL UNIQUE CHECK \(chat_ref ~ '\^\[0-9a-f\]\{64\}\$'\)/);
    // No column for the raw id anywhere. A dump is wallets beside opaque digests.
    expect(ddl).not.toMatch(/telegram_(user_)?id/i);
  });

  it('ends with the PostgREST schema reload, or the table exists and still 404s', () => {
    expect(sql.trimEnd().endsWith("NOTIFY pgrst, 'reload schema';")).toBe(true);
  });

  it('grants authenticated SELECT and DELETE only — no minting, no re-homing', () => {
    expect(ddl).toMatch(/GRANT SELECT, DELETE ON telegram_links TO authenticated/);
    expect(ddl).not.toMatch(/GRANT[^;]*INSERT[^;]*ON telegram_links/i);
    expect(ddl).not.toMatch(/GRANT[^;]*UPDATE[^;]*ON telegram_links/i);
    expect(ddl).toMatch(/REVOKE ALL ON telegram_links FROM anon/);
  });

  it('enables RLS, without which every policy above it is inert', () => {
    expect(ddl).toMatch(/ALTER TABLE telegram_links ENABLE ROW LEVEL SECURITY/);
  });
});

describe('the endpoint is reachable, and reachable only the way it claims', () => {
  const aggregator = readFileSync(join(API, 'aggregator.js'), 'utf8');
  const src = readFileSync(BOT_LINK, 'utf8');

  it('is dispatched from the catchall behind a lazy import', () => {
    // Vercel Hobby caps the deployment at 12 functions and the repo is at 11.
    // A new api/*.js file here would be the twelfth and last.
    expect(aggregator).toContain('req.query.resource === "bot-link"');
    expect(aggregator).toContain('await import("./_lib/botLink.js")');
  });

  it('sits ABOVE the provider dispatch, or the branch never runs', () => {
    const branch = aggregator.indexOf('req.query.resource === "bot-link"');
    const provider = aggregator.indexOf('const provider = req.query.provider');
    expect(branch).toBeGreaterThan(-1);
    expect(provider).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(provider);
  });

  it('adds no serverless function', () => {
    const fns = readdirSync(API, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.js') && !e.name.startsWith('_'))
      .map((e) => e.name);
    expect(fns).not.toContain('botLink.js');
    expect(fns).not.toContain('bot.js');
    expect(fns).not.toContain('telegram.js');
  });

  it('never selects the chat digest back out to any caller', () => {
    // The owner can do nothing with it, and a response carrying it would put the
    // one value that identifies a Telegram account into browser memory and every
    // intermediate log. Every `select=` in this file is checked, not just the ones
    // somebody remembered.
    const selects = [...src.matchAll(/select=([a-z_,.*]+)/g)].map((m) => m[1]);
    expect(selects.length).toBeGreaterThan(2);
    for (const s of selects) {
      expect(s, `a select returns chat_ref: ${s}`).not.toContain('chat_ref');
      expect(s, `a select is unbounded: ${s}`).not.toContain('*');
    }
  });

  it('pins every bot-credentialed read to exactly one chat', () => {
    // The bot's credential is one secret held by one process. If a read under it
    // were unfiltered, that one secret would be a downloadable map of every
    // linked wallet — the shape referrals.js and airdrop.js both refuse.
    for (const path of [...src.matchAll(/path:\s*`\$\{TABLE\}\?select=[^`]*`/g)].map((m) => m[0])) {
      expect(path).toMatch(/(chat_ref=eq\.|wallet=eq\.|wallet=not\.is\.null)/);
    }
  });

  it('claims a code only when it is unspent AND unexpired AND unowned', () => {
    // Drop any one of the three and an old code re-homes a live binding onto a
    // different wallet.
    expect(src).toContain('link_code=eq.');
    expect(src).toContain('code_expires_at=gt.');
    expect(src).toContain('wallet=is.null');
  });

  it('spends the code on claim, so it cannot be claimed twice', () => {
    expect(src).toMatch(/link_code:\s*null/);
    expect(src).toMatch(/code_expires_at:\s*null/);
  });

  it('has no bot-credentialed action that attaches a wallet', () => {
    // The whole architecture: the bot may begin, read and revoke. Binding needs a
    // signature, which only the browser can obtain.
    const botActions = [...src.matchAll(/body\.action === "([a-z-]+)"/g)].map((m) => m[1]);
    expect(new Set(botActions)).toEqual(new Set(['begin', 'status', 'revoke', 'claim']));
    const botBlock = src.slice(src.indexOf('if (isBotCall) {'), src.indexOf('const jwt = parseCookie'));
    expect(botBlock).toContain('botBegin');
    expect(botBlock).toContain('botStatus');
    expect(botBlock).toContain('botRevoke');
    expect(botBlock, 'the bot credential can reach the claim path').not.toContain('claimCode');
  });
});

describe('the bot and the API agree on the signature, or every call 401s', () => {
  it('produces a signature the API verifies, over the same canonical material', async () => {
    // Imported from BOTH sides rather than re-derived here: a drift between the
    // two would otherwise show up only as a production outage.
    const { verifyBotSignature, botSigningString, canonicalBotBody } = await import('../_lib/botLink.js');
    const {
      signBotRequest,
      botSigningString: botSide,
      canonicalBotBody: botCanonical,
    } = await import('../../../bot/src/venueClient.js');

    const secret = 'shared-secret';
    const action = { action: 'status', chatRef: 'a'.repeat(64) };
    const now = 1_700_000_000_000;
    const timestamp = String(Math.floor(now / 1000));

    expect(botCanonical(action)).toBe(canonicalBotBody(action));
    expect(botSide(timestamp, botCanonical(action))).toBe(botSigningString(timestamp, canonicalBotBody(action)));

    // The API verifies against what it rebuilds from the PARSED body, which is the
    // whole point: a round trip through JSON.parse must not break the signature.
    const wire = botCanonical(action);
    const signature = signBotRequest(secret, timestamp, wire);
    expect(
      verifyBotSignature({ secret, timestamp, signature, rawBody: canonicalBotBody(JSON.parse(wire)), now }),
    ).toEqual({ ok: true });
  });

  it('signs the fields the handler acts on, so extra fields cannot ride along unsigned', async () => {
    const { verifyBotSignature, canonicalBotBody } = await import('../_lib/botLink.js');
    const { signBotRequest } = await import('../../../bot/src/venueClient.js');
    const secret = 'shared-secret';
    const timestamp = '1700000000';
    const honest = { action: 'status', chatRef: 'a'.repeat(64) };
    const signature = signBotRequest(secret, timestamp, canonicalBotBody(honest));
    // A body with a smuggled extra key still verifies — safe ONLY because nothing
    // outside {action, chatRef} is read on the BOT path. If a third field is ever
    // read there, it must join canonicalBotBody in the same edit or it arrives
    // unsigned. (`code` and `id` are read on the browser path, which is
    // authenticated by the SIWE cookie, not by this signature.)
    const src = readFileSync(BOT_LINK, 'utf8');
    const botBlock = src.slice(src.indexOf('if (isBotCall) {'), src.indexOf('const jwt = parseCookie'));
    const readFields = new Set([...botBlock.matchAll(/\bbody\.([a-zA-Z]+)/g)].map((m) => m[1]));
    expect(readFields, 'a bot-request field is read but not signed').toEqual(new Set(['action', 'chatRef']));
    expect(
      verifyBotSignature({ secret, timestamp, signature, rawBody: canonicalBotBody(honest), now: 1_700_000_000_000 }).ok,
    ).toBe(true);
  });

  it('rejects a replayed signature once the window has passed', async () => {
    const { verifyBotSignature } = await import('../_lib/botLink.js');
    const { signBotRequest } = await import('../../../bot/src/venueClient.js');
    const secret = 'shared-secret';
    const rawBody = '{}';
    const timestamp = '1700000000';
    const signature = signBotRequest(secret, timestamp, rawBody);
    // The timestamp is INSIDE the signed material for exactly this reason: a
    // signature over the body alone is a standing credential for an endpoint that
    // mints link codes.
    expect(verifyBotSignature({ secret, timestamp, signature, rawBody, now: 1_700_000_600_000 })).toEqual({
      ok: false,
      code: 'stale',
    });
  });

  it('rejects a body altered after signing', async () => {
    const { verifyBotSignature } = await import('../_lib/botLink.js');
    const { signBotRequest } = await import('../../../bot/src/venueClient.js');
    const secret = 'shared-secret';
    const timestamp = '1700000000';
    const signature = signBotRequest(secret, timestamp, '{"action":"status"}');
    expect(
      verifyBotSignature({
        secret,
        timestamp,
        signature,
        rawBody: '{"action":"revoke"}',
        now: 1_700_000_000_000,
      }).ok,
    ).toBe(false);
  });

  it('distinguishes an unconfigured deployment from a bad signature', async () => {
    const { verifyBotSignature } = await import('../_lib/botLink.js');
    // One means the operator has not set BOT_LINK_SECRET and the bot must stop
    // retrying; the other is a compromise indicator. Collapsing them loses both.
    expect(verifyBotSignature({ secret: null, timestamp: '1', signature: 'ab', rawBody: '' })).toEqual({
      ok: false,
      code: 'not-configured',
    });
    expect(
      verifyBotSignature({ secret: 's', timestamp: '1700000000', signature: 'zz', rawBody: '', now: 1_700_000_000_000 })
        .code,
    ).toBe('bad-signature');
  });
});

describe('the browser half is mounted, so none of this is ghost code', () => {
  it('the panel reaches a page through the alerts surface', () => {
    // A fully-built, fully-tested surface that nothing mounts is this repo's
    // recurring defect (see hooksAreMounted.test.ts and the TriggerOrderTab note
    // in docs/BATTLE_PLAN.md). Two hops, both checked.
    const panelImporters = readFileSync(
      join(FRONTEND, 'src', 'components', 'notifications', 'AlertsPanel.tsx'),
      'utf8',
    );
    expect(panelImporters).toContain('TelegramLinkPanel');
    const page = readFileSync(join(FRONTEND, 'src', 'pages', 'AlertsPage.tsx'), 'utf8');
    expect(page).toContain('AlertsPanel');
  });

  it('the panel reads the query key the bot puts in its link', () => {
    const panel = readFileSync(join(COMPONENTS, 'TelegramLinkPanel.tsx'), 'utf8');
    expect(panel).toContain(".get('tglink')");
    const deepLink = readFileSync(join(BOT, 'src', 'deepLink.js'), 'utf8');
    expect(deepLink).toContain('"/alerts": ["tglink"]');
  });
});
