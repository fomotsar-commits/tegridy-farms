// @vitest-environment node
//
// What is drawn under every review, worked out from the prepared transaction alone: this
// site's figures beside the network's test run, the steps in words, the accounts written and
// the unsigned bytes. Node, not jsdom: web3's byte encoders need the real Uint8Array.
import { describe, expect, it } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction, VersionedTransaction } from '@solana/web3.js';
import { openPositionWithToken22NftIx } from '../../../lib/solana/clmm/ix';
import { TX_SIZE_LIMIT } from '../../../lib/launcher/solana/write/prepare';
import { SOL_QUOTE, USDC_QUOTE } from '../../../lib/solana/lp/quotes';
import { lpCreateSummary, lpDepositSummary } from '../lp/fakeLpWriteApi.fixture';
import { CREATOR, KEY } from './fakeWriteApi.fixture';
import type { PreparedTx } from './ports';
import { BAYLA, EVERY_KIND, POOL_LINE, rangeOpening, rangeTakeOut, underTheHood } from './reviewKinds.fixture';
import { SOLANA_TX_BYTES, legAmount, logCutShort, poolCoins, programName, siteAndNetwork, stepText, unsignedBase64, writtenAccounts, type StepContext } from './signingFacts';

type Step = PreparedTx['steps'][number];
const FEES = { baseLamports: 5_000n, priorityLamports: 12_000n, priorityFeeRead: true, newAccountRentLamports: 59_300_000n };
const LISTED = 5_000n + 12_000n + 59_300_000n;

describe('the size limit', () => {
  it('is the write layer’s own', () => {
    expect(SOLANA_TX_BYTES).toBe(TX_SIZE_LIMIT);
  });
});

describe("this site's figures beside the network's test run", () => {
  it('a SOL pool: SOL is the wallet’s change less the network fee, the priority fee and the deposits the review lists', () => {
    const p = underTheHood(rangeOpening(), {
      fees: FEES,
      simulated: { signerLamportsDelta: -(4_098_800_000n + LISTED), tokenDeltas: [{ mint: BAYLA, account: KEY(60), delta: -10_000_000_000n, role: 'token' }] },
    });
    const c = siteAndNetwork(p, 6)!;
    expect(c.legs).toEqual([
      { name: 'BAYLA', decimals: 6, site: -10_000_000_000n, network: -10_000_000_000n },
      { name: 'SOL', decimals: 9, site: -4_098_800_000n, network: -4_098_800_000n },
    ]);
    expect(c.solNetted).toBe(true);
  });

  it('wrapped SOL in an account the wallet keeps is counted as SOL', () => {
    // 0.5 SOL wrapped, 0.4 used by the pool: 0.1 stays as wrapped SOL in the kept account.
    const p = underTheHood(rangeOpening({ quoted: { token: 1_000_000n, quote: 400_000_000n }, unwrapsWsol: false }), {
      fees: FEES,
      simulated: {
        signerLamportsDelta: -(500_000_000n + LISTED),
        tokenDeltas: [
          { mint: BAYLA, account: KEY(60), delta: -1_000_000n, role: 'token' },
          { mint: new PublicKey(SOL_QUOTE.mint), account: KEY(61), delta: 100_000_000n, role: 'wsol' },
        ],
      },
    });
    expect(siteAndNetwork(p, 6)!.legs[1]).toMatchObject({ site: -400_000_000n, network: -400_000_000n });
  });

  it('a coin other than SOL is read from the wallet’s own account for it, and SOL is not a leg', () => {
    const p = underTheHood(lpDepositSummary(KEY(30), KEY(31), { quote: USDC_QUOTE }), {
      simulated: {
        signerLamportsDelta: -17_000n,
        tokenDeltas: [
          { mint: KEY(31), account: KEY(60), delta: -10_000_000n, role: 'token' },
          { mint: new PublicKey(USDC_QUOTE.mint), account: KEY(43), delta: -100_000_000n, role: 'quote' },
          { mint: KEY(62), account: KEY(63), delta: 1_000_000n, role: 'lp' },
        ],
      },
    });
    const c = siteAndNetwork(p, 6)!;
    expect(c.legs.map((l) => [l.name, l.site, l.network])).toEqual([
      ['tokens', -10_000_000n, -10_000_000n],
      ['USDC', -100_000_000n, -100_000_000n],
      ['pool shares', 1_000_000n, 1_000_000n],
    ]);
    expect(c.solNetted).toBe(false);
  });

  it('opening a pool: the fee to open it is left out of the SOL, like the other fees the review lists', () => {
    const s = lpCreateSummary(KEY(30), KEY(31));
    if (s.kind !== 'lp-create') throw new Error('kind');
    const p = underTheHood(s, { fees: FEES, simulated: { signerLamportsDelta: -(s.put.quote + s.createFee + LISTED), tokenDeltas: [] } });
    expect(siteAndNetwork(p, 6)!.legs.find((l) => l.name === 'SOL')).toMatchObject({ site: -s.put.quote, network: -s.put.quote });
  });

  it('closing a position in a SOL pool leaves SOL out and says why: the deposits it gives back are not listed', () => {
    const c = siteAndNetwork(underTheHood(rangeTakeOut('range-close')), 6)!;
    expect(c.legs.map((l) => l.name)).toEqual(['BAYLA']);
    expect(c.solNetted).toBe(false);
    expect(c.solLeftOut).toMatch(/^SOL is not compared here: closing also gives back your position's deposits/);
  });

  it('a removal whose fees owed did not read: the site’s figure is said as could not be worked out', () => {
    const c = siteAndNetwork(underTheHood(rangeTakeOut('range-remove', { fees: null })), 6)!;
    expect(c.unread).toBe('the fees owed did not read');
  });

  it('an account the test run did not report is null, never 0', () => {
    const c = siteAndNetwork(underTheHood(rangeOpening(), { simulated: { signerLamportsDelta: 0n, tokenDeltas: [] } }), 6)!;
    expect(c.legs[0]).toMatchObject({ name: 'BAYLA', network: null });
  });

  it("someone else's account (the treasury, the Workshop) is never counted as the wallet's", () => {
    const s = EVERY_KIND.create;
    if (s.kind !== 'create') throw new Error('kind');
    const p = underTheHood(s, {
      simulated: {
        signerLamportsDelta: -1_000_000n,
        tokenDeltas: [
          { mint: s.plant.mint, account: s.plant.from, delta: -s.plant.total },
          { mint: s.plant.mint, account: s.plant.workshopAccount, delta: s.plant.toWorkshop, role: 'workshop' },
        ],
      },
    });
    const c = siteAndNetwork(p, 6)!;
    expect(c.legs).toEqual([{ name: '$BAYLA', decimals: 6, site: -s.plant.total, network: -s.plant.total }]);
    expect(c.solLeftOut).toMatch(/^SOL is not compared for a launch/);
  });

  it('graduation moves none of the wallet’s coins but fees: no comparison', () => {
    expect(siteAndNetwork(underTheHood(EVERY_KIND.migrate), 6)).toBeNull();
  });

  it('every other kind has one', () => {
    for (const [kind, s] of Object.entries(EVERY_KIND)) {
      if (kind === 'migrate') continue;
      expect(siteAndNetwork(underTheHood(s), 6)?.legs.length, kind).toBeGreaterThan(0);
    }
  });

  it('amounts are said to the last unit, with their sign', () => {
    expect(legAmount(-4_098_800_001n, { name: 'SOL', decimals: 9 })).toBe('-4.098800001 SOL');
    expect(legAmount(1_198_120_000n, { name: 'BAYLA', decimals: 6 })).toBe('+1,198.12 BAYLA');
    expect(legAmount(5n, { name: 'tokens', decimals: null })).toBe('+5 base units of tokens');
    expect(legAmount(-300_000n, { name: 'SOL', decimals: 9 }, false)).toBe('0.0003 SOL');
  });
});

describe('the steps in words', () => {
  const k = (n: number) => KEY(n);
  /** One step of every kind: a kind missing here does not compile. */
  const EVERY_STEP: { [K in Step['kind']]: Extract<Step, { kind: K }> } = {
    'compute-limit': { kind: 'compute-limit', units: 120_000 },
    'compute-price': { kind: 'compute-price', microLamports: 10_000n },
    'create-mint-account': { kind: 'create-mint-account', mint: k(1), lamports: 1_461_600n },
    'init-mint': { kind: 'init-mint', mint: k(1), decimals: 6 },
    'create-metadata': { kind: 'create-metadata', mint: k(1), name: 'A', symbol: 'AB', uri: 'https://x' },
    'create-launch': { kind: 'create-launch', mint: k(1), feeRecipient: k(4), treasuryToken: k(12) },
    'create-token-account': { kind: 'create-token-account', owner: CREATOR, mint: k(1), address: k(9) },
    'curve-buy': { kind: 'curve-buy', mint: k(1), maxLamportsIn: 100_000_000n, minTokensOut: 3_000_000_000n, creator: k(2), feeRecipient: k(4) },
    'curve-sell': { kind: 'curve-sell', mint: k(1), tokensIn: 1_000_000n, minLamportsOut: 900n, creator: k(2), feeRecipient: k(4) },
    migrate: { kind: 'migrate', mint: k(1), pool: k(40), creator: k(2), feeRecipient: k(4) },
    'wrap-sol': { kind: 'wrap-sol', lamports: 500_000_000n },
    'sync-wsol': { kind: 'sync-wsol' },
    'pool-swap': { kind: 'pool-swap', pool: k(40), inputMint: k(5), outputMint: k(6), amountIn: 1_000n, minimumAmountOut: 900n },
    'close-wsol': { kind: 'close-wsol' },
    'plant-burn': { kind: 'plant-burn', account: k(13), mint: BAYLA, amount: 50_000_000_000n },
    'plant-transfer': { kind: 'plant-transfer', from: k(13), to: k(14), mint: BAYLA, amount: 50_000_000_000n },
    'pool-deposit': { kind: 'pool-deposit', pool: k(40), lpAmount: 1_000n, max0: 2n, max1: 3n },
    'pool-withdraw': { kind: 'pool-withdraw', pool: k(40), lpAccount: k(41), lpAmount: 1_000n, min0: 2n, min1: 3n },
    'pool-create': { kind: 'pool-create', pool: k(40), ammConfig: k(42), init0: 2n, init1: 3n },
    'range-open': { kind: 'range-open', pool: k(51), nftMint: k(52), tickLower: -1200, tickUpper: 1200, liquidity: 1_284_112n, max0: 10n, max1: 20n },
    'range-decrease': { kind: 'range-decrease', pool: k(51), position: k(53), liquidity: 0n, min0: 0n, min1: 0n },
    'range-close': { kind: 'range-close', position: k(53), nftMint: k(52) },
    'range-swap': { kind: 'range-swap', pool: k(51), inputMint: k(5), outputMint: k(6), amountIn: 1_000n, minimumAmountOut: 900n },
  };

  const plain = (over: Partial<StepContext> = {}): StepContext => ({ wallet: null, display: (s) => s, coins: null, ...over });

  it.each(Object.values(EVERY_STEP))('$kind has words of its own, with no em dash', (step) => {
    const t = stepText(step, plain({ wallet: CREATOR.toBase58() }));
    expect(t).not.toMatch(/no words for/);
    expect(t).not.toContain(String.fromCharCode(0x2014));
    expect(t.length).toBeGreaterThan(10);
  });

  it('raw values stay raw: ticks, liquidity and base units, every address whole', () => {
    expect(stepText(EVERY_STEP['range-open'], plain())).toBe(
      `Open a position in the pool ${k(51).toBase58()} from tick -1200 to tick 1200: liquidity 1,284,112, at most 10 and 20 base units of its two coins; its NFT is ${k(52).toBase58()}`,
    );
    expect(stepText(EVERY_STEP['range-decrease'], plain())).toMatch(/^Collect what the position .* is owed$/);
  });

  it("the pool's two coins by name, coin 0 first, when the summary says which is which", () => {
    // BAYLA's mint sorts after wrapped SOL's, so in a BAYLA with SOL pool SOL is coin 0.
    const flipped = rangeOpening({ poolLine: { ...POOL_LINE, tokenIsToken0: false } });
    expect(poolCoins(flipped)).toEqual(['SOL', 'BAYLA']);
    expect(poolCoins(rangeOpening())).toEqual(['BAYLA', 'SOL']);
    expect(poolCoins(lpDepositSummary(KEY(30), KEY(31), { quoteIsToken0: true }))).toEqual(['SOL', 'the token']);
    expect(poolCoins(EVERY_KIND.buy)).toBeNull();
    expect(stepText(EVERY_STEP['range-open'], plain({ coins: ['SOL', 'BAYLA'] }))).toContain('at most 10 base units of SOL and 20 of BAYLA; its NFT is');
  });

  it("a coin the site knows carries its ticker beside its whole address", () => {
    const wrap = { kind: 'create-token-account' as const, owner: CREATOR, mint: new PublicKey(SOL_QUOTE.mint), address: k(9) };
    expect(stepText(wrap, plain())).toContain(`for the mint ${SOL_QUOTE.mint} (SOL), owned by`);
    expect(stepText(EVERY_STEP['plant-burn'], plain())).toContain(`of ${BAYLA.toBase58()} (BAYLA) from`);
  });

  it("the wallet's own address is named as your wallet", () => {
    expect(stepText(EVERY_STEP['create-token-account'], plain({ wallet: CREATOR.toBase58() }))).toMatch(/, owned by your wallet$/);
  });

  it("a token's own name goes through the page's display rule", () => {
    expect(stepText(EVERY_STEP['create-metadata'], plain({ display: (s) => `[${s}]` }))).toContain('name "[A]", symbol "[AB]", link [https://x]');
  });

  it('a public program by its name; this venue’s own by the step it decoded as', () => {
    expect(programName(EVERY_STEP['compute-limit'], ComputeBudgetProgram.programId.toBase58())).toBe('Compute budget');
    expect(programName(EVERY_STEP['range-open'], k(70).toBase58())).toBe("This venue's range program");
    expect(programName(EVERY_STEP['pool-swap'], k(70).toBase58())).toBe("This venue's pool program");
    expect(programName(EVERY_STEP['curve-buy'], k(70).toBase58())).toBe("This venue's launch program");
  });
});

describe('the accounts it writes', () => {
  it('the wallet first, each account once, read-only ones left out, each named where the steps say what it is', () => {
    const got = writtenAccounts(underTheHood(EVERY_KIND['range-open']));
    expect(got).toEqual([
      { address: CREATOR.toBase58(), wallet: true, label: 'Your wallet, which pays the fees', field: 'payer' },
      { address: KEY(52).toBase58(), wallet: false, label: "Your position's NFT", field: 'position_nft_mint' },
      { address: KEY(56).toBase58(), wallet: false, label: null, field: 'position_nft_account' },
      { address: KEY(51).toBase58(), wallet: false, label: 'The pool', field: 'pool_state' },
      { address: KEY(54).toBase58(), wallet: false, label: null, field: 'tick_array_lower' },
    ]);
  });

  it("a real range opening's accounts carry the program's own names, as its account list has them", () => {
    const owner = Keypair.generate().publicKey;
    const pool = { address: KEY(51).toBase58(), tokenMint0: SOL_QUOTE.mint, tokenMint1: BAYLA.toBase58(), tokenVault0: KEY(58).toBase58(), tokenVault1: KEY(59).toBase58(), tickSpacing: 120 };
    const ix = openPositionWithToken22NftIx({
      programId: KEY(70), payer: owner, owner, positionNftMint: KEY(52), pool, tokenAccount0: KEY(61), tokenAccount1: KEY(62),
      tickLower: -1200, tickUpper: 1200, liquidity: 1n, amount0Max: 1n, amount1Max: 1n, baseFlag: null,
    });
    const tx = new Transaction({ feePayer: owner, blockhash: KEY(7).toBase58(), lastValidBlockHeight: 1 });
    tx.add(ix);
    const step: Step = { kind: 'range-open', pool: KEY(51), nftMint: KEY(52), tickLower: -1200, tickUpper: 1200, liquidity: 1n, max0: 1n, max1: 1n };
    const got = writtenAccounts({ ...underTheHood(EVERY_KIND['range-open']), tx, steps: [step] });
    const fieldOf = (k: PublicKey) => got.find((a) => a.address === k.toBase58())?.field;
    expect(got[0]).toMatchObject({ address: owner.toBase58(), wallet: true, field: 'payer' });
    expect(fieldOf(KEY(51))).toBe('pool_state');
    expect(fieldOf(KEY(58))).toBe('token_vault_0');
    expect(fieldOf(KEY(59))).toBe('token_vault_1');
    expect(fieldOf(KEY(61))).toBe('token_account_0');
    expect(got.map((a) => a.field)).toEqual(expect.arrayContaining(['tick_array_lower', 'tick_array_upper', 'personal_position', 'position_nft_account']));
    // Read-only accounts (the programs, the mints, the protocol position) are not written, so not listed.
    expect(got.map((a) => a.field)).not.toContain('system_program');
  });
});

describe('the unsigned transaction', () => {
  it('is the same message the wallet is handed, with every signature slot empty, in base64', () => {
    const mint = Keypair.generate();
    const tx = new Transaction({ feePayer: CREATOR, blockhash: KEY(7).toBase58(), lastValidBlockHeight: 1 });
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 }),
      new TransactionInstruction({ programId: KEY(70), keys: [{ pubkey: mint.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([1]) }),
    );
    // A second signer that already signed: the copy still carries no signature.
    tx.partialSign(mint);
    const bytes = Buffer.from(unsignedBase64(tx), 'base64');
    const back = VersionedTransaction.deserialize(bytes);
    expect(Buffer.from(back.message.serialize()).equals(tx.serializeMessage())).toBe(true);
    expect(back.signatures).toHaveLength(2);
    for (const sig of back.signatures) expect(sig.every((b) => b === 0)).toBe(true);
  });
});

describe('the log', () => {
  it('a log the network cut short is known by its own line', () => {
    expect(logCutShort(['Program log: a', 'Log truncated'])).toBe(true);
    expect(logCutShort(['Program log: a'])).toBe(false);
  });
});

it('the pool line fixture is the agreed split, so no review here carries the off-split line', () => {
  expect(POOL_LINE.protocolFeeRate + POOL_LINE.fundFeeRate).toBe(POOL_LINE.venueShareRate);
});
