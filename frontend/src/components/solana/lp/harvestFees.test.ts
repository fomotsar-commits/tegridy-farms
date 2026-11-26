// Harvest's pool fees: which island pool shares it claims, what it says of the rest, and that a
// claim is sent the way the Pools panel sends it (built fresh, signed once, noted while it may land).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import type { SignerWalletAdapter } from '@solana/wallet-adapter-base';
import { buildPool, key } from '../../../lib/solana/lp/testkit.fixture';
import { decodeAmmConfig, decodePoolState } from '../../../lib/solana/cpswap/program';
import { SOL_QUOTE } from '../../../lib/solana/lp/quotes';
import { isqrt } from '../../../lib/solana/lp/liquidityMath';
import { claimSentOn, forgetClaimsSent, noteClaimSent } from '../../../lib/solana/lp/claimed';
import type { LedgerFigures, LedgerRead } from '../../../lib/solana/lp/ledger';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import type { Position } from '../../../lib/solana/lp/positions';
import type { TokenSafety } from '../../../lib/solana/lp/tokenSafety';
import { DECLINED_IN_WALLET } from '../../../lib/solana/swap/walletCopy';
import type { LpGate, PreparedTx, TxOutcome, TxSigner, WriteRpc } from '../curve/ports';
import { LP_PENDING_SCOPE, clearPendingTrade, readPendingTrades, savePendingTrade, type PendingTrade } from '../curve/pendingTrade';
import { LP_PROGRAM, lpOpenGate } from './fakeLpWriteApi.fixture';
import { feeClaimResult, islandRooms, readFeeHarvest, sendFeeClaim, txSignerOf, type FeeApi, type FeeReads } from './harvestFees';

const BAYLA = islandRooms().find((r) => r.id === 'bayla')!;
const OWNER = key();
const SIG = '5'.repeat(88);
const HELD = 250_000n;
const PREPARED = { kind: 'lp-withdraw' } as unknown as PreparedTx;
const RPC = {} as WriteRpc;

/** A SOL pool of `mint` holding 10 SOL and 1,000 of the token (6 decimals) against 1,000,000 shares. */
function poolView(o: { mint?: PublicKey; history?: PoolView['history'] } = {}): PoolView {
  const s = 10n * 10n ** 9n;
  const t = 1_000n * 10n ** 6n;
  const mint = o.mint ?? new PublicKey(BAYLA.address);
  const b = buildPool({ plain: true, mint, configIndex: 1, quoteReserve: s, tokenReserve: t, openTime: 1n });
  const pool = decodePoolState(b.address.toBase58(), b.accounts[b.address.toBase58()]!.data)!;
  const config = decodeAmmConfig(b.config.toBase58(), b.accounts[b.config.toBase58()]!.data);
  const quoteIsToken0 = pool.token0Mint.startsWith('So111');
  return {
    address: b.address.toBase58(),
    origin: 'other',
    snapshot: { pool, vault0Amount: quoteIsToken0 ? s : t, vault1Amount: quoteIsToken0 ? t : s, reserve0: quoteIsToken0 ? s : t, reserve1: quoteIsToken0 ? t : s },
    config,
    tokenMint: mint.toBase58(),
    quote: SOL_QUOTE,
    quoteIsToken0,
    quoteReserve: s,
    tokenReserve: t,
    vaultsFrozen: false,
    launchTierWithoutLaunch: false,
    history: o.history ?? { kind: 'not-read' },
  };
}

function position(v: PoolView, over: Partial<Position> = {}): Position {
  return {
    lpMint: v.snapshot.pool.lpMint, lpAccount: key().toBase58(), lpAmount: HELD, placement: 'found', placementDetail: null,
    pool: { kind: 'pool', view: v }, value: { token0: 1n, token1: 2n, sharePct: 25 }, tooSmall: false, ...over,
  };
}

/** The liquidity HELD shares hold in `v` now, less 1%: deposits that bought 99% of it. */
const basisIn = (v: PoolView) => ((HELD * isqrt(v.snapshot.reserve0 * v.snapshot.reserve1)) / v.snapshot.pool.lpSupply) * 99n / 100n;

/** Figures that balance (case A), with 1% of the shares grown from fees: 2,500 of the 1,000,000. */
const ledgerOk = (v: PoolView, over: Partial<LedgerFigures> = {}, ledgerCase: 'A' | 'B' = 'A'): LedgerRead => ({
  kind: 'ok', case: ledgerCase, entries: [], window: { count: 1, oldest: 1_791_066_624, more: false },
  figures: {
    putIn: { token: 1_000n, coin: 1_000n, count: 1 }, takenOut: null, worthNow: { token: 1_010n, coin: 1_010n }, holdWorth: 2_000n, nowAndOutWorth: 2_020n,
    versusHolding: { kind: 'amount', coin: 20n }, growth: { kind: 'amount', coin: 20n }, priceEffect: { kind: 'none-yet' }, locked: null, since: 1_791_066_624,
    provenShares: HELD, otherShares: null, basis: basisIn(v), claimShares: HELD / 100n, ...over,
  },
});

const okSafety = (mint: string): TokenSafety => ({
  kind: 'read', mint, verdict: 'ok', blocks: [], warnings: [], name: 'Bayla', symbol: 'BAYLA', metadataSource: 'metaplex',
  facts: { program: 'spl-token', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
});

function fakeApi(outcome: TxOutcome | ((onSent?: (s: string, h: number) => void) => Promise<TxOutcome>) = { status: 'confirmed', signature: SIG, slot: 1 }) {
  return {
    prepareLpWithdraw: vi.fn(async () => ({ ok: true as const, prepared: PREPARED })),
    submitPrepared: vi.fn(async (_rpc: unknown, _signer: unknown, _p: unknown, deps?: { onSent?: (s: string, h: number) => void }) => {
      if (typeof outcome === 'function') return outcome(deps?.onSent);
      if (outcome.status !== 'not-sent') deps?.onSent?.(SIG, 1_234);
      return outcome;
    }),
  } satisfies FeeApi;
}

function fakeReads(o: {
  positions?: Position[];
  totalShares?: number;
  ledger?: LedgerRead | ((v: PoolView) => LedgerRead);
  gate?: LpGate;
  safety?: (mint: string) => TokenSafety;
  notes?: PendingTrade[];
  api?: FeeApi;
} = {}) {
  const positions = o.positions ?? [];
  const api = o.api ?? fakeApi();
  return {
    programId: LP_PROGRAM,
    mode: 'on' as const,
    positions: vi.fn(async () => ({ kind: 'ok' as const, positions, chainNow: 5n, totalShares: o.totalShares ?? positions.length })),
    safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, (o.safety ?? okSafety)(m)]))),
    ledger: vi.fn(async (_share: unknown, v: PoolView) => (typeof o.ledger === 'function' ? o.ledger(v) : (o.ledger ?? ledgerOk(v)))),
    writes: vi.fn(async () => ({ api, gate: o.gate ?? lpOpenGate() })),
    notes: () => o.notes ?? [],
    rpc: () => RPC,
  } satisfies FeeReads;
}

const adapter = { publicKey: OWNER, signTransaction: vi.fn() } as unknown as SignerWalletAdapter;

beforeEach(() => {
  forgetClaimsSent();
  clearPendingTrade(LP_PENDING_SCOPE);
});

describe('which pool shares Harvest claims the fees of', () => {
  it('a share of an island coin’s pool whose Pools row offers Claim fees: one claim, both coins, about', async () => {
    const v = poolView();
    const p = position(v);
    const plan = await readFeeHarvest(OWNER.toBase58(), fakeReads({ positions: [p] }));
    expect(plan.unread).toEqual([]);
    expect(plan.held).toEqual([]);
    expect(plan.claims).toHaveLength(1);
    const c = plan.claims[0]!;
    // 2,500 of 1,000,000 shares: a quarter of a percent of 1,000 BAYLA and of 10 SOL.
    expect(c).toMatchObject({
      key: `lp:${p.lpAccount}`, chain: 'solana', roomId: 'bayla', symbol: 'BAYLA', where: 'BAYLA/SOL pool', detail: 'fees your share earned',
      amountRaw: 2_500_000n, decimals: 6, also: { symbol: 'SOL', amountRaw: 25_000_000n, decimals: 9 }, about: true, caution: null,
    });
  });

  it('leaves out a share of a pool whose token is not an island coin, and loads no write code for it', async () => {
    const r = fakeReads({ positions: [position(poolView({ mint: key() }))] });
    const plan = await readFeeHarvest(OWNER.toBase58(), r);
    expect(plan).toEqual({ claims: [], held: [], unread: [] });
    expect(r.writes).not.toHaveBeenCalled();
    expect(r.ledger).not.toHaveBeenCalled();
  });

  it('names the shares as not read when the wallet’s shares could not be read, never as nothing', async () => {
    const r = fakeReads();
    r.positions.mockResolvedValue({ kind: 'unread', detail: 'rate limited' } as never);
    const plan = await readFeeHarvest(OWNER.toBase58(), r);
    expect(plan.unread).toEqual([{ key: 'lp', chain: 'solana', roomId: '', what: 'your pool shares', detail: 'rate limited' }]);
  });

  it('a share whose pool could not be looked up is not read, never nothing', async () => {
    const v = poolView();
    const plan = await readFeeHarvest(OWNER.toBase58(), fakeReads({ positions: [position(v, { placement: 'index-unread', pool: null })] }));
    expect(plan.unread.map((u) => u.what)).toEqual(['some of your pool shares']);
  });

  it('LP switched off: nothing, as Pools offers nothing; a gate that is shut is not read', async () => {
    const v = poolView();
    expect(await readFeeHarvest(OWNER.toBase58(), fakeReads({ positions: [position(v)], gate: { kind: 'off' } }))).toEqual({ claims: [], held: [], unread: [] });
    const shut = await readFeeHarvest(OWNER.toBase58(), fakeReads({ positions: [position(v)], gate: { kind: 'blocked', reason: 'unreadable', detail: 'the pool program could not be read' } }));
    expect(shut.claims).toEqual([]);
    expect(shut.unread.map((u) => u.detail)).toEqual(['the pool program could not be read']);
  });

  it('a gate open on another pool program than the one the shares were read from claims nothing', async () => {
    const v = poolView();
    const plan = await readFeeHarvest(OWNER.toBase58(), fakeReads({ positions: [position(v)], gate: lpOpenGate({ cfg: { ...lpOpenGate().cfg, cpSwapProgram: key() } }) }));
    expect(plan.claims).toEqual([]);
    expect(plan.unread).toHaveLength(1);
  });

  it('a token that could not be checked is never claimed against', async () => {
    const v = poolView();
    const plan = await readFeeHarvest(OWNER.toBase58(), fakeReads({ positions: [position(v)], safety: (mint) => ({ kind: 'unread', mint, detail: 'x' }) as unknown as TokenSafety }));
    expect(plan.claims).toEqual([]);
    expect(plan.unread.map((u) => u.what)).toEqual(['the fees on your BAYLA/SOL pool share']);
  });

  it('a withdrawal from that pool still waiting for its answer holds it, and no history is read', async () => {
    const v = poolView();
    const r = fakeReads({ positions: [position(v)], notes: [{ kind: 'lp-withdraw', signature: SIG, lastValidBlockHeight: 1, sentAt: 1, pool: v.address }] });
    const plan = await readFeeHarvest(OWNER.toBase58(), r);
    expect(plan.claims).toEqual([]);
    expect(r.ledger).not.toHaveBeenCalled();
  });

  it('a pool no trade has reached has no fees: no history is read', async () => {
    const v = poolView({ history: { kind: 'ok', obs: { initialized: false } } as unknown as PoolView['history'] });
    const r = fakeReads({ positions: [position(v)] });
    expect((await readFeeHarvest(OWNER.toBase58(), r)).claims).toEqual([]);
    expect(r.ledger).not.toHaveBeenCalled();
  });

  it('a balance a claim was already sent on is not offered again, and no history is read', async () => {
    const v = poolView();
    const p = position(v);
    noteClaimSent(p.lpAccount, HELD);
    const r = fakeReads({ positions: [p] });
    expect((await readFeeHarvest(OWNER.toBase58(), r)).claims).toEqual([]);
    expect(r.ledger).not.toHaveBeenCalled();
  });

  it('a history that could not be read, or was paused, is not read; never nothing', async () => {
    const v = poolView();
    for (const [ledger, detail] of [
      [{ kind: 'unread', detail: 'timed out' }, 'timed out'],
      [{ kind: 'paused' }, 'the network is busy, so its history was not read just now'],
      [{ kind: 'worth-only', why: 'unread-entry', entries: [], window: { count: 1, oldest: null, more: false } }, 'one of its transactions could not be read just now'],
    ] as [LedgerRead, string][]) {
      const plan = await readFeeHarvest(OWNER.toBase58(), fakeReads({ positions: [position(v)], ledger }));
      expect(plan.claims).toEqual([]);
      expect(plan.unread.map((u) => u.detail)).toEqual([detail]);
    }
  });

  it('a history longer than one page is left alone, pointing to Pools', async () => {
    const v = poolView();
    const plan = await readFeeHarvest(OWNER.toBase58(), fakeReads({
      positions: [position(v)], ledger: { kind: 'worth-only', why: 'run-start-not-read', entries: [], window: { count: 20, oldest: null, more: true } },
    }));
    expect(plan.claims).toEqual([]);
    expect(plan.held).toHaveLength(1);
    expect(plan.held[0]).toMatchObject({ roomId: 'bayla', symbol: 'BAYLA', amountRaw: null, to: '/pools' });
  });

  it('claims nothing where the Pools row offers no claim: case B, no growth, no shares grown', async () => {
    const v = poolView();
    for (const ledger of [ledgerOk(v, {}, 'B'), ledgerOk(v, { growth: { kind: 'none-yet' } }), ledgerOk(v, { claimShares: 0n })]) {
      const plan = await readFeeHarvest(OWNER.toBase58(), fakeReads({ positions: [position(v)], ledger }));
      expect(plan).toEqual({ claims: [], held: [], unread: [] });
    }
  });
});

describe('a fee claim is sent as the Pools panel sends it', () => {
  const signer = { publicKey: OWNER, signTransaction: vi.fn() } as unknown as TxSigner;
  const send = (api: FeeApi, lpAccount = key().toBase58()) => {
    const v = poolView();
    const basis = { basis: basisIn(v), provenShares: HELD, heldAtRead: HELD };
    return { v, lpAccount, basis, run: () => sendFeeClaim({ api, rpc: RPC, gate: lpOpenGate(), signer, owner: OWNER, view: v, lpAccount, basis }) };
  };

  it('built at a fresh read with the claim’s basis, never a percent; claimed, noted, and its pending note cleared', async () => {
    const api = fakeApi();
    const s = send(api);
    expect(await s.run()).toEqual({ kind: 'claimed', tx: SIG });
    const args = (api.prepareLpWithdraw.mock.calls[0] as unknown as [unknown, unknown, Record<string, unknown>])[2];
    expect(args).toMatchObject({ claim: s.basis, slippageBps: 100n, txVersion: 'legacy' });
    expect(args.owner).toBe(OWNER);
    expect(args.pctBps).toBeUndefined();
    expect(claimSentOn(s.lpAccount, HELD)).toBe(true);
    expect(readPendingTrades(LP_PENDING_SCOPE)).toEqual([]);
  });

  it('a claim whose answer is unknown stops the run, and stays noted with its pending note', async () => {
    const s = send(fakeApi({ status: 'unknown', signature: SIG, message: 'No answer yet.' }));
    expect(await s.run()).toEqual({ kind: 'unconfirmed', reason: 'No answer yet.', tx: SIG, stop: true });
    expect(claimSentOn(s.lpAccount, HELD)).toBe(true);
    expect(readPendingTrades(LP_PENDING_SCOPE).map((n) => [n.kind, n.signature, n.pool])).toEqual([['lp-withdraw', SIG, s.v.address]]);
  });

  it('refused on chain: it may be made again, and its pending note goes', async () => {
    const s = send(fakeApi({ status: 'reverted', signature: SIG, program: 'cp-swap', code: 6000, message: 'The price moved.' }));
    expect(await s.run()).toEqual({ kind: 'reverted', reason: 'The price moved.', tx: SIG });
    expect(claimSentOn(s.lpAccount, HELD)).toBe(false);
    expect(readPendingTrades(LP_PENDING_SCOPE)).toEqual([]);
  });

  it('cancelled in the wallet: declined, nothing noted', async () => {
    const s = send(fakeApi({ status: 'not-sent', stage: 'sign', message: DECLINED_IN_WALLET }));
    expect(await s.run()).toEqual({ kind: 'declined' });
    expect(claimSentOn(s.lpAccount, HELD)).toBe(false);
  });

  it('a build the pool would refuse is never put to the wallet', async () => {
    const api = fakeApi();
    api.prepareLpWithdraw.mockResolvedValue({ ok: false, outcome: { status: 'not-sent', stage: 'simulate', message: 'The test run failed. Nothing was sent.' } } as never);
    const s = send(api);
    expect(await s.run()).toEqual({ kind: 'unconfirmed', reason: 'The test run failed. Nothing was sent.' });
    expect(api.submitPrepared).not.toHaveBeenCalled();
  });

  it('a throw after the signature was known is unknown, carries it, and stops the run', async () => {
    const s = send(fakeApi(async (onSent) => {
      onSent?.(SIG, 9);
      throw new Error('socket closed');
    }));
    const r = await s.run();
    expect(r).toMatchObject({ kind: 'unconfirmed', tx: SIG, stop: true });
    expect(claimSentOn(s.lpAccount, HELD)).toBe(true);
    expect(readPendingTrades(LP_PENDING_SCOPE)).toHaveLength(1);
  });

  it('through Harvest’s own claim: the connected wallet signs, and a wallet with no address sends nothing', async () => {
    const api = fakeApi();
    const v = poolView();
    const plan = await readFeeHarvest(OWNER.toBase58(), fakeReads({ positions: [position(v)], api }));
    expect(await plan.claims[0]!.send(adapter)).toEqual({ kind: 'claimed', tx: SIG });
    expect((api.submitPrepared.mock.calls[0] as unknown as [unknown, TxSigner])[1].publicKey).toBe(OWNER);
    expect(txSignerOf({ publicKey: null } as unknown as SignerWalletAdapter)).toBeNull();
    expect(await plan.claims[0]!.send({ publicKey: null } as unknown as SignerWalletAdapter)).toMatchObject({ kind: 'unconfirmed' });
  });
});

describe('feeClaimResult', () => {
  it('an expired claim never landed: not confirmed, with no transaction to link, and the run goes on', () => {
    expect(feeClaimResult({ status: 'expired', signature: SIG, message: 'It ran out of time.' })).toEqual({ kind: 'unconfirmed', reason: 'It ran out of time.' });
  });
  it('a refusal before sending that is not a cancel goes on to the next claim', () => {
    expect(feeClaimResult({ status: 'not-sent', stage: 'send', message: 'The network refused this. Nothing was sent.' })).toEqual({ kind: 'unconfirmed', reason: 'The network refused this. Nothing was sent.' });
  });
});

// A note left by another tab's withdrawal of a different pool holds nothing here.
it('a pending note for another pool does not hold this one', async () => {
  const v = poolView();
  savePendingTrade(LP_PENDING_SCOPE, { kind: 'lp-withdraw', signature: SIG, lastValidBlockHeight: 1, pool: key().toBase58() });
  const plan = await readFeeHarvest(OWNER.toBase58(), fakeReads({ positions: [position(v)], notes: readPendingTrades(LP_PENDING_SCOPE) }));
  expect(plan.claims).toHaveLength(1);
});
