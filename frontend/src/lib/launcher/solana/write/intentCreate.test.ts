// @vitest-environment node
//
// Opening a pool, read back out of the bytes (spec 3.2). The one `initialize` is pinned
// slot by slot: always on the public fee tier (tier 1), derived from the constant; the
// pool, its vaults, share token and price record derived from the address prepare
// chose; the creator's accounts the signer's own; the amounts past the site's share
// rule; and the pool open for trading at once. Each case changes ONE thing, so deleting
// the check that guards it lets the transaction through.
import { describe, it, expect } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, SYSVAR_RENT_PUBKEY, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
} from '@solana/spl-token';
import { ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import {
  REGISTERED_PROGRAM_ID,
  deriveAmmConfig,
  deriveAuthority,
  deriveLpMint,
  deriveObservation,
  derivePool,
  deriveVault,
  publicTierConfig,
  sortMints,
} from '../../../solana/cpswap/program';
import { depositIx, initializeIx, withdrawIx } from '../../../solana/cpswap/ix';
import { PROGRAMS_BY_KIND, decodeIntent, isPoolIntent } from './intent';
import { createPins } from './createPool';
import { CP_CREATE_POOL_FEE_RECEIVER } from './config';
import { AMM_CONFIG, CPSWAP, VAULT, cfgLocal } from './testkit.fixture';
import type { IntentContext, PoolIntent, PoolPins } from './types';
import { SOL_QUOTE } from '../../../solana/lp/quotes';

const ME = Keypair.generate().publicKey;
const STRANGER = Keypair.generate().publicKey;
const fresh = () => Keypair.generate().publicKey;
const TIER1 = publicTierConfig(CPSWAP);
const TIER0 = deriveAmmConfig(CPSWAP, 0);

const standardOf = (tokenMint: PublicKey) => {
  const { token0, token1 } = sortMints(WSOL_MINT, tokenMint);
  return derivePool(CPSWAP, TIER1, token0, token1);
};

/** The pins prepare would make: the standard address, or a fresh key of its own. */
function pinsFor(o: { tokenProgram?: PublicKey; oneOff?: boolean; tokenMint?: PublicKey } = {}): PoolPins {
  const tokenMint = o.tokenMint ?? fresh();
  const address = o.oneOff ? fresh() : standardOf(tokenMint);
  const p = createPins(cfgLocal, { address, tokenMint, tokenProgram: o.tokenProgram ?? TOKEN_PROGRAM_ID, signer: ME, quote: SOL_QUOTE });
  if (typeof p === 'string') throw new Error(p);
  return p;
}

const ctxFor = (pins: PoolPins, kind: PoolIntent['kind'] = 'lp-create'): PoolIntent => ({
  kind,
  signer: ME,
  cfg: cfgLocal,
  maxPriorityLamports: 1_000_000n,
  pins,
});

const mine = (mint: PublicKey, program: PublicKey) => associatedTokenAddress(mint, ME, program);
const wsolAta = () => mine(WSOL_MINT, TOKEN_PROGRAM_ID);

/** The site's own opening instruction for these pins. */
function opening(p: PoolPins, o: Partial<{ init0: bigint; init1: bigint; openTime: bigint; ammConfig: PublicKey }> = {}) {
  return initializeIx({
    programId: CPSWAP,
    creator: ME,
    ammConfig: o.ammConfig ?? TIER1,
    token0Mint: p.token0Mint,
    token1Mint: p.token1Mint,
    creatorToken0: mine(p.token0Mint, p.token0Program),
    creatorToken1: mine(p.token1Mint, p.token1Program),
    creatorLpToken: p.lpAccount,
    token0Program: p.token0Program,
    token1Program: p.token1Program,
    createPoolFee: CP_CREATE_POOL_FEE_RECEIVER,
    initAmount0: o.init0 ?? 1_000_000_000n,
    initAmount1: o.init1 ?? 5_000_000_000n,
    openTime: o.openTime ?? 0n,
    poolState: p.origin === 'other' ? p.address : undefined,
  });
}

const createAta = (mint: PublicKey, program: PublicKey) =>
  createAssociatedTokenAccountIdempotentInstruction(ME, associatedTokenAddress(mint, ME, program), ME, mint, program);

/** The whole transaction the site builds: open the wrapped-SOL account, wrap, open the pool, close. */
const siteOpening = (p: PoolPins, ix: TransactionInstruction = opening(p)) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
  createAta(WSOL_MINT, TOKEN_PROGRAM_ID),
  SystemProgram.transfer({ fromPubkey: ME, toPubkey: wsolAta(), lamports: 1_000_000_000 }),
  createSyncNativeInstruction(wsolAta()),
  ix,
  createCloseAccountInstruction(wsolAta(), ME, ME),
];

/** The same instruction with one account slot replaced. */
const withKey = (ix: TransactionInstruction, i: number, pubkey: PublicKey) =>
  new TransactionInstruction({ programId: ix.programId, keys: ix.keys.map((k, n) => (n === i ? { ...k, pubkey } : k)), data: ix.data });

const ok = (ixs: TransactionInstruction[], c: IntentContext) => {
  const r = decodeIntent(ixs, c);
  expect(r.ok, r.ok ? '' : r.reason).toBe(true);
  return r.ok ? r.steps : [];
};

const refused = (ixs: TransactionInstruction[], why: RegExp, c: IntentContext) => {
  const r = decodeIntent(ixs, c);
  expect(r.ok, `expected a refusal matching ${why}`).toBe(false);
  if (!r.ok) expect(r.reason).toMatch(why);
};

describe('the public fee tier is derived, never read', () => {
  it('on mainnet, tier 1 is CapqvAA9… and tier 0 (the launch tier) is BHMteE8u…', () => {
    expect(publicTierConfig(REGISTERED_PROGRAM_ID).toBase58()).toBe('CapqvAA9HvERTwzmE26xrtFhMaNcaXXoQUADpBWqWjKy');
    expect(deriveAmmConfig(REGISTERED_PROGRAM_ID, 0).toBase58()).toBe('BHMteE8u6LAppswQmFmd2h7hp1fCfWtGahvVJnhRk8jW');
  });
});

describe("the site's own opening decodes into one pool-create", () => {
  it('at the standard address: wrap, open the pool, close the wrapped SOL', () => {
    const p = pinsFor();
    expect(p.origin).toBe('standard');
    const steps = ok(siteOpening(p), ctxFor(p));
    expect(steps.map((s) => s.kind)).toEqual(['compute-limit', 'create-token-account', 'wrap-sol', 'sync-wsol', 'pool-create', 'close-wsol']);
    expect(steps[4]).toEqual({ kind: 'pool-create', pool: p.address, ammConfig: TIER1, init0: 1_000_000_000n, init1: 5_000_000_000n });
  });

  it('at a one-off address of its own (the standard one was taken)', () => {
    const p = pinsFor({ oneOff: true });
    expect(p.origin).toBe('other');
    const ix = opening(p);
    expect(ix.keys[3]!.isSigner).toBe(true);
    const steps = ok(siteOpening(p, ix), ctxFor(p));
    expect(steps.filter((s) => s.kind === 'pool-create')).toEqual([
      { kind: 'pool-create', pool: p.address, ammConfig: TIER1, init0: 1_000_000_000n, init1: 5_000_000_000n },
    ]);
  });

  it('a Token-2022 token: its creator account and program slot are the Token-2022 ones', () => {
    const p = pinsFor({ tokenProgram: TOKEN_2022_PROGRAM_ID });
    ok(siteOpening(p), ctxFor(p));
    const tokenSlot = p.quoteIsToken0 ? 8 : 7;
    refused(siteOpening(p, withKey(opening(p), tokenSlot, mine(p.tokenMint, TOKEN_PROGRAM_ID))), /spends from an account that is not yours/, ctxFor(p));
  });

  it('an opening is a pool intent', () => {
    expect(isPoolIntent(ctxFor(pinsFor()))).toBe(true);
  });

  it('createPins pins the derivations from the address, and says standard only for the standard address', () => {
    const tokenMint = fresh();
    const std = createPins(cfgLocal, { address: standardOf(tokenMint), tokenMint, tokenProgram: TOKEN_PROGRAM_ID, signer: ME, quote: SOL_QUOTE });
    const other = createPins(cfgLocal, { address: fresh(), tokenMint, tokenProgram: TOKEN_PROGRAM_ID, signer: ME, quote: SOL_QUOTE });
    if (typeof std === 'string' || typeof other === 'string') throw new Error('no pins');
    expect(std.origin).toBe('standard');
    expect(other.origin).toBe('other');
    for (const p of [std, other]) {
      expect(p.ammConfig.equals(TIER1)).toBe(true);
      expect(p.lpMint.equals(deriveLpMint(CPSWAP, p.address))).toBe(true);
      expect(p.vault0.equals(deriveVault(CPSWAP, p.address, p.token0Mint))).toBe(true);
      expect(p.vault1.equals(deriveVault(CPSWAP, p.address, p.token1Mint))).toBe(true);
      expect(p.observation.equals(deriveObservation(CPSWAP, p.address))).toBe(true);
      expect(p.lpAccount.equals(associatedTokenAddress(p.lpMint, ME, TOKEN_PROGRAM_ID))).toBe(true);
    }
    expect(createPins(cfgLocal, { address: fresh(), tokenMint, tokenProgram: fresh(), signer: ME, quote: SOL_QUOTE })).toMatch(/token program/);
    expect(createPins(cfgLocal, { address: fresh(), tokenMint: WSOL_MINT, tokenProgram: TOKEN_PROGRAM_ID, signer: ME, quote: SOL_QUOTE })).toMatch(/SOL/);
  });
});

describe('refused: every one of the 20 slots, replaced', () => {
  const p = pinsFor();
  const c = ctxFor(p);
  const reasons: Array<[number, RegExp]> = [
    [0, /opened and paid for by someone else/],
    [1, /fee tier this site does not use/],
    [2, /wrong pool authority/],
    [3, /creates a different pool than the one checked/],
    [4, /pairs different tokens than the review names/],
    [5, /pairs different tokens than the review names/],
    [6, /wrong pool-share token/],
    [7, /spends from an account that is not yours/],
    [8, /spends from an account that is not yours/],
    [9, /pool shares go to an account that is not yours/],
    [10, /wrong pool vault/],
    [11, /wrong pool vault/],
    [12, /fee to open a pool goes somewhere other than the pool program's fee account/],
    [13, /wrong price record/],
    [14, /wrong token program/],
    [15, /wrong token program/],
    [16, /wrong token program/],
    [17, /wrong system program/],
    [18, /wrong system program/],
    [19, /wrong system program/],
  ];

  it('the table covers every slot', () => {
    expect(reasons.map(([i]) => i)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(opening(p).keys).toHaveLength(20);
  });

  it.each(reasons)('slot %i replaced by a stranger’s key is refused', (slot, why) => {
    refused(siteOpening(p, withKey(opening(p), slot, fresh())), why, c);
  });

  it('the fixed programs, each swapped for another real program, are refused too', () => {
    refused(siteOpening(p, withKey(opening(p), 14, TOKEN_2022_PROGRAM_ID)), /wrong token program/, c);
    refused(siteOpening(p, withKey(opening(p), 17, SYSTEM_PROGRAM_ID)), /wrong system program/, c);
    refused(siteOpening(p, withKey(opening(p), 18, ASSOCIATED_TOKEN_PROGRAM_ID)), /wrong system program/, c);
    refused(siteOpening(p, withKey(opening(p), 19, SYSTEM_PROGRAM_ID)), /wrong system program/, c);
    expect(opening(p).keys[19]!.pubkey.equals(SYSVAR_RENT_PUBKEY)).toBe(true);
  });

  it('the creator accounts are the signer’s own: a stranger’s, under the right program, is refused', () => {
    refused(siteOpening(p, withKey(opening(p), 8, associatedTokenAddress(p.token1Mint, STRANGER, p.token1Program))), /not yours/, c);
    refused(siteOpening(p, withKey(opening(p), 9, associatedTokenAddress(p.lpMint, STRANGER, TOKEN_PROGRAM_ID))), /not yours/, c);
  });
});

describe('refused: the fee tier and the address', () => {
  it('the launch tier (fee tier 0) is refused BY NAME', () => {
    const p = pinsFor();
    refused(siteOpening(p, withKey(opening(p), 1, TIER0)), /launch tier \(fee tier 0\), which this site never does/, ctxFor(p));
  });

  it('a pool built on tier 0 from the start, at tier 0’s own standard address, is refused', () => {
    const tokenMint = fresh();
    const p = pinsFor({ tokenMint });
    const { token0, token1 } = sortMints(WSOL_MINT, tokenMint);
    const tier0Pool = derivePool(CPSWAP, TIER0, token0, token1);
    const pins: PoolPins = { ...p, address: tier0Pool, origin: 'other' };
    refused(siteOpening(pins, opening(pins, { ammConfig: TIER0 })), /launch tier/, ctxFor(pins));
  });

  it("origin 'standard' at a non-standard address, 'other' at the standard one, and any launch-pool origin", () => {
    const std = pinsFor();
    const other = pinsFor({ oneOff: true });
    const lie1: PoolPins = { ...other, origin: 'standard' };
    const lie2: PoolPins = { ...std, origin: 'other' };
    const lie3: PoolPins = { ...std, origin: 'launch-pool' };
    refused(siteOpening(lie1, opening(other)), /pool's address does not match the review/, ctxFor(lie1));
    refused(siteOpening(lie2, opening(std)), /pool's address does not match the review/, ctxFor(lie2));
    refused(siteOpening(lie3, opening(std)), /pool's address does not match the review/, ctxFor(lie3));
    // A launch-pool origin at an address that is NOT the standard one: only the origin rule catches it.
    const lie4: PoolPins = { ...other, origin: 'launch-pool' };
    refused(siteOpening(lie4, opening(other)), /pool's address does not match the review/, ctxFor(lie4));
  });
});

describe('refused: the arguments', () => {
  const p = pinsFor();
  const c = ctxFor(p);

  it('a pool that opens for trading later', () => {
    refused(siteOpening(p, opening(p, { openTime: 1n })), /open for trading later, not now/, c);
  });

  it('an empty side', () => {
    refused(siteOpening(p, opening(p, { init0: 0n })), /open with an empty side/, c);
    refused(siteOpening(p, opening(p, { init1: 0n })), /open with an empty side/, c);
  });

  it('an opening the program would land with nothing for the opener (isqrt exactly 100), and one locking more than 0.1%', () => {
    refused(siteOpening(p, opening(p, { init0: 100n, init1: 100n })), /keep more than 0\.1% of what you put in forever/, c);
    refused(siteOpening(p, opening(p, { init0: 99_999n, init1: 99_999n })), /keep more than 0\.1%/, c);
    // Exactly 100,000 shares: the locked 100 are 0.1%, which is allowed.
    ok(siteOpening(p, opening(p, { init0: 100_000n, init1: 100_000n })), c);
  });

  it('a 21st account (the program would read it as a support-mint record)', () => {
    const ix = opening(p);
    const longer = new TransactionInstruction({ programId: ix.programId, keys: [...ix.keys, { pubkey: fresh(), isSigner: false, isWritable: false }], data: ix.data });
    refused(siteOpening(p, longer), /has 21 accounts, expected 20/, c);
  });

  it('data of the wrong length', () => {
    const ix = opening(p);
    const shorter = new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data: ix.data.subarray(0, 24) });
    refused(siteOpening(p, shorter), /other than opening a pool/, c);
  });
});

describe('refused: the whole transaction', () => {
  const p = pinsFor();
  const c = ctxFor(p);
  const common = {
    programId: CPSWAP,
    owner: ME,
    poolState: p.address,
    ownerLpToken: p.lpAccount,
    token0Account: mine(p.token0Mint, p.token0Program),
    token1Account: mine(p.token1Mint, p.token1Program),
    token0Vault: p.vault0,
    token1Vault: p.vault1,
    vault0Mint: p.token0Mint,
    vault1Mint: p.token1Mint,
    lpMint: p.lpMint,
    lpTokenAmount: 1_000n,
  };

  it('two openings, and none', () => {
    const ixs = siteOpening(p);
    refused([...ixs.slice(0, 5), opening(p), ...ixs.slice(5)], /does not open exactly one pool/, c);
    refused(ixs.filter((_, i) => i !== 4), /does not open exactly one pool/, c);
  });

  it('a deposit or a withdrawal inside an opening', () => {
    refused([...siteOpening(p), depositIx({ ...common, maximumToken0Amount: 5n, maximumToken1Amount: 5n })], /other than opening a pool/, c);
    refused([...siteOpening(p), withdrawIx({ ...common, minimumToken0Amount: 1n, minimumToken1Amount: 1n })], /other than opening a pool/, c);
  });

  it('an opening inside a deposit, a withdrawal or a pool swap', () => {
    refused([opening(p)], /other than a deposit/, ctxFor(p, 'lp-deposit'));
    refused([opening(p)], /other than a withdrawal/, ctxFor(p, 'lp-withdraw'));
    refused(
      [opening(p)],
      /other than a swap/,
      { kind: 'pool-buy', signer: ME, cfg: cfgLocal, feeRecipient: VAULT, ammConfig: AMM_CONFIG, mint: p.tokenMint, maxPriorityLamports: 1_000_000n },
    );
  });

  it('opening the pool-share account first, or the token account', () => {
    refused([createAta(p.lpMint, TOKEN_PROGRAM_ID), ...siteOpening(p)], /pool program opens your pool-share account itself/, c);
    refused([createAta(p.tokenMint, p.tokenProgram), ...siteOpening(p)], /an opening creates only your wrapped-SOL account/, c);
  });

  it('a System create-account', () => {
    const create = SystemProgram.createAccount({ fromPubkey: ME, newAccountPubkey: fresh(), lamports: 1, space: 82, programId: TOKEN_PROGRAM_ID });
    refused([create, ...siteOpening(p)], /never creates an account/, c);
  });

  it('the authority the decoder pins is the pool program’s own', () => {
    expect(opening(p).keys[2]!.pubkey.equals(deriveAuthority(CPSWAP))).toBe(true);
  });
});

describe('the programs an opening may call', () => {
  it('compute, System, Token, the associated-token program and the pool program, and nothing else', () => {
    expect([...PROGRAMS_BY_KIND['lp-create']].sort()).toEqual(['ata', 'compute', 'pool', 'system', 'token']);
  });
});
