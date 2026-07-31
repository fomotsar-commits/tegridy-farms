// Integrator fee collection — the revenue side of the launcher.
//
// Doppler credits the integrator named at create time (ours:
// LAUNCHER_INTEGRATOR_ADDRESS) with a share of every launch's fees, held INSIDE the
// Airlock under `getIntegratorFees[integrator][token]`. It is not streamed anywhere and
// it does not arrive on its own — somebody has to call `collectIntegratorFees`.
//
// Before this module, `Airlock.collectIntegratorFees` was live on-chain with ZERO
// callers anywhere in the repo. Fees accrued and nothing could ever withdraw them.
//
// 🔴 CORRECTED 2026-07-30 — the read below was `integratorFees(address,address)` and the
// header claimed the ABI was "verified against the SDK's own airlockAbi". Verifying
// against the SDK is what CAUSED the bug: the SDK's airlockAbi is stale relative to the
// deployed Airlock and still names the accessor `integratorFees`, which this contract
// does not have. Every read reverted, multicall's allowFailure swallowed it, and the UI
// reported "nothing to claim" over live integrator revenue. Same defect class as the
// lockerStream `streams(bytes32)` bug, from the same root cause: an SDK ABI pointed at a
// contract version it does not describe.
//
// Pinned to the DEPLOYED bytecode at 0xde35…9dFA, not to the SDK (mainnet, block
// 25650314). A revert PROVES absence here — `getIntegratorFees` is an auto-generated
// public-mapping getter, so a missing key returns zero rather than reverting:
//   integratorFees(address,address)    = 0x2b79198a  REVERTS, absent from an opcode walk
//   getIntegratorFees(address,address) = 0xe7f0d8f1  returns a uint256 word, present
//
// Confirmed against the canonical source (whetstoneresearch/doppler, src/Airlock.sol):
//   mapping(address integrator => mapping(address token => uint256 amount))
//       public getIntegratorFees;                              // the getter's real name
//   function collectIntegratorFees(address to, address token, uint256 amount) external;
// so the argument order is (integrator, token) and the return is uint256 — both
// unchanged by the rename. `collectIntegratorFees` debits `msg.sender`'s own row.
//
// airlockSelectors.test.ts now pins every function this ABI declares to that captured
// bytecode, so a fragment naming an absent function fails the suite instead of failing
// silently at runtime.
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
    // NOT `integratorFees` — that name is the SDK's, and it is not on this contract.
    type: 'function',
    name: 'getIntegratorFees',
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

/** The outcome of a claimable-fee read, keeping "zero" and "unknown" apart. */
export interface ClaimableFeesResult {
  /** Non-zero balances that read back successfully. */
  fees: ClaimableFee[];
  /**
   * Currencies whose read FAILED. Neither zero nor claimable — simply unknown.
   *
   * This is returned rather than swallowed because the omission is invisible at the call
   * site otherwise: a bare empty list reads identically whether every balance was truly
   * zero or the RPC was down, and a UI cannot honestly say "nothing to claim" without
   * knowing which. That conflation is the exact bug this module was rewritten to fix —
   * see the header — so it must not be reintroduced one layer up.
   */
  unreadable: Address[];
}

/**
 * Read what our integrator can currently claim, per currency.
 *
 * Returns only NON-ZERO balances in `fees`, so a caller can render "nothing to claim" by
 * checking `fees.length === 0 && unreadable.length === 0`. A failed read lands in
 * `unreadable` rather than being reported as zero — "we could not read this" and "there
 * is nothing here" are different claims, and only one of them is safe to show next to a
 * withdraw button.
 */
export async function readClaimableFees(
  client: PublicClient,
  currencies: readonly Address[],
  integrator: Address = LAUNCHER_INTEGRATOR_ADDRESS,
): Promise<ClaimableFeesResult> {
  if (currencies.length === 0) return { fees: [], unreadable: [] };
  let results;
  try {
    results = await client.multicall({
      contracts: currencies.map((currency) => ({
        address: DOPPLER_MAINNET.airlock,
        abi: AIRLOCK_FEES_ABI,
        functionName: 'getIntegratorFees' as const,
        args: [integrator, currency] as const,
      })),
      allowFailure: true,
    });
  } catch {
    // Transport died: nothing was read, so nothing is known about ANY currency.
    return { fees: [], unreadable: [...currencies] };
  }
  const fees: ClaimableFee[] = [];
  const unreadable: Address[] = [];
  results.forEach((res, i) => {
    const currency = currencies[i];
    if (!currency) return;
    if (res.status !== 'success') {
      unreadable.push(currency); // unreadable ⇒ report as unknown, never as 0
      return;
    }
    const amount = res.result as bigint;
    if (typeof amount !== 'bigint') {
      // A success that did not decode to a number is not a zero balance either.
      unreadable.push(currency);
      return;
    }
    if (amount > 0n) fees.push({ currency, amount });
  });
  return { fees, unreadable };
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
