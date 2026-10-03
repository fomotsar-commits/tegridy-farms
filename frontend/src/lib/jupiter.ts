// Jupiter Swap API client for the Solana fee-capture surface (Surface A).
//
// All calls go to our same-origin hardened proxy (/api/jupiter/*), which
// forwards to lite-api.jup.ag server-side. Supports ANY pair. The platform fee
// is attached ONLY when a leg of the pair is in our pre-created fee-ATA set
// {wSOL, USDC}: Jupiter requires the fee account to already exist, and for
// ExactIn the fee mint may be the input OR output side — so that one set covers
// both directions of any pair touching SOL/USDC. For any other pair the swap
// runs fee-free, so an arbitrary pair can never break. No own program.
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  JUPITER_PROXY_BASE,
  JUPITER_TOKENS_BASE,
  SOLANA_RPC_PROXY_PATH,
  SOLANA_FEE_ACCOUNT,
  SOLANA_PLATFORM_FEE_BPS,
  SOL_MINT,
  USDC_MINT,
} from './solana';

// We only read a few fields; the whole object is passed back to /swap verbatim,
// so keep an index signature for the rest of Jupiter's response shape.
export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
  /** Jupiter's own record of the platform fee this quote was priced with. Null or absent on a no-fee quote. */
  platformFee?: { amount?: string; feeBps?: number } | null;
  [key: string]: unknown;
}

/**
 * Pick the fee mint for a pair, or null for no fee. We can only collect a fee in
 * a mint whose ATA the fee wallet has pre-created — that set is {wSOL, USDC}
 * (both legacy SPL). For ExactIn the fee mint may be either leg, so this one set
 * covers both directions of any pair touching SOL or USDC; ExactOut allows the
 * input mint only. Prefer USDC (stable, no wSOL dust). Pure / env-independent so
 * it's unit-testable; the configured-and-enabled gating lives at the call sites.
 */
export function pickFeeMint(
  inputMint: string,
  outputMint: string,
  swapMode: string = 'ExactIn',
): string | null {
  const candidates = swapMode === 'ExactOut' ? [inputMint] : [inputMint, outputMint];
  if (candidates.includes(USDC_MINT)) return USDC_MINT;
  if (candidates.includes(SOL_MINT)) return SOL_MINT;
  return null;
}

/** A platform fee can be collected only when a fee account is configured + bps > 0. */
function feeEnabled(): boolean {
  return SOLANA_FEE_ACCOUNT.length > 0 && SOLANA_PLATFORM_FEE_BPS > 0;
}

/**
 * Derive the fee token account (ATA of `feeMint` owned by the fee wallet).
 * `feeMint` is always legacy SPL {wSOL, USDC}, so the default token program is
 * correct. `allowOwnerOffCurve = true` because the owner may be a Squads PDA.
 * Exported for tests only: nothing outside this file decides a fee account.
 */
export function feeAccountFor(feeMint: string): string | null {
  if (!SOLANA_FEE_ACCOUNT) return null;
  try {
    const owner = new PublicKey(SOLANA_FEE_ACCOUNT);
    return getAssociatedTokenAddressSync(new PublicKey(feeMint), owner, true).toBase58();
  } catch {
    return null;
  }
}

/**
 * Would a swap of this pair be built WITH the platform fee? The one decision
 * getQuote and buildSwapTransaction both follow, exported so the send path can
 * tell "a fee-bearing build failed" from "there was never a fee to drop".
 */
export function swapCarriesPlatformFee(inputMint: string, outputMint: string, swapMode: string = 'ExactIn'): boolean {
  return feeEnabled() && pickFeeMint(inputMint, outputMint, swapMode) !== null;
}

/** Does this quote say, in Jupiter's own field, that a platform fee is priced in? */
export function quoteHasPlatformFee(quote: JupiterQuote): boolean {
  const pf = quote.platformFee;
  if (pf === null || pf === undefined) return false;
  if (typeof pf !== 'object') return true;
  const zeroBps = pf.feeBps === undefined || pf.feeBps === 0;
  const zeroAmount = pf.amount === undefined || pf.amount === '0';
  return !(zeroBps && zeroAmount);
}

export interface QuoteParams {
  inputMint: string;
  outputMint: string;
  /** Integer amount in the INPUT mint's base units. */
  amount: string;
  slippageBps: number;
  signal?: AbortSignal;
  /**
   * Ask for the quote with NO platform fee even on a fee-supported pair. Only
   * the fee retry in lib/solana/swap/jupiterFeeRetry.ts sets this, and only
   * after the fee-bearing build failed simulation with Jupiter's 6014.
   */
  noPlatformFee?: boolean;
}

/** The one quote request both readers send, and the platform fee it carried (null: none). */
function quoteRequest(params: QuoteParams): { url: string; feeBpsSent: number | null } {
  const qs = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    slippageBps: String(params.slippageBps),
    swapMode: 'ExactIn',
    restrictIntermediateTokens: 'true',
  });
  // Attach the platform fee ONLY when a leg of the pair is fee-supported. The
  // SAME decision drives /swap, so platformFeeBps is never sent without a
  // matching feeAccount (which Jupiter rejects) and the fee account always exists.
  let feeBpsSent: number | null = null;
  if (!params.noPlatformFee && feeEnabled() && pickFeeMint(params.inputMint, params.outputMint)) {
    qs.set('platformFeeBps', String(SOLANA_PLATFORM_FEE_BPS));
    feeBpsSent = SOLANA_PLATFORM_FEE_BPS;
  }
  return { url: `${JUPITER_PROXY_BASE}/quote?${qs.toString()}`, feeBpsSent };
}

/**
 * The older reader: it THROWS for every answer that is not a quote, so its
 * caller cannot tell "Jupiter has no route" from "Jupiter could not be read".
 * The swap page still calls it; the page half of SPEC_S3 step S1 moves the page
 * to readQuote below and deletes this.
 */
export async function getQuote(params: QuoteParams): Promise<JupiterQuote> {
  const res = await fetch(quoteRequest(params).url, {
    headers: { Accept: 'application/json' },
    signal: params.signal,
  });
  if (!res.ok) throw new Error(`Quote unavailable (${res.status})`);
  return (await res.json()) as JupiterQuote;
}

/** The proxy's "no route" answer: `{"error":"No route","code":"NO_ROUTE"}` (api/_lib/aggregator-proxy.js). */
export async function isNoRouteBody(res: Response): Promise<boolean> {
  try {
    const body = (await res.json()) as { code?: unknown } | null;
    return body !== null && typeof body === 'object' && body.code === 'NO_ROUTE';
  } catch {
    return false;
  }
}

/**
 * One quote request, with its three honest answers kept apart:
 *   - `quote`: Jupiter priced THIS trade. `feeBpsSent` is the platformFeeBps the
 *     request carried (null: none), which jupiterNet needs to know what
 *     `outAmount` means;
 *   - `no-route`: Jupiter answered that it has no route. Only our proxy's fixed
 *     404 body (`code: "NO_ROUTE"`) is that answer;
 *   - `unread`: anything else. A 502, a 429, a network error, bad JSON, any
 *     other 404, an answer for a different trade, an answer without amounts.
 * "Unread" is never "no route": a page that says "No route" while Jupiter is
 * down sends people away from a trade that exists, and a route rule that reads
 * a down Jupiter as "no competitor" would let any pool win against nothing.
 */
export type QuoteRead =
  | { kind: 'quote'; quote: JupiterQuote; feeBpsSent: number | null }
  | { kind: 'no-route' }
  | { kind: 'unread'; detail: string };

const RAW_AMOUNT = /^\d{1,30}$/;

/** Never throws, except to pass on an AbortError (the caller cancelled; that is not an answer). */
export async function readQuote(params: QuoteParams): Promise<QuoteRead> {
  const { url, feeBpsSent } = quoteRequest(params);
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal: params.signal });
  } catch (e) {
    if (isAbort(e)) throw e;
    return { kind: 'unread', detail: 'Jupiter could not be reached' };
  }
  if (res.status === 404 && (await isNoRouteBody(res))) return { kind: 'no-route' };
  if (!res.ok) return { kind: 'unread', detail: `Jupiter did not give a price (HTTP ${res.status})` };
  let q: Partial<JupiterQuote> | null;
  try {
    q = (await res.json()) as Partial<JupiterQuote> | null;
  } catch (e) {
    if (isAbort(e)) throw e;
    return { kind: 'unread', detail: 'Jupiter’s answer could not be read' };
  }
  if (q === null || typeof q !== 'object' || Array.isArray(q)) return { kind: 'unread', detail: 'Jupiter’s answer could not be read' };
  if (q.inputMint !== params.inputMint || q.outputMint !== params.outputMint || q.inAmount !== params.amount) {
    return { kind: 'unread', detail: 'Jupiter answered for a different trade' };
  }
  if (typeof q.outAmount !== 'string' || !RAW_AMOUNT.test(q.outAmount) || BigInt(q.outAmount) <= 0n) {
    return { kind: 'unread', detail: 'Jupiter answered without an amount' };
  }
  return { kind: 'quote', quote: q as JupiterQuote, feeBpsSent };
}

function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

/**
 * The one platform-fee rate at which a Jupiter quote can be compared with one
 * of our own pools (SPEC_S3 D3, D4): 50 bps, the site's 0.5%. Committed, never
 * read from the environment; a build configured with any other rate simply
 * never gets a comparable number out of jupiterNet.
 */
export const COMPARABLE_PLATFORM_FEE_BPS = 50;

/**
 * What a trader receives through Jupiter for this trade AFTER our platform fee,
 * or null when the quote does not PROVE that its `outAmount` means that.
 *
 * Why not just read `outAmount`: whether it is before or after the platform fee
 * is Jupiter's convention, not ours, and it has drifted before on other
 * aggregators. Ranking our pool against a gross number would send trades to
 * whichever side the convention happens to favour. So the quote has to show its
 * own working. With S = the sum of `swapInfo.outAmount` over the legs that pay
 * out in the quote's output mint, all of these must hold:
 *   - the request carried platformFeeBps = 50, and the quote records feeBps 50;
 *   - platformFee.amount == floor(S x 50 / 10000);
 *   - outAmount + platformFee.amount == S;
 *   - the mints, the input amount and ExactIn echo what was asked.
 * Measured on mainnet 2026-10-03 on 7 of 7 pairs: one leg, three hops, a
 * four-leg split, split plus hop, both directions.
 *
 * Null means "unread", never "zero": Jupiter may still run the trade, but our
 * pool does not compete against a number whose meaning is not proven.
 */
export function jupiterNet(
  r: Extract<QuoteRead, { kind: 'quote' }>,
  asked: { inputMint: string; outputMint: string; amount: string },
): bigint | null {
  if (r.feeBpsSent !== COMPARABLE_PLATFORM_FEE_BPS) return null;
  const q = r.quote;
  if (q.inputMint !== asked.inputMint || q.outputMint !== asked.outputMint) return null;
  if (q.inAmount !== asked.amount || q.swapMode !== 'ExactIn') return null;
  if (typeof q.outAmount !== 'string' || !RAW_AMOUNT.test(q.outAmount)) return null;
  const pf = q.platformFee;
  if (pf === null || pf === undefined || typeof pf !== 'object') return null;
  if (pf.feeBps !== COMPARABLE_PLATFORM_FEE_BPS) return null;
  if (typeof pf.amount !== 'string' || !RAW_AMOUNT.test(pf.amount)) return null;
  if (!Array.isArray(q.routePlan) || q.routePlan.length === 0) return null;
  let sum = 0n;
  for (const leg of q.routePlan) {
    const info = (leg as { swapInfo?: { outputMint?: unknown; outAmount?: unknown } } | null)?.swapInfo;
    // Every leg must be readable, not only the final ones: a leg we cannot read
    // could be a final leg we failed to count.
    if (!info || typeof info.outputMint !== 'string') return null;
    if (typeof info.outAmount !== 'string' || !RAW_AMOUNT.test(info.outAmount)) return null;
    if (info.outputMint === q.outputMint) sum += BigInt(info.outAmount);
  }
  const out = BigInt(q.outAmount);
  const fee = BigInt(pf.amount);
  if (fee !== (sum * BigInt(COMPARABLE_PLATFORM_FEE_BPS)) / 10_000n) return null;
  if (out + fee !== sum) return null;
  // A plan with no leg paying the output mint sums to 0, so it ends here too.
  return out > 0n ? out : null;
}

/**
 * Priority-fee levels for the swap build ("Speed" in the UI). Each maps to
 * Jupiter's priorityLevelWithMaxLamports, hard-capped at MAX_PRIORITY_LAMPORTS
 * so a congestion spike can never charge more than the disclosed ceiling.
 */
export type PriorityLevel = 'medium' | 'high' | 'veryHigh';
export const MAX_PRIORITY_LAMPORTS = 5_000_000; // 0.005 SOL — disclosed in the UI

export interface BuildSwapParams {
  quote: JupiterQuote;
  userPublicKey: string;
  /** Omitted → Jupiter's default fee behavior (how v1 always ran). */
  priorityLevel?: PriorityLevel;
  /** Build with NO fee account. Must be paired with a quote taken with noPlatformFee. */
  noPlatformFee?: boolean;
}

export interface BuiltSwap {
  /** Base64 of a serialized VersionedTransaction, for the wallet to sign. */
  swapTransaction: string;
  /**
   * The last block height at which this transaction's blockhash is still valid,
   * as Jupiter reports it. Past it, a sent transaction that has not landed never
   * will. Null when the response did not carry a usable number: unknown, not 0.
   */
  lastValidBlockHeight: number | null;
}

/**
 * Build the (unsigned) swap transaction from a quote. Returns the base64
 * `swapTransaction` only. The swap page still calls this; the page half of
 * SPEC_S3 step S1 moves it to buildSwapWithExpiry and folds the two together.
 */
export async function buildSwapTransaction(params: BuildSwapParams): Promise<string> {
  return (await buildSwapWithExpiry(params)).swapTransaction;
}

/** The same build, with the block height the transaction expires at. */
export async function buildSwapWithExpiry(params: BuildSwapParams): Promise<BuiltSwap> {
  // A no-fee build of a quote that was priced WITH a fee would hand Jupiter
  // platformFeeBps and no feeAccount, which it rejects. Refuse it here so the
  // two halves cannot drift apart.
  if (params.noPlatformFee && quoteHasPlatformFee(params.quote)) {
    throw new Error('Could not build swap (the no-fee build was given a fee-bearing quote)');
  }
  // Derive the fee account from the SAME pair-aware decision as the quote, so
  // platformFeeBps + feeAccount stay coupled (both present, or neither).
  const feeMint = !params.noPlatformFee && feeEnabled()
    ? pickFeeMint(params.quote.inputMint, params.quote.outputMint, params.quote.swapMode)
    : null;
  const feeAccount = feeMint ? feeAccountFor(feeMint) : null;
  const body: Record<string, unknown> = {
    quoteResponse: params.quote,
    userPublicKey: params.userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
  };
  if (params.priorityLevel) {
    body.prioritizationFeeLamports = {
      priorityLevelWithMaxLamports: {
        maxLamports: MAX_PRIORITY_LAMPORTS,
        priorityLevel: params.priorityLevel,
      },
    };
  }
  if (feeAccount) body.feeAccount = feeAccount;
  const res = await fetch(`${JUPITER_PROXY_BASE}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Could not build swap (${res.status})`);
  const json = (await res.json()) as { swapTransaction?: string; lastValidBlockHeight?: unknown };
  if (!json.swapTransaction) throw new Error('No swap transaction returned');
  const height = json.lastValidBlockHeight;
  return {
    swapTransaction: json.swapTransaction,
    lastValidBlockHeight: typeof height === 'number' && Number.isSafeInteger(height) && height > 0 ? height : null,
  };
}

/** Convert a human decimal string to an integer base-unit string (no floats). */
export function toBaseUnits(amount: string, decimals: number): string | null {
  const m = amount.trim().match(/^(\d*)(?:\.(\d*))?$/);
  if (!m) return null;
  const whole = m[1] ?? '';
  const frac = (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  const combined = `${whole}${frac}`.replace(/^0+/, '');
  return combined === '' ? null : combined;
}

/**
 * Limit-order receive amount in the BUY token's base units, at full typed
 * precision. The naive shape — toBaseUnits(price, buyDecimals) first, multiply
 * after — silently truncates every typed price digit beyond the buy token's
 * decimals, flooring the order rate scaled by order size, and makes any
 * fractional price on a 0-decimal buy token unrepresentable (null). Parse the
 * price digits at their own scale instead and apply ONE floor at the end:
 *   taking = making × priceDigits × 10^buyDec ÷ (10^payDec × 10^priceScale)
 */
export function limitTakingAmount(
  makingAmount: string | null,
  price: string,
  payDecimals: number,
  buyDecimals: number,
): string | null {
  if (!makingAmount) return null;
  const m = price.trim().match(/^(\d*)(?:\.(\d*))?$/);
  if (!m) return null;
  const digits = `${m[1] ?? ''}${m[2] ?? ''}`;
  if (!/[1-9]/.test(digits)) return null;
  const priceScale = (m[2] ?? '').length;
  const taking =
    (BigInt(makingAmount) * BigInt(digits) * 10n ** BigInt(buyDecimals)) /
    (10n ** BigInt(payDecimals) * 10n ** BigInt(priceScale));
  return taking === 0n ? null : taking.toString();
}

/** Convert an integer base-unit string back to a human decimal string. */
export function fromBaseUnits(raw: string, decimals: number): string {
  if (decimals === 0) return raw;
  const s = raw.padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  // Trailing zeros stripped by index, NOT by /0+$/. That regex backtracks
  // quadratically on a long run of zeros (CodeQL js/polynomial-redos), and the
  // run length here is not ours to bound: `decimals` comes off the token, so a
  // hostile mint declaring a large value makes this string as long as it likes.
  // Walking back from the end is linear and cannot backtrack at all.
  const fracRaw = s.slice(s.length - decimals);
  let end = fracRaw.length;
  while (end > 0 && fracRaw[end - 1] === '0') end -= 1;
  const frac = fracRaw.slice(0, end);
  return frac ? `${whole}.${frac}` : whole;
}

// ─── Conversion polish: USD prices + route transparency ─────────────────────

/** USD prices for a set of mints in one keyless price/v3 call (via our proxy). */
export async function getUsdPrices(mints: string[], signal?: AbortSignal): Promise<Record<string, number>> {
  const ids = [...new Set(mints.filter(Boolean))];
  if (ids.length === 0) return {};
  const res = await fetch(`${JUPITER_TOKENS_BASE}/price/v3?ids=${ids.join(',')}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`Price fetch failed (${res.status})`);
  const json = (await res.json()) as Record<string, { usdPrice?: number } | null>;
  const out: Record<string, number> = {};
  for (const [mint, v] of Object.entries(json)) {
    if (v && typeof v.usdPrice === 'number') out[mint] = v.usdPrice;
  }
  return out;
}

/** Distinct DEX names a quote routes through, e.g. ["Raydium","Orca"]. */
export function routeLabels(quote: JupiterQuote): string[] {
  const plan = quote.routePlan;
  if (!Array.isArray(plan)) return [];
  const labels = plan
    .map((s) => (s as { swapInfo?: { label?: string } })?.swapInfo?.label)
    .filter((l): l is string => typeof l === 'string' && l.length > 0);
  return [...new Set(labels)];
}

// ─── Trust & safety: Shield warnings + pre-sign simulation ──────────────────

export interface ShieldWarning {
  type?: string;
  message: string;
  /** 'info' | 'warning' — the two tiers Jupiter Shield emits. Render by severity. */
  severity: string;
}

/**
 * Jupiter Shield — curated per-mint risk warnings (honeypot / freeze authority /
 * transfer fee / low liquidity …). Keyless via our proxy. Call once per pair on
 * token-select; render by SEVERITY, never switch on `type` (Jupiter adds codes).
 * Returns a map of mint → warnings.
 */
export async function getShield(mints: string[], signal?: AbortSignal): Promise<Record<string, ShieldWarning[]>> {
  const ids = [...new Set(mints.filter(Boolean))];
  if (ids.length === 0) return {};
  const res = await fetch(`${JUPITER_TOKENS_BASE}/ultra/v1/shield?mints=${ids.join(',')}`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`Shield failed (${res.status})`);
  const json = (await res.json()) as { warnings?: Record<string, ShieldWarning[]> };
  const warnings = json.warnings;
  if (!warnings || typeof warnings !== 'object') return {};
  const out: Record<string, ShieldWarning[]> = {};
  for (const [mint, list] of Object.entries(warnings)) {
    if (Array.isArray(list)) {
      out[mint] = list.filter((w): w is ShieldWarning => !!w && typeof w.message === 'string' && typeof w.severity === 'string');
    }
  }
  return out;
}

function parseSimError(err: unknown, logs?: string[]): string {
  const failLog = (logs ?? []).find((l) => /failed|insufficient|slippage|custom program error|0x/i.test(l));
  if (failLog) return failLog.replace(/^Program (log|failed): /, '').slice(0, 140);
  const errStr = typeof err === 'string' ? err : JSON.stringify(err);
  return errStr.slice(0, 140);
}

/** Jupiter's aggregator program (v6), the only program whose 6014 the fee retry listens to. */
export const JUPITER_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
/** Jupiter v6 custom error 6014 (0x177e), IncorrectTokenProgramID. */
export const JUPITER_INCORRECT_TOKEN_PROGRAM_ID = 6014;
const JUPITER_6014_LOG = `Program ${JUPITER_PROGRAM_ID} failed: custom program error: 0x177e`;
// The runtime's own failure line. A program cannot forge it: anything a program
// prints arrives as "Program log: ...", which this anchored pattern never matches.
const PROGRAM_FAILED_LINE = /^Program [1-9A-HJ-NP-Za-km-z]{32,44} failed: /;

/**
 * Did this simulation fail with EXACTLY Jupiter's 6014, raised BY the Jupiter
 * program? That is how a platform fee on the input side fails on a route whose
 * pool cannot take it (SOL -> BAYLA over Pump.fun AMM, 2026-10). It is the one
 * failure the send path may answer by rebuilding without the fee.
 *
 * All three must hold, and none of them can be set by a page URL, a token name
 * or a route label:
 *   1. the RPC's structured error is InstructionError[i, { Custom: 6014 }];
 *   2. instruction i of the transaction WE built is a call into Jupiter;
 *   3. the first program the runtime reports as failed is Jupiter, with that
 *      code. A pool or token program that fails first with its own 6014 (and
 *      lets Jupiter pass it up) is therefore NOT this error.
 * Anything unreadable is "no".
 */
export function isJupiterIncorrectTokenProgram(b64Tx: string, err: unknown, logs: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const ie = (err as { InstructionError?: unknown }).InstructionError;
  if (!Array.isArray(ie) || ie.length !== 2) return false;
  const index: unknown = ie[0];
  const detail: unknown = ie[1];
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return false;
  if (!detail || typeof detail !== 'object') return false;
  const keys = Object.keys(detail);
  if (keys.length !== 1 || keys[0] !== 'Custom') return false;
  if ((detail as { Custom?: unknown }).Custom !== JUPITER_INCORRECT_TOKEN_PROGRAM_ID) return false;
  try {
    const message = VersionedTransaction.deserialize(Uint8Array.from(atob(b64Tx), (c) => c.charCodeAt(0))).message;
    const ix = message.compiledInstructions[index];
    const program = ix ? message.staticAccountKeys[ix.programIdIndex] : undefined;
    if (!program || program.toBase58() !== JUPITER_PROGRAM_ID) return false;
  } catch {
    return false;
  }
  if (!Array.isArray(logs)) return false;
  const firstFailed: unknown = logs.find((l) => typeof l === 'string' && PROGRAM_FAILED_LINE.test(l));
  return firstFailed === JUPITER_6014_LOG;
}

export interface SwapSimulation {
  ok: boolean;
  reason: string | null;
  /** True only for Jupiter's own 6014: see isJupiterIncorrectTokenProgram. Never true when ok. */
  jupiterIncorrectTokenProgram: boolean;
}

/**
 * Pre-sign simulation of a built swap tx via our RPC proxy. Catches reverting
 * swaps (honeypots, freeze, slippage, insufficient balance) BEFORE the user
 * signs — saving gas. Callers FAIL CLOSED if this throws: a swap that could
 * not be simulated is not sent to the wallet (lib/solana/swap/jupiterSend.ts).
 * The swap page's own send path still runs the older rule, where an unreadable
 * FIRST simulation goes to the wallet, until the page half of SPEC_S3 step S1
 * moves it onto jupiterSend.
 */
export async function simulateSwap(b64Tx: string, signal?: AbortSignal): Promise<SwapSimulation> {
  const res = await fetch(SOLANA_RPC_PROXY_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'simulateTransaction',
      params: [b64Tx, { encoding: 'base64', replaceRecentBlockhash: true, sigVerify: false, commitment: 'processed' }],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Simulation failed (${res.status})`);
  const json = (await res.json()) as { result?: { value?: { err?: unknown; logs?: string[] } } };
  const value = json.result?.value;
  if (!value) throw new Error('No simulation result');
  if (value.err === null || value.err === undefined) return { ok: true, reason: null, jupiterIncorrectTokenProgram: false };
  return {
    ok: false,
    reason: parseSimError(value.err, value.logs),
    jupiterIncorrectTokenProgram: isJupiterIncorrectTokenProgram(b64Tx, value.err, value.logs),
  };
}

// ─── Limit orders (Jupiter Trigger — real on-chain, keeper-filled) ──────────

export interface TriggerOrder {
  orderKey?: string;
  publicKey?: string;
  inputMint?: string;
  outputMint?: string;
  makingAmount?: string;
  takingAmount?: string;
  account?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Create a limit order. Returns the base64 transaction for the wallet to
 * sign+send (same flow as a swap). v1 ships FEE-OFF — integrator fees need a
 * Jupiter referral-account setup (operator-gated follow-up).
 */
export async function createTriggerOrder(params: {
  inputMint: string;
  outputMint: string;
  maker: string;
  makingAmount: string;
  takingAmount: string;
  expiredAt?: number;
}): Promise<string> {
  const body: Record<string, unknown> = {
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    maker: params.maker,
    payer: params.maker,
    params: {
      makingAmount: params.makingAmount,
      takingAmount: params.takingAmount,
      ...(params.expiredAt ? { expiredAt: String(params.expiredAt) } : {}),
    },
    computeUnitPrice: 'auto',
  };
  const res = await fetch(`${JUPITER_TOKENS_BASE}/trigger/v1/createOrder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Could not create order (${res.status})`);
  const json = (await res.json()) as { transaction?: string };
  if (!json.transaction) throw new Error('No order transaction returned');
  return json.transaction;
}

/** A wallet's active (unfilled) limit orders. */
export async function getTriggerOrders(user: string, signal?: AbortSignal): Promise<TriggerOrder[]> {
  const res = await fetch(`${JUPITER_TOKENS_BASE}/trigger/v1/getTriggerOrders?user=${user}&orderStatus=active`, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!res.ok) throw new Error(`Could not load orders (${res.status})`);
  const json = (await res.json()) as { orders?: TriggerOrder[] };
  return Array.isArray(json.orders) ? json.orders : [];
}

/** Cancel a limit order. Returns the base64 tx for the wallet to sign+send. */
export async function cancelTriggerOrder(maker: string, order: string): Promise<string> {
  const res = await fetch(`${JUPITER_TOKENS_BASE}/trigger/v1/cancelOrder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ maker, order, computeUnitPrice: 'auto' }),
  });
  if (!res.ok) throw new Error(`Could not cancel order (${res.status})`);
  const json = (await res.json()) as { transaction?: string };
  if (!json.transaction) throw new Error('No cancel transaction returned');
  return json.transaction;
}

/** Best-effort extraction of an order's pubkey (the field name varies). */
export function orderKeyOf(o: TriggerOrder): string | null {
  const a = o.account as Record<string, unknown> | undefined;
  if (typeof o.orderKey === 'string') return o.orderKey;
  if (typeof o.publicKey === 'string') return o.publicKey;
  if (a && typeof a.orderKey === 'string') return a.orderKey;
  return null;
}

// ─── DCA (Jupiter Recurring — time-based, keeper-executed) ──────────────────
//
// v1 is TIME-BASED only (recurringType 'time'); the price-based strategy and
// its deposit/withdraw legs are not plumbed — the proxy refuses them. Ships
// FEE-OFF like Trigger: integrator fees need a Jupiter referral-account setup
// (operator-gated follow-up).

export interface RecurringOrder {
  orderKey?: string;
  publicKey?: string;
  inputMint?: string;
  outputMint?: string;
  inDeposited?: string;
  inUsed?: string;
  inWithdrawn?: string;
  inAmountPerCycle?: string;
  cycleFrequency?: string;
  outReceived?: string;
  account?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Create a time-based DCA order. Returns the base64 transaction for the
 * wallet to sign+send (same flow as a swap). Jupiter deposits `inAmount`
 * up-front and the keeper spends inAmount/numberOfOrders every
 * `intervalSeconds`.
 */
export async function createRecurringOrder(params: {
  user: string;
  inputMint: string;
  outputMint: string;
  /** TOTAL deposit in the input mint's base units, split across all orders. */
  inAmount: string;
  numberOfOrders: number;
  intervalSeconds: number;
}): Promise<string> {
  // Jupiter's time params are JSON numbers (u64 upstream — a string is
  // rejected), so a base-units total past 2^53 would silently lose precision.
  // Refuse it instead of corrupting the deposit.
  const inAmount = Number(params.inAmount);
  if (!Number.isSafeInteger(inAmount) || inAmount <= 0) {
    throw new Error('DCA amount not representable');
  }
  const body: Record<string, unknown> = {
    user: params.user,
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    params: {
      time: {
        inAmount,
        numberOfOrders: params.numberOfOrders,
        interval: params.intervalSeconds,
      },
    },
  };
  const res = await fetch(`${JUPITER_TOKENS_BASE}/recurring/v1/createOrder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Could not create DCA (${res.status})`);
  const json = (await res.json()) as { transaction?: string };
  if (!json.transaction) throw new Error('No DCA transaction returned');
  return json.transaction;
}

/**
 * A wallet's active time-based DCA orders. `recurringType` and
 * `includeFailedTx` are REQUIRED by the upstream (it 400s without them), and
 * the response array is keyed by the requested type (`time`), not `orders`.
 */
export async function getRecurringOrders(user: string, signal?: AbortSignal): Promise<RecurringOrder[]> {
  const res = await fetch(
    `${JUPITER_TOKENS_BASE}/recurring/v1/getRecurringOrders?user=${user}&orderStatus=active&recurringType=time&includeFailedTx=false`,
    { headers: { Accept: 'application/json' }, signal },
  );
  if (!res.ok) throw new Error(`Could not load DCAs (${res.status})`);
  const json = (await res.json()) as { time?: RecurringOrder[] };
  return Array.isArray(json.time) ? json.time : [];
}

/** Cancel a DCA order. Returns the base64 tx for the wallet to sign+send. */
export async function cancelRecurringOrder(user: string, order: string): Promise<string> {
  const res = await fetch(`${JUPITER_TOKENS_BASE}/recurring/v1/cancelOrder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ user, order, recurringType: 'time' }),
  });
  if (!res.ok) throw new Error(`Could not cancel DCA (${res.status})`);
  const json = (await res.json()) as { transaction?: string };
  if (!json.transaction) throw new Error('No cancel transaction returned');
  return json.transaction;
}

/** Best-effort extraction of a DCA order's pubkey (the field name varies). */
export function recurringOrderKeyOf(o: RecurringOrder): string | null {
  const a = o.account as Record<string, unknown> | undefined;
  if (typeof o.orderKey === 'string') return o.orderKey;
  if (typeof o.publicKey === 'string') return o.publicKey;
  if (a && typeof a.orderKey === 'string') return a.orderKey;
  return null;
}
