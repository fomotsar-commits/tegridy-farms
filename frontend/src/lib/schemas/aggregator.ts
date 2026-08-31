// R080: zod schemas for the 7 DEX aggregator response shapes used by
// `frontend/src/lib/aggregator.ts` — WIRED 2026-08-28 at every provider
// `res.json()` boundary there. (The 08-28 frontend audit flagged them as
// shipped with zero production import sites; that gap is closed, and the
// wiring is mutation-checked in `../aggregatorSchemaWiring.test.ts`.)
//
// Until R080, every aggregator response was consumed as `any` — a malicious
// or simply broken upstream could inject arbitrary fields and the client
// would happily wrap them into an `AggregatorQuote`. The schemas below
// validate the minimum surface that the aggregator code actually reads.
// Anything that doesn't match returns null from `parseOrNull`, which drops
// that ONE provider's quote — the race itself never throws (matching the
// existing "skip on error" semantics).
//
// Strict on the load-bearing keys (`amountOut`, `priceImpact`, etc);
// `.passthrough()` on unknown keys and `.nullish()` on the cosmetic fields
// real providers null out (Odos returns `priceImpact: null` on some routes),
// so an additive upstream change never benches a healthy provider.

import { z } from 'zod';

// Common: numeric strings that must look like an integer in smallest units
const intStringSchema = z.string().regex(/^\d+$/, 'must be a non-negative integer string');
// Permissive integer-or-stringified-int (some aggregators return numbers)
const intLikeSchema = z.union([
  intStringSchema,
  z.number().int().nonnegative().transform((n) => n.toString()),
]);
// Cosmetic scalar (gas estimates, price-impact strings): the consumers
// String()/parseFloat() these behind their own typeof guards, so shape is all
// that matters here.
const scalarSchema = z.union([z.string(), z.number()]);

// ─── SwapAPI.dev ─────────────────────────────────────────────────
export const swapApiResponseSchema = z.object({
  amountOut: intStringSchema,
  priceImpact: z.number().finite(),
  tx: z.object({ gas: scalarSchema.nullish() }).passthrough().nullish(),
}).passthrough();

// ─── Odos ────────────────────────────────────────────────────────
export const odosResponseSchema = z.object({
  outAmounts: z.array(intLikeSchema).min(1),
  // nullish, not optional: real Odos routes carry `priceImpact: null`.
  priceImpact: z.number().finite().nullish(),
  gasEstimate: scalarSchema.nullish(),
}).passthrough();

// ─── CowSwap ─────────────────────────────────────────────────────
export const cowSwapResponseSchema = z.object({
  quote: z.object({
    buyAmount: intLikeSchema,
  }).passthrough(),
}).passthrough();

// ─── Li.Fi ───────────────────────────────────────────────────────
export const liFiResponseSchema = z.object({
  estimate: z.object({
    toAmount: intLikeSchema,
    gasCosts: z
      .array(z.object({ estimate: scalarSchema.nullish() }).passthrough())
      .nullish(),
  }).passthrough(),
}).passthrough();

// ─── KyberSwap ───────────────────────────────────────────────────
export const kyberSwapResponseSchema = z.object({
  data: z.object({
    routeSummary: z.object({
      amountOut: intLikeSchema,
      gas: scalarSchema.nullish(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

// ─── OpenOcean ───────────────────────────────────────────────────
export const openOceanResponseSchema = z.object({
  data: z.object({
    outAmount: intLikeSchema,
    price_impact: scalarSchema.nullish(),
    estimatedGas: scalarSchema.nullish(),
  }).passthrough(),
}).passthrough();

// ─── ParaSwap ────────────────────────────────────────────────────
export const paraSwapResponseSchema = z.object({
  priceRoute: z.object({
    destAmount: intLikeSchema,
    gasCost: scalarSchema.nullish(),
  }).passthrough(),
}).passthrough();

/**
 * Convenience helper: run `safeParse` and return the parsed data or null.
 * Use at every external API boundary — the call site keeps its existing
 * "return null on error" pattern but now the success path is fully typed.
 */
export function parseOrNull<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
): z.infer<T> | null {
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}
