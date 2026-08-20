// Reads and writes for `TegridyPositionMarket` — the escrowed order book for
// veTOWELI staking positions.
//
// The ABI lives here rather than in lib/contracts.ts because the market is
// undeployed; when a ceremony runs it should move there with the rest of the
// protocol ABIs. Only the selectors the app actually calls are declared: an ABI
// entry for a function that is not on the deployed bytecode reverts with empty
// returndata, which reads to a user as a refusal rather than as the wiring bug it
// is (see the `earned`/`getPosition` note in lib/contracts.ts for the same
// hazard on TegridyStaking).

import { useCallback, useMemo } from 'react';
import { useAccount, useChainId, useReadContract, useReadContracts, useWriteContract } from 'wagmi';
import { POSITION_MARKET_ADDRESS, CHAIN_ID, isDeployed } from '../lib/constants';

export const POSITION_MARKET_ABI = [
  {
    type: 'function',
    name: 'list',
    inputs: [
      { name: 'tokenId', type: 'uint256' },
      { name: 'price', type: 'uint256' },
    ],
    outputs: [{ name: 'orderId', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'cancel',
    inputs: [
      { name: 'orderId', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'fill',
    inputs: [
      { name: 'orderId', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'claimEscrowRewards',
    inputs: [],
    outputs: [{ name: 'paid', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'fillability',
    inputs: [
      { name: 'orderId', type: 'uint256' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [
      { name: 'blocker', type: 'uint8' },
      { name: 'certain', type: 'bool' },
      { name: 'releasableAt', type: 'uint64' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'orders',
    inputs: [{ name: '', type: 'uint256' }],
    outputs: [
      { name: 'seller', type: 'address' },
      { name: 'price', type: 'uint96' },
      { name: 'escrowedAt', type: 'uint64' },
      { name: 'feeBps', type: 'uint16' },
      { name: 'status', type: 'uint8' },
      { name: 'feeRecipient', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  { type: 'function', name: 'nextOrderId', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'escrowedCount', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'MAX_ESCROWED_POSITIONS', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'STAKING_TRANSFER_RATE_LIMIT', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'feeBps', inputs: [], outputs: [{ name: '', type: 'uint16' }], stateMutability: 'view' },
  { type: 'function', name: 'feeRecipient', inputs: [], outputs: [{ name: '', type: 'address' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'escrowRewardsOwed',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
  },
] as const;

/** Mirrors `TegridyPositionMarket.OrderStatus`. */
export const ORDER_STATUS = {
  None: 0,
  Open: 1,
  Filled: 2,
  Cancelled: 3,
} as const;

export interface MarketOrder {
  orderId: bigint;
  seller: `0x${string}`;
  price: bigint;
  escrowedAt: number;
  feeBps: number;
  status: number;
  feeRecipient: `0x${string}`;
  tokenId: bigint;
}

/**
 * Escrow capacity, from the chain.
 *
 * The market is a plain contract holder on TegridyStaking, which caps any holder
 * at 50 positions — so the number of listings that can stand at once is a hard
 * protocol limit, not a product choice. A seller who hits it gets a refusal at
 * listing time, and the surface should say why before they try.
 *
 * `known` is false whenever the reads did not land. A full book and an
 * unreachable one are not the same fact.
 */
export interface EscrowCapacity {
  known: boolean;
  used: number | null;
  cap: number | null;
  full: boolean;
}

export function usePositionMarketCapacity(): EscrowCapacity {
  const chainId = useChainId();
  const enabled = isDeployed(POSITION_MARKET_ADDRESS) && chainId === CHAIN_ID;

  const { data, isSuccess } = useReadContracts({
    contracts: [
      { address: POSITION_MARKET_ADDRESS, abi: POSITION_MARKET_ABI, functionName: 'escrowedCount', chainId: CHAIN_ID },
      {
        address: POSITION_MARKET_ADDRESS,
        abi: POSITION_MARKET_ABI,
        functionName: 'MAX_ESCROWED_POSITIONS',
        chainId: CHAIN_ID,
      },
    ],
    query: { enabled },
  });

  return useMemo(() => {
    const used = data?.[0]?.status === 'success' ? Number(data[0].result as bigint) : null;
    const cap = data?.[1]?.status === 'success' ? Number(data[1].result as bigint) : null;
    const known = enabled && isSuccess && used !== null && cap !== null;
    return { known, used: known ? used : null, cap: known ? cap : null, full: known ? used >= cap : false };
  }, [data, enabled, isSuccess]);
}

/** A single order, or null when it could not be read. */
export function usePositionMarketOrder(orderId: bigint | undefined): {
  order: MarketOrder | null;
  unavailableReason: string | null;
} {
  const chainId = useChainId();
  const deployed = isDeployed(POSITION_MARKET_ADDRESS);
  const enabled = deployed && chainId === CHAIN_ID && orderId !== undefined;

  const { data, isError, isLoading } = useReadContract({
    address: POSITION_MARKET_ADDRESS,
    abi: POSITION_MARKET_ABI,
    functionName: 'orders',
    args: enabled ? [orderId as bigint] : undefined,
    chainId: CHAIN_ID,
    query: { enabled },
  });

  return useMemo(() => {
    if (!deployed) return { order: null, unavailableReason: 'The position market is not deployed yet.' };
    if (chainId !== CHAIN_ID) return { order: null, unavailableReason: 'Switch to Ethereum mainnet.' };
    if (isError) return { order: null, unavailableReason: 'This listing could not be read from the chain.' };
    if (isLoading || !data) return { order: null, unavailableReason: null };
    const [seller, price, escrowedAt, feeBps, status, feeRecipient, tokenId] = data as unknown as [
      `0x${string}`,
      bigint,
      bigint,
      number,
      number,
      `0x${string}`,
      bigint,
    ];
    return {
      order: {
        orderId: orderId as bigint,
        seller,
        price,
        escrowedAt: Number(escrowedAt),
        feeBps: Number(feeBps),
        status: Number(status),
        feeRecipient,
        tokenId,
      },
      unavailableReason: null,
    };
  }, [data, deployed, chainId, isError, isLoading, orderId]);
}

/**
 * What a seller nets on a sale at `price`, given the fee snapshotted into their
 * order. Returns null when the fee is unknown rather than assuming zero — the
 * dial ships at zero but this must not hardcode that.
 */
export function netProceeds(price: bigint, feeBps: number | null, feeRecipient: `0x${string}` | null): bigint | null {
  if (feeBps === null || feeRecipient === null) return null;
  const ZERO = '0x0000000000000000000000000000000000000000';
  if (feeRecipient.toLowerCase() === ZERO || feeBps === 0) return price;
  return price - (price * BigInt(feeBps)) / 10_000n;
}

/** Escrow-period yield this wallet is owed, or null when unread. */
export function usePositionMarketEscrowRewards(): { owed: bigint | null; unavailableReason: string | null } {
  const { address } = useAccount();
  const chainId = useChainId();
  const deployed = isDeployed(POSITION_MARKET_ADDRESS);
  const enabled = deployed && chainId === CHAIN_ID && !!address;

  const { data, isError } = useReadContract({
    address: POSITION_MARKET_ADDRESS,
    abi: POSITION_MARKET_ABI,
    functionName: 'escrowRewardsOwed',
    args: enabled ? [address as `0x${string}`] : undefined,
    chainId: CHAIN_ID,
    query: { enabled },
  });

  if (!deployed) return { owed: null, unavailableReason: 'The position market is not deployed yet.' };
  if (!enabled) return { owed: null, unavailableReason: 'Connect a wallet on Ethereum mainnet.' };
  if (isError) return { owed: null, unavailableReason: 'Could not read what you are owed.' };
  if (data === undefined) return { owed: null, unavailableReason: null };
  return { owed: data as bigint, unavailableReason: null };
}

/** Write actions. Every one of them is a no-op while the market is undeployed. */
export function usePositionMarketActions() {
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const deployed = isDeployed(POSITION_MARKET_ADDRESS);

  const list = useCallback(
    (tokenId: bigint, price: bigint) => {
      if (!deployed) return;
      writeContract({
        address: POSITION_MARKET_ADDRESS,
        abi: POSITION_MARKET_ABI,
        functionName: 'list',
        args: [tokenId, price],
        chainId: CHAIN_ID,
      });
    },
    [writeContract, deployed],
  );

  const cancel = useCallback(
    (orderId: bigint, recipient: `0x${string}`) => {
      if (!deployed) return;
      writeContract({
        address: POSITION_MARKET_ADDRESS,
        abi: POSITION_MARKET_ABI,
        functionName: 'cancel',
        args: [orderId, recipient],
        chainId: CHAIN_ID,
      });
    },
    [writeContract, deployed],
  );

  const fill = useCallback(
    (orderId: bigint, recipient: `0x${string}`, price: bigint) => {
      if (!deployed) return;
      writeContract({
        address: POSITION_MARKET_ADDRESS,
        abi: POSITION_MARKET_ABI,
        functionName: 'fill',
        args: [orderId, recipient],
        value: price,
        chainId: CHAIN_ID,
      });
    },
    [writeContract, deployed],
  );

  const claimEscrowRewards = useCallback(() => {
    if (!deployed) return;
    writeContract({
      address: POSITION_MARKET_ADDRESS,
      abi: POSITION_MARKET_ABI,
      functionName: 'claimEscrowRewards',
      chainId: CHAIN_ID,
    });
  }, [writeContract, deployed]);

  return { list, cancel, fill, claimEscrowRewards, hash, isPending, error, reset, deployed };
}
