// @vitest-environment node
//
// NODE, not jsdom: PublicKey.findProgramAddressSync fails every bump under jsdom
// (same reason as scripts/bayla-ladder-ops.test.mjs).
//
// Pins for the e2e genesis accounts. The claim under test is NOT "our encoder agrees
// with our decoder" (circular); it is "our encoder, fed the values the rehearsal passed
// to the REAL instructions, reproduces the bytes those instructions wrote to the
// rehearsal ledger" (golden/*.rehearsal.json).
//
// The IDLs come from the repo copy (solana/tegridy-amm/idl/) when it exists, else the
// release artifacts. Where neither exists the suite is skipped and says so; a skip is
// "not checked", never "passed".
import { describe, it, expect } from 'vitest';
import {
  loadVerifiedIdls, goldenMismatches, encodeIdlAccount, buildGenesisAccounts, rentExempt,
  rehearsalGlobalValues, e2eGlobalValues, ammConfigValues, derived, readGolden,
  LAUNCH_PROGRAM, CP_SWAP_PROGRAM, VAULT, DEPLOYER,
} from './genesis-accounts.mjs';

const idls = loadVerifiedIdls();
if (!idls) console.warn('[genesis-accounts.test] no pinned IDL found: this suite is NOT checked on this machine');

const clone = (x) => JSON.parse(JSON.stringify(x));

describe.skipIf(!idls)('e2e genesis accounts', () => {
  it('reproduces the rehearsal ledger byte for byte (GlobalConfig, AmmConfig, Permission)', () => {
    expect(goldenMismatches(idls)).toEqual([]);
  });

  it('the golden check fails when two fields swap places (it is sensitive to layout)', () => {
    const launchIdl = clone(idls.launchIdl);
    const f = launchIdl.types.find((t) => t.name === 'GlobalConfig').type.fields;
    const a = f.findIndex((x) => x.name === 'initial_virtual_sol');
    const b = f.findIndex((x) => x.name === 'initial_virtual_token');
    [f[a], f[b]] = [f[b], f[a]];
    expect(goldenMismatches({ ...idls, launchIdl }).some((p) => p.startsWith('global.rehearsal.json'))).toBe(true);
  });

  it('the golden check fails on a wrong discriminator or a wrong bump', () => {
    const cpIdl = clone(idls.cpIdl);
    cpIdl.accounts.find((x) => x.name === 'AmmConfig').discriminator[0] ^= 1;
    expect(goldenMismatches({ ...idls, cpIdl }).some((p) => p.startsWith('amm-config.rehearsal.json'))).toBe(true);
    const golden = Buffer.from(readGolden('global.rehearsal.json').account.data[0], 'base64');
    const wrongBump = encodeIdlAccount(idls.launchIdl, 'GlobalConfig', { ...rehearsalGlobalValues(), bump: derived().globalBump - 1 });
    expect(wrongBump.equals(golden)).toBe(false);
  });

  it('the e2e GlobalConfig differs from the rehearsal one ONLY in authority, virtual SOL and target', () => {
    const golden = Buffer.from(readGolden('global.rehearsal.json').account.data[0], 'base64');
    const e2e = encodeIdlAccount(idls.launchIdl, 'GlobalConfig', e2eGlobalValues());
    expect(e2e.length).toBe(202);
    const differing = [];
    for (let i = 0; i < e2e.length; i++) if (e2e[i] !== golden[i]) differing.push(i);
    // authority [8,40), initial_virtual_sol [88,96), graduation_target_lamports [112,120)
    const allowed = (i) => (i >= 8 && i < 40) || (i >= 88 && i < 96) || (i >= 112 && i < 120);
    expect(differing.length).toBeGreaterThan(0);
    expect(differing.filter((i) => !allowed(i))).toEqual([]);
    expect(e2e.subarray(8, 40).equals(DEPLOYER.toBuffer())).toBe(true);
    expect(e2e.readBigUInt64LE(88)).toBe(2_603_952_621n);
    expect(e2e.readBigUInt64LE(112)).toBe(1_000_000_000n);
  });

  it('refuses a missing or unknown field rather than writing a zero', () => {
    const v = { ...ammConfigValues() };
    delete v.trade_fee_rate;
    expect(() => encodeIdlAccount(idls.cpIdl, 'AmmConfig', v)).toThrow(/trade_fee_rate not given/);
    expect(() => encodeIdlAccount(idls.cpIdl, 'AmmConfig', { ...ammConfigValues(), tradeFeeRate: 1n })).toThrow(/unknown field/);
    expect(() => encodeIdlAccount(idls.cpIdl, 'AmmConfig', { ...ammConfigValues(), index: 70_000 })).toThrow(/out of u16 range/);
  });

  it('seeds rent-exempt accounts under the right owners, and the real vault and fee account', () => {
    const accts = Object.fromEntries(buildGenesisAccounts(idls).map((a) => [a.file, a.json]));
    const d = derived();
    expect(accts['global.json'].pubkey).toBe(d.global.toBase58());
    expect(accts['global.json'].account.owner).toBe(LAUNCH_PROGRAM.toBase58());
    expect(accts['amm-config.json'].account.owner).toBe(CP_SWAP_PROGRAM.toBase58());
    expect(accts['permission.json'].account.owner).toBe(CP_SWAP_PROGRAM.toBase58());
    for (const f of ['global.json', 'amm-config.json', 'permission.json']) {
      expect(accts[f].account.lamports).toBe(rentExempt(accts[f].account.space));
    }
    expect(accts['vault.json'].pubkey).toBe(VAULT.toBase58());
    // The vault's REAL mainnet balance, which is above the 0-byte rent floor (890,880):
    // a fee leg paid into it must not be refused for leaving it below rent.
    expect(accts['vault.json'].account.lamports).toBeGreaterThanOrEqual(rentExempt(0));
  });
});
