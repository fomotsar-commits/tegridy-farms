// @vitest-environment node
//
// The leave rule as code: nobody is let in who cannot be let out.
//
// The token verdict (tokenSafety.ts `classifyToken`) already blocks every Token-2022
// extension this site cannot build a withdrawal for. Each builder repeats that on its
// own, against the ONE set of buildable extensions, so that a verdict loosened by
// mistake still cannot open or add to a pool for such a token.
//
// So in this file the verdict IS loosened by mistake: it reads every token and blocks
// nothing. What the builders then let in is their own second guard, and nothing else.
// A builder "lets it in" here when it gets past every check of its own and reaches the
// test run, which this file's chain always fails (nothing here signs or sends).
import { describe, it, expect, vi } from 'vitest';
import { Keypair, type PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, WSOL_MINT } from '../curve/program';
import { associatedTokenAddress } from '../curve/ix';
import { BUILDABLE_EXTENSIONS, EXTENSION, classifyToken, extensionPlain, type TokenSafety } from '../../../solana/lp/tokenSafety';
import { CREATE_COPY, prepareLpCreate } from './createPool';
import { LP_COPY, prepareLpDeposit, prepareLpWithdraw, type LpPrepareReads } from './liquidity';
import { FakeChain, TIER1_VALUES, addPool, cfgLocal, setClock } from './testkit.fixture';
import type { LpOpenGate, Prepared, TierTerms, WriteRpc } from './types';

vi.mock('../../../solana/lp/tokenSafety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../solana/lp/tokenSafety')>();
  return {
    ...actual,
    // The verdict, loosened by mistake: every token it can read is let through.
    classifyToken: (...args: Parameters<typeof actual.classifyToken>): TokenSafety => {
      const s = actual.classifyToken(...args);
      return s.kind === 'read' ? { ...s, verdict: 'warn', blocks: [] } : s;
    },
  };
});

/**
 * cp-swap's own list (utils/token.rs `is_supported_mint`): a Token-2022 mint is taken
 * only when every one of its extensions is one of these. Written out from the program's
 * source, not imported, so a change to this site's set is checked against it.
 */
const CP_SWAP_ACCEPTED: readonly number[] = [
  1, // TransferFeeConfig
  18, // MetadataPointer
  19, // TokenMetadata
  10, // InterestBearingConfig
  25, // ScaledUiAmount
];

const W = (c: FakeChain) => c as unknown as WriteRpc;
const ME = Keypair.generate().publicKey;
const OPEN: LpOpenGate = { kind: 'open', cfg: cfgLocal, mode: 'on' };
const NOW = 2_000_000_000n;
const LP_SUPPLY = 1_000_000_000n;
const TERMS: TierTerms = {
  createPoolFee: TIER1_VALUES.createPoolFee,
  tradeFeeRate: TIER1_VALUES.tradeFeeRate,
  protocolFeeRate: TIER1_VALUES.protocolFeeRate,
  fundFeeRate: TIER1_VALUES.fundFeeRate,
  creatorFeeRate: TIER1_VALUES.creatorFeeRate,
};
const priced: LpPrepareReads = { outsidePrice: async () => ({ kind: 'ok', solPerToken: 0.01, source: 'Jupiter' }) };

/** Every extension this site has a name for, and one it does not. */
const ALL_EXTENSIONS = [...Object.values(EXTENSION), 99];
/** The body length each Token-2022 mint extension needs to decode (the two name ones); any other is opaque here. */
const extensionOf = (type: number): [number, number] => [type, type === EXTENSION.MetadataPointer ? 64 : type === EXTENSION.TokenMetadata ? 76 : 8];

/** A chain whose test run always fails: a builder that reaches it got past all its own checks. */
function chainWith(mint: PublicKey, type: number | number[]): FakeChain {
  const chain = FakeChain.healthy();
  chain.simulate = () => ({ err: 'this file never runs a transaction', logs: [], unitsConsumed: 1 });
  chain.mint2022(mint, [type].flat().map(extensionOf), { decimals: 6 });
  chain.fund(ME, 20_000_000_000);
  chain.token2022Account(associatedTokenAddress(mint, ME, TOKEN_2022_PROGRAM_ID), mint, ME, 10_000_000_000n);
  return chain;
}

/** A 10 SOL / 1,000 token pool for a Token-2022 mint carrying this one extension, with the wallet holding 10% of its shares. */
function poolWorld(type: number | number[]) {
  const mint = Keypair.generate().publicKey;
  const chain = chainWith(mint, type);
  const pool = addPool(chain, mint, { sol: 10_000_000_000n, tokens: 1_000_000_000n, lpSupply: LP_SUPPLY, tokenProgram: TOKEN_2022_PROGRAM_ID });
  setClock(chain, NOW);
  const lpAta = associatedTokenAddress(pool.lpMint, ME);
  chain.tokenAccount(lpAta, pool.lpMint, ME, LP_SUPPLY / 10n);
  return { chain, mint, pool, lpAta };
}

const deposit = (type: number | number[]) => {
  const w = poolWorld(type);
  return prepareLpDeposit(W(w.chain), OPEN, priced, { owner: ME, pool: w.pool.address, tokenMint: w.mint, quoteMint: WSOL_MINT, driving: 'quote', maxIn: 100_000_000n, slippageBps: 100n, shownOtherMax: null });
};
const withdraw = (type: number | number[]) => {
  const w = poolWorld(type);
  return prepareLpWithdraw(W(w.chain), OPEN, { owner: ME, pool: w.pool.address, tokenMint: w.mint, quoteMint: WSOL_MINT, lpAccount: w.lpAta, pctBps: 5_000n, slippageBps: 100n });
};
const create = (type: number | number[]) => {
  const mint = Keypair.generate().publicKey;
  const chain = chainWith(mint, type).addTier1({}).addFeeReceiver({});
  return prepareLpCreate(W(chain), OPEN, priced, { owner: ME, tokenMint: mint, quoteMint: WSOL_MINT, quote: 1_000_000_000n, token: 100_000_000n, shown: { terms: TERMS, standard: 'empty' } });
};

/** Past every check of the builder's own: it stopped only at the test run. */
const letThrough = (r: Prepared): boolean => !r.ok && r.outcome.stage === 'simulate';
const refusal = (r: Prepared): string => {
  if (r.ok || r.outcome.stage !== 'build') throw new Error('expected the builder itself to refuse');
  return r.outcome.message;
};
const sorted = (xs: Iterable<number>) => [...xs].sort((a, b) => a - b);

describe('the leave rule, with the token verdict loosened by mistake', () => {
  it('this file’s verdict really is loosened: a transfer fee and a transfer hook are no longer blocked by it', () => {
    for (const type of [EXTENSION.TransferFeeConfig, EXTENSION.TransferHook]) {
      const mint = Keypair.generate().publicKey;
      const chain = chainWith(mint, type);
      const acc = chain.accounts.get(mint.toBase58())!;
      const s = classifyToken(mint.toBase58(), { address: mint.toBase58(), owner: acc.owner.toBase58(), data: acc.data, lamports: acc.lamports }, null);
      expect(s.kind === 'read' && [s.verdict, s.blocks]).toEqual(['warn', []]);
    }
  });

  // A real mint carries several extensions (a name, a picture, and then whatever else). A
  // guard that looked only at the first would let a hook in behind a name: every other
  // test here mints ONE extension, so nothing pinned that until this one (review, 2026-10-04).
  it('a mint with a buildable extension AND one that is not is refused by all three builders, wherever the bad one sits', async () => {
    const mixed: number[][] = [
      [EXTENSION.MetadataPointer, EXTENSION.TokenMetadata, EXTENSION.TransferHook],
      [EXTENSION.InterestBearingConfig, EXTENSION.MetadataPointer, EXTENSION.TokenMetadata, EXTENSION.TransferFeeConfig],
      [EXTENSION.ScaledUiAmountConfig, EXTENSION.PermanentDelegate, EXTENSION.MetadataPointer, EXTENSION.TokenMetadata],
      [EXTENSION.MetadataPointer, EXTENSION.TokenMetadata, EXTENSION.PausableConfig],
      [EXTENSION.MetadataPointer, EXTENSION.TokenMetadata, 99],
    ];
    for (const types of mixed) {
      expect(letThrough(await deposit(types)), `deposit ${types.join(',')}`).toBe(false);
      expect(letThrough(await create(types)), `create ${types.join(',')}`).toBe(false);
      expect(letThrough(await withdraw(types)), `withdraw ${types.join(',')}`).toBe(false);
    }
    // The four buildable ones together go through all three, so each refusal above is the bad one's.
    const all = [EXTENSION.MetadataPointer, EXTENSION.InterestBearingConfig, EXTENSION.ScaledUiAmountConfig, EXTENSION.TokenMetadata];
    expect(letThrough(await deposit(all))).toBe(true);
    expect(letThrough(await create(all))).toBe(true);
    expect(letThrough(await withdraw(all))).toBe(true);
  });

  it('adding to a pool, opening one and removing from one let through exactly the same extensions: the one set', async () => {
    const letIn = { deposit: [] as number[], create: [] as number[] };
    const letOut: number[] = [];
    for (const type of ALL_EXTENSIONS) {
      if (letThrough(await deposit(type))) letIn.deposit.push(type);
      if (letThrough(await create(type))) letIn.create.push(type);
      if (letThrough(await withdraw(type))) letOut.push(type);
    }
    // Not a vacuous pass: each builder lets the four through, and only those.
    expect(sorted(letIn.deposit)).toEqual(sorted(BUILDABLE_EXTENSIONS));
    expect(sorted(letIn.create)).toEqual(sorted(BUILDABLE_EXTENSIONS));
    expect(sorted(letOut)).toEqual(sorted(BUILDABLE_EXTENSIONS));
    // The leave rule itself: whatever is let in can be let out, and the pool program takes it.
    for (const type of [...letIn.deposit, ...letIn.create]) {
      expect(letOut, `let in but not out: ${type}`).toContain(type);
      expect(CP_SWAP_ACCEPTED, `let in but not accepted by the pool program: ${type}`).toContain(type);
    }
  });

  it('every extension outside the set is refused by each builder ITSELF, in its own words, though the verdict let it through', async () => {
    const outside = ALL_EXTENSIONS.filter((t) => !BUILDABLE_EXTENSIONS.has(t));
    // A transfer fee is the one the pool program takes and this site does not.
    expect(outside).toContain(EXTENSION.TransferFeeConfig);
    expect(outside.length).toBe(ALL_EXTENSIONS.length - 4);
    for (const type of outside) {
      const uses = `It uses ${extensionPlain(type)}.`;
      expect(refusal(await deposit(type)), String(type)).toBe(LP_COPY.tokenBlocked(uses));
      expect(refusal(await create(type)), String(type)).toBe(CREATE_COPY.tokenRefused(uses));
      expect(refusal(await withdraw(type)), String(type)).toBe(LP_COPY.cannotBuild(`it uses ${extensionPlain(type)}`));
    }
  });
});
