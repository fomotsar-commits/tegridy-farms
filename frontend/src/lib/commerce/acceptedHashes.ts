// The merchant's own record of which transaction hashes they have already
// counted as paid.
//
// ─── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────
//
// receiptProof.ts can prove that a hash moved exactly `settleAmount` of exactly
// `settleToken` to exactly `merchant`. It cannot prove WHICH invoice that was
// for, because a plain ERC-20 transfer carries no reference. So a buyer holding
// one paid hash could present it against a second invoice of the same merchant
// for the same amount, and every on-chain check would pass. The only defence
// available without a new contract is the merchant remembering.
//
// ─── AND WHY IT IS HONEST ABOUT BEING WEAK ──────────────────────────────────
//
// This is localStorage. It lives in ONE browser, on ONE device, and it is gone
// with a cleared cache. It is a hint that says "you have seen this hash before",
// not a settlement system, and the panel that reads it says exactly that in the
// merchant's own copy. A ledger presented as authoritative would be worse than
// no ledger, because it would invite a merchant to trust the absence of a row.
//
// Follows the copytrade/follows.ts pattern: versioned envelope, safeGetItem /
// safeSetItem so a private-mode browser refusing the write is a returned false
// rather than a throw, a cap, and rows that no longer decode are DROPPED rather
// than repaired — a repaired row here would be an invoice id nobody chose.

import { safeGetItem, safeJsonParse, safeSetItem } from '../storage';
import { TX_HASH_RE } from './settlement';

/** `tegridy_` prefix so storage.ts's quota eviction can reclaim it; never rendered. */
export const ACCEPTED_HASHES_KEY = 'tegridy_commerce_accepted_hashes';

/** Rows kept per browser. Oldest fall off — a hint, not an archive. */
export const MAX_ACCEPTED_HASHES = 300;

export interface AcceptedHash {
  /** The payee this was accepted for. Lowercased. */
  merchant: string;
  chainId: number;
  /** Lowercased, so a hash pasted in a different case is still the same hash. */
  txHash: string;
  /** The invoice the merchant said this paid. */
  invoiceId: string;
  /** Unix seconds the merchant pressed accept. Not when anything was mined. */
  acceptedAt: number;
}

interface AcceptedEnvelope {
  v: 1;
  rows: AcceptedHash[];
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

function decodeRow(raw: unknown): AcceptedHash | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<AcceptedHash>;
  if (typeof r.merchant !== 'string' || !ADDRESS_RE.test(r.merchant)) return null;
  if (typeof r.txHash !== 'string' || !TX_HASH_RE.test(r.txHash)) return null;
  if (typeof r.invoiceId !== 'string' || r.invoiceId.length === 0) return null;
  if (typeof r.chainId !== 'number' || !Number.isInteger(r.chainId)) return null;
  if (typeof r.acceptedAt !== 'number' || !Number.isFinite(r.acceptedAt)) return null;
  return {
    merchant: r.merchant.toLowerCase(),
    chainId: r.chainId,
    txHash: r.txHash.toLowerCase(),
    invoiceId: r.invoiceId,
    acceptedAt: r.acceptedAt,
  };
}

/** Every row in this browser. A corrupt envelope reads as empty, never as a throw. */
export function loadAcceptedHashes(): AcceptedHash[] {
  const envelope = safeJsonParse<Partial<AcceptedEnvelope> | null>(safeGetItem(ACCEPTED_HASHES_KEY), null);
  if (!envelope || !Array.isArray(envelope.rows)) return [];
  const out: AcceptedHash[] = [];
  for (const row of envelope.rows) {
    const decoded = decodeRow(row);
    if (decoded) out.push(decoded);
  }
  return out.slice(0, MAX_ACCEPTED_HASHES);
}

/** This merchant's rows only. A merchant never sees another merchant's ledger. */
export function loadAccepted(merchant: string): AcceptedHash[] {
  const wanted = merchant.toLowerCase();
  return loadAcceptedHashes().filter((r) => r.merchant === wanted);
}

/**
 * The invoice a hash was already accepted for, or null.
 *
 * Keyed on (merchant, chainId, txHash): the same 32 bytes on two chains are two
 * different transactions, and treating them as one would flag an honest payment.
 */
export function previouslyAcceptedFor(merchant: string, chainId: number, txHash: string): string | null {
  const m = merchant.toLowerCase();
  const h = txHash.toLowerCase();
  return loadAcceptedHashes().find((r) => r.merchant === m && r.chainId === chainId && r.txHash === h)?.invoiceId ?? null;
}

/**
 * Write one acceptance. False when the browser refused the write.
 *
 * The caller must say so rather than assume it stuck — a merchant who believes a
 * hash was recorded and finds it missing next week has been told something
 * untrue by this function's silence.
 */
export function recordAccepted(
  merchant: string,
  chainId: number,
  txHash: string,
  invoiceId: string,
  now: number,
): boolean {
  if (!ADDRESS_RE.test(merchant) || !TX_HASH_RE.test(txHash)) return false;
  const row: AcceptedHash = {
    merchant: merchant.toLowerCase(),
    chainId,
    txHash: txHash.toLowerCase(),
    invoiceId,
    acceptedAt: now,
  };
  // Newest first, and an existing acceptance for the same (merchant, chain,
  // hash) is NOT overwritten: the first invoice it was counted for is the fact
  // that makes a second presentation detectable.
  const existing = loadAcceptedHashes();
  if (existing.some((r) => r.merchant === row.merchant && r.chainId === row.chainId && r.txHash === row.txHash)) {
    return true;
  }
  const envelope: AcceptedEnvelope = { v: 1, rows: [row, ...existing].slice(0, MAX_ACCEPTED_HASHES) };
  return safeSetItem(ACCEPTED_HASHES_KEY, JSON.stringify(envelope));
}
