// Token permalink dossier — the classification layer behind /launch/:token.
//
// The page it feeds is a TRUST SURFACE, so every branch here exists to keep three
// things that look alike strictly apart:
//
//   1. "we read it and the answer is no"   (a real negative finding)
//   2. "we read it and the answer is yes"  (a real positive finding)
//   3. "we could not read it"              (NOT a finding about the token at all)
//
// Collapsing (3) into (1) is the defect class this repo keeps re-learning: a
// permanently-broken locker call rendered for weeks as "has not graduated"
// (lockerStream.ts header), and a market feed that could not price a pool rendered
// a scam as "520607 ETH". So every classifier below returns an explicit
// unreadable/cannot-verify kind, and the page renders it as such.
//
// Nothing here fetches on its own except the two thin I/O wrappers at the bottom,
// which are the only functions that touch a client. Everything above them is pure
// and unit-tested.

import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { AIRLOCK_GET_ASSET_DATA, sameAddress } from './ourLaunches';
import { LAUNCHER_INTEGRATOR_ADDRESS } from './config';
import { DOPPLER_MAINNET } from './doppler.constants';
import type { MigrationStream } from './lockerStream';

const ZERO: Address = '0x0000000000000000000000000000000000000000';

/**
 * Bound an RPC error string before it reaches a page. viem attaches the ENTIRE
 * JSON-RPC request body to a transport error, which put a wall of hex topics on the
 * live page; the leading sentence plus the URL is the whole diagnostic value.
 */
export function clipMessage(s: string, max = 180): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// ---------------------------------------------------------------------------
// URL parameter
// ---------------------------------------------------------------------------

export type TokenParamResult =
  | { ok: true; address: Address }
  | { ok: false; reason: string };

/**
 * Validate the `:token` path segment.
 *
 * Accepts any-case hex (`strict: false`) and normalises to EIP-55. A permalink is
 * routinely copied out of a block explorer, a log line, or one of our own lowercased
 * hrefs, and rejecting a mixed-case-but-not-EIP-55 string would 404 a perfectly real
 * token. Case carries no information on-chain, so normalising invents nothing —
 * whereas anything that is not 20 hex bytes is rejected outright rather than
 * being partially rendered.
 */
export function parseTokenParam(raw: string | undefined | null): TokenParamResult {
  const v = (raw ?? '').trim();
  if (!v) return { ok: false, reason: 'No token address in the link.' };
  if (!isAddress(v, { strict: false })) {
    return { ok: false, reason: 'That is not a valid Ethereum address (expected 0x followed by 40 hex characters).' };
  }
  try {
    return { ok: true, address: getAddress(v) };
  } catch {
    // Unreachable via isAddress above, but a throw here must never white-screen the route.
    return { ok: false, reason: 'That address could not be read.' };
  }
}

// ---------------------------------------------------------------------------
// Airlock record → provenance
// ---------------------------------------------------------------------------

/** The slice of Doppler's `getAssetData` record this page needs. */
export interface AirlockAssetRecord {
  numeraire: Address;
  /** Whitelisted PoolInitializer module. NON-ZERO for every real record — see decodeAssetData. */
  poolInitializer: Address;
  /** Zero while the auction is still running. */
  migrationPool: Address;
  totalSupply: bigint;
  /** Airlock output index 9 — the ONLY place a launch's integrator is recoverable. */
  integrator: Address;
}

export type AirlockRead =
  | { status: 'found'; record: AirlockAssetRecord }
  | { status: 'absent' }
  | { status: 'unreadable'; message: string };

/**
 * Decode a raw `getAssetData` result.
 *
 * `getAssetData` is a public-mapping getter, so an address the Airlock has never seen
 * returns an ALL-ZERO struct rather than reverting (verified against mainnet
 * 2026-07-30). The discriminator for "no record" is therefore `poolInitializer == 0`:
 * every real record names a whitelisted PoolInitializer module, while `integrator`
 * is legitimately zero for a Doppler launch made without one — so keying absence off
 * the integrator would misreport a real foreign launch as "not a Doppler launch".
 */
export function decodeAssetData(raw: unknown): AirlockRead {
  if (raw == null || typeof raw !== 'object') {
    return { status: 'unreadable', message: 'The Airlock returned a value this app could not decode.' };
  }
  const arr = Array.isArray(raw);
  const at = (i: number, key: string): unknown =>
    arr ? (raw as readonly unknown[])[i] : (raw as Record<string, unknown>)[key];

  const numeraire = at(0, 'numeraire');
  const poolInitializer = at(4, 'poolInitializer');
  const migrationPool = at(6, 'migrationPool');
  const totalSupply = at(8, 'totalSupply');
  const integrator = at(9, 'integrator');

  if (typeof poolInitializer !== 'string' || typeof integrator !== 'string') {
    return { status: 'unreadable', message: 'The Airlock record was missing the fields this page reads.' };
  }
  if (sameAddress(poolInitializer, ZERO)) return { status: 'absent' };

  return {
    status: 'found',
    record: {
      numeraire: (typeof numeraire === 'string' ? numeraire : ZERO) as Address,
      poolInitializer: poolInitializer as Address,
      migrationPool: (typeof migrationPool === 'string' ? migrationPool : ZERO) as Address,
      totalSupply: typeof totalSupply === 'bigint' ? totalSupply : 0n,
      integrator: integrator as Address,
    },
  };
}

export type ProvenanceKind =
  | 'ours' // the Airlock record names OUR integrator
  | 'other-integrator' // a Doppler launch, but someone else's rail
  | 'no-integrator' // a Doppler launch with no integrator at all
  | 'not-doppler' // no Airlock record: this token did not launch through Doppler
  | 'unreadable'; // we could not read the record — NOT a statement about the token

export interface Provenance {
  kind: ProvenanceKind;
  /** Short badge text. */
  label: string;
  /** Full factual sentence. Only `ours` may claim this launch came through us. */
  detail: string;
  /** The integrator the Airlock names, when we read one. */
  integrator: Address | null;
}

/**
 * Classify where a token came from.
 *
 * Fails CLOSED in both directions: an unreadable record never claims a launch as
 * ours, and a configured-zero integrator never matches (the same guard
 * `filterOurAssets` carries — a zero integrator would otherwise claim every
 * integrator-less launch on Doppler as ours).
 */
export function classifyProvenance(
  read: AirlockRead,
  integrator: Address = LAUNCHER_INTEGRATOR_ADDRESS,
): Provenance {
  if (read.status === 'unreadable') {
    return {
      kind: 'unreadable',
      label: 'Provenance unverified',
      detail: `We could not read this token's Doppler Airlock record, so we cannot say whether it launched through this rail. ${clipMessage(read.message)}`,
      integrator: null,
    };
  }
  if (read.status === 'absent') {
    return {
      kind: 'not-doppler',
      label: 'Not launched here',
      detail:
        'Doppler’s Airlock holds no record for this address, so this token was not launched through Doppler and did not come through this rail.',
      integrator: null,
    };
  }

  const found = read.record.integrator;
  if (!sameAddress(integrator, ZERO) && sameAddress(found, integrator)) {
    return {
      kind: 'ours',
      label: 'Launched through this rail',
      detail: `The Airlock record for this token names our integrator (${integrator}), so it launched through this rail.`,
      integrator: found,
    };
  }
  if (sameAddress(found, ZERO)) {
    return {
      kind: 'no-integrator',
      label: 'Not launched here',
      detail:
        'This is a Doppler launch, but its Airlock record names no integrator — it did not come through this rail.',
      integrator: ZERO,
    };
  }
  return {
    kind: 'other-integrator',
    label: 'Not launched here',
    detail: `This is a Doppler launch, but its Airlock record names a different integrator (${found}) — it did not come through this rail.`,
    integrator: found,
  };
}

// ---------------------------------------------------------------------------
// Post-graduation state
// ---------------------------------------------------------------------------

export type GraduationKind = 'graduated' | 'not-graduated' | 'cannot-verify';

export interface GraduationState {
  kind: GraduationKind;
  label: string;
  detail: string;
  /** The derived UniV4 migration PoolId — a real identifier even when nothing was read. */
  poolId: Hex;
  numeraire: Address;
  /** null whenever the lock state was not actually read (never rendered as "unlocked"). */
  locked: boolean | null;
  unlockAt: number | null;
  beneficiaries: MigrationStream['beneficiaries'];
}

/**
 * Turn a locker read into a renderable state.
 *
 * `unsupported` WINS over `graduated: false`. readMigrationStream cannot resolve a
 * token to its V1 locker position tokenId today, so it always reports
 * `{ graduated: false, unsupported: true }` — presenting that as "has not graduated"
 * would be exactly the conflation its own header warns about.
 */
export function classifyGraduation(stream: MigrationStream): GraduationState {
  const base = {
    poolId: stream.poolId,
    numeraire: stream.numeraire,
    beneficiaries: stream.beneficiaries,
  };
  if (stream.unsupported) {
    return {
      ...base,
      kind: 'cannot-verify',
      label: 'Graduation state unverified',
      locked: null,
      unlockAt: null,
      detail:
        'We cannot read this token’s position in Doppler’s StreamableFeesLocker from the browser yet, so we do not know whether it has graduated. This is a limit of our read — it is not a finding about the token.',
    };
  }
  if (stream.graduated) {
    return {
      ...base,
      kind: 'graduated',
      label: 'Graduated',
      locked: stream.locked,
      unlockAt: stream.unlockAt,
      detail:
        'This token has migrated into its Uniswap V4 pool and its fee split is a live on-chain stream in Doppler’s StreamableFeesLocker.',
    };
  }
  return {
    ...base,
    kind: 'not-graduated',
    label: 'Not graduated',
    locked: null,
    unlockAt: null,
    detail:
      'Doppler’s StreamableFeesLocker holds no fee stream for this token’s migration pool — price discovery has not migrated to a Uniswap V4 pool.',
  };
}

// ---------------------------------------------------------------------------
// Which Fact Sheet lines are actually EVIDENCE, and which are safe defaults
// ---------------------------------------------------------------------------

/**
 * Gate checks whose `detail` string is a CONSERVATIVE DEFAULT rather than a reading,
 * mapped to what we can honestly say instead.
 *
 * gate.ts is a gate: when the collector cannot read something it substitutes the
 * value that CLOSES the gate, which is correct for tiering and wrong for publishing.
 * On an unrecognised template the collector reports every dangerous power as present
 * (collector.ts, "safety defaults to closed"), so the sheet says "Contract exposes a
 * post-launch mint power." about a contract nobody read — a fabricated accusation on
 * a public page. In the other direction it reports a 0-bps team allocation and an
 * unlocked LP, so the sheet says "No team/insider allocation." and "Liquidity is not
 * locked." — a fabricated clean bill of health and a fabricated failure respectively.
 *
 * Every id listed here must be rendered as UNKNOWN by the page — never as a pass and
 * never as a fail.
 */
export function unverifiedGateChecks(
  knownSafeTemplate: boolean,
  graduation: GraduationState,
  unreadFields: readonly string[] = [],
): Record<string, string> {
  const out: Record<string, string> = {};

  // A FAILED READ ON THE RECOGNISED TEMPLATE IS THE DANGEROUS CASE.
  //
  // The template branches below only fire when the contract is NOT the known Doppler
  // template. But every launch through our own rail IS that template, and the collector
  // still degrades an individual failed view call to a conservative fallback — which the
  // gate then reads as a PASS and this page renders as a green statement of fact:
  //   owner unread       -> null -> "Ownership renounced."          (INVERTED, not unknown)
  //   totalSupply unread -> 0n   -> "No team/insider allocation."   and the flagship cap passes
  // One rate-limited call inside a Promise.all is enough, and public RPCs return 429/1015
  // routinely. So suppress off what actually landed, not off which template it is.
  const unread = new Set(unreadFields);
  if (unread.has('owner')) {
    out['admin-renounced-or-timelock'] =
      'Not read. The ownership call did not return, so a renounced owner and an unreachable node are indistinguishable here.';
  }
  if (unread.has('totalSupply')) {
    const reason =
      'Not read. Total supply did not return, so insider allocation could not be computed — this is unknown, not a zero.';
    out['team-allocation-vested'] = reason;
    out['insider-float-cap'] = reason;
  }
  if (!knownSafeTemplate) {
    const reason =
      'Not read. This contract is not the recognised Doppler template, so its powers were not enumerated — this is unknown, not a finding.';
    for (const id of ['no-mint', 'no-transfer-tax', 'no-blacklist', 'no-upgrade', 'no-pause']) {
      out[id] = reason;
    }
    const allocation =
      'Not read. Insider allocation is only readable on the recognised Doppler template.';
    out['team-allocation-vested'] = allocation;
    // `insider-float-cap` compares the SAME unread 0-bps figure against the flagship cap,
    // so on an unrecognised template the gate renders it as a PASS — a fabricated clean
    // bill of health. Caught only by reading the live page. (2026-07-30)
    out['insider-float-cap'] = allocation;
    // Likewise ownership: the collector reads `owner()` with a null fallback, so a
    // contract that has no `owner()` at all degrades to ownerRenounced = true and the
    // gate publishes "Ownership renounced." about a contract nobody could inspect.
    out['admin-renounced-or-timelock'] =
      'Not read. Ownership is only reliably readable on the recognised Doppler template; a contract without an owner() call is indistinguishable from a renounced one here.';
  }
  if (graduation.locked == null) {
    const reason =
      'Not read. The liquidity-lock state could not be read, so neither a lock nor the absence of one is established.';
    out['lp-lock-floor'] = reason;
    out['lp-lock-12mo'] = reason;
  }
  return out;
}

/**
 * True only when the residual-power list came from a real read. On an unrecognised
 * template the whole list is the conservative default, and publishing it would state
 * seven dangerous powers about a contract that was never inspected.
 */
export function powersWereRead(knownSafeTemplate: boolean): boolean {
  return knownSafeTemplate;
}

// ---------------------------------------------------------------------------
// I/O — the only functions here that touch a client.
// ---------------------------------------------------------------------------

/** Minimal read surface; a real viem PublicClient satisfies it, tests supply a mock. */
export interface AirlockReadClient {
  // `any` for the same contravariance reason as collector.ts's ReadOnlyPublicClient.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  readContract(args: any): Promise<unknown>;
  getCode?(args: any): Promise<Hex | undefined>;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Whether anything is deployed at the address at all. */
export type TokenPresence = 'contract' | 'no-code' | 'unreadable';

/**
 * Is there a contract here? A permalink to a typo'd or EOA address would otherwise
 * render a Fact Sheet full of blank strings and zeroes, which reads like data. The
 * distinction between "nothing is deployed here" and "we could not check" is kept,
 * because only the first is a fact about the address.
 */
export async function readTokenPresence(
  client: AirlockReadClient,
  token: Address,
): Promise<TokenPresence> {
  if (typeof client.getCode !== 'function') return 'unreadable';
  try {
    const code = await client.getCode({ address: token });
    return code && code !== '0x' ? 'contract' : 'no-code';
  } catch {
    return 'unreadable';
  }
}

/**
 * Read ONE token's Airlock record. A single `eth_call` — deliberately not the
 * `Create`-log scan `readOurLaunches` performs, which needs a multi-million-block
 * `eth_getLogs` range that the public RPCs this app ships with reject.
 */
export async function readAirlockAssetData(
  client: AirlockReadClient,
  token: Address,
): Promise<AirlockRead> {
  try {
    const raw = await client.readContract({
      address: DOPPLER_MAINNET.airlock,
      abi: [AIRLOCK_GET_ASSET_DATA] as const,
      functionName: 'getAssetData',
      args: [token],
    });
    return decodeAssetData(raw);
  } catch (e) {
    return {
      status: 'unreadable',
      message: e instanceof Error ? e.message : 'The RPC call failed.',
    };
  }
}
