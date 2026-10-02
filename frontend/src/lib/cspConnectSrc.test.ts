// The MetaMask row (RainbowKit → wagmi metaMask() → @metamask/connect-evm) reaches hosts
// no other wallet does. On a phone it pairs with the MetaMask app over a relay websocket;
// once connected it sends the wallet's reads (eth_call, eth_estimateGas, receipts) to each
// chain's rpcUrls.default, never to our transports. A host the CSP omits kills the flow
// in production only. Hosts are read from the shipped SDK build, so a bump that moves
// one fails here.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { cspAllows } from '../test/csp';
import { WAGMI_CHAINS } from './chains/viemChains';

const require = createRequire(import.meta.url);

type Exports = { '.': { browser?: { import?: string }; import?: { default?: string } } };

/** The build a browser bundle takes from `pkg`, found through the package's own exports map. */
const shippedBuild = (pkg: string): string => {
  const manifest = require.resolve(`${pkg}/package.json`);
  const entry = (JSON.parse(readFileSync(manifest, 'utf-8')) as { exports: Exports }).exports['.'];
  const file = entry.browser?.import ?? entry.import?.default;
  expect(file, `${pkg} exports no browser/import build`).toBeTruthy();
  return readFileSync(join(dirname(manifest), file!), 'utf-8');
};

const urlLiterals = (source: string, scheme: string): string[] =>
  [...new Set(source.match(new RegExp(`${scheme}://[^"'\`\\s]+`, 'g')) ?? [])];

describe('vercel.json CSP connect-src: the MetaMask connector', () => {
  it('permits every websocket the MetaMask SDK can open (the mobile pairing relay)', () => {
    const sockets = urlLiterals(shippedBuild('@metamask/connect-multichain'), 'wss');
    expect(sockets.length, 'no wss:// URL found in the SDK build: find where it pairs now').toBeGreaterThan(0);
    for (const url of sockets) {
      expect(cspAllows('connect-src', url), `connect-src blocks ${url}: tapping MetaMask on a `
        + 'phone opens the app, and the page never hears it answer').toBe(true);
    }
  });

  it.each(WAGMI_CHAINS.map((chain) => [chain.name, chain] as const))(
    'permits the %s rpcUrls.default the SDK sends reads to',
    (_name, chain) => {
      expect(chain.rpcUrls.default.http.length).toBeGreaterThan(0);
      for (const url of chain.rpcUrls.default.http) {
        expect(cspAllows('connect-src', url), `connect-src blocks ${url}: with MetaMask connected, `
          + `every gas estimate and receipt read on ${chain.name} fails`).toBe(true);
      }
    },
  );

  // RainbowKit passes enableAnalytics:false, which connect-evm v2 ignores (it reads
  // analytics.enabled, and wagmi overwrites `analytics`). The CSP is what keeps it off.
  it('keeps MetaMask analytics blocked', () => {
    const endpoints = urlLiterals(shippedBuild('@metamask/analytics'), 'https')
      .filter((url) => /analytics/.test(new URL(url).hostname));
    expect(endpoints.length, 'no analytics endpoint found in @metamask/analytics').toBeGreaterThan(0);
    for (const url of endpoints) expect(cspAllows('connect-src', url), `connect-src permits ${url}`).toBe(false);
  });
});
