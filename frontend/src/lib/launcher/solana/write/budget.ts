// Compute limit and priority fee for our own transactions.
//
// The limit comes from the simulation (units used + 15%), so a transaction never
// asks for, or pays priority on, compute it will not use. The price is the 75th
// percentile of recent priority fees on the accounts this transaction writes, and
// then CAPPED so the whole priority fee is at most `MAX_OWN_PRIORITY_LAMPORTS`.
//
// The cap is lower than the swap page's 0.005 SOL (jupiter.ts MAX_PRIORITY_LAMPORTS)
// on purpose: 0.005 SOL is half of a 0.01 SOL buy. Anyone can raise the recent fees
// on a public account by paying them, so the percentile is a hint, never a promise;
// the cap is what bounds it. If the fee read fails the price is 0 and the review
// says so, rather than guessing.

import { ComputeBudgetProgram, type PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { priorityLamports } from './intent';
import type { WriteRpc } from './types';

/** 0.001 SOL. The most priority fee any transaction built here may carry. */
export const MAX_OWN_PRIORITY_LAMPORTS = 1_000_000n;

/** Solana's per-transaction ceiling. */
export const MAX_COMPUTE_UNITS = 1_400_000;

/** 5,000 lamports per signature: the protocol's fixed base fee. */
export const LAMPORTS_PER_SIGNATURE = 5_000n;

/** Units used in simulation + 15%, at least 1,000 more than used, never above the ceiling. */
export function computeLimitFromSimulation(unitsConsumed: number | undefined, floor = 0): number {
  const used = typeof unitsConsumed === 'number' && Number.isFinite(unitsConsumed) && unitsConsumed > 0
    ? Math.ceil(unitsConsumed)
    : MAX_COMPUTE_UNITS;
  const padded = Math.max(Math.ceil((used * 115) / 100), used + 1_000, floor);
  return Math.min(padded, MAX_COMPUTE_UNITS);
}

/** The highest price (µ-lamports per unit) that keeps `limit` units within `capLamports`. */
export function maxPriceForCap(limit: number, capLamports: bigint = MAX_OWN_PRIORITY_LAMPORTS): bigint {
  if (limit <= 0) return 0n;
  return (capLamports * 1_000_000n) / BigInt(limit);
}

/** 75th percentile of the samples, or 0 for none. */
export function percentile75(samples: readonly number[]): bigint {
  const xs = samples.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (xs.length === 0) return 0n;
  const idx = Math.min(xs.length - 1, Math.ceil(xs.length * 0.75) - 1);
  return BigInt(Math.floor(xs[idx]!));
}

export interface PriorityChoice {
  microLamports: bigint;
  /** False when the fee read failed and the price fell back to 0. */
  read: boolean;
}

export async function choosePriorityPrice(
  rpc: Pick<WriteRpc, 'getRecentPrioritizationFees'>,
  writable: PublicKey[],
  limit: number,
  capLamports: bigint = MAX_OWN_PRIORITY_LAMPORTS,
): Promise<PriorityChoice> {
  let samples: number[];
  try {
    const r = await rpc.getRecentPrioritizationFees({ lockedWritableAccounts: writable.slice(0, 128) });
    if (!Array.isArray(r)) return { microLamports: 0n, read: false };
    samples = r.map((x) => x?.prioritizationFee).filter((x): x is number => typeof x === 'number');
  } catch {
    return { microLamports: 0n, read: false };
  }
  const want = percentile75(samples);
  const cap = maxPriceForCap(limit, capLamports);
  return { microLamports: want < cap ? want : cap, read: true };
}

export function computeBudgetIxs(limit: number, microLamports: bigint): TransactionInstruction[] {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: limit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

export { priorityLamports };
