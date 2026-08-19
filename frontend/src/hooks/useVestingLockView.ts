import { useReadContracts } from 'wagmi';
import { isAddress, type Address } from 'viem';
import { LAUNCH_LOCK_VIEW_ABI } from '../lib/contracts';
import { LAUNCH_LOCK_VIEW_ADDRESS, isDeployed as checkDeployed } from '../lib/constants';

/**
 * `LaunchLockView.snapshot` for one token.
 *
 * This hook exists to carry the view's own honesty flags through to the UI without
 * flattening them. The contract returns `vestingSourceAvailable` / `lockSourceAvailable`
 * precisely so that a rail which is unset, misaddressed, or reverting can be told apart
 * from a rail that answered zero — and the numeric fields beside a false flag are zero
 * only because nothing was read.
 *
 * So there are three states per rail here, never two:
 *   available === true   → the number is the answer, including when it is 0
 *   available === false  → NO DATA; the rail is unset or unreachable
 *   snapshot === null    → the view itself could not be read; nothing is known at all
 */

export interface LockSnapshot {
  vestingSourceAvailable: boolean;
  lockSourceAvailable: boolean;
  vestedInflow: bigint;
  vestingWalletCount: number;
  lockedTotal: bigint;
  lockedScanned: bigint;
  earliestUnlockAt: number;
  latestUnlockAt: number;
  activeLockCount: number;
  /** Non-zero means the lock scan was TRUNCATED — the unlock dates cover part of the
   *  token's locks only, and must not be published as the token's lock expiry. */
  nextLockOffset: number;
}

export interface LockViewState {
  /** The view contract has an address. */
  deployed: boolean;
  address: Address;
  /** `null` when the view itself could not be read, or nothing was queried yet. */
  snapshot: LockSnapshot | null;
  /** True when a token was queried against a deployed view and no snapshot came back. */
  readFailed: boolean;
}

/**
 * @param token     Token to report on, or `null` for no query.
 * @param lockLimit Maximum locks to visit. The vault's per-token list is
 *                  attacker-growable (anyone can open a dust lock against any token),
 *                  so the scan is bounded and `nextLockOffset` reports the truncation
 *                  rather than the page silently showing a partial figure as total.
 */
export function useVestingLockView(token: Address | null, lockLimit = 64): LockViewState & { refetch: () => void } {
  const deployed = checkDeployed(LAUNCH_LOCK_VIEW_ADDRESS);
  const enabled = deployed && token !== null && isAddress(token);

  const { data, refetch } = useReadContracts({
    contracts: [
      {
        address: LAUNCH_LOCK_VIEW_ADDRESS,
        abi: LAUNCH_LOCK_VIEW_ABI,
        functionName: 'snapshot',
        args: [
          (token ?? '0x0000000000000000000000000000000000000000') as Address,
          0n,
          BigInt(lockLimit),
        ],
      },
    ],
    query: { enabled, refetchInterval: 60_000 },
  });

  const raw =
    data?.[0]?.status === 'success'
      ? (data[0].result as {
          vestingSourceAvailable: boolean;
          lockSourceAvailable: boolean;
          vestedInflow: bigint;
          vestingWalletCount: bigint;
          lockedTotal: bigint;
          lockedScanned: bigint;
          earliestUnlockAt: bigint;
          latestUnlockAt: bigint;
          activeLockCount: bigint;
          nextLockOffset: bigint;
        })
      : null;

  return {
    deployed,
    address: LAUNCH_LOCK_VIEW_ADDRESS,
    snapshot: raw
      ? {
          vestingSourceAvailable: raw.vestingSourceAvailable,
          lockSourceAvailable: raw.lockSourceAvailable,
          vestedInflow: raw.vestedInflow,
          vestingWalletCount: Number(raw.vestingWalletCount),
          lockedTotal: raw.lockedTotal,
          lockedScanned: raw.lockedScanned,
          earliestUnlockAt: Number(raw.earliestUnlockAt),
          latestUnlockAt: Number(raw.latestUnlockAt),
          activeLockCount: Number(raw.activeLockCount),
          nextLockOffset: Number(raw.nextLockOffset),
        }
      : null,
    readFailed: enabled && raw === null,
    refetch: () => void refetch(),
  };
}
