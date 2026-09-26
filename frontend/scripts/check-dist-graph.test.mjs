// @vitest-environment node
//
// NODE, not the project's jsdom default: this drives a build-time CLI as a
// child process, exactly as `npm run build` runs it.
//
// PINS FOR INVARIANT D OF check-dist-graph.mjs — WalletConnect's SignClient
// stays lazy in the BUILT graph (2026-09-25).
//
// WHY THIS FILE EXISTS. The Solana connect modal's WalletConnect row
// (src/lib/solanaWalletConnect.ts) loads @walletconnect/sign-client with a
// dynamic import(), so the Solana pages pay nothing for it until someone
// connects. Source tests can prove the import is written as import(); only
// the built graph can prove it STAYED lazy — the bundler is free to weld a
// module into a static chunk edge, and this repo has shipped exactly that
// class twice while dev, vitest and tsc were all green (the gate's own header
// has both). A gate that runs only against the real dist can only ever be
// seen passing, so its failing branches are proven here, on fixture dists the
// gate cannot tell from a real one: a static import, a missing marker, an
// eager edge from the entry, a modulepreload.
//
// THE MARKERS ARE READ FROM THE GATE, then pinned to what they stand for: the
// sign-client string must be in the installed sign-client's dist, and the
// adapter's must be in the adapter's own notice. A marker that drifted from
// either would make the gate fail every real build with "marker missing" —
// loudly, but only at build time. These fail first.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAIRING_REASONS } from '../src/lib/solanaWalletConnect.ts';

const GATE = fileURLToPath(new URL('./check-dist-graph.mjs', import.meta.url));
const GATE_SRC = readFileSync(GATE, 'utf8');

function markerFromGate(name) {
  const found = new RegExp(`const ${name} = '([^']+)';`).exec(GATE_SRC);
  if (!found) throw new Error(`check-dist-graph.mjs declares no ${name}`);
  return found[1];
}

const made = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

/**
 * A dist the gate cannot tell from a real one: an entry carrying the polyfill
 * markers and one static dependency (invariants A and B), a lazy Solana page
 * holding the adapter's marker, and a chunk holding sign-client's.
 */
function fixture({ adapterEdge = 'dynamic', adapterMarker = true, signClient = true, fromEntry = false, preload = false } = {}) {
  const SIGN = markerFromGate('SIGN_CLIENT_MARKER');
  const SOLANA = markerFromGate('SOLANA_WALLETCONNECT_MARKER');
  const dir = mkdtempSync(join(tmpdir(), 'dist-graph-'));
  made.push(dir);
  mkdirSync(join(dir, 'assets'));
  const chunk = (file, src) => writeFileSync(join(dir, 'assets', file), src);
  chunk(
    'index-e.js',
    'import"./vendor-react-r.js";globalThis.Buffer=1;globalThis.global=globalThis;' +
      (fromEntry ? 'import{S as c}from"./sign-client-c.js";' : '') +
      'const page=()=>import(`./SolanaPage-s.js`);export{page};',
  );
  chunk('vendor-react-r.js', 'export const r=1;');
  chunk(
    'SolanaPage-s.js',
    (adapterEdge === 'static'
      ? 'import{S as t}from"./sign-client-c.js";'
      : 'const load=()=>import(`./sign-client-c.js`);') +
      (adapterMarker ? `const reasons={startFailed:"WalletConnect didn't start. ${SOLANA}."};` : '') +
      'export{};',
  );
  if (signClient) chunk('sign-client-c.js', `console.info("${SIGN}");export const S=1;`);
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><head>' +
      '<script type="module" crossorigin src="/assets/index-e.js"></script>' +
      (preload ? '<link rel="modulepreload" crossorigin href="/assets/sign-client-c.js">' : '') +
      '</head><body></body></html>',
  );
  return dir;
}

const gate = (dir) => spawnSync(process.execPath, [GATE, dir], { encoding: 'utf8' });

describe('check-dist-graph invariant D: sign-client stays lazy', () => {
  it('a dynamic import() of sign-client passes, and the pass names the chunk it checked', () => {
    const run = gate(fixture());
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    // Exit 0 alone could be a gate that looked at nothing.
    expect(run.stdout).toContain('sign-client-c.js');
  });

  it("a STATIC import of sign-client from the adapter's chunk fails", () => {
    const run = gate(fixture({ adapterEdge: 'static' }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('sign-client-c.js');
    expect(run.stderr).toContain('SolanaPage-s.js');
  });

  it("the adapter's marker missing fails — the gate checked nothing", () => {
    const run = gate(fixture({ adapterMarker: false }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(markerFromGate('SOLANA_WALLETCONNECT_MARKER'));
  });

  it("sign-client's marker missing fails — the gate checked nothing", () => {
    const run = gate(fixture({ signClient: false }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(markerFromGate('SIGN_CLIENT_MARKER'));
  });

  it("sign-client in the ENTRY's static closure fails", () => {
    const run = gate(fixture({ fromEntry: true }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('sign-client-c.js');
  });

  it('index.html modulepreloading sign-client fails', () => {
    const run = gate(fixture({ preload: true }));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('sign-client-c.js');
  });
});

describe("the gate's markers stand for what they claim", () => {
  it("SIGN_CLIENT_MARKER is in the installed @walletconnect/sign-client's own dist", () => {
    const require = createRequire(import.meta.url);
    const dist = readFileSync(require.resolve('@walletconnect/sign-client').replace(/index\.cjs$/, 'index.js'), 'utf8');
    expect(dist).toContain(markerFromGate('SIGN_CLIENT_MARKER'));
  });

  it("SOLANA_WALLETCONNECT_MARKER is in the adapter's own start-failure notice", () => {
    expect(PAIRING_REASONS.startFailed).toContain(markerFromGate('SOLANA_WALLETCONNECT_MARKER'));
  });
});
