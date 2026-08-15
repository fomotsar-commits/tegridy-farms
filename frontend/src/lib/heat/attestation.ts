// THE ATTESTATION SEAM — laid dark, on purpose. Wave 3, phase 06(c).
//
// The island has ruled that signed launch vouchers are coming. They are not here yet:
// there is no island key and no island route to fetch one from. This module exists so
// that the day the island publishes, the venue sets a route and changes nothing else.
//
// THE PINNED SHAPE, verbatim from the wave — do not "improve" it:
//
//   island-key signature over canonical JSON of
//   { address, degrees, tier, floor, as_of_unix, expires_unix, nonce }
//   island public key read from an island route that does not exist yet.
//
// ## Why the return is a state and not a boolean
//
// A dark seam has one characteristic way of going wrong: it quietly becomes
// load-bearing. Someone wires this into the gate, it returns falsy because nothing is
// configured, the caller reads falsy as "not attested", and a check that has never run
// starts deciding who may launch. The venue would then be enforcing a verdict the
// island never gave — the exact defect Wave 3 spent phase 06(b) undoing.
//
// So `unconfigured` is its own state, distinct from `valid` and from `invalid`. It is
// not falsy-by-convention and there is no `.valid` property to destructure. A caller
// that wants to branch has to acknowledge the third state to compile.
//
// ## Rails this keeps
//
//   * the oracle is the only judge — this verifies the island's signature, it never
//     forms an opinion about a wallet
//   * unknown is never zero and never a confident value — in BOTH directions: an
//     unconfigured seam is not a denial either
//   * nothing activates the covenant — no key, no route, no activation today
//   * config over constants — the route is config, and its absence is the default

/** The seven fields, in the island's order. The signature is over exactly these. */
export const VOUCHER_FIELDS = [
  'address',
  'degrees',
  'tier',
  'floor',
  'as_of_unix',
  'expires_unix',
  'nonce',
] as const;

export interface LaunchVoucher {
  /** The wallet the island measured. */
  address: string;
  /** island_heat at `as_of_unix`. */
  degrees: number;
  /** The island's tier word. */
  tier: string;
  /** The floor this voucher was issued against. */
  floor: number;
  /** When the island reckoned it. */
  as_of_unix: number;
  /** After this, the voucher is spent. */
  expires_unix: number;
  /** Replay guard. */
  nonce: string;
}

export type VoucherVerdict =
  /** No island route configured. NOT a pass and NOT a denial — we could not ask. */
  | { state: 'unconfigured'; reason: string }
  | { state: 'valid'; voucher: LaunchVoucher }
  | { state: 'invalid'; reason: string };

/**
 * Where the island's public key will be read from.
 *
 * Returns null today, and that is the whole point: the island has not published a
 * route, so the venue must not invent one. `VITE_ISLAND_KEY_ROUTE` is the seam — when
 * the island publishes, set it, and `verifyLaunchVoucher` stops answering
 * `unconfigured` without any other edit here.
 *
 * Deliberately a function and not a module constant so a test can observe it, and so
 * the value is read at call time rather than frozen at import.
 */
export function islandKeyRoute(): string | null {
  const configured = (import.meta.env.VITE_ISLAND_KEY_ROUTE as string | undefined)?.trim();
  return configured || null;
}

/**
 * Serialise a voucher to the exact bytes a signature is taken over.
 *
 * Key order is FIXED to `VOUCHER_FIELDS`, not to object construction order. Two
 * encoders of the same voucher must produce identical bytes or every signature looks
 * forged — the same "sign the exact wire bytes" discipline the birth socket keeps, and
 * for the same reason.
 *
 * Extra properties are dropped rather than serialised: the island signs seven fields,
 * so an eighth in the object cannot be allowed to change the bytes. A MISSING field
 * throws instead, because silently encoding `undefined` would produce bytes that verify
 * against nothing and send the reader hunting through the crypto for a data bug.
 */
export function canonicalVoucherBytes(voucher: LaunchVoucher): Uint8Array {
  const ordered: Record<string, unknown> = {};
  for (const field of VOUCHER_FIELDS) {
    const value = (voucher as unknown as Record<string, unknown>)[field];
    if (value === undefined || value === null) {
      throw new Error(`canonicalVoucherBytes: voucher is missing the pinned field "${field}"`);
    }
    ordered[field] = value;
  }
  return new TextEncoder().encode(JSON.stringify(ordered));
}

/**
 * Verify an island-signed launch voucher.
 *
 * INACTIVE TODAY, BY CONSTRUCTION. With no island route there is no public key, so
 * there is nothing to verify against and the only honest answer is `unconfigured`.
 * It says so for every input — including a voucher that is already expired, which is
 * still not a denial, because we cannot judge it at all.
 *
 * When the island publishes: fetch the key from `islandKeyRoute()`, verify `signature`
 * over `canonicalVoucherBytes(voucher)`, then check `expires_unix` against a clock the
 * caller supplies. Nothing above this line needs to change.
 */
export function verifyLaunchVoucher(voucher: LaunchVoucher, signature: string): VoucherVerdict {
  const route = islandKeyRoute();
  if (!route) {
    return {
      state: 'unconfigured',
      reason:
        'No island key route is configured, so launch vouchers cannot be verified. This is not a denial — the island has not published the route yet.',
    };
  }
  // Unreachable until the island publishes. Left explicit rather than implemented
  // against a guessed key format: the wave says no activation today, and a hopeful
  // implementation is how a seam activates by accident.
  void voucher;
  void signature;
  return {
    state: 'unconfigured',
    reason: `An island key route is set (${route}) but voucher verification is not implemented yet — the island's key format is not published.`,
  };
}
