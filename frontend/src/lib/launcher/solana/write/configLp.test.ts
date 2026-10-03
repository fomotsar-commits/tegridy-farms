// @vitest-environment node
//
// Liquidity's own configuration and gate (spec D1, D2, 3.7). config.test.ts pins the
// launch-program pair, unedited.
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { REGISTERED_CP_SWAP_PROGRAM_ID, REGISTERED_PROGRAM_ID, SPENT_CP_SWAP_PROGRAM_ID, SPENT_PROGRAM_ID, globalPda } from '../curve/program';
import { GENESIS_HASH, lpWriteConfig, readLpGate, type CommittedWriteIds } from './config';
import { CPSWAP, FakeChain, LAUNCH, cfgLocal, encodeGlobal, globalValue, rent } from './testkit.fixture';

const PROD = { DEV: false, MODE: 'production' };
const E2E = { DEV: false, MODE: 'solana-e2e' };
const ENV_IDS = {
  VITE_SOLANA_CURVE_WRITES: '1',
  VITE_SOLANA_CURVE_PROGRAM: LAUNCH.toBase58(),
  VITE_SOLANA_CPSWAP_PROGRAM: CPSWAP.toBase58(),
  VITE_SOLANA_CLUSTER: 'localnet',
};
/** The committed state today: the registered pair, the curve's flag on. */
const COMMITTED: CommittedWriteIds = {
  enabled: true,
  programId: REGISTERED_PROGRAM_ID,
  cpSwapProgram: REGISTERED_CP_SWAP_PROGRAM_ID,
  cpSwapLive: REGISTERED_CP_SWAP_PROGRAM_ID,
};

describe('lpWriteConfig', () => {
  it('is null whenever LP’s own switch is off, whatever the curve’s flag and the ids say', () => {
    expect(lpWriteConfig(PROD, COMMITTED, 'off')).toBeNull();
    expect(lpWriteConfig({ ...E2E, ...ENV_IDS }, COMMITTED, 'off')).toBeNull();
  });

  it('production ignores env: the registered mainnet pair, even with env naming other ids', () => {
    const env = { ...PROD, ...ENV_IDS };
    const cfg = lpWriteConfig(env, COMMITTED, 'on');
    expect(cfg && [cfg.programId.toBase58(), cfg.cpSwapProgram.toBase58(), cfg.cluster]).toEqual([
      REGISTERED_PROGRAM_ID.toBase58(),
      REGISTERED_CP_SWAP_PROGRAM_ID.toBase58(),
      'mainnet',
    ]);
    // 'withdraw-only' gets the same configuration: removing must work in the emergency state.
    expect(lpWriteConfig(env, COMMITTED, 'withdraw-only')).toEqual(cfg);
  });

  it('opens with the curve’s own flag committed off: LP does not follow CURVE_WRITES_ENABLED', () => {
    expect(lpWriteConfig(PROD, { ...COMMITTED, enabled: false }, 'on')).not.toBeNull();
  });

  it('refuses when the pool client’s live cp-swap id is not the registered one, or the committed ids are not the registered pair', () => {
    const other = Keypair.generate().publicKey;
    expect(lpWriteConfig(PROD, { ...COMMITTED, cpSwapLive: other }, 'on')).toBeNull();
    expect(lpWriteConfig(PROD, { ...COMMITTED, programId: SPENT_PROGRAM_ID, cpSwapProgram: SPENT_CP_SWAP_PROGRAM_ID }, 'on')).toBeNull();
  });

  it('the e2e build takes the localnet ids from env', () => {
    const cfg = lpWriteConfig({ ...E2E, ...ENV_IDS }, COMMITTED, 'on');
    expect(cfg && [cfg.programId.equals(LAUNCH), cfg.cpSwapProgram.equals(CPSWAP), cfg.cluster]).toEqual([true, true, 'localnet']);
  });
});

/** Only the pool program, deployed: no launch program, no `global`, no fee tier. */
function poolProgramOnly(): FakeChain {
  const c = FakeChain.healthy();
  for (const k of [LAUNCH.toBase58(), globalPda(LAUNCH).toBase58()]) c.accounts.delete(k);
  return c;
}

describe('readLpGate', () => {
  it('open on a chain with NO launch program and NO global, reading only the cluster and the pool program', async () => {
    const c = poolProgramOnly();
    expect(c.accounts.has(LAUNCH.toBase58())).toBe(false);
    const g = await readLpGate(c, cfgLocal, 'on');
    expect(g).toEqual({ kind: 'open', cfg: cfgLocal, mode: 'on' });
    // Genesis, then the pool program and its ProgramData. Nothing else.
    expect(c.calls).toEqual(['getGenesisHash', 'getAccountInfo', 'getAccountInfo']);
  });

  it('carries withdraw-only through', async () => {
    expect(await readLpGate(poolProgramOnly(), cfgLocal, 'withdraw-only')).toEqual({ kind: 'open', cfg: cfgLocal, mode: 'withdraw-only' });
  });

  it('a launch program that is paused, or whose global names another pool program, does not close it', async () => {
    const paused = FakeChain.healthy(globalValue({ paused: true }));
    expect((await readLpGate(paused, cfgLocal, 'on')).kind).toBe('open');
    const mismatched = FakeChain.healthy();
    mismatched.set(globalPda(LAUNCH), { lamports: rent(202), owner: LAUNCH, data: encodeGlobal(globalValue({ cpSwapProgram: Keypair.generate().publicKey })) });
    expect((await readLpGate(mismatched, cfgLocal, 'on')).kind).toBe('open');
    const undecodable = FakeChain.healthy();
    undecodable.set(globalPda(LAUNCH), { lamports: rent(202), owner: LAUNCH, data: new Uint8Array(10) });
    expect((await readLpGate(undecodable, cfgLocal, 'on')).kind).toBe('open');
  });

  it('off without a config or with the switch off, and reads nothing', async () => {
    const c = FakeChain.healthy();
    expect(await readLpGate(c, null, 'on')).toEqual({ kind: 'off' });
    expect(await readLpGate(c, cfgLocal, 'off')).toEqual({ kind: 'off' });
    expect(c.calls).toEqual([]);
  });

  it('wrong cluster: a localnet build on a public genesis', async () => {
    const c = poolProgramOnly();
    c.genesis = GENESIS_HASH.mainnet;
    expect(await readLpGate(c, cfgLocal, 'on')).toMatchObject({ kind: 'blocked', reason: 'wrong-cluster' });
  });

  it('cp-swap missing, including a closed program (its stub without ProgramData)', async () => {
    const gone = poolProgramOnly();
    gone.accounts.delete(CPSWAP.toBase58());
    expect(await readLpGate(gone, cfgLocal, 'on')).toMatchObject({ kind: 'blocked', reason: 'cpswap-program-missing' });
    const closed = poolProgramOnly();
    const stub = closed.accounts.get(CPSWAP.toBase58())!;
    closed.accounts.delete(new PublicKey(stub.data.subarray(4, 36)).toBase58());
    expect(await readLpGate(closed, cfgLocal, 'on')).toMatchObject({ kind: 'blocked', reason: 'cpswap-program-missing', detail: expect.stringMatching(/closed/) });
  });

  it('cp-swap unreadable, and a genesis read that fails, are blocked as unreadable, never open', async () => {
    const flaky = poolProgramOnly();
    flaky.getAccountInfo = async () => {
      throw new Error('rpc down');
    };
    expect(await readLpGate(flaky, cfgLocal, 'on')).toMatchObject({ kind: 'blocked', reason: 'unreadable', detail: expect.stringMatching(/pool program/) });
    const noGenesis = poolProgramOnly();
    noGenesis.getGenesisHash = async () => {
      throw new Error('down');
    };
    expect(await readLpGate(noGenesis, cfgLocal, 'on')).toMatchObject({ kind: 'blocked', reason: 'unreadable' });
  });
});
