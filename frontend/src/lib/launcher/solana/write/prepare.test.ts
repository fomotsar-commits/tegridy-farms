// @vitest-environment node
//
// Every prepare* function against a fake chain whose simulation we control. What is
// pinned: the simulate-first rule (a failed simulation never reaches a wallet, and
// says why in the failing program's own words), the balance check (a simulation
// that drains more than the screen says is BLOCKED), the compute limit and capped
// priority fee, and that the summary equals what the bytes encode.
import { describe, it, expect } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { WSOL_MINT, globalPda, poolStatePda } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { quoteBuyOnCurve, quoteSellOnCurve } from '../curve/math';
import { readCurve, type CurveAccount } from '../curve/read';
import { quoteOwnPool, readPoolAt } from '../../../solana/cpswap/read';
import type { LaunchPool } from '../discover/pool';
import { MAX_OWN_PRIORITY_LAMPORTS } from './budget';
import { CP_CREATE_POOL_FEE_RECEIVER, launchIndexAddress, readWriteGate } from './config';
import { prepareMigrate, prepareRelease } from './graduate';
import { LAUNCH_TERMS_CHANGED, prepareCreateLaunch, quoteOpeningBuy } from './launch';
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
  encodeGlobal,
  cfgLocal,
  freshCurve,
  globalValue,
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
  const worst = { name: 'N'.repeat(32), symbol: 'S'.repeat(10), uri: `https://ipfs.io/ipfs/${'b'.repeat(79)}` };

  it('one transaction, mint signs too, opening buy minimum = the quote EXACTLY, launch index trailing', async () => {
    const { chain, gate } = await setup();
    const mintKp = Keypair.generate();
    const lamportsIn = 50_000_000n;
    const q = quoteOpeningBuy(gate.global, lamportsIn);
    if (!q.ok) throw new Error('quote');
    const creatorAta = associatedTokenAddress(mintKp.publicKey, ME);
    const metadataRent = rent(607);
    simulating(chain, {
      [ME.toBase58()]: { lamportsDelta: -(rent(82) + rent(179) + TOKEN_RENT + metadataRent + Number(lamportsIn) + TOKEN_RENT) },
      [creatorAta.toBase58()]: { tokenAmount: q.value.tokensOut, mint: mintKp.publicKey, owner: ME },
    }, 120_000);
    const p = ok(await prepareCreateLaunch(W(chain), gate, { creator: ME, mint: mintKp, metadata: worst, openingBuy: { lamportsIn } }));
    expect(p.extraSigners).toEqual([mintKp]);
    expect(p.summary.kind).toBe('create');
    if (p.summary.kind !== 'create') return;
    expect(p.summary.openingBuy?.minTokensOut).toBe(q.value.tokensOut);
    expect(p.summary.name).toBe(worst.name);
    const launchIx = p.tx.instructions.find((i) => i.programId.equals(LAUNCH) && i.keys.length === 9);
    expect(launchIx?.keys[8]?.pubkey.equals(launchIndexAddress(LAUNCH))).toBe(true);
  });

  it('worst-case inputs leave at least 150 bytes for a wallet’s own guard instructions', async () => {
    const { chain, gate } = await setup();
    const mintKp = Keypair.generate();
    const q = quoteOpeningBuy(gate.global, 50_000_000n);
    if (!q.ok) throw new Error('quote');
    simulating(chain, {
      [ME.toBase58()]: { lamportsDelta: -(rent(82) + rent(179) + 2 * TOKEN_RENT + rent(607) + 50_000_000) },
      [associatedTokenAddress(mintKp.publicKey, ME).toBase58()]: { tokenAmount: q.value.tokensOut, mint: mintKp.publicKey, owner: ME },
    });
    const p = ok(await prepareCreateLaunch(W(chain), gate, { creator: ME, mint: mintKp, metadata: worst, openingBuy: { lamportsIn: 50_000_000n } }));
    // Recorded for the report: the measured worst case.
    process.stdout.write(`[size] worst-case create with opening buy: ${p.sizeBytes} of ${TX_SIZE_LIMIT} bytes\n`);
    expect(TX_SIZE_LIMIT - p.sizeBytes).toBeGreaterThanOrEqual(150);
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
  // would launch the creator on terms the page never showed.
  it('re-reads the launch terms: changed since the page loaded = refused, nothing simulated', async () => {
    for (const change of [
      { tradeFeeBps: 200n },
      { creatorFeeShareBps: 1_000n },
      { platformReserveBps: 900n },
      { graduationTargetLamports: 1n },
      { migrationReserveLamports: 1n },
      { initialVirtualSol: 1n },
      { initialVirtualToken: 1n },
    ]) {
      const { chain, gate } = await setup();
      chain.set(globalPda(LAUNCH), { lamports: rent(202), owner: LAUNCH, data: encodeGlobal(globalValue(change)) });
      simulating(chain, { [ME.toBase58()]: { lamportsDelta: -(rent(82) + rent(179) + TOKEN_RENT + rent(607)) } });
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
    simulating(chain, { [ME.toBase58()]: { lamportsDelta: -(rent(82) + rent(179) + TOKEN_RENT + rent(607)) } });
    ok(await prepareCreateLaunch(W(chain), gate, { creator: ME, mint: Keypair.generate(), metadata: worst }));
  });
});

describe('graduate and release', () => {
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

  it('release: only after graduation, only once', async () => {
    const c = freshCurve(MINT, CREATOR);
    const done = { ...c, complete: true, pool: poolStatePda(MINT, LAUNCH) };
    const { chain, gate, curve } = await setup({ curve: done });
    simulating(chain, { [ME.toBase58()]: { lamportsDelta: -TOKEN_RENT } });
    const p = ok(await prepareRelease(W(chain), gate, { payer: ME, mint: MINT, curve }));
    expect(p.summary).toEqual({ kind: 'release', mint: MINT, amount: c.platformReserveTokens, recipient: VAULT });
    const released = await setup({ curve: { ...done, platformReserveReleased: true } });
    const r = await prepareRelease(W(released.chain), released.gate, { payer: ME, mint: MINT, curve: released.curve });
    expect(!r.ok && r.outcome.message).toMatch(/already been released/);
    const open = await setup();
    const r2 = await prepareRelease(W(open.chain), open.gate, { payer: ME, mint: MINT, curve: open.curve });
    expect(!r2.ok && r2.outcome.message).toMatch(/only be released after/);
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

  it('release charges the treasury account rent only when that account does not exist yet', async () => {
    const c = freshCurve(MINT, CREATOR);
    const done = { ...c, complete: true, pool: poolStatePda(MINT, LAUNCH) };
    const absent = await setup({ curve: done });
    simulating(absent.chain, { [ME.toBase58()]: { lamportsDelta: -TOKEN_RENT } });
    const p1 = ok(await prepareRelease(W(absent.chain), absent.gate, { payer: ME, mint: MINT, curve: absent.curve }));
    expect(p1.fees.newAccountRentLamports).toBe(BigInt(TOKEN_RENT));

    const present = await setup({ curve: done });
    present.chain.tokenAccount(associatedTokenAddress(MINT, VAULT), MINT, VAULT, 0n);
    simulating(present.chain, { [ME.toBase58()]: { lamportsDelta: 0 } });
    const p2 = ok(await prepareRelease(W(present.chain), present.gate, { payer: ME, mint: MINT, curve: present.curve }));
    expect(p2.fees.newAccountRentLamports).toBe(0n);

    const unread = await setup({ curve: done });
    unread.chain.getAccountInfo = async () => {
      throw new Error('HTTP 429');
    };
    const r = await prepareRelease(W(unread.chain), unread.gate, { payer: ME, mint: MINT, curve: unread.curve });
    expect(!r.ok && r.outcome.stage).toBe('build');
    expect(unread.chain.simulateCalls).toHaveLength(0);
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
