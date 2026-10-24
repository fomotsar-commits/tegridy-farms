// The fee policy's acceptance list. Four properties carry the money:
//   1. OFF by default, and it takes TWO deliberate settings to leave it.
//   2. A nonsense override is ignored, never obeyed.
//   3. A withheld provider leg stays withheld with the fee enabled.
//   4. The recipient is bound to the chain: only the venue's own Safe ON THAT CHAIN is
//      accepted, because a Safe on another chain is an address nobody controls here.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  swapFeePolicy,
  providerFeeAttachment,
  blockedFeeLegs,
  PROVIDER_FEE_LEGS,
  PROXY_ALLOWLIST_ADDITIONS,
  MAX_SWAP_FEE_BPS,
} from './swapFee';
import type { AggregatorSource } from '../aggregator';

const MAINNET = 1;
// The mainnet treasury Safe: the only recipient chain 1 accepts (see the chain-binding suite).
const RECIPIENT = '0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d';
const ALL_SOURCES: AggregatorSource[] = [
  'swapapi', 'odos', 'cowswap', 'lifi', 'kyberswap', 'openocean', 'paraswap',
];

function enableFee(bps: string, recipient: string = RECIPIENT) {
  vi.stubEnv('VITE_SWAP_FEE_BPS', bps);
  vi.stubEnv('VITE_SWAP_FEE_RECIPIENT', recipient);
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe('the fee is off until an operator turns it on', () => {
  it('is disabled with nothing configured', () => {
    expect(swapFeePolicy(MAINNET)).toEqual({ enabled: false, bps: 0, recipient: null });
  });

  it('is disabled with a rate but no recipient — never falls back to a known address', () => {
    vi.stubEnv('VITE_SWAP_FEE_BPS', '25');
    const p = swapFeePolicy(MAINNET);
    expect(p.enabled).toBe(false);
    expect(p.recipient).toBeNull();
    expect(p.bps).toBe(0);
  });

  it('is disabled with a recipient but no rate', () => {
    vi.stubEnv('VITE_SWAP_FEE_RECIPIENT', RECIPIENT);
    expect(swapFeePolicy(MAINNET).enabled).toBe(false);
  });

  it('enables only when both dials are set', () => {
    enableFee('25');
    expect(swapFeePolicy(MAINNET)).toEqual({ enabled: true, bps: 25, recipient: RECIPIENT });
  });
});

describe('the recipient is bound to the chain the fee is collected on', () => {
  // Production shipped VITE_SWAP_FEE_RECIPIENT = the BASE treasury Safe (2026-09-25).
  // It has no code on Ethereum, so a partner fee credited to it there is claimable by
  // nobody until someone deploys that Safe on mainnet.
  const BASE = 8453;
  const BASE_TREASURY = '0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0';
  const MAINNET_SWAP_FEE_ROUTER = '0x6d5791A660e79175F74C6D639584C98422d5956E';

  it('refuses the Base treasury Safe as the recipient of a mainnet fee', () => {
    enableFee('25', BASE_TREASURY);
    expect(swapFeePolicy(MAINNET)).toEqual({ enabled: false, bps: 0, recipient: null });
    expect(providerFeeAttachment('paraswap', MAINNET)).toBeNull();
  });

  it('accepts the mainnet treasury Safe on mainnet', () => {
    enableFee('25', RECIPIENT);
    expect(providerFeeAttachment('paraswap', MAINNET)?.params.partnerAddress).toBe(RECIPIENT);
  });

  it('is per chain, not mainnet-only: each Safe is accepted on its own chain alone', () => {
    enableFee('25', BASE_TREASURY);
    expect(swapFeePolicy(BASE)).toEqual({ enabled: true, bps: 25, recipient: BASE_TREASURY });
    enableFee('25', RECIPIENT);
    expect(swapFeePolicy(BASE).enabled).toBe(false);
  });

  it('refuses a venue contract that is not the Safe on that chain, since it could not claim a vault credit', () => {
    enableFee('25', MAINNET_SWAP_FEE_ROUTER);
    expect(swapFeePolicy(MAINNET).enabled).toBe(false);
  });

  it('refuses every recipient on a chain the venue does not serve', () => {
    enableFee('25', RECIPIENT);
    expect(swapFeePolicy(10).enabled).toBe(false);
  });

  it('matches the address case-insensitively and returns the registry checksum', () => {
    enableFee('25', RECIPIENT.toLowerCase());
    expect(swapFeePolicy(MAINNET).recipient).toBe(RECIPIENT);
  });
});

describe('a nonsense override is ignored, never obeyed', () => {
  it.each(['abc', '', '   ', 'NaN', 'Infinity', '-25', '0', '12.5', 'null', '25bps'])(
    'VITE_SWAP_FEE_BPS=%j leaves the fee off',
    (raw) => {
      enableFee(raw);
      expect(swapFeePolicy(MAINNET)).toEqual({ enabled: false, bps: 0, recipient: null });
    },
  );

  it.each([
    'treasury.eth',
    '0x6d5791A6',
    '0x6d5791A660e79175F74C6D639584C98422d5956',
    '6d5791A660e79175F74C6D639584C98422d5956E',
    '0xZZZZ791A660e79175F74C6D639584C98422d5956',
    '0x0000000000000000000000000000000000000000',
  ])('VITE_SWAP_FEE_RECIPIENT=%j leaves the fee off', (raw) => {
    enableFee('25', raw);
    expect(swapFeePolicy(MAINNET).enabled).toBe(false);
  });

  it('tolerates surrounding whitespace on both dials', () => {
    enableFee('  25  ', `  ${RECIPIENT}  `);
    expect(swapFeePolicy(MAINNET)).toEqual({ enabled: true, bps: 25, recipient: RECIPIENT });
  });
});

describe('the ceiling is enforced, not merely documented', () => {
  it('clamps an over-max rate down to the ceiling', () => {
    enableFee('5000');
    expect(swapFeePolicy(MAINNET).bps).toBe(MAX_SWAP_FEE_BPS);
  });

  it('accepts the ceiling exactly', () => {
    enableFee(String(MAX_SWAP_FEE_BPS));
    expect(swapFeePolicy(MAINNET).bps).toBe(MAX_SWAP_FEE_BPS);
  });

  it('leaves an in-range rate untouched', () => {
    enableFee('25');
    expect(swapFeePolicy(MAINNET).bps).toBe(25);
  });

  it('the ceiling is well below the point where a fee eats a trade', () => {
    expect(MAX_SWAP_FEE_BPS).toBeLessThanOrEqual(100);
  });
});

describe('provider legs', () => {
  it('attaches nothing to any provider while the fee is off', () => {
    for (const source of ALL_SOURCES) {
      expect(providerFeeAttachment(source, MAINNET), source).toBeNull();
    }
  });

  it('attaches ParaSwap’s recipient and bps once enabled', () => {
    enableFee('25');
    expect(providerFeeAttachment('paraswap', MAINNET)).toEqual({
      bps: 25,
      recipient: RECIPIENT,
      params: { partnerAddress: RECIPIENT, partnerFeeBps: '25' },
    });
  });

  it('withholds every blocked provider even with the fee enabled', () => {
    enableFee('25');
    for (const { source } of blockedFeeLegs()) {
      expect(providerFeeAttachment(source, MAINNET), source).toBeNull();
    }
  });

  it('the attached bps equals the policy bps — one number, one source', () => {
    enableFee('5000');
    const policy = swapFeePolicy(MAINNET);
    const leg = providerFeeAttachment('paraswap', MAINNET);
    expect(leg!.bps).toBe(policy.bps);
    expect(leg!.params.partnerFeeBps).toBe(String(policy.bps));
  });
});

describe('honesty: the table discloses its own limits', () => {
  it('names a leg for every aggregator the meta-router queries', () => {
    for (const source of ALL_SOURCES) {
      expect(PROVIDER_FEE_LEGS[source], source).toBeDefined();
    }
  });

  it('every withheld leg says what must be confirmed and names the parameters it would use', () => {
    const blocked = blockedFeeLegs();
    expect(blocked.length).toBeGreaterThan(0);
    for (const { source, params, mustConfirm } of blocked) {
      expect(params.length, source).toBeGreaterThan(0);
      expect(mustConfirm.length, source).toBeGreaterThan(20);
    }
  });

  it('no ready leg sends a rate without also naming the recipient in the request', () => {
    enableFee('25');
    for (const source of ALL_SOURCES) {
      const leg = PROVIDER_FEE_LEGS[source];
      if (leg.status !== 'ready') continue;
      const attachment = providerFeeAttachment(source, MAINNET);
      expect(Object.values(attachment!.params), source).toContain(RECIPIENT);
    }
  });

  it('the proxy-allowlist checklist matches exactly what the ready legs emit', () => {
    enableFee('25');
    for (const source of ALL_SOURCES) {
      const leg = PROVIDER_FEE_LEGS[source];
      if (leg.status !== 'ready') {
        expect(PROXY_ALLOWLIST_ADDITIONS[source], source).toBeUndefined();
        continue;
      }
      const emitted = Object.keys(providerFeeAttachment(source, MAINNET)!.params).sort();
      expect([...(PROXY_ALLOWLIST_ADDITIONS[source] ?? [])].sort(), source).toEqual(emitted);
    }
  });
});
