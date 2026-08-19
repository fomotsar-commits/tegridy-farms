import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { Address, Hex } from 'viem';
import { wagmiMock } from '../test-utils/wagmi-mocks';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { useAirdropCampaign } from './useAirdropCampaign';

const DISTRIBUTOR = '0x2222222222222222222222222222222222222222' as Address;
const TOKEN = '0x3333333333333333333333333333333333333333' as Address;
const CLAIMANT = '0x4444444444444444444444444444444444444444' as Address;
const ROOT = `0x${'ab'.repeat(32)}` as Hex;

function campaignInfo(overrides: Record<string, unknown> = {}) {
  return {
    token: TOKEN,
    merkleRoot: ROOT,
    creator: CLAIMANT,
    expiresAt: 4_000_000_000n,
    claimsOpen: true,
    claimFeeWei: 0n,
    feeSink: '0x0000000000000000000000000000000000000000' as Address,
    remaining: 1000n,
    ...overrides,
  };
}

describe('useAirdropCampaign reports unknowns as null', () => {
  beforeEach(() => wagmiMock.reset());

  it('returns a null campaign when the distributor does not answer', () => {
    wagmiMock.setReadResult({ functionName: 'campaignInfo', result: undefined, status: 'failure' });
    const { result } = renderHook(() => useAirdropCampaign(DISTRIBUTOR, 0));
    // Not an expired campaign, not an empty one — nothing was read. The claim surface
    // turns this into "campaign state unavailable".
    expect(result.current.campaign).toBeNull();
  });

  it('returns a null claimed flag when the bitmap read does not land', () => {
    wagmiMock.setReadResult({ functionName: 'campaignInfo', result: campaignInfo() });
    wagmiMock.setReadResult({ functionName: 'isClaimed', result: undefined, status: 'failure' });
    const { result } = renderHook(() => useAirdropCampaign(DISTRIBUTOR, 0));
    expect(result.current.claimed).toBeNull();
  });

  it('returns a null claimed flag when no index has been resolved yet', () => {
    // A wallet with no row has no index, and `isClaimed(0)` would be somebody else's
    // answer. Passing null must never read as "not claimed".
    wagmiMock.setReadResult({ functionName: 'campaignInfo', result: campaignInfo() });
    wagmiMock.setReadResult({ functionName: 'isClaimed', result: true });
    const { result } = renderHook(() => useAirdropCampaign(DISTRIBUTOR, null));
    expect(result.current.claimed).toBeNull();
  });

  it('leaves provenance unknown while the factory has no address to ask', () => {
    // AIRDROP_FACTORY_ADDRESS is 0x0 on this build, so `isCampaign` was never asked.
    // Reporting `false` would accuse a legitimate campaign of being unvouched.
    wagmiMock.setReadResult({ functionName: 'campaignInfo', result: campaignInfo() });
    const { result } = renderHook(() => useAirdropCampaign(DISTRIBUTOR, 0));
    expect(result.current.fromOurFactory).toBeNull();
  });

  it('does not scale an amount it could not read decimals for', () => {
    wagmiMock.setReadResult({ functionName: 'campaignInfo', result: campaignInfo() });
    const { result } = renderHook(() => useAirdropCampaign(DISTRIBUTOR, 0));
    expect(result.current.tokenDecimals).toBeNull();
    expect(result.current.tokenSymbol).toBeNull();
  });
});

describe('the claim entry point follows the campaign, not the factory', () => {
  beforeEach(() => wagmiMock.reset());

  const args = { index: 3, account: CLAIMANT, amount: 42n, proof: [ROOT] };

  it('uses the fee-free `claim` when this campaign snapshotted no fee', () => {
    wagmiMock.setReadResult({ functionName: 'campaignInfo', result: campaignInfo({ claimFeeWei: 0n }) });
    const { result } = renderHook(() => useAirdropCampaign(DISTRIBUTOR, 3));
    result.current.claim(args);
    const call = wagmiMock.writeContract().mock.calls[0]![0] as { functionName: string; value?: bigint };
    // Sending value to `claim` would revert — it is not payable.
    expect(call.functionName).toBe('claim');
    expect(call.value).toBeUndefined();
  });

  it('uses `claimWithFee` with the exact snapshotted value when a fee is live', () => {
    wagmiMock.setReadResult({ functionName: 'campaignInfo', result: campaignInfo({ claimFeeWei: 500_000_000_000_000n }) });
    const { result } = renderHook(() => useAirdropCampaign(DISTRIBUTOR, 3));
    result.current.claim(args);
    const call = wagmiMock.writeContract().mock.calls[0]![0] as { functionName: string; value?: bigint };
    // The distributor requires msg.value to EQUAL the fee — not at least it — so it
    // never has to refund change to an untrusted claimant.
    expect(call.functionName).toBe('claimWithFee');
    expect(call.value).toBe(500_000_000_000_000n);
  });

  it('fires nothing at all while the campaign state is unknown', () => {
    wagmiMock.setReadResult({ functionName: 'campaignInfo', result: undefined, status: 'failure' });
    const { result } = renderHook(() => useAirdropCampaign(DISTRIBUTOR, 3));
    result.current.claim(args);
    expect(wagmiMock.writeContract()).not.toHaveBeenCalled();
  });
});
