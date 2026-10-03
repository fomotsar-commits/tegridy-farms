// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLATFORM_TREASURY_VAULT } from '../../launcher/solana/curve/program';
import { CP_CREATE_POOL_FEE_RECEIVER } from '../../launcher/solana/write/config';
import { COMPARABLE_PLATFORM_FEE_BPS } from '../../jupiter';
import { SOL_MINT, USDC_MINT } from '../../solana';
import { SITE_SWAP_FEE_BPS, siteFee, siteFeeAgrees } from './siteFee';
import { SITE_FEE_WSOL_ACCOUNT } from './siteFeeAccount';

// The site's swap fee on a trade through our own pool (SPEC_S3 D2, D3; T-FEE-01..07).
// No address is typed here: every one comes from a committed constant.

const VAULT = PLATFORM_TREASURY_VAULT.toBase58();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('../cpswap/program');
  vi.doUnmock('../../launcher/solana/lpWriteFlag');
  vi.resetModules();
});

describe('T-FEE-01: the fee account is derived, and it is the account the other two fee flows use', () => {
  it('equals the pool program’s opening-fee receiver', () => {
    expect(SITE_FEE_WSOL_ACCOUNT.equals(CP_CREATE_POOL_FEE_RECEIVER)).toBe(true);
  });

  it('equals where Jupiter’s SOL-side platform fee lands when the build’s fee account is the vault', async () => {
    vi.stubEnv('VITE_SOLANA_FEE_ACCOUNT', VAULT);
    vi.resetModules();
    const { feeAccountFor } = await import('../../jupiter');
    expect(feeAccountFor(SOL_MINT)).toBe(SITE_FEE_WSOL_ACCOUNT.toBase58());
    // The vault's USDC account is a different one: a fee in USDC never lands here.
    expect(feeAccountFor(USDC_MINT)).not.toBe(SITE_FEE_WSOL_ACCOUNT.toBase58());
  });
});

describe('T-FEE-02: siteFee is floor(x * 50 / 10000)', () => {
  it('the committed rate is 0.5%, the rate jupiterNet compares at', () => {
    expect(SITE_SWAP_FEE_BPS).toBe(50n);
    expect(SITE_SWAP_FEE_BPS).toBe(BigInt(COMPARABLE_PLATFORM_FEE_BPS));
  });

  it.each([
    [0n, 0n],
    [199n, 0n],
    [200n, 1n],
    [399n, 1n],
    [100_000_199n, 500_000n],
    [1_000_000_000n, 5_000_000n],
    [834_885_819n, 4_174_429n],
    [(1n << 64n) - 1n, 92_233_720_368_547_758n],
  ])('siteFee(%s) = %s', (x, fee) => {
    expect(siteFee(x)).toBe(fee);
  });

  it('a negative amount throws: it never returns a "fee" that would pay the trader', () => {
    expect(() => siteFee(-1n)).toThrow(RangeError);
    expect(() => siteFee(-200n)).toThrow(RangeError);
  });
});

describe('T-FEE-03..06: the build’s fee env must AGREE with the committed fee', () => {
  it('the vault at exactly 50 bps agrees', () => {
    expect(siteFeeAgrees({ account: VAULT, bps: 50 })).toEqual({ ok: true });
  });

  it('T-FEE-03: no fee account configured', () => {
    expect(siteFeeAgrees({ account: '', bps: 50 })).toEqual({ ok: false, why: 'no-fee-account' });
  });

  it('T-FEE-04: another valid key, even one of ours, is not the vault', () => {
    expect(siteFeeAgrees({ account: SITE_FEE_WSOL_ACCOUNT.toBase58(), bps: 50 })).toEqual({ ok: false, why: 'other-fee-account' });
    expect(siteFeeAgrees({ account: SOL_MINT, bps: 50 })).toEqual({ ok: false, why: 'other-fee-account' });
  });

  it('T-FEE-05: a string that is not a key, or the vault with anything around it', () => {
    for (const account of ['not-a-key', `${VAULT} `, ` ${VAULT}`, VAULT.toLowerCase(), VAULT.slice(0, -1), `${VAULT}x`]) {
      expect(siteFeeAgrees({ account, bps: 50 })).toEqual({ ok: false, why: 'other-fee-account' });
    }
  });

  it('T-FEE-06: any rate but exactly 50 (49, 51, and the 100 that lib/solana.ts falls back to)', () => {
    for (const bps of [49, 51, 100, 0, 50.5, 5000, Number.NaN]) {
      expect(siteFeeAgrees({ account: VAULT, bps })).toEqual({ ok: false, why: 'other-rate' });
    }
  });

  it('the account is judged before the rate, so a wrong account is never reported as a wrong rate', () => {
    expect(siteFeeAgrees({ account: '', bps: 100 })).toEqual({ ok: false, why: 'no-fee-account' });
    expect(siteFeeAgrees({ account: SOL_MINT, bps: 100 })).toEqual({ ok: false, why: 'other-fee-account' });
  });

  it('the default reads this build’s env: unset is no-fee-account; the vault with no rate set is other-rate (the 100 fallback)', async () => {
    vi.stubEnv('VITE_SOLANA_FEE_ACCOUNT', '');
    vi.stubEnv('VITE_SOLANA_PLATFORM_FEE_BPS', '50');
    vi.resetModules();
    expect((await import('./siteFee')).siteFeeAgrees()).toEqual({ ok: false, why: 'no-fee-account' });

    vi.stubEnv('VITE_SOLANA_FEE_ACCOUNT', VAULT);
    vi.stubEnv('VITE_SOLANA_PLATFORM_FEE_BPS', '');
    vi.resetModules();
    expect((await import('./siteFee')).siteFeeAgrees()).toEqual({ ok: false, why: 'other-rate' });

    vi.stubEnv('VITE_SOLANA_PLATFORM_FEE_BPS', '50');
    vi.resetModules();
    expect((await import('./siteFee')).siteFeeAgrees()).toEqual({ ok: true });
  });
});

// The three parts of "comparable", and the switch on top of them. Each part is turned
// off alone, with the other two on, so no part can hide behind another.
describe('T-FEE-07: comparable needs a program id, LP fully on and the fee env; offered needs the switch too', () => {
  const E2E_ON = { DEV: false, MODE: 'solana-e2e', VITE_SOLANA_CURVE_WRITES: '1' };
  const PROD = { DEV: false, PROD: true, MODE: 'production' };

  async function load(o: { programId?: boolean; lpMode?: 'on' | 'withdraw-only' | 'off'; account?: string; bps?: string } = {}) {
    vi.stubEnv('VITE_SOLANA_FEE_ACCOUNT', o.account ?? VAULT);
    vi.stubEnv('VITE_SOLANA_PLATFORM_FEE_BPS', o.bps ?? '50');
    vi.resetModules();
    vi.doMock('../cpswap/program', async (orig) => ({
      ...(await orig<typeof import('../cpswap/program')>()),
      hasProgramId: () => o.programId ?? true,
    }));
    vi.doMock('../../launcher/solana/lpWriteFlag', async (orig) => ({
      ...(await orig<typeof import('../../launcher/solana/lpWriteFlag')>()),
      lpWriteMode: () => o.lpMode ?? 'on',
    }));
    return import('./siteFee');
  }

  it('all three true: comparable. With the switch off (production) it is not offered: shadow mode', async () => {
    const m = await load();
    expect(m.ownPoolRouteComparable(PROD)).toBe(true);
    expect(m.ownPoolRouteOffered(PROD)).toBe(false);
    // A production build cannot be talked into it by the env flag.
    expect(m.ownPoolRouteOffered({ ...PROD, VITE_SOLANA_CURVE_WRITES: '1' })).toBe(false);
  });

  it('all three true and the switch on (the e2e build raises it): offered', async () => {
    const m = await load();
    expect(m.ownPoolRouteComparable(E2E_ON)).toBe(true);
    expect(m.ownPoolRouteOffered(E2E_ON)).toBe(true);
  });

  it('no pool program id: neither', async () => {
    const m = await load({ programId: false });
    expect(m.ownPoolRouteComparable(E2E_ON)).toBe(false);
    expect(m.ownPoolRouteOffered(E2E_ON)).toBe(false);
  });

  it.each(['withdraw-only', 'off'] as const)('LP mode %s: neither (the emergency state turns the route off)', async (lpMode) => {
    const m = await load({ lpMode });
    expect(m.ownPoolRouteComparable(E2E_ON)).toBe(false);
    expect(m.ownPoolRouteOffered(E2E_ON)).toBe(false);
  });

  it.each([
    ['no fee account', { account: '' }],
    ['another fee account', { account: SOL_MINT }],
    ['another rate', { bps: '100' }],
    ['no rate set (falls back to 100)', { bps: '' }],
  ])('the fee env disagrees (%s): neither', async (_name, o) => {
    const m = await load(o);
    expect(m.ownPoolRouteComparable(E2E_ON)).toBe(false);
    expect(m.ownPoolRouteOffered(E2E_ON)).toBe(false);
  });

  it('this repo as committed: LP is on, the route’s switch is off, so nothing is offered in production', async () => {
    vi.stubEnv('VITE_SOLANA_FEE_ACCOUNT', VAULT);
    vi.stubEnv('VITE_SOLANA_PLATFORM_FEE_BPS', '50');
    vi.resetModules();
    const m = await import('./siteFee');
    expect(m.ownPoolRouteOffered(PROD)).toBe(false);
  });
});
