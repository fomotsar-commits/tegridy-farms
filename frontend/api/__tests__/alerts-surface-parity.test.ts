// Drift guard for the alerts surface.
//
// TWO THINGS CAN ROT HERE, BOTH SILENTLY.
//
// 1. THE FUNCTION BUDGET. Vercel Hobby caps a deployment at 12 serverless
//    functions and this repo is at 11 (api/SERVERLESS_BUDGET.md). Alerts shipped
//    as a `?resource=` branch on the aggregator catchall precisely so the count
//    would not move. A future `api/alerts.js` would be the 12th — the deploy
//    would still pass, and the NEXT feature would fail a build with an error that
//    names nothing about alerts. This test makes the branch, not a new function,
//    the thing that has to be true.
//
//    The branch also has to sit ABOVE the `const provider` line: a `?resource=`
//    call carries no provider, so a branch placed after it never runs and the
//    route 404s. That ordering bug is invisible in review and total in effect.
//
// 2. THE RULE VOCABULARY. A rule kind lives in three places — the browser's
//    validator, the API's validator, and the migration's CHECK constraint. If
//    they drift, the failure lands on the user as a rule that saves and never
//    evaluates, or one the database refuses for reasons the UI cannot explain.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = join(HERE, '..');
const AGGREGATOR = join(API_DIR, 'aggregator.js');
const SERVER_ALERTS = join(API_DIR, '_lib', 'alerts.js');
const CLIENT_RULES = join(HERE, '..', '..', 'src', 'lib', 'alerts', 'rules.ts');
const MIGRATION = join(HERE, '..', '..', 'supabase', 'migrations', '016_alert_rules.sql');

/**
 * Vercel counts each top-level handler under `api/` — NOT `_lib/`,
 * `__tests__/`, or `_`-prefixed files. Mirrors the accounting in
 * SERVERLESS_BUDGET.md.
 */
function countFunctions(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith('_') || name === '__tests__' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...countFunctions(full));
    } else if (name.endsWith('.js') && !name.endsWith('.test.js')) {
      out.push(full.slice(API_DIR.length + 1).replace(/\\/g, '/'));
    }
  }
  return out;
}

describe('the alerts store costs no serverless function', () => {
  it('there is no top-level api/alerts.js', () => {
    const fns = countFunctions(API_DIR);
    expect(fns, 'alerts must live on the catchall, not as its own function').not.toContain('alerts.js');
  });

  it('the deployment stays at or under the Hobby cap of 12', () => {
    const fns = countFunctions(API_DIR);
    expect(fns.length, `functions: ${fns.join(', ')}`).toBeLessThanOrEqual(12);
  });

  it('the catchall dispatches ?resource=alerts behind a lazy import', () => {
    const src = readFileSync(AGGREGATOR, 'utf8');
    expect(src).toMatch(/req\.query\.resource === "alerts"/);
    expect(src).toMatch(/await import\("\.\/_lib\/alerts\.js"\)/);
  });

  it('the alerts branch sits ABOVE the provider dispatch, or it would never run', () => {
    const src = readFileSync(AGGREGATOR, 'utf8');
    const branch = src.indexOf('req.query.resource === "alerts"');
    const provider = src.indexOf('const provider = req.query.provider');
    expect(branch).toBeGreaterThan(-1);
    expect(provider).toBeGreaterThan(-1);
    expect(branch, 'a ?resource= call carries no provider — a branch below this line 404s').toBeLessThan(provider);
  });
});

/**
 * Both files below discuss the very shapes these guards forbid — the SQL warns
 * against adding a `last_fired_at`, the handler explains why it never answers
 * `{ rules: [] }`. Grepping the prose would fail the guard for saying the right
 * thing, so the guards run over code with comments stripped.
 */
function codeOnly(src: string, style: 'js' | 'sql'): string {
  return src
    .split('\n')
    .filter((line) => !line.trim().startsWith(style === 'sql' ? '--' : '//'))
    .join('\n');
}

/** The kind list as each of the three layers spells it. */
function clientKinds(): string[] {
  const src = readFileSync(CLIENT_RULES, 'utf8');
  const m = src.match(/export const ALERT_RULE_KINDS[^=]*=\s*\[([^\]]*)\]/);
  if (!m) throw new Error('could not locate ALERT_RULE_KINDS in src/lib/alerts/rules.ts');
  return [...m[1]!.matchAll(/'([a-z-]+)'/g)].map((x) => x[1]!).sort();
}

function serverKinds(): string[] {
  const src = readFileSync(SERVER_ALERTS, 'utf8');
  const m = src.match(/const ALERT_RULE_KINDS\s*=\s*\[([^\]]*)\]/);
  if (!m) throw new Error('could not locate ALERT_RULE_KINDS in api/_lib/alerts.js');
  return [...m[1]!.matchAll(/"([a-z-]+)"/g)].map((x) => x[1]!).sort();
}

function migrationKinds(): string[] {
  const src = readFileSync(MIGRATION, 'utf8');
  const m = src.match(/kind\s+text\s+NOT NULL CHECK \(kind IN \(([\s\S]*?)\)\)/);
  if (!m) throw new Error('could not locate the kind CHECK constraint in migration 016');
  return [...m[1]!.matchAll(/'([a-z-]+)'/g)].map((x) => x[1]!).sort();
}

describe('the rule vocabulary is one vocabulary', () => {
  it('browser, API and database agree on the kinds', () => {
    const client = clientKinds();
    expect(client.length).toBeGreaterThan(0);
    expect(serverKinds(), 'api/_lib/alerts.js drifted from src/lib/alerts/rules.ts').toEqual(client);
    expect(migrationKinds(), 'migration 016 drifted from the code').toEqual(client);
  });
});

describe('the migration is an unapplied file, and says so', () => {
  it('exists and creates the table with RLS enabled', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS alert_rules/);
    expect(sql).toMatch(/ALTER TABLE alert_rules ENABLE ROW LEVEL SECURITY/);
  });

  it('every policy binds to the SIWE wallet claim, not merely to an authenticated role', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    const policies = [...sql.matchAll(/CREATE POLICY\s+"([^"]+)"\s+ON\s+alert_rules([\s\S]*?);/g)];
    expect(policies.length, 'no policies found on alert_rules').toBeGreaterThanOrEqual(4);
    for (const [, name, body] of policies) {
      expect(body, `${name} is not bound to the JWT wallet claim`).toMatch(/request\.jwt\.claims/);
    }
  });

  it('the UPDATE policy gates what a row may BECOME, not only which rows are visible', () => {
    // Without WITH CHECK an owner could re-home their rule to another wallet.
    const sql = readFileSync(MIGRATION, 'utf8');
    const update = sql.match(/CREATE POLICY[^;]*FOR UPDATE([\s\S]*?);/);
    expect(update?.[1]).toMatch(/WITH CHECK/);
  });

  it('the schema carries no column that would imply something evaluates rules server-side', () => {
    // A `last_fired_at` that is always NULL reads as "never fired", which is a
    // claim. No column may exist until a real evaluator writes to it.
    const sql = codeOnly(readFileSync(MIGRATION, 'utf8'), 'sql');
    expect(sql).not.toMatch(/last_fired_at|last_triggered|fired_count/i);
  });
});

describe('the server never answers a missing table with an empty list', () => {
  it('the schema-missing branch returns a code and an operator step', () => {
    const src = readFileSync(SERVER_ALERTS, 'utf8');
    expect(src).toMatch(/code: "schema-missing"/);
    expect(src).toMatch(/016_alert_rules\.sql/);
  });

  it('no branch responds with a literal empty rules array', () => {
    const src = codeOnly(readFileSync(SERVER_ALERTS, 'utf8'), 'js');
    expect(src).not.toMatch(/rules:\s*\[\s*\]/);
  });
});
