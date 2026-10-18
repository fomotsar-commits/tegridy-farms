// @vitest-environment node
// (node: web3.js cannot serialize a transaction under jsdom, whose Uint8Array is another realm's.)
// "Add with one coin", step 1 through Jupiter (oneCoinSwap.ts): the swap page's Buy press,
// rule for rule. Pinned here: the wallet is asked only after every check passed; a second
// test run in a row that could not run says so (D2); a lost wallet answer writes a note
// with no signature (D1); a late read never brings back a released note; a review made
// on a no-fee quote is not called "price moved" for the fee alone; a step 1 whose status
// cannot be read is never said to have failed; the step 2 note keeps its slippage.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import type { JupiterQuote, SwapSimulation } from '../../../lib/jupiter';
import { CHECK_KEEPS_FAILING, HELD_NOT_SENT } from '../../../lib/solana/swap/walletCopy';
import { priceChangeOf, readStepTwo, saveStepTwo, sendJupiterLeg, stepOneLanded, type JupiterLegDeps } from './oneCoinSwap';

const SOL = 'So11111111111111111111111111111111111111112';
const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const USER = Keypair.generate().publicKey;
const SIG = '5'.repeat(88);

function quote(over: Partial<JupiterQuote> = {}): JupiterQuote {
  return {
    inputMint: SOL,
    outputMint: BAYLA,
    inAmount: '50000000',
    outAmount: '10000000000',
    otherAmountThreshold: '9900000000',
    swapMode: 'ExactIn',
    slippageBps: 100,
    priceImpactPct: '0.001',
    routePlan: [{ swapInfo: { label: 'Pump.fun Amm' } }],
    platformFee: { amount: '50000000', feeBps: 50 },
    ...over,
  };
}

/** A real transaction's bytes, as Jupiter hands them back: the leg deserializes them. */
const TX_B64 = (() => {
  const msg = new TransactionMessage({ payerKey: USER, recentBlockhash: new PublicKey(new Uint8Array(32).fill(7)).toBase58(), instructions: [] }).compileToV0Message();
  return btoa(String.fromCharCode(...new VersionedTransaction(msg).serialize()));
})();

const OK: SwapSimulation = { ok: true, reason: null, jupiterIncorrectTokenProgram: false };

function deps(over: Partial<JupiterLegDeps> = {}) {
  const held: Parameters<JupiterLegDeps['hold']>[0][] = [];
  const d = {
    getQuote: vi.fn<JupiterLegDeps['getQuote']>(async () => quote()),
    buildSwapTransaction: vi.fn<JupiterLegDeps['buildSwapTransaction']>(async () => TX_B64),
    simulateSwap: vi.fn<JupiterLegDeps['simulateSwap']>(async () => OK),
    swapCarriesPlatformFee: vi.fn<JupiterLegDeps['swapCarriesPlatformFee']>(() => true),
    ownPoolWins: vi.fn<JupiterLegDeps['ownPoolWins']>(async () => false),
    holdsNow: vi.fn<JupiterLegDeps['holdsNow']>(() => false),
    hold: vi.fn<JupiterLegDeps['hold']>((n) => {
      if (!held.some((h) => h.signature === n.signature && h.sentAt === n.sentAt)) held.push(n);
    }),
    stillHeld: vi.fn<JupiterLegDeps['stillHeld']>((n) => held.some((h) => h.signature === n.signature && h.sentAt === n.sentAt)),
    release: vi.fn<JupiterLegDeps['release']>((sig) => {
      const i = held.findIndex((h) => h.signature === sig);
      if (i >= 0) held.splice(i, 1);
    }),
    send: vi.fn<JupiterLegDeps['send']>(async () => SIG),
    rpc: { getBlockHeight: vi.fn(async () => 1_000), getSignatureStatuses: vi.fn(), isBlockhashValid: vi.fn(async () => ({ context: { slot: 5 }, value: true })) },
    confirm: vi.fn<NonNullable<JupiterLegDeps['confirm']>>(async () => 'confirmed'),
    ...over,
  };
  return { d: d as typeof d & JupiterLegDeps, held };
}

const ARGS = {
  shown: quote(),
  inputMint: SOL,
  outputMint: BAYLA,
  amount: '50000000',
  slippageBps: 100,
  user: USER.toBase58(),
  priority: 'high' as const,
  uncheckedBefore: 0,
  words: '≈10,000 BAYLA with 0.05 SOL',
};

describe('sendJupiterLeg', () => {
  it('asks the wallet once every check passed, writes the note on the signature and releases it once confirmed', async () => {
    const { d, held } = deps();
    const end = await sendJupiterLeg(d, ARGS);
    expect(end).toMatchObject({ kind: 'sent', signature: SIG, outcome: 'confirmed' });
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.hold).toHaveBeenCalledWith(expect.objectContaining({ signature: SIG }));
    expect(d.release).toHaveBeenCalledWith(SIG);
    expect(held).toHaveLength(0);
  });

  it('a swap this wallet sent elsewhere holds it: not sent, and the wallet is not asked', async () => {
    const { d } = deps({ holdsNow: vi.fn(() => true) });
    const end = await sendJupiterLeg(d, ARGS);
    expect(end).toMatchObject({ kind: 'not-sent', message: HELD_NOT_SENT });
    expect(d.send).not.toHaveBeenCalled();
  });

  it('a second test run in a row that could not run says the check keeps failing (D2), and the wallet is not asked', async () => {
    const sim = vi.fn<JupiterLegDeps['simulateSwap']>(async () => {
      throw new Error('Simulation failed (503)');
    });
    const first = await sendJupiterLeg(deps({ simulateSwap: sim }).d, ARGS);
    expect(first).toMatchObject({ kind: 'not-sent', unchecked: true });
    expect(first.kind === 'not-sent' && first.message).not.toBe(CHECK_KEEPS_FAILING);
    const { d } = deps({ simulateSwap: sim });
    const second = await sendJupiterLeg(d, { ...ARGS, uncheckedBefore: 1 });
    expect(second).toMatchObject({ kind: 'not-sent', unchecked: true, message: CHECK_KEEPS_FAILING });
    expect(d.send).not.toHaveBeenCalled();
  });

  it('a lost wallet answer writes a note with no signature, held until its blockhash dies (D1)', async () => {
    const { d, held } = deps({ send: vi.fn(async () => Promise.reject(new Error('Unexpected error'))) });
    const end = await sendJupiterLeg(d, ARGS);
    expect(end.kind).toBe('lost');
    expect(held).toEqual([expect.objectContaining({ signature: null })]);
    expect(held[0]!.lastValidBlockHeight).toBeNull();
  });

  it('a read that lands after the swap was confirmed and released does not bring its note back', async () => {
    // The height read answers only after the confirm: by then the note was released.
    let answerHeight: (h: number) => void = () => {};
    const heightLater = new Promise<number>((r) => (answerHeight = r));
    const { d, held } = deps({ rpc: { getBlockHeight: vi.fn(() => heightLater), getSignatureStatuses: vi.fn(), isBlockhashValid: vi.fn(async () => ({ context: { slot: 5 }, value: true })) } });
    await sendJupiterLeg(d, ARGS);
    expect(held).toHaveLength(0);
    answerHeight(1_000);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(held).toHaveLength(0);
  });

  it('a review shown on a no-fee quote is not called "price moved" for the site fee alone', async () => {
    // Shown: no fee, 10,050. Fresh, fee-bearing: 10,000, about 0.5% under it, past a 0.10% slippage.
    const shown = quote({ outAmount: '10050000000', platformFee: null });
    const { d } = deps({ simulateSwap: vi.fn(async () => OK) });
    const end = await sendJupiterLeg(d, { ...ARGS, shown, slippageBps: 10 });
    expect(end.kind === 'not-sent' && end.title).not.toBe('Price moved');
    // The fee can be taken now: that pays less than the review said, so it is shown again, not sent.
    expect(end).toMatchObject({ kind: 'not-sent', title: 'Quote changed', replan: true });
    expect(d.send).not.toHaveBeenCalled();
  });

  describe('a route whose transaction cannot take the site fee (the 6014 retry, kept)', () => {
    // The fee-bearing build fails with Jupiter's 6014; the one no-fee rebuild passes.
    const SIXTY_FOURTEEN: SwapSimulation = { ok: false, reason: 'custom program error: 0x177e', jupiterIncorrectTokenProgram: true };
    const noFee = quote({ outAmount: '10050000000', otherAmountThreshold: '9949500000', platformFee: null });
    const onRetryRoute = () =>
      deps({
        getQuote: vi.fn<JupiterLegDeps['getQuote']>(async (p) => (p.noPlatformFee ? noFee : quote())),
        simulateSwap: vi.fn<JupiterLegDeps['simulateSwap']>(async () => SIXTY_FOURTEEN).mockResolvedValueOnce(SIXTY_FOURTEEN).mockResolvedValueOnce(OK),
      });

    it('a review that showed the site fee is shown again with none, and the wallet is not asked', async () => {
      const { d } = onRetryRoute();
      const onNoFee = vi.fn();
      const end = await sendJupiterLeg(d, { ...ARGS, onNoFee });
      expect(end).toMatchObject({ kind: 'not-sent', title: 'Quote changed', replan: true });
      expect(end.kind === 'not-sent' && end.message).toBe(
        'The site fee cannot be taken on this route, so the figures changed. Nothing was sent. Review the new figures and press again.',
      );
      // The pair is learned as no-fee, so the review made again quotes what is sent.
      expect(onNoFee).toHaveBeenCalledWith(true);
      expect(d.send).not.toHaveBeenCalled();
    });

    it('a review that already showed no site fee sends the no-fee transaction, and says so', async () => {
      const { d } = onRetryRoute();
      const end = await sendJupiterLeg(d, { ...ARGS, shown: noFee });
      expect(end).toMatchObject({ kind: 'sent', signature: SIG, outcome: 'confirmed', feeWaived: true, quote: noFee });
      expect(d.getQuote).toHaveBeenCalledWith(expect.objectContaining({ noPlatformFee: true }));
      expect(d.send).toHaveBeenCalledTimes(1);
    });
  });

  it('a fresh quote under the reviewed one by more than the slippage is not sent', async () => {
    const { d } = deps({ getQuote: vi.fn(async () => quote({ outAmount: '9800000000' })) });
    const end = await sendJupiterLeg(d, ARGS);
    expect(end).toMatchObject({ kind: 'not-sent', title: 'Price moved', replan: true });
    expect(d.send).not.toHaveBeenCalled();
  });
});

describe('priceChangeOf', () => {
  it('says Jupiter’s price impact as the swap page does, and its warning from 5%', () => {
    expect(priceChangeOf(quote({ priceImpactPct: '0.0123' }))).toEqual({ text: '1.23%', bps: 123n });
    expect(priceChangeOf(quote({ priceImpactPct: '0.00001' }))?.text).toBe('<0.01%');
    expect(priceChangeOf(quote({ priceImpactPct: '-0.07' }))).toEqual({ text: '7.00%', bps: 700n });
  });
  it('a missing or unreadable figure is no figure, never 0%', () => {
    for (const raw of [undefined, '', '  ', 'abc', null]) expect(priceChangeOf(quote({ priceImpactPct: raw as never })), String(raw)).toBeNull();
  });
});

describe('stepOneLanded', () => {
  const rpc = (value: unknown) => ({ getSignatureStatuses: vi.fn(async () => ({ context: { slot: 1 }, value: [value] })) }) as never;
  it('landed only on a confirmed status with no error, failed on a confirmed error', async () => {
    expect(await stepOneLanded(rpc({ confirmationStatus: 'confirmed', err: null, slot: 1, confirmations: 1 }), SIG)).toBe('landed');
    expect(await stepOneLanded(rpc({ confirmationStatus: 'finalized', err: { InstructionError: [0, 'x'] }, slot: 1, confirmations: null }), SIG)).toBe('failed');
  });
  it('no status, a processed one, or a failed read is no answer, never "did not land"', async () => {
    expect(await stepOneLanded(rpc(null), SIG)).toBe('unread');
    expect(await stepOneLanded(rpc({ confirmationStatus: 'processed', err: null, slot: 1, confirmations: 0 }), SIG)).toBe('unread');
    expect(await stepOneLanded({ getSignatureStatuses: vi.fn(async () => Promise.reject(new Error('429'))) } as never, SIG)).toBe('unread');
  });
});

describe('the step 2 note', () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => m.set(k, v), removeItem: (k: string) => m.delete(k) });
  });
  it('is kept per wallet and pool, with the slippage step 1 was reviewed at', () => {
    const w = USER.toBase58();
    saveStepTwo(w, { pool: 'P1', paid: 'quote', kept: 5n, got: 7n, gotExact: true, bps: 250n, signature: SIG, at: Date.now() });
    expect(readStepTwo(w, 'P1')).toMatchObject({ kept: 5n, got: 7n, bps: 250n });
    expect(readStepTwo(w, 'P2')).toBeNull();
    expect(readStepTwo(Keypair.generate().publicKey.toBase58(), 'P1')).toBeNull();
  });
  it('is gone after an hour', () => {
    const w = USER.toBase58();
    saveStepTwo(w, { pool: 'P1', paid: 'token', kept: 5n, got: 7n, gotExact: false, bps: 100n, signature: SIG, at: 0 });
    expect(readStepTwo(w, 'P1', 60 * 60_000 + 1)).toBeNull();
  });
});
