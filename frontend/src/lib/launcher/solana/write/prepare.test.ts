// @vitest-environment node
//
// Every prepare* function against a fake chain whose simulation we control. What is
// pinned: the simulate-first rule (a failed simulation never reaches a wallet, and
// says why in the failing program's own words), the balance check (a simulation
// that drains more than the screen says is BLOCKED), the compute limit and capped
// priority fee, and that the summary equals what the bytes encode.
import { describe, it, expect } from 'vitest';
import { Keypair, type PublicKey } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, WSOL_MINT, globalPda, poolStatePda } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { quoteBuyOnCurve, quoteSellOnCurve } from '../curve/math';
import { readCurve, type CurveAccount } from '../curve/read';
import { quoteOwnPool, readPoolAt } from '../../../solana/cpswap/read';
import type { LaunchPool } from '../discover/pool';
import { MAX_OWN_PRIORITY_LAMPORTS } from './budget';
import { CP_CREATE_POOL_FEE_RECEIVER, launchIndexAddress, readWriteGate } from './config';
import { prepareMigrate } from './graduate';
import { LAUNCH_TERMS_CHANGED, METADATA_URI_MAX_BYTES, prepareCreateLaunch, quoteOpeningBuy } from './launch';
import { BAYLA_MINT, WORKSHOP_BAYLA_ACCOUNT, WORKSHOP_WALLET, baylaAccountOf } from './plant';
import { preparePoolSwap } from './poolSwap';
import { TX_SIZE_LIMIT } from './prepare';
import { prepareCurveBuy, prepareCurveSell, priceImpactBps } from './trade';
import {
  AMM_CONFIG,
  CPSWAP,
  FakeChain,
  LAUNCH,
  VAULT,
  addLaunchPool,
  addPlantAccounts,
  encodeGlobal,
  cfgLocal,
  freshCurve,
  globalValue,
  plantMoved,
  rent,
  setClock,
} from './testkit.fixture';
import type { OpenGate, Prepared, WriteRpc } from './types';

/** The fake answers every call the write path makes; Connection’s overloads are not worth re-typing. */
const W = (c: FakeChain) => c as unknown as WriteRpc;
import { cpPermissionPda, migrationAuthorityPda } from '../curve/program';

const ME = Keypair.generate().publicKey;
const CREATOR = Keypair.generate().publicKey;
const MINT = Keypair.generate().publicKey;
const ATA = associatedTokenAddress(MINT, ME);
const TOKEN_RENT = rent(165);
const SOL = 1_000_000_000;

async function setup(opts: { paused?: boolean; curve?: ReturnType<typeof freshCurve>; curveLamports?: bigint } = {}) {
  const chain = FakeChain.healthy(globalValue({ paused: opts.paused ?? false }));
  chain.set(cpPermissionPda(migrationAuthorityPda(LAUNCH), CPSWAP), { lamports: 1, owner: CPSWAP, data: new Uint8Array(8) });
  chain.tokenAccount(CP_CREATE_POOL_FEE_RECEIVER, WSOL_MINT, VAULT, 0n);
  chain.fund(ME, 10 * SOL);
  // ME holds 250,000 $BAYLA, and the Workshop's account is there: a launch can plant.
  addPlantAccounts(chain, ME);
  chain.addCurve(opts.curve ?? freshCurve(MINT, CREATOR), opts.curveLamports);
  const gate = (await readWriteGate(chain, cfgLocal)) as OpenGate;
  expect(gate.kind).toBe('open');
  const c = await readCurve(chain, MINT, LAUNCH);
  if (c.kind !== 'ok') throw new Error('curve fixture');
  chain.calls = [];
  return { chain, gate, curve: c.value as CurveAccount };
}

type Changes = Parameters<FakeChain['post']>[1];

/** Simulation that succeeds, reporting `changes` for whatever balances it is asked about. */
function simulating(chain: FakeChain, changes: Changes, units = 60_000) {
  chain.simulate = (_vtx, config) => ({
    err: null,
    logs: ['Program log: ok'],
    unitsConsumed: units,
    ...(config?.accounts ? { accounts: chain.post(config.accounts.addresses, changes) } : {}),
  });
}

const ok = (p: Prepared) => {
  if (!p.ok) throw new Error(`expected prepared, got: ${p.outcome.message}`);
  return p.prepared;
};

describe('curve buy', () => {
  it('builds [limit, price, create-ATA, buy], limit from the simulation, priority capped, summary from the bytes', async () => {
    const { chain, gate, curve } = await setup();
    const lamportsIn = 300_000_000n;
    const q = quoteBuyOnCurve(curve.curve, lamportsIn);
    if (!q.ok) throw new Error('quote');
    simulating(chain, {
      [ME.toBase58()]: { lamportsDelta: -(Number(lamportsIn) + TOKEN_RENT) },
      [ATA.toBase58()]: { tokenAmount: q.value.tokensOut, mint: MINT, owner: ME },
    });
    const p = ok(await prepareCurveBuy(W(chain), gate, { trader: ME, mint: MINT, curve, lamportsIn, slippageBps: 100n }));

    expect(p.tx.instructions).toHaveLength(4);
    expect(p.steps.map((s) => s.kind)).toEqual(['compute-limit', 'compute-price', 'create-token-account', 'curve-buy']);
    expect(p.steps[0]).toEqual({ kind: 'compute-limit', units: 69_000 }); // ceil(60,000 × 1.15)
    expect(p.steps[1]).toEqual({ kind: 'compute-price', microLamports: 10_000n }); // p75 of [0,0,10k,20k]
    expect(p.fees.priorityLamports).toBe(690n);
    expect(p.fees.priorityLamports).toBeLessThanOrEqual(MAX_OWN_PRIORITY_LAMPORTS);
    expect(p.fees.baseLamports).toBe(5_000n);
    expect(p.fees.newAccountRentLamports).toBe(BigInt(TOKEN_RENT));
    expect(p.summary.kind).toBe('buy');
    if (p.summary.kind !== 'buy') return;
    expect(p.summary.minTokensOut).toBe((q.value.tokensOut * 9_900n) / 10_000n);
    expect(p.summary.minTokensOut).toBeGreaterThan(0n);
    expect(p.summary.feeSplit).toEqual({ total: q.value.feeLamports, creator: q.value.feeLamports / 2n, platform: q.value.feeLamports - q.value.feeLamports / 2n });
    expect(p.simulated.signerLamportsDelta).toBe(-(lamportsIn + BigInt(TOKEN_RENT)));
    expect(p.tx.feePayer?.equals(ME)).toBe(true);
    // Two simulations: one to size it, one of the final bytes.
    expect(chain.simulateCalls).toHaveLength(2);
  });

  it('BLOCKS when the simulation shows more SOL leaving than the screen says', async () => {
    const { chain, gate, curve } = await setup();
    const q = quoteBuyOnCurve(curve.curve, 300_000_000n);
    if (!q.ok) throw new Error('quote');
    simulating(chain, {
      [ME.toBase58()]: { lamportsDelta: -(300_000_000 + TOKEN_RENT + 50_000_000) },
      [ATA.toBase58()]: { tokenAmount: q.value.tokensOut, mint: MINT, owner: ME },
    });
    const r = await prepareCurveBuy(W(chain), gate, { trader: ME, mint: MINT, curve, lamportsIn: 300_000_000n, slippageBps: 100n });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.outcome).toMatchObject({ stage: 'simulate', message: expect.stringMatching(/more SOL leaving/) });
  });

  it('BLOCKS when the simulation shows fewer tokens than the minimum', async () => {
    const { chain, gate, curve } = await setup();
    simulating(chain, {
      [ME.toBase58()]: { lamportsDelta: -(300_000_000 + TOKEN_RENT) },
      [ATA.toBase58()]: { tokenAmount: 1n, mint: MINT, owner: ME },
    });
    const r = await prepareCurveBuy(W(chain), gate, { trader: ME, mint: MINT, curve, lamportsIn: 300_000_000n, slippageBps: 100n });
    expect(!r.ok && r.outcome.message).toMatch(/different token amount/);
  });

  it('a failed simulation stops before any wallet, in the failing program’s own words', async () => {
    const { chain, gate, curve } = await setup();
    chain.simulate = () => ({
      err: { InstructionError: [3, { Custom: 6007 }] },
      logs: [
        `Program ${LAUNCH.toBase58()} invoke [1]`,
        'Program log: AnchorError occurred. Error Code: SlippageExceeded. Error Number: 6007.',
        `Program ${LAUNCH.toBase58()} failed: custom program error: 0x1777`,
      ],
    });
    const r = await prepareCurveBuy(W(chain), gate, { trader: ME, mint: MINT, curve, lamportsIn: 300_000_000n, slippageBps: 100n });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.outcome.stage).toBe('simulate');
    expect(r.outcome.message).toMatch(/price moved past your limit/);
    expect(r.outcome.logs?.length).toBe(3);
    expect(chain.calls).not.toContain('sendRawTransaction');
  });

  it('refuses while paused, an over-5% price limit, and a zero price limit', async () => {
    const paused = await setup({ paused: true });
    let r = await prepareCurveBuy(W(paused.chain), paused.gate, { trader: ME, mint: MINT, curve: paused.curve, lamportsIn: 1n, slippageBps: 100n });
    expect(!r.ok && r.outcome.message).toMatch(/paused.*Selling still works/);
    const { chain, gate, curve } = await setup();
    r = await prepareCurveBuy(W(chain), gate, { trader: ME, mint: MINT, curve, lamportsIn: SOL_n(), slippageBps: 501n });
    expect(!r.ok && r.outcome.message).toMatch(/at most 5%/);
    r = await prepareCurveBuy(W(chain), gate, { trader: ME, mint: MINT, curve, lamportsIn: SOL_n(), slippageBps: 0n });
    expect(!r.ok && r.outcome.message).toMatch(/above 0%/);
    expect(chain.simulateCalls).toHaveLength(0);
  });

  it('a priority-fee read failure falls back to 0 and says so', async () => {
    const { chain, gate, curve } = await setup();
    chain.fees = new Error('down');
    const q = quoteBuyOnCurve(curve.curve, 300_000_000n);
    if (!q.ok) throw new Error('quote');
    simulating(chain, {
      [ME.toBase58()]: { lamportsDelta: -(300_000_000 + TOKEN_RENT) },
      [ATA.toBase58()]: { tokenAmount: q.value.tokensOut, mint: MINT, owner: ME },
    });
    const p = ok(await prepareCurveBuy(W(chain), gate, { trader: ME, mint: MINT, curve, lamportsIn: 300_000_000n, slippageBps: 100n }));
    expect(p.fees.priorityFeeRead).toBe(false);
    expect(p.fees.priorityLamports).toBe(0n);
  });

  it('recent fees far above the cap are capped at 0.001 SOL', async () => {
    const { chain, gate, curve } = await setup();
    chain.fees = [1e12, 1e12, 1e12, 1e12];
    const q = quoteBuyOnCurve(curve.curve, 300_000_000n);
    if (!q.ok) throw new Error('quote');
    simulating(chain, {
      [ME.toBase58()]: { lamportsDelta: -(300_000_000 + TOKEN_RENT) },
      [ATA.toBase58()]: { tokenAmount: q.value.tokensOut, mint: MINT, owner: ME },
    });
    const p = ok(await prepareCurveBuy(W(chain), gate, { trader: ME, mint: MINT, curve, lamportsIn: 300_000_000n, slippageBps: 100n }));
    expect(p.fees.priorityLamports).toBeLessThanOrEqual(MAX_OWN_PRIORITY_LAMPORTS);
    expect(p.fees.priorityLamports).toBeGreaterThan(MAX_OWN_PRIORITY_LAMPORTS - 100n);
  });

  // F1: the page hands in the curve it loaded, possibly minutes ago. The quote and
  // the minimum must come from the curve as the chain has it now.
  it('quotes a buy from the curve as it is NOW, not from the copy the page loaded', async () => {
    const { chain, gate, curve } = await setup();
    const moved = { ...curve.curve, realSolReserves: 400_000_000n, realTokenReserves: curve.curve.realTokenReserves - 120_000_000_000_000n };
    chain.addCurve(moved);
    const now = quoteBuyOnCurve(moved, 100_000_000n);
    const stale = quoteBuyOnCurve(curve.curve, 100_000_000n);
    if (!now.ok || !stale.ok) throw new Error('quote');
    expect(now.value.tokensOut).toBeLessThan(stale.value.tokensOut);
    simulating(chain, {
      [ME.toBase58()]: { lamportsDelta: -(100_000_000 + TOKEN_RENT) },
      [ATA.toBase58()]: { tokenAmount: now.value.tokensOut, mint: MINT, owner: ME },
    });
    const p = ok(await prepareCurveBuy(W(chain), gate, { trader: ME, mint: MINT, curve, lamportsIn: 100_000_000n, slippageBps: 100n }));
    if (p.summary.kind !== 'buy') throw new Error('kind');
    expect(p.summary.minTokensOut).toBe((now.value.tokensOut * 9_900n) / 10_000n);
    expect(p.summary.quote.tokensOut).toBe(now.value.tokensOut);
  });

  it('a curve that cannot be read again stops the buy before anything is simulated', async () => {
    const { chain, gate, curve } = await setup();
    chain.getAccountInfo = async () => {
      throw new Error('rpc down');
    };
    const r = await prepareCurveBuy(W(chain), gate, { trader: ME, mint: MINT, curve, lamportsIn: 100_000_000n, slippageBps: 100n });
    expect(!r.ok && r.outcome.message).toMatch(/Could not read the curve/);
    expect(chain.simulateCalls).toHaveLength(0);
  });

  // F2: the program takes min(max_lamports_in, what is left to the target) when it
  // RUNS. Signed for the typed amount, a sell landing first lets it take more than
  // the review's "at most".
  it('a buy that fills the curve is SIGNED for what the curve can take, not the amount typed', async () => {
    const base = freshCurve(MINT, CREATOR);
    const nearFull = { ...base, realSolReserves: 1_000_000_000n, realTokenReserves: base.realTokenReserves - 300_000_000_000_000n };
    const { chain, gate, curve } = await setup({ curve: nearFull });
    const q = quoteBuyOnCurve(curve.curve, SOL_n());
    if (!q.ok) throw new Error('quote');
    expect(q.value.capped).toBe(true);
    simulating(chain, {
      [ME.toBase58()]: { lamportsDelta: -(Number(q.value.lamportsIn) + TOKEN_RENT) },
      [ATA.toBase58()]: { tokenAmount: q.value.tokensOut, mint: MINT, owner: ME },
    });
    const p = ok(await prepareCurveBuy(W(chain), gate, { trader: ME, mint: MINT, curve, lamportsIn: SOL_n(), slippageBps: 100n }));
    const step = p.steps.find((s) => s.kind === 'curve-buy');
    expect(step && step.kind === 'curve-buy' && step.maxLamportsIn).toBe(q.value.lamportsIn);
    if (p.summary.kind !== 'buy') throw new Error('kind');
    expect(p.summary).toMatchObject({ fillsCurve: true, maxLamportsIn: q.value.lamportsIn, requestedLamports: SOL_n() });
    expect(p.check.expect.maxSolOut).toBe(q.value.lamportsIn + BigInt(TOKEN_RENT));

    // A simulation that takes the whole typed amount is outside what the screen says.
    simulating(chain, {
      [ME.toBase58()]: { lamportsDelta: -(Number(SOL_n()) + TOKEN_RENT) },
      [ATA.toBase58()]: { tokenAmount: q.value.tokensOut, mint: MINT, owner: ME },
    });
    const r = await prepareCurveBuy(W(chain), gate, { trader: ME, mint: MINT, curve, lamportsIn: SOL_n(), slippageBps: 100n });
    expect(!r.ok && r.outcome.message).toMatch(/more SOL leaving/);
  });
});

function SOL_n() {
  return 1_000_000_000n;
}

describe('curve sell', () => {
  it('quotes WITH the rent floor, stays open while paused, and pins the exact token debit', async () => {
    const bought = freshCurve(MINT, CREATOR);
    const curveState = { ...bought, realSolReserves: 500_000_000n, realTokenReserves: bought.realTokenReserves - 100_000_000_000_000n };
    const { chain, gate, curve } = await setup({ paused: true, curve: curveState });
    chain.tokenAccount(ATA, MINT, ME, 10_000_000_000_000n);
    const tokensIn = 5_000_000_000_000n;
    const floor = BigInt(rent(179));
    const q = quoteSellOnCurve(curve.curve, tokensIn, 0n, { curveAccountLamports: curve.lamports, rentExemptLamports: floor });
    if (!q.ok) throw new Error('quote');
    simulating(chain, {
      [ME.toBase58()]: { lamportsDelta: Number(q.value.lamportsOut) },
      [ATA.toBase58()]: { tokenAmount: 5_000_000_000_000n, mint: MINT, owner: ME },
    });
    const p = ok(await prepareCurveSell(W(chain), gate, { trader: ME, mint: MINT, curve, curveRentFloor: floor, tokensIn, slippageBps: 100n }));
    expect(p.summary.kind).toBe('sell');
    if (p.summary.kind !== 'sell') return;
    expect(p.summary.minLamportsOut).toBe((q.value.lamportsOut * 9_900n) / 10_000n);
    expect(p.steps.map((s) => s.kind)).toEqual(['compute-limit', 'compute-price', 'curve-sell']);
  });

  it('BLOCKS a simulation that takes more tokens than the sell says', async () => {
    const bought = freshCurve(MINT, CREATOR);
    const { chain, gate, curve } = await setup({ curve: { ...bought, realSolReserves: 500_000_000n, realTokenReserves: bought.realTokenReserves - 100_000_000_000_000n } });
    chain.tokenAccount(ATA, MINT, ME, 10_000_000_000_000n);
    simulating(chain, { [ME.toBase58()]: { lamportsDelta: 50_000_000 }, [ATA.toBase58()]: { tokenAmount: 0n, mint: MINT, owner: ME } });
    const r = await prepareCurveSell(W(chain), gate, { trader: ME, mint: MINT, curve, curveRentFloor: BigInt(rent(179)), tokensIn: 5_000_000_000_000n, slippageBps: 100n });
    expect(!r.ok && r.outcome.message).toMatch(/different token amount/);
  });

  it('quotes a sell from the curve as it is NOW (reserves and account balance), not the page copy', async () => {
    const bought = freshCurve(MINT, CREATOR);
    const atLoad = { ...bought, realSolReserves: 500_000_000n, realTokenReserves: bought.realTokenReserves - 100_000_000_000_000n };
    const { chain, gate, curve } = await setup({ curve: atLoad });
    const later = { ...atLoad, realSolReserves: 250_000_000n, realTokenReserves: atLoad.realTokenReserves + 30_000_000_000_000n };
    chain.addCurve(later);
    chain.tokenAccount(ATA, MINT, ME, 10_000_000_000_000n);
    const floor = BigInt(rent(179));
    const now = quoteSellOnCurve(later, 5_000_000_000_000n, 0n, { curveAccountLamports: floor + later.realSolReserves, rentExemptLamports: floor });
    if (!now.ok) throw new Error('quote');
    simulating(chain, {
      [ME.toBase58()]: { lamportsDelta: Number(now.value.lamportsOut) },
      [ATA.toBase58()]: { tokenAmount: 5_000_000_000_000n, mint: MINT, owner: ME },
    });
    const p = ok(await prepareCurveSell(W(chain), gate, { trader: ME, mint: MINT, curve, curveRentFloor: floor, tokensIn: 5_000_000_000_000n, slippageBps: 100n }));
    if (p.summary.kind !== 'sell') throw new Error('kind');
    expect(p.summary.minLamportsOut).toBe((now.value.lamportsOut * 9_900n) / 10_000n);
  });

  it('a sell the curve cannot pay (rent floor) is refused before building', async () => {
    const { chain, gate, curve } = await setup();
    const r = await prepareCurveSell(W(chain), gate, { trader: ME, mint: MINT, curve, curveRentFloor: BigInt(rent(179)), tokensIn: 1_000_000_000n, slippageBps: 100n });
    expect(r.ok).toBe(false);
    expect(chain.simulateCalls).toHaveLength(0);
  });
});

describe('create', () => {
  // The largest details the encoder allows: name 32, symbol 10, link 80 bytes.
  const worst = { name: 'N'.repeat(32), symbol: 'S'.repeat(10), uri: `ipfs://${'b'.repeat(73)}` };
  /** The platform reserve create_launch pays at 369 bps of the fixture supply. */
  const reserveOf = (g = globalValue()) => (g.tokenTotalSupply * g.platformReserveBps) / 10_000n;
  /** What the program does to the treasury's token account: it receives the reserve, exactly. */
  const treasuryGets = (mint: PublicKey, amount = reserveOf()) => ({
    [associatedTokenAddress(mint, VAULT).toBase58()]: { tokenAmount: amount, mint, owner: VAULT },
  });
  /** Mint, curve, vault and treasury token account rent, and the token details. */
  const createRent = () => rent(82) + rent(179) + TOKEN_RENT + TOKEN_RENT + rent(607);

  it('one transaction, mint signs too, opening buy minimum = the quote EXACTLY, launch index trailing', async () => {
    const { chain, gate } = await setup();
    const mintKp = Keypair.generate();
    const lamportsIn = 50_000_000n;
    const q = quoteOpeningBuy(gate.global, lamportsIn);
    if (!q.ok) throw new Error('quote');
    const creatorAta = associatedTokenAddress(mintKp.publicKey, ME);
    simulating(chain, {
      [ME.toBase58()]: { lamportsDelta: -(createRent() + Number(lamportsIn) + TOKEN_RENT) },
      [creatorAta.toBase58()]: { tokenAmount: q.value.tokensOut, mint: mintKp.publicKey, owner: ME },
      ...treasuryGets(mintKp.publicKey),
      ...plantMoved(ME),
    }, 120_000);
    const p = ok(await prepareCreateLaunch(W(chain), gate, { creator: ME, mint: mintKp, metadata: worst, openingBuy: { lamportsIn } }));
    expect(p.extraSigners).toEqual([mintKp]);
    expect(p.summary.kind).toBe('create');
    if (p.summary.kind !== 'create') return;
    expect(p.summary.openingBuy?.minTokensOut).toBe(q.value.tokensOut);
    expect(p.summary.name).toBe(worst.name);
    // 11 accounts (the reserve-at-create program), then the launch index.
    const launchIx = p.tx.instructions.find((i) => i.programId.equals(LAUNCH) && i.keys.length === 12);
    expect(launchIx?.keys[8]?.pubkey.equals(VAULT)).toBe(true);
    expect(launchIx?.keys[9]?.pubkey.equals(associatedTokenAddress(mintKp.publicKey, VAULT))).toBe(true);
    expect(launchIx?.keys[10]?.pubkey.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(launchIx?.keys[11]?.pubkey.equals(launchIndexAddress(LAUNCH))).toBe(true);
  });

  // Reserve at create (owner decision 2026-09-26).
  it('the review carries the reserve, its receiver READ FROM CHAIN, and the treasury account rent read from the cluster', async () => {
    const { chain, gate } = await setup();
    const mintKp = Keypair.generate();
    simulating(chain, { [ME.toBase58()]: { lamportsDelta: -createRent() }, ...treasuryGets(mintKp.publicKey), ...plantMoved(ME) });
    const p = ok(await prepareCreateLaunch(W(chain), gate, { creator: ME, mint: mintKp, metadata: worst }));
    if (p.summary.kind !== 'create') throw new Error('kind');
    const treasuryToken = associatedTokenAddress(mintKp.publicKey, VAULT);
    expect(p.summary.platformReserve).toEqual({ amount: reserveOf(), bps: 369n, recipient: VAULT, treasuryToken });
    // rent(165) from getMinimumBalanceForRentExemption, never a constant in the code.
    expect(p.summary.treasuryAccountRent).toBe(BigInt(TOKEN_RENT));
    expect(p.fees.newAccountRentLamports).toBe(BigInt(rent(82) + rent(179) + 2 * TOKEN_RENT));
    expect(p.steps).toContainEqual({ kind: 'create-launch', mint: mintKp.publicKey, feeRecipient: VAULT, treasuryToken });
    // The test run proves the reserve lands in the treasury, and says whose tokens they are.
    expect(p.simulated.tokenDeltas).toContainEqual({ mint: mintKp.publicKey, account: treasuryToken, delta: reserveOf(), role: 'treasury' });
  });

  it('BLOCKS a test run in which the treasury receives anything but the reserve', async () => {
    for (const amount of [reserveOf() - 1n, reserveOf() + 1n, 0n]) {
      const { chain, gate } = await setup();
      const mintKp = Keypair.generate();
      simulating(chain, {
        [ME.toBase58()]: { lamportsDelta: -createRent() },
        ...(amount > 0n ? treasuryGets(mintKp.publicKey, amount) : {}),
        ...plantMoved(ME),
      });
      const r = await prepareCreateLaunch(W(chain), gate, { creator: ME, mint: mintKp, metadata: worst });
      expect(!r.ok && r.outcome.message).toMatch(/different token amount/);
    }
  });

  it('a treasury token account that already exists costs the creator nothing, and says so', async () => {
    const { chain, gate } = await setup();
    const mintKp = Keypair.generate();
    chain.tokenAccount(associatedTokenAddress(mintKp.publicKey, VAULT), mintKp.publicKey, VAULT, 0n);
    simulating(chain, { [ME.toBase58()]: { lamportsDelta: -(createRent() - TOKEN_RENT) }, ...treasuryGets(mintKp.publicKey), ...plantMoved(ME) });
    const p = ok(await prepareCreateLaunch(W(chain), gate, { creator: ME, mint: mintKp, metadata: worst }));
    if (p.summary.kind !== 'create') throw new Error('kind');
    expect(p.summary.treasuryAccountRent).toBe(0n);
    expect(p.fees.newAccountRentLamports).toBe(BigInt(rent(82) + rent(179) + TOKEN_RENT));
  });

  // The treasury's own wallet launching: its token account and the treasury's are one
  // account, which receives the reserve AND the buy. Two exact checks on that one
  // account could never both pass, so it is refused up front, in plain words.
  it('the treasury wallet: an opening buy is refused before anything is simulated; no buy builds', async () => {
    const { chain, gate } = await setup();
    chain.fund(VAULT, 10 * SOL);
    addPlantAccounts(chain, VAULT);
    const mintKp = Keypair.generate();
    const q = quoteOpeningBuy(gate.global, 50_000_000n);
    if (!q.ok) throw new Error('quote');
    const same = associatedTokenAddress(mintKp.publicKey, VAULT);
    simulating(chain, {
      [VAULT.toBase58()]: { lamportsDelta: -(createRent() + 50_000_000) },
      [same.toBase58()]: { tokenAmount: reserveOf() + q.value.tokensOut, mint: mintKp.publicKey, owner: VAULT },
    });
    const r = await prepareCreateLaunch(W(chain), gate, { creator: VAULT, mint: mintKp, metadata: worst, openingBuy: { lamportsIn: 50_000_000n } });
    expect(!r.ok && r.outcome).toMatchObject({
      stage: 'build',
      message:
        'This wallet is the platform treasury, so an opening buy would land in the same token account as the platform reserve. Launch without an opening buy, then buy on the curve.',
    });
    expect(chain.simulateCalls).toHaveLength(0);
    const plain = Keypair.generate();
    simulating(chain, { [VAULT.toBase58()]: { lamportsDelta: -createRent() }, ...treasuryGets(plain.publicKey), ...plantMoved(VAULT) });
    ok(await prepareCreateLaunch(W(chain), gate, { creator: VAULT, mint: plain, metadata: worst }));
  });

  it('rent that cannot be read stops the launch before anything is simulated', async () => {
    const { chain, gate } = await setup();
    chain.getMinimumBalanceForRentExemption = async () => {
      throw new Error('HTTP 429');
    };
    const r = await prepareCreateLaunch(W(chain), gate, { creator: ME, mint: Keypair.generate(), metadata: worst });
    expect(!r.ok && r.outcome).toMatchObject({ stage: 'build', message: 'Could not read the network to prepare this launch.' });
    expect(chain.simulateCalls).toHaveLength(0);
  });

  // Measured 2026-10-01: 1,210 of 1,232 bytes (1,069 before the plant's 4 keys and 2
  // instructions; the link cap went 100 -> 80). The create NO LONGER keeps 150 bytes for
  // a wallet's own guard instructions: 22 are left. Whether a wallet then skips its
  // guards or refuses is unmeasured, and only a real wallet can say.
  it('the true worst case (name 32, symbol 10, link 80, opening buy, plant) is 1,210 bytes, under the 1,232 limit', async () => {
    expect(new TextEncoder().encode(worst.uri).length).toBe(METADATA_URI_MAX_BYTES);
    expect(METADATA_URI_MAX_BYTES).toBe(80);
    const { chain, gate } = await setup();
    const mintKp = Keypair.generate();
    const q = quoteOpeningBuy(gate.global, 50_000_000n);
    if (!q.ok) throw new Error('quote');
    simulating(chain, {
      [ME.toBase58()]: { lamportsDelta: -(createRent() + TOKEN_RENT + 50_000_000) },
      [associatedTokenAddress(mintKp.publicKey, ME).toBase58()]: { tokenAmount: q.value.tokensOut, mint: mintKp.publicKey, owner: ME },
      ...treasuryGets(mintKp.publicKey),
      ...plantMoved(ME),
    });
    const p = ok(await prepareCreateLaunch(W(chain), gate, { creator: ME, mint: mintKp, metadata: worst, openingBuy: { lamportsIn: 50_000_000n } }));
    expect(p.steps.map((s) => s.kind).slice(-4)).toEqual(['create-token-account', 'curve-buy', 'plant-burn', 'plant-transfer']);
    process.stdout.write(`[size] worst-case create with opening buy and plant: ${p.sizeBytes} of ${TX_SIZE_LIMIT} bytes\n`);
    expect(p.sizeBytes).toBeLessThanOrEqual(TX_SIZE_LIMIT);
    expect(p.sizeBytes).toBe(1_210);
  });

  // The plant (island ruling 2): 100,000 $BAYLA from the maker's own $BAYLA account, in
  // the create transaction itself: 50,000 burned, 50,000 to the island's Workshop.
  describe('the plant', () => {
    const T22 = TOKEN_2022_PROGRAM_ID.toBase58();
    const MINE = baylaAccountOf(ME);
    const build = async (chain: FakeChain, gate: OpenGate, creator: PublicKey = ME) =>
      prepareCreateLaunch(W(chain), gate, { creator, mint: Keypair.generate(), metadata: worst });

    it('rides in the create transaction; the review is read back out of the bytes; the test run proves both halves', async () => {
      const { chain, gate } = await setup();
      const mintKp = Keypair.generate();
      simulating(chain, { [ME.toBase58()]: { lamportsDelta: -createRent() }, ...treasuryGets(mintKp.publicKey), ...plantMoved(ME) });
      const p = ok(await prepareCreateLaunch(W(chain), gate, { creator: ME, mint: mintKp, metadata: worst }));
      expect(p.tx.instructions.slice(-2).map((i) => i.programId.toBase58())).toEqual([T22, T22]);
      if (p.summary.kind !== 'create') throw new Error('kind');
      expect(p.summary.plant).toEqual({
        total: 100_000_000_000n,
        burned: 50_000_000_000n,
        toWorkshop: 50_000_000_000n,
        from: MINE,
        workshopAccount: WORKSHOP_BAYLA_ACCOUNT,
        mint: BAYLA_MINT,
        decimals: 6,
      });
      expect(p.simulated.tokenDeltas).toContainEqual({ mint: BAYLA_MINT, account: MINE, delta: -100_000_000_000n });
      expect(p.simulated.tokenDeltas).toContainEqual({ mint: BAYLA_MINT, account: WORKSHOP_BAYLA_ACCOUNT, delta: 50_000_000_000n, role: 'workshop' });
      // The mint is never watched as a token account: its bytes at offset 64 are not an amount.
      expect(p.check.watch.tokenAccounts.some((t) => t.account.equals(BAYLA_MINT))).toBe(false);
      // It moves no SOL and creates no account: rent and the SOL bound are what they were.
      expect(p.fees.newAccountRentLamports).toBe(BigInt(rent(82) + rent(179) + 2 * TOKEN_RENT));
    });

    it('BLOCKS a test run in which the Workshop receives anything but 50,000 $BAYLA', async () => {
      for (const toWorkshop of [49_999_999_999n, 50_000_000_001n, 0n]) {
        const { chain, gate } = await setup();
        const mintKp = Keypair.generate();
        // Your side still loses exactly 100,000: only the Workshop's half is off.
        simulating(chain, {
          [ME.toBase58()]: { lamportsDelta: -createRent() },
          ...treasuryGets(mintKp.publicKey),
          ...plantMoved(ME, { burned: 100_000_000_000n - toWorkshop, toWorkshop }),
        });
        const r = await prepareCreateLaunch(W(chain), gate, { creator: ME, mint: mintKp, metadata: worst });
        expect(!r.ok && r.outcome.message, String(toWorkshop)).toMatch(/different token amount/);
      }
    });

    it('BLOCKS a test run in which your $BAYLA changes by anything but -100,000', async () => {
      for (const burned of [49_999_999_999n, 50_000_000_001n, 0n]) {
        const { chain, gate } = await setup();
        const mintKp = Keypair.generate();
        simulating(chain, {
          [ME.toBase58()]: { lamportsDelta: -createRent() },
          ...treasuryGets(mintKp.publicKey),
          ...plantMoved(ME, { burned }),
        });
        const r = await prepareCreateLaunch(W(chain), gate, { creator: ME, mint: mintKp, metadata: worst });
        expect(!r.ok && r.outcome.message, String(burned)).toMatch(/different token amount/);
      }
    });

    it('the Workshop’s own wallet cannot launch: refused before anything is read', async () => {
      const { chain, gate } = await setup();
      chain.fund(WORKSHOP_WALLET, 10 * SOL);
      addPlantAccounts(chain, WORKSHOP_WALLET);
      chain.calls = [];
      const r = await build(chain, gate, WORKSHOP_WALLET);
      expect(!r.ok && r.outcome).toMatchObject({ stage: 'build', message: expect.stringMatching(/is the island's Workshop/) });
      expect(chain.calls).toEqual([]);
    });

    it('no $BAYLA account, or less than 100,000 in it: refused before anything is simulated; exactly 100,000 builds', async () => {
      const none = await setup();
      none.chain.accounts.delete(MINE.toBase58());
      let r = await build(none.chain, none.gate);
      expect(!r.ok && r.outcome).toMatchObject({ stage: 'build', message: 'Your wallet holds no $BAYLA. A launch plants 100,000 $BAYLA, so nothing was built.' });
      expect(none.chain.simulateCalls).toHaveLength(0);

      const short = await setup();
      addPlantAccounts(short.chain, ME, 99_999_999_999n);
      r = await build(short.chain, short.gate);
      expect(!r.ok && r.outcome).toMatchObject({
        stage: 'build',
        message: 'Your $BAYLA account holds 99,999.999999 $BAYLA. A launch plants 100,000 $BAYLA from it, so nothing was built.',
      });
      expect(short.chain.simulateCalls).toHaveLength(0);

      const exact = await setup();
      addPlantAccounts(exact.chain, ME, 100_000_000_000n);
      const mintKp = Keypair.generate();
      simulating(exact.chain, {
        [ME.toBase58()]: { lamportsDelta: -createRent() },
        ...treasuryGets(mintKp.publicKey),
        ...plantMoved(ME, { makerAmount: 100_000_000_000n }),
      });
      ok(await prepareCreateLaunch(W(exact.chain), exact.gate, { creator: ME, mint: mintKp, metadata: worst }));
    });

    it('the Workshop account missing, or not the Workshop’s Token-2022 $BAYLA account: refused before anything is simulated', async () => {
      const stranger = Keypair.generate().publicKey;
      const cases: Array<[string, (c: FakeChain) => void]> = [
        ['missing', (c) => void c.accounts.delete(WORKSHOP_BAYLA_ACCOUNT.toBase58())],
        ['another owner', (c) => void c.token2022Account(WORKSHOP_BAYLA_ACCOUNT, BAYLA_MINT, stranger, 1n)],
        ['another mint', (c) => void c.token2022Account(WORKSHOP_BAYLA_ACCOUNT, Keypair.generate().publicKey, WORKSHOP_WALLET, 1n)],
        ['the legacy token program', (c) => void c.tokenAccount(WORKSHOP_BAYLA_ACCOUNT, BAYLA_MINT, WORKSHOP_WALLET, 1n)],
      ];
      for (const [label, spoil] of cases) {
        const { chain, gate } = await setup();
        spoil(chain);
        const r = await build(chain, gate);
        expect(!r.ok && r.outcome.stage, label).toBe('build');
        expect(!r.ok && r.outcome.message, label).toMatch(label === 'missing' ? /Workshop has no \$BAYLA account/ : /Workshop account is not the \$BAYLA account/);
        expect(chain.simulateCalls, label).toHaveLength(0);
      }
    });

    it('a $BAYLA read that fails refuses; it never passes as "enough"', async () => {
      for (const [target, why] of [
        [MINE, /Could not read your \$BAYLA balance/],
        [WORKSHOP_BAYLA_ACCOUNT, /Could not read the island's Workshop account/],
      ] as const) {
        const { chain, gate } = await setup();
        const real = chain.getAccountInfo;
        chain.getAccountInfo = async (a: PublicKey) => {
          if (a.equals(target)) throw new Error('HTTP 429');
          return real(a);
        };
        const r = await build(chain, gate);
        expect(!r.ok && r.outcome).toMatchObject({ stage: 'build', message: expect.stringMatching(why) });
        expect(chain.simulateCalls).toHaveLength(0);
      }
    });
  });

  it('refused while paused, and a name the details instruction cannot hold is refused before any network call', async () => {
    const paused = await setup({ paused: true });
    let r = await prepareCreateLaunch(W(paused.chain), paused.gate, { creator: ME, mint: Keypair.generate(), metadata: worst });
    expect(!r.ok && r.outcome.message).toMatch(/paused/);
    const { chain, gate } = await setup();
    r = await prepareCreateLaunch(W(chain), gate, { creator: ME, mint: Keypair.generate(), metadata: { ...worst, name: 'N'.repeat(33) } });
    expect(!r.ok && r.outcome.stage).toBe('build');
    expect(chain.simulateCalls).toHaveLength(0);
  });

  // R6-4: create_launch copies the program's settings AS THEY ARE when it runs. The
  // form showed the settings read when the page loaded; an operator change since then
  // would launch the creator on terms the page never showed. That includes WHO gets
  // the platform reserve: the program pays whatever fee_recipient says at that moment.
  it('re-reads the launch terms: changed since the page loaded = refused, nothing simulated', async () => {
    for (const change of [
      { tradeFeeBps: 200n },
      { creatorFeeShareBps: 1_000n },
      { platformReserveBps: 900n },
      { graduationTargetLamports: 1n },
      { migrationReserveLamports: 1n },
      { initialVirtualSol: 1n },
      { initialVirtualToken: 1n },
      { feeRecipient: Keypair.generate().publicKey },
    ]) {
      const { chain, gate } = await setup();
      chain.set(globalPda(LAUNCH), { lamports: rent(202), owner: LAUNCH, data: encodeGlobal(globalValue(change)) });
      simulating(chain, { [ME.toBase58()]: { lamportsDelta: -createRent() } });
      const r = await prepareCreateLaunch(W(chain), gate, { creator: ME, mint: Keypair.generate(), metadata: worst });
      expect(r.ok, JSON.stringify(change, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(false);
      expect(!r.ok && r.outcome).toMatchObject({ stage: 'build', message: LAUNCH_TERMS_CHANGED });
      expect(chain.simulateCalls).toHaveLength(0);
    }
    // Paused since the page loaded: refused as paused.
    const { chain, gate } = await setup();
    chain.set(globalPda(LAUNCH), { lamports: rent(202), owner: LAUNCH, data: encodeGlobal(globalValue({ paused: true })) });
    const p = await prepareCreateLaunch(W(chain), gate, { creator: ME, mint: Keypair.generate(), metadata: worst });
    expect(!p.ok && p.outcome.message).toMatch(/paused/);
    // Unreadable is not "unchanged".
    const u = await setup();
    u.chain.getAccountInfo = async () => {
      throw new Error('down');
    };
    const q = await prepareCreateLaunch(W(u.chain), u.gate, { creator: ME, mint: Keypair.generate(), metadata: worst });
    expect(!q.ok && q.outcome.message).toMatch(/Could not read the launch terms/);
  });

  it('the same terms as the page showed: builds as before', async () => {
    const { chain, gate } = await setup();
    const mintKp = Keypair.generate();
    simulating(chain, { [ME.toBase58()]: { lamportsDelta: -createRent() }, ...treasuryGets(mintKp.publicKey), ...plantMoved(ME) });
    ok(await prepareCreateLaunch(W(chain), gate, { creator: ME, mint: mintKp, metadata: worst }));
  });
});

describe('graduate', () => {
  it('migrate: compute floor 400,000, the pool is the launch program’s own address', async () => {
    const c = freshCurve(MINT, CREATOR);
    const full = { ...c, realSolReserves: c.graduationTargetLamports + c.migrationReserveLamports };
    const { chain, gate, curve } = await setup({ curve: full });
    simulating(chain, { [ME.toBase58()]: { lamportsDelta: -TOKEN_RENT } }, 270_000);
    const p = ok(await prepareMigrate(W(chain), gate, { payer: ME, mint: MINT, curve }));
    expect(p.steps[0]).toEqual({ kind: 'compute-limit', units: 400_000 });
    expect(p.summary).toEqual({ kind: 'migrate', mint: MINT, pool: poolStatePda(MINT, LAUNCH) });
  });

  it('migrate BLOCKED when the simulation charges the clicker more than two token accounts of rent', async () => {
    const c = freshCurve(MINT, CREATOR);
    const { chain, gate, curve } = await setup({ curve: { ...c, realSolReserves: c.graduationTargetLamports + c.migrationReserveLamports } });
    simulating(chain, { [ME.toBase58()]: { lamportsDelta: -(3 * TOKEN_RENT + 100_000) } }, 270_000);
    const r = await prepareMigrate(W(chain), gate, { payer: ME, mint: MINT, curve });
    expect(!r.ok && r.outcome.message).toMatch(/more SOL leaving/);
  });

  it('a race lost to another graduation reads as "someone already finished this"', async () => {
    const c = freshCurve(MINT, CREATOR);
    const { chain, gate, curve } = await setup({ curve: { ...c, realSolReserves: c.graduationTargetLamports + c.migrationReserveLamports } });
    chain.simulate = () => ({ err: { InstructionError: [2, { Custom: 6005 }] }, logs: [`Program ${LAUNCH.toBase58()} failed: custom program error: 0x1775`] });
    const r = await prepareMigrate(W(chain), gate, { payer: ME, mint: MINT, curve });
    expect(!r.ok && r.outcome.message).toMatch(/someone may have just finished it/);
  });

  // L3/F3: the "One-time account rent" line must match what the signed transaction keeps.
  it('migrate shows no account rent: the program closes the accounts it opens back to the payer', async () => {
    const c = freshCurve(MINT, CREATOR);
    const { chain, gate, curve } = await setup({ curve: { ...c, realSolReserves: c.graduationTargetLamports + c.migrationReserveLamports } });
    // lib.rs: 2 ATA rents + the seed top-up out, 3 ATA rents back, so the payer ends ahead.
    simulating(chain, { [ME.toBase58()]: { lamportsDelta: TOKEN_RENT - 890_880 } }, 270_000);
    const p = ok(await prepareMigrate(W(chain), gate, { payer: ME, mint: MINT, curve }));
    expect(p.fees.newAccountRentLamports).toBe(0n);
  });

  // release_platform_reserve is gone from the program (reserve paid at create).
  it('the write layer offers no reserve release', async () => {
    const graduate = await import('./graduate');
    expect(Object.keys(graduate)).toEqual(['prepareMigrate']);
  });
});

describe('pool swap', () => {
  const POOL = poolStatePda(MINT, LAUNCH);
  const RESERVES = { sol: 20_000_000_000n, tokens: 700_000_000_000_000n };

  /** A graduated pool on the chain, and the page's verified copy of it (read now). */
  async function poolSetup(o: { status?: number; openTime?: bigint; clock?: bigint | null } = {}) {
    const s = await setup();
    addLaunchPool(s.chain, MINT, { ...RESERVES, status: o.status, openTime: o.openTime });
    setClock(s.chain, o.clock === undefined ? 1_000n : o.clock);
    const r = await readPoolAt(s.chain, CPSWAP, POOL);
    if (r.kind !== 'ok') throw new Error('pool fixture');
    const lp: LaunchPool = { address: POOL, snapshot: r.value, ammConfigAddress: AMM_CONFIG, ammConfig: s.gate.ammConfig, chainTime: 1_000n };
    s.chain.calls = [];
    return { ...s, lp };
  }

  it('buy: wraps, swaps, and closes a WSOL account it created; output is the signer’s own token account', async () => {
    const { chain, gate, lp } = await poolSetup();
    const WSOL_ATA = associatedTokenAddress(WSOL_MINT, ME);
    simulating(chain, {
      [ME.toBase58()]: { lamportsDelta: -(100_000_000 + TOKEN_RENT) },
      [ATA.toBase58()]: { tokenAmount: quoteOwnPool(lp.snapshot, gate.ammConfig, WSOL_MINT.toBase58(), 100_000_000n)!.outAmount, mint: MINT, owner: ME },
      [WSOL_ATA.toBase58()]: { closed: true },
    });
    const p = ok(await preparePoolSwap(W(chain), gate, { owner: ME, mint: MINT, pool: lp, side: 'buy', amountIn: 100_000_000n, slippageBps: 100n }));
    expect(p.steps.map((s) => s.kind)).toEqual([
      'compute-limit', 'compute-price', 'create-token-account', 'wrap-sol', 'sync-wsol', 'create-token-account', 'pool-swap', 'close-wsol',
    ]);
    expect(p.summary).toMatchObject({ kind: 'pool-buy', unwrapsWsol: true, pool: POOL });
  });

  it('sell: does NOT unwrap a WSOL account that already held wrapped SOL', async () => {
    const { chain, gate, lp } = await poolSetup();
    const WSOL_ATA = associatedTokenAddress(WSOL_MINT, ME);
    chain.tokenAccount(WSOL_ATA, WSOL_MINT, ME, 5n);
    chain.tokenAccount(ATA, MINT, ME, 10_000_000_000n);
    simulating(chain, {
      [ATA.toBase58()]: { tokenAmount: 0n, mint: MINT, owner: ME },
      [WSOL_ATA.toBase58()]: { tokenAmount: 5n + quoteOwnPool(lp.snapshot, gate.ammConfig, MINT.toBase58(), 10_000_000_000n)!.outAmount, mint: WSOL_MINT, owner: ME },
    });
    const p = ok(await preparePoolSwap(W(chain), gate, { owner: ME, mint: MINT, pool: lp, side: 'sell', amountIn: 10_000_000_000n, slippageBps: 100n }));
    expect(p.summary).toMatchObject({ kind: 'pool-sell', unwrapsWsol: false });
    expect(p.steps.some((s) => s.kind === 'close-wsol')).toBe(false);
  });

  it('the pool opens by the CHAIN clock: not open yet by the chain = nothing built; unknown clock with a future open = refused', async () => {
    const early = await poolSetup({ openTime: 1_001n });
    let r = await preparePoolSwap(W(early.chain), early.gate, { owner: ME, mint: MINT, pool: early.lp, side: 'buy', amountIn: 1_000n, slippageBps: 100n });
    expect(!r.ok && r.outcome.message).toMatch(/cannot price/);
    const noClock = await poolSetup({ openTime: 1_001n, clock: null });
    r = await preparePoolSwap(W(noClock.chain), noClock.gate, { owner: ME, mint: MINT, pool: noClock.lp, side: 'buy', amountIn: 1_000n, slippageBps: 100n });
    expect(!r.ok && r.outcome.message).toMatch(/network clock/);
    expect(early.chain.simulateCalls).toHaveLength(0);
    expect(noClock.chain.simulateCalls).toHaveLength(0);
  });

  it('a pool closed to swaps cannot be quoted, so nothing is built', async () => {
    const { chain, gate, lp } = await poolSetup({ status: 4 });
    const r = await preparePoolSwap(W(chain), gate, { owner: ME, mint: MINT, pool: lp, side: 'buy', amountIn: 1_000n, slippageBps: 100n });
    expect(!r.ok && r.outcome.message).toMatch(/cannot price/);
  });

  // F1: the page's copy of the pool is from page load. The quote, and the minimum
  // built from it, must come from the pool as the chain has it now.
  it('quotes from the pool as it is NOW, not from the copy the page loaded', async () => {
    const { chain, gate, lp } = await poolSetup();
    // Someone sold into the pool after the page loaded: more tokens per SOL now.
    addLaunchPool(chain, MINT, { sol: RESERVES.sol / 2n, tokens: RESERVES.tokens * 2n });
    const now = await readPoolAt(chain, CPSWAP, POOL);
    if (now.kind !== 'ok') throw new Error('pool');
    const fresh = quoteOwnPool(now.value, gate.ammConfig, WSOL_MINT.toBase58(), 100_000_000n)!.outAmount;
    const stale = quoteOwnPool(lp.snapshot, gate.ammConfig, WSOL_MINT.toBase58(), 100_000_000n)!.outAmount;
    expect(fresh).toBeGreaterThan(stale * 3n);
    simulating(chain, {
      [ME.toBase58()]: { lamportsDelta: -(100_000_000 + TOKEN_RENT) },
      [ATA.toBase58()]: { tokenAmount: fresh, mint: MINT, owner: ME },
      [associatedTokenAddress(WSOL_MINT, ME).toBase58()]: { closed: true },
    });
    const p = ok(await preparePoolSwap(W(chain), gate, { owner: ME, mint: MINT, pool: lp, side: 'buy', amountIn: 100_000_000n, slippageBps: 100n }));
    if (p.summary.kind !== 'pool-buy') throw new Error('kind');
    expect(p.summary.minimumAmountOut).toBe((fresh * 9_900n) / 10_000n);
  });

  it('a pool that no longer matches the verified copy is refused', async () => {
    const { chain, gate, lp } = await poolSetup();
    addLaunchPool(chain, MINT, { ...RESERVES, ammConfig: Keypair.generate().publicKey });
    const r = await preparePoolSwap(W(chain), gate, { owner: ME, mint: MINT, pool: lp, side: 'buy', amountIn: 1_000n, slippageBps: 100n });
    expect(!r.ok && r.outcome.message).toMatch(/no longer matches/);
    expect(chain.simulateCalls).toHaveLength(0);
  });

  // F4: the operator may change global.amm_config for FUTURE graduations. A pool
  // keeps its own for life, and cp-swap accepts only that one.
  it('names the POOL’s own fee settings, even after global.amm_config has changed', async () => {
    const { chain, gate, lp } = await poolSetup();
    const moved: OpenGate = { ...gate, global: { ...gate.global, ammConfig: Keypair.generate().publicKey } };
    simulating(chain, {
      [ME.toBase58()]: { lamportsDelta: -(100_000_000 + TOKEN_RENT) },
      [ATA.toBase58()]: { tokenAmount: quoteOwnPool(lp.snapshot, gate.ammConfig, WSOL_MINT.toBase58(), 100_000_000n)!.outAmount, mint: MINT, owner: ME },
      [associatedTokenAddress(WSOL_MINT, ME).toBase58()]: { closed: true },
    });
    const p = ok(await preparePoolSwap(W(chain), moved, { owner: ME, mint: MINT, pool: lp, side: 'buy', amountIn: 100_000_000n, slippageBps: 100n }));
    const swap = p.tx.instructions.find((ix) => ix.programId.equals(CPSWAP))!;
    expect(swap.keys[2]!.pubkey.equals(AMM_CONFIG)).toBe(true);
  });
});

// F3: an impact that could not be computed came back as 0n and showed as "0.00%".
describe('priceImpactBps', () => {
  const k = Keypair.generate().publicKey;
  it('is null, never 0, when the curve gives no price to measure against', () => {
    const c = freshCurve(k, k);
    expect(priceImpactBps({ ...c, virtualSolReserves: 0n, realSolReserves: 0n }, 'buy', 1_000n, 1n)).toBeNull();
    expect(priceImpactBps({ ...c, virtualSolReserves: 2n ** 64n }, 'sell', 1_000n, 1n)).toBeNull();
  });
  it('is a real number for a real trade', () => {
    const c = freshCurve(k, k);
    const q = quoteBuyOnCurve(c, 5_000_000_000n);
    if (!q.ok) throw new Error('quote');
    const bps = priceImpactBps(c, 'buy', q.value.lamportsToCurve, q.value.tokensOut);
    expect(bps).not.toBeNull();
    expect(bps!).toBeGreaterThan(0n);
  });
});
