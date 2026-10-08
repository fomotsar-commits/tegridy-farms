// @vitest-environment node
//
// Opening a pool on the public fee tier (SPEC_S2_CREATE 3.1-3.4), against a fake chain
// whose simulator runs cp-swap's `initialize` on its accounts. The point of most of
// these: every "no" in 3.1's order says so in its own words, the pool goes to the
// standard address only when nothing at all is there, the balance check lets nothing
// more leave than the review says (a fee one lamport above the one shown is blocked)
// while dust a stranger sends in cannot block it, and the one-off key is never written
// anywhere but the prepared transaction's signer list.
import { afterEach, describe, it, expect, vi } from 'vitest';
import { base58, hex } from '@scure/base';
import { NATIVE_MINT_2022 } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { formatTokenAmount } from '../curve/format';
import { deriveLpMint, deriveObservation, derivePool, deriveVault, publicTierConfig, sortMints } from '../../../solana/cpswap/program';
import { feeReserveFor, isqrt, spendableSol } from '../../../solana/lp/liquidityMath';
import { estimatedLoss } from '../../../solana/lp/opening';
import type { OutsidePrice } from '../../../solana/lp/outsidePrice';
import { BUILDABLE_EXTENSIONS, EXTENSION } from '../../../solana/lp/tokenSafety';
import { METAPLEX_TOKEN_METADATA_ID, metadataPda } from './metaplex';
import { CP_CREATE_POOL_FEE_RECEIVER } from './config';
import {
  CREATE_COPY,
  createStepsProblem,
  prepareLpCreate,
  readCreateSnapshot,
  vaultAccountSize,
  type CreateSnapshot,
  type LpCreateArgs,
} from './createPool';
import { LP_COPY, tokenAccountSize, type LpPrepareReads } from './liquidity';
import { TX_SIZE_LIMIT } from './prepare';
import {
  CPSWAP,
  EXT,
  FakeChain,
  TIER1_VALUES,
  addPool,
  beforeBalanceRun,
  cfgLocal,
  createSimulator,
  encodeAmmConfig,
  rent,
  skewTestRun,
  type AmmConfigOverrides,
  type FeeReceiverOptions,
} from './testkit.fixture';
import type { IntentStep, LpCreateSummary, LpOpenGate, PreparedTx, TierTerms, WriteRpc } from './types';
import { SOL_QUOTE } from '../../../solana/lp/quotes';

const W = (c: FakeChain) => c as unknown as WriteRpc;
const ME = Keypair.generate().publicKey;
const STRANGER = Keypair.generate().publicKey;
const OPEN: LpOpenGate = { kind: 'open', cfg: cfgLocal, mode: 'on' };
const TIER1 = publicTierConfig(CPSWAP);
const SOL = 1_000_000_000n; // 1 SOL
const TOKENS = 100_000_000n; // 100 tokens at 6 decimals: 0.01 SOL a token
const METADATA_ONLY: Array<[number, number]> = [[EXT.MetadataPointer, 64], [EXT.TokenMetadata, 76]];
const FEE = TIER1_VALUES.createPoolFee;
const R = (n: number) => BigInt(rent(n));
/** What `initialize` pays for and never returns, for a 165-byte token vault: pool, price record, share token, two vaults. */
const NEVER_REFUNDED = R(637) + R(4075) + R(82) + R(165) + R(165);

const TERMS: TierTerms = {
  createPoolFee: TIER1_VALUES.createPoolFee,
  tradeFeeRate: TIER1_VALUES.tradeFeeRate,
  protocolFeeRate: TIER1_VALUES.protocolFeeRate,
  fundFeeRate: TIER1_VALUES.fundFeeRate,
  creatorFeeRate: TIER1_VALUES.creatorFeeRate,
};

const priced = (solPerToken = 0.01): LpPrepareReads => ({ outsidePrice: async () => ({ kind: 'ok', solPerToken, source: 'Jupiter' }) });
const answering = (o: OutsidePrice): LpPrepareReads => ({ outsidePrice: async () => o });
const NO_ROUTE: OutsidePrice = { kind: 'no-route', detail: 'Jupiter has no route for this token' };

/** The body length each Token-2022 mint extension needs to decode (the two name ones); any other is opaque here. */
const extensionOf = (type: number): [number, number] => [type, type === EXTENSION.MetadataPointer ? 64 : type === EXTENSION.TokenMetadata ? 76 : 8];

const NO_MARKET_OPENING =
  'Jupiter has no market price for this token, so there is nothing to compare your opening price with. You are setting the price yourself: if it is off, the first trades take the difference out of what you put in.';
const COPY_OPENING =
  'It calls itself by a well-known token’s name but has a different mint, so it is not that token. If the copy turns out to be worth nothing, so is your share of the pool you open.';
const FREEZE_OPENING =
  'Its creator can freeze the vault of the pool you open, and while it is frozen nobody can take liquidity out, you included. They can also freeze your own account for the token.';
const AMOUNTS =
  'The amount a wallet displays for this token changes over time. This site shows and moves raw token units, so check the amounts against your wallet before you sign.';

function str(s: string): number[] {
  const b = Buffer.from(s, 'utf8');
  return [b.length & 255, (b.length >> 8) & 255, 0, 0, ...b];
}
/** A Metaplex name record (key 4), immutable. */
function metaplexRecord(mint: PublicKey, name: string, symbol: string): Uint8Array {
  return Uint8Array.from([4, ...Keypair.generate().publicKey.toBytes(), ...mint.toBytes(), ...str(name), ...str(symbol), ...str('https://x.test/a.json'), 0, 0, 0, 0, 0]);
}

interface World {
  chain: FakeChain;
  mint: PublicKey;
  tokenProgram: PublicKey;
  tokenAta: PublicKey;
  wsolAta: PublicKey;
  standard: PublicKey;
  token0: PublicKey;
  token1: PublicKey;
}

function world(o: {
  mint?: PublicKey;
  tokenProgram?: PublicKey;
  mintExtensions?: Array<[number, number]>;
  mintDecimals?: number;
  freezeAuthority?: PublicKey;
  name?: [string, string];
  noMint?: boolean;
  wallet?: bigint;
  heldTokens?: bigint | null;
  tokenAccount?: Parameters<FakeChain['tokenAccount']>[4] & { cpiGuard?: boolean; owner?: PublicKey };
  heldWsol?: bigint;
  wsolOptions?: Parameters<FakeChain['tokenAccount']>[4];
  tier?: Partial<AmmConfigOverrides> | null;
  feeReceiver?: Partial<FeeReceiverOptions> | null;
} = {}): World {
  const chain = FakeChain.healthy();
  chain.simulate = createSimulator();
  if (o.tier !== null) chain.addTier1(o.tier ?? {});
  if (o.feeReceiver !== null) chain.addFeeReceiver(o.feeReceiver ?? {});
  const mint = o.mint ?? Keypair.generate().publicKey;
  const tokenProgram = o.tokenProgram ?? TOKEN_PROGRAM_ID;
  const mintOpts = { decimals: o.mintDecimals ?? 6, freezeAuthority: o.freezeAuthority };
  if (!o.noMint) {
    if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) chain.mint2022(mint, o.mintExtensions ?? METADATA_ONLY, mintOpts);
    else chain.mint(mint, mintOpts);
  }
  if (o.name) chain.set(metadataPda(mint), { lamports: 1, owner: METAPLEX_TOKEN_METADATA_ID, data: metaplexRecord(mint, o.name[0], o.name[1]) });
  chain.fund(ME, Number(o.wallet ?? 20n * 10n ** 9n));
  const tokenAta = associatedTokenAddress(mint, ME, tokenProgram);
  const held = o.heldTokens === undefined ? 1_000n * 10n ** 6n : o.heldTokens;
  if (held !== null) {
    const owner = o.tokenAccount?.owner ?? ME;
    if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) chain.token2022Account(tokenAta, mint, owner, held, o.tokenAccount ?? {});
    else chain.tokenAccount(tokenAta, mint, owner, held, o.tokenAccount ?? {});
  }
  const wsolAta = associatedTokenAddress(WSOL_MINT, ME);
  if (o.heldWsol !== undefined) chain.tokenAccount(wsolAta, WSOL_MINT, ME, o.heldWsol, o.wsolOptions ?? {});
  const { token0, token1 } = sortMints(WSOL_MINT, mint);
  return { chain, mint, tokenProgram, tokenAta, wsolAta, standard: derivePool(CPSWAP, TIER1, token0, token1), token0, token1 };
}

const args = (w: World, o: Partial<LpCreateArgs> = {}): LpCreateArgs => ({
  owner: ME,
  tokenMint: w.mint,
  quoteMint: WSOL_MINT,
  quote: SOL,
  token: TOKENS,
  shown: { terms: TERMS, standard: 'empty' },
  ...o,
});

async function create(w: World, o: Partial<LpCreateArgs> = {}, reads: LpPrepareReads = priced(), gate: LpOpenGate = OPEN) {
  return prepareLpCreate(W(w.chain), gate, reads, args(w, o));
}

function ok(r: Awaited<ReturnType<typeof create>>): PreparedTx {
  if (!r.ok) throw new Error(`expected a prepared transaction, got: ${r.outcome.message}`);
  return r.prepared;
}

function refused(r: Awaited<ReturnType<typeof create>>): string {
  if (r.ok) throw new Error('expected a refusal, but it prepared');
  expect(r.outcome).toMatchObject({ status: 'not-sent', stage: 'build' });
  return r.outcome.message;
}

const summaryOf = (p: PreparedTx) => p.summary as LpCreateSummary;
const tokensText = (raw: bigint) => `${formatTokenAmount(raw, 6, 6).text} tokens`;

/** A pool someone else opened at the standard tier-1 address (all five of its accounts but the price record). */
function squat(w: World): void {
  addPool(w.chain, w.mint, { sol: 10n * SOL, tokens: TOKENS, address: w.standard, tokenProgram: w.tokenProgram });
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── the single read ──────────────────────────────────────────────────────────

describe('readCreateSnapshot: one read for both possible addresses', () => {
  it('reads the 18 keys in ONE call, in 3.1 step 3’s order; prepare then reads only the balances it watches', async () => {
    const w = world();
    const fresh = Keypair.generate();
    vi.spyOn(Keypair, 'generate').mockReturnValueOnce(fresh);
    const asked: string[][] = [];
    const orig = w.chain.getMultipleAccountsInfo;
    w.chain.getMultipleAccountsInfo = async (keys: PublicKey[]) => {
      asked.push(keys.map((k) => k.toBase58()));
      return orig(keys);
    };
    ok(await create(w));
    const five = (pool: PublicKey) => [pool, deriveLpMint(CPSWAP, pool), deriveVault(CPSWAP, pool, w.token0), deriveVault(CPSWAP, pool, w.token1), deriveObservation(CPSWAP, pool)];
    const want = [
      TIER1,
      CP_CREATE_POOL_FEE_RECEIVER,
      w.mint,
      metadataPda(w.mint),
      ME,
      associatedTokenAddress(w.mint, ME, TOKEN_PROGRAM_ID),
      associatedTokenAddress(w.mint, ME, TOKEN_2022_PROGRAM_ID),
      w.wsolAta,
      ...five(w.standard),
      ...five(fresh.publicKey),
    ].map((k) => k.toBase58());
    expect(asked[0]).toEqual(want);
    // The only other account read is the shared pipeline's balance read of the 4 watched accounts and the wallet.
    expect(asked).toHaveLength(2);
    expect(asked[1]).toHaveLength(5);
  });

  it('called on its own: exactly one account read, and a failed read is a string, never a snapshot', async () => {
    const w = world();
    const fresh = Keypair.generate().publicKey;
    const snap = (await readCreateSnapshot(W(w.chain), cfgLocal, { tokenMint: w.mint, owner: ME, fresh, quote: SOL_QUOTE })) as CreateSnapshot;
    expect(w.chain.calls).toEqual(['getMultipleAccountsInfo']);
    expect(snap.tier?.owner).toBe(CPSWAP.toBase58());
    expect(snap.standard.address.equals(w.standard)).toBe(true);
    expect(snap.fresh.address.equals(fresh)).toBe(true);
    expect([...snap.standard.accounts, ...snap.fresh.accounts]).toEqual([null, null, null, null, null, null, null, null, null, null]);
    expect(snap.tokenAccounts.classic).not.toBeNull();
    expect(snap.signerLamports).toBe(20n * 10n ** 9n);
    w.chain.getMultipleAccountsInfo = async () => {
      throw new Error('HTTP 502');
    };
    expect(typeof (await readCreateSnapshot(W(w.chain), cfgLocal, { tokenMint: w.mint, owner: ME, fresh, quote: SOL_QUOTE }))).toBe('string');
  });
});

// ── a clean opening ──────────────────────────────────────────────────────────

describe('prepareLpCreate: a clean opening at the standard address', () => {
  it('one opening on tier 1, every number from the transaction and the reads', async () => {
    const w = world();
    const p = ok(await create(w));
    const s = summaryOf(p);
    const supply = isqrt(SOL * TOKENS);
    expect(p.kind).toBe('lp-create');
    expect(p.extraSigners).toEqual([]);
    expect(s.origin).toBe('standard');
    expect(s.pool.equals(w.standard)).toBe(true);
    expect(s.config.index).toBe(1);
    expect(s.put).toEqual({ quote: SOL, token: TOKENS });
    expect(s.supply).toBe(supply);
    expect(s.lpAmount).toBe(supply - 100n);
    // What stays behind: what was put in less what the opener's own shares pay out (floor), so it rounds up.
    const behind = (put: bigint) => put - ((supply - 100n) * put) / supply;
    expect(s.locked).toEqual({ quote: behind(SOL), token: behind(TOKENS) });
    expect(s.locked).toEqual({ quote: (100n * SOL) / supply + 1n, token: (100n * TOKENS) / supply + 1n });
    expect(s.createFee).toBe(FEE);
    expect(s.feeReceiver.equals(CP_CREATE_POOL_FEE_RECEIVER)).toBe(true);
    expect(s.rents).toEqual({ neverRefunded: NEVER_REFUNDED, lpAccount: R(165) });
    expect(s.price.state).toBe('agrees');
    // A clean token at the market price: nothing to warn of, and no price gap.
    expect(s.warnings).toEqual([]);
    expect(s.priceGap).toBeNull();
    expect(s.unwrapsWsol).toBe(true);
    expect(s.notices).toEqual([]);
    expect(p.steps.filter((x) => x.kind === 'pool-create')).toHaveLength(1);
  });

  it('the bytes: open time 0, slot 1 is tier 1, slot 12 is the pool program’s fee account', async () => {
    const p = ok(await create(world()));
    const ix = p.tx.instructions.find((i) => i.programId.equals(CPSWAP))!;
    expect(ix.data.readBigUInt64LE(24)).toBe(0n);
    expect(ix.keys[1]!.pubkey.equals(TIER1)).toBe(true);
    expect(ix.keys[12]!.pubkey.equals(CP_CREATE_POOL_FEE_RECEIVER)).toBe(true);
  });

  it('a Token-2022 token whose only extras are its name and picture opens with 165-byte vaults (not its 170-byte account size)', async () => {
    const w = world({ tokenProgram: TOKEN_2022_PROGRAM_ID });
    const p = ok(await create(w));
    expect(summaryOf(p).rents.neverRefunded).toBe(NEVER_REFUNDED);
    expect(p.fees.newAccountRentLamports).toBe(NEVER_REFUNDED + R(165));
  });
});

// ── where the pool goes (N5) ─────────────────────────────────────────────────

describe('where the pool goes', () => {
  const extraKeys = (p: PreparedTx) => p.extraSigners.map((k) => k.publicKey.toBase58());
  const pinsOf = (p: PreparedTx) => (p.check.intent.kind === 'lp-create' && 'pins' in p.check.intent ? p.check.intent.pins : null);

  it('a pool already at the standard address: a fresh one-off address, signed by exactly one extra key, which is the pool', async () => {
    const w = world();
    squat(w);
    const p = ok(await create(w, { shown: { terms: TERMS, standard: 'taken' } }));
    const s = summaryOf(p);
    expect(s.origin).toBe('other');
    expect(s.pool.equals(w.standard)).toBe(false);
    expect(extraKeys(p)).toEqual([pinsOf(p)!.address.toBase58()]);
    expect(extraKeys(p)).toEqual([s.pool.toBase58()]);
    const ix = p.tx.instructions.find((i) => i.programId.equals(CPSWAP))!;
    expect(ix.keys[3]!.pubkey.equals(s.pool) && ix.keys[3]!.isSigner).toBe(true);
  });

  it('a 0.01 SOL gift to the standard wrapped-SOL vault alone sends it to a one-off address (it would become wrapped SOL in the vault)', async () => {
    const w = world();
    w.chain.fund(deriveVault(CPSWAP, w.standard, WSOL_MINT), 10_000_000);
    const p = ok(await create(w));
    expect(summaryOf(p).origin).toBe('other');
    expect(p.extraSigners).toHaveLength(1);
  });

  it('plain lamports at the standard pool address alone: a one-off address too', async () => {
    const w = world();
    w.chain.fund(w.standard, 1_000_000);
    expect(summaryOf(ok(await create(w))).origin).toBe('other');
  });

  it('a fresh key per Review: two openings on the one-off path never share an address', async () => {
    const w = world();
    squat(w);
    const a = summaryOf(ok(await create(w, { shown: { terms: TERMS, standard: 'taken' } }))).pool;
    const b = summaryOf(ok(await create(w, { shown: { terms: TERMS, standard: 'taken' } }))).pool;
    expect(a.equals(b)).toBe(false);
  });

  it('the panel saw the standard address empty and a pool is there now: someone just opened one', async () => {
    const w = world();
    squat(w);
    expect(refused(await create(w))).toBe(CREATE_COPY.justOpened);
  });

  it('something already at the fresh key’s accounts: refused, never used', async () => {
    const w = world();
    squat(w);
    const fresh = Keypair.generate();
    w.chain.fund(deriveLpMint(CPSWAP, fresh.publicKey), 1_000_000);
    vi.spyOn(Keypair, 'generate').mockReturnValueOnce(fresh);
    expect(refused(await create(w, { shown: { terms: TERMS, standard: 'taken' } }))).toBe(CREATE_COPY.freshTaken);
  });
});

// ── each "no", in 3.1's order ────────────────────────────────────────────────

describe('prepareLpCreate: what refuses it, each in its own words', () => {
  it('inputs: paused, an empty side, a side past u64', async () => {
    const w = world();
    expect(refused(await create(w, {}, priced(), { kind: 'open', cfg: cfgLocal, mode: 'withdraw-only' }))).toBe(CREATE_COPY.paused);
    expect(refused(await create(w, { quote: 0n }))).toBe(CREATE_COPY.emptySide);
    expect(refused(await create(w, { token: 0n }))).toBe(CREATE_COPY.emptySide);
    expect(refused(await create(w, { token: 1n << 64n }))).toBe(CREATE_COPY.tooLarge);
  });

  it('a read that fails is said as such', async () => {
    const w = world();
    w.chain.getMultipleAccountsInfo = async () => {
      throw new Error('HTTP 502');
    };
    expect(refused(await create(w))).toBe(CREATE_COPY.readFailed);
  });

  it('tier 1: gone, switched off, its fee above the ceiling, or not tier 1 at all', async () => {
    expect(refused(await create(world({ tier: null })))).toBe(CREATE_COPY.tierNotOpen);
    expect(refused(await create(world({ tier: { disableCreatePool: true } })))).toBe(CREATE_COPY.tierOff);
    expect(refused(await create(world({ tier: { createPoolFee: 2_000_000_000n } })))).toBe(CREATE_COPY.tierFeeTooHigh('2', '1'));
    const w = world();
    w.chain.set(TIER1, { lamports: 1, owner: CPSWAP, data: encodeAmmConfig({ ...TIER1_VALUES, index: 0 }) });
    expect(refused(await create(w))).toBe(CREATE_COPY.tierUnread('it is fee tier 0, not 1'));
  });

  it('tier 1’s terms changed since the panel showed them: refused, naming the change (one case per term, either direction)', async () => {
    const cases: Array<[keyof TierTerms, bigint, string]> = [
      ['createPoolFee', 100_000_000n, 'fee to open 0.1 → 0.15 SOL'],
      ['tradeFeeRate', 20_000n, 'trade fee 2% → 1%'],
      ['protocolFeeRate', 120_000n, 'protocol fee 12% → 16%'],
      ['fundFeeRate', 10_000n, 'fund fee 1% → 0%'],
      ['creatorFeeRate', 500n, 'creator fee 0.05% → 0%'],
    ];
    for (const [term, shown, what] of cases) {
      const r = await create(world(), { shown: { terms: { ...TERMS, [term]: shown }, standard: 'empty' } });
      expect(refused(r), term).toBe(CREATE_COPY.termsChanged(what));
    }
  });

  it('the fee account: missing, or not a native wrapped-SOL account', async () => {
    expect(refused(await create(world({ feeReceiver: null })))).toBe(CREATE_COPY.feeAccount('there is no account at its address'));
    expect(refused(await create(world({ feeReceiver: { native: false } })))).toBe(CREATE_COPY.feeAccount('it is not a native wrapped-SOL account'));
  });

  it('the token, what still refuses it: absent, never set up, SOL under Token-2022, a transfer fee at 0 bps, an extension the pool program rejects', async () => {
    expect(refused(await create(world({ noMint: true })))).toBe(CREATE_COPY.tokenRefused('The token does not exist.'));
    const never = world();
    never.chain.accounts.get(never.mint.toBase58())!.data[45] = 0;
    expect(refused(await create(never))).toBe(CREATE_COPY.tokenRefused('This token mint was never set up.'));
    expect(refused(await create(world({ mint: NATIVE_MINT_2022, tokenProgram: TOKEN_2022_PROGRAM_ID, mintExtensions: [] })))).toBe(CREATE_COPY.native2022);
    // A transfer fee: the leave rule. The words say it is this site's limit.
    const fee = world({ tokenProgram: TOKEN_2022_PROGRAM_ID, mintExtensions: [[EXT.TransferFeeConfig, 108]] });
    expect(refused(await create(fee))).toBe(
      CREATE_COPY.tokenRefused(
        'It uses a transfer-fee setting, which lets the token take a fee out of every transfer. This site cannot build exact deposits and withdrawals for a token with one, so it does not open or add to pools for it.',
      ),
    );
    const hook = world({ tokenProgram: TOKEN_2022_PROGRAM_ID, mintExtensions: [extensionOf(EXTENSION.TransferHook)] });
    expect(refused(await create(hook))).toBe(
      CREATE_COPY.tokenRefused('It uses a transfer hook, a program that runs on every transfer and can refuse or redirect it. The pool program does not accept tokens with it.'),
    );
  });

  // Owner ruling 2026-10-04: these two open a pool, and the review is handed the warning.
  it('a token whose creator can freeze accounts opens a pool, and the summary says what a freeze means for that pool and for the holder', async () => {
    const s = summaryOf(ok(await create(world({ freezeAuthority: STRANGER }))));
    expect(s.warnings).toEqual([FREEZE_OPENING]);
    expect(s.priceGap).toBeNull();
    const own = s.tokenWarnings.find((x) => x.code === 'freeze-authority')!;
    expect(own.text).toContain(STRANGER.toBase58());
    expect(own.text).toMatch(/a pool’s own vault and your own account included/);
  });

  it('a copy of a well-known name opens a pool, and the copy warning is on the summary', async () => {
    const s = summaryOf(ok(await create(world({ name: ['USD Coin', 'USDC'] }))));
    expect(s.warnings).toEqual([COPY_OPENING]);
    expect(s.tokenWarnings.map((x) => x.code)).toEqual(['copies-known-name']);
  });

  it.each([
    ['interest-bearing', EXTENSION.InterestBearingConfig],
    ['scaled-amount', EXTENSION.ScaledUiAmountConfig],
  ] as const)('a Token-2022 token with %s amounts opens a pool with a 165-byte vault, and the summary carries the line about what a wallet displays', async (code, type) => {
    const w = world({ tokenProgram: TOKEN_2022_PROGRAM_ID, mintExtensions: [extensionOf(type), ...METADATA_ONLY] });
    const p = ok(await create(w));
    const s = summaryOf(p);
    expect(s.warnings).toEqual([AMOUNTS]);
    expect(s.tokenWarnings.map((x) => x.code)).toContain(code);
    // The pool program adds no account extension for these, so the vault is a plain 165.
    expect(s.rents.neverRefunded).toBe(NEVER_REFUNDED);
    expect(p.fees.newAccountRentLamports).toBe(NEVER_REFUNDED + R(165));
  });

  // The leave rule, with the real verdict: this site opens a pool for exactly the
  // extensions it can also build a withdrawal for (liquidity.test.ts pins the other half).
  it('for each Token-2022 extension: an opening builds only for the one set this site builds for', async () => {
    const opened: number[] = [];
    for (const type of [...Object.values(EXTENSION), 99]) {
      if ((await create(world({ tokenProgram: TOKEN_2022_PROGRAM_ID, mintExtensions: [extensionOf(type)] }))).ok) opened.push(type);
    }
    const sorted = (xs: Iterable<number>) => [...xs].sort((a, b) => a - b);
    expect(sorted(opened)).toEqual(sorted(BUILDABLE_EXTENSIONS));
  });

  // The loss is worked out with the TOKEN's own decimals. Every other loss test here uses
  // a 6-decimal token, so a builder that assumed 6 passed them all (review, 2026-10-04).
  it('a 9-decimal token: the estimated loss uses the token’s own decimals', async () => {
    // 1 SOL against 100 whole tokens of 9 decimals: 0.01 SOL a token. The market says 0.0096.
    const token = 100n * 10n ** 9n;
    const w = world({ mintDecimals: 9, heldTokens: 1_000n * 10n ** 9n });
    const s = summaryOf(ok(await create(w, { token }, priced(0.0096))));
    expect(s.tokenDecimals).toBe(9);
    expect(s.price).toMatchObject({ state: 'disagrees', against: 'outside', pool: 0.01, reference: 0.0096 });
    const loss = estimatedLoss({ quoteAmount: SOL, token, tokenDecimals: 9, marketPricePerToken: 0.0096, quote: SOL_QUOTE })!;
    expect(s.priceGap!.lossQuote).toBe(loss);
    expect(Number(loss) / 1e9).toBeCloseTo((1 - Math.sqrt(0.96)) ** 2, 9);
    // Read as 6 decimals the tokens would count a thousand times over, and so would the loss.
    expect(loss).not.toBe(estimatedLoss({ quoteAmount: SOL, token, tokenDecimals: 6, marketPricePerToken: 0.0096, quote: SOL_QUOTE }));
  });

  // Owner ruling 2026-10-04: an opening price off the market builds. The gap and the
  // estimated loss come from the price read just now, not from what the panel showed.
  it('the price, 4% from the market at prepare although the panel agreed: it builds, with the gap and the estimated loss in SOL', async () => {
    const w = world();
    const above = summaryOf(ok(await create(w, {}, priced(0.0096))));
    expect(above.price).toMatchObject({ state: 'disagrees', against: 'outside', pool: 0.01, reference: 0.0096 });
    expect(above.priceGap!.diff).toBeCloseTo(0.01 / 0.0096 - 1, 12);
    const loss = estimatedLoss({ quoteAmount: SOL, token: TOKENS, tokenDecimals: 6, marketPricePerToken: 0.0096, quote: SOL_QUOTE })!;
    expect(above.priceGap!.lossQuote).toBe(loss);
    // 1 SOL against 100 tokens worth 0.96 SOL: (1 − √0.96)² SOL, about 0.0004 SOL.
    expect(Number(loss) / 1e9).toBeCloseTo((1 - Math.sqrt(0.96)) ** 2, 9);
    expect(above.warnings).toEqual([
      'Your opening price is 4.2% above the market price (Jupiter). The first trades would move it to the market price, at your cost.',
      `At these amounts, a move back to the market price would take up to about ${(Number(loss) / 1e9).toFixed(9).replace(/0+$/, '')} SOL of what you put in. That is an estimate.`,
    ]);
    const below = summaryOf(ok(await create(w, {}, priced(0.0104))));
    expect(below.priceGap!.diff).toBeCloseTo(0.01 / 0.0104 - 1, 12);
    expect(below.warnings[0]).toBe('Your opening price is 3.8% below the market price (Jupiter). The first trades would move it to the market price, at your cost.');
    // Within 3% it builds with nothing to say.
    const near = summaryOf(ok(await create(w, {}, priced(0.0101))));
    expect([near.warnings, near.priceGap]).toEqual([[], null]);
    // No sentence says this site refuses a price it now takes.
    expect([...above.warnings, ...below.warnings].join(' ')).not.toMatch(/must start within|does not open|Match the market price/);
  });

  it('the estimated loss never decides anything: an opening 50% off is the same transaction as one at the market', async () => {
    const fair = ok(await create(world()));
    const off = ok(await create(world(), {}, priced(0.02)));
    expect(summaryOf(off).priceGap!.lossQuote).toBeGreaterThan(0n);
    expect([summaryOf(off).put, summaryOf(off).lpAmount]).toEqual([summaryOf(fair).put, summaryOf(fair).lpAmount]);
    expect(off.check.expect.maxSolOut).toBe(fair.check.expect.maxSolOut);
  });

  it('a loss that cannot be worked out is said as such, never as 0', async () => {
    const s = summaryOf(ok(await create(world(), {}, priced(1e300))));
    expect(s.priceGap).toMatchObject({ lossQuote: null });
    expect(s.warnings[1]).toBe('What a move back to the market price would cost you at these amounts could not be worked out.');
  });

  it('the price, Jupiter ANSWERS "no route": it builds as "no market", and the opener is told they set the price themselves', async () => {
    const s = summaryOf(ok(await create(world(), {}, answering(NO_ROUTE))));
    expect(s.price).toEqual({ state: 'no-market', of: 'token', pool: 0.01, detail: 'Jupiter has no route for this token' });
    expect(s.warnings).toEqual([NO_MARKET_OPENING]);
    expect(s.priceGap).toBeNull();
  });

  it('every warning that applies is carried together: a freezable copy with no market price', async () => {
    const s = summaryOf(ok(await create(world({ freezeAuthority: STRANGER, name: ['BAYLA', 'BAYLA'] }), {}, answering(NO_ROUTE))));
    expect(s.warnings).toEqual([COPY_OPENING, FREEZE_OPENING, NO_MARKET_OPENING]);
  });

  it('the price, NOT read: Jupiter down, or a read that throws, still builds nothing and is never a warning', async () => {
    const w = world();
    expect(refused(await create(w, {}, answering({ kind: 'unread', detail: 'Jupiter did not give a price (HTTP 502)' })))).toBe(
      CREATE_COPY.priceUnread('Jupiter did not give a price (HTTP 502)'),
    );
    const throwing: LpPrepareReads = {
      outsidePrice: async () => {
        throw new Error('offline');
      },
    };
    expect(refused(await create(w, {}, throwing))).toBe(CREATE_COPY.priceUnread('offline'));
  });

  it('the wallet’s token account: missing, a stranger’s, frozen, CPI Guard on, or holding too little', async () => {
    const none = world({ heldTokens: null });
    expect(refused(await create(none))).toBe(LP_COPY.noTokenAccount(none.tokenAta.toBase58()));
    const foreign = world({ tokenAccount: { owner: STRANGER } });
    expect(refused(await create(foreign))).toBe(LP_COPY.foreignOwner(foreign.tokenAta.toBase58(), STRANGER.toBase58()));
    expect(refused(await create(world({ tokenAccount: { state: 2 } })))).toBe(LP_COPY.frozenSource('token'));
    expect(refused(await create(world({ tokenProgram: TOKEN_2022_PROGRAM_ID, tokenAccount: { cpiGuard: true } })))).toBe(LP_COPY.cpiGuard);
    ok(await create(world({ tokenProgram: TOKEN_2022_PROGRAM_ID, tokenAccount: { cpiGuard: false } })));
    expect(refused(await create(world({ heldTokens: 50_000_000n })))).toBe(LP_COPY.overBalance(tokensText(TOKENS), tokensText(50_000_000n)));
  });

  // Whole-change review 2026-10-04 (L4). A withdrawal is refused while the token account
  // it pays into has an approved spender. The opening spends from that account and built
  // with no word about it: its review now says so. A clean wallet's review says nothing new.
  it('an approved spender on the token account: the opening builds, and its review says a withdrawal into that account is off until it is revoked', async () => {
    const w = world({ tokenAccount: { delegate: STRANGER, delegatedAmount: 2_500_000n } });
    expect(summaryOf(ok(await create(w))).notices).toEqual([
      `An approved spender (${STRANGER.toBase58()}) can move up to 2.5 out of your token account (${w.tokenAta.toBase58()}). This site will not pay a withdrawal into that account until you revoke that approval.`,
    ]);
    expect(summaryOf(ok(await create(world()))).notices).toEqual([]);
  });

  it('a wrapped-SOL account a stranger can close is refused (wsolPlanFrom), kept or empty', async () => {
    const w = world({ heldWsol: 0n, wsolOptions: { closeAuthority: STRANGER } });
    expect(refused(await create(w))).toMatch(new RegExp(`^${STRANGER.toBase58()} can close your wrapped-SOL account`));
  });

  it('too small: the program’s 100 locked shares not covered, or more than 0.1% of the pool', async () => {
    const w = world();
    // isqrt(100 · 10) = 31: below the 100 the program keeps.
    expect(refused(await create(w, { quote: 100n, token: 10n }))).toBe(CREATE_COPY.tooSmall);
    // isqrt(158,110 · 15,811) = 49,998: the 100 would be 0.2% of the pool.
    expect(refused(await create(w, { quote: 158_110n, token: 15_811n }))).toBe(CREATE_COPY.lockTooLarge('0.2'));
  });

  it('the rent band: exactly what this wallet can put in prepares; one lamport more is refused, naming that number', async () => {
    // A wallet with no wrapped-SOL account: it pays that account's rent during the transaction.
    const most = SOL;
    const wallet = most + feeReserveFor(2) + R(165) + FEE + NEVER_REFUNDED + R(165);
    expect(spendableSol({ lamports: wallet, walletFloor: R(0), feeReserve: feeReserveFor(2), lpAccountRent: R(165), wsolCreateRent: R(165), alsoPaid: FEE + NEVER_REFUNDED })).toBe(most);
    const w = world({ wallet });
    ok(await create(w, { quote: most }));
    expect(refused(await create(w, { quote: most + 1n }))).toBe(CREATE_COPY.rentBand('1 SOL'));
  });
});

// ── the exact balance check (3.3) ────────────────────────────────────────────

/** A row with no upper bound: more arriving than the review says cannot hurt the signer. */
const NO_CEILING = 2n ** 64n;

describe('the balance check: nothing more may leave the wallet than the review says', () => {
  const row = (p: PreparedTx, k: PublicKey) => {
    const r = p.check.expect.tokens.find((t) => t.account.equals(k))!;
    return [r.minDelta, r.maxDelta];
  };

  it('shares in exactly; at most the tokens typed out; wrapped SOL back where it was; at least the fee into the fee account; SOL out at most the sum of them', async () => {
    const w = world();
    const p = ok(await create(w));
    const s = summaryOf(p);
    const pins = p.check.intent.kind === 'lp-create' && 'pins' in p.check.intent ? p.check.intent.pins : null;
    expect(row(p, pins!.lpAccount)).toEqual([s.lpAmount, s.lpAmount]);
    expect(row(p, w.tokenAta)).toEqual([-TOKENS, NO_CEILING]);
    expect(row(p, w.wsolAta)).toEqual([0n, 0n]);
    expect(row(p, CP_CREATE_POOL_FEE_RECEIVER)).toEqual([FEE, NO_CEILING]);
    expect(p.check.expect.maxSolOut).toBe(SOL + FEE + NEVER_REFUNDED + R(165));
    expect(p.check.expect.minSolIn).toBeUndefined();
    expect(p.check.watch.tokenAccounts.find((t) => t.account.equals(CP_CREATE_POOL_FEE_RECEIVER))?.role).toBe('treasury');
  });

  it('a test run where the program takes a different fee than the one shown (a stale or lying tier read) is BLOCKED before any signature', async () => {
    const w = world();
    w.chain.simulate = createSimulator({ feeCharged: (fee) => fee * 2n });
    const r = await create(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.outcome).toMatchObject({ status: 'not-sent', stage: 'simulate', message: 'Blocked: the simulation shows more SOL leaving your wallet than this screen says.' });
  });

  it('wrapped SOL the wallet already holds is never spent: kept, never closed', async () => {
    const w = world({ heldWsol: 500_000_000n });
    const p = ok(await create(w));
    const s = summaryOf(p);
    expect(p.steps.some((x) => x.kind === 'close-wsol')).toBe(false);
    expect(s.unwrapsWsol).toBe(false);
    expect(s.wsolHeldBefore).toBe(500_000_000n);
    expect(row(p, w.wsolAta)).toEqual([0n, NO_CEILING]);
  });
});

// ── a credit between the balance read and the test run ───────────────────────
//
// The balances are read a slot or more before the test run. Anyone can send a lamport to
// the fee account, a token to the wallet, or wrapped SOL to a kept account in between,
// and a row that allowed only the exact change let that dust block every opening. What
// protects the signer stays: the wallet pays at most the sum on screen, to the lamport,
// so a fee above the one shown is caught there, whoever sends what to the fee account.

describe('a credit between the balance read and the test run does not block an opening; taking more still does', () => {
  const moved = (p: PreparedTx, k: PublicKey) => p.simulated.tokenDeltas.find((d) => d.account.equals(k))!.delta;
  const outcome = (r: Awaited<ReturnType<typeof create>>) => (r.ok ? 'prepared' : r.outcome);
  const BLOCKED_TOKENS = { status: 'not-sent', stage: 'simulate', message: 'Blocked: the simulation shows a different token amount than this screen says.' };
  const lpAtaOf = (w: World) => associatedTokenAddress(deriveLpMint(CPSWAP, w.standard), ME);

  it('a lamport sent to the fee account in between: the opening still prepares', async () => {
    const w = world();
    beforeBalanceRun(w.chain, () => w.chain.addFeeReceiver({ unsynced: 1n }));
    expect(moved(ok(await create(w)), CP_CREATE_POOL_FEE_RECEIVER)).toBe(FEE + 1n);
  });

  it('a token sent to the wallet in between: the opening still prepares', async () => {
    const w = world();
    beforeBalanceRun(w.chain, () => w.chain.tokenAccount(w.tokenAta, w.mint, ME, 1_000n * 10n ** 6n + 1n));
    expect(moved(ok(await create(w)), w.tokenAta)).toBe(1n - TOKENS);
  });

  it('wrapped SOL sent to a kept wrapped-SOL account in between: the opening still prepares', async () => {
    const w = world({ heldWsol: 500_000_000n });
    beforeBalanceRun(w.chain, () => w.chain.tokenAccount(w.wsolAta, WSOL_MINT, ME, 500_000_001n));
    expect(moved(ok(await create(w)), w.wsolAta)).toBe(1n);
  });

  // The fee account's own row no longer has a ceiling, so this is the row that must hold:
  // the fee on screen passes with nothing to spare, and one lamport more is blocked, in
  // every state the wallet's own addresses can be in. `networkFee`: as a cluster reports it.
  describe('one lamport more than the fee on screen, taken from the wallet, is still blocked, whatever its addresses held', () => {
    const states: Array<[string, (w: World) => void]> = [
      ['no wrapped-SOL account', () => {}],
      ['an empty wrapped-SOL account, closed at the end', (w) => w.chain.tokenAccount(w.wsolAta, WSOL_MINT, ME, 0n)],
      ['an empty wrapped-SOL account set up under an older rent', (w) => w.chain.tokenAccount(w.wsolAta, WSOL_MINT, ME, 0n, { native: { reserve: R(165) + 550_840n, unsynced: 5_000n } })],
      ['wrapped SOL the wallet keeps', (w) => w.chain.tokenAccount(w.wsolAta, WSOL_MINT, ME, 500_000_000n)],
      ['only SOL someone sent to the wrapped-SOL address', (w) => w.chain.fund(w.wsolAta, rent(165) + 12_345)],
      ['only SOL someone sent to the pool-share address', (w) => w.chain.fund(lpAtaOf(w), rent(0))],
    ];
    for (const [label, set] of states) {
      it(label, async () => {
        const shown = world();
        set(shown);
        shown.chain.simulate = createSimulator({ networkFee: true });
        expect(outcome(await create(shown))).toBe('prepared');
        const over = world();
        set(over);
        over.chain.simulate = createSimulator({ networkFee: true, feeCharged: (fee) => fee + 1n });
        expect(outcome(await create(over))).toMatchObject({ status: 'not-sent', stage: 'simulate', message: expect.stringMatching(/^Blocked: /) });
      });
    }
  });

  it('one token more than typed leaving, one pool share fewer arriving, or kept wrapped SOL going down by one lamport: each is still blocked', async () => {
    const tok = world();
    skewTestRun(tok.chain, tok.tokenAta, -1n);
    expect(outcome(await create(tok))).toMatchObject(BLOCKED_TOKENS);

    const lp = world();
    skewTestRun(lp.chain, lpAtaOf(lp), -1n);
    expect(outcome(await create(lp))).toMatchObject(BLOCKED_TOKENS);

    const kept = world({ heldWsol: 500_000_000n });
    skewTestRun(kept.chain, kept.wsolAta, -1n);
    expect(outcome(await create(kept))).toMatchObject(BLOCKED_TOKENS);
  });
});

// ── SOL sent to an address before its account exists ─────────────────────────
//
// Anyone can send SOL to a wallet's associated address before an account is opened
// there. The address then reads as owned by the System program, with no data. That is
// no account yet: the transaction opens one over it, and the wallet pays only what is
// missing from its deposit. A stranger must not be able to stop an opening with it.

describe('SOL sent to one of the wallet’s addresses before its account exists is no account', () => {
  /** The least a bare address can hold, and more than a token account's deposit. */
  const SENT = [rent(0), rent(165) + 12_345];
  const row = (p: PreparedTx, k: PublicKey) => {
    const r = p.check.expect.tokens.find((t) => t.account.equals(k))!;
    return [r.minDelta, r.maxDelta];
  };
  const moved = (p: PreparedTx, k: PublicKey) => p.simulated.tokenDeltas.find((d) => d.account.equals(k))!.delta;

  it('at the wrapped-SOL address: the opening prepares at the standard address, and the wallet pays the sum on screen less exactly those lamports', async () => {
    for (const sent of SENT) {
      const w = world();
      w.chain.fund(w.wsolAta, sent);
      const p = ok(await create(w));
      const s = summaryOf(p);
      expect(s.origin, String(sent)).toBe('standard');
      expect(s.unwrapsWsol, String(sent)).toBe(true);
      expect(s.wsolHeldBefore, String(sent)).toBe(0n);
      expect(row(p, w.wsolAta), String(sent)).toEqual([0n, 0n]);
      const paid = SOL + FEE + NEVER_REFUNDED + R(165) - BigInt(sent);
      expect(p.simulated.signerLamportsDelta, String(sent)).toBe(-paid);
      expect(p.check.expect.maxSolOut, String(sent)).toBe(paid);
    }
  });

  it('at the pool-share address of the standard pool: the opening prepares, exactly the shares arrive, and the wallet pays only what is missing from that deposit', async () => {
    for (const sent of SENT) {
      const w = world();
      const lpAta = associatedTokenAddress(deriveLpMint(CPSWAP, w.standard), ME);
      w.chain.fund(lpAta, sent);
      const p = ok(await create(w));
      const s = summaryOf(p);
      expect(s.origin, String(sent)).toBe('standard');
      expect(moved(p, lpAta), String(sent)).toBe(s.lpAmount);
      const paid = SOL + FEE + NEVER_REFUNDED + BigInt(Math.max(0, rent(165) - sent));
      expect(p.simulated.signerLamportsDelta, String(sent)).toBe(-paid);
      expect(p.check.expect.maxSolOut, String(sent)).toBe(paid);
      // The review still states the whole deposit.
      expect(s.rents.lpAccount, String(sent)).toBe(R(165));
    }
  });

  it('at the token address (classic and Token-2022): said as holding none of the token', async () => {
    for (const tokenProgram of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const w = world({ tokenProgram, heldTokens: null });
      w.chain.fund(w.tokenAta, rent(0));
      expect(refused(await create(w)), tokenProgram.toBase58()).toBe(LP_COPY.noTokenAccount(w.tokenAta.toBase58()));
    }
  });

  it('the most this wallet can put in still sets aside a full deposit for the wrapped-SOL address', async () => {
    const most = SOL;
    const wallet = most + feeReserveFor(2) + R(165) + FEE + NEVER_REFUNDED + R(165);
    const w = world({ wallet });
    w.chain.fund(w.wsolAta, rent(0));
    ok(await create(w, { quote: most }));
    expect(refused(await create(w, { quote: most + 1n }))).toBe(CREATE_COPY.rentBand('1 SOL'));
  });

  it('anything else at the wrapped-SOL address is still refused: another owner, or data that is not a token account', async () => {
    const cases: Array<[string, { owner: PublicKey; data: Uint8Array }]> = [
      ['owned by the System program, with data', { owner: SYSTEM_PROGRAM_ID, data: new Uint8Array(80) }],
      ['no data, owned by another program', { owner: STRANGER, data: new Uint8Array(0) }],
      ['owned by the token program, too short to be a token account', { owner: TOKEN_PROGRAM_ID, data: new Uint8Array(0) }],
    ];
    for (const [label, a] of cases) {
      const w = world();
      w.chain.set(w.wsolAta, { lamports: rent(0), ...a });
      expect(refused(await create(w)), label).toBe(LP_COPY.notUsable('wrapped SOL', w.wsolAta.toBase58()));
    }
  });
});

// ── a sync credits what an account already held (mainnet, 2026-10-02) ──────────
//
// The fee account was set up under the old rent, and mainnet's token program re-prices a
// native account's reserve when it syncs, so the first opening credits it the fee PLUS
// 550,840 lamports it had been holding as reserve. An exact fee row blocked every opening
// on mainnet while this suite, whose chain never synced anything, stayed green.

describe('a sync credits what a wrapped-SOL account already held, and the check counts it', () => {
  const OLD_RESERVE_SURPLUS = 550_840n;
  const OLD_RESERVE = R(165) + OLD_RESERVE_SURPLUS;
  const row = (p: PreparedTx, k: PublicKey) => {
    const r = p.check.expect.tokens.find((t) => t.account.equals(k))!;
    return [r.minDelta, r.maxDelta];
  };
  const moved = (p: PreparedTx, k: PublicKey) => p.simulated.tokenDeltas.find((d) => d.account.equals(k))!.delta;
  const BLOCKED = { status: 'not-sent', stage: 'simulate', message: 'Blocked: the simulation shows a different token amount than this screen says.' };

  it('the fee account set up under the old rent: the opening prepares, and the fee account gains exactly the fee plus that surplus', async () => {
    const w = world({ feeReceiver: { reserve: OLD_RESERVE } });
    const p = ok(await create(w));
    expect(moved(p, CP_CREATE_POOL_FEE_RECEIVER)).toBe(FEE + OLD_RESERVE_SURPLUS);
    expect(row(p, CP_CREATE_POOL_FEE_RECEIVER)).toEqual([FEE + OLD_RESERVE_SURPLUS, NO_CEILING]);
  });

  it('a token program that keeps the stored reserve instead (not mainnet): refused, never accepted on a guess', async () => {
    const w = world({ feeReceiver: { reserve: OLD_RESERVE } });
    w.chain.simulate = createSimulator({ keepsReserve: true });
    const r = await create(w);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.outcome).toMatchObject(BLOCKED);
  });

  it('lamports someone sent to the fee account before Review are credited with the fee, and the least that must arrive counts them', async () => {
    const w = world({ feeReceiver: { unsynced: 1_000n } });
    const p = ok(await create(w));
    expect(moved(p, CP_CREATE_POOL_FEE_RECEIVER)).toBe(FEE + 1_000n);
    expect(row(p, CP_CREATE_POOL_FEE_RECEIVER)).toEqual([FEE + 1_000n, NO_CEILING]);
  });

  // One lamport more comes out of the wallet, so the SOL row says so; one lamport less
  // lands short of the fee account's own row.
  it('a fee one lamport off the one shown, either way, is still blocked on an account set up under the old rent', async () => {
    const cases: Array<[(fee: bigint) => bigint, string]> = [
      [(fee) => fee + 1n, 'Blocked: the simulation shows more SOL leaving your wallet than this screen says.'],
      [(fee) => fee - 1n, BLOCKED.message],
    ];
    for (const [feeCharged, message] of cases) {
      const w = world({ feeReceiver: { reserve: OLD_RESERVE } });
      w.chain.simulate = createSimulator({ feeCharged, networkFee: true });
      const r = await create(w);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.outcome).toMatchObject({ ...BLOCKED, message });
    }
  });

  it('a tier with no fee to open: the program neither pays nor syncs the fee account, so lamports sitting there are not expected to move', async () => {
    const free = { ...TERMS, createPoolFee: 0n };
    const w = world({ tier: { createPoolFee: 0n }, feeReceiver: { unsynced: 1_000n } });
    const p = ok(await create(w, { shown: { terms: free, standard: 'empty' } }));
    expect(row(p, CP_CREATE_POOL_FEE_RECEIVER)).toEqual([0n, NO_CEILING]);
  });

  it('wrapped SOL the wallet keeps, in an account set up under the old rent: the wrap’s sync credits exactly its surplus, and the opening prepares', async () => {
    const w = world({ heldWsol: 500_000_000n, wsolOptions: { native: { reserve: OLD_RESERVE } } });
    const p = ok(await create(w));
    expect(summaryOf(p).unwrapsWsol).toBe(false);
    expect(moved(p, w.wsolAta)).toBe(OLD_RESERVE_SURPLUS);
    expect(row(p, w.wsolAta)).toEqual([OLD_RESERVE_SURPLUS, NO_CEILING]);
  });

  it('a wrapped-SOL account the opening closes is still exact: it ends empty, whatever it held as reserve', async () => {
    const w = world({ heldWsol: 0n, wsolOptions: { native: { reserve: OLD_RESERVE, unsynced: 5_000n } } });
    const p = ok(await create(w));
    expect(summaryOf(p).unwrapsWsol).toBe(true);
    expect(row(p, w.wsolAta)).toEqual([0n, 0n]);
  });
});

// ── the summary must be the plan ─────────────────────────────────────────────

describe('createStepsProblem', () => {
  const pool = Keypair.generate().publicKey;
  const wsolAta = associatedTokenAddress(WSOL_MINT, ME);
  const steps = (over: Partial<Extract<IntentStep, { kind: 'pool-create' }>> = {}, o: { close?: boolean; extraCreate?: boolean; wrap?: bigint } = {}): IntentStep[] => [
    { kind: 'create-token-account', owner: ME, mint: WSOL_MINT, address: wsolAta },
    ...(o.extraCreate ? [{ kind: 'create-token-account', owner: ME, mint: WSOL_MINT, address: Keypair.generate().publicKey } as IntentStep] : []),
    { kind: 'wrap-sol', lamports: o.wrap ?? 100n },
    { kind: 'sync-wsol' },
    { kind: 'pool-create', pool, ammConfig: TIER1, init0: 100n, init1: 7n, ...over },
    ...(o.close === false ? [] : [{ kind: 'close-wsol' } as IntentStep]),
  ];
  const want = { pool, ammConfig: TIER1, init0: 100n, init1: 7n, sol: 100n, closeAfter: true, wsolAta };

  it('an opening that differs from the plan in any field is refused', () => {
    expect(createStepsProblem(steps(), want)).toBeNull();
    expect(createStepsProblem(steps({ pool: Keypair.generate().publicKey }), want)).toMatch(/does not match/);
    expect(createStepsProblem(steps({ ammConfig: Keypair.generate().publicKey }), want)).toMatch(/does not match/);
    expect(createStepsProblem(steps({ init0: 101n }), want)).toMatch(/does not match/);
    expect(createStepsProblem(steps({ init1: 6n }), want)).toMatch(/does not match/);
    expect(createStepsProblem(steps({}, { wrap: 99n }), want)).toMatch(/wrapped/);
    expect(createStepsProblem(steps({}, { extraCreate: true }), want)).toMatch(/does not open exactly your wrapped-SOL account/);
    expect(createStepsProblem(steps({}, { close: false }), want)).toMatch(/closes your wrapped-SOL/);
    expect(createStepsProblem(steps().filter((s) => s.kind !== 'pool-create'), want)).toMatch(/missing/);
  });
});

// ── the one-off key is never written anywhere ────────────────────────────────

describe('the one-off key lives only in the prepared transaction’s signers', () => {
  it('no secret in the summary, the check, the steps or the pending note; no storage written while preparing', async () => {
    const setItem = vi.fn();
    const store = { getItem: () => null, setItem, removeItem: vi.fn(), clear: vi.fn(), key: () => null, length: 0 };
    vi.stubGlobal('sessionStorage', store);
    vi.stubGlobal('localStorage', store);
    try {
      const w = world();
      squat(w);
      const p = ok(await create(w, { shown: { terms: TERMS, standard: 'taken' } }));
      expect(setItem).not.toHaveBeenCalled();
      const kp = p.extraSigners[0]!;
      const secret = kp.secretKey;
      expect(secret.subarray(32).every((b, i) => b === kp.publicKey.toBytes()[i])).toBe(true);
      const forms = [base58.encode(secret), hex.encode(secret), Array.from(secret).join(','), base58.encode(secret.subarray(0, 32)), hex.encode(secret.subarray(0, 32))];
      const seed = Array.from(secret.subarray(0, 32));
      const found: string[] = [];
      const seen = new Set<unknown>();
      const walk = (v: unknown, path: string): void => {
        if (v === kp) found.push(`${path}: the keypair itself`);
        if (typeof v === 'string') {
          for (const f of forms) if (v.includes(f)) found.push(`${path}: a string`);
          return;
        }
        if (!v || typeof v !== 'object' || seen.has(v)) return;
        seen.add(v);
        if (ArrayBuffer.isView(v)) {
          const bytes = Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
          for (let i = 0; i + 32 <= bytes.length; i++) if (seed.every((b, j) => bytes[i + j] === b)) found.push(`${path}: bytes`);
          return;
        }
        if (Array.isArray(v) && v.length >= 32 && v.every((x) => typeof x === 'number')) {
          for (let i = 0; i + 32 <= v.length; i++) if (seed.every((b, j) => v[i + j] === b)) found.push(`${path}: a number array`);
        }
        const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
        for (const [k, x] of entries) walk(x, `${path}.${String(k)}`);
      };
      const note = { kind: p.kind, signature: '5'.repeat(88), lastValidBlockHeight: p.lastValidBlockHeight, sentAt: 1, pool: p.summary.kind === 'lp-create' ? p.summary.pool.toBase58() : null };
      walk(p.summary, 'summary');
      walk(p.check, 'check');
      walk(p.steps, 'steps');
      walk(note, 'note');
      const json = JSON.stringify({ summary: p.summary, check: p.check, steps: p.steps, note }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Map ? [...v.entries()] : v));
      for (const f of forms) expect(json.includes(f)).toBe(false);
      expect(found).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── vault sizes (D20's twin) ─────────────────────────────────────────────────

describe('vaultAccountSize', () => {
  const acc = (c: FakeChain, k: PublicKey) => {
    const a = c.accounts.get(k.toBase58())!;
    return { address: k.toBase58(), owner: a.owner.toBase58(), data: a.data, lamports: a.lamports };
  };

  it('165 for a classic mint, a Token-2022 mint with no extensions, and a metadata-only one, whose ASSOCIATED account is 170; a transfer fee cannot be sized', () => {
    const c = new FakeChain();
    const [classic, bare, meta, fee] = [0, 1, 2, 3].map(() => Keypair.generate().publicKey) as [PublicKey, PublicKey, PublicKey, PublicKey];
    c.mint(classic).mint2022(bare, []).mint2022(meta, METADATA_ONLY).mint2022(fee, [[EXT.TransferFeeConfig, 108]]);
    expect(vaultAccountSize(acc(c, classic))).toBe(165);
    expect(vaultAccountSize(acc(c, bare))).toBe(165);
    expect(vaultAccountSize(acc(c, meta))).toBe(165);
    expect(tokenAccountSize(acc(c, meta))).toBe(170);
    expect(vaultAccountSize(acc(c, fee))).toMatch(/^it uses a transfer-fee setting/);
    expect(vaultAccountSize({ address: 'x', owner: STRANGER.toBase58(), data: new Uint8Array(82), lamports: 1 })).toMatch(/not owned by a token program/);
  });

  // cp-swap sizes a vault by `get_required_init_account_extensions`, which adds an account
  // extension only for a transfer fee, a non-transferable token, a transfer hook and a
  // pause switch. Interest-bearing and scaled amounts add none.
  it('165 for interest-bearing and scaled amounts too (their ASSOCIATED account is 170); every extension outside the one set cannot be sized', () => {
    const c = new FakeChain();
    for (const type of [...Object.values(EXTENSION), 99]) {
      const k = Keypair.generate().publicKey;
      c.mint2022(k, [extensionOf(type)]);
      const size = vaultAccountSize(acc(c, k));
      if (BUILDABLE_EXTENSIONS.has(type)) {
        expect(size, String(type)).toBe(165);
        expect(tokenAccountSize(acc(c, k)), String(type)).toBe(170);
      } else {
        expect(size, String(type)).toMatch(/^it uses /);
      }
    }
  });
});

// ── size ─────────────────────────────────────────────────────────────────────

describe('size', () => {
  it('the worst case (a one-off address, a Token-2022 token, the wrapped-SOL account opened and closed, two signatures) leaves 150 bytes for wallet guards', async () => {
    const w = world({ tokenProgram: TOKEN_2022_PROGRAM_ID });
    w.chain.fund(deriveVault(CPSWAP, w.standard, WSOL_MINT), 10_000_000);
    const p = ok(await create(w));
    process.stdout.write(`[size] worst-case opening: ${p.sizeBytes} of ${TX_SIZE_LIMIT} bytes\n`);
    expect(summaryOf(p).origin).toBe('other');
    expect(p.tx.compileMessage().header.numRequiredSignatures).toBe(2);
    expect(p.steps.filter((s) => s.kind === 'create-token-account')).toHaveLength(1);
    expect(p.steps.some((s) => s.kind === 'close-wsol')).toBe(true);
    expect(p.sizeBytes).toBeLessThanOrEqual(TX_SIZE_LIMIT - 150);
  });
});

// B review person-2: the refusals say the locked part the way the panel's disclosure and
// review say it, in 9 decimals. "100 pool shares" reads a billion times too large.
describe('the locked part, in the refusals', () => {
  it('too small, lock too large and the program’s own 6009 say "0.0000001 pool shares (100 of the smallest unit)", never "100 pool shares"', async () => {
    const { CREATE_FAILURE_COPY } = await import('./errors');
    const { LOCKED_SHARES_TEXT } = await import('../../../solana/lp/liquidityMath');
    expect(LOCKED_SHARES_TEXT).toBe('0.0000001 pool shares (100 of the smallest unit)');
    for (const text of [CREATE_COPY.tooSmall, CREATE_COPY.lockTooLarge('0.2'), CREATE_FAILURE_COPY.initLpAmountTooLess]) {
      expect(text).toContain(LOCKED_SHARES_TEXT);
      expect(text).not.toMatch(/(^|[^.\d])100 pool shares/);
    }
  });
});
