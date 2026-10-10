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
  rehearsalGlobalValues, e2eGlobalValues, ammConfigValues, ammConfig1Values, e2eAmmConfigValues, mainnetConfigMismatches, derived, readGolden,
  baylaMintStandIn, baylaMintAuthority, usdcMintStandIn, usdcMintAuthority, USDC_MINT, TOKEN_PROGRAM,
  LAUNCH_PROGRAM, CP_SWAP_PROGRAM, VAULT, DEPLOYER, BAYLA_MINT, TOKEN_2022_PROGRAM,
} from './genesis-accounts.mjs';

const idls = loadVerifiedIdls();
if (!idls) console.warn('[genesis-accounts.test] no pinned IDL found: this suite is NOT checked on this machine');

const clone = (x) => JSON.parse(JSON.stringify(x));

describe('the stand-in USDC mint', () => {
  const golden = readGolden('usdc-mint.mainnet.json');
  const g = Buffer.from(golden.account.data[0], 'base64');

  it('is the mainnet USDC mint: its real address, the classic token program, 82 bytes, 6 decimals, a mint and a freeze authority', () => {
    expect(golden.pubkey).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(USDC_MINT.toBase58()).toBe(golden.pubkey);
    expect(golden.account.owner).toBe('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    expect(TOKEN_PROGRAM.toBase58()).toBe(golden.account.owner);
    expect(g.length).toBe(82);
    expect(g[44]).toBe(6);
    expect(g.readUInt32LE(0)).toBe(1);
    expect(g.readUInt32LE(46)).toBe(1);
  });

  it('differs from mainnet ONLY in its mint authority, which is the harness test key', () => {
    const s = usdcMintStandIn();
    const b = Buffer.from(s.account.data[0], 'base64');
    expect(b.length).toBe(g.length);
    const differing = [];
    for (let i = 0; i < b.length; i++) if (b[i] !== g[i]) differing.push(i);
    expect(differing.length).toBeGreaterThan(0);
    // Only the 32 key bytes of the mint authority: its tag, the supply, the decimals and the freeze authority are mainnet's.
    expect(differing.filter((i) => i < 4 || i >= 36)).toEqual([]);
    expect(b.subarray(4, 36).equals(usdcMintAuthority().publicKey.toBuffer())).toBe(true);
    // A different key from $BAYLA's: one phrase must not mint both.
    expect(usdcMintAuthority().publicKey.equals(baylaMintAuthority().publicKey)).toBe(false);
    expect(s.pubkey).toBe(golden.pubkey);
    expect(s.account.owner).toBe(golden.account.owner);
    expect(s.account.lamports).toBe(golden.account.lamports);
    expect(s.account.space).toBe(golden.account.space);
  });

  it('refuses a dump that is not that mint', () => {
    const noAuthority = clone(golden);
    const d = Buffer.from(noAuthority.account.data[0], 'base64');
    d.writeUInt32LE(0, 0);
    noAuthority.account.data[0] = d.toString('base64');
    expect(() => usdcMintStandIn(noAuthority)).toThrow(/not the USDC mint/);
    expect(() => usdcMintStandIn({ ...golden, account: { ...golden.account, owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' } })).toThrow(/not the USDC mint/);
    expect(() => usdcMintStandIn({ ...golden, pubkey: VAULT.toBase58() })).toThrow(/not the USDC mint/);
    const nineDecimals = clone(golden);
    const e = Buffer.from(nineDecimals.account.data[0], 'base64');
    e[44] = 9;
    nineDecimals.account.data[0] = e.toString('base64');
    expect(() => usdcMintStandIn(nineDecimals)).toThrow(/not the USDC mint/);
  });
});

// No IDL needed: the stand-in is a mainnet read with one field changed.
describe('the stand-in $BAYLA mint', () => {
  const golden = readGolden('bayla-mint.mainnet.json');
  const g = Buffer.from(golden.account.data[0], 'base64');

  it('is the mainnet $BAYLA mint: its real address, Token-2022, 6 decimals, no mint or freeze authority', () => {
    expect(golden.pubkey).toBe('7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump');
    expect(BAYLA_MINT.toBase58()).toBe(golden.pubkey);
    expect(golden.account.owner).toBe('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
    expect(TOKEN_2022_PROGRAM.toBase58()).toBe(golden.account.owner);
    expect(g[44]).toBe(6);
    expect(g.readUInt32LE(0)).toBe(0);
    expect(g.readUInt32LE(46)).toBe(0);
  });

  it('differs from mainnet ONLY in its mint authority, which is the harness test key', () => {
    const s = baylaMintStandIn();
    const b = Buffer.from(s.account.data[0], 'base64');
    expect(b.length).toBe(g.length);
    const differing = [];
    for (let i = 0; i < b.length; i++) if (b[i] !== g[i]) differing.push(i);
    expect(differing.length).toBeGreaterThan(0);
    expect(differing.filter((i) => i >= 36)).toEqual([]);
    expect(b.readUInt32LE(0)).toBe(1);
    expect(b.subarray(4, 36).equals(baylaMintAuthority().publicKey.toBuffer())).toBe(true);
    expect(baylaMintAuthority().publicKey.toBase58()).toBe('7kELDkVhUAeJTi8o4RQZw9CU2EuRyEdQkQ9ruxeCC2Wd');
    expect(s.pubkey).toBe(golden.pubkey);
    expect(s.account.owner).toBe(golden.account.owner);
    expect(s.account.lamports).toBe(golden.account.lamports);
    expect(s.account.space).toBe(golden.account.space);
  });

  it('refuses a dump that is not that mint', () => {
    const withAuthority = clone(golden);
    const d = Buffer.from(withAuthority.account.data[0], 'base64');
    d.writeUInt32LE(1, 0);
    withAuthority.account.data[0] = d.toString('base64');
    expect(() => baylaMintStandIn(withAuthority)).toThrow(/not the \$BAYLA Token-2022 mint/);
    expect(() => baylaMintStandIn({ ...golden, account: { ...golden.account, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' } })).toThrow(/not the \$BAYLA/);
    expect(() => baylaMintStandIn({ ...golden, pubkey: VAULT.toBase58() })).toThrow(/not the \$BAYLA/);
  });
});

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
    // The plant needs $BAYLA on the chain: the stand-in mint is seeded at its real address.
    expect(accts['bayla-mint.json']).toEqual(baylaMintStandIn());
    // A pool may pair a token with USDC: its stand-in mint is seeded at its real address too.
    expect(accts['usdc-mint.json']).toEqual(usdcMintStandIn());
  });
it('config 1 (the public tier) is config 0 with ONLY its bump, index and fee fields changed', () => {
    const c0 = encodeIdlAccount(idls.cpIdl, 'AmmConfig', ammConfigValues());
    const c1 = encodeIdlAccount(idls.cpIdl, 'AmmConfig', ammConfig1Values());
    expect(c1.length).toBe(c0.length);
    // bump [8], index [10,12), trade [12,20), protocol [20,28), fund [28,36), create fee [36,44)
    const allowed = (i) => i === 8 || (i >= 10 && i < 44);
    const differing = [];
    for (let i = 0; i < c1.length; i++) if (c1[i] !== c0[i]) differing.push(i);
    expect(differing.filter((i) => !allowed(i))).toEqual([]);
    expect(c1[8]).toBe(derived().ammBump1);
    expect(c1.readUInt16LE(10)).toBe(1);
    expect(c1.readBigUInt64LE(12)).toBe(10_000n);
    expect(c1.readBigUInt64LE(20)).toBe(160_000n);
    expect(c1.readBigUInt64LE(28)).toBe(0n);
    expect(c1.readBigUInt64LE(36)).toBe(150_000_000n);
    // Both fee owners stay the vault.
    expect(c1.subarray(44, 76).equals(VAULT.toBuffer())).toBe(true);
    expect(c1.subarray(76, 108).equals(VAULT.toBuffer())).toBe(true);
    const accts = Object.fromEntries(buildGenesisAccounts(idls).map((a) => [a.file, a.json]));
    expect(accts['amm-config-1.json'].pubkey).toBe(derived().ammConfig1.toBase58());
    expect(accts['amm-config-1.json'].account.owner).toBe(CP_SWAP_PROGRAM.toBase58());
  });

  it('seeds fee tiers 0 and 1 with MAINNET\'s own bytes (read from api.mainnet-beta 2026-10-01)', () => {
    expect(mainnetConfigMismatches(idls)).toEqual([]);
    const accts = Object.fromEntries(buildGenesisAccounts(idls).map((a) => [a.file, a.json]));
    for (const [file, golden] of [['amm-config-1.json', 'amm-config-1.mainnet.json'], ['amm-config.json', 'amm-config-0.mainnet.json']]) {
      expect(accts[file].account.data[0], file).toBe(readGolden(golden).account.data[0]);
    }
    // Mainnet tier 0 after the fee proposals: 20% to the venue, a 0.05% creator fee.
    const c0 = encodeIdlAccount(idls.cpIdl, 'AmmConfig', e2eAmmConfigValues());
    expect(c0.readBigUInt64LE(20)).toBe(200_000n);
    expect(c0.readBigUInt64LE(108)).toBe(500n);
  });

  it('the mainnet check fails on a one-field difference in either tier', () => {
    const cpIdl = clone(idls.cpIdl);
    const f = cpIdl.types.find((t) => t.name === 'AmmConfig').type.fields;
    const a = f.findIndex((x) => x.name === 'trade_fee_rate');
    const b = f.findIndex((x) => x.name === 'protocol_fee_rate');
    [f[a], f[b]] = [f[b], f[a]];
    const problems = mainnetConfigMismatches({ ...idls, cpIdl });
    expect(problems.some((p) => p.startsWith('amm-config-1.mainnet.json'))).toBe(true);
    expect(problems.some((p) => p.startsWith('amm-config-0.mainnet.json'))).toBe(true);
  });
});
