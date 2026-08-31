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

// ─────────────────────────────────────────────────────────────────────────────
// Pool market data — `networks/{network}/pools/{address}`.
//
// Added 2026-08-28 for the bungalow market strip (BAYLA/SOL on PumpSwap). Every
// numeric field arrives as a STRING, and several are legitimately absent:
// `market_cap_usd` is null for a pump.fun token that has no circulating-supply
// record, which is exactly why the UI must show FDV labelled as FDV rather than
// quietly printing one number under the other one's name. Absent stays absent
// here — nothing is defaulted to 0, because 0 and "unknown" are different facts.
// ─────────────────────────────────────────────────────────────────────────────

/** Signed decimal — price changes are negative about half the time. */
const signedDecimalStringSchema = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string');

/** A field that may be a decimal string, explicitly null, or missing. */
const optionalDecimal = decimalStringSchema.nullish();

const windowedDecimals = z
  .object({
    h1: signedDecimalStringSchema.nullish(),
    h6: signedDecimalStringSchema.nullish(),
    h24: signedDecimalStringSchema.nullish(),
  })
  .partial()
  .nullish();

export const geckoTerminalPoolSchema = z.object({
  data: z.object({
    attributes: z.object({
      name: z.string().nullish(),
      base_token_price_usd: optionalDecimal,
      fdv_usd: optionalDecimal,
      market_cap_usd: optionalDecimal,
      reserve_in_usd: optionalDecimal,
      price_change_percentage: windowedDecimals,
      volume_usd: windowedDecimals,
      transactions: z
        .object({
          h24: z
            .object({
              buys: z.number().nullish(),
              sells: z.number().nullish(),
              buyers: z.number().nullish(),
              sellers: z.number().nullish(),
            })
            .partial()
            .nullish(),
        })
        .partial()
        .nullish(),
    }),
  }),
});

// ─────────────────────────────────────────────────────────────────────────────
// Pool trades — `networks/{network}/pools/{address}/trades`.
//
// Backs the bungalow trade tape (the honest replacement for LiveActivity, which
// is TOWELI-denominated and muted in a bungalow). Only the fields the tape
// renders are pinned; `kind` is narrowed to the two values the UI can label,
// so an unknown third value fails validation rather than rendering unlabelled.
// ─────────────────────────────────────────────────────────────────────────────
export const geckoTerminalTradesSchema = z.object({
  data: z.array(
    z.object({
      attributes: z.object({
        block_timestamp: z.string(),
        kind: z.enum(['buy', 'sell']),
        tx_hash: z.string(),
        tx_from_address: z.string().nullish(),
        from_token_amount: decimalStringSchema.nullish(),
        to_token_amount: decimalStringSchema.nullish(),
        volume_in_usd: decimalStringSchema.nullish(),
      }),
    }),
  ),
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
