import { describe, it, expect, vi } from 'vitest';
import type { Address } from 'viem';
import {
  AIRLOCK_FEES_ABI,
  NATIVE_CURRENCY,
  readClaimableFees,
  collectIntegratorFees,
  migrateAsset,
  canMigrate,
} from './integratorFees';
import { DOPPLER_MAINNET } from './doppler.constants';

const TOWELI = '0x420698cfdeddea6bc78d59bc17798113ad278f9d' as Address;
const TREASURY = '0x00000000000000000000000000000000000000t1'.replace('t1', 'a1') as Address;
const ASSET = '0x00000000000000000000000000000000000000aa' as Address;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pub(results: any[], opts: { throws?: boolean } = {}): any {
  return {
    multicall: vi.fn(async () => {
      if (opts.throws) throw new Error('rpc down');
      return results;
    }),
    simulateContract: vi.fn(async (args: unknown) => {
      if (opts.throws) throw new Error('execution reverted');
      return { request: { ...(args as object), __simulated: true } };
    }),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wallet(account: unknown = { address: TREASURY }): any {
  return { account, writeContract: vi.fn(async () => '0xhash' as const) };
}

describe('AIRLOCK_FEES_ABI — pinned to the SDK-verified shapes', () => {
  it('declares the three functions with the argument orders Airlock expects', () => {
    const byName = Object.fromEntries(AIRLOCK_FEES_ABI.map((f) => [f.name, f]));
    expect(byName.integratorFees?.inputs.map((i) => i.type)).toEqual(['address', 'address']);
    expect(byName.collectIntegratorFees?.inputs.map((i) => i.name)).toEqual(['to', 'token', 'amount']);
    expect(byName.migrate?.inputs.map((i) => i.type)).toEqual(['address']);
  });
});

describe('readClaimableFees', () => {
  it('returns only non-zero balances, keyed by currency', async () => {
    const c = pub([
      { status: 'success', result: 0n },
      { status: 'success', result: 5n },
    ]);
    await expect(readClaimableFees(c, [NATIVE_CURRENCY, TOWELI])).resolves.toEqual([
      { currency: TOWELI, amount: 5n },
    ]);
  });

  it('supports the zero address as a real currency (native ETH), not as "unset"', async () => {
    const c = pub([{ status: 'success', result: 7n }]);
    await expect(readClaimableFees(c, [NATIVE_CURRENCY])).resolves.toEqual([
      { currency: NATIVE_CURRENCY, amount: 7n },
    ]);
  });

  // "Could not read" and "there is nothing here" are different claims, and only one of
  // them is safe to render beside a withdraw button.
  it('OMITS a failed read rather than reporting it as a zero balance', async () => {
    const c = pub([
      { status: 'failure', error: new Error('reverted') },
      { status: 'success', result: 3n },
    ]);
    const out = await readClaimableFees(c, [NATIVE_CURRENCY, TOWELI]);
    expect(out).toEqual([{ currency: TOWELI, amount: 3n }]);
    expect(out.some((f) => f.currency === NATIVE_CURRENCY)).toBe(false);
  });

  it('degrades to empty on transport failure and never throws', async () => {
    await expect(readClaimableFees(pub([], { throws: true }), [TOWELI])).resolves.toEqual([]);
  });

  it('short-circuits an empty currency list without an RPC call', async () => {
    const c = pub([]);
    await expect(readClaimableFees(c, [])).resolves.toEqual([]);
    expect(c.multicall).not.toHaveBeenCalled();
  });
});

describe('collectIntegratorFees', () => {
  it('simulates against the Airlock before asking for a signature', async () => {
    const p = pub([]);
    const w = wallet();
    await collectIntegratorFees(p, w, { to: TREASURY, currency: TOWELI, amount: 10n });
    expect(p.simulateContract).toHaveBeenCalledTimes(1);
    const args = p.simulateContract.mock.calls[0][0];
    expect(args.address).toBe(DOPPLER_MAINNET.airlock);
    expect(args.functionName).toBe('collectIntegratorFees');
    expect(args.args).toEqual([TREASURY, TOWELI, 10n]);
    // The signature request must be the SIMULATED request, not a re-built one.
    expect(w.writeContract).toHaveBeenCalledWith(expect.objectContaining({ __simulated: true }));
  });

  it('refuses a zero/negative amount before touching the chain', async () => {
    const p = pub([]);
    await expect(collectIntegratorFees(p, wallet(), { to: TREASURY, currency: TOWELI, amount: 0n }))
      .rejects.toThrow(/nothing to collect/i);
    expect(p.simulateContract).not.toHaveBeenCalled();
  });

  it('refuses without a connected account', async () => {
    await expect(collectIntegratorFees(pub([]), wallet(null), { to: TREASURY, currency: TOWELI, amount: 1n }))
      .rejects.toThrow(/no account/i);
  });

  it('propagates a failed simulation instead of prompting a doomed signature', async () => {
    const w = wallet();
    await expect(collectIntegratorFees(pub([], { throws: true }), w, { to: TREASURY, currency: TOWELI, amount: 1n }))
      .rejects.toThrow();
    expect(w.writeContract).not.toHaveBeenCalled();
  });
});

describe('migrateAsset / canMigrate', () => {
  it('migrate simulates then writes', async () => {
    const p = pub([]);
    const w = wallet();
    await expect(migrateAsset(p, w, ASSET)).resolves.toBe('0xhash');
    expect(p.simulateContract.mock.calls[0][0].functionName).toBe('migrate');
    expect(p.simulateContract.mock.calls[0][0].args).toEqual([ASSET]);
  });

  it('canMigrate reports readiness from the simulation, never throwing', async () => {
    await expect(canMigrate(pub([]), ASSET, TREASURY)).resolves.toBe(true);
    await expect(canMigrate(pub([], { throws: true }), ASSET, TREASURY)).resolves.toBe(false);
  });
});
