// useWalletExposure — what the "distribution not measured" copy is allowed to say.
//
// The page tells a holder why a token has no distribution read. Whatever that
// copy claims, THIS is the behaviour behind it: the scan effect is keyed on the
// holding SET, so a failed scan is never re-run while the holdings stay the same
// — and no retry control exists on the page. These tests pin that, so the copy in
// lib/detection/walletExposure.ts (UNMEASURED_REASON) cannot quietly drift back
// into promising a retry that never fires.
//
// If someone DOES wire a retry later, the "never retries" test below is meant to
// fail. That is the reminder to revisit the wording at the same time.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';
import { CHAIN_ID } from '../lib/constants';
import { UNMEASURED_REASON } from '../lib/detection/walletExposure';
import { useWalletExposure } from './useWalletExposure';

const WALLET = '0x00000000000000000000000000000000000000ff' as `0x${string}`;
const TOKEN_A = '0x00000000000000000000000000000000000000aa';
const TOKEN_B = '0x00000000000000000000000000000000000000bb';

/**
 * Make exactly one pasted token read back as a real position. Curated tokens are
 * left unstubbed, so the shared mock reports `failure` for them, their balance
 * falls to 0n, and the hook filters them out — leaving a single holding to scan.
 */
function stubHolding(address: string, symbol: string) {
  wagmiMock.setReadResult({ address, functionName: 'balanceOf', result: 5n * 10n ** 18n });
  wagmiMock.setReadResult({ address, functionName: 'totalSupply', result: 1000n * 10n ** 18n });
  wagmiMock.setReadResult({ address, functionName: 'symbol', result: symbol });
  wagmiMock.setReadResult({ address, functionName: 'decimals', result: 18 });
}

/** A distribution analysis shaped just enough for the hook to call it measured. */
function fakeAnalysis() {
  return {
    band: 'well-distributed',
    headline: 'evenly held',
    confidence: { level: 'high', reasons: [] },
    observedAt: 1_700_000_000,
    metrics: { includedHolders: 200 },
  } as never;
}

describe('useWalletExposure — the no-retry behaviour the copy has to match', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setAccount({ address: WALLET, isConnected: true });
    wagmiMock.setChainId(CHAIN_ID);
  });

  it('surfaces a measured band when the scan succeeds (proves the harness really scans)', async () => {
    // Without this, the unmeasured assertions below could pass simply because the
    // scanner never ran at all.
    stubHolding(TOKEN_A, 'AAA');
    const scanToken = vi.fn().mockResolvedValue(fakeAnalysis());

    const { result } = renderHook(() => useWalletExposure({ extraTokens: [TOKEN_A], scanToken }));

    await waitFor(() => expect(result.current.scanning).toBe(false));
    expect(scanToken).toHaveBeenCalledTimes(1);
    expect(result.current.exposures[TOKEN_A]?.status).toBe('measured');
  });

  it('never re-scans a failed token while the holding set is unchanged', async () => {
    stubHolding(TOKEN_A, 'AAA');
    // The page's real shape: it catches its own errors and resolves null.
    const scanToken = vi.fn().mockResolvedValue(null);

    const { result, rerender } = renderHook(
      ({ extra }: { extra: string[] }) => useWalletExposure({ extraTokens: extra, scanToken }),
      { initialProps: { extra: [TOKEN_A] } },
    );

    await waitFor(() => expect(scanToken).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.scanning).toBe(false));
    expect(result.current.exposures[TOKEN_A]?.status).toBe('unmeasured');

    // Re-render the way the live page does: a brand-new `extraTokens` array and a
    // fresh balance multicall result on every 30s refetch. Identities change, the
    // holding SET does not — so the scan effect must not fire again.
    for (let i = 0; i < 3; i++) rerender({ extra: [TOKEN_A] });
    await Promise.resolve();

    expect(scanToken).toHaveBeenCalledTimes(1);
    expect(result.current.exposures[TOKEN_A]?.status).toBe('unmeasured');
  });

  it('a rejected scan is also never retried, and reads as unmeasured', async () => {
    stubHolding(TOKEN_A, 'AAA');
    const scanToken = vi.fn().mockRejectedValue(new Error('holder source rate-limited'));

    const { result, rerender } = renderHook(
      ({ extra }: { extra: string[] }) => useWalletExposure({ extraTokens: extra, scanToken }),
      { initialProps: { extra: [TOKEN_A] } },
    );

    await waitFor(() => expect(result.current.scanning).toBe(false));
    expect(scanToken).toHaveBeenCalledTimes(1);
    expect(result.current.exposures[TOKEN_A]?.status).toBe('unmeasured');

    rerender({ extra: [TOKEN_A] });
    await Promise.resolve();
    expect(scanToken).toHaveBeenCalledTimes(1);
  });

  it('the reason a failed scan renders is the shared one, and it promises no retry', async () => {
    // The behavioural pin above and the wording live in different files; this is
    // the seam that keeps them honest about each other.
    stubHolding(TOKEN_A, 'AAA');
    const scanToken = vi.fn().mockResolvedValue(null);

    const { result } = renderHook(() => useWalletExposure({ extraTokens: [TOKEN_A], scanToken }));

    await waitFor(() => expect(result.current.scanning).toBe(false));
    const reason = result.current.exposures[TOKEN_A]?.reason ?? '';
    expect(reason).toBe(UNMEASURED_REASON);
    expect(reason).not.toMatch(/will retry|retry(ing)?\b|try again|check back/i);
  });

  it('DOES scan again when the holding set actually changes', async () => {
    // The effect is keyed on the holding set — not dead. This is what makes
    // "until your holdings change" the accurate description of the behaviour.
    stubHolding(TOKEN_A, 'AAA');
    stubHolding(TOKEN_B, 'BBB');
    const scanToken = vi.fn().mockResolvedValue(null);

    const { rerender } = renderHook(
      ({ extra }: { extra: string[] }) => useWalletExposure({ extraTokens: extra, scanToken }),
      { initialProps: { extra: [TOKEN_A] } },
    );

    await waitFor(() => expect(scanToken).toHaveBeenCalledTimes(1));

    rerender({ extra: [TOKEN_A, TOKEN_B] });
    // Two holdings now ⇒ both are scanned in the fresh pass: 1 + 2 = 3.
    await waitFor(() => expect(scanToken).toHaveBeenCalledTimes(3));
  });
});

// ── A failed balanceOf is not a zero balance ─────────────────────────────────
//
// `balRes?.status === 'success' ? result : 0n`, followed by the `<= 0n` skip, deleted
// the position outright: one failed leg of the multicall and that token vanished from
// your exposure, taking its weight out of the headline concentration with it. The
// flattering direction, and completely invisible — while the page's own footer
// promises "the position size stays exact and nothing is inferred".
//
// Read it and it is zero → still skipped: you do not hold it, and that IS an answer.
describe('useWalletExposure — an unreadable balance is disclosed, not deleted', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setAccount({ address: WALLET, isConnected: true });
    wagmiMock.setChainId(CHAIN_ID);
  });

  /** Everything reads back EXCEPT balanceOf, which the mock reports as a failure. */
  function stubHoldingWithoutBalance(address: string, symbol: string) {
    wagmiMock.setReadResult({ address, functionName: 'totalSupply', result: 1000n * 10n ** 18n });
    wagmiMock.setReadResult({ address, functionName: 'symbol', result: symbol });
    wagmiMock.setReadResult({ address, functionName: 'decimals', result: 18 });
  }

  it('reports a token whose balance could not be read instead of dropping it', async () => {
    stubHoldingWithoutBalance(TOKEN_B, 'BBB');
    const { result } = renderHook(() =>
      useWalletExposure({ extraTokens: [TOKEN_B], scanToken: vi.fn().mockResolvedValue(null) }),
    );

    await waitFor(() => expect(result.current.unreadableBalances).toContain(TOKEN_B));
    // No size to show, so it is correctly absent from the list — the count is what
    // keeps that absence from being silent.
    expect(result.current.holdings.some((h) => h.address === TOKEN_B)).toBe(false);
  });

  it('does NOT report a token the wallet genuinely holds none of', async () => {
    // The other side: a read that worked and returned zero is an answer, and calling
    // it unreadable would cry wolf on every token in the curated list.
    wagmiMock.setReadResult({ address: TOKEN_B, functionName: 'balanceOf', result: 0n });
    wagmiMock.setReadResult({ address: TOKEN_B, functionName: 'totalSupply', result: 1000n * 10n ** 18n });
    wagmiMock.setReadResult({ address: TOKEN_B, functionName: 'symbol', result: 'BBB' });
    wagmiMock.setReadResult({ address: TOKEN_B, functionName: 'decimals', result: 18 });

    const { result } = renderHook(() =>
      useWalletExposure({ extraTokens: [TOKEN_B], scanToken: vi.fn().mockResolvedValue(null) }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.unreadableBalances).not.toContain(TOKEN_B);
    expect(result.current.holdings.some((h) => h.address === TOKEN_B)).toBe(false);
  });

  it('keeps a real position out of the unreadable list', async () => {
    stubHolding(TOKEN_A, 'AAA');
    const { result } = renderHook(() =>
      useWalletExposure({ extraTokens: [TOKEN_A], scanToken: vi.fn().mockResolvedValue(fakeAnalysis()) }),
    );

    await waitFor(() => expect(result.current.scanning).toBe(false));
    expect(result.current.holdings.some((h) => h.address === TOKEN_A)).toBe(true);
    expect(result.current.unreadableBalances).not.toContain(TOKEN_A);
  });
});
