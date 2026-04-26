// R080: zod schemas for the 7 DEX aggregator response shapes used by
// `frontend/src/lib/aggregator.ts`. Until R080, every aggregator response was
// consumed as `any` — a malicious or simply broken upstream could inject
// arbitrary fields and the client would happily wrap them into an
// `AggregatorQuote`. The schemas below validate the minimum surface that the
// aggregator code actually reads. Anything that doesn't match returns null
// from the parsing function (matching the existing "skip on error" semantics).
//
// Each schema is intentionally permissive on optional/extra fields (we use
// `passthrough` semantics by default) but strict on the load-bearing keys
// (`amountOut`, `priceImpact`, etc).

import { z } from 'zod';

// Common: numeric strings that must look like an integer in smallest units
const intStringSchema = z.string().regex(/^\d+$/, 'must be a non-negative integer string');
// Permissive integer-or-stringified-int (some aggregators return numbers)
const intLikeSchema = z.union([
  intStringSchema,
  z.number().int().nonnegative().transform((n) => n.toString()),
]);

// ─── SwapAPI.dev ─────────────────────────────────────────────────
export const swapApiResponseSchema = z.object({
  amountOut: intStringSchema,
  priceImpact: z.number().finite(),
  tx: z.object({ gas: z.string().optional() }).optional(),
});

// ─── Odos ────────────────────────────────────────────────────────
export const odosResponseSchema = z.object({
  outAmounts: z.array(intLikeSchema).min(1),
  priceImpact: z.number().finite().optional(),
  gasEstimate: z.union([z.string(), z.number()]).optional(),
});

// ─── CowSwap ─────────────────────────────────────────────────────
export const cowSwapResponseSchema = z.object({
  quote: z.object({
    buyAmount: intLikeSchema,
  }),
});

// ─── Li.Fi ───────────────────────────────────────────────────────
export const liFiResponseSchema = z.object({
  estimate: z.object({
    toAmount: intLikeSchema,
    gasCosts: z
      .array(z.object({ estimate: z.string().optional() }).passthrough())
      .optional(),
  }),
});

// ─── KyberSwap ───────────────────────────────────────────────────
export const kyberSwapResponseSchema = z.object({
  data: z.object({
    routeSummary: z.object({
      amountOut: intLikeSchema,
      gas: z.union([z.string(), z.number()]).optional(),
    }),
  }),
});

// ─── OpenOcean ───────────────────────────────────────────────────
export const openOceanResponseSchema = z.object({
  data: z.object({
    outAmount: intLikeSchema,
    price_impact: z.string().optional(),
    estimatedGas: z.union([z.string(), z.number()]).optional(),
  }),
});

// ─── ParaSwap ────────────────────────────────────────────────────
export const paraSwapResponseSchema = z.object({
  priceRoute: z.object({
    destAmount: intLikeSchema,
    gasCost: z.union([z.string(), z.number()]).optional(),
  }),
});

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
