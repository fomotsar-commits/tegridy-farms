// The fee-line read exists to answer one question about real money: has the launcher's
// 15% ever been credited? The failure mode it must never have is the one this repo keeps
// reproducing — rendering a confident zero over a balance nobody managed to read.

import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import { readFeeLine, feeLineStatement, claimAuthorityStatement, EXPECTED_SINK_DESTINATIONS } from './feeLine';
import { LOCKER_CLAIMER_ADDRESS, REVENUE_DISTRIBUTOR_ADDRESS, TREASURY_ADDRESS } from '../../constants';
import { DOPPLER_MAINNET } from '../doppler.constants';

const NATIVE = '0x0000000000000000000000000000000000000000' as Address;
const TOKEN = '0x00000000000000000000000000000000000000Aa' as Address;
const ZERO_SINK = '0x0000000000000000000000000000000000000000' as Address;

/** A client whose reads are driven by a per-function script. */
function client(opts: {
  locker?: Address | (() => never);
  distributor?: Address;
  treasury?: Address;
  claims?: Record<string, bigint | 'throw'>;
  destinationsThrow?: boolean;
}) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readContract: async (args: any) => {
      const fn = args.functionName as string;
      if (fn === 'locker' || fn === 'revenueDistributor' || fn === 'treasury') {
        if (opts.destinationsThrow) throw new Error('rpc down');
        if (fn === 'locker') return opts.locker ?? DOPPLER_MAINNET.support.streamableFeesLocker;
        if (fn === 'revenueDistributor') return opts.distributor ?? REVENUE_DISTRIBUTOR_ADDRESS;
        return opts.treasury ?? TREASURY_ADDRESS;
      }
      if (fn === 'beneficiariesClaims') {
        const currency = (args.args[1] as string).toLowerCase();
        const v = opts.claims?.[currency];
        if (v === 'throw') throw new Error('rpc down');
        return v ?? 0n;
      }
      throw new Error(`unexpected read ${fn}`);
    },
  };
}

describe('destinations are read back from the deployed contract, not assumed', () => {
  it('reads locker / revenueDistributor / treasury off the sink', async () => {
    const r = await readFeeLine(client({}), [NATIVE]);
    expect(r.sink).toBe(LOCKER_CLAIMER_ADDRESS);
    expect(r.sinkConfigured).toBe(true);
    expect(r.destinations).toEqual({
      locker: DOPPLER_MAINNET.support.streamableFeesLocker,
      revenueDistributor: REVENUE_DISTRIBUTOR_ADDRESS,
      treasury: TREASURY_ADDRESS,
    });
    expect(r.pointsAtOurLocker).toBe(true);
  });

  it('the repo expectation matches what the deployed sink is documented to hold', () => {
    // Guards the constants used for the comparison, so a constants edit that silently
    // re-points the fee line is caught here rather than on-chain.
    expect(EXPECTED_SINK_DESTINATIONS.locker.toLowerCase()).toBe(
      DOPPLER_MAINNET.support.streamableFeesLocker.toLowerCase(),
    );
    expect(EXPECTED_SINK_DESTINATIONS.revenueDistributor).toBe(REVENUE_DISTRIBUTOR_ADDRESS);
    expect(EXPECTED_SINK_DESTINATIONS.treasury).toBe(TREASURY_ADDRESS);
  });

  it('flags a sink that points at a locker our launches never fund', async () => {
    const other = '0x00000000000000000000000000000000000000bb' as Address;
    const r = await readFeeLine(client({ locker: other }), [NATIVE]);
    expect(r.pointsAtOurLocker).toBe(false);
  });

  it('an unreadable destination set is reported as unreadable, not as absent', async () => {
    const r = await readFeeLine(client({ destinationsThrow: true }), [NATIVE]);
    expect(r.destinations).toBeNull();
    expect(r.destinationsUnreadable).toBe(true);
    expect(r.pointsAtOurLocker).toBeNull();
  });
});

describe('honesty guard — an unread balance never renders as zero', () => {
  it('a genuine all-zero read yields no credits and no unreadable entries', async () => {
    const r = await readFeeLine(client({}), [NATIVE, TOKEN]);
    expect(r.credits).toEqual([]);
    expect(r.unreadable).toEqual([]);
    expect(r.checkedCount).toBe(2);
    expect(feeLineStatement(r)).toMatch(/every one read back zero/i);
    // The sentence must also explain that zero is not "no fee owed".
    expect(feeLineStatement(r)).toMatch(/not that no fee is owed/i);
  });

  it('a failed balance read lands in `unreadable` and the statement refuses to say zero', async () => {
    const r = await readFeeLine(client({ claims: { [NATIVE]: 'throw', [TOKEN.toLowerCase()]: 'throw' } }), [
      NATIVE,
      TOKEN,
    ]);
    expect(r.credits).toEqual([]);
    expect(r.unreadable).toEqual([NATIVE, TOKEN]);
    const s = feeLineStatement(r);
    expect(s).toMatch(/could not read any/i);
    expect(s).toMatch(/unknown, not a zero/i);
    expect(s).not.toMatch(/read back zero/i);
  });

  it('a PARTIAL read is labelled incomplete rather than presented as a total', async () => {
    const r = await readFeeLine(
      client({ claims: { [NATIVE]: 5n, [TOKEN.toLowerCase()]: 'throw' } }),
      [NATIVE, TOKEN],
    );
    expect(r.credits).toEqual([{ currency: NATIVE, amount: 5n }]);
    expect(r.unreadable).toEqual([TOKEN]);
    expect(feeLineStatement(r)).toMatch(/incomplete/i);
  });

  it('an unconfigured sink says so instead of reading anything', async () => {
    const r = await readFeeLine(client({}), [NATIVE], ZERO_SINK);
    expect(r.sinkConfigured).toBe(false);
    expect(r.checkedCount).toBe(0);
    expect(r.destinations).toBeNull();
    expect(r.destinationsUnreadable).toBe(false); // nothing to read, not a failed read
    expect(feeLineStatement(r)).toMatch(/no protocol fee sink is configured/i);
  });

  it('checking nothing is not the same as finding nothing', async () => {
    const r = await readFeeLine(client({}), []);
    expect(r.checkedCount).toBe(0);
    expect(feeLineStatement(r)).toMatch(/checked 0 currencies/i);
  });
});

describe('the read side must not imply a spend path exists', () => {
  it('states that releasing is permissionless AND that this surface offers no claim', () => {
    const s = claimAuthorityStatement();
    expect(s).toMatch(/permissionless/i);
    expect(s).toMatch(/read-only/i);
    expect(s).toMatch(/no claim is offered/i);
  });

  it('the module exports no function that could originate a transaction', async () => {
    const mod = await import('./feeLine');
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== 'function') continue;
      // Anything that writes would need a wallet client; naming is the tripwire that
      // catches a future edit adding one to this deliberately read-only module.
      expect(name).not.toMatch(/claim(?!AuthorityStatement)|release|forward|sweep|withdraw|send/i);
    }
  });
});
