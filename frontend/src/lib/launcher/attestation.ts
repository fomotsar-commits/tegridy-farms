// On-chain EAS attestation of a LaunchFactSheet — makes the DISCLOSURE
// verifiable + composable without vouching for anything (red-team disposition F,
// see factSheet.ts). An attestation is a timestamped, revocable statement of
// facts read at `observedAt`, NOT a warranty or a "safe" endorsement.
//
// viem ONLY — no @ethereum-attestation-service/eas-sdk dependency (keeps the
// launcher surface minimal + avoids a heavy transitive tree). We hand-roll the
// tiny slice of EAS we use: schema-UID derivation, ABI-encoding the schema
// fields, SchemaRegistry.register, and EAS.attest.
//
// Grounded in the canonical EAS contracts (Ethereum mainnet):
//   - EAS.attest(AttestationRequest) payable returns (bytes32 uid)
//   - SchemaRegistry.register(string,address,bool) returns (bytes32 uid)
//   - schema UID = keccak256(abi.encodePacked(schema, resolver, revocable))
//     (SchemaRegistry._getUID) — deterministic, resolver=address(0), revocable=true.
//
// GATING: nothing here reads or writes chain state on its own. The attest/register
// helpers require live clients supplied by the caller; the main loop invokes them
// only POST-launch and only when isLauncherEnabled() is true. Pure helpers
// (schema UID, encode, digest) are safe to call anytime — they touch no network.

import {
  encodeAbiParameters,
  encodePacked,
  keccak256,
  parseAbiParameters,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import {
  FACT_SHEET_EAS_SCHEMA,
  TIER_CODE,
  type LaunchFactSheet,
} from './factSheet';
import { isLauncherEnabled } from './config';

/** Canonical EAS deployment — Ethereum mainnet. */
export const EAS_MAINNET: Address = '0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587';
/** Canonical EAS SchemaRegistry — Ethereum mainnet. */
export const EAS_SCHEMA_REGISTRY_MAINNET: Address = '0xA7b39296258348C78294F95B872b282326A97BDF';

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000';
const ZERO_BYTES32: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * The fact sheet schema is registered with NO resolver and REVOCABLE by design
 * (a fact sheet is a timestamped disclosure the attester can retract, not a
 * warranty). These two constants feed both the UID derivation and register().
 */
const SCHEMA_RESOLVER: Address = ZERO_ADDRESS;
const SCHEMA_REVOCABLE = true;

/**
 * Minimal EAS ABI fragment — only `attest`. AttestationRequest is a nested tuple:
 *   { bytes32 schema, AttestationRequestData data }
 *   AttestationRequestData { address recipient, uint64 expirationTime, bool revocable,
 *                            bytes32 refUID, bytes data, uint256 value }
 */
export const EAS_ABI = [
  {
    type: 'function',
    name: 'attest',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'request',
        type: 'tuple',
        components: [
          { name: 'schema', type: 'bytes32' },
          {
            name: 'data',
            type: 'tuple',
            components: [
              { name: 'recipient', type: 'address' },
              { name: 'expirationTime', type: 'uint64' },
              { name: 'revocable', type: 'bool' },
              { name: 'refUID', type: 'bytes32' },
              { name: 'data', type: 'bytes' },
              { name: 'value', type: 'uint256' },
            ],
          },
        ],
      },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
] as const;

/**
 * Minimal SchemaRegistry ABI fragment — `register` (write, idempotent-ish: reverts
 * `AlreadyExists()` if the exact schema is already registered) + `getSchema` (view,
 * to check existence before registering).
 */
export const EAS_SCHEMA_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'schema', type: 'string' },
      { name: 'resolver', type: 'address' },
      { name: 'revocable', type: 'bool' },
    ],
    outputs: [{ name: '', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'getSchema',
    stateMutability: 'view',
    inputs: [{ name: 'uid', type: 'bytes32' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'uid', type: 'bytes32' },
          { name: 'resolver', type: 'address' },
          { name: 'revocable', type: 'bool' },
          { name: 'schema', type: 'string' },
        ],
      },
    ],
  },
] as const;

/**
 * Deterministic EAS schema UID for the Fact Sheet schema.
 * Mirrors SchemaRegistry._getUID:
 *   keccak256(abi.encodePacked(schema, resolver, revocable))
 * with resolver = address(0) and revocable = true. Pure — no chain access, so it
 * is safe to precompute and compare against on-chain state.
 */
export function factSheetSchemaUid(): Hex {
  return keccak256(
    encodePacked(['string', 'address', 'bool'], [FACT_SHEET_EAS_SCHEMA, SCHEMA_RESOLVER, SCHEMA_REVOCABLE]),
  );
}

/**
 * Canonically serialise an arbitrary value: object keys sorted, arrays kept in
 * order (order is meaningful for our disclosure lists), bigints stringified. This
 * is the ONLY place disclosuresDigest input is shaped, so the digest is stable
 * across key-insertion order and JS engine quirks.
 *
 * `null` and `undefined`/omitted are normalised to a SINGLE canonical form (an
 * absent object key): the collector may represent "unknown holder/locker" as either
 * `null` or an omitted key across code paths, and both must digest identically or
 * the same launch would attest two distinct digests.
 */
function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const cv = canonicalize((value as Record<string, unknown>)[key]);
      // Drop null/undefined keys so `holder: null` ≡ omitted `holder` — one form.
      if (cv === null) continue;
      out[key] = cv;
    }
    return out;
  }
  return value;
}

/**
 * Stable JSON of the ENTIRE Fact Sheet — every tamper-sensitive field, with NO
 * exceptions. The flat FACT_SHEET_EAS_SCHEMA columns (token / chainId /
 * templateCodehash / knownSafeTemplate / tier / teamAllocation* /
 * liquidityUnlockAt / observedAt) ARE also folded in here alongside the rich
 * arrays (residualPowers / liquidity / feeConstitution / vesting) and the
 * committed-nowhere-else fields (gateChecks / totalSupply / tokenFactory / name /
 * symbol / schemaVersion). This is belt-and-suspenders on the flat columns: a
 * consumer who verifies tamper-evidence by recomputing the digest ALONE (without
 * separately re-checking each ABI column) would otherwise NOT detect a forged flat
 * field. With every field folded in, ONE digest covers the whole sheet — a forged
 * tier, an inflated supply, a doctored gate check, or a bumped schemaVersion all
 * change the digest. `liquidity.unlockAt` is covered transitively via `liquidity`.
 */
export function canonicalDisclosuresJson(sheet: LaunchFactSheet): string {
  return JSON.stringify(
    canonicalize({
      // schema envelope
      schemaVersion: sheet.schemaVersion,
      // identity
      token: sheet.token,
      chainId: sheet.chainId,
      name: sheet.name,
      symbol: sheet.symbol,
      totalSupply: sheet.totalSupply,
      // provenance
      tokenFactory: sheet.tokenFactory,
      templateCodehash: sheet.templateCodehash,
      knownSafeTemplate: sheet.knownSafeTemplate,
      // disclosures
      residualPowers: sheet.residualPowers,
      liquidity: sheet.liquidity,
      feeConstitution: sheet.feeConstitution,
      vesting: sheet.vesting,
      // The two third states are folded in as well, for the same reason as every other
      // field: a consumer recomputing this digest must be able to see that the sheet
      // declined to claim something. They are only ever present as `false`
      // (gate.buildFactSheet spreads nothing in the honest case), and `canonicalize`
      // drops absent keys — so a sheet that WAS fully read digests to exactly the same
      // 32 bytes it did before these fields existed. No prior attestation is orphaned.
      vestingReadable: sheet.vestingReadable,
      tierDeterminate: sheet.tierDeterminate,
      teamAllocationBps: sheet.teamAllocationBps,
      teamAllocationVestedBps: sheet.teamAllocationVestedBps,
      // outcome
      tier: sheet.tier,
      gateChecks: sheet.gateChecks,
      observedAt: sheet.observedAt,
    }),
  );
}

// ---------------------------------------------------------------------------
// FAIL-CLOSED. An attestation is a permanent, public, machine-read claim about
// somebody else's token. Attesting a WRONG fact is strictly worse than attesting
// nothing, so the encoder refuses rather than rounding an unknown down to zero.
// ---------------------------------------------------------------------------

/** Thrown instead of encoding a fact sheet whose columns would be false. */
export class AttestationRefused extends Error {
  readonly reason: 'tier-undetermined' | 'liquidity-unread';
  constructor(reason: 'tier-undetermined' | 'liquidity-unread', message: string) {
    super(message);
    this.name = 'AttestationRefused';
    this.reason = reason;
  }
}

/**
 * Why this sheet must NOT be attested, or null when it may be. Pure, non-throwing —
 * a UI can call it to disable the button and explain, instead of letting the user
 * discover the refusal by pressing it.
 *
 * Two of the schema's flat columns are lossy in exactly the way the rest of this
 * codebase refuses to be, and neither has room for a third value:
 *
 *   `uint8 tier`               0 means BOTH "evaluated, meets no bar" and "could not
 *                              be evaluated".
 *   `uint64 liquidityUnlockAt` 0 means BOTH "no lock" and "the locker was never
 *                              queried".
 *
 * The launch-time attest path lands on both at once. It re-collects the token's facts
 * with NO LockResolver, so `collector.DEFAULT_LOCK_RESOLVER` returns `readable: false`
 * having touched no chain; the two LP-lock checks then "fail", the tier collapses, and
 * a launch the wizard rendered FLAGSHIP one screen earlier is written to mainnet as
 * `tier = 0, liquidityUnlockAt = 0`. Permanently. About a stranger's token.
 *
 * The honest tier cannot be recovered here — the wizard's FLAGSHIP was a PROJECTION of
 * a lock that does not exist until graduation, so promoting the attested tier to match
 * it would forge the opposite lie. Refusing is the only correct third answer, and the
 * product already has the right path for it: attest after graduation, where
 * `lockerStream.lockResolverFor` supplies a lock state that was actually read.
 */
export function attestationRefusal(sheet: LaunchFactSheet): string | null {
  if (sheet.tierDeterminate === false) {
    return (
      'This launch cannot be attested yet: the tier is not settled. At least one gate check ' +
      'rests on something that could not be read, so the tier on the record would be a guess — ' +
      'and an attestation is permanent. Attest once the launch has graduated and its liquidity ' +
      'lock is readable on-chain. Your launch is unaffected.'
    );
  }
  if (sheet.liquidity.readable === false) {
    return (
      'This launch cannot be attested yet: the liquidity lock has not been read. The record ' +
      'would have to write an unlock time of zero, which reads as "no lock" rather than "not ' +
      'checked", and that claim would be permanent. Attest once the launch has graduated and ' +
      'the locker can be queried. Your launch is unaffected.'
    );
  }
  return null;
}

/** Throwing form of {@link attestationRefusal}, used at every encode/write seam. */
export function assertAttestable(sheet: LaunchFactSheet): void {
  const refusal = attestationRefusal(sheet);
  if (refusal) {
    throw new AttestationRefused(
      sheet.tierDeterminate === false ? 'tier-undetermined' : 'liquidity-unread',
      refusal,
    );
  }
}

/**
 * keccak digest of the WHOLE Fact Sheet (see canonicalDisclosuresJson — every
 * field, flat columns included). The full JSON is published off-chain + pinned;
 * the on-chain attestation commits only to this 32-byte digest, so the ENTIRE
 * sheet is tamper-evident (a forged gate check, an altered supply, a swapped tier,
 * or a changed observation time all change the digest) without bloating calldata.
 */
export function disclosuresDigest(sheet: LaunchFactSheet): Hex {
  return keccak256(toHex(canonicalDisclosuresJson(sheet)));
}

/**
 * ABI-encode a Fact Sheet into the bytes the EAS schema expects. Field order + types
 * exactly match FACT_SHEET_EAS_SCHEMA. Rich arrays are folded into disclosuresDigest;
 * a null templateCodehash / unlock time encodes as zero.
 *
 * THROWS {@link AttestationRefused} on a sheet whose tier or unlock time would be a
 * fabricated zero. The guard lives HERE, at the seam that turns a sheet into bytes,
 * rather than only in `attestFactSheet` — this is the single funnel every write path
 * goes through, so no future caller can route around it.
 */
export function encodeFactSheetData(sheet: LaunchFactSheet): Hex {
  assertAttestable(sheet);
  return encodeAbiParameters(parseAbiParameters(FACT_SHEET_EAS_SCHEMA), [
    sheet.token,
    BigInt(sheet.chainId),
    sheet.templateCodehash ?? ZERO_BYTES32,
    sheet.knownSafeTemplate,
    TIER_CODE[sheet.tier],
    sheet.teamAllocationBps,
    sheet.teamAllocationVestedBps,
    BigInt(sheet.liquidity.unlockAt ?? 0),
    disclosuresDigest(sheet),
    BigInt(sheet.observedAt),
  ]);
}

/** Optional overrides for an attestation. All default to a plain, revocable disclosure. */
export interface AttestFactSheetOptions {
  /** Override the schema UID (e.g. a testnet re-registration). Defaults to factSheetSchemaUid(). */
  schemaUid?: Hex;
  /** Reference another attestation (e.g. a prior revision). Defaults to 0x00..0. */
  refUID?: Hex;
  /** Attestation expiry (unix seconds); 0 = no expiry (default). */
  expirationTime?: bigint;
}

/**
 * Probe whether the Fact Sheet disclosure schema is registered on the mainnet
 * SchemaRegistry. Returns true (registered), false (not registered — a getSchema
 * that returns the empty record with a 0x0…0 uid), or null (unknown: a read/decode
 * error). Read-only; the same logic the launch-success path uses inline, exposed so
 * the post-graduation re-attestation panel can gate its button the same way (an
 * attestation against an unregistered schema reverts).
 */
export async function factSheetSchemaRegistered(publicClient: PublicClient): Promise<boolean | null> {
  try {
    const rec = (await publicClient.readContract({
      address: EAS_SCHEMA_REGISTRY_MAINNET,
      abi: EAS_SCHEMA_REGISTRY_ABI,
      functionName: 'getSchema',
      args: [factSheetSchemaUid()],
    })) as { uid?: `0x${string}` };
    return typeof rec?.uid === 'string' && !/^0x0*$/.test(rec.uid);
  } catch {
    return null;
  }
}

/**
 * Write a Fact Sheet as an EAS attestation. Simulates first (to read the returned
 * UID and surface reverts cleanly), then sends. The recipient is the launched
 * token — so the attestation is discoverable by token address.
 *
 * The caller already gates (isLauncherEnabled()) and only invokes this post-launch.
 * This helper ALSO checks the gate itself — defense-in-depth belt-and-suspenders on
 * a chain-WRITE seam — throwing before any client interaction if the launcher is off.
 */
export async function attestFactSheet(
  walletClient: WalletClient,
  publicClient: PublicClient,
  sheet: LaunchFactSheet,
  opts: AttestFactSheetOptions = {},
): Promise<{ uid: Hex; txHash: Hex }> {
  if (!isLauncherEnabled()) throw new Error('launcher gated');
  // Refuse a false record BEFORE any client interaction, on the same
  // belt-and-suspenders principle as the gate check above: `encodeFactSheetData`
  // would catch it a few lines later, but not until after we had built a request
  // around it. Nothing that would write a fabricated zero gets that far.
  assertAttestable(sheet);
  const account = walletClient.account;
  if (!account) throw new Error('attestFactSheet: walletClient has no account');

  const request = {
    schema: opts.schemaUid ?? factSheetSchemaUid(),
    data: {
      recipient: sheet.token,
      expirationTime: opts.expirationTime ?? 0n,
      revocable: SCHEMA_REVOCABLE,
      refUID: opts.refUID ?? ZERO_BYTES32,
      data: encodeFactSheetData(sheet),
      value: 0n,
    },
  } as const;

  // simulateContract returns the function's return value (the new attestation UID)
  // AND a prepared request we hand straight to writeContract.
  const { request: prepared, result } = await publicClient.simulateContract({
    address: EAS_MAINNET,
    abi: EAS_ABI,
    functionName: 'attest',
    args: [request],
    account,
  });

  const txHash = await walletClient.writeContract(prepared);
  return { uid: result as Hex, txHash };
}

// ---------------------------------------------------------------------------
// READ-BACK. Everything above WRITES an attestation; the token permalink needs to
// ask the opposite question — "is there one?" — without ever guessing the answer.
// ---------------------------------------------------------------------------

/**
 * Block the mainnet EAS was deployed in. Taken from the deployment receipt in
 * ethereum-attestation-service/eas-contracts (deployments/mainnet/EAS.json,
 * fetched 2026-07-30), not from a doc page — no attestation can predate it, so it
 * is the provable floor for a log scan.
 */
export const EAS_MAINNET_FIRST_BLOCK = 16_756_728n;

/**
 * `Attested` exactly as the mainnet EAS emits it — copied from that same
 * deployment ABI, NOT from memory. Three indexed topics (recipient, attester,
 * schema) is what makes a read-back possible at all: we attest with the launched
 * token as `recipient`, so a token + schema topic filter is a precise query.
 * `uid` is the only unindexed field.
 */
export const EAS_ATTESTED_EVENT = {
  type: 'event',
  name: 'Attested',
  inputs: [
    { name: 'recipient', type: 'address', indexed: true },
    { name: 'attester', type: 'address', indexed: true },
    { name: 'uid', type: 'bytes32', indexed: false },
    { name: 'schema', type: 'bytes32', indexed: true },
  ],
} as const;

/** `getAttestation` — the full on-chain record, including revocation. */
export const EAS_GET_ATTESTATION_ABI = [
  {
    type: 'function',
    name: 'getAttestation',
    stateMutability: 'view',
    inputs: [{ name: 'uid', type: 'bytes32' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'uid', type: 'bytes32' },
          { name: 'schema', type: 'bytes32' },
          { name: 'time', type: 'uint64' },
          { name: 'expirationTime', type: 'uint64' },
          { name: 'revocationTime', type: 'uint64' },
          { name: 'refUID', type: 'bytes32' },
          { name: 'recipient', type: 'address' },
          { name: 'attester', type: 'address' },
          { name: 'revocable', type: 'bool' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
  },
] as const;

/** One Fact Sheet attestation found on-chain for a token. */
export interface FactSheetAttestation {
  uid: Hex;
  attester: Address;
  /** Unix seconds. null when the log was found but the record could not be re-read. */
  time: number | null;
  /** null when unknown — never rendered as "not revoked" on a failed read. */
  revoked: boolean | null;
}

/**
 * Outcome of asking "has this token been attested under our disclosure schema?".
 *
 * `unverifiable` is a first-class result, not an error path. It means the QUESTION
 * went unanswered — the caller must render it as such and must NOT show it as
 * "not attested".
 */
export type AttestationLookup =
  | { status: 'attested'; attestations: FactSheetAttestation[] }
  | { status: 'none' }
  | { status: 'unverifiable'; reason: string };

/** Minimal read surface for the lookup; a real viem PublicClient satisfies it. */
export interface AttestationReadClient {
  // `any` for the same contravariance reason as collector.ts's ReadOnlyPublicClient.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  getLogs(args: any): Promise<unknown[]>;
  readContract(args: any): Promise<unknown>;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Decode a `getAttestation` tuple. Returns null on anything unexpected. Pure. */
export function decodeAttestationRecord(raw: unknown): { time: number; revoked: boolean } | null {
  if (raw == null || typeof raw !== 'object') return null;
  const arr = Array.isArray(raw);
  const time = arr ? (raw as readonly unknown[])[2] : (raw as Record<string, unknown>).time;
  const revocationTime = arr
    ? (raw as readonly unknown[])[4]
    : (raw as Record<string, unknown>).revocationTime;
  if (typeof time !== 'bigint' || typeof revocationTime !== 'bigint') return null;
  // time === 0 is EAS's "no such attestation" — a getAttestation for an unknown uid
  // returns a zeroed struct rather than reverting, so 0 must not read as "attested at
  // the unix epoch".
  if (time === 0n) return null;
  return { time: Number(time), revoked: revocationTime > 0n };
}

/**
 * Look up Fact Sheet attestations for `token` on the mainnet EAS.
 *
 * ⚠ FEASIBILITY, measured 2026-07-30 rather than assumed. There is NO EAS `Indexer`
 * contract on Ethereum mainnet (eas-contracts/deployments/mainnet contains only
 * EAS.json + SchemaRegistry.json), so a log scan is the only on-chain discovery path,
 * and all three public RPCs this app ships with (lib/wagmi.ts) refuse the full range:
 * publicnode rejects archive queries outright, drpc caps `eth_getLogs` at 10,000
 * blocks, merkle rate-limits. EAS deployed at block 16,756,728 and mainnet is past
 * 25.6M, so the honest expectation on today's transports is `unverifiable` — which is
 * precisely why that is a status and not a thrown error. Point this at any
 * archive-capable RPC and it answers for real; it never fabricates a "not attested".
 *
 * A found log already proves an attestation exists and names its attester (both are
 * indexed topics), so a failed `getAttestation` follow-up degrades to
 * `time: null, revoked: null` instead of discarding a proven attestation.
 */
export async function readFactSheetAttestations(
  client: AttestationReadClient,
  token: Address,
  opts: { fromBlock?: bigint; schemaUid?: Hex; max?: number } = {},
): Promise<AttestationLookup> {
  const schema = opts.schemaUid ?? factSheetSchemaUid();
  let logs: unknown[];
  try {
    logs = await client.getLogs({
      address: EAS_MAINNET,
      event: EAS_ATTESTED_EVENT,
      args: { recipient: token, schema },
      fromBlock: opts.fromBlock ?? EAS_MAINNET_FIRST_BLOCK,
      toBlock: 'latest',
    });
  } catch (e) {
    return {
      status: 'unverifiable',
      reason: e instanceof Error ? e.message : 'The attestation log query failed.',
    };
  }
  if (!Array.isArray(logs) || logs.length === 0) return { status: 'none' };

  // Newest first, bounded: one extra eth_call per attestation, and a token with a long
  // revision history should not turn a page load into an unbounded fan-out.
  const newest = logs.slice(-(opts.max ?? 3)).reverse();
  const attestations: FactSheetAttestation[] = [];
  for (const log of newest) {
    const args = (log as { args?: { uid?: unknown; attester?: unknown } }).args;
    const uid = args?.uid;
    const attester = args?.attester;
    if (typeof uid !== 'string' || typeof attester !== 'string') continue;
    let record: { time: number; revoked: boolean } | null;
    try {
      record = decodeAttestationRecord(
        await client.readContract({
          address: EAS_MAINNET,
          abi: EAS_GET_ATTESTATION_ABI,
          functionName: 'getAttestation',
          args: [uid],
        }),
      );
    } catch {
      record = null; // the log still proves existence; time/revocation stay unknown
    }
    attestations.push({
      uid: uid as Hex,
      attester: attester as Address,
      time: record?.time ?? null,
      revoked: record?.revoked ?? null,
    });
  }
  // Every log was malformed — we saw something but decoded nothing, which is an
  // unanswered question, not an absence.
  if (attestations.length === 0) {
    return { status: 'unverifiable', reason: 'Attestation logs were found but could not be decoded.' };
  }
  return { status: 'attested', attestations };
}

/**
 * Register the Fact Sheet schema once. Idempotent-ish: if the exact
 * (schema, resolver=0, revocable=true) triple already exists, the SchemaRegistry
 * reverts `AlreadyExists()` — callers should treat that as success. Returns the
 * transaction hash; the resulting schema UID is always factSheetSchemaUid().
 */
export async function registerFactSheetSchema(walletClient: WalletClient): Promise<{ uid: Hex; txHash: Hex }> {
  if (!isLauncherEnabled()) throw new Error('launcher gated');
  const account = walletClient.account;
  if (!account) throw new Error('registerFactSheetSchema: walletClient has no account');

  const txHash = await walletClient.writeContract({
    address: EAS_SCHEMA_REGISTRY_MAINNET,
    abi: EAS_SCHEMA_REGISTRY_ABI,
    functionName: 'register',
    args: [FACT_SHEET_EAS_SCHEMA, SCHEMA_RESOLVER, SCHEMA_REVOCABLE],
    account,
    chain: walletClient.chain,
  });
  return { uid: factSheetSchemaUid(), txHash };
}
