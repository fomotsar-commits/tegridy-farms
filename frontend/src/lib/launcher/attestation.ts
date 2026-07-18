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
      teamAllocationBps: sheet.teamAllocationBps,
      teamAllocationVestedBps: sheet.teamAllocationVestedBps,
      // outcome
      tier: sheet.tier,
      gateChecks: sheet.gateChecks,
      observedAt: sheet.observedAt,
    }),
  );
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
 */
export function encodeFactSheetData(sheet: LaunchFactSheet): Hex {
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
