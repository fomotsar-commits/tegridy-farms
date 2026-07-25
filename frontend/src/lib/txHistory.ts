// Shared, schema-validated transaction-history helpers.
//
// Extracted from HistoryPage (the R040 H1 hardened parser) so HistoryPage and
// the Treasury activity feed share ONE validated path for proxy responses
// crossing the wire — rather than two diverging copies. Every externally
// controlled JSON row runs through `TxRecordSchema` before it can reach a
// clickable href or a value calculation.
import { z } from 'zod';
import {
  SWAP_FEE_ROUTER_ADDRESS, UNISWAP_V2_ROUTER, TEGRIDY_STAKING_ADDRESS,
  TEGRIDY_RESTAKING_ADDRESS, REVENUE_DISTRIBUTOR_ADDRESS, REFERRAL_SPLITTER_ADDRESS,
  COMMUNITY_GRANTS_ADDRESS, MEME_BOUNTY_BOARD_ADDRESS, PREMIUM_ACCESS_ADDRESS,
  VOTE_INCENTIVES_ADDRESS, LP_FARMING_ADDRESS, TEGRIDY_ROUTER_ADDRESS,
  TEGRIDY_LP_ADDRESS, TOWELI_ADDRESS, isDeployed,
  TEGRIDY_NFT_LENDING_ADDRESS, TEGRIDY_NFT_POOL_FACTORY_ADDRESS, TEGRIDY_LAUNCHPAD_V2_ADDRESS,
} from './constants';

// F382: the set of protocol contracts the history feed tracks. Live contracts
// only (zeroed/undeployed addresses are dropped so an undeployed feature's 0x0
// never collides with a real `to`). Single source of truth for the fetch filter
// + the footer's "all protocol contracts" claim.
export const HISTORY_CONTRACTS: string[] = [
  SWAP_FEE_ROUTER_ADDRESS, UNISWAP_V2_ROUTER, TEGRIDY_STAKING_ADDRESS,
  TEGRIDY_RESTAKING_ADDRESS, REVENUE_DISTRIBUTOR_ADDRESS, REFERRAL_SPLITTER_ADDRESS,
  COMMUNITY_GRANTS_ADDRESS, MEME_BOUNTY_BOARD_ADDRESS, PREMIUM_ACCESS_ADDRESS,
  VOTE_INCENTIVES_ADDRESS, LP_FARMING_ADDRESS, TEGRIDY_ROUTER_ADDRESS, TEGRIDY_LP_ADDRESS,
  TOWELI_ADDRESS,
  // Un-gated 2026-07-21 — must be in the feed for the "all protocol contracts"
  // claim to hold (they were omitted while dark). .filter(isDeployed) keeps this
  // safe if any is ever re-zeroed.
  TEGRIDY_NFT_LENDING_ADDRESS, TEGRIDY_NFT_POOL_FACTORY_ADDRESS, TEGRIDY_LAUNCHPAD_V2_ADDRESS,
].filter(isDeployed).map((a) => a.toLowerCase());

const HEX_HASH = /^0x[a-fA-F0-9]{64}$/;
const HEX_ADDR = /^0x[a-fA-F0-9]{40}$/;
const DEC_DIGITS = /^\d+$/;

export const TxRecordSchema = z.object({
  hash: z.string().regex(HEX_HASH),
  to: z.string().regex(HEX_ADDR),
  // `from` is optional: HistoryPage categorizes by `to`, but the treasury feed
  // needs `from` to tell inflows from outflows. Etherscan normal + internal tx
  // rows both carry it; we keep it optional so a row missing it still parses.
  from: z.string().regex(HEX_ADDR).optional(),
  // Etherscan returns timeStamp as a digit-string, but other indexers may use
  // numbers — accept both then normalise to a string of digits.
  timeStamp: z.union([z.string().regex(DEC_DIGITS), z.number().int().nonnegative()])
    .transform((v) => String(v)),
  // value is a decimal-string wei amount.
  value: z.string().regex(DEC_DIGITS).default('0'),
  functionName: z.string().max(256).default(''),
  isError: z.string().max(2).default('0'),
  // Optional gas fields — bounded strings when present.
  gasUsed: z.string().regex(DEC_DIGITS).max(20).optional(),
  gasPrice: z.string().regex(DEC_DIGITS).max(32).optional(),
});

export type TxRecord = z.infer<typeof TxRecordSchema>;

/**
 * Parse a raw indexer response into a list of validated TxRecords. Every
 * entry runs through `safeParse`; failures are dropped silently so a single
 * malformed row can't break the page. Never throws.
 */
export function parseTxRecords(input: unknown): TxRecord[] {
  if (!Array.isArray(input)) return [];
  const out: TxRecord[] = [];
  for (const raw of input) {
    const parsed = TxRecordSchema.safeParse(raw);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

// Compute gas cost in ETH from decimal-string gasUsed * gasPrice (wei).
// Returns empty string if either field is missing / malformed so the UI can
// render "—" without special-casing. 6 decimals is enough to see sub-cent
// tx costs without taking up a column worth of real estate.
export function formatGasEth(gasUsed?: string, gasPrice?: string): string {
  if (!gasUsed || !gasPrice) return '';
  try {
    const cost = BigInt(gasUsed) * BigInt(gasPrice);
    if (cost === 0n) return '';
    // Convert wei → ETH with 6-decimal precision, no float precision loss.
    const whole = cost / 1_000_000_000_000_000_000n;
    const micro = (cost / 1_000_000_000_000n) % 1_000_000n;
    const wholeStr = whole.toString();
    const microStr = micro.toString().padStart(6, '0');
    const trimmed = (wholeStr + '.' + microStr).replace(/\.?0+$/, '') || '0';
    return trimmed;
  } catch {
    return '';
  }
}

export function categorizeTx(tx: TxRecord): { type: string; color: string } {
  const fn = tx.functionName?.split('(')[0] || '';
  const to = tx.to.toLowerCase();

  // Swap routers (native SwapFeeRouter, Uniswap V2, and the native Tegridy router)
  if (
    to === SWAP_FEE_ROUTER_ADDRESS.toLowerCase() ||
    to === UNISWAP_V2_ROUTER.toLowerCase() ||
    (isDeployed(TEGRIDY_ROUTER_ADDRESS) && to === TEGRIDY_ROUTER_ADDRESS.toLowerCase())
  ) {
    if (fn.includes('swap') || fn.includes('Swap')) return { type: 'Swap', color: 'text-white' };
    if (fn.includes('Liquidity')) return { type: 'Liquidity', color: 'text-white' };
    return { type: 'Router', color: 'text-white' };
  }
  // LP Farming (Synthetix-style boosted LP staking)
  if (isDeployed(LP_FARMING_ADDRESS) && to === LP_FARMING_ADDRESS.toLowerCase()) {
    if (fn === 'stake') return { type: 'Stake LP', color: 'text-success' };
    if (fn === 'withdraw') return { type: 'Unstake LP', color: 'text-warning' };
    if (fn === 'getReward' || fn === 'claimReward') return { type: 'Claim', color: 'text-white' };
    return { type: 'Farm', color: 'text-white' };
  }
  // Native LP token (TOWELI/WETH pair) — direct transfers / approvals
  if (isDeployed(TEGRIDY_LP_ADDRESS) && to === TEGRIDY_LP_ADDRESS.toLowerCase()) {
    if (fn === 'approve') return { type: 'Approve', color: 'text-white' };
    return { type: 'LP', color: 'text-white' };
  }
  // Staking
  if (to === TEGRIDY_STAKING_ADDRESS.toLowerCase()) {
    if (fn === 'stake') return { type: 'Stake', color: 'text-success' };
    if (fn === 'withdraw') return { type: 'Unstake', color: 'text-warning' };
    if (fn === 'getReward') return { type: 'Claim', color: 'text-white' };
    if (fn === 'earlyWithdraw') return { type: 'Early Exit', color: 'text-danger' };
    if (fn === 'toggleAutoMaxLock') return { type: 'Auto-Lock', color: 'text-white' };
    return { type: 'Farm', color: 'text-white' };
  }
  // Restaking
  // F478: guard every zeroed-contract compare with isDeployed() so a tx to the
  // zero address (ETH burn / zero-send) doesn't collide with an undeployed
  // contract's 0x000…0 and get mislabelled (e.g. 'Restake').
  if (isDeployed(TEGRIDY_RESTAKING_ADDRESS) && to === TEGRIDY_RESTAKING_ADDRESS.toLowerCase()) {
    if (fn === 'restake') return { type: 'Restake', color: 'text-success' };
    if (fn === 'unrestake') return { type: 'Unrestake', color: 'text-warning' };
    if (fn === 'claimAll') return { type: 'Claim', color: 'text-white' };
    return { type: 'Restake', color: 'text-white' };
  }
  // Revenue & Referrals
  if (to === REVENUE_DISTRIBUTOR_ADDRESS.toLowerCase()) {
    if (fn === 'register') return { type: 'Register', color: 'text-success' };
    if (fn === 'claim') return { type: 'Revenue', color: 'text-white' };
    return { type: 'Revenue', color: 'text-white' };
  }
  if (to === REFERRAL_SPLITTER_ADDRESS.toLowerCase()) {
    if (fn === 'claimReferralRewards') return { type: 'Referral', color: 'text-white' };
    if (fn === 'setReferrer') return { type: 'Referral', color: 'text-success' };
    return { type: 'Referral', color: 'text-white' };
  }
  // Governance
  if (isDeployed(COMMUNITY_GRANTS_ADDRESS) && to === COMMUNITY_GRANTS_ADDRESS.toLowerCase()) {
    if (fn === 'createProposal') return { type: 'Proposal', color: 'text-white' };
    if (fn === 'voteOnProposal') return { type: 'Vote', color: 'text-success' };
    if (fn === 'finalizeProposal') return { type: 'Finalize', color: 'text-warning' };
    return { type: 'Grants', color: 'text-white' };
  }
  // Bounties
  if (isDeployed(MEME_BOUNTY_BOARD_ADDRESS) && to === MEME_BOUNTY_BOARD_ADDRESS.toLowerCase()) {
    if (fn === 'createBounty') return { type: 'Bounty', color: 'text-white' };
    if (fn === 'submitWork') return { type: 'Submit', color: 'text-success' };
    if (fn === 'voteForSubmission') return { type: 'Vote', color: 'text-success' };
    return { type: 'Bounty', color: 'text-white' };
  }
  // Premium
  if (isDeployed(PREMIUM_ACCESS_ADDRESS) && to === PREMIUM_ACCESS_ADDRESS.toLowerCase()) {
    if (fn === 'subscribe') return { type: 'Subscribe', color: 'text-white' };
    if (fn === 'claimNFTAccess') return { type: 'NFT Claim', color: 'text-success' };
    return { type: 'Premium', color: 'text-white' };
  }
  // Vote Incentives (Bribes)
  if (isDeployed(VOTE_INCENTIVES_ADDRESS) && to === VOTE_INCENTIVES_ADDRESS.toLowerCase()) {
    if (fn === 'depositBribe' || fn === 'depositBribeETH') return { type: 'Bribe', color: 'text-white' };
    if (fn === 'claimBribes' || fn === 'claimBribesBatch') return { type: 'Claim Bribe', color: 'text-success' };
    if (fn === 'advanceEpoch') return { type: 'Epoch', color: 'text-white' };
    return { type: 'Bribes', color: 'text-white' };
  }
  // Token approvals
  if (fn === 'approve') {
    return { type: 'Approve', color: 'text-white' };
  }
  return { type: 'Other', color: 'text-white' };
}

/**
 * Fetch + validate an address's transaction list via the server-side Etherscan
 * proxy (keeps the API key server-side). `action` selects normal (`txlist`) or
 * internal (`txlistinternal`) transfers — the proxy allows both. The proxy
 * ignores `page`/`offset`, so callers slice the (desc-sorted) result
 * client-side. Returns only schema-validated rows; throws a human-readable
 * Error on transport/upstream failure so callers can surface a retry + an
 * explorer fallback.
 */
export async function fetchAddressTxList(
  address: string,
  signal: AbortSignal,
  action: 'txlist' | 'txlistinternal' = 'txlist',
): Promise<TxRecord[]> {
  const res = await fetch(
    `/api/etherscan?module=account&action=${action}&address=${address}&sort=desc`,
    { signal },
  );
  // The proxy can return a Vercel HTML/comment error page instead of JSON
  // (e.g. during a deploy). r.json() on that body surfaces a cryptic parse
  // error — read text first and fall back to a readable message.
  const text = await res.text();
  let data: { status?: string; message?: string; result?: unknown };
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      res.ok
        ? 'Activity service returned an unexpected response. Try again shortly.'
        : `Activity service unavailable (HTTP ${res.status}). Try again shortly.`,
    );
  }
  if (data.status === '1' && Array.isArray(data.result)) return parseTxRecords(data.result);
  // Etherscan returns status '0' + "No transactions found" for an empty history.
  if (data.status === '0' && data.message === 'No transactions found') return [];
  const raw = (data.message || '').toString();
  const looksLikeAuthIssue =
    raw === 'NOTOK' || /api\s*key/i.test(typeof data.result === 'string' ? data.result : '');
  throw new Error(
    looksLikeAuthIssue
      ? "Tegridy Farms can't reach Etherscan right now."
      : raw || 'Failed to load activity. Try again later.',
  );
}
