// @vitest-environment node
//
// The range-pool deploy pack (solana/clmm-deploy) asks only Solana's public RPCs, GitHub and the
// website, over https, or this machine during a rehearsal: scripts/lib/hosts.mjs refuses the rest
// before a byte is sent.

import { describe, it, expect } from 'vitest';
import {
  allowedUrl,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plain .mjs pack module, deliberately untyped and outside src/
} from '../../../solana/clmm-deploy/scripts/lib/hosts.mjs';

describe('the deploy pack\'s hosts', () => {
  it('lets through the RPCs, GitHub and the website, over https', () => {
    for (const u of [
      'https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com', 'https://api.devnet.solana.com',
      'https://api.github.com/repos/fomotsar-commits/tegridy-farms/commits/mvp-launch',
      'https://raw.githubusercontent.com/fomotsar-commits/tegridy-farms/abc/CHANGELOG.md',
      'https://memetics.finance/position/11111111111111111111111111111111.json',
    ]) expect(() => allowedUrl(u)).not.toThrow();
  });

  it('refuses any other host, plain http, a port, credentials, or a look-alike', () => {
    for (const u of [
      'https://example.com/', 'http://api.mainnet-beta.solana.com', 'https://api.mainnet-beta.solana.com:8899',
      'https://user:pass@api.github.com/', 'https://memetics.finance.evil.example/', 'https://evilmemetics.finance/',
      'http://127.0.0.1:8899',
    ]) expect(() => allowedUrl(u)).toThrow(/is not a host this pack may ask/);
  });

  it('lets a rehearsal ask this machine, and only this machine, over http', () => {
    expect(() => allowedUrl('http://127.0.0.1:18899', { loopback: true })).not.toThrow();
    expect(() => allowedUrl('http://localhost:5499/x', { loopback: true })).not.toThrow();
    expect(() => allowedUrl('http://10.0.0.5:8899', { loopback: true })).toThrow();
  });
});
