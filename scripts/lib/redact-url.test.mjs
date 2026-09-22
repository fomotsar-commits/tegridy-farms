// Proof for scripts/lib/redact-url.mjs, contracts/script/lib/redact-url.sh, and every
// surface outside frontend/ that prints an endpoint.
//
// RUN BY `node --test`, NOT VITEST, and named explicitly in .github/workflows/ci.yml.
// frontend/vitest.config.ts is rooted at frontend/, so nothing here can ever be
// collected by it -- see the OTHER_RUNNERS accounting in
// frontend/src/test/vitestCollection.test.ts, which asserts that this file is named by
// a workflow that runs on pull requests. Plain node:test also keeps these runnable on a
// bare runner with no frontend install, which is the constraint these scripts live under.
//
// THE DEFECT THIS PINS (2026-09-20). An ops CLI printed its configured endpoint verbatim
// in the header it prints on every invocation, dry runs included, and that put a live
// Alchemy API key into a shared terminal screenshot. The key was rotated. The same line
// existed in scripts outside frontend/, which the original fix did not cover.
//
// The invariant is TWO-SIDED, and both halves have to hold or the fix is not a fix:
//   1. no credential from the configured URL survives into the emitted text, and
//   2. the HOST does survive -- it is the operator's only local signal that a mainnet
//      ceremony is not pointed somewhere else.
// A test that only checked (1) would pass on `rpc: [redacted]`, which deletes the
// reason the line exists.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

import { redactRpcUrl } from './redact-url.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const SH_LIB = join(REPO_ROOT, 'contracts', 'script', 'lib', 'redact-url.sh');

// A fixture with a credential's SHAPE but not a credential's LOOK: 32 characters,
// long enough and mixed enough to fail every route-word test and exercise each
// masking path, but low-entropy and self-labelling so it reads as fake to a human.
//
// An earlier draft used a realistic high-entropy string and gitleaks flagged it as a
// generic-api-key -- correctly, on the evidence available to it. The fix belongs HERE
// rather than in an allowlist entry: .gitleaks.toml says in as many words that the
// better fix sits upstream of that file, and a repo that commits no credential-shaped
// literals needs no exemption to be added to a secret scanner. Do not 'improve' this
// back into something that looks real.
//
// KEY is what must not appear; HOST is what must.
const KEY = 'FAKEKEYFAKEKEYFAKEKEYFAKEKEY0000';
const HOST = 'eth-mainnet.g.alchemy.com';
const KEYED = `https://${HOST}/v2/${KEY}`;

/**
 * Both halves of the invariant, asserted against whatever text a surface emitted.
 *
 * The credential check is on an 8-character PREFIX of the key, not the whole key: a
 * render that truncated it (`/v2/FAKEKEYF...`) leaks enough to matter and would sail
 * straight through a whole-string check.
 *
 * The host is checked by PARSING the result and comparing `.host` exactly, not by
 * asking whether the hostname appears somewhere in the string. Substring-matching a
 * host is the js/incomplete-url-substring-sanitization pattern CodeQL flags, and it
 * flags it for a good reason: `https://evil.example.com/?x=eth-mainnet.g.alchemy.com`
 * would satisfy a substring check. The strict form is also the better assertion --
 * it proves the redactor kept the host AS the host, not merely somewhere in its output.
 *
 * It EXTRACTS the URL before parsing it, so it also accepts a whole emitted LINE --
 * `rpc     https://.../v2/***` -- and not only a bare URL. Every surface this file
 * guards prints the endpoint inside a line, and a helper that could only parse a bare
 * URL would push the next caller who asserts on a real line straight back into a
 * substring check. (This form started in frontend/scripts/lib/redact-url.test.mjs,
 * whose bayla-ladder-ops call site is a two-line header; it lives here now.)
 */
function assertRedacted(emitted, { key = KEY, host = HOST } = {}) {
  const text = String(emitted);
  assert.ok(!text.includes(key), `emitted the whole key: ${text}`);
  assert.ok(!text.includes(key.slice(0, 8)), `emitted a usable key prefix: ${text}`);
  const found = text.match(/\bhttps?:\/\/[^\s'"`]+/);
  if (!found) assert.fail(`expected a parseable URL so the host can be compared exactly, got: ${text}`);
  assert.equal(new URL(found[0]).host, host, `lost the host, which is why the line exists: ${text}`);
}

describe('redactRpcUrl -- the host survives, the credential does not', () => {
  test('masks a key in the path and keeps the path SHAPE', () => {
    const out = redactRpcUrl(KEYED);
    assertRedacted(out);
    // The shape is kept deliberately: `/v2/***` tells the operator this is a keyed
    // endpoint rather than a bare public one, without saying what the key is.
    assert.equal(out, `https://${HOST}/v2/***`);
  });

  test('masks a key in the query, whatever the parameter is called', () => {
    assert.equal(
      redactRpcUrl(`https://mainnet.helius-rpc.com/?api-key=${KEY}`),
      'https://mainnet.helius-rpc.com/?api-key=***',
    );
    assert.equal(
      redactRpcUrl(`https://lb.drpc.org/ogrpc?network=solana&dkey=${KEY}`),
      'https://lb.drpc.org/ogrpc?network=***&dkey=***',
    );
    // A repeated parameter stays repeated rather than collapsing.
    assert.equal(redactRpcUrl(`https://x.example.com/?k=${KEY}&k=${KEY}`), 'https://x.example.com/?k=***&k=***');
    // `?<key>` with no `=` is masked WHOLE. Read as a parameter NAME it would have been
    // printed in full, because names are kept -- this is the case that catches that.
    assert.equal(redactRpcUrl(`https://x.example.com/?${KEY}`), 'https://x.example.com/?***');
    // ...and still masked whole when it sits BESIDE a named parameter, rather than the
    // named one's handling leaking into it.
    assert.equal(redactRpcUrl(`https://x.example.com/?network=solana&${KEY}`), 'https://x.example.com/?network=***&***');
    // The other common spelling. Parameter names are not a list the redactor knows.
    assertRedacted(redactRpcUrl(`https://mainnet.helius-rpc.com/?apikey=${KEY}`), { host: 'mainnet.helius-rpc.com' });
  });

  test('masks userinfo, and still says one was there', () => {
    const out = redactRpcUrl(`https://apikey:${KEY}@rpc.example.com/`);
    assertRedacted(out, { host: 'rpc.example.com' });
    assert.equal(out, 'https://***@rpc.example.com');
    // The key as the USERNAME with no password -- a different field of the parsed URL,
    // and the shape some providers actually use.
    assert.equal(redactRpcUrl(`https://${KEY}@rpc.example.com/`), 'https://***@rpc.example.com');
  });

  test('masks a fragment', () => {
    assert.equal(redactRpcUrl(`https://${HOST}/rpc#${KEY}`), `https://${HOST}/rpc#***`);
    assertRedacted(redactRpcUrl(`https://${HOST}/v2/x#${KEY}`));
  });

  test('leaves a keyless public endpoint EXACTLY as it was', () => {
    // Half (2) of the invariant: these are what an operator compares against to notice
    // they are on the wrong network.
    for (const url of [
      'https://ethereum-rpc.publicnode.com',
      'https://eth.drpc.org',
      'https://api.devnet.solana.com',
      // The Solana ops CLIs' mainnet default: the value an operator reads back to
      // confirm a ceremony is NOT on devnet, so it must survive untouched.
      'https://api.mainnet-beta.solana.com',
      'http://127.0.0.1:8545',
      'http://127.0.0.1:8899',
    ]) {
      assert.equal(redactRpcUrl(url), url);
    }
  });

  test('keeps route words and masks every credential-shaped path segment', () => {
    // Route words carry no secret and reading them back is how an operator recognises
    // the provider's URL, so they survive; anything longer or digit-bearing does not.
    assert.equal(redactRpcUrl('https://h.example.com/v2'), 'https://h.example.com/v2');
    assert.equal(redactRpcUrl('https://h.example.com/solana/rpc/v1'), 'https://h.example.com/solana/rpc/v1');
    // The path shapes of the providers this repo's RPC roster actually uses. Every
    // fixture is deliberately DULL -- 'deadbeef' repeated, a nil-ish UUID -- because a
    // realistic one is a credential-shaped literal, and this file already had to be
    // rewritten out of history once for committing one of those.
    assert.equal(
      redactRpcUrl('https://mainnet.infura.io/v3/deadbeefdeadbeefdeadbeefdeadbeef'),
      'https://mainnet.infura.io/v3/***',
    );
    assert.equal(
      redactRpcUrl('https://eth-mainnet.blastapi.io/00000000-0000-4000-8000-000000000000'),
      'https://eth-mainnet.blastapi.io/***',
    );
    // QuickNode's token is a whole path segment with a TRAILING slash. The empty
    // segment it leaves behind must stay empty rather than becoming another mask.
    assert.equal(
      redactRpcUrl(`https://name.solana-mainnet.quiknode.pro/${KEY}/`),
      'https://name.solana-mainnet.quiknode.pro/***/',
    );
    assert.equal(redactRpcUrl(`https://rpc.ankr.com/solana/${KEY}`), 'https://rpc.ankr.com/solana/***');
  });

  test('refuses rather than echoes when there is nothing it can parse', () => {
    // A value that is not a URL may BE the bare key -- someone exporting ETH_RPC_URL
    // wrong. Passing it through is the one outcome that must not happen.
    for (const bad of [KEY, `  ${KEY}  `, 'not a url', 'file:///etc/passwd']) {
      const out = redactRpcUrl(bad);
      assert.ok(!out.includes(KEY.slice(0, 8)), `echoed an unparseable value: ${out}`);
      assert.match(out, /^\[(unreadable|no) endpoint\]$/);
    }
    for (const empty of ['', '   ', undefined, null, 42, {}]) {
      assert.equal(redactRpcUrl(empty), '[no endpoint]');
    }
  });
});

/**
 * Run the SHELL redactor the shell scripts actually source, in bash.
 *
 * Sourcing the real file rather than scraping its text means this pins the behaviour
 * the scripts get, not a copy of it. bash is present on the ubuntu runner ci.yml uses
 * and in Git Bash locally; a missing bash FAILS here rather than skipping, because a
 * silent skip is how a guard stops guarding.
 */
const shRedact = (value) => execFileSync(
  'bash',
  ['-c', '. "$1"; redact_url "$2"', '_', SH_LIB, value],
  { encoding: 'utf8' },
);

describe('redact_url (shell) -- same four places, same kept host', () => {
  test('the shell library exists and is sourceable', () => {
    // Guard on the guard: if the file moved, every assertion below would otherwise
    // fail with a shell error that reads like a redaction bug.
    assert.ok(existsSync(SH_LIB), `${SH_LIB} is missing`);
    assert.equal(shRedact('https://ethereum-rpc.publicnode.com'), 'https://ethereum-rpc.publicnode.com');
  });

  test('masks the path, the query values, userinfo and the fragment', () => {
    assertRedacted(shRedact(KEYED));
    assert.equal(shRedact(KEYED), `https://${HOST}/v2/***`);
    assert.equal(
      shRedact(`https://lb.drpc.org/ogrpc?network=solana&dkey=${KEY}`),
      'https://lb.drpc.org/ogrpc?network=***&dkey=***',
    );
    assert.equal(shRedact(`https://apikey:${KEY}@rpc.example.com/`), 'https://***@rpc.example.com/');
    assert.equal(shRedact(`https://h.example.com/rpc#${KEY}`), 'https://h.example.com/rpc#***');
    // No `=` to read, so the pair is masked whole rather than treated as a name.
    assert.equal(shRedact(`https://x.example.com/?${KEY}`), 'https://x.example.com/?***');
  });

  test('keeps a keyless endpoint and a foundry rpc alias readable', () => {
    for (const url of ['https://ethereum-rpc.publicnode.com', 'http://127.0.0.1:8545']) {
      assert.equal(shRedact(url), url);
    }
    // deploy-gated.sh passes an alias from foundry.toml [rpc_endpoints] by default.
    // These carry no credential and printing "[unreadable endpoint]" for the ordinary
    // case would train an operator to ignore the line.
    for (const alias of ['mainnet', 'flashbots', 'mev-blocker']) {
      assert.equal(shRedact(alias), alias);
    }
  });

  test('refuses a bare key rather than echoing it', () => {
    for (const bad of [KEY, `  ${KEY}  `, 'not a url']) {
      const out = shRedact(bad);
      assert.ok(!out.includes(KEY.slice(0, 8)), `echoed an unparseable value: ${out}`);
      assert.match(out, /^\[(unreadable|no) endpoint\]$/);
    }
    assert.equal(shRedact(''), '[no endpoint]');
  });
});

describe('the host assertion itself -- pinning the CodeQL fix', () => {
  // Reverting assertRedacted's exact host comparison to `emitted.includes(host)`
  // leaves every other test in this file GREEN -- measured, not assumed. So the
  // strict form needs its own pin, or the tempting "simplification" reintroduces
  // js/incomplete-url-substring-sanitization with nothing to catch it.
  test('a hostname that is merely PRESENT does not satisfy it', () => {
    // The shape from the CodeQL rule's own description: the real host appears in
    // the string, but it is NOT the host -- it is a query value on evil.example.com.
    // `impostor.includes(HOST)` is therefore true, which is the entire bug.
    //
    // That claim is stated here rather than asserted, deliberately. Writing it as
    // executable code re-introduces the exact pattern this test exists to keep out,
    // and CodeQL flags it on sight -- correctly, and it did: the first draft of this
    // test shipped the assertion and raised a fresh high-severity alert of the very
    // rule it was written to defend. The teeth are in the throws below, which fails
    // if assertRedacted is ever loosened back to a substring check.
    const impostor = `https://evil.example.com/?x=${HOST}`;
    assert.throws(() => assertRedacted(impostor), /lost the host/);
  });

  test('output that is not a URL fails loudly rather than passing quietly', () => {
    // `[unreadable endpoint]` is a legitimate result FROM the redactor -- it refused
    // to echo something it could not parse. It is not a redacted host, though, and a
    // helper that shrugged at it would stop proving half the invariant.
    assert.throws(() => assertRedacted('rpc     [unreadable endpoint]'), /parseable URL/);
  });

  test('a whole emitted LINE is checked, not only a bare URL', () => {
    // What every guarded surface actually prints. A helper that parsed `emitted` whole
    // would throw here, and the obvious "fix" for that is a substring check.
    assertRedacted(`rpc     ${redactRpcUrl(KEYED)}`);
    assert.throws(() => assertRedacted(`rpc     ${KEYED}`), /key/);
  });
});

// ---------------------------------------------------------------------------
// Source guards.
//
// The contract tests above prove the two redactors work. They cannot prove the scripts
// USE them, and a redactor nobody calls is not a fix. These read the scripts and pin
// that every endpoint reaching printed text goes through one.
//
// A guard like this is also what finds the site a human list misses: the endpoint
// variable is derived from each script's own declarations rather than a hardcoded name
// list, so a rename cannot quietly empty it and a fourth script cannot be overlooked.
// ---------------------------------------------------------------------------

/** Source with comments removed, so a guard that is commented out stops matching. */
const stripJsComments = (src) => src
  .replace(/\r\n/g, '\n')
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
  .replace(/\/\*.*?\*\//g, '')
  .replace(/(^|[ \t])\/\/.*$/gm, '$1');

const ENDPOINTISH = /rpc|fork|cluster|endpoint/i;
const DECL = /^[ \t]*(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(.+)$/gm;

/**
 * The identifiers a script resolves an endpoint into: a declaration that either defaults
 * to an `http…` literal while naming an endpoint, or reads one out of an endpoint-shaped
 * environment variable. Both forms are how every script here takes its endpoint.
 *
 * Deliberately NOT a fixpoint over "anything referencing an endpoint variable": in
 * pull-caller-credit.mjs that would capture `const res = await fetch(RPC, …)` and then
 * call `${res.status}` a leak. The two forms below are narrow enough to stay honest and
 * wide enough to have caught verify-ownership.mjs, which was not on the list of sites
 * this change started from.
 *
 * WHAT IT CANNOT SEE, stated rather than implied: an endpoint read from an environment
 * variable whose name says nothing about endpoints, with no literal default, is
 * invisible to it.
 */
const endpointIdents = (code) => [...code.matchAll(DECL)]
  .filter(([, name, rhs]) => (
    (/['"`]https?:\/\//.test(rhs) && ENDPOINTISH.test(`${name} ${rhs}`))
    || /process\.env\.[A-Za-z0-9_]*(RPC|FORK|CLUSTER|ENDPOINT)/i.test(rhs)
  ))
  .map(([, name]) => name);

/** Every `${…}` in the source, as the expression text between the braces. */
const interpolations = (code) => [...code.matchAll(/\$\{([^{}]*)\}/g)].map((m) => m[1]);

const SCRIPTS_DIR = join(REPO_ROOT, 'scripts');
const opsScripts = () => [SCRIPTS_DIR, join(SCRIPTS_DIR, 'lib')]
  .flatMap((dir) => readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
    .map((f) => join(dir, f)))
  .map((path) => ({ path, name: basename(path), code: stripJsComments(readFileSync(path, 'utf8')) }));

describe('no repo-root script echoes an endpoint unredacted', () => {
  test('finds the endpoint variables it is supposed to be guarding', () => {
    // Guard on the guard. If the detector matches nothing -- a rewritten declaration, a
    // moved file -- every assertion below passes over an empty set and pins nothing.
    const byName = Object.fromEntries(
      opsScripts().map((s) => [s.name, endpointIdents(s.code)]).filter(([, ids]) => ids.length),
    );
    assert.ok(byName['pull-caller-credit.mjs']?.includes('RPC'), 'lost RPC in pull-caller-credit.mjs');
    assert.ok(byName['exotic-toweli-fork-rehearsal.mjs']?.includes('FORK_URL'), 'lost FORK_URL');
    assert.ok(byName['verify-ownership.mjs']?.includes('url'), 'lost url in verify-ownership.mjs');
    assert.ok(byName['oneshot-guard.mjs']?.includes('url'), 'lost url in oneshot-guard.mjs');
    assert.ok(Object.keys(byName).length >= 4, `too few endpoint scripts found: ${Object.keys(byName)}`);
  });

  test('interpolates every endpoint variable only through redactRpcUrl', () => {
    const leaks = [];
    for (const { name, code } of opsScripts()) {
      const idents = new Set(endpointIdents(code));
      if (!idents.size) continue;
      for (const expr of interpolations(code)) {
        // Compare whole IDENTIFIERS rather than building a regex out of the names: a
        // name may legally contain `$`, which is a regex metacharacter, and a
        // word-boundary pattern assembled from untrusted names is how this guard
        // silently matched nothing the first time it was written.
        const mentions = (expr.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || []).some((t) => idents.has(t));
        if (mentions && !/redactRpcUrl\s*\(/.test(expr)) leaks.push(`${name}: \${${expr}}`);
      }
    }
    assert.deepEqual(leaks, [], `these print an endpoint verbatim:\n  ${leaks.join('\n  ')}`);
  });
});

const shellScripts = () => execFileSync('git', ['ls-files', '*.sh'], { cwd: REPO_ROOT, encoding: 'utf8' })
  .split('\n').map((l) => l.trim())
  .filter((l) => l && !l.startsWith('contracts/lib/') && !l.endsWith('script/lib/redact-url.sh'))
  .map((rel) => ({
    rel,
    // Full-line comments only: an inline `#` may live inside a quoted string.
    lines: readFileSync(join(REPO_ROOT, rel), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)),
  }));

/** Lines that PRINT and mention an endpoint-shaped variable. */
const printingEndpointLines = (lines) => lines.filter(
  (l) => /(^|[\s;(])(echo|printf)\b/.test(l) && /\$\{?[A-Za-z_]*(RPC|FORK_URL)/.test(l),
);

describe('no shell script echoes an endpoint unredacted', () => {
  test('finds the printing lines it is supposed to be guarding', () => {
    // Stays true after the fix: the redacted form still names the variable, inside
    // $(redact_url "$RPC_URL"). If this goes empty the guard below is vacuous.
    const found = shellScripts()
      .map((s) => [s.rel, printingEndpointLines(s.lines).length])
      .filter(([, n]) => n > 0);
    const byRel = Object.fromEntries(found);
    assert.ok(byRel['contracts/script/cancel-gated-pending.sh'] >= 1, 'lost the cancel-gated header');
    assert.ok(byRel['contracts/script/deploy-gated.sh'] >= 1, 'lost the deploy-gated header');
  });

  test('prints an endpoint only through redact_url', () => {
    const leaks = [];
    for (const { rel, lines } of shellScripts()) {
      for (const line of printingEndpointLines(lines)) {
        if (!/redact_url\b/.test(line)) leaks.push(`${rel}: ${line.trim()}`);
      }
    }
    assert.deepEqual(leaks, [], `these print an endpoint verbatim:\n  ${leaks.join('\n  ')}`);
  });
});
