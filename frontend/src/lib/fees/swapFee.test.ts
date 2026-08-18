// The fee policy's acceptance list.
//
// Three properties carry the money and are pinned hardest:
//   1. OFF is the default, and it takes TWO deliberate settings to leave it. A rate
//      alone is not a fee we can collect; a recipient alone is not a fee at all.
//   2. A nonsense override never becomes a charge. The heat gate's rule ("ignore, do
//      not obey") applies with the sign flipped: there, a bad value could open a door;
//      here it could open a wallet.
//   3. A provider whose leg is withheld stays withheld even with the fee enabled — the
//      whole point of the table is that "we have a rate" and "this provider was sent a
//      rate" are separate facts.

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

const RECIPIENT = '0x6d5791A660e79175F74C6D639584C98422d5956E';
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
    expect(swapFeePolicy()).toEqual({ enabled: false, bps: 0, recipient: null });
  });

  it('is disabled with a rate but no recipient — never falls back to a known address', () => {
    vi.stubEnv('VITE_SWAP_FEE_BPS', '25');
    const p = swapFeePolicy();
    expect(p.enabled).toBe(false);
    expect(p.recipient).toBeNull();
    expect(p.bps).toBe(0);
  });

  it('is disabled with a recipient but no rate', () => {
    vi.stubEnv('VITE_SWAP_FEE_RECIPIENT', RECIPIENT);
    expect(swapFeePolicy().enabled).toBe(false);
  });

  it('enables only when both dials are set', () => {
    enableFee('25');
    expect(swapFeePolicy()).toEqual({ enabled: true, bps: 25, recipient: RECIPIENT });
  });
});

describe('a nonsense override is ignored, never obeyed', () => {
  it.each(['abc', '', '   ', 'NaN', 'Infinity', '-25', '0', '12.5', 'null', '25bps'])(
    'VITE_SWAP_FEE_BPS=%j leaves the fee off',
    (raw) => {
      enableFee(raw);
      expect(swapFeePolicy()).toEqual({ enabled: false, bps: 0, recipient: null });
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
    expect(swapFeePolicy().enabled).toBe(false);
  });

  it('tolerates surrounding whitespace on both dials', () => {
    enableFee('  25  ', `  ${RECIPIENT}  `);
    expect(swapFeePolicy()).toEqual({ enabled: true, bps: 25, recipient: RECIPIENT });
  });
});

describe('the ceiling is enforced, not merely documented', () => {
  it('clamps an over-max rate down to the ceiling', () => {
    enableFee('5000');
    expect(swapFeePolicy().bps).toBe(MAX_SWAP_FEE_BPS);
  });

  it('accepts the ceiling exactly', () => {
    enableFee(String(MAX_SWAP_FEE_BPS));
    expect(swapFeePolicy().bps).toBe(MAX_SWAP_FEE_BPS);
  });

  it('leaves an in-range rate untouched', () => {
    enableFee('25');
    expect(swapFeePolicy().bps).toBe(25);
  });

  it('the ceiling is well below the point where a fee eats a trade', () => {
    expect(MAX_SWAP_FEE_BPS).toBeLessThanOrEqual(100);
  });
});

describe('provider legs', () => {
  it('attaches nothing to any provider while the fee is off', () => {
    for (const source of ALL_SOURCES) {
      expect(providerFeeAttachment(source), source).toBeNull();
    }
  });

  it('attaches ParaSwap’s recipient and bps once enabled', () => {
    enableFee('25');
    expect(providerFeeAttachment('paraswap')).toEqual({
      bps: 25,
      recipient: RECIPIENT,
      params: { partnerAddress: RECIPIENT, partnerFeeBps: '25' },
    });
  });

  it('withholds every blocked provider even with the fee enabled', () => {
    enableFee('25');
    for (const { source } of blockedFeeLegs()) {
      expect(providerFeeAttachment(source), source).toBeNull();
    }
  });

  it('the attached bps equals the policy bps — one number, one source', () => {
    enableFee('5000');
    const policy = swapFeePolicy();
    const leg = providerFeeAttachment('paraswap');
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
      const attachment = providerFeeAttachment(source);
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
      const emitted = Object.keys(providerFeeAttachment(source)!.params).sort();
      expect([...(PROXY_ALLOWLIST_ADDITIONS[source] ?? [])].sort(), source).toEqual(emitted);
    }
  });
});
