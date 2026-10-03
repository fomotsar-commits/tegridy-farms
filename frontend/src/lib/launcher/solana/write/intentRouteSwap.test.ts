// @vitest-environment node
//
// A swap through one of our own pools from the main swap page (`lp-swap`), read back out
// of its bytes (SPEC_S3 3.4, T-DEC-01..31).
//
// The transaction is built here the way the builder will build it (SPEC_S3 3.3 step 12):
//   buy:  open wSOL, wrap T, pay the site fee, open the token account, swap T - fee, close
//   sell: open wSOL, swap, pay the site fee, close
// and then ONE thing is changed per case, so deleting the check that guards it lets the
// transaction through. No address is typed: the fee account is the derived constant.
//
// What the six older kinds refuse is pinned, unedited, in intentPool.test.ts (P-01, P-02),
// intentCreate.test.ts and intent.test.ts.
import { describe, it, expect } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  createApproveInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createInitializeMint2Instruction,
  createSyncNativeInstruction,
  createTransferCheckedInstruction,
  createTransferInstruction,
} from '@solana/spl-token';
import { PLATFORM_TREASURY_VAULT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import {
  IX_DEPOSIT,
  IX_WITHDRAW,
  deriveAmmConfig,
  deriveLpMint,
  deriveObservation,
  deriveVault,
  sortMints,
} from '../../../solana/cpswap/program';
import { MEMO_PROGRAM_ID, depositIx, swapBaseInputIx, withdrawIx } from '../../../solana/cpswap/ix';
import { USDC_MINT } from '../../../solana';
import { SITE_SWAP_FEE_BPS, siteFee } from '../../../solana/swap/siteFee';
import { SITE_FEE_WSOL_ACCOUNT } from '../../../solana/swap/siteFeeAccount';
import { LIGHTHOUSE_PROGRAM_ID, PROGRAMS_BY_KIND, decodeIntent, isPoolIntent } from './intent';
import { CP_CREATE_POOL_FEE_RECEIVER } from './config';
import { METAPLEX_TOKEN_METADATA_ID } from './metaplex';
import { closeWsolIxs, openWsolIx, wrapIxs } from './wsol';
import { AMM_CONFIG, CPSWAP, VAULT, cfgLocal } from './testkit.fixture';
import type { CurveIntent, IntentContext, IntentStep, PoolIntent, PoolPins, RouteIntent } from './types';

const ME = Keypair.generate().publicKey;
const STRANGER = Keypair.generate().publicKey;
const fresh = () => Keypair.generate().publicKey;

const TIER0 = deriveAmmConfig(CPSWAP, 0);
const TIER1 = deriveAmmConfig(CPSWAP, 1);
const TIER2 = deriveAmmConfig(CPSWAP, 2);

/** A token mint that sorts on the wanted side of wrapped SOL, so both pool layouts are exercised. */
function mintWith(solIsToken0: boolean): PublicKey {
  for (let i = 0; i < 20_000; i++) {
    const m = fresh();
    if (sortMints(WSOL_MINT, m).token0.equals(WSOL_MINT) === solIsToken0) return m;
  }
  throw new Error('no mint found on that side of wrapped SOL');
}

/** A pool's pins, derived the way poolPins() derives them. */
function pinsFor(o: { tokenProgram?: PublicKey; solIsToken0?: boolean; ammConfig?: PublicKey; origin?: PoolPins['origin'] } = {}): PoolPins {
  const address = fresh();
  const tokenMint = mintWith(o.solIsToken0 ?? true);
  const tokenProgram = o.tokenProgram ?? TOKEN_PROGRAM_ID;
  const { token0, token1 } = sortMints(WSOL_MINT, tokenMint);
  const solIsToken0 = token0.equals(WSOL_MINT);
  const lpMint = deriveLpMint(CPSWAP, address);
  return {
    address,
    ammConfig: o.ammConfig ?? TIER0,
    origin: o.origin ?? 'standard',
    token0Mint: token0,
    token1Mint: token1,
    token0Program: solIsToken0 ? TOKEN_PROGRAM_ID : tokenProgram,
    token1Program: solIsToken0 ? tokenProgram : TOKEN_PROGRAM_ID,
    vault0: deriveVault(CPSWAP, address, token0),
    vault1: deriveVault(CPSWAP, address, token1),
    lpMint,
    observation: deriveObservation(CPSWAP, address),
    tokenMint,
    tokenProgram,
    solIsToken0,
    lpAccount: associatedTokenAddress(lpMint, ME, TOKEN_PROGRAM_ID),
  };
}

const CAP = 1_000_000n;
const ctx = (side: 'buy' | 'sell', pins: PoolPins): RouteIntent => ({
  kind: 'lp-swap',
  side,
  signer: ME,
  cfg: cfgLocal,
  maxPriorityLamports: CAP,
  pins,
});

const MY_WSOL = associatedTokenAddress(WSOL_MINT, ME);
const prog = (p: PoolPins, m: PublicKey) => (m.equals(WSOL_MINT) ? TOKEN_PROGRAM_ID : p.tokenProgram);
const mine = (p: PoolPins, m: PublicKey) => associatedTokenAddress(m, ME, prog(p, m));
const vaultOf = (p: PoolPins, m: PublicKey) => (m.equals(p.token0Mint) ? p.vault0 : p.vault1);

/** The swap exactly as the builder makes it: every account from the pins. */
function swapIx(p: PoolPins, side: 'buy' | 'sell', amountIn: bigint, minimumAmountOut: bigint): TransactionInstruction {
  const [inMint, outMint] = side === 'buy' ? [WSOL_MINT, p.tokenMint] : [p.tokenMint, WSOL_MINT];
  return swapBaseInputIx({
    programId: CPSWAP,
    payer: ME,
    ammConfig: p.ammConfig,
    poolState: p.address,
    inputTokenAccount: mine(p, inMint),
    outputTokenAccount: mine(p, outMint),
    inputVault: vaultOf(p, inMint),
    outputVault: vaultOf(p, outMint),
    inputTokenProgram: prog(p, inMint),
    outputTokenProgram: prog(p, outMint),
    inputTokenMint: inMint,
    outputTokenMint: outMint,
    observationState: p.observation,
    amountIn,
    minimumAmountOut,
  });
}

/** The site fee exactly as the builder makes it. */
const feeIx = (amount: bigint, o: Partial<{ from: PublicKey; mint: PublicKey; to: PublicKey; authority: PublicKey; decimals: number }> = {}) =>
  createTransferCheckedInstruction(
    o.from ?? MY_WSOL,
    o.mint ?? WSOL_MINT,
    o.to ?? SITE_FEE_WSOL_ACCOUNT,
    o.authority ?? ME,
    amount,
    o.decimals ?? 9,
    [],
    TOKEN_PROGRAM_ID,
  );

const tokenAtaIx = (p: PoolPins) =>
  createAssociatedTokenAccountIdempotentInstruction(ME, mine(p, p.tokenMint), ME, p.tokenMint, p.tokenProgram);

const closeIxs = () => closeWsolIxs({ ata: MY_WSOL, closeAfter: true, heldBefore: 0n }, ME);

// The buy: 1 SOL typed. The fee is floor(T x 50 / 10000); the pool gets the rest.
const T = 1_000_000_199n;
const BUY_FEE = siteFee(T);
const BUY_MIN = 2_295_000_000n;
// The sell: the fee is floor(minimum x 50 / 10000).
const SELL_IN = 2_000_000_000_000n;
const SELL_MIN = 834_885_819n;
const SELL_FEE = siteFee(SELL_MIN);

interface BuyParts {
  open: TransactionInstruction[];
  wrap: TransactionInstruction[];
  fee: TransactionInstruction[];
  tokenAta: TransactionInstruction[];
  swap: TransactionInstruction[];
  close: TransactionInstruction[];
}
const buyParts = (p: PoolPins): BuyParts => ({
  open: [openWsolIx(ME)],
  wrap: wrapIxs(ME, T),
  fee: [feeIx(BUY_FEE)],
  tokenAta: [tokenAtaIx(p)],
  swap: [swapIx(p, 'buy', T - BUY_FEE, BUY_MIN)],
  close: closeIxs(),
});
const buyBody = (p: PoolPins, over: Partial<BuyParts> = {}): TransactionInstruction[] => {
  const b = { ...buyParts(p), ...over };
  return [...b.open, ...b.wrap, ...b.fee, ...b.tokenAta, ...b.swap, ...b.close];
};

interface SellParts {
  open: TransactionInstruction[];
  swap: TransactionInstruction[];
  fee: TransactionInstruction[];
  close: TransactionInstruction[];
}
const sellParts = (p: PoolPins): SellParts => ({
  open: [openWsolIx(ME)],
  swap: [swapIx(p, 'sell', SELL_IN, SELL_MIN)],
  fee: [feeIx(SELL_FEE)],
  close: closeIxs(),
});
const sellBody = (p: PoolPins, over: Partial<SellParts> = {}): TransactionInstruction[] => {
  const s = { ...sellParts(p), ...over };
  return [...s.open, ...s.swap, ...s.fee, ...s.close];
};

/** The same instruction with one account slot replaced. */
const withKey = (ix: TransactionInstruction, i: number, pubkey: PublicKey) =>
  new TransactionInstruction({ programId: ix.programId, keys: ix.keys.map((k, n) => (n === i ? { ...k, pubkey } : k)), data: ix.data });

const withData = (ix: TransactionInstruction, data: Uint8Array) =>
  new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data: Buffer.from(data) });

const ok = (ixs: TransactionInstruction[], c: IntentContext, opts?: { allowWalletGuards?: boolean }): IntentStep[] => {
  const r = decodeIntent(ixs, c, opts);
  expect(r.ok, r.ok ? '' : r.reason).toBe(true);
  return r.ok ? r.steps : [];
};

const refused = (ixs: TransactionInstruction[], why: RegExp, c: IntentContext, opts?: { allowWalletGuards?: boolean }) => {
  const r = decodeIntent(ixs, c, opts);
  expect(r.ok, `expected a refusal matching ${why}`).toBe(false);
  if (!r.ok) expect(r.reason).toMatch(why);
};

const LAYOUTS: Array<[string, { tokenProgram: PublicKey; solIsToken0: boolean }]> = [
  ['a classic token, SOL as token 0', { tokenProgram: TOKEN_PROGRAM_ID, solIsToken0: true }],
  ['a classic token, SOL as token 1', { tokenProgram: TOKEN_PROGRAM_ID, solIsToken0: false }],
  ['a Token-2022 token, SOL as token 0', { tokenProgram: TOKEN_2022_PROGRAM_ID, solIsToken0: true }],
  ['a Token-2022 token, SOL as token 1', { tokenProgram: TOKEN_2022_PROGRAM_ID, solIsToken0: false }],
];

describe('T-DEC-01: the swap this site builds decodes into steps a person can read', () => {
  it('the fixture really covers both pool layouts', () => {
    expect(pinsFor({ solIsToken0: true }).solIsToken0).toBe(true);
    expect(pinsFor({ solIsToken0: false }).solIsToken0).toBe(false);
  });

  it.each(LAYOUTS)('a buy of %s', (_name, layout) => {
    const p = pinsFor(layout);
    const steps = ok(buyBody(p), ctx('buy', p));
    expect(steps.map((s) => s.kind)).toEqual([
      'create-token-account', 'wrap-sol', 'sync-wsol', 'site-fee', 'create-token-account', 'pool-swap', 'close-wsol',
    ]);
    expect(steps[1]).toEqual({ kind: 'wrap-sol', lamports: T });
    expect(steps[3]).toEqual({ kind: 'site-fee', from: MY_WSOL, to: SITE_FEE_WSOL_ACCOUNT, amount: BUY_FEE });
    expect(steps[4]).toMatchObject({ kind: 'create-token-account', mint: p.tokenMint, address: mine(p, p.tokenMint) });
    expect(steps[5]).toEqual({
      kind: 'pool-swap', pool: p.address, inputMint: WSOL_MINT, outputMint: p.tokenMint, amountIn: T - BUY_FEE, minimumAmountOut: BUY_MIN,
    });
  });

  it.each(LAYOUTS)('a sell of %s', (_name, layout) => {
    const p = pinsFor(layout);
    const steps = ok(sellBody(p), ctx('sell', p));
    expect(steps.map((s) => s.kind)).toEqual(['create-token-account', 'pool-swap', 'site-fee', 'close-wsol']);
    expect(steps[1]).toEqual({
      kind: 'pool-swap', pool: p.address, inputMint: p.tokenMint, outputMint: WSOL_MINT, amountIn: SELL_IN, minimumAmountOut: SELL_MIN,
    });
    expect(steps[2]).toEqual({ kind: 'site-fee', from: MY_WSOL, to: SITE_FEE_WSOL_ACCOUNT, amount: SELL_FEE });
  });

  it('the numbers are the spec’s: 0.5%, floored, off the SOL side', () => {
    expect(SITE_SWAP_FEE_BPS).toBe(50n);
    expect(BUY_FEE).toBe(5_000_000n);
    expect(SELL_FEE).toBe(4_174_429n);
  });

  it('a pool on the public tier (tier 1) and a launch pool decode the same way', () => {
    const p1 = pinsFor({ ammConfig: TIER1 });
    ok(buyBody(p1), ctx('buy', p1));
    ok(sellBody(p1), ctx('sell', p1));
    const launch = pinsFor({ origin: 'launch-pool' });
    ok(buyBody(launch), ctx('buy', launch));
    const other = pinsFor({ origin: 'other', ammConfig: TIER1 });
    ok(sellBody(other), ctx('sell', other));
    expect(AMM_CONFIG.equals(TIER0)).toBe(true);
  });

  it('a kept wrapped-SOL account: no close, and no account to open, still decode', () => {
    const p = pinsFor();
    ok(buyBody(p, { close: [], open: [], tokenAta: [] }), ctx('buy', p));
    ok(sellBody(p, { close: [], open: [] }), ctx('sell', p));
  });

  it('order is not pinned: a sell whose fee comes first decodes to the same steps', () => {
    const p = pinsFor();
    const s = sellParts(p);
    const steps = ok([...s.open, ...s.fee, ...s.swap, ...s.close], ctx('sell', p));
    expect(steps.filter((x) => x.kind === 'site-fee')).toHaveLength(1);
  });

  it('it is a pool intent, and it reaches exactly the programs a wrap, a fee and a swap need', () => {
    expect(isPoolIntent(ctx('buy', pinsFor()))).toBe(true);
    expect([...PROGRAMS_BY_KIND['lp-swap']].sort()).toEqual(['ata', 'compute', 'pool', 'system', 'token']);
  });

  it('the fee account is the team vault’s wrapped-SOL account, the same one openings pay', () => {
    expect(SITE_FEE_WSOL_ACCOUNT.equals(associatedTokenAddress(WSOL_MINT, PLATFORM_TREASURY_VAULT))).toBe(true);
    expect(SITE_FEE_WSOL_ACCOUNT.equals(CP_CREATE_POOL_FEE_RECEIVER)).toBe(true);
    expect(PLATFORM_TREASURY_VAULT.equals(VAULT)).toBe(true);
  });
});

describe('T-DEC-02..14: every one of the swap’s 13 accounts is pinned', () => {
  const SLOTS: Array<[number, string, RegExp]> = [
    [0, 'payer', /the swap is paid by someone else/],
    [1, 'authority', /the swap names the wrong pool authority/],
    [2, 'amm_config', /the swap names the wrong fee settings/],
    [3, 'pool_state', /the swap is against a different pool than the one checked/],
    [4, 'input_token_account', /the swap spends from an account that is not yours/],
    [5, 'output_token_account', /the swap pays out to an account that is not yours/],
    [6, 'input_vault', /the swap names the wrong pool vault/],
    [7, 'output_vault', /the swap names the wrong pool vault/],
    [8, 'input_token_program', /the swap names the wrong token program/],
    [9, 'output_token_program', /the swap names the wrong token program/],
    [10, 'input_token_mint', /not between SOL and this token in the reviewed direction/],
    [11, 'output_token_mint', /not between SOL and this token in the reviewed direction/],
    [12, 'observation_state', /the swap names the wrong price record/],
  ];

  it.each(SLOTS)('slot %i (%s) replaced by a fresh key is refused, buy and sell', (i, _name, why) => {
    const p = pinsFor({ tokenProgram: TOKEN_2022_PROGRAM_ID });
    refused(buyBody(p, { swap: [withKey(swapIx(p, 'buy', T - BUY_FEE, BUY_MIN), i, fresh())] }), why, ctx('buy', p));
    refused(sellBody(p, { swap: [withKey(swapIx(p, 'sell', SELL_IN, SELL_MIN), i, fresh())] }), why, ctx('sell', p));
  });

  it('slot 5, the payout: a stranger’s own account for the right token is refused (the pool program would pay it)', () => {
    const p = pinsFor();
    const theirs = associatedTokenAddress(p.tokenMint, STRANGER, p.tokenProgram);
    refused(buyBody(p, { swap: [withKey(swapIx(p, 'buy', T - BUY_FEE, BUY_MIN), 5, theirs)] }), /pays out to an account that is not yours/, ctx('buy', p));
    const theirWsol = associatedTokenAddress(WSOL_MINT, STRANGER);
    refused(sellBody(p, { swap: [withKey(swapIx(p, 'sell', SELL_IN, SELL_MIN), 5, theirWsol)] }), /pays out to an account that is not yours/, ctx('sell', p));
    // And the site's own fee account as the payout.
    refused(sellBody(p, { swap: [withKey(swapIx(p, 'sell', SELL_IN, SELL_MIN), 5, SITE_FEE_WSOL_ACCOUNT)] }), /pays out to an account that is not yours/, ctx('sell', p));
  });

  it('a Token-2022 token: your classic-seeded account for it, and the classic program in its slot, are refused', () => {
    const p = pinsFor({ tokenProgram: TOKEN_2022_PROGRAM_ID });
    const classicSeeded = associatedTokenAddress(p.tokenMint, ME, TOKEN_PROGRAM_ID);
    refused(buyBody(p, { swap: [withKey(swapIx(p, 'buy', T - BUY_FEE, BUY_MIN), 5, classicSeeded)] }), /pays out to an account that is not yours/, ctx('buy', p));
    refused(sellBody(p, { swap: [withKey(swapIx(p, 'sell', SELL_IN, SELL_MIN), 4, classicSeeded)] }), /spends from an account that is not yours/, ctx('sell', p));
    refused(buyBody(p, { swap: [withKey(swapIx(p, 'buy', T - BUY_FEE, BUY_MIN), 9, TOKEN_PROGRAM_ID)] }), /the wrong token program/, ctx('buy', p));
    refused(sellBody(p, { swap: [withKey(swapIx(p, 'sell', SELL_IN, SELL_MIN), 8, TOKEN_PROGRAM_ID)] }), /the wrong token program/, ctx('sell', p));
    // Wrapped SOL is always classic: Token-2022 in ITS slot is refused too.
    refused(buyBody(p, { swap: [withKey(swapIx(p, 'buy', T - BUY_FEE, BUY_MIN), 8, TOKEN_2022_PROGRAM_ID)] }), /the wrong token program/, ctx('buy', p));
  });

  it('the two vaults the wrong way round are refused', () => {
    const p = pinsFor();
    const s = swapIx(p, 'buy', T - BUY_FEE, BUY_MIN);
    const swapped = withKey(withKey(s, 6, s.keys[7]!.pubkey), 7, s.keys[6]!.pubkey);
    refused(buyBody(p, { swap: [swapped] }), /the swap names the wrong pool vault/, ctx('buy', p));
  });

  it('slot 2: another tier’s settings than the pool’s own are refused, tier 2 and tier 1 alike', () => {
    const p = pinsFor();
    for (const other of [TIER2, TIER1]) {
      refused(buyBody(p, { swap: [withKey(swapIx(p, 'buy', T - BUY_FEE, BUY_MIN), 2, other)] }), /the swap names the wrong fee settings/, ctx('buy', p));
    }
  });

  it('slot 2: a pool that really is on tier 2 is refused even though the swap names the pool’s own settings', () => {
    const p = pinsFor({ ammConfig: TIER2 });
    refused(buyBody(p), /a fee tier this site does not route to/, ctx('buy', p));
    refused(sellBody(p), /a fee tier this site does not route to/, ctx('sell', p));
    // ...and so is one whose settings account is not a tier of this pool program at all.
    const q = pinsFor({ ammConfig: fresh() });
    refused(buyBody(q), /a fee tier this site does not route to/, ctx('buy', q));
  });

  it('the mints reversed for the side: a sell under a reviewed buy, and a buy under a reviewed sell', () => {
    const p = pinsFor();
    const why = /not between SOL and this token in the reviewed direction/;
    refused(buyBody(p, { swap: [swapIx(p, 'sell', T - BUY_FEE, BUY_MIN)] }), why, ctx('buy', p));
    refused(sellBody(p, { swap: [swapIx(p, 'buy', SELL_IN, SELL_MIN)] }), why, ctx('sell', p));
  });

  it('a swap against another pool of the same token, with that pool’s own accounts, is refused', () => {
    const p = pinsFor();
    const other: PoolPins = { ...p, address: fresh() };
    other.vault0 = deriveVault(CPSWAP, other.address, p.token0Mint);
    other.vault1 = deriveVault(CPSWAP, other.address, p.token1Mint);
    other.observation = deriveObservation(CPSWAP, other.address);
    refused(buyBody(p, { swap: [swapIx(other, 'buy', T - BUY_FEE, BUY_MIN)] }), /a different pool than the one checked/, ctx('buy', p));
  });

  it('pins that do not pair SOL with the token are refused before any slot is read', () => {
    const p = pinsFor();
    const bad: PoolPins = { ...p, token0Mint: fresh(), token1Mint: fresh() };
    refused(buyBody(p), /the pool checked does not pair SOL with this token/, ctx('buy', bad));
    const twice: PoolPins = { ...p, token0Mint: WSOL_MINT, token1Mint: WSOL_MINT };
    refused(buyBody(p), /the pool checked does not pair SOL with this token/, ctx('buy', twice));
  });

  it('a side that is neither buy nor sell is refused', () => {
    const p = pinsFor();
    const c = { ...ctx('buy', p), side: 'both' } as unknown as RouteIntent;
    refused(buyBody(p), /the swap has no reviewed direction/, c);
  });

  it('12 or 14 accounts, and data of another size, are refused', () => {
    const p = pinsFor();
    const s = swapIx(p, 'buy', T - BUY_FEE, BUY_MIN);
    const short = new TransactionInstruction({ programId: s.programId, keys: s.keys.slice(0, 12), data: s.data });
    const long = new TransactionInstruction({ programId: s.programId, keys: [...s.keys, { pubkey: fresh(), isSigner: false, isWritable: true }], data: s.data });
    refused(buyBody(p, { swap: [short] }), /pool swap has 12 accounts, expected 13/, ctx('buy', p));
    refused(buyBody(p, { swap: [long] }), /pool swap has 14 accounts, expected 13/, ctx('buy', p));
    refused(buyBody(p, { swap: [withData(s, new Uint8Array([...s.data, 0]))] }), /a pool instruction other than a swap/, ctx('buy', p));
  });
});

describe('T-DEC-15..26: the site fee goes to one derived account, at one committed rate', () => {
  const p = pinsFor();
  const buy = ctx('buy', p);
  const sell = ctx('sell', p);
  const both = (fee: TransactionInstruction[], why: RegExp) => {
    refused(buyBody(p, { fee }), why, buy);
    refused(sellBody(p, { fee }), why, sell);
  };

  it('to your own wrapped-SOL account', () => {
    refused(buyBody(p, { fee: [feeIx(BUY_FEE, { to: MY_WSOL })] }), /somewhere other than the site's fee account/, buy);
    refused(sellBody(p, { fee: [feeIx(SELL_FEE, { to: MY_WSOL })] }), /somewhere other than the site's fee account/, sell);
  });

  it('to the vault wallet itself, to the vault’s USDC account, to a stranger’s wrapped-SOL account', () => {
    const vaultUsdc = associatedTokenAddress(new PublicKey(USDC_MINT), PLATFORM_TREASURY_VAULT);
    for (const to of [PLATFORM_TREASURY_VAULT, vaultUsdc, associatedTokenAddress(WSOL_MINT, STRANGER), fresh()]) {
      refused(buyBody(p, { fee: [feeIx(BUY_FEE, { to })] }), /somewhere other than the site's fee account/, buy);
      refused(sellBody(p, { fee: [feeIx(SELL_FEE, { to })] }), /somewhere other than the site's fee account/, sell);
    }
  });

  it('the fee one unit above and one unit below, on a buy', () => {
    for (const amount of [BUY_FEE + 1n, BUY_FEE - 1n]) {
      refused(buyBody(p, { fee: [feeIx(amount)] }), /the site fee is not 0\.5% of the SOL you pay/, buy);
    }
  });

  it('a buy whose fee is right for a smaller wrap, with the swap adjusted to match the bigger one, is still refused', () => {
    // fee + swap == wrap holds, but the fee is not 0.5% of the wrap.
    const fee = BUY_FEE * 2n;
    refused(buyBody(p, { fee: [feeIx(fee)], swap: [swapIx(p, 'buy', T - fee, BUY_MIN)] }), /the site fee is not 0\.5% of the SOL you pay/, buy);
  });

  it('the fee one unit above and one unit below, on a sell', () => {
    for (const amount of [SELL_FEE + 1n, SELL_FEE - 1n]) {
      refused(sellBody(p, { fee: [feeIx(amount)] }), /the site fee is not 0\.5% of the minimum the pool must pay you/, sell);
    }
  });

  it('a sell’s fee follows the minimum in the bytes: lower the minimum and the same fee is refused', () => {
    refused(sellBody(p, { swap: [swapIx(p, 'sell', SELL_IN, SELL_MIN - 200n)] }), /not 0\.5% of the minimum the pool must pay you/, sell);
    // Rounding: 199 more of minimum is the same floor, so it still decodes.
    expect(siteFee(SELL_MIN + 100n)).toBe(SELL_FEE);
    ok(sellBody(p, { swap: [swapIx(p, 'sell', SELL_IN, SELL_MIN + 100n)] }), sell);
  });

  it('no fee, and two fees', () => {
    both([], /it does not pay the site fee exactly once/);
    refused(buyBody(p, { fee: [feeIx(BUY_FEE), feeIx(BUY_FEE)] }), /it does not pay the site fee exactly once/, buy);
    refused(sellBody(p, { fee: [feeIx(SELL_FEE), feeIx(SELL_FEE)] }), /it does not pay the site fee exactly once/, sell);
    // Two halves that add up to the fee are still two fees.
    refused(buyBody(p, { fee: [feeIx(BUY_FEE - 1n), feeIx(1n)] }), /it does not pay the site fee exactly once/, buy);
  });

  it('the fee as a plain Transfer (tag 3), even to the right account for the right amount', () => {
    const plain = (amount: bigint) => createTransferInstruction(MY_WSOL, SITE_FEE_WSOL_ACCOUNT, ME, amount);
    expect(plain(1n).data[0]).toBe(3);
    refused(buyBody(p, { fee: [plain(BUY_FEE)] }), /a token instruction this page never builds/, buy);
    refused(sellBody(p, { fee: [plain(SELL_FEE)] }), /a token instruction this page never builds/, sell);
  });

  it('an approval (tag 4) of the site’s fee account, or of anyone, is refused', () => {
    const approve = createApproveInstruction(MY_WSOL, SITE_FEE_WSOL_ACCOUNT, ME, BUY_FEE);
    expect(approve.data[0]).toBe(4);
    refused([...buyBody(p), approve], /a token instruction this page never builds/, buy);
  });

  it('decimals other than 9, and data of another size', () => {
    refused(buyBody(p, { fee: [feeIx(BUY_FEE, { decimals: 6 })] }), /the site fee instruction has the wrong size or decimals/, buy);
    const f = feeIx(BUY_FEE);
    refused(buyBody(p, { fee: [withData(f, new Uint8Array([...f.data, 0]))] }), /the site fee instruction has the wrong size or decimals/, buy);
    refused(buyBody(p, { fee: [withData(f, f.data.subarray(0, 9))] }), /the site fee instruction has the wrong size or decimals/, buy);
  });

  it('a mint other than wrapped SOL', () => {
    both([feeIx(BUY_FEE, { mint: p.tokenMint })], /the site fee moves a token other than wrapped SOL/);
  });

  it('paid from an account that is not your wrapped-SOL account', () => {
    for (const from of [associatedTokenAddress(WSOL_MINT, STRANGER), mine(p, p.tokenMint), SITE_FEE_WSOL_ACCOUNT]) {
      refused(buyBody(p, { fee: [feeIx(BUY_FEE, { from })] }), /paid from an account that is not your wrapped-SOL account/, buy);
    }
  });

  it('authorised by someone other than you', () => {
    both([feeIx(BUY_FEE, { authority: STRANGER })], /the site fee is authorised by someone other than you/);
  });

  it('a fifth account (a multisig signer), or one too few', () => {
    const f = feeIx(BUY_FEE);
    const five = new TransactionInstruction({ programId: f.programId, keys: [...f.keys, { pubkey: STRANGER, isSigner: true, isWritable: false }], data: f.data });
    const three = new TransactionInstruction({ programId: f.programId, keys: f.keys.slice(0, 3), data: f.data });
    refused(buyBody(p, { fee: [five] }), /the site fee names the wrong accounts/, buy);
    refused(buyBody(p, { fee: [three] }), /the site fee names the wrong accounts/, buy);
  });

  it('an amount of zero', () => {
    both([feeIx(0n)], /the site fee is zero/);
    // Even when zero IS floor(0.5%) of the wrap: a buy too small to carry a fee is not built.
    const tiny = 199n;
    expect(siteFee(tiny)).toBe(0n);
    refused(
      [openWsolIx(ME), ...wrapIxs(ME, tiny), feeIx(0n), swapIx(p, 'buy', tiny, 1n)],
      /the site fee is zero/,
      buy,
    );
  });
});

describe('T-DEC-27: the site-fee shape is refused in every other kind', () => {
  const p = pinsFor();
  const pool = (kind: PoolIntent['kind']): PoolIntent => ({ kind, signer: ME, cfg: cfgLocal, maxPriorityLamports: CAP, pins: p });
  const curve = (kind: CurveIntent['kind']): CurveIntent => ({
    kind, signer: ME, cfg: cfgLocal, feeRecipient: VAULT, ammConfig: AMM_CONFIG, mint: p.tokenMint, maxPriorityLamports: CAP,
  });
  const OTHERS: [string, IntentContext][] = [
    ['lp-deposit', pool('lp-deposit')],
    ['lp-withdraw', pool('lp-withdraw')],
    ['lp-create', pool('lp-create')],
    ['pool-buy', curve('pool-buy')],
    ['pool-sell', curve('pool-sell')],
    ['create', curve('create')],
  ];

  it.each(OTHERS)('%s: the exact honest site fee is "a token instruction this page never builds"', (_name, c) => {
    refused([feeIx(BUY_FEE)], /a token instruction this page never builds/, c);
  });

  it('only lp-swap accepts it: every other kind that reaches the token program is in the list above', () => {
    const reachToken = (Object.keys(PROGRAMS_BY_KIND) as (keyof typeof PROGRAMS_BY_KIND)[]).filter((k) => PROGRAMS_BY_KIND[k].has('token'));
    expect(reachToken.sort()).toEqual([...OTHERS.map(([name]) => name), 'lp-swap'].sort());
  });
});

describe('T-DEC-28: the whole transaction has the shape of one buy or one sell', () => {
  const p = pinsFor();
  const buy = ctx('buy', p);
  const sell = ctx('sell', p);

  it('a buy whose swap does not put in exactly the wrap less the fee', () => {
    for (const amountIn of [T - BUY_FEE - 1n, T - BUY_FEE + 1n, T]) {
      refused(buyBody(p, { swap: [swapIx(p, 'buy', amountIn, BUY_MIN)] }), /does not put in exactly what you pay less the site fee/, buy);
    }
  });

  it('a buy with no wrap, with two wraps, or with a second sync', () => {
    const why = /a buy must wrap your SOL exactly once/;
    refused(buyBody(p, { wrap: [] }), why, buy);
    refused(buyBody(p, { wrap: [...wrapIxs(ME, T), ...wrapIxs(ME, T)] }), why, buy);
    refused(buyBody(p, { wrap: [...wrapIxs(ME, T), createSyncNativeInstruction(MY_WSOL)] }), why, buy);
    // A transfer without its sync, and a sync without a transfer.
    refused(buyBody(p, { wrap: [wrapIxs(ME, T)[0]!] }), why, buy);
    refused(buyBody(p, { wrap: [createSyncNativeInstruction(MY_WSOL)] }), why, buy);
  });

  it('a sell that wraps SOL, or only syncs', () => {
    refused([...wrapIxs(ME, 1_000n), ...sellBody(p)], /a sell never wraps SOL/, sell);
    refused([createSyncNativeInstruction(MY_WSOL), ...sellBody(p)], /a sell never wraps SOL/, sell);
    refused([wrapIxs(ME, 1_000n)[0]!, ...sellBody(p)], /a sell never wraps SOL/, sell);
  });

  it('a second close of the wrapped-SOL account', () => {
    const why = /it closes your wrapped-SOL account more than once/;
    refused(buyBody(p, { close: [...closeIxs(), ...closeIxs()] }), why, buy);
    refused(sellBody(p, { close: [...closeIxs(), ...closeIxs()] }), why, sell);
  });

  it('a third account opened on a buy, a second on a sell', () => {
    const why = /it opens more token accounts than a swap needs/;
    refused(buyBody(p, { tokenAta: [tokenAtaIx(p), tokenAtaIx(p)] }), why, buy);
    refused(sellBody(p, { open: [openWsolIx(ME), tokenAtaIx(p)] }), why, sell);
    // Within the limit: a sell may open one, a buy two.
    ok(sellBody(p, { open: [tokenAtaIx(p)] }), sell);
  });

  it('an account for the pool’s shares, or for an unrelated token', () => {
    const lp = createAssociatedTokenAccountIdempotentInstruction(ME, associatedTokenAddress(p.lpMint, ME), ME, p.lpMint, TOKEN_PROGRAM_ID);
    refused(buyBody(p, { tokenAta: [lp] }), /a swap never opens a pool-share account/, buy);
    refused(sellBody(p, { open: [lp] }), /a swap never opens a pool-share account/, sell);
    const m = fresh();
    const unrelated = createAssociatedTokenAccountIdempotentInstruction(ME, associatedTokenAddress(m, ME), ME, m, TOKEN_PROGRAM_ID);
    refused(buyBody(p, { tokenAta: [unrelated] }), /creates a token account for an unrelated token/, buy);
  });

  it('a token account for someone else, or the Token-2022 token’s under the classic program', () => {
    const t22 = pinsFor({ tokenProgram: TOKEN_2022_PROGRAM_ID });
    const classic = createAssociatedTokenAccountIdempotentInstruction(
      ME, associatedTokenAddress(t22.tokenMint, ME, TOKEN_PROGRAM_ID), ME, t22.tokenMint, TOKEN_PROGRAM_ID,
    );
    refused(buyBody(t22, { tokenAta: [classic] }), /under the wrong programs/, ctx('buy', t22));
    const theirs = createAssociatedTokenAccountIdempotentInstruction(
      ME, associatedTokenAddress(p.tokenMint, STRANGER), STRANGER, p.tokenMint, TOKEN_PROGRAM_ID,
    );
    refused(buyBody(p, { tokenAta: [theirs] }), /creates a token account for someone else/, buy);
  });

  it('two swaps, or none', () => {
    const why = /it does not hold exactly one swap through the pool/;
    refused(buyBody(p, { swap: [swapIx(p, 'buy', T - BUY_FEE, BUY_MIN), swapIx(p, 'buy', T - BUY_FEE, BUY_MIN)] }), why, buy);
    refused(buyBody(p, { swap: [] }), why, buy);
    refused(sellBody(p, { swap: [] }), why, sell);
  });

  it('a deposit, a withdrawal or an exact-output swap in place of the swap', () => {
    const common = {
      programId: CPSWAP, owner: ME, poolState: p.address,
      token0Account: mine(p, p.token0Mint), token1Account: mine(p, p.token1Mint),
      token0Vault: p.vault0, token1Vault: p.vault1, vault0Mint: p.token0Mint, vault1Mint: p.token1Mint, lpMint: p.lpMint,
      ownerLpToken: p.lpAccount, lpTokenAmount: 1_000n,
    };
    const dep = depositIx({ ...common, maximumToken0Amount: 5n, maximumToken1Amount: 7n });
    const wd = withdrawIx({ ...common, minimumToken0Amount: 5n, minimumToken1Amount: 7n });
    expect(Buffer.from(dep.data.subarray(0, 8)).equals(Buffer.from(IX_DEPOSIT))).toBe(true);
    expect(Buffer.from(wd.data.subarray(0, 8)).equals(Buffer.from(IX_WITHDRAW))).toBe(true);
    const why = /a pool instruction other than a swap/;
    refused(buyBody(p, { swap: [dep] }), why, buy);
    refused(sellBody(p, { swap: [wd] }), why, sell);
    // swap_base_output: the same accounts, another discriminator.
    const s = swapIx(p, 'buy', T - BUY_FEE, BUY_MIN);
    const other = new Uint8Array(s.data);
    other.set([55, 217, 98, 86, 163, 74, 180, 173], 0);
    refused(buyBody(p, { swap: [withData(s, other)] }), why, buy);
  });
});

describe('T-DEC-29: the fee account is never paid SOL and never synced (mainnet would re-price its reserve)', () => {
  const p = pinsFor();
  it.each(['buy', 'sell'] as const)('%s: a System transfer to it, and a SyncNative on it, are refused', (side) => {
    const c = ctx(side, p);
    const body = side === 'buy' ? buyBody(p) : sellBody(p);
    const pay = SystemProgram.transfer({ fromPubkey: ME, toPubkey: SITE_FEE_WSOL_ACCOUNT, lamports: 100_000 });
    refused([...body, pay], /a SOL transfer to an account that is not your own wrapped-SOL account/, c);
    refused([...body, createSyncNativeInstruction(SITE_FEE_WSOL_ACCOUNT)], /syncs an account that is not your wrapped-SOL account/, c);
    // The dry-run-B shape in place of the fee: a transfer and a sync instead of TransferChecked.
    const fee = [pay, createSyncNativeInstruction(SITE_FEE_WSOL_ACCOUNT)];
    refused(side === 'buy' ? buyBody(p, { fee }) : sellBody(p, { fee }), /a SOL transfer to an account that is not your own wrapped-SOL account/, c);
  });

  it('a close of any account but your wrapped SOL, or one that pays someone else', () => {
    const c = ctx('sell', p);
    const closeToken = createCloseAccountInstruction(mine(p, p.tokenMint), ME, ME);
    refused(sellBody(p, { close: [closeToken] }), /closes an account that is not your wrapped-SOL account/, c);
    refused(sellBody(p, { close: [createCloseAccountInstruction(MY_WSOL, STRANGER, ME)] }), /closes an account and pays someone else/, c);
    refused(sellBody(p, { close: [createCloseAccountInstruction(MY_WSOL, SITE_FEE_WSOL_ACCOUNT, ME)] }), /closes an account and pays someone else/, c);
  });
});

describe('T-DEC-30: amounts with no limit, and the priority fee', () => {
  const p = pinsFor();
  it('a minimum of zero, and an amount of zero', () => {
    // On a sell the fee is 0.5% of the minimum, so a zero minimum also means no fee: both say no.
    refused(buyBody(p, { swap: [swapIx(p, 'buy', T - BUY_FEE, 0n)] }), /the swap accepts any price \(no minimum\)/, ctx('buy', p));
    refused(sellBody(p, { swap: [swapIx(p, 'sell', SELL_IN, 0n)] }), /the swap accepts any price \(no minimum\)/, ctx('sell', p));
    refused(sellBody(p, { swap: [swapIx(p, 'sell', 0n, SELL_MIN)] }), /the swap amount is zero/, ctx('sell', p));
    refused(buyBody(p, { swap: [swapIx(p, 'buy', 0n, BUY_MIN)] }), /the swap amount is zero/, ctx('buy', p));
  });

  it('a priority fee above the cap is refused; at the cap it decodes', () => {
    const limit = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
    const at = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000_000n });
    const above = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000_005n });
    ok([limit, at, ...buyBody(p)], ctx('buy', p));
    refused([limit, above, ...buyBody(p)], /its priority fee is above this page’s limit/, ctx('buy', p));
    refused([limit, limit, at, ...sellBody(p)], /it sets the network fee more than once/, ctx('sell', p));
  });
});

describe('T-DEC-31 and the refusals every pool intent inherits', () => {
  const p = pinsFor();
  const guard = new TransactionInstruction({ programId: LIGHTHOUSE_PROGRAM_ID, keys: [], data: Buffer.from([1, 2, 3]) });

  it('a Lighthouse guard passes only on the transaction a wallet hands back', () => {
    refused([...buyBody(p), guard], /a program this page never uses/, ctx('buy', p));
    const steps = ok([...buyBody(p), guard], ctx('buy', p), { allowWalletGuards: true });
    expect(steps.filter((s) => s.kind === 'pool-swap')).toHaveLength(1);
    ok([...sellBody(p), guard], ctx('sell', p), { allowWalletGuards: true });
  });

  it('a wallet’s copy is judged by the same rules: the fee one unit up is refused with guards allowed too', () => {
    refused([...buyBody(p, { fee: [feeIx(BUY_FEE + 1n)] }), guard], /the site fee is not 0\.5% of the SOL you pay/, ctx('buy', p), { allowWalletGuards: true });
    refused([...sellBody(p, { fee: [feeIx(SELL_FEE), feeIx(SELL_FEE)] }), guard], /exactly once/, ctx('sell', p), { allowWalletGuards: true });
  });

  it('Token-2022 at the top level, even for a Token-2022 token', () => {
    const t22 = pinsFor({ tokenProgram: TOKEN_2022_PROGRAM_ID });
    const move = createTransferCheckedInstruction(mine(t22, t22.tokenMint), t22.tokenMint, fresh(), ME, 1n, 6, [], TOKEN_2022_PROGRAM_ID);
    refused([...buyBody(t22), move], /a program this page never uses \(TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb\)/, ctx('buy', t22));
  });

  it('the launch program, Token Metadata, the memo program and an unknown program', () => {
    const call = (programId: PublicKey) => new TransactionInstruction({ programId, keys: [], data: Buffer.from([0]) });
    const c = ctx('buy', p);
    refused([...buyBody(p), call(cfgLocal.programId)], /a program this kind of transaction never uses/, c);
    refused([...buyBody(p), call(METAPLEX_TOKEN_METADATA_ID)], /a program this kind of transaction never uses/, c);
    refused([...buyBody(p), call(MEMO_PROGRAM_ID)], /a program this page never uses/, c);
    refused([...buyBody(p), call(fresh())], /a program this page never uses/, c);
  });

  it('creating an account, or a new token', () => {
    const c = ctx('buy', p);
    const mint = fresh();
    const create = SystemProgram.createAccount({ fromPubkey: ME, newAccountPubkey: mint, lamports: 1_461_600, space: 82, programId: TOKEN_PROGRAM_ID });
    refused([...buyBody(p), create], /this kind of transaction never creates an account/, c);
    refused([...buyBody(p), createInitializeMint2Instruction(mint, 6, ME, null)], /this kind of transaction never creates a token/, c);
  });

  it('SOL sent to anyone but your own wrapped-SOL account', () => {
    const c = ctx('buy', p);
    for (const to of [STRANGER, PLATFORM_TREASURY_VAULT, p.address]) {
      refused([...buyBody(p), SystemProgram.transfer({ fromPubkey: ME, toPubkey: to, lamports: 1 })], /not your own wrapped-SOL account/, c);
    }
  });
});
