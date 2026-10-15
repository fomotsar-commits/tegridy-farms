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
  getAddress,
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
      // What set the venue's line. Folded in for the same reason as the constitution
      // itself — it is a published claim about where the money goes, and a claim outside
      // the digest is a claim nobody can check. Present only when a pricing feature was
      // in force, and `canonicalize` drops absent keys, so a standard-rate sheet digests
      // to exactly the 32 bytes it did before this field existed.
      pricing: sheet.pricing,
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
 * Block the mainnet EAS was deployed in, from the deployment receipt in
 * eas-contracts (deployments/mainnet/EAS.json, fetched 2026-07-30). No attestation
 * predates it, so it is the floor of the log scan (api/_lib/eas-attested.js pins it).
 */
export const EAS_MAINNET_FIRST_BLOCK = 16_756_728n;

/**
 * `Attested` exactly as the mainnet EAS emits it, copied from that deployment ABI.
 * recipient, attester and schema are indexed, so a token + schema topic filter is a
 * precise query (we attest with the launched token as `recipient`); `uid` is the data.
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
 * `unverifiable` is a first-class result: the QUESTION went unanswered, and the caller
 * must never show it as "not attested". `detail` says what failed, in a developer's
 * words, for the small print only; the visible line is the page's own sentence.
 */
export type AttestationLookup =
  | { status: 'attested'; attestations: FactSheetAttestation[] }
  | { status: 'none' }
  | { status: 'unverifiable'; detail: string };

/** Minimal read surface for the lookup; a real viem PublicClient satisfies it. */
export interface AttestationReadClient {
  // `any` for the same contravariance reason as collector.ts's ReadOnlyPublicClient.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readContract(args: any): Promise<unknown>;
}

/** What the record must name for a log's uid to count: the chain's word over the lookup's. */
export interface AttestationClaim {
  uid: Hex;
  schema: Hex;
  recipient: Address;
}

const same = (a: unknown, b: string) => typeof a === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * Decode a `getAttestation` tuple. Null on anything unexpected, and, given a `claim`, on a
 * record naming another uid, schema or recipient. Pure.
 */
export function decodeAttestationRecord(raw: unknown, claim?: AttestationClaim): { time: number; revoked: boolean } | null {
  if (raw == null || typeof raw !== 'object') return null;
  const arr = Array.isArray(raw);
  const field = (name: string, index: number) =>
    arr ? (raw as readonly unknown[])[index] : (raw as Record<string, unknown>)[name];
  const time = field('time', 2);
  const revocationTime = field('revocationTime', 4);
  if (typeof time !== 'bigint' || typeof revocationTime !== 'bigint') return null;
  // EAS answers an unknown uid with a zeroed struct, not a revert: 0 is "no such attestation".
  if (time === 0n) return null;
  if (claim && !(same(field('uid', 0), claim.uid) && same(field('schema', 1), claim.schema) && same(field('recipient', 6), claim.recipient))) {
    return null;
  }
  return { time: Number(time), revoked: revocationTime > 0n };
}

/** One `Attested` log as our backend names it: a hint, until the EAS record agrees. */
export interface AttestedLog {
  uid: Hex;
  attester: Address;
}

/** Oldest first. `[]` means the history was read and holds none; a failed read THROWS. */
export type AttestedLogSource = (recipient: Address, schema: Hex) => Promise<AttestedLog[]>;

export const EAS_ATTESTED_ENDPOINT = '/api/aggregator';
const WORD_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The browser cannot run this query: every RPC it reaches refuses an eth_getLogs over
 * EAS's whole life (publicnode wants an archive token, drpc caps a range at 10,000
 * blocks). Our backend asks keyless Blockscout (api/_lib/eas-attested.js).
 */
export const fetchAttestedLogs: AttestedLogSource = async (recipient, schema) => {
  const q = new URLSearchParams({ resource: 'eas-attested', recipient, schema });
  const res = await fetch(`${EAS_ATTESTED_ENDPOINT}?${q}`);
  if (!res.ok) throw new Error(`the lookup answered HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as { attestations?: unknown } | null;
  if (!Array.isArray(body?.attestations)) throw new Error('the lookup answered without a list');
  return body.attestations.map((a: unknown) => {
    const { uid, attester } = (a ?? {}) as { uid?: unknown; attester?: unknown };
    if (typeof uid !== 'string' || !WORD_RE.test(uid) || typeof attester !== 'string' || !ADDRESS_RE.test(attester)) {
      throw new Error('the lookup named an attestation it did not spell out');
    }
    return { uid: uid as Hex, attester: getAddress(attester) };
  });
};

/** An error's first line, bounded: viem's messages run to a page of request body. */
const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0]!.slice(0, 160);

/**
 * Look up Fact Sheet attestations for `token` on the mainnet EAS. Mainnet has no EAS
 * indexer contract, so discovery is a log scan, which only our backend can run.
 *
 * Each uid the lookup names is re-read with `getAttestation`. A record that names
 * another schema or recipient, or none at all, drops that uid. A re-read that FAILS
 * keeps it with `time: null, revoked: null`: the log names it, the chain was not asked.
 */
export async function readFactSheetAttestations(
  client: AttestationReadClient,
  token: Address,
  opts: { schemaUid?: Hex; max?: number; logs?: AttestedLogSource } = {},
): Promise<AttestationLookup> {
  const schema = opts.schemaUid ?? factSheetSchemaUid();
  let logs: AttestedLog[];
  try {
    logs = await (opts.logs ?? fetchAttestedLogs)(token, schema);
  } catch (e) {
    return { status: 'unverifiable', detail: firstLine(e) };
  }
  if (logs.length === 0) return { status: 'none' };

  // Newest first, bounded: one eth_call per attestation, and a long revision history
  // must not turn a page load into an unbounded fan-out.
  const newest = logs.slice(-(opts.max ?? 3)).reverse();
  const attestations: FactSheetAttestation[] = [];
  for (const { uid, attester } of newest) {
    let raw: unknown;
    try {
      raw = await client.readContract({
        address: EAS_MAINNET,
        abi: EAS_GET_ATTESTATION_ABI,
        functionName: 'getAttestation',
        args: [uid],
      });
    } catch {
      attestations.push({ uid, attester, time: null, revoked: null });
      continue;
    }
    const record = decodeAttestationRecord(raw, { uid, schema, recipient: token });
    if (record) attestations.push({ uid, attester, ...record });
  }
  // The lookup named attestations the EAS contract does not hold: its answer is wrong,
  // so its "none" would be too.
  if (attestations.length === 0) {
    return { status: 'unverifiable', detail: 'the EAS contract does not hold the attestations the lookup named' };
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
