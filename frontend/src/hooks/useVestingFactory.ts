import { useAccount, useReadContracts } from 'wagmi';
import type { Address } from 'viem';
import { VESTING_FACTORY_ABI } from '../lib/contracts';
import { VESTING_FACTORY_ADDRESS, isDeployed as checkDeployed } from '../lib/constants';

/**
 * The two registry lists a wallet appears in: streams it RECEIVES (beneficiary) and
 * streams it FUNDED (creator).
 *
 * Both are `null` when their read did not land. An empty array means the registry
 * answered and the wallet genuinely has no streams; `null` means nobody asked or
 * nobody answered. The dashboard keeps those apart — "no streams" and "could not
 * check" are different sentences.
 */

export interface VestingRegistryState {
  deployed: boolean;
  address: Address;
  /** Wallets where the connected account is the beneficiary. `null` = unread. */
  incoming: readonly Address[] | null;
  /** Wallets the connected account funded. `null` = unread. */
  outgoing: readonly Address[] | null;
  /** Streams created by this factory in total. `null` = unread. */
  totalStreams: number | null;
  /** At least one read did not land while the rail is deployed and a wallet is connected. */
  readIncomplete: boolean;
}

export function useVestingFactory(): VestingRegistryState & { refetch: () => void } {
  const { address } = useAccount();
  const deployed = checkDeployed(VESTING_FACTORY_ADDRESS);
  const enabled = deployed && Boolean(address);

  const { data, refetch } = useReadContracts({
    contracts: [
      {
        address: VESTING_FACTORY_ADDRESS,
        abi: VESTING_FACTORY_ABI,
        functionName: 'vestingsForBeneficiary',
        args: [(address ?? '0x0000000000000000000000000000000000000000') as Address],
      },
      {
        address: VESTING_FACTORY_ADDRESS,
        abi: VESTING_FACTORY_ABI,
        functionName: 'vestingsForCreator',
        args: [(address ?? '0x0000000000000000000000000000000000000000') as Address],
      },
      { address: VESTING_FACTORY_ADDRESS, abi: VESTING_FACTORY_ABI, functionName: 'vestingCount' },
    ],
    query: { enabled, refetchInterval: 60_000 },
  });

  return {
    deployed,
    address: VESTING_FACTORY_ADDRESS,
    incoming: data?.[0]?.status === 'success' ? (data[0].result as readonly Address[]) : null,
    outgoing: data?.[1]?.status === 'success' ? (data[1].result as readonly Address[]) : null,
    totalStreams: data?.[2]?.status === 'success' ? Number(data[2].result as bigint) : null,
    readIncomplete: enabled ? !data || data.some((r) => r.status !== 'success') : false,
    refetch: () => void refetch(),
  };
}
