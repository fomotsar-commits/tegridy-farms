// Test-only: a fake `LpWriteApi` and the fixtures the /pools liquidity UI tests share,
// like curve/fakeWriteApi.fixture.ts for /curve-launch. `displaySafe` is the REAL rule
// (validate.js is pure). Everything that would touch a chain, a wallet or the network
// is a vi.fn the test can steer.

import { vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import * as validate from '../../../lib/launchMetadata/validate.js';
import type { CurveWriteConfig, GateRpc, LpGate, LpOpenGate, LpWriteApi, TxSummary } from '../curve/ports';

/** The pool program the fake readers report (`LpReaders.programId`). The gate must name the same one. */
export const LP_PROGRAM = 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT';

export const lpCfg = (cpSwapProgram: string = LP_PROGRAM): CurveWriteConfig => ({
  programId: new PublicKey(new Uint8Array(32).fill(10)),
  cpSwapProgram: new PublicKey(cpSwapProgram),
  cluster: 'localnet',
});

export function lpOpenGate(over: Partial<LpOpenGate> = {}): LpOpenGate {
  return { kind: 'open', cfg: lpCfg(), mode: 'on', ...over };
}

/** A gate rpc that is never called: the fake API's `readLpGate` answers without it. */
export const unusedGateRpc: GateRpc = {
  getAccountInfo: vi.fn(async () => {
    throw new Error('the fake LP gate reads nothing');
  }),
  getMinimumBalanceForRentExemption: vi.fn(async () => {
    throw new Error('the fake LP gate reads nothing');
  }),
  getGenesisHash: vi.fn(async () => {
    throw new Error('the fake LP gate reads nothing');
  }),
};

export function fakeLpApi(over: Partial<LpWriteApi> & { gate?: LpGate } = {}): LpWriteApi {
  const { gate = lpOpenGate(), ...rest } = over;
  const api: LpWriteApi = {
    lpWriteConfig: vi.fn(() => lpCfg()),
    readLpGate: vi.fn(async () => gate),
    prepareLpDeposit: vi.fn(),
    prepareLpWithdraw: vi.fn(),
    submitPrepared: vi.fn(),
    recheckOutcome: vi.fn(),
    explorerTxUrl: vi.fn((sig: string) => `https://explorer.test/tx/${sig}`),
    meta: { displaySafe: validate.displaySafe },
  };
  return { ...api, ...rest };
}

/** An `lp-deposit` summary, as a prepare would return it. */
export function lpDepositSummary(pool: PublicKey, tokenMint: PublicKey, over: Partial<Extract<TxSummary, { kind: 'lp-deposit' }>> = {}): TxSummary {
  return {
    kind: 'lp-deposit',
    pool,
    origin: 'other',
    config: null,
    tokenMint,
    tokenDecimals: 6,
    solIsToken0: true,
    lpAmount: 1_000_000n,
    lpDecimals: 9,
    quoted: { sol: 100_000_000n, token: 10_000_000n },
    max: { sol: 101_000_000n, token: 10_100_000n },
    limitedByBalance: 'none',
    sharePct: { before: 0, after: 1 },
    price: { state: 'agrees', pool: 0.01, reference: 0.01, against: 'outside', diff: 0 },
    tokenWarnings: [],
    unwrapsWsol: true,
    wsolHeldBefore: 0n,
    notices: [],
    ...over,
  };
}

/** An `lp-withdraw` summary, as a prepare would return it. */
export function lpWithdrawSummary(
  pool: PublicKey,
  tokenMint: PublicKey,
  lpAccount: PublicKey,
  over: Partial<Extract<TxSummary, { kind: 'lp-withdraw' }>> = {},
): TxSummary {
  return {
    kind: 'lp-withdraw',
    pool,
    origin: 'other',
    config: null,
    tokenMint,
    tokenDecimals: 6,
    solIsToken0: true,
    lpAccount,
    lpAmount: 500_000n,
    lpDecimals: 9,
    heldBefore: 1_000_000n,
    all: false,
    keep: 500_000n,
    quoted: { sol: 50_000_000n, token: 5_000_000n },
    min: { sol: 49_500_000n, token: 4_950_000n },
    tokenAccount: tokenMint,
    tokenAccountRent: 0n,
    unwrapsWsol: true,
    notices: [],
    ...over,
  };
}
