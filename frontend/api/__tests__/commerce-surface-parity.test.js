// Drift guard for the commerce surface.
//
// FOUR THINGS CAN ROT HERE, AND EVERY ONE OF THEM IS SILENT.
//
// 1. THE FUNCTION BUDGET. Vercel Hobby caps a deployment at 12 serverless
//    functions (api/SERVERLESS_BUDGET.md). Commerce shipped as a `?resource=`
//    branch on the aggregator catchall precisely so the count would not move, and
//    the branch has to sit ABOVE the `const provider` line — a `?resource=` call
//    carries no provider, so a branch placed after it never runs and 404s.
//
// 2. THE PINNED READ. The one public invoice read runs under the SERVICE ROLE,
//    which bypasses RLS, so its filter is the entire access control for the
//    table's public face. A `select=*`, a missing `limit=1`, or a merchant-scoped
//    listing turns "what is THIS invoice" into a downloadable ledger of every
//    merchant's sales. `webhook_url` must stay out of the column list: a
//    merchant's callback endpoint published to the world is a free target list.
//
// 3. THE VERIFICATION LITERAL. Nothing on this deployment reads a transaction
//    receipt, so nothing on this deployment may write a word that means one was
//    read. `verification` is a hardcoded 'client-reported' and is never taken
//    from the request body. A merchant releasing goods against a row that says
//    "confirmed" when nothing checked the chain is the robbery the whole design
//    is arranged to prevent.
//
// 4. NON-CUSTODY. No key material of any kind may appear on this path. This is
//    the one line no revenue argument justifies crossing, so it is asserted
//    rather than reviewed.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = join(HERE, '..');
const AGGREGATOR = join(API_DIR, 'aggregator.js');
const SERVER = join(API_DIR, '_lib', 'commerce.js');
const CLIENT_INVOICE = join(HERE, '..', '..', 'src', 'lib', 'commerce', 'invoice.ts');
const MIGRATION = join(HERE, '..', '..', 'supabase', 'migrations', '021_commerce.sql');
const BUDGET = join(API_DIR, 'SERVERLESS_BUDGET.md');

const aggregatorSrc = readFileSync(AGGREGATOR, 'utf8');
const serverSrc = readFileSync(SERVER, 'utf8');
const migrationSrc = readFileSync(MIGRATION, 'utf8');

/** Vercel counts each top-level handler under `api/` — not `_lib/` or `__tests__/`. */
function countFunctions(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('_') || name === '__tests__' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...countFunctions(full));
    else if (name.endsWith('.js') && !name.endsWith('.test.js')) {
      out.push(full.slice(API_DIR.length + 1).replace(/\\/g, '/'));
    }
  }
  return out;
}

describe('the commerce store costs no serverless function', () => {
  it('there is no top-level api/commerce.js', () => {
    expect(countFunctions(API_DIR), 'commerce must live on the catchall, not as its own function').not.toContain(
      'commerce.js',
    );
  });

  it('the deployment stays at or under the Hobby cap of 12', () => {
    expect(countFunctions(API_DIR).length).toBeLessThanOrEqual(12);
  });

  it('dispatches ?resource=commerce behind a lazy import', () => {
    expect(aggregatorSrc).toMatch(/req\.query\.resource === "commerce"/);
    expect(aggregatorSrc).toMatch(/await import\("\.\/_lib\/commerce\.js"\)/);
  });

  it('places the branch ABOVE `const provider`, where it can actually run', () => {
    const branch = aggregatorSrc.indexOf('req.query.resource === "commerce"');
    const provider = aggregatorSrc.indexOf('const provider = req.query.provider');
    expect(branch).toBeGreaterThan(-1);
    expect(provider).toBeGreaterThan(-1);
    expect(branch, 'a ?resource= branch after the provider dispatch never runs').toBeLessThan(provider);
  });

  it('is documented in the budget table, which is what the next author reads', () => {
    expect(readFileSync(BUDGET, 'utf8')).toMatch(/\| `commerce` \| `_lib\/commerce\.js`/);
  });
});

describe('the one public read stays one row wide', () => {
  it('filters by exactly one id, with limit=1 and an explicit column list', () => {
    const query = serverSrc.match(/\$\{INVOICE_TABLE\}\?select=\$\{PUBLIC_INVOICE_COLUMNS\}&id=eq\.\$\{encodeURIComponent\(id\)\}&limit=1/);
    expect(query, 'the pinned public invoice read changed shape').not.toBeNull();
  });

  it('never selects * from either commerce table', () => {
    expect(serverSrc).not.toMatch(/commerce_invoices\?select=\*/);
    expect(serverSrc).not.toMatch(/SETTLEMENT_TABLE\}\?select=\*/);
  });

  it('keeps webhook_url out of the public column list', () => {
    const columns = serverSrc.match(/const PUBLIC_INVOICE_COLUMNS\s*=\s*\n?\s*"([^"]+)"/);
    expect(columns).not.toBeNull();
    expect(columns[1].split(',')).not.toContain('webhook_url');
  });

  it('exposes no endpoint that lists invoices or merchants', () => {
    // The guard is the ABSENCE. Every read of the invoice table must carry an
    // `id=eq.` filter; a merchant-scoped or unfiltered variant is a sales ledger.
    const reads = [...serverSrc.matchAll(/\$\{INVOICE_TABLE\}\?select=[^`"]*/g)].map((m) => m[0]);
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) {
      expect(read, `unfiltered invoice read: ${read}`).toMatch(/id=eq\./);
    }
  });

  it('reads settlements only for one named invoice', () => {
    const reads = [...serverSrc.matchAll(/\$\{SETTLEMENT_TABLE\}\?select=[^`"]*/g)].map((m) => m[0]);
    for (const read of reads) {
      expect(read, `unfiltered settlement read: ${read}`).toMatch(/invoice_id=eq\./);
    }
  });
});

describe('nothing that has not read a receipt may say it has', () => {
  it('writes verification as a hardcoded client-reported literal', () => {
    expect(serverSrc).toMatch(/verification:\s*"client-reported"/);
  });

  it('never takes verification from the request body', () => {
    expect(serverSrc).not.toMatch(/body[?.\s]*\.?\s*verification/);
    expect(serverSrc).not.toMatch(/verification:\s*(body|req)/);
  });

  it('has no code path that writes chain-confirmed', () => {
    // The migration's CHECK allows it so a future verifier has somewhere to
    // write. The API must not reach it until that verifier exists.
    const writes = serverSrc.split('\n').filter((l) => /chain-confirmed/.test(l) && !l.trim().startsWith('//'));
    expect(writes, 'the API claims an on-chain confirmation it never performed').toEqual([]);
  });

  it('carries the not-a-confirmation notice on every settlement answer', () => {
    expect(serverSrc).toMatch(/const SETTLE_NOTICE\s*=/);
    expect(serverSrc).toMatch(/NOT a confirmation of payment/);
    // Every settle/settlements response includes it.
    const responses = [...serverSrc.matchAll(/return res\.status\((200|201)\)\.json\(\{[^;]*?\}\);/gs)].map((m) => m[0]);
    const settlementResponses = responses.filter((r) => /verification|settlements/.test(r));
    expect(settlementResponses.length).toBeGreaterThan(0);
    for (const r of settlementResponses) {
      expect(r, `a settlement response omits SETTLE_NOTICE: ${r.slice(0, 120)}`).toMatch(/SETTLE_NOTICE/);
    }
  });

  it('the migration defaults verification to client-reported', () => {
    expect(migrationSrc).toMatch(/verification\s+text\s+NOT NULL DEFAULT 'client-reported'/);
  });
});

describe('non-custody, asserted rather than reviewed', () => {
  const FORBIDDEN = [
    /privateKey/i,
    /private_key/i,
    /\bmnemonic\b/i,
    /\bseedPhrase\b/i,
    /PRIVATE_KEY/,
    /\bsignTransaction\b/,
    /\bsendRawTransaction\b/,
    /\bWallet\.fromPhrase\b/,
    /privateKeyToAccount/,
  ];

  it('holds, derives and accepts no key material anywhere on the checkout path', () => {
    for (const pattern of FORBIDDEN) {
      expect(serverSrc, `api/_lib/commerce.js matched ${pattern} — this path must never touch a key`).not.toMatch(
        pattern,
      );
    }
  });

  it('the schema has no custody column', () => {
    for (const forbidden of ['private_key', 'mnemonic', 'balance', 'escrow', 'custody']) {
      expect(migrationSrc.replace(/--[^\n]*/g, ' '), `021_commerce.sql declares a ${forbidden} column`).not.toMatch(
        new RegExp(`\\b${forbidden}\\s+(text|numeric|bigint|integer|bytea)`, 'i'),
      );
    }
  });

  it('the webhook is delivered once, signed, and says it will not be retried', () => {
    expect(serverSrc).toMatch(/createHmac\("sha256", secret\)/);
    expect(serverSrc).toMatch(/redirect: "manual"/);
    expect(serverSrc).toMatch(/retries: "none"/);
    expect(serverSrc).toMatch(/will NOT be retried/);
    // No secret means no delivery — an unsigned callback is a forgeable one.
    expect(serverSrc).toMatch(/COMMERCE_WEBHOOK_SECRET/);
    expect(serverSrc).toMatch(/An unsigned callback is one anybody could forge/);
  });

  it('refuses a callback host that would make this function fetch itself', () => {
    expect(serverSrc).toMatch(/an IP literal is not accepted as a callback host/);
    expect(serverSrc).toMatch(/only https callbacks are delivered to/);
  });
});

describe('the id shape is one literal in three places', () => {
  const ID_LITERAL = '^[a-z0-9][a-z0-9-]{7,63}$';

  it('the client regex, the API regex and the migration CHECK agree', () => {
    expect(readFileSync(CLIENT_INVOICE, 'utf8')).toContain(ID_LITERAL);
    expect(serverSrc).toContain(ID_LITERAL);
    expect(migrationSrc).toContain(ID_LITERAL);
  });
});

describe('a missing migration is never an answer about an invoice', () => {
  it('answers schema-missing with a 503 and an operator step, never a 404', () => {
    expect(serverSrc).toMatch(/code: "schema-missing"/);
    expect(serverSrc).toMatch(/operatorStep: MIGRATION_STEP/);
    const fn = serverSrc.slice(serverSrc.indexOf('function schemaMissing'), serverSrc.indexOf('async function postgrest'));
    expect(fn).toMatch(/res\.status\(503\)/);
    expect(fn).not.toMatch(/res\.status\(404\)/);
  });

  it('reserves 404 + code:"not-found" for the one branch that really is an answer', () => {
    expect(serverSrc).toMatch(/code: "not-found"/);
  });

  it('names the migration file an operator has to apply by hand', () => {
    expect(serverSrc).toMatch(/021_commerce\.sql/);
  });
});
