// @vitest-environment node
//
// NODE, not the project's jsdom default: this file imports bayla-ladder-ops.mjs, and
// under jsdom `PublicKey.findProgramAddressSync` fails every bump. Same reason, same
// choice as bayla-ladder-ops.test.mjs.
//
// Proof for lib/redact-url.mjs and for the surfaces that print an endpoint.
//
// THE DEFECT THIS PINS (2026-09-20). `bayla-ladder-ops.mjs` printed its `--rpc` value
// verbatim on every invocation, dry runs included, and during the BAYLA ladder mainnet
// go-live that put the owner's live Alchemy API key into a shared terminal screenshot.
// The key was rotated. `BAYLA_LADDER_MAINNET_RUNBOOK.md` §0 tells the operator never to
// paste that URL into the repo; the tool pasted it into stdout unasked.
//
// So the invariant is two-sided, and BOTH halves have to hold or the fix is not a fix:
//   1. no credential from the configured URL survives into the emitted text, and
//   2. the HOST does survive — it is the operator's only local signal that a mainnet
//      ceremony is not running against this CLI's devnet default.
// A test that only checked (1) would pass on `console.log('rpc     [redacted]')`, which
// deletes the reason the line exists.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

import { redactRpcUrl } from './redact-url.mjs';
import { headerLines } from '../bayla-ladder-ops.mjs';

// A credential-SHAPED fixture: 32 characters, the length of a real Alchemy key, and long
// enough to fail every route-word test in the redactor so it must be masked.
//
// DELIBERATELY LOW-ENTROPY AND SELF-LABELLING, and not a stylistic choice. A realistic
// random-looking literal here is flagged by the repo's gitleaks gate as `generic-api-key`
// on entropy alone, and `gitleaks-action` scans a PR's whole COMMIT RANGE rather than its
// head tree — so a later commit that fixes the fixture does NOT clear the gate; the
// offending commit stays in range and the branch stays red until history is rewritten.
//
// The other option was a `.gitleaks.toml` allowlist entry, and it is the wrong one. That
// allowlist is GLOBAL across every rule (its own comments record a real case where a shape
// entry silenced the dedicated sendgrid-api-token rule), it is deliberately a closed list
// of exact strings that were each verified to be public on-chain identifiers, and the file
// states its own doctrine: "The better fix sits upstream of this file ... so entries get
// DELETED not added." Buying a permanent scanner exemption for a value we invented would
// be the clearest possible violation of that.
const KEY = 'FAKEKEYFAKEKEYFAKEKEYFAKEKEY0000';
const HOST = 'solana-mainnet.g.alchemy.com';
const KEYED = `https://${HOST}/v2/${KEY}`;

/**
 * The endpoint in some emitted text, parsed — never substring-matched.
 *
 * `expect(emitted).toContain(host)` is the obvious way to assert the host survived, and it
 * is wrong: `https://evil.example.com/?x=solana-mainnet.g.alchemy.com` contains the host
 * while being a completely different origin. CodeQL flags that shape as
 * `js/incomplete-url-substring-sanitization` and is right to. Parsing is also the STRONGER
 * assertion for what this test is actually for — it proves the redactor kept the host AS
 * the host, rather than leaving the string lying around somewhere in its output.
 *
 * Extracts rather than parsing `emitted` whole, because some call sites pass a multi-line
 * emission (bayla-ladder-ops' two-line header) rather than a bare URL.
 */
function hostOf(emitted) {
  const found = String(emitted).match(/\bhttps?:\/\/[^\s'"`]+/);
  expect(found, `expected an http(s) URL somewhere in: ${emitted}`).not.toBeNull();
  return new URL(found[0]).host;
}

/**
 * Both halves of the invariant, asserted against whatever text a surface emitted.
 *
 * The credential check is on an 8-character PREFIX of the key, not the whole key: a
 * render that truncated it (`/v2/FAKEKEYF…`) leaks enough to matter and would sail
 * through a whole-string `not.toContain`.
 */
function expectRedacted(emitted, { key = KEY, host = HOST } = {}) {
  expect(emitted).not.toContain(key);
  expect(emitted).not.toContain(key.slice(0, 8));
  expect(hostOf(emitted)).toBe(host);
}

describe('the host assertion itself', () => {
  it('cannot be satisfied by a DIFFERENT origin that merely contains the host', () => {
    // The whole reason hostOf parses instead of substring-matching. `impostor` CONTAINS
    // the expected host — so the weak form of this assertion, `expect(impostor)
    // .toContain(HOST)`, passes on it — while being an entirely attacker-chosen origin.
    // If someone "simplifies" hostOf back to a substring check, this is what stops them.
    //
    // THE WEAK ASSERTION IS DESCRIBED ABOVE, NOT EXECUTED, AND THAT IS DELIBERATE.
    // Writing it out is itself an instance of js/incomplete-url-substring-sanitization, and
    // CodeQL matches the line, not the intent — so a test that documents the pattern by
    // performing it raises a fresh high-severity alert of the very rule it defends against.
    // The sibling session hit exactly that, one commit after fixing the original instance.
    // Nothing is lost: the teeth are in the parsed comparison below and in the `throws`
    // case, never in a line asserting that a substring check does what substring checks do.
    const impostor = `https://evil.example.com/?x=${HOST}`;
    expect(hostOf(impostor)).toBe('evil.example.com');
    expect(hostOf(impostor)).not.toBe(HOST);
  });

  it('fails loudly when there is no URL to parse at all', () => {
    // A silent pass on unparseable output is how a host check stops checking anything.
    expect(() => hostOf('rpc     [unreadable endpoint]')).toThrow();
  });
});

describe('redactRpcUrl — the host survives, the credential does not', () => {
  it('masks a key in the path and keeps the host and the path SHAPE', () => {
    const out = redactRpcUrl(KEYED);
    expectRedacted(out);
    // The shape is kept deliberately: `/v2/***` tells the operator this is a keyed
    // endpoint rather than a bare public one, without saying what the key is.
    expect(out).toBe(`https://${HOST}/v2/***`);
  });

  it('masks a key in the query string, whatever the parameter is called', () => {
    // Helius puts it in `api-key`, drpc in `dkey`, and the next provider will pick a
    // third name. Every VALUE is masked and the names are kept, so this does not depend
    // on having heard of the parameter.
    expect(redactRpcUrl(`https://mainnet.helius-rpc.com/?api-key=${KEY}`))
      .toBe('https://mainnet.helius-rpc.com/?api-key=***');
    expectRedacted(redactRpcUrl(`https://mainnet.helius-rpc.com/?apikey=${KEY}`), {
      host: 'mainnet.helius-rpc.com',
    });
    expect(redactRpcUrl(`https://lb.drpc.org/ogrpc?network=solana&dkey=${KEY}`))
      .toBe('https://lb.drpc.org/ogrpc?network=***&dkey=***');
    // A repeated parameter stays repeated, and a bare `?token` with no `=` is masked
    // rather than dropped — dropping it would under-report what was sent.
    expect(redactRpcUrl(`https://x.example.com/?k=${KEY}&k=${KEY}`))
      .toBe('https://x.example.com/?k=***&k=***');
    // `?<key>` with no `=` is masked WHOLE. Read as a parameter name it would have been
    // printed in full, because names are kept — this is the case that catches that.
    expect(redactRpcUrl(`https://x.example.com/?${KEY}`)).toBe('https://x.example.com/?***');
    expect(redactRpcUrl(`https://x.example.com/?network=solana&${KEY}`))
      .toBe('https://x.example.com/?network=***&***');
  });

  it('masks a credential in userinfo, and still says one was there', () => {
    const out = redactRpcUrl(`https://apikey:${KEY}@rpc.example.com/`);
    expectRedacted(out, { host: 'rpc.example.com' });
    // `***@` rather than silence: an endpoint carrying userinfo is worth noticing, and a
    // render that dropped it would read as a plain public URL.
    expect(out).toBe('https://***@rpc.example.com');
    expect(redactRpcUrl(`https://${KEY}@rpc.example.com/`)).toBe('https://***@rpc.example.com');
  });

  it('masks a fragment', () => {
    expectRedacted(redactRpcUrl(`https://${HOST}/v2/x#${KEY}`), { host: HOST });
    expect(redactRpcUrl(`https://${HOST}/rpc#${KEY}`)).toBe(`https://${HOST}/rpc#***`);
  });

  it('leaves a keyless public endpoint EXACTLY as it was', () => {
    // The CLI defaults, and the reason (2) half of the invariant matters: these are what
    // the operator compares against to notice they are on devnet.
    for (const url of [
      'https://api.devnet.solana.com',
      'https://api.mainnet-beta.solana.com',
      'https://eth.drpc.org',
      'https://ethereum-rpc.publicnode.com',
      'http://127.0.0.1:8899',
    ]) {
      expect(redactRpcUrl(url)).toBe(url);
    }
  });

  // CONVERGENCE NOTE. This test and the pure-contract ones above are duplicated in
  // scripts/lib/redact-url.test.mjs (repo root), which is the canonical home once both
  // halves of this fix land. When deleting them from here, DIFF THE TWO FILES rather than
  // assuming the port was complete — the QuickNode trailing-slash case below is the one
  // with no other coverage: the empty segment a trailing `/` leaves behind must stay empty
  // rather than becoming a second `***`, and nothing else in either file asserts that.
  it('keeps route words and masks every credential-shaped path segment', () => {
    // Route words: short, letters, an optional version number. These carry no secret and
    // reading them back is how an operator recognises the provider's URL.
    expect(redactRpcUrl('https://h.example.com/v2')).toBe('https://h.example.com/v2');
    expect(redactRpcUrl('https://h.example.com/solana/rpc/v1')).toBe('https://h.example.com/solana/rpc/v1');
    // Credential shapes from the real providers this repo has used: 32-hex (Infura),
    // a UUID (Blast), base58 (Alchemy), a QuickNode token with a trailing slash.
    // 32-char hex, deliberately repeating: dull for the same reason KEY is dull, and it
    // exercises the identical path — any 32-char segment fails ROUTE_WORD whatever it spells.
    expect(redactRpcUrl('https://mainnet.infura.io/v3/deadbeefdeadbeefdeadbeefdeadbeef'))
      .toBe('https://mainnet.infura.io/v3/***');
    expect(redactRpcUrl('https://eth-mainnet.blastapi.io/550e8400-e29b-41d4-a716-446655440000'))
      .toBe('https://eth-mainnet.blastapi.io/***');
    expect(redactRpcUrl(`https://name.solana-mainnet.quiknode.pro/${KEY}/`))
      .toBe('https://name.solana-mainnet.quiknode.pro/***/');
    expect(redactRpcUrl(`https://rpc.ankr.com/solana/${KEY}`)).toBe('https://rpc.ankr.com/solana/***');
  });

  it('refuses rather than echoes when there is nothing it can parse', () => {
    // A value that is not a URL may BE the bare key — someone exporting SOLANA_RPC wrong.
    // Passing it through is the one outcome that must not happen, so the fallbacks say
    // what went wrong and print none of the input.
    for (const bad of [KEY, `  ${KEY}  `, 'not a url', 'file:///etc/passwd', 'ws//host']) {
      const out = redactRpcUrl(bad);
      expect(out).not.toContain(KEY.slice(0, 8));
      expect(out).toMatch(/^\[(unreadable|no) endpoint\]$/);
    }
    for (const empty of ['', '   ', undefined, null, 42, {}]) {
      expect(redactRpcUrl(empty)).toBe('[no endpoint]');
    }
  });
});

describe('bayla-ladder-ops header — the line that leaked', () => {
  const PROGRAM = 'EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ';

  it('prints the host of a keyed endpoint and none of its key', () => {
    const emitted = headerLines({ programId: PROGRAM, rpc: KEYED }).join('\n');
    expectRedacted(emitted);
    expect(emitted).toContain(PROGRAM);
  });

  it('still tells the operator apart from the devnet default', () => {
    // The whole point of the line: mainnet and devnet must not render identically.
    const mainnet = headerLines({ programId: PROGRAM, rpc: KEYED }).join('\n');
    const devnet = headerLines({ programId: PROGRAM, rpc: 'https://api.devnet.solana.com' }).join('\n');
    // Exact hosts, not substrings — same reason as hostOf.
    expect(hostOf(devnet)).toBe('api.devnet.solana.com');
    expect(hostOf(mainnet)).toBe(HOST);
    expect(mainnet).not.toContain('devnet');
    expect(mainnet).not.toBe(devnet);
  });
});

/**
 * Source with its comments removed, so a guard that is commented out stops matching.
 * Copied verbatim from bayla-ladder-ops.test.mjs, which pins its behaviour.
 */
const stripComments = (src) => src
  .replace(/\r\n/g, '\n')
  .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
  .replace(/\/\*.*?\*\//g, '')
  .replace(/(^|[ \t])\/\/.*$/gm, '$1');

const SCRIPTS = dirname(dirname(fileURLToPath(import.meta.url)));

const opsScripts = () => [SCRIPTS, join(SCRIPTS, 'lib')]
  .flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs')).map((f) => join(dir, f)))
  .map((path) => ({ path, name: basename(path), code: stripComments(readFileSync(path, 'utf8')) }));

/** Every `${…}` in the source, as the expression text between the braces. */
const interpolations = (code) => [...code.matchAll(/\$\{([^{}]*)\}/g)].map((m) => m[1]);

/**
 * The identifier tokens in an expression.
 *
 * Whole tokens, compared through a Set — this deliberately builds NO regex out of a
 * variable's name. `$` is legal in a JavaScript identifier and is a regex anchor, so
 * `new RegExp(name)` on an identifier like `rpc$url` matches the wrong thing, silently and
 * in the direction that makes the guard pass. Tokenising also stops `rpc` from matching
 * inside `rpcTimeoutMs`.
 */
const identTokens = (expr) => expr.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || [];

/**
 * The identifiers a script resolves an endpoint into: a declaration that both defaults to
 * an `http…` literal and mentions rpc/fork/cluster. That is how all five of these scripts
 * take their endpoint, and deriving the name from the source means renaming the variable
 * cannot quietly empty this guard the way a hardcoded name list would.
 *
 * WHAT IT CANNOT SEE, stated rather than implied: an endpoint resolved with no literal
 * default (`requireEnv('SOLANA_RPC_URL')` in tegridy-launch-operator.mjs) is invisible to
 * it. The `rpcEndpoint` case below covers that one script's echo; a new script that reads
 * an endpoint from the environment with no default and prints it would pass this guard.
 */
const endpointIdents = (code) => [...code.matchAll(/^[ \t]*(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=[ \t]*(.+)$/gm)]
  .filter(([, , rhs]) => /['"`]https?:\/\//.test(rhs) && /rpc|fork|cluster/i.test(rhs))
  .map(([, name]) => name);

describe('no ops script under frontend/scripts echoes an endpoint unredacted', () => {
  it('finds the endpoint variables it is supposed to be guarding', () => {
    // Guard on the guard. If the detector matches nothing — a rewritten declaration, a
    // moved file — every assertion below passes over an empty set and pins nothing.
    const found = opsScripts()
      .map((s) => [s.name, endpointIdents(s.code)])
      .filter(([, idents]) => idents.length > 0);
    const byName = Object.fromEntries(found);
    expect(byName['bayla-ladder-ops.mjs']).toContain('rpc');
    expect(byName['bayla-lighthouse-ceremony.mjs']).toContain('clusterUrl');
    expect(byName['run-e2e-with-anvil.mjs']).toContain('FORK_URL');
    expect(byName['verify-yield-protocols.mjs']).toContain('RPC');
    expect(byName['verify-addresses.mjs']).toContain('SOL_RPC');
    expect(found.length).toBeGreaterThanOrEqual(5);
  });

  it('interpolates every endpoint variable only through redactRpcUrl', () => {
    const leaks = [];
    for (const { name, code } of opsScripts()) {
      const idents = new Set(endpointIdents(code));
      if (idents.size === 0) continue;
      for (const expr of interpolations(code)) {
        if (identTokens(expr).some((t) => idents.has(t)) && !/redactRpcUrl\s*\(/.test(expr)) {
          leaks.push(`${name}: \${${expr}}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it('interpolates a live connection.rpcEndpoint only through redactRpcUrl', () => {
    // The endpoint read back off an open Connection, which carries the key just as the
    // configured string does. tegridy-launch-operator.mjs used to strip `?…` off it by
    // hand, which covered Helius and left Alchemy's `/v2/<key>` fully printed.
    const leaks = [];
    for (const { name, code } of opsScripts()) {
      for (const expr of interpolations(code)) {
        if (/rpcEndpoint/.test(expr) && !/redactRpcUrl\s*\(/.test(expr)) leaks.push(`${name}: \${${expr}}`);
      }
    }
    expect(leaks).toEqual([]);
  });
});
