// Test-only: a fake `LpWriteApi` and the fixtures the /pools liquidity UI tests share,
// like curve/fakeWriteApi.fixture.ts for /curve-launch. `displaySafe` is the REAL rule
// (validate.js is pure). Everything that would touch a chain, a wallet or the network
// is a vi.fn the test can steer.

import { vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import * as validate from '../../../lib/launchMetadata/validate.js';
import type { AmmConfigView } from '../../../lib/solana/cpswap/program';
import type { CreateFacts, CurveWriteConfig, GateRpc, LpGate, LpOpenGate, LpWriteApi, TxSummary } from '../curve/ports';
import { SOL_QUOTE } from '../../../lib/solana/lp/quotes';

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
    // Mainnet before the vault creates the public tier: no opening is offered. A test
    // that opens pools passes `readyFacts()`.
    readCreateFacts: vi.fn(async () => notOpenFacts()),
    prepareLpDeposit: vi.fn(),
    prepareLpWithdraw: vi.fn(),
    prepareLpCreate: vi.fn(),
    submitPrepared: vi.fn(),
    recheckOutcome: vi.fn(),
    explorerTxUrl: vi.fn((sig: string) => `https://explorer.test/tx/${sig}`),
    meta: { displaySafe: validate.displaySafe },
  };
  return { ...api, ...rest };
}

/**
 * Where a fake wallet keeps a pool's pairing coin when that coin is not SOL (its USDC or
 * BAYLA account). A fixed key: web3's address derivation cannot run under jsdom.
 */
export const COIN_ACCOUNT = new PublicKey(new Uint8Array(32).fill(43));

/**
 * An `lp-deposit` summary, as a prepare would return it. Pass `quote` in `over` for a
 * pool paired with USDC or BAYLA: every `quote` amount is then in THAT coin's base units
 * (100_000_000n is 0.1 SOL, and 100 USDC), and nothing is wrapped, as the builder has it.
 */
export function lpDepositSummary(pool: PublicKey, tokenMint: PublicKey, over: Partial<Extract<TxSummary, { kind: 'lp-deposit' }>> = {}): TxSummary {
  const quote = over.quote ?? SOL_QUOTE;
  return {
    kind: 'lp-deposit',
    pool,
    origin: 'other',
    config: null,
    enableCreatorFee: false,
    tokenMint,
    tokenDecimals: 6,
    quote,
    quoteIsToken0: true,
    lpAmount: 1_000_000n,
    lpDecimals: 9,
    quoted: { quote: 100_000_000n, token: 10_000_000n },
    max: { quote: 101_000_000n, token: 10_100_000n },
    limitedByBalance: 'none',
    sharePct: { before: 0, after: 1 },
    price: { state: 'agrees', pool: 0.01, reference: 0.01, against: 'outside', diff: 0 },
    tokenWarnings: [],
    unwrapsWsol: quote.native,
    wsolHeldBefore: 0n,
    notices: [],
    warnings: [],
    marketWarnings: [],
    priceGap: null,
    ...over,
  };
}

/**
 * An `lp-withdraw` summary, as a prepare would return it. With `quote` in `over` set to
 * USDC or BAYLA, the coin is paid into the wallet's own account for it (`COIN_ACCOUNT`,
 * already open) and nothing is unwrapped, as the builder has it.
 */
export function lpWithdrawSummary(
  pool: PublicKey,
  tokenMint: PublicKey,
  lpAccount: PublicKey,
  over: Partial<Extract<TxSummary, { kind: 'lp-withdraw' }>> = {},
): TxSummary {
  const quote = over.quote ?? SOL_QUOTE;
  return {
    kind: 'lp-withdraw',
    pool,
    origin: 'other',
    config: null,
    tokenMint,
    tokenDecimals: 6,
    quote,
    quoteIsToken0: true,
    lpAccount,
    lpAmount: 500_000n,
    lpDecimals: 9,
    heldBefore: 1_000_000n,
    all: false,
    keep: 500_000n,
    quoted: { quote: 50_000_000n, token: 5_000_000n },
    min: { quote: 49_500_000n, token: 4_950_000n },
    tokenAccount: tokenMint,
    tokenAccountRent: 0n,
    quoteAccount: quote.native ? null : { address: COIN_ACCOUNT, rent: 0n },
    unwrapsWsol: quote.native,
    notices: [],
    ...over,
  };
}

/** Where the fake public tier lives. A fixed key: web3's address derivation cannot run under jsdom. */
export const TIER1_ADDRESS = new PublicKey(new Uint8Array(32).fill(41));

/** Tier 1 with the owner's values (2026-10-01): 1% a trade, 16% of it to the venue, 0.15 SOL to open. */
export function tier1Config(over: Partial<AmmConfigView> = {}): AmmConfigView {
  return {
    address: TIER1_ADDRESS.toBase58(),
    index: 1,
    disableCreatePool: false,
    tradeFeeRate: 10_000n,
    protocolFeeRate: 160_000n,
    fundFeeRate: 0n,
    createPoolFee: 150_000_000n,
    creatorFeeRate: 0n,
    protocolOwner: 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd',
    fundOwner: 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd',
    ...over,
  };
}

export const readyFacts = (over: Partial<AmmConfigView> = {}): CreateFacts => ({
  tier: { kind: 'ready', address: TIER1_ADDRESS, config: tier1Config(over) },
  feeAccount: { kind: 'ready' },
});

export const notOpenFacts = (): CreateFacts => ({ tier: { kind: 'not-open', address: TIER1_ADDRESS }, feeAccount: { kind: 'ready' } });

/**
 * An `lp-create` summary, as a prepare would return it. With `quote` in `over` set to USDC
 * or BAYLA, `put.quote` and `locked.quote` are in that coin's base units and nothing is
 * wrapped; the fee to open and the rents stay in lamports, whatever the coin.
 */
export function lpCreateSummary(pool: PublicKey, tokenMint: PublicKey, over: Partial<Extract<TxSummary, { kind: 'lp-create' }>> = {}): TxSummary {
  const quote = over.quote ?? SOL_QUOTE;
  return {
    kind: 'lp-create',
    pool,
    origin: 'standard',
    config: tier1Config(),
    tokenMint,
    tokenDecimals: 6,
    quote,
    quoteIsToken0: true,
    put: { quote: 1_000_000_000n, token: 100_000_000n },
    supply: 10_000_000_000n,
    lpAmount: 9_999_999_900n,
    lpDecimals: 9,
    locked: { quote: 10n, token: 1n },
    createFee: 150_000_000n,
    feeReceiver: new PublicKey(new Uint8Array(32).fill(42)),
    rents: { neverRefunded: 40_000_000n, lpAccount: 2_039_280n },
    price: { state: 'agrees', pool: 0.01, reference: 0.01, against: 'outside', diff: 0 },
    tokenWarnings: [],
    unwrapsWsol: quote.native,
    wsolHeldBefore: 0n,
    notices: [],
    warnings: [],
    marketWarnings: [],
    priceGap: null,
    ...over,
  };
}
