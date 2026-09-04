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
 * An ERC-20 transfer row (`action=tokentx`).
 *
 * The token metadata columns are attacker-authored: `tokenSymbol` and
 * `tokenName` are whatever the contract's own `symbol()`/`name()` returned, and
 * anyone can deploy a token that claims to be "USDC" or `=HYPERLINK("…")`. They
 * are TRUNCATED here rather than rejected — a row dropped over a display field
 * is a transfer missing from somebody's tax report, which is the worse of the
 * two failures — and `lib/tax/ledger.ts` decides separately whether a claimed
 * symbol may be shown at all. Identity is `contractAddress`, never the symbol.
 *
 * `tokenDecimal` is likewise NOT a validation gate: Etherscan occasionally
 * returns it empty, and the ledger treats an unreadable value as "decimals
 * unknown" (displayed at 18, never used in arithmetic) instead of losing the
 * row.
 */
export const tokenTxRowSchema = z.object({
  hash: z.string().regex(HEX_HASH),
  from: z.string().regex(HEX_ADDR),
  to: z.string().regex(HEX_ADDR),
  contractAddress: z.string().regex(HEX_ADDR),
  value: z.string().regex(DEC_DIGITS).default('0'),
  tokenSymbol: z.string().default('').transform((s) => s.slice(0, 64)),
  tokenName: z.string().default('').transform((s) => s.slice(0, 64)),
  tokenDecimal: z.string().default('').transform((s) => s.slice(0, 3)),
  timeStamp: z.union([z.string().regex(DEC_DIGITS), z.number().int().nonnegative()])
    .transform((v) => String(v)),
  blockNumber: z.union([z.string().regex(DEC_DIGITS), z.number().int().nonnegative()])
    .transform((v) => String(v)),
});

export type TokenTxRow = z.infer<typeof tokenTxRowSchema>;

/** Every row an allowlisted account action can return. */
export type ExplorerRow = TxRecord | TokenTxRow;

/**
 * Which of the two row shapes this is.
 *
 * Narrowed on a field only the token schema has, so a caller holding a mixed
 * list never has to remember which action produced it. Note that the PARSE is
 * still chosen by action rather than by shape: a `tokentx` row also satisfies
 * `TxRecordSchema` (zod strips the unknown keys), so shape-sniffing at the
 * parse boundary would silently discard `contractAddress` and turn every token
 * transfer into a native one.
 */
export function isTokenTxRow(row: ExplorerRow): row is TokenTxRow {
  return 'contractAddress' in row;
}

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

/** `parseTxRecords` for `action=tokentx`. Never throws; drops only unparseable rows. */
export function parseTokenTxRows(input: unknown): TokenTxRow[] {
  if (!Array.isArray(input)) return [];
  const out: TokenTxRow[] = [];
  for (const raw of input) {
    const parsed = tokenTxRowSchema.safeParse(raw);
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

/** The account actions this rail reads. All three are allowlisted at api/etherscan.js:69-76. */
export type ExplorerAction = 'txlist' | 'txlistinternal' | 'tokentx';

/**
 * Rows asked for per page. 500 == MAX_OFFSET in api/etherscan.js, so the
 * proxy's clamp is a no-op and the page size the caller reasons about is the
 * page size that is sent.
 *
 * Sending page/offset at all is load-bearing. Without them Etherscan returns
 * its 10,000-row default; at ~700 B/row that is ~7 MB, over MAX_RESPONSE_BYTES
 * in api/_lib/bodycap.js, so the proxy answers 502 "Upstream response too
 * large" deterministically for any busy address — the failure documented at
 * useDeployerReputation.ts:104-114, which read as an outage rather than a bug.
 */
export const EXPLORER_PAGE_SIZE = 500;

/**
 * The URL for one page of one account action.
 *
 * `endblock` is sent ALONE and `startblock` is never sent: api/etherscan.js
 * rejects a span wider than 10k blocks only when BOTH bounds are present
 * (:169-174) and forwards a lone endblock (:197). Pinning the upper bound is
 * what makes multi-page reads consistent — without it a block mined between
 * page 1 and page 2 shifts every row down and a transaction falls through the
 * seam unnoticed.
 */
export function explorerPageUrl(
  action: ExplorerAction,
  address: string,
  page: number,
  offset: number = EXPLORER_PAGE_SIZE,
  endblock?: bigint,
): string {
  const q = new URLSearchParams({
    module: 'account',
    action,
    address: address.toLowerCase(),
    page: String(page),
    offset: String(offset),
    sort: 'desc',
  });
  if (endblock !== undefined) q.set('endblock', endblock.toString());
  return `/api/etherscan?${q.toString()}`;
}

export type ExplorerFailureReason =
  /** The proxy has no usable ETHERSCAN_API_KEY, so the upstream refused us. */
  | 'explorer-keyless'
  /** Etherscan throttled the deployment (its own 200-body envelope). */
  | 'explorer-rate-limited'
  /** Our own proxy throttled this browser (HTTP 429). */
  | 'proxy-rate-limited'
  /** The proxy answered non-2xx — upstream 502, deploy in flight, body cap. */
  | 'proxy-error'
  /** A 200 body we cannot trust: not JSON, or an envelope in no known shape. */
  | 'explorer-malformed';

export type ExplorerRead<T> =
  | {
      kind: 'rows';
      /** Rows that passed their schema. */
      rows: T[];
      /** The page came back at its limit, so more rows exist behind it. */
      full: boolean;
      /**
       * Rows the page contained and the schema refused.
       *
       * Reported rather than swallowed. A dropped row is a transaction the
       * caller will not see, and in a tax ledger an unseen transaction is the
       * failure the whole surface exists to prevent — so the count travels up
       * and is declared as a limitation on the export.
       */
      dropped: number;
      /**
       * Oldest `timeStamp` in the RAW page, or null when none was readable.
       *
       * Read off the raw rows on purpose: this is what a truncation boundary is
       * derived from, and deriving it from the VALIDATED rows meant a page whose
       * rows all failed the schema truncated the read while reporting no cut —
       * history dropped with nothing saying so, which is fail-open.
       */
      oldestRawAt: number | null;
    }
  | { kind: 'empty' }
  | { kind: 'failed'; reason: ExplorerFailureReason; detail: string };

/** Oldest readable `timeStamp` across raw explorer rows. Null when none is. */
function oldestRawTimestamp(raw: unknown[]): number | null {
  let oldest: number | null = null;
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const value = (entry as { timeStamp?: unknown }).timeStamp;
    const at = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
    if (!Number.isFinite(at)) continue;
    if (oldest === null || at < oldest) oldest = at;
  }
  return oldest;
}

/**
 * Read one page of one account action, WITHOUT throwing.
 *
 * ─── THE SHAPE RULE ────────────────────────────────────────────────────────
 *
 * Etherscan signals failure inside a 200 body and does not put the reason in
 * `message`: a refused read is
 * `{"status":"0","message":"NOTOK","result":"Missing/Invalid API Key"}` and a
 * throttled one is the same envelope with "Max rate limit reached" in `result`.
 * Its genuine empty answer is `{status:'0', message:'No transactions found',
 * result:[]}` — an ARRAY. So EMPTINESS IS A SHAPE, not a sentence. The prose
 * test this replaces (`message === 'No transactions found'`) meant a wording
 * change upstream turned "we could not read" into a thrown error at best and,
 * in the sibling implementation on /deployer, into "this address has no
 * history" — a claim about somebody's wallet manufactured out of our own
 * missing key. Copied from the pure rule at useDeployerReputation.ts:79-86.
 *
 * `full` is measured on the RAW result length, not on the validated rows: a
 * page that came back at its limit is a full page even if a row inside it
 * failed the schema, and treating it as short would end the read early and
 * silently truncate the history without declaring a gap.
 */
export async function readExplorerPage(
  action: ExplorerAction,
  address: string,
  page: number,
  signal: AbortSignal,
  endblock?: bigint,
  offset: number = EXPLORER_PAGE_SIZE,
): Promise<ExplorerRead<ExplorerRow>> {
  const res = await fetch(explorerPageUrl(action, address, page, offset, endblock), {
    headers: { accept: 'application/json' },
    signal,
  });
  if (res.status === 429) {
    return {
      kind: 'failed',
      reason: 'proxy-rate-limited',
      detail: 'Activity service is rate-limiting this deployment (HTTP 429). Nothing was read.',
    };
  }
  // The proxy can return a Vercel HTML/comment error page instead of JSON
  // (e.g. during a deploy). r.json() on that body surfaces a cryptic parse
  // error — read text first and fall back to a readable message.
  const text = await res.text();
  let data: { status?: string; message?: string; result?: unknown };
  try {
    data = JSON.parse(text) as { status?: string; message?: string; result?: unknown };
  } catch {
    return res.ok
      ? {
          kind: 'failed',
          reason: 'explorer-malformed',
          detail: 'Activity service returned an unexpected response. Try again shortly.',
        }
      : {
          kind: 'failed',
          reason: 'proxy-error',
          detail: `Activity service unavailable (HTTP ${res.status}). Try again shortly.`,
        };
  }
  if (!res.ok) {
    return {
      kind: 'failed',
      reason: 'proxy-error',
      detail: `Activity service unavailable (HTTP ${res.status}). Try again shortly.`,
    };
  }

  if (data.status === '1' && Array.isArray(data.result)) {
    const raw: unknown[] = data.result;
    const rows: ExplorerRow[] =
      action === 'tokentx' ? parseTokenTxRows(raw) : parseTxRecords(raw);
    return {
      kind: 'rows',
      rows,
      full: raw.length >= offset,
      dropped: raw.length - rows.length,
      oldestRawAt: oldestRawTimestamp(raw),
    };
  }
  if (data.status === '0' && Array.isArray(data.result)) return { kind: 'empty' };

  const reason = typeof data.result === 'string' ? data.result : '';
  const message = typeof data.message === 'string' ? data.message : '';
  if (/api\s*key/i.test(reason)) {
    return {
      kind: 'failed',
      reason: 'explorer-keyless',
      detail: "memetics.finance can't reach Etherscan right now.",
    };
  }
  if (/rate limit/i.test(reason) || /rate limit/i.test(message)) {
    return {
      kind: 'failed',
      reason: 'explorer-rate-limited',
      detail: 'The explorer is rate-limiting right now — try again in a moment.',
    };
  }
  return {
    kind: 'failed',
    reason: 'explorer-malformed',
    detail: message || 'Failed to load activity. Try again later.',
  };
}

/**
 * Fetch + validate one page of an address's normal or internal transaction
 * list via the server-side Etherscan proxy (keeps the API key server-side).
 *
 * A thin, THROWING wrapper over `readExplorerPage` — kept because
 * TreasuryPage.tsx:703-704 is written against the throwing contract, and its
 * messages are unchanged. The one behavioural difference for existing callers
 * is that the request is now bounded to one 500-row page, which is the fix
 * described on EXPLORER_PAGE_SIZE, not a new limitation: the proxy already
 * capped the answer, it just capped it by 502-ing.
 */
export async function fetchAddressTxList(
  address: string,
  signal: AbortSignal,
  action: 'txlist' | 'txlistinternal' = 'txlist',
): Promise<TxRecord[]> {
  const read = await readExplorerPage(action, address, 1, signal);
  if (read.kind === 'empty') return [];
  if (read.kind === 'rows') return read.rows.filter((r): r is TxRecord => !isTokenTxRow(r));
  throw new Error(read.detail);
}
