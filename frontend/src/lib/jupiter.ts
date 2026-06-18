// Jupiter Swap API client for the Solana fee-capture surface (Surface A).
//
// All calls go to our same-origin hardened proxy (/api/jupiter/*), which
// forwards to lite-api.jup.ag server-side. The platform fee is taken from the
// INPUT mint (so we only need a fee ATA for the small PAY_WITH set), via
// `platformFeeBps` on the quote + `feeAccount` on the swap. No own program.
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { JUPITER_PROXY_BASE, SOLANA_FEE_ACCOUNT, SOLANA_PLATFORM_FEE_BPS } from './solana';

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
 * Derive the platform-fee token account: an ATA of the INPUT mint owned by the
 * Tegridy fee wallet (SOLANA_FEE_ACCOUNT). `allowOwnerOffCurve = true` because
 * the owner may be a Squads vault PDA (off-curve). Returns null when no fee
 * account is configured (then no fee is charged).
 */
export function deriveFeeAccount(inputMint: string): string | null {
  if (!SOLANA_FEE_ACCOUNT) return null;
  try {
    const owner = new PublicKey(SOLANA_FEE_ACCOUNT);
    const mint = new PublicKey(inputMint);
    return getAssociatedTokenAddressSync(mint, owner, true).toBase58();
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
  // Only attach the platform fee when there's an account to receive it.
  if (SOLANA_FEE_ACCOUNT && SOLANA_PLATFORM_FEE_BPS > 0) {
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
  const feeAccount = deriveFeeAccount(params.quote.inputMint);
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
