// @vitest-environment node
// PDA derivation must run in the NODE environment, matching dbcClient.test.ts.
// Under the default jsdom env, vitest's realm has its own `Uint8Array`, so the
// `instanceof Uint8Array` guard inside @noble/hashes rejects EVERY seed — even a
// literal `Uint8Array.from([...])`. `findProgramAddressSync` swallows that
// TypeError as "this bump is on the curve", walks all 255 nonces, and dies as
// "Unable to find a viable program address nonce" — a message that reads like a
// bad seed rather than a wrong test environment. Measured here, 2026-08-01.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  TEGRIDY_LAUNCH_PROGRAM_ID,
  GLOBAL_CONFIG_LEN,
  MIN_MIGRATION_RESERVE_LAMPORTS,
  deriveGlobalConfigPda,
  decodeGlobalConfig,
  graduationVenue,
  classifyProgramAccount,
  fetchProgramDeployment,
  fetchGlobalConfig,
  fetchLaunchProtocolStatus,
  maxReachableRealSol,
  graduationPriceRatioBps,
  continuityTarget,
  checkLaunchEconomics,
  encodeInitializeGlobalData,
  encodeUpdateGlobalData,
  CurveConfigError,
  type GlobalConfig,
} from './tegridyLaunch';

// Anchor sha256("account:GlobalConfig")[0..8] — recomputed here rather than imported,
// so a change to the module's copy cannot silently agree with itself.
const DISCRIMINATOR = [149, 8, 156, 202, 160, 252, 176, 217];
const ZERO_KEY = '11111111111111111111111111111111';
const AUTHORITY = 'SQDSvaU1t1111111111111111111111111111111111';
// Real 32-byte keys — these go through `new PublicKey`, so a short base58 literal
// (the shape dbc.test.ts uses for plain strings) would throw rather than encode.
const FEE_RECIPIENT = '2jiPrz5gt6tqGfvGiUUTbfVbmc11o1gwp58JUw2zohwX';
const CP_SWAP = 'BvBkt84ZiKmiPSuWrdefxbxPTX5YiLnU6YEGtY6pDodL';
const AMM_CONFIG = 'CBj8RNexvESC7X7WzJf6BTNfZCEtCaFXnWAGPG7mYQqH';

/** Encode a `GlobalConfig` exactly as the program lays it out (state.rs:77-120). */
function encodeGlobalConfig(c: Partial<GlobalConfig> = {}): Uint8Array {
  const buf = new Uint8Array(GLOBAL_CONFIG_LEN);
  buf.set(DISCRIMINATOR, 0);
  const view = new DataView(buf.buffer);
  const key = (off: number, k: string) => buf.set(new PublicKey(k).toBytes(), off);
  key(8, c.authority ?? AUTHORITY);
  key(40, c.feeRecipient ?? FEE_RECIPIENT);
  view.setBigUint64(72, c.tradeFeeBps ?? 100n, true);
  view.setBigUint64(80, c.initialVirtualSol ?? 30_000_000_000n, true);
  view.setBigUint64(88, c.initialVirtualToken ?? 1_073_000_000_000_000n, true);
  view.setBigUint64(96, c.tokenTotalSupply ?? 1_000_000_000_000_000n, true);
  view.setBigUint64(104, c.graduationTargetLamports ?? 11_685_689_681n, true);
  view.setBigUint64(112, c.migrationReserveLamports ?? MIN_MIGRATION_RESERVE_LAMPORTS, true);
  key(120, c.cpSwapProgram ?? CP_SWAP);
  key(152, c.ammConfig ?? AMM_CONFIG);
  buf[184] = c.paused ? 1 : 0;
  buf[185] = c.bump ?? 255;
  return buf;
}

/** Minimal `getAccountInfo` stub. `data` of `undefined` means "account absent". */
function fakeConnection(byAddress: Record<string, { executable: boolean; owner: string; data: Uint8Array } | null>) {
  return {
    getAccountInfo: async (pk: PublicKey) => {
      const hit = byAddress[pk.toBase58()];
      if (!hit) return null;
      return { executable: hit.executable, owner: new PublicKey(hit.owner), data: hit.data };
    },
  };
}

const BPF_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';

describe('identity + PDA derivation', () => {
  it('derives the global PDA from the program id rather than hardcoding it', () => {
    const expected = PublicKey.findProgramAddressSync(
      [Buffer.from('global')],
      new PublicKey(TEGRIDY_LAUNCH_PROGRAM_ID),
    )[0].toBase58();
    expect(deriveGlobalConfigPda()).toBe(expected);
    // Pinned: the value independently computed for the PLACEHOLDER program id.
    expect(deriveGlobalConfigPda()).toBe('AS1dDKPm8mkLuZYmmkpecWyLo8AbQbqtndnsjCEVZuP');
  });

  it('follows the program id when it changes — the real deploy will not reuse the placeholder', () => {
    const other = deriveGlobalConfigPda(CP_SWAP);
    expect(other).not.toBe(deriveGlobalConfigPda());
  });

  it('rejects a malformed program id instead of returning a plausible address', () => {
    expect(() => deriveGlobalConfigPda('not-base58!!')).toThrow();
  });
});

describe('decodeGlobalConfig', () => {
  it('decodes every field at its declared offset', () => {
    const r = decodeGlobalConfig(encodeGlobalConfig());
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.config).toEqual({
      authority: AUTHORITY,
      feeRecipient: FEE_RECIPIENT,
      tradeFeeBps: 100n,
      initialVirtualSol: 30_000_000_000n,
      initialVirtualToken: 1_073_000_000_000_000n,
      tokenTotalSupply: 1_000_000_000_000_000n,
      graduationTargetLamports: 11_685_689_681n,
      migrationReserveLamports: MIN_MIGRATION_RESERVE_LAMPORTS,
      cpSwapProgram: CP_SWAP,
      ammConfig: AMM_CONFIG,
      paused: false,
      bump: 255,
    });
  });

  it('keeps u64 values as bigint — token_total_supply exceeds Number.MAX_SAFE_INTEGER', () => {
    const r = decodeGlobalConfig(encodeGlobalConfig({ tokenTotalSupply: 9_007_199_254_740_993n }));
    expect(r.kind === 'ok' && r.config.tokenTotalSupply).toBe(9_007_199_254_740_993n);
  });

  it('reads paused = true', () => {
    const r = decodeGlobalConfig(encodeGlobalConfig({ paused: true }));
    expect(r.kind === 'ok' && r.config.paused).toBe(true);
  });

  it('rejects a wrong discriminator rather than offset-parsing a foreign account', () => {
    const buf = encodeGlobalConfig();
    buf[0] ^= 0xff;
    const r = decodeGlobalConfig(buf);
    expect(r.kind).toBe('malformed');
    expect(r.kind === 'malformed' && r.reason).toMatch(/discriminator/);
  });

  it('rejects a wrong length', () => {
    expect(decodeGlobalConfig(encodeGlobalConfig().slice(0, 100)).kind).toBe('malformed');
    expect(decodeGlobalConfig(new Uint8Array(GLOBAL_CONFIG_LEN + 1)).kind).toBe('malformed');
  });

  it('rejects a non-borsh bool byte instead of coercing it to true', () => {
    const buf = encodeGlobalConfig();
    buf[184] = 2;
    const r = decodeGlobalConfig(buf);
    expect(r.kind).toBe('malformed');
    expect(r.kind === 'malformed' && r.reason).toMatch(/paused/);
  });

  it('treats absent data as malformed, never as a zeroed config', () => {
    expect(decodeGlobalConfig(null).kind).toBe('malformed');
    expect(decodeGlobalConfig(undefined).kind).toBe('malformed');
  });
});

describe('graduationVenue — an all-zero address is a REAL state, not an error', () => {
  const cfg = (over: Partial<GlobalConfig>) => {
    const r = decodeGlobalConfig(encodeGlobalConfig(over));
    if (r.kind !== 'ok') throw new Error('fixture did not decode');
    return r.config;
  };

  it('reports not-configured when cp_swap_program is zero', () => {
    expect(graduationVenue(cfg({ cpSwapProgram: ZERO_KEY })).kind).toBe('not-configured');
  });

  it('reports not-configured when amm_config is zero', () => {
    expect(graduationVenue(cfg({ ammConfig: ZERO_KEY })).kind).toBe('not-configured');
  });

  it('reports configured only when both are set', () => {
    expect(graduationVenue(cfg({}))).toEqual({
      kind: 'configured',
      cpSwapProgram: CP_SWAP,
      ammConfig: AMM_CONFIG,
    });
  });
});

describe('classifyProgramAccount', () => {
  it('absent account is not-deployed', () => {
    expect(classifyProgramAccount(TEGRIDY_LAUNCH_PROGRAM_ID, null)).toEqual({
      kind: 'not-deployed',
      programId: TEGRIDY_LAUNCH_PROGRAM_ID,
    });
  });

  it('a funded but NON-executable account is not-a-program, never "deployed"', () => {
    // Anyone may transfer lamports to the (public) program address; that must not
    // read as a live protocol.
    const r = classifyProgramAccount(TEGRIDY_LAUNCH_PROGRAM_ID, {
      executable: false,
      owner: new PublicKey(ZERO_KEY),
      data: new Uint8Array(0),
    });
    expect(r.kind).toBe('not-a-program');
  });

  it('an executable account is deployed', () => {
    const r = classifyProgramAccount(TEGRIDY_LAUNCH_PROGRAM_ID, {
      executable: true,
      owner: new PublicKey(BPF_LOADER),
      data: new Uint8Array(36),
    });
    expect(r).toEqual({
      kind: 'deployed',
      programId: TEGRIDY_LAUNCH_PROGRAM_ID,
      owner: BPF_LOADER,
      dataLen: 36,
    });
  });
});

describe('reads — an RPC failure is never a finding about the protocol', () => {
  const throwingConnection = {
    getAccountInfo: async () => {
      throw new Error('503 Service Unavailable — upstream RPC refused');
    },
  };

  it('a failed program read is unreadable, NOT not-deployed', async () => {
    const r = await fetchProgramDeployment(throwingConnection);
    expect(r.kind).toBe('unreadable');
    expect(r.kind === 'unreadable' && r.reason).toMatch(/503/);
  });

  it('a failed global read is unreadable, NOT not-initialized', async () => {
    const r = await fetchGlobalConfig(throwingConnection);
    expect(r.kind).toBe('unreadable');
  });

  it('clips a huge RPC error rather than spilling it onto a page', async () => {
    const r = await fetchProgramDeployment({
      getAccountInfo: async () => {
        throw new Error('x'.repeat(5000));
      },
    });
    expect(r.kind === 'unreadable' && r.reason.length).toBeLessThanOrEqual(181);
  });

  it('an existing-but-foreign account at the global PDA is malformed, not initialized', async () => {
    const addr = deriveGlobalConfigPda();
    const conn = fakeConnection({
      [addr]: { executable: false, owner: TEGRIDY_LAUNCH_PROGRAM_ID, data: new Uint8Array(186) },
    });
    const r = await fetchGlobalConfig(conn);
    expect(r.kind).toBe('malformed');
  });
});

describe('fetchLaunchProtocolStatus — the honest short-circuit', () => {
  it('does not look at global when the program is not deployed', async () => {
    // This is the live state: verified null on mainnet-beta AND devnet, 2026-08-01.
    const r = await fetchLaunchProtocolStatus(fakeConnection({}));
    expect(r.program.kind).toBe('not-deployed');
    // `null` = deliberately did not look. NOT `not-initialized`, which would be a
    // claim about a protocol that does not exist.
    expect(r.global).toBeNull();
  });

  it('does not look at global when the program read failed', async () => {
    const r = await fetchLaunchProtocolStatus({
      getAccountInfo: async () => {
        throw new Error('timeout');
      },
    });
    expect(r.program.kind).toBe('unreadable');
    expect(r.global).toBeNull();
  });

  it('reads global once the program really is deployed', async () => {
    const r = await fetchLaunchProtocolStatus(
      fakeConnection({
        [TEGRIDY_LAUNCH_PROGRAM_ID]: { executable: true, owner: BPF_LOADER, data: new Uint8Array(36) },
        [deriveGlobalConfigPda()]: {
          executable: false,
          owner: TEGRIDY_LAUNCH_PROGRAM_ID,
          data: encodeGlobalConfig(),
        },
      }),
    );
    expect(r.program.kind).toBe('deployed');
    expect(r.global?.kind).toBe('initialized');
  });

  it('reports not-initialized only when the program exists and global does not', async () => {
    const r = await fetchLaunchProtocolStatus(
      fakeConnection({
        [TEGRIDY_LAUNCH_PROGRAM_ID]: { executable: true, owner: BPF_LOADER, data: new Uint8Array(36) },
      }),
    );
    expect(r.global?.kind).toBe('not-initialized');
  });
});

// Values below are the output of the REAL `curve.rs`, compiled on the host with
// `rustc --edition 2021` (its own suite: 23/23 green) and captured directly — not
// computed by this port. The full port was diffed against it over 50,009 cases.
describe('config math — pinned against the real Rust', () => {
  const V_SOL = 30_000_000_000n; // 30 SOL
  const V_TOK = 1_073_000_000_000_000n;
  const SUPPLY = 1_000_000_000_000_000n;

  it('maxReachableRealSol', () => {
    expect(maxReachableRealSol(V_SOL, V_TOK, SUPPLY)).toBe(27_958_993_476n);
  });

  it('continuityTarget at the minimum migration reserve', () => {
    expect(continuityTarget(V_SOL, V_TOK, SUPPLY, MIN_MIGRATION_RESERVE_LAMPORTS)).toBe(11_685_689_681n);
  });

  it('a launch at its continuity target lists at ~the curve price', () => {
    expect(
      graduationPriceRatioBps(V_SOL, V_TOK, SUPPLY, 11_685_689_681n, MIN_MIGRATION_RESERVE_LAMPORTS),
    ).toBe(9_999n);
  });

  it("reproduces this repo's original ~7x listing gap (30 vSOL against a 2 SOL target)", () => {
    // MIGRATE_DESIGN.md's "opened at ~14% of the curve's final price", exactly.
    expect(graduationPriceRatioBps(V_SOL, V_TOK, SUPPLY, 2_000_000_000n, 250_000_000n)).toBe(1_398n);
  });

  it('the migration reserve moves the ratio — ignoring it misprices every launch that uses one', () => {
    const withReserve = graduationPriceRatioBps(V_SOL, V_TOK, SUPPLY, 2_000_000_000n, 250_000_000n);
    const without = graduationPriceRatioBps(V_SOL, V_TOK, SUPPLY, 2_000_000_000n, 0n);
    expect(withReserve).not.toBe(without);
    expect(without).toBe(1_395n);
  });

  it('a target past the curve ceiling is InsufficientLiquidity, not a number', () => {
    expect(() => graduationPriceRatioBps(V_SOL, V_TOK, SUPPLY, 85_000_000_000n, 0n)).toThrow(CurveConfigError);
  });

  it('rejects degenerate books with ZeroAmount', () => {
    expect(() => maxReachableRealSol(0n, V_TOK, SUPPLY)).toThrow(CurveConfigError);
    expect(() => maxReachableRealSol(V_SOL, 0n, SUPPLY)).toThrow(CurveConfigError);
    expect(() => maxReachableRealSol(V_SOL, V_TOK, 0n)).toThrow(CurveConfigError);
    expect(() => continuityTarget(0n, V_TOK, SUPPLY, 0n)).toThrow(CurveConfigError);
  });

  it('emulates the u128 overflow the Rust checks for, instead of returning a big number', () => {
    const MAX = (1n << 64n) - 1n;
    expect(() => graduationPriceRatioBps(MAX, MAX, MAX, MAX, MAX)).toThrow(CurveConfigError);
  });
});

describe('instruction data encoding', () => {
  const ZERO_32 = new Uint8Array(32);
  const initArgs = {
    tradeFeeBps: 100n,
    initialVirtualSol: 30_000_000_000n,
    initialVirtualToken: 1_073_000_000_000_000n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    graduationTargetLamports: 11_685_689_681n,
    migrationReserveLamports: MIN_MIGRATION_RESERVE_LAMPORTS,
    cpSwapProgram: ZERO_KEY,
    ammConfig: ZERO_KEY,
  };

  it('initialize_global is 8 + 6xu64 + 2xPubkey = 120 bytes, discriminator first', () => {
    const d = encodeInitializeGlobalData(initArgs);
    expect(d.length).toBe(120);
    expect(Array.from(d.subarray(0, 8))).toEqual([47, 225, 15, 112, 86, 51, 190, 231]);
  });

  it('initialize_global writes u64 little-endian in declaration order', () => {
    const d = encodeInitializeGlobalData(initArgs);
    const view = new DataView(d.buffer, d.byteOffset, d.byteLength);
    expect(view.getBigUint64(8, true)).toBe(100n); // trade_fee_bps
    expect(view.getBigUint64(16, true)).toBe(30_000_000_000n); // initial_virtual_sol
    expect(view.getBigUint64(24, true)).toBe(1_073_000_000_000_000n); // initial_virtual_token
    expect(view.getBigUint64(32, true)).toBe(1_000_000_000_000_000n); // token_total_supply
    expect(view.getBigUint64(40, true)).toBe(11_685_689_681n); // graduation_target
    expect(view.getBigUint64(48, true)).toBe(MIN_MIGRATION_RESERVE_LAMPORTS); // migration_reserve
    expect(Array.from(d.subarray(56, 88))).toEqual(Array.from(ZERO_32)); // cp_swap_program
    expect(Array.from(d.subarray(88, 120))).toEqual(Array.from(ZERO_32)); // amm_config
  });

  it('initialize_global carries real AMM addresses when they are supplied', () => {
    const d = encodeInitializeGlobalData({ ...initArgs, cpSwapProgram: CP_SWAP, ammConfig: AMM_CONFIG });
    expect(Array.from(d.subarray(56, 88))).toEqual(Array.from(new PublicKey(CP_SWAP).toBytes()));
    expect(Array.from(d.subarray(88, 120))).toEqual(Array.from(new PublicKey(AMM_CONFIG).toBytes()));
  });

  it('rejects a value that does not fit in u64 rather than truncating it', () => {
    expect(() => encodeInitializeGlobalData({ ...initArgs, tradeFeeBps: 1n << 64n })).toThrow(RangeError);
  });

  it('update_global with nothing set is 8 + nine None bytes', () => {
    const d = encodeUpdateGlobalData({});
    expect(d.length).toBe(17);
    expect(Array.from(d.subarray(0, 8))).toEqual([90, 152, 240, 21, 199, 38, 72, 20]);
    expect(Array.from(d.subarray(8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('update_global with everything set is 178 bytes', () => {
    const d = encodeUpdateGlobalData({
      tradeFeeBps: 1n,
      graduationTargetLamports: 2n,
      paused: true,
      newAuthority: AUTHORITY,
      newFeeRecipient: FEE_RECIPIENT,
      migrationReserveLamports: 3n,
      newCpSwapProgram: CP_SWAP,
      newAmmConfig: AMM_CONFIG,
      newInitialVirtualSol: 4n,
    });
    expect(d.length).toBe(178);
  });

  // The Option ORDER is load-bearing and silent if wrong: the program would apply the
  // value to a different field than the operator asked for. Each of these pins one
  // option's byte position with every other option absent.
  it('places each Option at its declared position', () => {
    const at = (args: Parameters<typeof encodeUpdateGlobalData>[0]) => encodeUpdateGlobalData(args);

    // 1st option: trade_fee_bps → tag at 8, value at 9
    const fee = at({ tradeFeeBps: 250n });
    expect(fee[8]).toBe(1);
    expect(new DataView(fee.buffer, fee.byteOffset).getBigUint64(9, true)).toBe(250n);
    expect(Array.from(fee.subarray(17))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);

    // 3rd option: paused → tag at 10 (after two None u64 tags at 8 and 9)
    const paused = at({ paused: true });
    expect(Array.from(paused.subarray(8, 12))).toEqual([0, 0, 1, 1]);

    // 7th option: new_cp_swap_program. Preceded by six Nones (bytes 8..13), tag at 14.
    const cps = at({ newCpSwapProgram: CP_SWAP });
    expect(Array.from(cps.subarray(8, 14))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(cps[14]).toBe(1);
    expect(Array.from(cps.subarray(15, 47))).toEqual(Array.from(new PublicKey(CP_SWAP).toBytes()));

    // 8th option: new_amm_config — the field that must NOT be confused with the 7th.
    const amm = at({ newAmmConfig: AMM_CONFIG });
    expect(Array.from(amm.subarray(8, 15))).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(amm[15]).toBe(1);
    expect(Array.from(amm.subarray(16, 48))).toEqual(Array.from(new PublicKey(AMM_CONFIG).toBytes()));
  });

  it('distinguishes paused=false from paused absent', () => {
    // Some(false) must halt-unpause; None must leave the flag alone.
    expect(Array.from(encodeUpdateGlobalData({ paused: false }).subarray(10, 12))).toEqual([1, 0]);
    expect(encodeUpdateGlobalData({}).length).toBe(17);
  });
});

describe('checkLaunchEconomics — pre-flight for initialize_global', () => {
  const good = {
    tradeFeeBps: 100n,
    initialVirtualSol: 30_000_000_000n,
    initialVirtualToken: 1_073_000_000_000_000n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    graduationTargetLamports: 11_685_689_681n,
    migrationReserveLamports: MIN_MIGRATION_RESERVE_LAMPORTS,
  };

  it('accepts a config the program would accept, and reports the diagnostics', () => {
    const r = checkLaunchEconomics(good);
    expect(r.problems).toEqual([]);
    expect(r.graduationPriceRatioBps).toBe(9_999n);
    expect(r.maxReachableRealSol).toBe(27_958_993_476n);
    expect(r.continuityTarget).toBe(11_685_689_681n);
  });

  it('rejects a fee above MAX_FEE_BPS', () => {
    expect(checkLaunchEconomics({ ...good, tradeFeeBps: 1_001n }).problems.join()).toMatch(/FeeTooHigh/);
  });

  it('rejects a migration reserve below the rent floor', () => {
    const r = checkLaunchEconomics({ ...good, migrationReserveLamports: 0n });
    expect(r.problems.join()).toMatch(/MigrationReserveTooLow/);
  });

  it('rejects an unreachable target', () => {
    const r = checkLaunchEconomics({ ...good, graduationTargetLamports: 900_000_000_000n });
    expect(r.problems.join()).toMatch(/GraduationTargetUnreachable/);
  });

  it('rejects a config that would gap at listing — the ~7x drop guard', () => {
    const r = checkLaunchEconomics({ ...good, graduationTargetLamports: 2_000_000_000n });
    expect(r.problems.join()).toMatch(/GraduationPriceGap/);
    expect(r.graduationPriceRatioBps).toBe(1_395n);
  });

  it('rejects zero parameters', () => {
    const r = checkLaunchEconomics({ ...good, initialVirtualSol: 0n });
    expect(r.problems.join()).toMatch(/InvalidParameter/);
  });

  it('reports an uncomputable diagnostic as null, never as 0', () => {
    const r = checkLaunchEconomics({ ...good, initialVirtualToken: 0n });
    expect(r.maxReachableRealSol).toBeNull();
    expect(r.graduationPriceRatioBps).toBeNull();
    expect(r.continuityTarget).toBeNull();
  });
});
