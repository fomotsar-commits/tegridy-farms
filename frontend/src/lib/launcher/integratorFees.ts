// Integrator fee collection — the revenue side of the launcher.
//
// Doppler credits the integrator named at create time (ours:
// LAUNCHER_INTEGRATOR_ADDRESS) with a share of every launch's fees, held INSIDE the
// Airlock under `integratorFees[integrator][token]`. It is not streamed anywhere and it
// does not arrive on its own — somebody has to call `collectIntegratorFees`.
//
// Before this module, `Airlock.collectIntegratorFees` was live on-chain with ZERO
// callers anywhere in the repo. Fees accrued and nothing could ever withdraw them.
//
// ABI verified against the SDK's own airlockAbi (@whetstone-research/doppler-sdk,
// dist/evm), not hand-written:
//   integratorFees(address integrator, address token) view returns (uint256)
//   collectIntegratorFees(address to, address token, uint256 amount) nonpayable
//   migrate(address asset) nonpayable
//
// `token` is the currency the fee is denominated in — the NUMERAIRE, plus the launched
// asset itself. For an ETH launch the numeraire slot is address(0) (native ETH), which
// is why callers must be able to ask about the zero address explicitly rather than
// treating it as "unset".

import type { Address, PublicClient, WalletClient } from 'viem';
import { DOPPLER_MAINNET } from './doppler.constants';
import { LAUNCHER_INTEGRATOR_ADDRESS } from './config';

/** Native ETH is represented as the zero address in Airlock fee accounting. */
export const NATIVE_CURRENCY = '0x0000000000000000000000000000000000000000' as Address;

export const AIRLOCK_FEES_ABI = [
  {
    type: 'function',
    name: 'integratorFees',
    stateMutability: 'view',
    inputs: [
      { name: 'integrator', type: 'address' },
      { name: 'token', type: 'address' },
    ],
    outputs: [{ name: 'amount', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'collectIntegratorFees',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'migrate',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [],
  },
] as const;

/** One currency's claimable balance for our integrator. */
export interface ClaimableFee {
  /** Fee currency. `NATIVE_CURRENCY` (0x0) means native ETH. */
  currency: Address;
  /** Raw claimable amount in that currency's smallest unit. */
  amount: bigint;
}

/**
 * Read what our integrator can currently claim, per currency.
 *
 * Returns only NON-ZERO balances, so a caller can render "nothing to claim" by checking
 * `length === 0` without having to filter. A failed read is OMITTED rather than reported
 * as zero — "we could not read this" and "there is nothing here" are different claims,
 * and only one of them is safe to show next to a withdraw button.
 */
export async function readClaimableFees(
  client: PublicClient,
  currencies: readonly Address[],
  integrator: Address = LAUNCHER_INTEGRATOR_ADDRESS,
): Promise<ClaimableFee[]> {
  if (currencies.length === 0) return [];
  let results;
  try {
    results = await client.multicall({
      contracts: currencies.map((currency) => ({
        address: DOPPLER_MAINNET.airlock,
        abi: AIRLOCK_FEES_ABI,
        functionName: 'integratorFees' as const,
        args: [integrator, currency] as const,
      })),
      allowFailure: true,
    });
  } catch {
    return [];
  }
  const out: ClaimableFee[] = [];
  results.forEach((res, i) => {
    const currency = currencies[i];
    if (res.status !== 'success' || !currency) return; // unreadable ⇒ omit, never report 0
    const amount = res.result as bigint;
    if (typeof amount === 'bigint' && amount > 0n) out.push({ currency, amount });
  });
  return out;
}

/**
 * Withdraw accrued integrator fees to `to`.
 *
 * Deliberately takes an explicit `amount` rather than defaulting to "everything": the
 * caller should have just read the balance, and a max-withdraw that races an incoming
 * fee would revert on an over-draw. Simulates first so a revert surfaces as a rejected
 * promise BEFORE the user is asked to sign.
 */
export async function collectIntegratorFees(
  publicClient: PublicClient,
  walletClient: WalletClient,
  params: { to: Address; currency: Address; amount: bigint },
): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) throw new Error('No account connected.');
  if (params.amount <= 0n) throw new Error('Nothing to collect.');

  const { request } = await publicClient.simulateContract({
    address: DOPPLER_MAINNET.airlock,
    abi: AIRLOCK_FEES_ABI,
    functionName: 'collectIntegratorFees',
    args: [params.to, params.currency, params.amount],
    account,
  });
  return walletClient.writeContract(request);
}

/**
 * Trigger a launch's graduation from the auction into its migration pool.
 *
 * `Airlock.migrate` is permissionless — anyone may call it once the auction's own
 * conditions are met — and until this module nothing in the repo called it, so our
 * launches could sit un-migrated indefinitely waiting for a stranger to do it.
 *
 * Simulated first: pre-conditions (auction not finished, already migrated) revert, and
 * a failed simulation is far better than a user paying gas to find out.
 */
export async function migrateAsset(
  publicClient: PublicClient,
  walletClient: WalletClient,
  asset: Address,
): Promise<`0x${string}`> {
  const account = walletClient.account;
  if (!account) throw new Error('No account connected.');
  const { request } = await publicClient.simulateContract({
    address: DOPPLER_MAINNET.airlock,
    abi: AIRLOCK_FEES_ABI,
    functionName: 'migrate',
    args: [asset],
    account,
  });
  return walletClient.writeContract(request);
}

/**
 * Whether an asset looks ready to migrate, without spending gas to find out.
 * A reverting simulation is the "not yet" signal — `migrate` has no view predicate.
 */
export async function canMigrate(
  publicClient: PublicClient,
  asset: Address,
  from: Address,
): Promise<boolean> {
  try {
    await publicClient.simulateContract({
      address: DOPPLER_MAINNET.airlock,
      abi: AIRLOCK_FEES_ABI,
      functionName: 'migrate',
      args: [asset],
      account: from,
    });
    return true;
  } catch {
    return false;
  }
}
