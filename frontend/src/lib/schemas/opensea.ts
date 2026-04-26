// R080: zod schemas for OpenSea v2 responses consumed via the
// `/api/opensea?path=...` proxy. Server-side R053 already passes responses
// through path-keyed schemas before forwarding, but the browser is the final
// trust boundary — a compromised CDN, a misrouted Vercel preview, or even a
// future schema drift can deliver a shape that the JS land assumes is safe.
//
// These schemas are the load-bearing fields the marketplace UI actually
// reads. Optional/extra OpenSea fields are tolerated (default zod object
// behaviour drops them on parse) so additive upstream changes don't break us
// — but the price/owner/identifier fields that flow into BigInt math, owner
// gating, and rendering are strict.
//
// All call sites in `src/nakamigos/api.js` / `api-offers.js` consume the
// proxy via `.json()`, then walk `data.listings`, `data.orders`,
// `data.asset_events`, etc. Apply via `parseOrNull(schema, data)` at every
// such boundary; `null` means "treat as empty" and the existing UI falls
// back to its empty-state.

import { z } from 'zod';

// Numeric strings — OpenSea returns wei as decimal-only strings. Reject
// scientific notation and negative values so `BigInt(value)` downstream
// can't throw.
const weiStringSchema = z.string().regex(/^\d+$/, 'wei must be a non-negative integer string');

// Lowercase hex address (0x + 40 hex chars) — viem-compatible literal.
const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x-prefixed 20-byte hex address');

// Token identifier: digits only (BigInt-safe).
const tokenIdSchema = z.string().regex(/^\d+$/, 'identifierOrCriteria must be a non-negative integer string');

// ─── Price ───────────────────────────────────────────────────────
// `price.current.value` carries the wei string; `currency` and `decimals`
// are optional but informational.
const priceCurrentSchema = z.object({
  current: z.object({
    value: weiStringSchema,
    currency: z.string().optional(),
    decimals: z.number().int().nonnegative().optional(),
  }),
});

// ─── Seaport `protocol_data` ─────────────────────────────────────
// Only the fields the renderer reads: `offer[0].identifierOrCriteria`,
// `parameters.offerer`, `parameters.endTime`. The rest of the parameters
// (consideration, salt, signatures, etc) flow through opaquely to the
// fulfillment request — we don't validate them here because the wallet
// signs over the canonical EIP-712 typed data on submit, not over the
// parsed JSON.
const seaportProtocolDataSchema = z.object({
  parameters: z.object({
    offerer: addressSchema,
    endTime: z.string().optional(), // unix-seconds string
    offer: z
      .array(
        z.object({
          identifierOrCriteria: tokenIdSchema.optional(),
        }).passthrough(),
      )
      .optional(),
  }).passthrough(),
}).passthrough();

// ─── `listings/collection/<slug>/best` ────────────────────────────
const listingItemSchema = z.object({
  order_hash: z.string().optional(),
  protocol_address: addressSchema.optional(),
  protocol_data: seaportProtocolDataSchema.optional(),
  price: priceCurrentSchema.optional(),
}).passthrough();

export const openSeaBestListingsResponseSchema = z.object({
  listings: z.array(listingItemSchema),
  next: z.string().nullable().optional(),
});

// ─── `orders/ethereum/seaport/(offers|listings)` ──────────────────
const orderItemSchema = z.object({
  order_hash: z.string().optional(),
  protocol_data: seaportProtocolDataSchema.optional(),
  current_price: weiStringSchema.optional(),
}).passthrough();

export const openSeaOrdersResponseSchema = z.object({
  orders: z.array(orderItemSchema),
  next: z.string().nullable().optional(),
});

// ─── `events/collection/<slug>` ──────────────────────────────────
const assetEventSchema = z.object({
  event_type: z.string().optional(),
  payment: z
    .object({
      quantity: weiStringSchema.optional(),
      token_address: addressSchema.optional(),
      decimals: z.number().int().nonnegative().optional(),
    })
    .partial()
    .optional(),
  nft: z
    .object({
      identifier: tokenIdSchema.optional(),
    })
    .passthrough()
    .optional(),
  transaction: z.string().optional(),
}).passthrough();

export const openSeaEventsResponseSchema = z.object({
  asset_events: z.array(assetEventSchema),
  next: z.string().nullable().optional(),
});

// ─── `collection(s)/<slug>/stats` ────────────────────────────────
export const openSeaCollectionStatsResponseSchema = z.object({
  total: z
    .object({
      volume: z.number().optional(),
      sales: z.number().optional(),
      floor_price: z.number().optional(),
      num_owners: z.number().optional(),
      market_cap: z.number().optional(),
    })
    .partial()
    .optional(),
  intervals: z
    .array(
      z.object({
        interval: z.string().optional(),
        volume: z.number().optional(),
        volume_change: z.number().optional(),
      }).passthrough(),
    )
    .optional(),
}).passthrough();

/**
 * Convenience helper: run `safeParse` and return the parsed data or null.
 * Mirrors the helper in `aggregator.ts` and `geckoTerminal.ts` so each
 * boundary reads consistently.
 */
export function parseOrNull<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
): z.infer<T> | null {
  const result = schema.safeParse(data);
  return result.success ? result.data : null;
}
