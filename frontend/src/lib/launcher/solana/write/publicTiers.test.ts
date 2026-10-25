// @vitest-environment node
//
// Two public fee tiers (owner, 2026-10-18): tier 1 at 1% a trade and tier 2 at 0.25%,
// beside the launch tier 0 this site never opens on. An opener picks one; every reader
// takes either; tier 0 and any index outside the list stay refused; a tier is offered
// only once its account is read on chain, so a failed read never offers it.
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import {
  PUBLIC_TIER_INDICES,
  REGISTERED_PROGRAM_ID,
  deriveAmmConfig,
  derivePool,
  isPublicTierIndex,
  publicTierConfig,
  sortMints,
} from '../../../solana/cpswap/program';
import { initializeIx } from '../../../solana/cpswap/ix';
import { SOL_QUOTE } from '../../../solana/lp/quotes';
import { USDC_MINT } from '../../../solana/lp/tokenSafety';
import { CP_CREATE_POOL_FEE_RECEIVER, readCreateFacts, tierStateOf, type GateRpc } from './config';
import { CREATE_COPY, createPins, prepareLpCreate, readCreateSnapshot, type CreateSnapshot, type LpCreateArgs } from './createPool';
import { decodeIntent } from './intent';
import type { LpPrepareReads } from './liquidity';
import { CPSWAP, FakeChain, TIER1_VALUES, TIER2_VALUES, cfgLocal, createSimulator, encodeAmmConfig } from './testkit.fixture';
import type { CreateFacts, LpCreateSummary, LpOpenGate, PoolIntent, PoolPins, PreparedTx, TierTerms, WriteRpc } from './types';

const ME = Keypair.generate().publicKey;
const OPEN: LpOpenGate = { kind: 'open', cfg: cfgLocal, mode: 'on' };
const TIER0 = deriveAmmConfig(CPSWAP, 0);
const TIER1 = deriveAmmConfig(CPSWAP, 1);
const TIER2 = deriveAmmConfig(CPSWAP, 2);
const CP = CPSWAP.toBase58();
const SOL = 1_000_000_000n;
const TOKENS = 100_000_000n;
const priced: LpPrepareReads = { outsidePrice: async () => ({ kind: 'ok', solPerToken: 0.01, source: 'Jupiter' }) };
const termsOf = (v: typeof TIER1_VALUES): TierTerms => ({
  createPoolFee: v.createPoolFee,
  tradeFeeRate: v.tradeFeeRate,
  protocolFeeRate: v.protocolFeeRate,
  fundFeeRate: v.fundFeeRate,
  creatorFeeRate: v.creatorFeeRate,
});
const acc = (owner: PublicKey | string, data: Uint8Array) => ({ owner: typeof owner === 'string' ? owner : owner.toBase58(), data });

describe('the public tiers are a list, derived from their indices', () => {
  it('tiers 1 and 2, in offer order; on mainnet 2 is 4UjFf1iU…; 0 and 3 are not public', () => {
    expect([...PUBLIC_TIER_INDICES]).toEqual([1, 2]);
    expect(publicTierConfig(REGISTERED_PROGRAM_ID, 1).toBase58()).toBe('CapqvAA9HvERTwzmE26xrtFhMaNcaXXoQUADpBWqWjKy');
    expect(publicTierConfig(REGISTERED_PROGRAM_ID, 2).toBase58()).toBe('4UjFf1iU27SqyJfDif6Ra9YcgPYDjv6ehs9V7YaSUbb8');
    expect([0, 1, 2, 3].map(isPublicTierIndex)).toEqual([false, true, true, false]);
  });
});

describe('tierStateOf, by index', () => {
  it('tier 2 with the owner’s values reads ready, carrying its index', () => {
    const s = tierStateOf(2, acc(CP, encodeAmmConfig(TIER2_VALUES)), CPSWAP);
    expect(s).toMatchObject({ kind: 'ready', index: 2, address: TIER2, config: { index: 2, tradeFeeRate: 2_500n, protocolFeeRate: 160_000n, createPoolFee: 150_000_000n } });
  });

  it('tier 1’s bytes at tier 2’s address are not tier 2; no account is not open, with the index', () => {
    expect(tierStateOf(2, acc(CP, encodeAmmConfig(TIER1_VALUES)), CPSWAP)).toMatchObject({ kind: 'not-a-tier', index: 2, detail: 'it is fee tier 1, not 2' });
    expect(tierStateOf(2, null, CPSWAP)).toEqual({ kind: 'not-open', index: 2, address: TIER2 });
    expect(tierStateOf(1, null, CPSWAP)).toEqual({ kind: 'not-open', index: 1, address: TIER1 });
  });
});

/** A chain with the fee account and whichever tiers `o` names; tier 2's read can be made to fail. */
function chainWith(o: { tier1?: boolean; tier2?: boolean; failTier2?: boolean } = {}): FakeChain & { calls: string[] } {
  const c = FakeChain.healthy().addFeeReceiver();
  if (o.tier1 ?? true) c.addTier1();
  if (o.tier2 ?? true) c.addTier2();
  if (o.failTier2) {
    const base = c.getAccountInfo.bind(c);
    c.getAccountInfo = (async (address: PublicKey) => {
      if (address.equals(TIER2)) throw new Error('HTTP 429');
      return base(address);
    }) as typeof c.getAccountInfo;
  }
  return c;
}

describe('readCreateFacts reads every public tier beside the fee account', () => {
  it('both tiers there: two ready states, in offer order, and the fee account, in one round', async () => {
    const c = chainWith();
    const f: CreateFacts = await readCreateFacts(c as GateRpc, cfgLocal);
    expect(f.tiers.map((t) => [t.kind, t.index])).toEqual([
      ['ready', 1],
      ['ready', 2],
    ]);
    expect(f.feeAccount).toEqual({ kind: 'ready' });
    expect(c.calls).toEqual(['getAccountInfo', 'getAccountInfo', 'getAccountInfo']);
  });

  it('mainnet before the Squads step executes: tier 1 ready, tier 2 not open', async () => {
    const f = await readCreateFacts(chainWith({ tier2: false }) as GateRpc, cfgLocal);
    expect(f.tiers).toMatchObject([{ kind: 'ready', index: 1 }, { kind: 'not-open', index: 2, address: TIER2 }]);
  });

  it('a read of tier 2 that fails is unread for tier 2 alone; tier 1 and the fee account still read', async () => {
    const f = await readCreateFacts(chainWith({ failTier2: true }) as GateRpc, cfgLocal);
    expect(f.tiers).toMatchObject([{ kind: 'ready', index: 1 }, { kind: 'unread', index: 2, detail: expect.stringMatching(/HTTP 429/) }]);
    expect(f.feeAccount).toEqual({ kind: 'ready' });
  });
});

interface World { chain: FakeChain; mint: PublicKey; token0: PublicKey; token1: PublicKey }

/** A new token paired with SOL; `usdc`: USDC as the token, the one pair tier 2 is offered (owner, 2026-10-24). */
function world(o: { tier2?: boolean; usdc?: boolean } = {}): World {
  const chain = chainWith({ tier2: o.tier2 ?? true });
  chain.simulate = createSimulator();
  const mint = o.usdc ? new PublicKey(USDC_MINT) : Keypair.generate().publicKey;
  chain.mint(mint, { decimals: 6 });
  chain.fund(ME, Number(20n * SOL));
  chain.tokenAccount(associatedTokenAddress(mint, ME, TOKEN_PROGRAM_ID), mint, ME, 1_000n * 10n ** 6n, {});
  const { token0, token1 } = sortMints(WSOL_MINT, mint);
  return { chain, mint, token0, token1 };
}

const args = (w: World, tier: number, shown: TierTerms): LpCreateArgs => ({
  owner: ME,
  tokenMint: w.mint,
  quoteMint: WSOL_MINT,
  quote: SOL,
  token: TOKENS,
  tier,
  shown: { terms: shown, standard: 'empty' },
});

const create = (w: World, tier: number, shown: TierTerms = termsOf(tier === 2 ? TIER2_VALUES : TIER1_VALUES)) =>
  prepareLpCreate(w.chain as unknown as WriteRpc, OPEN, priced, args(w, tier, shown));

function ok(r: Awaited<ReturnType<typeof create>>): PreparedTx {
  if (!r.ok) throw new Error(`expected a prepared transaction, got: ${r.outcome.message}`);
  return r.prepared;
}

function refused(r: Awaited<ReturnType<typeof create>>): string {
  if (r.ok) throw new Error('expected a refusal, but it prepared');
  return r.outcome.message;
}

describe('prepareLpCreate on the tier the opener chose', () => {
  it('tier 2: slot 1 is tier 2, the pool is tier 2’s standard address, and the summary carries tier 2’s terms', async () => {
    const w = world({ usdc: true });
    const p = ok(await create(w, 2));
    const s = p.summary as LpCreateSummary;
    const ix = p.tx.instructions.find((i) => i.programId.equals(CPSWAP))!;
    expect(ix.keys[1]!.pubkey.equals(TIER2)).toBe(true);
    expect(s.origin).toBe('standard');
    expect(s.pool.equals(derivePool(CPSWAP, TIER2, w.token0, w.token1))).toBe(true);
    expect(s.config).toMatchObject({ index: 2, tradeFeeRate: 2_500n, createPoolFee: 150_000_000n });
    expect(p.steps.find((x) => x.kind === 'pool-create')).toMatchObject({ ammConfig: TIER2 });
  });

  it('tier 1 still opens as it always did: slot 1 is tier 1, at tier 1’s standard address', async () => {
    const w = world();
    const p = ok(await create(w, 1));
    const s = p.summary as LpCreateSummary;
    expect(p.tx.instructions.find((i) => i.programId.equals(CPSWAP))!.keys[1]!.pubkey.equals(TIER1)).toBe(true);
    expect(s.pool.equals(derivePool(CPSWAP, TIER1, w.token0, w.token1))).toBe(true);
    expect(s.config.index).toBe(1);
  });

  it('the two tiers have different standard addresses for the same pair: a tier-1 pool does not take tier 2’s address', async () => {
    const w = world({ usdc: true });
    expect(derivePool(CPSWAP, TIER1, w.token0, w.token1).equals(derivePool(CPSWAP, TIER2, w.token0, w.token1))).toBe(false);
    ok(await create(w, 1));
    // Nothing was sent, so nothing sits at either address; prepare on tier 2 still lands at its own standard address.
    expect((ok(await create(w, 2)).summary as LpCreateSummary).origin).toBe('standard');
  });

  it('the launch tier (0) and an index outside the list (3) are refused before anything is read', async () => {
    const w = world();
    const calls = w.chain.calls.length;
    expect(refused(await create(w, 0))).toBe(CREATE_COPY.notAPublicTier(0));
    expect(refused(await create(w, 3))).toBe(CREATE_COPY.notAPublicTier(3));
    expect(w.chain.calls.length).toBe(calls);
  });

  it('tier 2 chosen while its account is not on chain: refused as not open, naming tier 2', async () => {
    expect(refused(await create(world({ tier2: false }), 2))).toBe(CREATE_COPY.tierNotOpen(2));
  });

  it('tier 2’s terms shown as tier 1’s: refused as changed terms (the chosen tier is what is re-read)', async () => {
    expect(refused(await create(world({ usdc: true }), 2, termsOf(TIER1_VALUES)))).toBe(CREATE_COPY.termsChanged('trade fee 1% → 0.25%'));
  });

  it('tier 2 for any pair but SOL against USDC: refused by its rate as just read, and nothing is built (owner, 2026-10-24)', async () => {
    const w = world();
    expect(refused(await create(w, 2))).toBe(CREATE_COPY.tierNotForPair('0.25%'));
    expect(CREATE_COPY.tierNotForPair('0.25%')).toBe('The 0.25% fee tier is for SOL against USDC only, so this site does not open this pool on it. Nothing was built.');
    // The same token on tier 1 opens.
    ok(await create(w, 1));
  });

  it('the single read is of the CHOSEN tier and that tier’s standard address', async () => {
    const w = world();
    const fresh = Keypair.generate().publicKey;
    const snap = (await readCreateSnapshot(w.chain as unknown as WriteRpc, cfgLocal, { tokenMint: w.mint, owner: ME, fresh, quote: SOL_QUOTE, tier: 2 })) as CreateSnapshot;
    expect(snap.standard.address.equals(derivePool(CPSWAP, TIER2, w.token0, w.token1))).toBe(true);
    expect(snap.tier?.data).toEqual(encodeAmmConfig(TIER2_VALUES));
  });
});

describe('the decoder: an opening may name either public tier, and nothing else', () => {
  const pinsOn = (tier: 1 | 2, tokenMint = Keypair.generate().publicKey): PoolPins => {
    const { token0, token1 } = sortMints(WSOL_MINT, tokenMint);
    const p = createPins(cfgLocal, { address: derivePool(CPSWAP, publicTierConfig(CPSWAP, tier), token0, token1), tokenMint, tokenProgram: TOKEN_PROGRAM_ID, signer: ME, quote: SOL_QUOTE, tier });
    if (typeof p === 'string') throw new Error(p);
    return p;
  };
  const ctx = (pins: PoolPins): PoolIntent => ({ kind: 'lp-create', signer: ME, cfg: cfgLocal, maxPriorityLamports: 1_000_000n, pins });
  const opening = (p: PoolPins, ammConfig: PublicKey = p.ammConfig) =>
    initializeIx({
      programId: CPSWAP,
      creator: ME,
      ammConfig,
      token0Mint: p.token0Mint,
      token1Mint: p.token1Mint,
      creatorToken0: associatedTokenAddress(p.token0Mint, ME, p.token0Program),
      creatorToken1: associatedTokenAddress(p.token1Mint, ME, p.token1Program),
      creatorLpToken: p.lpAccount,
      token0Program: p.token0Program,
      token1Program: p.token1Program,
      createPoolFee: CP_CREATE_POOL_FEE_RECEIVER,
      initAmount0: SOL,
      initAmount1: 5n * SOL,
      openTime: 0n,
    });

  it('tier 2 pins decode to a pool-create on tier 2, at tier 2’s standard address', () => {
    const p = pinsOn(2);
    expect(p.ammConfig.equals(TIER2) && p.origin === 'standard').toBe(true);
    const r = decodeIntent([opening(p)], ctx(p));
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
    if (r.ok) expect(r.steps.find((s) => s.kind === 'pool-create')).toMatchObject({ ammConfig: TIER2, pool: p.address });
  });

  it('the instruction names tier 1 while the pins say tier 2 (or the other way round): refused', () => {
    const two = pinsOn(2);
    const r1 = decodeIntent([opening(two, TIER1)], ctx(two));
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toMatch(/fee tier this site does not use/);
    const one = pinsOn(1);
    const r2 = decodeIntent([opening(one, TIER2)], ctx(one));
    expect(r2.ok).toBe(false);
  });

  it('pins that name the launch tier are refused by name, and pins naming tier 3 as a tier this site does not use', () => {
    const p = pinsOn(1);
    const onZero: PoolPins = { ...p, ammConfig: TIER0 };
    const r0 = decodeIntent([opening(onZero)], ctx(onZero));
    expect(r0.ok).toBe(false);
    if (!r0.ok) expect(r0.reason).toMatch(/launch tier \(fee tier 0\)/);
    const three = deriveAmmConfig(CPSWAP, 3);
    const onThree: PoolPins = { ...p, ammConfig: three };
    const r3 = decodeIntent([opening(onThree)], ctx(onThree));
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.reason).toMatch(/fee tier this site does not use/);
  });

  it("origin 'standard' is judged against the pinned tier's own standard address", () => {
    const two = pinsOn(2);
    // Tier 1's standard address for the same pair, claimed as tier 2's standard: a lie.
    const { token0, token1 } = sortMints(WSOL_MINT, two.tokenMint);
    const lie: PoolPins = { ...two, address: derivePool(CPSWAP, TIER1, token0, token1) };
    const r = decodeIntent([opening(lie)], ctx(lie));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/does not match the review/);
  });
});
