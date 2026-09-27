// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  CP_SWAP_PROGRAM_ID,
  PLACEHOLDER_PROGRAM_ID,
  PROGRAM_ID,
  REGISTERED_CP_SWAP_PROGRAM_ID,
  REGISTERED_PROGRAM_ID,
  cpPermissionPda,
  globalPda,
  migrationAuthorityPda,
  poolStatePda,
} from '../curve/program';
import type { LaunchPhase, LaunchState } from '../curve/read';
import { CURVE_WRITES_ENABLED } from '../curveWriteFlag';
import {
  COMMITTED_WRITE_IDS,
  CP_CREATE_POOL_FEE_RECEIVER,
  GENESIS_HASH,
  curveWriteConfig,
  explorerTxUrl,
  readWriteGate,
  writeActions,
  type CommittedWriteIds,
} from './config';
import {
  AMM_CONFIG,
  CPSWAP,
  FakeChain,
  LAUNCH,
  cfgLocal,
  encodeGlobal,
  freshCurve,
  globalValue,
  rent,
} from './testkit.fixture';
import type { WriteGate } from './types';

const PROD = { DEV: false, MODE: 'production' };
const DEV = { DEV: true, MODE: 'development' };
const E2E = { DEV: false, MODE: 'solana-e2e' };
const ENV_IDS = {
  VITE_SOLANA_CURVE_WRITES: '1',
  VITE_SOLANA_CURVE_PROGRAM: LAUNCH.toBase58(),
  VITE_SOLANA_CPSWAP_PROGRAM: CPSWAP.toBase58(),
};
const FLIPPED: CommittedWriteIds = {
  enabled: true,
  programId: REGISTERED_PROGRAM_ID,
  cpSwapProgram: REGISTERED_CP_SWAP_PROGRAM_ID,
  cpSwapLive: null,
};

describe('gate 1: the configuration', () => {
  it('what is committed today is OFF: spent ids, flag false', () => {
    expect(CURVE_WRITES_ENABLED).toBe(false);
    expect(COMMITTED_WRITE_IDS.programId.equals(PROGRAM_ID)).toBe(true);
    expect(curveWriteConfig(PROD)).toBeNull();
  });

  it('flipping the flag is only coherent together with the ids (so the flag cannot be flipped alone)', () => {
    // If someone flips CURVE_WRITES_ENABLED without flipping the ids, production must stay off.
    if (CURVE_WRITES_ENABLED) {
      expect(PROGRAM_ID.equals(REGISTERED_PROGRAM_ID)).toBe(true);
      expect(CP_SWAP_PROGRAM_ID.equals(REGISTERED_CP_SWAP_PROGRAM_ID)).toBe(true);
    }
    expect(curveWriteConfig(PROD, { ...FLIPPED, programId: PROGRAM_ID })).toBeNull();
    expect(curveWriteConfig(PROD, { ...FLIPPED, cpSwapProgram: CP_SWAP_PROGRAM_ID })).toBeNull();
  });

  it('production ignores env entirely: flag + registered env ids + spent committed ids = off', () => {
    expect(curveWriteConfig({ ...PROD, ...ENV_IDS, VITE_SOLANA_CLUSTER: 'mainnet' })).toBeNull();
  });

  it('a custom build mode is production (no env override)', () => {
    expect(curveWriteConfig({ DEV: false, MODE: 'staging', ...ENV_IDS, VITE_SOLANA_CLUSTER: 'localnet' })).toBeNull();
    expect(curveWriteConfig({ DEV: false, MODE: 'development', ...ENV_IDS, VITE_SOLANA_CLUSTER: 'localnet' })).toBeNull();
  });

  it('production opens only when the committed flag AND committed ids are the registered ones', () => {
    const c = curveWriteConfig(PROD, FLIPPED);
    expect(c?.programId.equals(REGISTERED_PROGRAM_ID)).toBe(true);
    expect(c?.cluster).toBe('mainnet');
    expect(curveWriteConfig(PROD, { ...FLIPPED, enabled: false })).toBeNull();
    // The pool client's own env id must agree when set.
    expect(curveWriteConfig(PROD, { ...FLIPPED, cpSwapLive: Keypair.generate().publicKey })).toBeNull();
    expect(curveWriteConfig(PROD, { ...FLIPPED, cpSwapLive: REGISTERED_CP_SWAP_PROGRAM_ID })).not.toBeNull();
  });

  it('dev / e2e: flag off = off; flag on + localnet ids = config', () => {
    expect(curveWriteConfig({ ...DEV })).toBeNull();
    expect(curveWriteConfig({ ...DEV, ...ENV_IDS, VITE_SOLANA_CURVE_WRITES: '0', VITE_SOLANA_CLUSTER: 'localnet' })).toBeNull();
    const c = curveWriteConfig({ ...E2E, ...ENV_IDS, VITE_SOLANA_CLUSTER: 'localnet' });
    expect(c).toEqual({ programId: LAUNCH, cpSwapProgram: CPSWAP, cluster: 'localnet' });
    expect(curveWriteConfig({ ...DEV, ...ENV_IDS, VITE_SOLANA_CLUSTER: 'devnet' })?.cluster).toBe('devnet');
  });

  it('dev: spent, placeholder, unparsable and duplicate ids are refused', () => {
    const env = (p: string, c: string) => ({ ...DEV, ...ENV_IDS, VITE_SOLANA_CURVE_PROGRAM: p, VITE_SOLANA_CPSWAP_PROGRAM: c, VITE_SOLANA_CLUSTER: 'localnet' });
    expect(curveWriteConfig(env(PROGRAM_ID.toBase58(), CPSWAP.toBase58()))).toBeNull(); // spent launch id
    expect(curveWriteConfig(env(LAUNCH.toBase58(), CP_SWAP_PROGRAM_ID.toBase58()))).toBeNull(); // spent cp-swap id
    expect(curveWriteConfig(env(PLACEHOLDER_PROGRAM_ID.toBase58(), CPSWAP.toBase58()))).toBeNull();
    expect(curveWriteConfig(env('not-a-key', CPSWAP.toBase58()))).toBeNull();
    expect(curveWriteConfig(env(LAUNCH.toBase58(), LAUNCH.toBase58()))).toBeNull();
  });

  it('dev: a mainnet cluster only with the registered pair; unknown clusters refused', () => {
    const other = Keypair.generate().publicKey.toBase58();
    expect(curveWriteConfig({ ...DEV, ...ENV_IDS, VITE_SOLANA_CLUSTER: 'mainnet' })).not.toBeNull();
    expect(curveWriteConfig({ ...DEV, ...ENV_IDS, VITE_SOLANA_CURVE_PROGRAM: other, VITE_SOLANA_CLUSTER: 'mainnet' })).toBeNull();
    expect(curveWriteConfig({ ...DEV, ...ENV_IDS, VITE_SOLANA_CLUSTER: 'testnet' })).toBeNull();
  });
});

describe('gate 2: the chain', () => {
  const open = async (c: FakeChain) => readWriteGate(c, cfgLocal);

  it('off without a config, and reads nothing', async () => {
    const c = FakeChain.healthy();
    expect(await readWriteGate(c, null)).toEqual({ kind: 'off' });
    expect(c.calls).toEqual([]);
  });

  it('open on a healthy chain, with the decoded global, AmmConfig and readiness', async () => {
    const c = FakeChain.healthy();
    c.set(cpPermissionPda(migrationAuthorityPda(LAUNCH), CPSWAP), { lamports: 1, owner: CPSWAP, data: new Uint8Array(8) });
    c.set(CP_CREATE_POOL_FEE_RECEIVER, { lamports: rent(165), owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), data: new Uint8Array(165) });
    const g = await open(c);
    expect(g.kind).toBe('open');
    if (g.kind !== 'open') return;
    expect(g.global.feeRecipient.equals(globalValue().feeRecipient)).toBe(true);
    expect(g.ammConfig.tradeFeeRate).toBe(2_500n);
    expect(g.graduation).toEqual({ permission: true, createPoolFeeReceiver: true });
    expect(g.paused).toBe(false);
  });

  it('readiness: missing is false, unreadable is null (never false)', async () => {
    const c = FakeChain.healthy();
    let g = await open(c);
    expect(g.kind === 'open' && g.graduation).toEqual({ permission: false, createPoolFeeReceiver: false });
    const flaky = FakeChain.healthy();
    const orig = flaky.getAccountInfo;
    const perm = cpPermissionPda(migrationAuthorityPda(LAUNCH), CPSWAP);
    flaky.getAccountInfo = async (a: PublicKey) => {
      if (a.equals(perm) || a.equals(CP_CREATE_POOL_FEE_RECEIVER)) throw new Error('rpc down');
      return orig(a);
    };
    g = await open(flaky);
    expect(g.kind === 'open' && g.graduation).toEqual({ permission: null, createPoolFeeReceiver: null });
  });

  const blocked = async (c: FakeChain, reason: string) => {
    const g = await open(c);
    expect(g.kind).toBe('blocked');
    expect(g.kind === 'blocked' && g.reason).toBe(reason);
    return g as Extract<WriteGate, { kind: 'blocked' }>;
  };

  it('wrong-cluster: localnet config on a PUBLIC genesis (mainnet RPC behind a localnet build)', async () => {
    const c = FakeChain.healthy();
    c.genesis = GENESIS_HASH.mainnet;
    await blocked(c, 'wrong-cluster');
    const m = FakeChain.healthy();
    expect((await readWriteGate(m, { ...cfgLocal, cluster: 'mainnet' })).kind).toBe('blocked');
  });

  it('unreadable when the genesis read fails', async () => {
    const c = FakeChain.healthy();
    c.getGenesisHash = async () => {
      throw new Error('down');
    };
    await blocked(c, 'unreadable');
  });

  it('launch-program-missing / cpswap-program-missing, including a CLOSED program (stub without ProgramData)', async () => {
    const a = FakeChain.healthy();
    a.accounts.delete(LAUNCH.toBase58());
    await blocked(a, 'launch-program-missing');
    const b = FakeChain.healthy();
    // Close cp-swap: keep its executable stub, delete its ProgramData.
    const stub = b.accounts.get(CPSWAP.toBase58())!;
    b.accounts.delete(new PublicKey(stub.data.subarray(4, 36)).toBase58());
    const g = await blocked(b, 'cpswap-program-missing');
    expect(g.detail).toMatch(/closed/);
  });

  it('protocol-not-initialized when global is absent; unreadable when it does not decode', async () => {
    const a = FakeChain.healthy();
    a.accounts.delete(globalPda(LAUNCH).toBase58());
    await blocked(a, 'protocol-not-initialized');
    const b = FakeChain.healthy();
    b.set(globalPda(LAUNCH), { lamports: 1, owner: LAUNCH, data: new Uint8Array(202) });
    await blocked(b, 'unreadable');
  });

  it('venue-not-configured when global has no pool program yet', async () => {
    const zero = new PublicKey(new Uint8Array(32));
    await blocked(FakeChain.healthy(globalValue({ cpSwapProgram: zero, ammConfig: zero })), 'venue-not-configured');
  });

  it('venue-mismatch when global graduates into a DIFFERENT pool program', async () => {
    await blocked(FakeChain.healthy(globalValue({ cpSwapProgram: Keypair.generate().publicKey })), 'venue-mismatch');
  });

  it('the AmmConfig must exist, be owned by the pool program, and decode', async () => {
    const a = FakeChain.healthy();
    a.accounts.delete(AMM_CONFIG.toBase58());
    await blocked(a, 'venue-not-configured');
    const b = FakeChain.healthy();
    b.set(AMM_CONFIG, { lamports: 1, owner: Keypair.generate().publicKey, data: b.accounts.get(AMM_CONFIG.toBase58())!.data });
    await blocked(b, 'venue-mismatch');
    const c = FakeChain.healthy();
    c.set(AMM_CONFIG, { lamports: 1, owner: CPSWAP, data: new Uint8Array(236) });
    await blocked(c, 'unreadable');
  });

  it('paused is carried, not treated as blocked', async () => {
    const g = await open(FakeChain.healthy(globalValue({ paused: true })));
    expect(g.kind === 'open' && g.paused).toBe(true);
  });

  it('the healthy global round-trips through the real decoder (encoder sanity)', () => {
    expect(encodeGlobal(globalValue()).length).toBe(202);
  });
});

describe('writeActions', () => {
  const MINT = Keypair.generate().publicKey;
  const gateOpen = (paused = false, graduation = { permission: true, createPoolFeeReceiver: true }): WriteGate => ({
    kind: 'open',
    cfg: cfgLocal,
    global: globalValue({ paused }),
    ammConfig: {} as never,
    ammConfigAddress: AMM_CONFIG,
    paused,
    graduation,
  });
  const launch = (kind: LaunchPhase['kind']): LaunchState => {
    const curve = { ...freshCurve(MINT, MINT), complete: kind === 'graduated' };
    const phase = (kind === 'graduated' ? { kind, pool: poolStatePda(MINT, LAUNCH) } : { kind }) as LaunchPhase;
    return { phase, paused: false, ammConfigured: true, global: globalValue(), curve: { address: MINT, curve, lamports: 0n } };
  };

  it('nothing at all unless the gate is open', () => {
    for (const g of [{ kind: 'off' } as WriteGate, { kind: 'blocked', reason: 'unreadable', detail: '' } as WriteGate]) {
      expect(Object.values(writeActions(g, launch('trading')))).toEqual([false, false, false, false, false]);
    }
  });

  const table: Array<[LaunchPhase['kind'], boolean, Partial<Record<string, boolean>>]> = [
    ['trading', false, { create: true, buy: true, sell: true }],
    ['trading', true, { sell: true }],
    ['at-target', false, { create: true, buy: true, sell: true }],
    ['at-target', true, { sell: true }],
    ['awaiting-migration', false, { create: true, sell: true, migrate: true }],
    ['awaiting-migration', true, { sell: true }],
    ['graduated', false, { create: true, poolSwap: true }],
    ['graduated', true, { poolSwap: true }],
    ['pre-launch', false, { create: true }],
    ['unreadable', false, { create: true }],
    ['not-deployed', false, { create: true }],
  ];
  it.each(table)('%s, paused=%s', (phase, paused, want) => {
    const a = writeActions(gateOpen(paused), launch(phase), { migrationEligible: true });
    const expected = { create: false, buy: false, sell: false, migrate: false, poolSwap: false, ...want };
    expect(a).toEqual(expected);
  });

  it('SELL STAYS ON while paused, in every phase the curve still trades', () => {
    for (const p of ['trading', 'at-target', 'awaiting-migration'] as const) {
      expect(writeActions(gateOpen(true), launch(p)).sell).toBe(true);
    }
  });

  it('migrate needs eligibility AND both readiness reads true; null (unreadable) is not true', () => {
    expect(writeActions(gateOpen(), launch('awaiting-migration')).migrate).toBe(false);
    expect(writeActions(gateOpen(), launch('awaiting-migration'), { migrationEligible: false }).migrate).toBe(false);
    expect(
      writeActions(gateOpen(false, { permission: null as unknown as boolean, createPoolFeeReceiver: true }), launch('awaiting-migration'), { migrationEligible: true }).migrate,
    ).toBe(false);
    expect(
      writeActions(gateOpen(false, { permission: true, createPoolFeeReceiver: false }), launch('awaiting-migration'), { migrationEligible: true }).migrate,
    ).toBe(false);
  });

  // The platform reserve is paid inside create_launch (2026-09-26): nothing is left to release.
  it('offers no reserve release in any phase', () => {
    for (const p of ['trading', 'at-target', 'awaiting-migration', 'graduated'] as const) {
      expect(Object.keys(writeActions(gateOpen(), launch(p)))).toEqual(['create', 'buy', 'sell', 'migrate', 'poolSwap']);
    }
  });
});

describe('explorer links', () => {
  it('Solscan for mainnet and devnet, the Solana Explorer for a local validator', () => {
    expect(explorerTxUrl('abc', 'mainnet')).toBe('https://solscan.io/tx/abc');
    expect(explorerTxUrl('abc', 'devnet')).toBe('https://solscan.io/tx/abc?cluster=devnet');
    expect(explorerTxUrl('abc', 'localnet')).toBe(
      'https://explorer.solana.com/tx/abc?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899',
    );
  });
});
