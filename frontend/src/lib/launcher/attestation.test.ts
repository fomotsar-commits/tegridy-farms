import { describe, it, expect, vi, beforeEach } from 'vitest';

// The write helpers (attestFactSheet / registerFactSheetSchema) carry an internal
// defense-in-depth gate (INFO#17). Mock the launcher gate so we can drive both the
// happy path (enabled) and the gated-throw path (disabled). Pure digest/encode
// helpers don't touch the gate, so their tests are unaffected.
const gate = vi.hoisted(() => ({ enabled: true }));
vi.mock('./config', () => ({ isLauncherEnabled: () => gate.enabled }));

import {
  decodeAbiParameters,
  encodePacked,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import {
  EAS_MAINNET,
  EAS_SCHEMA_REGISTRY_MAINNET,
  factSheetSchemaUid,
  encodeFactSheetData,
  disclosuresDigest,
  canonicalDisclosuresJson,
  attestFactSheet,
  registerFactSheetSchema,
  EAS_ATTESTED_EVENT,
  EAS_MAINNET_FIRST_BLOCK,
  decodeAttestationRecord,
  readFactSheetAttestations,
} from './attestation';
import { FACT_SHEET_EAS_SCHEMA, TIER_CODE, type LaunchFactSheet } from './factSheet';

const TOKEN = '0xabcabcabcabcabcabcabcabcabcabcabcabcabca' as Address;
const OWNER = '0x1111111111111111111111111111111111111111' as Address;
const LOCKER = '0x2222222222222222222222222222222222222222' as Address;
const ATTESTER = '0x3333333333333333333333333333333333333333' as Address;
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;

function factSheet(overrides: Partial<LaunchFactSheet> = {}): LaunchFactSheet {
  return {
    schemaVersion: 1,
    token: TOKEN,
    chainId: 1,
    name: 'Tegridy Launch',
    symbol: 'TGL',
    totalSupply: 1_000_000_000n * 10n ** 18n,
    tokenFactory: '0x89c261c05b5f9b6bcba07c199b8dee7cfad45292' as Address,
    templateCodehash: null,
    knownSafeTemplate: true,
    residualPowers: [
      { power: 'mint', present: false, holder: null, disclosure: 'No mint function.' },
      { power: 'owner-privileged', present: true, holder: OWNER, disclosure: 'Owner retains privileges.' },
    ],
    liquidity: { locked: true, locker: LOCKER, unlockAt: 1_800_000_000, note: 'LP fee stream locked 12 months.' },
    feeConstitution: [
      { recipient: 'Creator', role: 'creator', shareBps: 7000 },
      { recipient: 'Doppler', role: 'doppler', shareBps: 500 },
    ],
    vesting: [{ beneficiary: OWNER, amount: 5_000n * 10n ** 18n, cliffSeconds: 0, durationSeconds: 31_536_000 }],
    teamAllocationBps: 250,
    teamAllocationVestedBps: 250,
    tier: 'flagship',
    gateChecks: [],
    observedAt: 1_752_700_000,
    ...overrides,
  };
}

describe('factSheetSchemaUid', () => {
  it('is deterministic across calls', () => {
    expect(factSheetSchemaUid()).toBe(factSheetSchemaUid());
  });

  it('is a 32-byte hex', () => {
    expect(factSheetSchemaUid()).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('equals keccak256(encodePacked(schema, address(0), true)) per EAS getUID', () => {
    const expected = keccak256(
      encodePacked(
        ['string', 'address', 'bool'],
        [FACT_SHEET_EAS_SCHEMA, '0x0000000000000000000000000000000000000000', true],
      ),
    );
    expect(factSheetSchemaUid()).toBe(expected);
  });

  it('changes if the schema string changes (guards against silent schema drift)', () => {
    const other = keccak256(
      encodePacked(
        ['string', 'address', 'bool'],
        [FACT_SHEET_EAS_SCHEMA + ',uint8 extra', '0x0000000000000000000000000000000000000000', true],
      ),
    );
    expect(other).not.toBe(factSheetSchemaUid());
  });
});

describe('encodeFactSheetData', () => {
  it('round-trips to the schema field shape', () => {
    const sheet = factSheet();
    const encoded = encodeFactSheetData(sheet);
    const decoded = decodeAbiParameters(parseAbiParameters(FACT_SHEET_EAS_SCHEMA), encoded);
    const [
      token,
      chainId,
      templateCodehash,
      knownSafeTemplate,
      tier,
      teamAllocationBps,
      teamAllocationVestedBps,
      liquidityUnlockAt,
      digest,
      observedAt,
    ] = decoded;

    expect((token as string).toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(chainId).toBe(1n);
    expect(templateCodehash).toBe(ZERO_BYTES32);
    expect(knownSafeTemplate).toBe(true);
    expect(tier).toBe(TIER_CODE.flagship);
    expect(teamAllocationBps).toBe(250);
    expect(teamAllocationVestedBps).toBe(250);
    expect(liquidityUnlockAt).toBe(1_800_000_000n);
    expect(digest).toBe(disclosuresDigest(sheet));
    expect(observedAt).toBe(1_752_700_000n);
  });

  it('encodes null templateCodehash and null unlockAt as zero', () => {
    const sheet = factSheet({
      templateCodehash: null,
      liquidity: { locked: false, locker: null, unlockAt: null, note: 'no lock' },
    });
    const decoded = decodeAbiParameters(parseAbiParameters(FACT_SHEET_EAS_SCHEMA), encodeFactSheetData(sheet));
    expect(decoded[2]).toBe(ZERO_BYTES32); // templateCodehash
    expect(decoded[7]).toBe(0n); // liquidityUnlockAt
  });

  it('preserves a non-null templateCodehash', () => {
    const codehash = keccak256('0xdeadbeef');
    const sheet = factSheet({ templateCodehash: codehash });
    const decoded = decodeAbiParameters(parseAbiParameters(FACT_SHEET_EAS_SCHEMA), encodeFactSheetData(sheet));
    expect(decoded[2]).toBe(codehash);
  });
});

describe('disclosuresDigest', () => {
  it('is stable across key-insertion order + repeated calls', () => {
    const a = factSheet();
    // Rebuild the liquidity object with keys in a different order.
    const b = factSheet({
      liquidity: { note: 'LP fee stream locked 12 months.', unlockAt: 1_800_000_000, locker: LOCKER, locked: true },
    });
    expect(disclosuresDigest(a)).toBe(disclosuresDigest(b));
    expect(disclosuresDigest(a)).toBe(disclosuresDigest(a));
  });

  it('changes when a residual power disclosure changes', () => {
    const base = factSheet();
    const changed = factSheet({
      residualPowers: [
        { power: 'mint', present: true, holder: OWNER, disclosure: 'Owner CAN mint new supply.' },
        { power: 'owner-privileged', present: true, holder: OWNER, disclosure: 'Owner retains privileges.' },
      ],
    });
    expect(disclosuresDigest(changed)).not.toBe(disclosuresDigest(base));
  });

  it('changes when the LP unlock time changes', () => {
    const base = factSheet();
    const changed = factSheet({
      liquidity: { locked: true, locker: LOCKER, unlockAt: 1_900_000_000, note: 'LP fee stream locked 12 months.' },
    });
    expect(disclosuresDigest(changed)).not.toBe(disclosuresDigest(base));
  });

  it('changes when observedAt changes (now folded into the whole-sheet digest)', () => {
    const base = factSheet();
    const laterObservation = factSheet({ observedAt: 1_752_799_999 });
    expect(disclosuresDigest(laterObservation)).not.toBe(disclosuresDigest(base));
  });

  it('changes when the tier changes (flat column now folded into the digest)', () => {
    const base = factSheet({ tier: 'flagship' });
    expect(disclosuresDigest(factSheet({ tier: 'listable' }))).not.toBe(disclosuresDigest(base));
    expect(disclosuresDigest(factSheet({ tier: 'none' }))).not.toBe(disclosuresDigest(base));
  });

  it('changes when team allocation bps change (flat columns now folded into the digest)', () => {
    const base = factSheet();
    expect(disclosuresDigest(factSheet({ teamAllocationBps: 251 }))).not.toBe(disclosuresDigest(base));
    expect(disclosuresDigest(factSheet({ teamAllocationVestedBps: 0 }))).not.toBe(disclosuresDigest(base));
  });

  it('changes when other flat columns change (token / chainId / codehash / knownSafeTemplate / schemaVersion)', () => {
    const base = factSheet();
    expect(disclosuresDigest(factSheet({ chainId: 8453 }))).not.toBe(disclosuresDigest(base));
    expect(disclosuresDigest(factSheet({ knownSafeTemplate: false }))).not.toBe(disclosuresDigest(base));
    expect(disclosuresDigest(factSheet({ templateCodehash: keccak256('0xbeef') }))).not.toBe(disclosuresDigest(base));
    expect(disclosuresDigest(factSheet({ token: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead' as Address }))).not.toBe(
      disclosuresDigest(base),
    );
  });

  it('serialises bigints in vesting without throwing', () => {
    const json = canonicalDisclosuresJson(factSheet());
    expect(json).toContain('5000000000000000000000'); // 5000e18 vesting amount, stringified
  });

  it('commits to gateChecks — a forged passing audit trail changes the digest', () => {
    const base = factSheet({ gateChecks: [] });
    const forged = factSheet({
      gateChecks: [{ id: 'lp-lock', requiredFor: 'flagship', passed: true, detail: 'FORGED: locked forever' }],
    });
    expect(disclosuresDigest(forged)).not.toBe(disclosuresDigest(base));
  });

  it('commits to totalSupply, tokenFactory, name, and symbol', () => {
    const base = factSheet();
    expect(disclosuresDigest(factSheet({ totalSupply: base.totalSupply + 1n }))).not.toBe(disclosuresDigest(base));
    expect(disclosuresDigest(factSheet({ tokenFactory: '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead' as Address }))).not.toBe(
      disclosuresDigest(base),
    );
    expect(disclosuresDigest(factSheet({ name: 'Different' }))).not.toBe(disclosuresDigest(base));
    expect(disclosuresDigest(factSheet({ symbol: 'XXX' }))).not.toBe(disclosuresDigest(base));
  });

  it('treats a null field and an omitted field identically (canonicalization symmetry)', () => {
    // holder: null vs holder omitted — the same "unknown" fact must digest the same.
    const withNull = factSheet({
      residualPowers: [{ power: 'mint', present: false, holder: null, disclosure: 'No mint function.' }],
    });
    const omitted = factSheet({
      residualPowers: [{ power: 'mint', present: false, disclosure: 'No mint function.' }],
    });
    expect(disclosuresDigest(withNull)).toBe(disclosuresDigest(omitted));
  });
});

describe('attestFactSheet — request shape (no live chain)', () => {
  beforeEach(() => {
    gate.enabled = true; // happy-path shape tests need the launcher gate open
  });

  it('simulates then writes an EAS.attest call with the token as recipient', async () => {
    const sheet = factSheet();
    let simulateArgs: any;
    let writeArg: any;
    const RETURNED_UID = keccak256('0xbeef') as Hex;
    const TX = ('0x' + 'ab'.repeat(32)) as Hex;

    const publicClient = {
      simulateContract: async (a: any) => {
        simulateArgs = a;
        return { request: { ...a, __prepared: true }, result: RETURNED_UID };
      },
    } as unknown as PublicClient;
    const walletClient = {
      account: { address: ATTESTER },
      chain: { id: 1 },
      writeContract: async (a: any) => {
        writeArg = a;
        return TX;
      },
    } as unknown as WalletClient;

    const { uid, txHash } = await attestFactSheet(walletClient, publicClient, sheet);

    expect(uid).toBe(RETURNED_UID);
    expect(txHash).toBe(TX);
    // Targets the canonical EAS contract + attest function.
    expect(simulateArgs.address).toBe(EAS_MAINNET);
    expect(simulateArgs.functionName).toBe('attest');
    // The request tuple is well-formed.
    const req = simulateArgs.args[0];
    expect(req.schema).toBe(factSheetSchemaUid());
    expect(req.data.recipient).toBe(TOKEN);
    expect(req.data.revocable).toBe(true);
    expect(req.data.expirationTime).toBe(0n);
    expect(req.data.refUID).toBe(ZERO_BYTES32);
    expect(req.data.value).toBe(0n);
    expect(req.data.data).toBe(encodeFactSheetData(sheet));
    // writeContract receives the prepared request from simulate.
    expect(writeArg.__prepared).toBe(true);
  });

  it('honors refUID + expirationTime overrides', async () => {
    const sheet = factSheet();
    const REF = keccak256('0xfeed') as Hex;
    let simulateArgs: any;
    const publicClient = {
      simulateContract: async (a: any) => {
        simulateArgs = a;
        return { request: a, result: ZERO_BYTES32 };
      },
    } as unknown as PublicClient;
    const walletClient = {
      account: { address: ATTESTER },
      writeContract: async () => '0x00' as Hex,
    } as unknown as WalletClient;

    await attestFactSheet(walletClient, publicClient, sheet, { refUID: REF, expirationTime: 123n });
    const req = simulateArgs.args[0];
    expect(req.data.refUID).toBe(REF);
    expect(req.data.expirationTime).toBe(123n);
  });

  it('throws if the wallet has no account (never fires a bad tx)', async () => {
    const publicClient = { simulateContract: async () => ({ request: {}, result: ZERO_BYTES32 }) } as unknown as PublicClient;
    const walletClient = { writeContract: async () => '0x' } as unknown as WalletClient;
    await expect(attestFactSheet(walletClient, publicClient, factSheet())).rejects.toThrow(/no account/);
  });

  it('throws before any client interaction when the launcher is gated (INFO#17)', async () => {
    gate.enabled = false;
    let simulated = false;
    let wrote = false;
    const publicClient = {
      simulateContract: async () => {
        simulated = true;
        return { request: {}, result: ZERO_BYTES32 };
      },
    } as unknown as PublicClient;
    const walletClient = {
      account: { address: ATTESTER },
      writeContract: async () => {
        wrote = true;
        return '0x' as Hex;
      },
    } as unknown as WalletClient;

    await expect(attestFactSheet(walletClient, publicClient, factSheet())).rejects.toThrow(/launcher gated/);
    expect(simulated).toBe(false);
    expect(wrote).toBe(false);
  });
});

describe('registerFactSheetSchema — request shape (no live chain)', () => {
  beforeEach(() => {
    gate.enabled = true; // happy-path shape tests need the launcher gate open
  });

  it('calls SchemaRegistry.register with resolver=0, revocable=true and returns the deterministic UID', async () => {
    let writeArg: any;
    const TX = ('0x' + 'cd'.repeat(32)) as Hex;
    const walletClient = {
      account: { address: ATTESTER },
      chain: { id: 1 },
      writeContract: async (a: any) => {
        writeArg = a;
        return TX;
      },
    } as unknown as WalletClient;

    const { uid, txHash } = await registerFactSheetSchema(walletClient);
    expect(txHash).toBe(TX);
    expect(uid).toBe(factSheetSchemaUid());
    expect(writeArg.address).toBe(EAS_SCHEMA_REGISTRY_MAINNET);
    expect(writeArg.functionName).toBe('register');
    expect(writeArg.args[0]).toBe(FACT_SHEET_EAS_SCHEMA);
    expect(writeArg.args[1]).toBe('0x0000000000000000000000000000000000000000');
    expect(writeArg.args[2]).toBe(true);
  });

  it('throws if the wallet has no account', async () => {
    const walletClient = { writeContract: async () => '0x' } as unknown as WalletClient;
    await expect(registerFactSheetSchema(walletClient)).rejects.toThrow(/no account/);
  });

  it('throws before any client interaction when the launcher is gated (INFO#17)', async () => {
    gate.enabled = false;
    let wrote = false;
    const walletClient = {
      account: { address: ATTESTER },
      chain: { id: 1 },
      writeContract: async () => {
        wrote = true;
        return '0x' as Hex;
      },
    } as unknown as WalletClient;

    await expect(registerFactSheetSchema(walletClient)).rejects.toThrow(/launcher gated/);
    expect(wrote).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Read-back — "has this token been attested?"
// ---------------------------------------------------------------------------

const UID_A = ('0x' + 'a1'.repeat(32)) as Hex;
const UID_B = ('0x' + 'b2'.repeat(32)) as Hex;

/** A decoded viem log for the Attested event. */
function attestedLog(uid: Hex, attester: Address = ATTESTER) {
  return { args: { recipient: TOKEN, attester, uid, schema: factSheetSchemaUid() } };
}

/** A getAttestation tuple in the EAS struct's own field order. */
function attestationTuple(time: bigint, revocationTime = 0n): readonly unknown[] {
  return [UID_A, factSheetSchemaUid(), time, 0n, revocationTime, ZERO_BYTES32, TOKEN, ATTESTER, true, '0x'];
}

describe('EAS_ATTESTED_EVENT', () => {
  // Copied from eas-contracts/deployments/mainnet/EAS.json, not from memory. If the
  // indexed set ever drifts, the recipient+schema topic filter silently matches
  // nothing — which is indistinguishable from "never attested".
  it('indexes recipient, attester and schema; uid is the only unindexed field', () => {
    const indexed = EAS_ATTESTED_EVENT.inputs.filter((i) => i.indexed).map((i) => i.name);
    expect(indexed).toEqual(['recipient', 'attester', 'schema']);
    expect(EAS_ATTESTED_EVENT.inputs.find((i) => i.name === 'uid')?.indexed).toBe(false);
  });

  it('pins the mainnet EAS deployment block as the scan floor', () => {
    expect(EAS_MAINNET_FIRST_BLOCK).toBe(16_756_728n);
  });
});

describe('decodeAttestationRecord', () => {
  it('reads time and derives revocation from revocationTime', () => {
    expect(decodeAttestationRecord(attestationTuple(1_800_000_000n))).toEqual({
      time: 1_800_000_000,
      revoked: false,
    });
    expect(decodeAttestationRecord(attestationTuple(1_800_000_000n, 1_800_000_999n))).toEqual({
      time: 1_800_000_000,
      revoked: true,
    });
  });

  it('accepts the named-object form as well as the tuple', () => {
    expect(decodeAttestationRecord({ time: 42n, revocationTime: 0n })).toEqual({ time: 42, revoked: false });
  });

  it('treats a zeroed record as ABSENT rather than "attested at the unix epoch"', () => {
    expect(decodeAttestationRecord(attestationTuple(0n))).toBeNull();
  });

  it('returns null on anything it cannot decode', () => {
    expect(decodeAttestationRecord(null)).toBeNull();
    expect(decodeAttestationRecord('0x')).toBeNull();
    expect(decodeAttestationRecord({ time: 1 })).toBeNull();
  });
});

describe('readFactSheetAttestations', () => {
  it('queries the EAS with a recipient + schema topic filter from the deployment block', async () => {
    let seen: Record<string, unknown> | undefined;
    const client = {
      getLogs: async (args: Record<string, unknown>) => {
        seen = args;
        return [];
      },
      readContract: async () => null,
    };
    await readFactSheetAttestations(client, TOKEN);
    expect(seen?.address).toBe(EAS_MAINNET);
    expect(seen?.fromBlock).toBe(EAS_MAINNET_FIRST_BLOCK);
    expect(seen?.args).toEqual({ recipient: TOKEN, schema: factSheetSchemaUid() });
  });

  it('reports an empty log set as a real "none"', async () => {
    const client = { getLogs: async () => [], readContract: async () => null };
    expect(await readFactSheetAttestations(client, TOKEN)).toEqual({ status: 'none' });
  });

  // The bug class this whole read guards against: an RPC that refuses the query must
  // NOT render as "this token has never been attested".
  it('reports an RPC failure as UNVERIFIABLE, never as "none"', async () => {
    const client = {
      getLogs: async () => {
        throw new Error('ranges over 10000 blocks are not supported on free plan');
      },
      readContract: async () => null,
    };
    const r = await readFactSheetAttestations(client, TOKEN);
    expect(r.status).toBe('unverifiable');
    if (r.status === 'unverifiable') expect(r.reason).toMatch(/10000 blocks/);
  });

  it('returns the attestation with its attester, timestamp and revocation state', async () => {
    const client = {
      getLogs: async () => [attestedLog(UID_A)],
      readContract: async () => attestationTuple(1_800_000_000n),
    };
    const r = await readFactSheetAttestations(client, TOKEN);
    expect(r).toEqual({
      status: 'attested',
      attestations: [{ uid: UID_A, attester: ATTESTER, time: 1_800_000_000, revoked: false }],
    });
  });

  it('keeps a proven attestation when the getAttestation follow-up fails, with UNKNOWN time', async () => {
    // The log alone proves existence and names the attester (both indexed). Dropping
    // it would turn a real attestation into a "none".
    const client = {
      getLogs: async () => [attestedLog(UID_A)],
      readContract: async () => {
        throw new Error('rpc down');
      },
    };
    const r = await readFactSheetAttestations(client, TOKEN);
    expect(r).toEqual({
      status: 'attested',
      attestations: [{ uid: UID_A, attester: ATTESTER, time: null, revoked: null }],
    });
  });

  it('returns the newest attestations first and bounds the follow-up reads', async () => {
    const client = {
      getLogs: async () => [attestedLog(UID_A), attestedLog(UID_B)],
      readContract: async () => attestationTuple(1n),
    };
    const r = await readFactSheetAttestations(client, TOKEN, { max: 1 });
    expect(r.status).toBe('attested');
    if (r.status === 'attested') {
      expect(r.attestations).toHaveLength(1);
      expect(r.attestations[0].uid).toBe(UID_B); // getLogs is ascending → last is newest
    }
  });

  it('reports logs it cannot decode as unverifiable, not as "none"', async () => {
    const client = { getLogs: async () => [{ args: {} }], readContract: async () => null };
    const r = await readFactSheetAttestations(client, TOKEN);
    expect(r.status).toBe('unverifiable');
  });
});
