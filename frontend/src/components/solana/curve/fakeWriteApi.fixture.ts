// Test-only: a fake `WriteApi` and the fixtures the /curve-launch UI tests share.
// The metadata rules are the REAL ones (validate.js is pure), so a form test
// exercises the same checks the page ships with. Everything that would touch a
// chain, a wallet or the network is a vi.fn the test can steer.

import { vi } from 'vitest';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import * as validate from '../../../lib/launchMetadata/validate.js';
import type { BondingCurve, CurveAccount, GlobalConfig, LaunchState } from '../../../lib/launcher/solana/curve';
import { classifyLaunch } from '../../../lib/launcher/solana/curve';
import type { AmmConfigView } from '../../../lib/solana/cpswap/program';
import type { OpenGate, PreparedTx, TxSummary, WriteApi } from './ports';

export const SOL = 1_000_000_000n;
export const KEY = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
export const MINT = KEY(1);
export const CREATOR = KEY(2);

/**
 * The $BAYLA plant every create summary carries. `from` is a stand-in: deriving the
 * creator's real $BAYLA account needs PDA maths, which fails under jsdom.
 */
export const PLANT_SUMMARY: Extract<TxSummary, { kind: 'create' }>['plant'] = {
  total: 100_000_000_000n,
  burned: 50_000_000_000n,
  toWorkshop: 50_000_000_000n,
  from: KEY(13),
  workshopAccount: new PublicKey('9i7vMCBcTSs3CsEZNcNDmH5Lh8yuH6aqYULNHWfxatwT'),
  mint: new PublicKey('7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump'),
  decimals: 6,
};

/** A maker with enough $BAYLA to plant: 150,000 in their own $BAYLA account (a stand-in address). */
export const PLANT_BALANCE_ENOUGH = { account: KEY(13), amount: 150_000_000_000n, accountExists: true };

export function globalCfg(over: Partial<GlobalConfig> = {}): GlobalConfig {
  return {
    authority: KEY(3),
    feeRecipient: KEY(4),
    tradeFeeBps: 100n,
    creatorFeeShareBps: 5_000n,
    initialVirtualSol: 30n * SOL,
    initialVirtualToken: 1_073_000_000_000_000n,
    tokenTotalSupply: 1_000_000_000_000_000n,
    graduationTargetLamports: 25n * SOL,
    migrationReserveLamports: 1n * SOL,
    cpSwapProgram: KEY(5),
    ammConfig: KEY(6),
    paused: false,
    bump: 254,
    platformReserveBps: 369n,
    ...over,
  };
}

export function bondingCurve(over: Partial<BondingCurve> = {}): BondingCurve {
  return {
    mint: MINT,
    creator: CREATOR,
    virtualSolReserves: 30n * SOL,
    virtualTokenReserves: 1_073_000_000_000_000n,
    realSolReserves: 0n,
    realTokenReserves: 963_100_000_000_000n,
    tradeFeeBps: 100n,
    creatorFeeShareBps: 5_000n,
    graduationTargetLamports: 25n * SOL,
    migrationReserveLamports: 1n * SOL,
    complete: false,
    pool: new PublicKey(new Uint8Array(32)),
    bump: 255,
    platformReserveTokens: 36_900_000_000_000n,
    // The program pays the reserve inside create_launch and sets this there.
    platformReserveReleased: true,
    ...over,
  };
}

export const curveAccount = (c: BondingCurve = bondingCurve(), lamports = 2_000_000n + c.realSolReserves): CurveAccount => ({
  address: KEY(9),
  curve: c,
  lamports,
});

export function launchState(c: BondingCurve | null = bondingCurve(), g: GlobalConfig = globalCfg()): LaunchState {
  return classifyLaunch(
    { kind: 'deployed', executable: true },
    { kind: 'ok', value: g },
    c ? { kind: 'ok', value: curveAccount(c) } : { kind: 'absent' },
  );
}

export const ammConfig: AmmConfigView = {
  address: KEY(6).toBase58(),
  index: 0,
  disableCreatePool: false,
  tradeFeeRate: 2_500n,
  protocolFeeRate: 120_000n,
  fundFeeRate: 0n,
  createPoolFee: 0n,
  creatorFeeRate: 0n,
  protocolOwner: KEY(7).toBase58(),
  fundOwner: KEY(7).toBase58(),
};

export function openGate(over: Partial<OpenGate> = {}): OpenGate {
  return {
    kind: 'open',
    cfg: { programId: KEY(10), cpSwapProgram: KEY(5), cluster: 'localnet' },
    global: globalCfg(),
    ammConfig,
    ammConfigAddress: KEY(6),
    paused: false,
    graduation: { permission: true, createPoolFeeReceiver: true },
    ...over,
  };
}

export const SIG = '5'.repeat(88);

export function prepared(summary: TxSummary, over: Partial<PreparedTx> = {}): PreparedTx {
  const tx = new Transaction();
  tx.feePayer = CREATOR;
  return {
    kind: summary.kind,
    tx,
    extraSigners: summary.kind === 'create' ? [Keypair.generate()] : [],
    blockhash: '11111111111111111111111111111111',
    lastValidBlockHeight: 1234,
    sizeBytes: 900,
    simulation: { unitsConsumed: 61_234, logs: [] },
    fees: { baseLamports: 5_000n, priorityLamports: 12_000n, priorityFeeRead: true, newAccountRentLamports: 2_039_280n },
    steps: [],
    simulated: { signerLamportsDelta: -(SOL / 10n) - 17_000n, tokenDeltas: [] },
    summary,
    check: {} as PreparedTx['check'],
    ...over,
  };
}

export function buySummary(): TxSummary {
  return {
    kind: 'buy',
    mint: MINT,
    maxLamportsIn: SOL / 10n,
    requestedLamports: SOL / 10n,
    minTokensOut: 3_000_000_000n,
    quote: {
      lamportsIn: SOL / 10n,
      feeLamports: SOL / 1000n,
      lamportsToCurve: SOL / 10n - SOL / 1000n,
      tokensOut: 3_500_000_000n,
      capped: false,
    },
    fillsCurve: false,
    priceImpactBps: 33n,
    feeSplit: { total: SOL / 1000n, creator: SOL / 2000n, platform: SOL / 2000n },
  };
}

export function fakeApi(over: Partial<WriteApi> = {}): WriteApi {
  const api: WriteApi = {
    curveWriteConfig: vi.fn(() => openGate().cfg),
    readWriteGate: vi.fn(async () => openGate()),
    writeActions: vi.fn(() => ({ create: true, buy: true, sell: true, migrate: false, poolSwap: false })),
    explorerTxUrl: vi.fn((sig: string) => `https://explorer.test/tx/${sig}`),
    quoteOpeningBuy: vi.fn(() => ({
      ok: true as const,
      value: { lamportsIn: SOL / 10n, feeLamports: SOL / 1000n, lamportsToCurve: 0n, tokensOut: 3_500_000_000_000n, capped: false },
    })),
    priceImpactBps: vi.fn(() => 25n),
    prepareCreateLaunch: vi.fn(),
    readPlantBalance: vi.fn(async () => ({ kind: 'ok' as const, value: PLANT_BALANCE_ENOUGH })),
    readPlantRefusal: vi.fn(async () => null),
    prepareCurveBuy: vi.fn(),
    prepareCurveSell: vi.fn(),
    prepareMigrate: vi.fn(),
    preparePoolSwap: vi.fn(),
    submitPrepared: vi.fn(),
    recheckOutcome: vi.fn(),
    readTokenMetadata: vi.fn(async () => ({ kind: 'absent' as const })),
    listRecentLaunches: vi.fn(async () => ({ kind: 'ok' as const, value: { items: [], before: null, scanned: 60, hidden: 0 } })),
    listLaunchesByCreator: vi.fn(async () => ({ kind: 'ok' as const, value: { items: [], before: null, scanned: 20, hidden: 0 } })),
    readLaunchOrigin: vi.fn(async () => ({ kind: 'absent' as const })),
    readCreatorHolding: vi.fn(async () => ({ kind: 'ok' as const, value: { amount: 0n, accountExists: false } })),
    readLaunchPool: vi.fn(async () => ({ kind: 'not-graduated' as const })),
    meta: {
      LIMITS: validate.LIMITS,
      checkName: validate.checkName,
      checkSymbol: validate.checkSymbol,
      checkDescription: validate.checkDescription,
      checkLinks: validate.checkLinks,
      checkContentUri: validate.checkContentUri,
      displaySafe: validate.displaySafe,
      impersonationWarning: validate.impersonationWarning,
      uploadsAvailable: vi.fn(async () => 'yes' as const),
      prepareLaunchImage: vi.fn(),
      uploadLaunchMetadata: vi.fn(),
      readLaunchMetadataJson: vi.fn(async () => ({ kind: 'unreadable' as const, detail: 'not fetched in tests' })),
    },
  };
  return { ...api, ...over, meta: { ...api.meta, ...(over.meta ?? {}) } };
}
