// Jupiter Swap API client for the Solana fee-capture surface (Surface A).
//
// All calls go to our same-origin hardened proxy (/api/jupiter/*), which
// forwards to lite-api.jup.ag server-side. Supports ANY pair. The platform fee
// is attached ONLY when a leg of the pair is in our pre-created fee-ATA set
// {wSOL, USDC}: Jupiter requires the fee account to already exist, and for
// ExactIn the fee mint may be the input OR output side — so that one set covers
// both directions of any pair touching SOL/USDC. For any other pair the swap
// runs fee-free, so an arbitrary pair can never break. No own program.
import { PublicKey } from '@solana/web3.js';
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
 */
function feeAccountFor(feeMint: string): string | null {
  if (!SOLANA_FEE_ACCOUNT) return null;
  try {
    const owner = new PublicKey(SOLANA_FEE_ACCOUNT);
    return getAssociatedTokenAddressSync(new PublicKey(feeMint), owner, true).toBase58();
  } catch {
    return null;
  }
}

export async function getQuote(params: {
  inputMint: string;
  outputMint: string;
  /** Integer amount in the INPUT mint's base units. */
  amount: string;
  slippageBps: number;
  signal?: AbortSignal;
}): Promise<JupiterQuote> {
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
  if (feeEnabled() && pickFeeMint(params.inputMint, params.outputMint)) {
    qs.set('platformFeeBps', String(SOLANA_PLATFORM_FEE_BPS));
  }
  const res = await fetch(`${JUPITER_PROXY_BASE}/quote?${qs.toString()}`, {
    headers: { Accept: 'application/json' },
    signal: params.signal,
  });
  if (!res.ok) throw new Error(`Quote unavailable (${res.status})`);
  return (await res.json()) as JupiterQuote;
}

/**
 * Build the (unsigned) swap transaction from a quote. Returns the base64
 * `swapTransaction` (a serialized VersionedTransaction) for the wallet to sign.
 */
export async function buildSwapTransaction(params: {
  quote: JupiterQuote;
  userPublicKey: string;
}): Promise<string> {
  // Derive the fee account from the SAME pair-aware decision as the quote, so
  // platformFeeBps + feeAccount stay coupled (both present, or neither).
  const feeMint = feeEnabled()
    ? pickFeeMint(params.quote.inputMint, params.quote.outputMint, params.quote.swapMode)
    : null;
  const feeAccount = feeMint ? feeAccountFor(feeMint) : null;
  const body: Record<string, unknown> = {
    quoteResponse: params.quote,
    userPublicKey: params.userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
  };
  if (feeAccount) body.feeAccount = feeAccount;
  const res = await fetch(`${JUPITER_PROXY_BASE}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Could not build swap (${res.status})`);
  const json = (await res.json()) as { swapTransaction?: string };
  if (!json.swapTransaction) throw new Error('No swap transaction returned');
  return json.swapTransaction;
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

/** Convert an integer base-unit string back to a human decimal string. */
export function fromBaseUnits(raw: string, decimals: number): string {
  if (decimals === 0) return raw;
  const s = raw.padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
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

/**
 * Pre-sign simulation of a built swap tx via our RPC proxy. Catches reverting
 * swaps (honeypots, freeze, slippage, insufficient balance) BEFORE the user
 * signs — saving gas. Best-effort: callers should FAIL OPEN if this throws.
 */
export async function simulateSwap(b64Tx: string, signal?: AbortSignal): Promise<{ ok: boolean; reason: string | null }> {
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
  if (value.err === null || value.err === undefined) return { ok: true, reason: null };
  return { ok: false, reason: parseSimError(value.err, value.logs) };
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
