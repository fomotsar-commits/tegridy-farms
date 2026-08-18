// FEE CUSTODY, VERIFIED ON THE PATH THE PUBLIC WALKS — Wave 3, phase 03.
//
// The venue's strongest Solana guarantee is that the DBC config's `feeClaimer` is the
// Squads vault, so trading fees cannot be redirected to one person. `squads.ts` already
// implements that check properly — and `submitLaunch` never called it.
//
// The reasoning for skipping it was sound: the config address is build-time
// configuration and never user input, and `verifySquadsVault` reaches
// `findProgramAddressSync`, which web3.js stubs out in its browser build. But the
// outcome was that the guarantee ran in operator tooling and nowhere near the public
// submit button. A build-time constant is only as good as the build, and nothing on the
// public path had ever asked the chain.
//
// So this is ONE read, before submit, failing closed.
//
// ## Fail-closed is the point, not a detail
//
// Every branch that is not "the chain says the expected vault" refuses: a mismatch, an
// unreadable account, a throwing RPC, and a missing expectation. "Unknown is never zero
// and never a confident value" is a rail of this wave, and a check that waves traffic
// through on an RPC hiccup is worse than no check — it reads as verified.
//
// ## Why a plain Error, thrown high
//
// Same doctrine as `HeatGateDenied`. This is called ABOVE the SDK and far above
// `sendTransaction`, so a refusal is provably "nothing was submitted" and can never be
// confused with a landed transaction that failed. It must never carry a `signature`.

import { CONFIG_OFFSETS, POOL_CONFIG_DISCRIMINATOR } from './liveConfig';

/**
 * A refusal to submit because fee custody could not be proven.
 *
 * Deliberately a plain Error subclass carrying no `signature`, so `wasBroadcast()`
 * reads false and the caller reports "never submitted" — which is literally true from
 * where this is thrown.
 */
export class FeeCustodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeeCustodyError';
  }
}

/** Base58, the Solana alphabet. Local so this module pulls in no web3.js in the browser. */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Encode 32 raw bytes as a base58 pubkey. */
export function encodeBase58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  // Leading zero bytes are significant and encode as '1' each.
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

/**
 * Read the `feeClaimer` out of a live DBC PoolConfig account.
 *
 * Returns null when the account cannot be read or does not look like a PoolConfig —
 * never a guess. The discriminator guard is what makes a hand-rolled offset safe: if
 * Meteora changes the layout, the first eight bytes stop matching and this reads null
 * rather than decoding whatever now sits at the fee-claimer offset and calling it an
 * address.
 *
 * Reads `CONFIG_OFFSETS.feeClaimer` (40), NOT `leftoverReceiver` (72). The two hold
 * the same key on the v1 config, so the substitution is invisible until a config is
 * minted where they differ — and the whole point of this check is the config nobody
 * here minted.
 */
export async function readFeeClaimerOnChain(
  configAddress: string,
  opts: { endpoint?: string; signal?: AbortSignal } = {},
): Promise<string | null> {
  const endpoint = opts.endpoint ?? '/api/solrpc';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getAccountInfo',
      params: [configAddress, { encoding: 'base64' }],
    }),
  });
  if (!res.ok) return null;
  const json: unknown = await res.json();
  const data = (json as { result?: { value?: { data?: [string, string] } } })?.result?.value?.data;
  const b64 = Array.isArray(data) ? data[0] : undefined;
  if (typeof b64 !== 'string' || b64.length === 0) return null;

  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (raw.length < CONFIG_OFFSETS.feeClaimer + 32) return null;
  for (let i = 0; i < POOL_CONFIG_DISCRIMINATOR.length; i++) {
    if (raw[i] !== POOL_CONFIG_DISCRIMINATOR[i]) return null;
  }
  return encodeBase58(raw.subarray(CONFIG_OFFSETS.feeClaimer, CONFIG_OFFSETS.feeClaimer + 32));
}

/**
 * Refuse to proceed unless the live config's fee claimer IS the expected vault.
 *
 * `readFeeClaimer` is injected so the check is testable without a network, and so the
 * caller controls the endpoint. One call, one RPC read, on the happy path.
 */
export async function assertFeeCustody(
  configAddress: string,
  expectedVault: string,
  opts: { readFeeClaimer?: (config: string) => Promise<string | null> } = {},
): Promise<void> {
  // No expectation means there is nothing to compare against, so a "match" would be
  // vacuous. Refuse BEFORE spending the read — a pass here would be the most dangerous
  // outcome available, because it looks identical to a verified one.
  if (!expectedVault || !expectedVault.trim()) {
    throw new FeeCustodyError(
      'Fee custody cannot be verified: no expected vault is configured for this rail. Refusing to submit rather than launching against an unverified fee destination.',
    );
  }
  if (!configAddress || !configAddress.trim()) {
    throw new FeeCustodyError('Fee custody cannot be verified: no launch config was resolved. Refusing to submit.');
  }

  const read = opts.readFeeClaimer ?? readFeeClaimerOnChain;
  let actual: string | null;
  try {
    actual = await read(configAddress);
  } catch (e) {
    // An RPC failure is UNKNOWN, not "fine". Waving it through would make the check
    // read as verified on exactly the runs where it verified nothing.
    throw new FeeCustodyError(
      `Fee custody could not be verified — the config account could not be read (${
        e instanceof Error ? e.message : String(e)
      }). Refusing to submit; nothing was sent.`,
    );
  }

  if (!actual) {
    throw new FeeCustodyError(
      `Fee custody could not be verified — config ${configAddress} did not return a readable PoolConfig. Refusing to submit; nothing was sent.`,
    );
  }

  if (actual !== expectedVault) {
    // Name BOTH addresses. "Custody check failed" sends the reader hunting; the pair
    // tells them immediately whether the config moved or the expectation is stale.
    throw new FeeCustodyError(
      `Fee custody mismatch on config ${configAddress}: the chain says fees go to ${actual}, but this build expects ${expectedVault}. Refusing to submit; nothing was sent.`,
    );
  }
}
