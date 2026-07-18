import { describe, it, expect } from 'vitest';
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

  it('does NOT depend on fields outside the disclosure set (e.g. observedAt)', () => {
    const base = factSheet();
    const laterObservation = factSheet({ observedAt: 1_752_799_999 });
    expect(disclosuresDigest(laterObservation)).toBe(disclosuresDigest(base));
  });

  it('serialises bigints in vesting without throwing', () => {
    const json = canonicalDisclosuresJson(factSheet());
    expect(json).toContain('5000000000000000000000'); // 5000e18 vesting amount, stringified
  });
});

describe('attestFactSheet — request shape (no live chain)', () => {
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
});

describe('registerFactSheetSchema — request shape (no live chain)', () => {
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
});
