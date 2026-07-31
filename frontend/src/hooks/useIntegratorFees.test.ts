// The hook that turns the Airlock fee module into something a screen can render.
//
// The assertions worth having here are all about HONESTY of the empty state, because
// that is the failure this whole area keeps producing: a read that silently fails and
// then renders as a confident zero. "Nothing to claim" must be reachable only when every
// currency actually read back zero.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { Address } from 'viem';

const NATIVE = '0x0000000000000000000000000000000000000000' as Address;
const TOWELI = '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D' as Address;
const ASSET = '0x00000000000000000000000000000000000000aa' as Address;

const multicall = vi.fn();
const publicClient = { multicall };

vi.mock('wagmi', () => ({
  usePublicClient: () => publicClient,
}));

const readClaimableFees = vi.fn();
vi.mock('../lib/launcher/integratorFees', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/launcher/integratorFees')>();
  return { ...actual, readClaimableFees: (...a: unknown[]) => readClaimableFees(...a) };
});

const readOurLaunches = vi.fn();
vi.mock('../lib/launcher/ourLaunches', () => ({
  readOurLaunches: (...a: unknown[]) => readOurLaunches(...a),
}));

import { useIntegratorFees } from './useIntegratorFees';

/** The currency list the hook assembled, as lowercase strings. */
function queriedCurrencies(): string[] {
  const call = readClaimableFees.mock.calls.at(-1);
  return ((call?.[1] ?? []) as Address[]).map((c) => c.toLowerCase());
}

describe('useIntegratorFees', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readOurLaunches.mockResolvedValue({ baselines: [], poolByToken: {}, complete: true });
    readClaimableFees.mockResolvedValue({ fees: [], unreadable: [] });
    multicall.mockResolvedValue([]);
  });

  it('queries the launch ASSETS as well as the numeraires', async () => {
    // Airlock fees accrue in the numeraire AND in the launched asset. Checking only
    // numeraires would under-report revenue.
    readOurLaunches.mockResolvedValue({ baselines: [{ token: ASSET }], poolByToken: {}, complete: true });
    const { result } = renderHook(() => useIntegratorFees(true));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(queriedCurrencies()).toContain(ASSET.toLowerCase());
    expect(queriedCurrencies()).toContain(NATIVE.toLowerCase());
  });

  it('de-dupes a launch asset that is also a numeraire, so no balance is double-counted', async () => {
    readOurLaunches.mockResolvedValue({ baselines: [{ token: TOWELI }], poolByToken: {}, complete: true });
    const { result } = renderHook(() => useIntegratorFees(true));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const toweli = queriedCurrencies().filter((c) => c === TOWELI.toLowerCase());
    expect(toweli).toHaveLength(1);
  });

  it('reports unreadable balances instead of implying they are zero', async () => {
    readClaimableFees.mockResolvedValue({ fees: [], unreadable: [NATIVE, TOWELI] });
    const { result } = renderHook(() => useIntegratorFees(true));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.fees).toEqual([]);
    // An empty `fees` with a non-empty `unreadable` is NOT "nothing to claim".
    expect(result.current.unreadable).toEqual([NATIVE, TOWELI]);
  });

  it('a genuine all-zero read leaves `unreadable` empty', async () => {
    const { result } = renderHook(() => useIntegratorFees(true));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.fees).toEqual([]);
    expect(result.current.unreadable).toEqual([]);
    expect(result.current.checkedCount).toBeGreaterThan(0);
  });

  // NOT `mockRejectedValue`. readOurLaunches never throws — an earlier version of this
  // test mocked a throw, which passed while the production flag stayed permanently false
  // because the real function degrades to an incomplete result instead.
  it('flags assetsUnavailable from an INCOMPLETE scan, and still reads numeraires', async () => {
    readOurLaunches.mockResolvedValue({ baselines: [], poolByToken: {}, complete: false });
    const { result } = renderHook(() => useIntegratorFees(true));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.assetsUnavailable).toBe(true);
    // Degraded, not dead: the base pairs were still checked.
    expect(queriedCurrencies()).toContain(NATIVE.toLowerCase());
  });

  it('decorates native ETH without an on-chain metadata read', async () => {
    readClaimableFees.mockResolvedValue({ fees: [{ currency: NATIVE, amount: 5n }], unreadable: [] });
    const { result } = renderHook(() => useIntegratorFees(true));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.fees[0]).toMatchObject({ symbol: 'ETH', decimals: 18, amount: 5n });
    expect(multicall).not.toHaveBeenCalled();
  });

  it('reads symbol/decimals for an unknown asset', async () => {
    readClaimableFees.mockResolvedValue({ fees: [{ currency: ASSET, amount: 9n }], unreadable: [] });
    multicall.mockResolvedValue([
      { status: 'success', result: 'MEME' },
      { status: 'success', result: 6 },
    ]);
    const { result } = renderHook(() => useIntegratorFees(true));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.fees[0]).toMatchObject({ symbol: 'MEME', decimals: 6 });
  });

  it('keeps a row whose metadata read fails — the balance is still real', async () => {
    readClaimableFees.mockResolvedValue({ fees: [{ currency: ASSET, amount: 9n }], unreadable: [] });
    multicall.mockResolvedValue([
      { status: 'failure', error: new Error('no symbol') },
      { status: 'failure', error: new Error('no decimals') },
    ]);
    const { result } = renderHook(() => useIntegratorFees(true));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Cosmetic failure must not drop withdrawable money from the list.
    expect(result.current.fees).toHaveLength(1);
    expect(result.current.fees[0]?.amount).toBe(9n);
    expect(result.current.fees[0]?.decimals).toBe(18);
  });

  it('does not read at all when disabled', async () => {
    renderHook(() => useIntegratorFees(false));
    await new Promise((r) => setTimeout(r, 0));
    expect(readClaimableFees).not.toHaveBeenCalled();
  });
});
