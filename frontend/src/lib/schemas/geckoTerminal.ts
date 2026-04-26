// R080: zod schemas for GeckoTerminal API responses consumed by:
//   - useToweliPrice.ts → `simple/networks/eth/token_price/{addr}`
//   - usePriceHistory.ts → `networks/eth/pools/{pool}/ohlcv/{period}`
//
// Until R080, both call sites consumed `r.json()` as `any` and walked nested
// keys with optional chaining. A malicious or simply broken upstream could
// inject NaN strings, arrays where objects were expected, or extra fields
// that the UI then rendered. These schemas validate the minimum surface the
// hooks actually read — anything outside the spec returns null from
// `parseOrNull` (matching the existing "fall back to on-chain" semantics).
//
// The `token_price` endpoint returns prices keyed by lowercase token address.
// We accept the dynamic key by allowing arbitrary string keys whose values
// are decimal-ish strings (GT returns "0.00012345" form). Numeric strings
// containing scientific notation are rejected — Number() loses precision and
// upstream is expected to send plain decimals.

import { z } from 'zod';

// Decimal-ish: digits with optional decimal portion. Reject scientific
// notation explicitly (".e", "e", "E") and infinities / NaN.
const decimalStringSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string');

// `token_prices` is a map of `{ <lowercase-address>: "<decimal>" }`. zod
// `record` with a string key + decimalStringSchema value covers it.
export const geckoTerminalTokenPriceSchema = z.object({
  data: z.object({
    attributes: z.object({
      token_prices: z.record(z.string(), decimalStringSchema),
    }),
  }),
});

/// OHLCV: `[timestamp, open, high, low, close, volume]`. Values are numbers
/// per the docs; some pools return zero volume which is fine.
export const geckoTerminalOhlcvSchema = z.object({
  data: z.object({
    attributes: z.object({
      ohlcv_list: z.array(
        z.tuple([
          z.number(), // timestamp (unix seconds)
          z.number(), // open
          z.number(), // high
          z.number(), // low
          z.number(), // close
          z.number(), // volume
        ]),
      ),
    }),
  }),
});

/**
 * Convenience helper: run `safeParse` and return the parsed data or null.
 * Mirrors the helper in `aggregator.ts` so consumers can colocate the
 * import with the schema they validate against.
 */
export function parseOrNull<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
): z.infer<T> | null {
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}
