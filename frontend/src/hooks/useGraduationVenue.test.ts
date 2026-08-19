// The hook adds exactly one thing to the pure plan: the Airlock read that decides whether
// the migrator is usable. Its whole value is that the read has THREE outcomes, and the
// two failure outcomes are not the same failure — "we have no RPC" and "the RPC answered
// with an error" must not both collapse into a red badge on a whitelisted module.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const client = { readContract: vi.fn() };
const clientBox = { current: client as { readContract: ReturnType<typeof vi.fn> } | undefined };
vi.mock('wagmi', () => ({
  usePublicClient: () => clientBox.current,
}));

import { useGraduationVenue } from './useGraduationVenue';
import { resolveEvmGraduationVenue } from '../lib/launcher/graduation';

beforeEach(() => {
  vi.clearAllMocks();
  clientBox.current = client;
});

describe('the plan is available without a client', () => {
  it('returns the pure plan even when there is no RPC, and marks the check skipped', () => {
    clientBox.current = undefined;
    const { result } = renderHook(() => useGraduationVenue());
    expect(result.current.plan.migrator.address).toBe(resolveEvmGraduationVenue().migrator.address);
    expect(result.current.checkSkipped).toBe(true);
    expect(result.current.moduleCheck).toBeNull();
  });
});

describe('the module check keeps its three states apart', () => {
  it('a whitelisted module resolves to whitelisted, with checkSkipped false', async () => {
    client.readContract.mockResolvedValue(4);
    const { result } = renderHook(() => useGraduationVenue());
    await waitFor(() => expect(result.current.moduleCheck).not.toBeNull());
    expect(result.current.moduleCheck).toMatchObject({ whitelisted: true, unreadable: false });
    expect(result.current.checkSkipped).toBe(false);
  });

  it('an RPC failure resolves to unreadable — NOT to a not-whitelisted finding', async () => {
    client.readContract.mockRejectedValue(new Error('rpc down'));
    const { result } = renderHook(() => useGraduationVenue());
    await waitFor(() => expect(result.current.moduleCheck).not.toBeNull());
    expect(result.current.moduleCheck).toMatchObject({ unreadable: true, whitelisted: false, state: null });
    // The distinction that matters downstream: unreadable is not the same as "no client".
    expect(result.current.checkSkipped).toBe(false);
  });

  it('queries the migrator the plan actually names', async () => {
    client.readContract.mockResolvedValue(4);
    const { result } = renderHook(() => useGraduationVenue());
    await waitFor(() => expect(result.current.moduleCheck).not.toBeNull());
    expect(client.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        functionName: 'getModuleState',
        args: [resolveEvmGraduationVenue().migrator.address],
      }),
    );
  });
});
