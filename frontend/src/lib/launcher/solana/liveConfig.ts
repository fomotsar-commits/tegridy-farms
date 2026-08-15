// Reads the LIVE Meteora DBC partner config from mainnet and decodes the fee
// terms a trader actually faces.
//
// WHY THIS EXISTS
// ---------------
// /solana-launch renders its Fact Sheet from `DEFAULT_ANTI_SNIPE` and the other
// builder defaults in dbc.ts. Those are what we WOULD configure, not what IS
// configured. Today they happen to agree with mainnet — verified on-chain — but
// a visitor cannot tell the difference, and the moment a config v2 is created
// (DBC configs are IMMUTABLE, so changing terms means a new config) the page
// would go on describing v1 with nothing failing.
//
// So the page should read the chain. Numbers that come from the chain and cite
// the account they came from are checkable by the reader; numbers that come from
// a constant are a claim.
//
// WHY HAND-ROLLED OFFSETS AND NOT THE SDK
// ---------------------------------------
// dbc.ts deliberately imports the Meteora SDK TYPE-ONLY so none of its runtime
// weight reaches this lazy chunk. Pulling the real SDK in just to read six
// scalars would undo that. The same trade-off was already made in squads.ts.
//
// What makes a hand-rolled offset safe there is the DISCRIMINATOR GUARD, and the
// same rule applies here: the 8-byte Anchor discriminator is COMPUTED from
// `sha256("account:PoolConfig")`, never memorised, and every read is refused
// unless it matches. A different account type — or a differently-shaped one —
// fails closed to `null` rather than yielding a plausible wrong number.
//
// OFFSETS — each verified against the SDK's own decode of the live account on
// 2026-08-02 (see liveConfig.test.ts, which pins the real 1048-byte account):
//
//   72   feeClaimer            pubkey (32)
//   104  cliffFeeNumerator     u64  → 990000000 = 99.00% opening fee
//   112  periodFrequency       u64  → 180 s per period
//   120  reductionFactor       u64  → 375 (bps of decay per period)
//   128  numberOfPeriod        u16  → 120
//   130  baseFeeMode           u8   → 1 = exponential, 0 = linear
//   245  creatorTradingFeePct  u8   → 60 (creator's % of the non-Meteora 80%)
//
// A layout change inside the same account type would NOT be caught by the
// discriminator, so `decodePoolConfig` additionally range-checks every field and
// returns null on anything impossible. Wrong-and-plausible is the failure mode
// worth engineering against; wrong-and-obvious is merely a bug.

import { METEORA_PROTOCOL_FEE_PERCENT } from './dbc';

/**
 * The DBC program stores fees as a numerator over 1e9, NOT as bps. Confirmed
 * against the live account: `cliffFeeNumerator = 990_000_000`, which the SDK
 * decodes as a 99% opening fee — so the denominator is 1e9 and bps = n / 1e5.
 * Kept local to this decoder rather than added to dbc.ts, which deals in bps
 * throughout and has no other use for it.
 */
const FEE_DENOMINATOR = 1_000_000_000n;

/** The Anchor account discriminator for a DBC `PoolConfig`. */
export const POOL_CONFIG_DISCRIMINATOR = new Uint8Array([
  0x1a, 0x6c, 0x0e, 0x7b, 0x74, 0xe6, 0x81, 0x2b,
]);

/**
 * Byte offsets into the DBC PoolConfig account.
 *
 * Exported because `feeCustody.ts` reads `feeClaimer` from the same account for the
 * pre-submit custody check. One definition, so the two readers cannot drift apart —
 * and the discriminator guard above is what makes hand-rolled offsets safe for both.
 */
export const CONFIG_OFFSETS = {
  feeClaimer: 72,
  cliffFeeNumerator: 104,
  periodFrequency: 112,
  reductionFactor: 120,
  numberOfPeriod: 128,
  baseFeeMode: 130,
  creatorTradingFeePercentage: 245,
} as const;

const OFF = CONFIG_OFFSETS;

/** Smallest account we will attempt to decode (the live one is 1048 bytes). */
const MIN_ACCOUNT_BYTES = 256;

export interface LivePoolConfig {
  /** Opening fee, in bps of trade volume (e.g. 9900 = 99%). */
  openingFeeBps: number;
  /** Fee after the full decay window, in bps. */
  restingFeeBps: number;
  numberOfPeriod: number;
  periodFrequencySeconds: number;
  reductionFactorBps: number;
  mode: 'exponential' | 'linear';
  /** Total decay window in seconds. */
  totalDurationSeconds: number;
  /** Creator's share of the non-Meteora remainder, as a percent (0-100). */
  creatorTradingFeePercentage: number;
}

// `noUncheckedIndexedAccess` is on, so every index is `number | undefined`.
// These readers are only ever called after the length check in
// decodePoolConfig, but assert that rather than silencing it — an out-of-range
// read should be a loud bug, not a 0 that decodes into a plausible fee.
function byteAt(b: Uint8Array, o: number): number {
  const v = b[o];
  if (v === undefined) throw new RangeError(`PoolConfig read out of range at ${o}`);
  return v;
}
function u64LE(b: Uint8Array, o: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(byteAt(b, o + i));
  return v;
}
function u16LE(b: Uint8Array, o: number): number {
  return byteAt(b, o) | (byteAt(b, o + 1) << 8);
}

/**
 * Fee in bps after `period` periods of decay.
 * Exponential: cliff * (1 - reduction/10_000)^period
 * Linear:      cliff - reduction * period
 * Mirrors the DBC program's own scheduler so the disclosure matches what a
 * trader is actually charged.
 */
export function feeBpsAtPeriod(cfg: LivePoolConfig, period: number): number {
  const p = Math.max(0, Math.min(period, cfg.numberOfPeriod));
  if (cfg.mode === 'linear') {
    return Math.max(0, cfg.openingFeeBps - cfg.reductionFactorBps * p);
  }
  return cfg.openingFeeBps * Math.pow(1 - cfg.reductionFactorBps / 10_000, p);
}

/** Fee in bps `seconds` after the pool activates. */
export function feeBpsAtSeconds(cfg: LivePoolConfig, seconds: number): number {
  if (cfg.periodFrequencySeconds <= 0) return cfg.openingFeeBps;
  return feeBpsAtPeriod(cfg, Math.floor(seconds / cfg.periodFrequencySeconds));
}

/**
 * Decode a raw DBC PoolConfig account. Returns null — never a guess — if the
 * discriminator does not match, the account is too short, or any field is
 * outside a physically possible range.
 */
export function decodePoolConfig(raw: Uint8Array): LivePoolConfig | null {
  if (raw.length < MIN_ACCOUNT_BYTES) return null;
  for (let i = 0; i < 8; i++) {
    if (byteAt(raw, i) !== POOL_CONFIG_DISCRIMINATOR[i]) return null;
  }

  const cliff = u64LE(raw, OFF.cliffFeeNumerator);
  const periodFrequency = u64LE(raw, OFF.periodFrequency);
  const reduction = u64LE(raw, OFF.reductionFactor);
  const numberOfPeriod = u16LE(raw, OFF.numberOfPeriod);
  const modeByte = byteAt(raw, OFF.baseFeeMode);
  const creatorPct = byteAt(raw, OFF.creatorTradingFeePercentage);

  // FEE_DENOMINATOR is 1e9 and bps is 1e-4, so bps = numerator / 1e5.
  const openingFeeBps = Number((cliff * 10_000n) / FEE_DENOMINATOR);

  // Range checks — a layout drift inside the same account type would sail past
  // the discriminator, so every value has to be independently implausible-proof.
  if (openingFeeBps <= 0 || openingFeeBps > 10_000) return null;
  if (numberOfPeriod < 0 || numberOfPeriod > 10_000) return null;
  if (periodFrequency <= 0n || periodFrequency > 86_400n) return null;
  if (reduction <= 0n || reduction > 10_000n) return null;
  if (modeByte !== 0 && modeByte !== 1) return null;
  if (creatorPct > 100) return null;

  const cfg: LivePoolConfig = {
    openingFeeBps,
    restingFeeBps: 0, // filled below, once the shape is known-good
    numberOfPeriod,
    periodFrequencySeconds: Number(periodFrequency),
    reductionFactorBps: Number(reduction),
    mode: modeByte === 1 ? 'exponential' : 'linear',
    totalDurationSeconds: numberOfPeriod * Number(periodFrequency),
    creatorTradingFeePercentage: creatorPct,
  };
  cfg.restingFeeBps = feeBpsAtPeriod(cfg, cfg.numberOfPeriod);
  return cfg;
}

/**
 * Split a fee (bps) into creator / partner / Meteora, using the LIVE config's
 * creator percentage. Meteora takes a fixed cut of every trade fee first; the
 * remainder is divided by `creatorTradingFeePercentage`.
 */
export function splitAtFee(cfg: LivePoolConfig, feeBps: number) {
  const meteora = (feeBps * METEORA_PROTOCOL_FEE_PERCENT) / 100;
  const rest = feeBps - meteora;
  const creator = (rest * cfg.creatorTradingFeePercentage) / 100;
  return { creatorBps: creator, partnerBps: rest - creator, meteoraBps: meteora };
}

/**
 * Fetch + decode the live config through the origin-gated /api/solrpc proxy.
 * `getAccountInfo` is already on that proxy's method allowlist.
 *
 * Returns null on ANY failure — unreachable RPC, missing account, bad shape.
 * The caller must render that as "could not read", never as the builder
 * defaults dressed up as live values; that substitution is the exact defect
 * this module exists to remove.
 */
export async function fetchLivePoolConfig(
  configAddress: string,
  opts: { endpoint?: string; signal?: AbortSignal } = {},
): Promise<LivePoolConfig | null> {
  const endpoint = opts.endpoint ?? '/api/solrpc';
  try {
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

    const binary = atob(b64);
    const raw = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) raw[i] = binary.charCodeAt(i);
    return decodePoolConfig(raw);
  } catch {
    return null;
  }
}
