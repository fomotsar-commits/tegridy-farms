// The unverified liquidity claim must not reach the ON-CHAIN disclosures digest.
//
// `readMigrationStream` is inert against the V1 locker: it takes `_client`, touches no
// chain, and returns a hardcoded `locked: false`. `toLiquidityDisclosure` used to turn
// that into the sentence "Liquidity is not locked; it may be withdrawable by the
// liquidity owner." — and `attestation.canonicalDisclosuresJson` folds the whole
// `liquidity` object into `disclosuresDigest`, which is published on-chain and permanent.
//
// So this was not a wording problem. It was an unverified assertion being committed
// forever, about every token launched through this rail.

import { describe, it, expect } from 'vitest';
import { parseEther, type Address } from 'viem';
import { buildFactSheet, type RawTokenFacts } from './gate';
import { canonicalDisclosuresJson, disclosuresDigest } from './attestation';

const TOKEN = '0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca' as Address;

function raw(over: Partial<RawTokenFacts> = {}): RawTokenFacts {
  return {
    token: TOKEN,
    chainId: 1,
    name: 'Test Coin',
    symbol: 'TEST',
    totalSupply: parseEther('1000000'),
    owner: null,
    ownerRenounced: true,
    ownerIsTimelock: false,
    tokenFactory: null,
    templateCodehash: null,
    powers: {
      mint: false,
      pause: false,
      blacklist: false,
      feeOnTransfer: false,
      upgrade: false,
      balanceLimit: false,
    },
    liquidity: { locked: false, locker: null, unlockAt: null },
    feeConstitution: [],
    vesting: [],
    teamAllocationBps: 0,
    teamAllocationVestedBps: 0,
    observedAt: 1786104024,
    ...over,
  } as RawTokenFacts;
}

describe('an unread liquidity lock is never asserted, and never attested', () => {
  it('makes NO claim when the locker was not queried', () => {
    const sheet = buildFactSheet(raw({ liquidity: { locked: false, locker: null, unlockAt: null, readable: false } }));
    expect(sheet.liquidity.note).not.toMatch(/not locked/i);
    expect(sheet.liquidity.note).not.toMatch(/withdrawable/i);
    expect(sheet.liquidity.readable).toBe(false);
  });

  it('the unverified sentence is absent from the ON-CHAIN digest input', () => {
    // The assertion that actually matters: what gets hashed.
    const sheet = buildFactSheet(raw({ liquidity: { locked: false, locker: null, unlockAt: null, readable: false } }));
    const json = canonicalDisclosuresJson(sheet);
    expect(json).not.toMatch(/withdrawable by the liquidity owner/);
    expect(disclosuresDigest(sheet)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('still states a REAL unlocked lock when the locker WAS queried', () => {
    // The fix must not gag a genuine finding — "we read it and it is unlocked" is a fact
    // buyers need, and suppressing that would be the opposite failure.
    const sheet = buildFactSheet(raw({ liquidity: { locked: false, locker: null, unlockAt: null, readable: true } }));
    expect(sheet.liquidity.note).toMatch(/not locked/i);
  });

  it('still states a real LOCK when there is one', () => {
    const sheet = buildFactSheet(
      raw({ liquidity: { locked: true, locker: TOKEN, unlockAt: 1_900_000_000, readable: true } }),
    );
    expect(sheet.liquidity.note).toMatch(/Liquidity is locked/);
  });

  it('defaults to readable, so every existing producer is unaffected', () => {
    const sheet = buildFactSheet(raw());
    expect(sheet.liquidity.readable).toBe(true);
    expect(sheet.liquidity.note).toMatch(/not locked/i);
  });
});
