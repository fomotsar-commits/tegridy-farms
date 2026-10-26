// @vitest-environment node
//
// NODE, like the other Solana tests (lib/ladder/program.test.ts): under jsdom a
// Uint8Array from the other realm fails web3.js's address and encoding checks.
import { describe, it, expect } from 'vitest';
import bs58 from 'bs58';
import { Message, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { JUPITER_RECURRING_PROGRAM, JUPITER_SWAP_PROGRAM, JUPITER_TRIGGER_PROGRAM, jupiterTxRefusal, type JupiterTxExpectation } from './jupiterTxGuard';
import {
  LIVE_USER, RECURRING_CREATE, SWAP_SHARED_SOL_BAYLA, SWAP_SHARED_USDC_SOL, SWAP_SOL_BAYLA, SWAP_SOL_USDC, SWAP_USDC_SOL, TRIGGER_CREATE,
} from './__fixtures__/jupiterLive';

// SECURITY REGRESSION — what a Jupiter-built Solana transaction may contain.
//
// The site used to hand Jupiter's base64 to the wallet unread. Every case below
// starts from a REAL unsigned transaction captured from Jupiter's API and changes one
// thing a hostile or tampered answer could change. The live shapes passing is half
// the point: a guard that refuses real swaps breaks the venue.

const CAP = 5_000_000;
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SYSTEM = '11111111111111111111111111111111';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

type Fx = typeof SWAP_SOL_USDC;
const swapExpect = (fx: Fx, over: Partial<Extract<JupiterTxExpectation, { kind: 'swap' }>> = {}): JupiterTxExpectation =>
  ({ kind: 'swap', user: LIVE_USER, quote: fx.quote, feeBps: 50, feeAccount: fx.feeAccount, maxPriorityLamports: CAP, ...over });
const triggerExpect = (over = {}): JupiterTxExpectation =>
  ({ kind: 'trigger-create', user: LIVE_USER, ...TRIGGER_CREATE, maxPriorityLamports: CAP, ...over });
const recurringExpect = (over = {}): JupiterTxExpectation =>
  ({ kind: 'recurring-create', user: LIVE_USER, ...RECURRING_CREATE, maxPriorityLamports: CAP, ...over });

interface Ix { programIdIndex: number; accountKeyIndexes: number[]; data: Uint8Array }
interface View { keys: string[]; ixs: Ix[]; header: { numRequiredSignatures: number } }

/** Re-encode a transaction after `f` edits its instructions (v0 and legacy alike). */
function edit(b64: string, f: (v: View) => void): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
  const m = tx.message;
  if (m instanceof Message) {
    const ixs: Ix[] = m.instructions.map((i) => ({ programIdIndex: i.programIdIndex, accountKeyIndexes: [...i.accounts], data: bs58.decode(i.data) }));
    f({ keys: m.accountKeys.map((k) => k.toBase58()), ixs, header: m.header });
    m.instructions = ixs.map((i) => ({ programIdIndex: i.programIdIndex, accounts: i.accountKeyIndexes, data: bs58.encode(i.data) }));
  } else {
    const ixs = m.compiledInstructions.map((i) => ({ programIdIndex: i.programIdIndex, accountKeyIndexes: [...i.accountKeyIndexes], data: Uint8Array.from(i.data) }));
    f({ keys: m.staticAccountKeys.map((k) => k.toBase58()), ixs, header: m.header });
    m.compiledInstructions = ixs;
  }
  return Buffer.from(new VersionedTransaction(m).serialize()).toString('base64');
}
const find = (v: View, program: string, nth = 0): Ix => v.ixs.filter((i) => v.keys[i.programIdIndex] === program)[nth];
const keyIndex = (v: View, key: string): number => v.keys.indexOf(key);
const putU64 = (d: Uint8Array, at: number, n: bigint) => new DataView(d.buffer, d.byteOffset).setBigUint64(at, n, true);
const putU16 = (d: Uint8Array, at: number, n: number) => new DataView(d.buffer, d.byteOffset).setUint16(at, n, true);

describe('the live Jupiter transactions pass', () => {
  for (const [name, fx] of Object.entries({ SWAP_SOL_USDC, SWAP_USDC_SOL, SWAP_SOL_BAYLA, SWAP_SHARED_USDC_SOL, SWAP_SHARED_SOL_BAYLA })) {
    it(`${name} (a real swap, venue fee attached) passes`, () => {
      expect(jupiterTxRefusal(fx.tx, swapExpect(fx))).toBeNull();
    });
  }
  it('a real limit-order placement passes', () => {
    expect(jupiterTxRefusal(TRIGGER_CREATE.tx, triggerExpect())).toBeNull();
  });
  it('a real recurring-buy placement (a legacy transaction) passes', () => {
    expect(jupiterTxRefusal(RECURRING_CREATE.tx, recurringExpect())).toBeNull();
  });
});

describe('a tampered swap is refused', () => {
  const fx = SWAP_SOL_USDC;
  const refusal = (b64: string, over = {}) => jupiterTxRefusal(b64, swapExpect(fx, over));

  it('a token Approve slipped in beside the swap', () => {
    const b64 = edit(fx.tx, (v) => {
      const data = new Uint8Array(9); data[0] = 4; putU64(data, 1, 2n ** 64n - 1n);
      v.ixs.push({ programIdIndex: keyIndex(v, TOKEN), accountKeyIndexes: [keyIndex(v, LIVE_USER), keyIndex(v, fx.feeAccount), keyIndex(v, LIVE_USER)], data });
    });
    expect(refusal(b64)).toMatch(/token call outside the trade/);
  });

  it('SOL sent to another account', () => {
    const b64 = edit(fx.tx, (v) => { find(v, SYSTEM).accountKeyIndexes[1] = keyIndex(v, fx.feeAccount); });
    expect(refusal(b64)).toMatch(/sends SOL somewhere other/);
  });

  it('more SOL wrapped than the trade sells', () => {
    const b64 = edit(fx.tx, (v) => { putU64(find(v, SYSTEM).data, 4, BigInt(fx.quote.inAmount) + 1n); });
    expect(refusal(b64)).toMatch(/wraps more SOL/);
  });

  it('a durable nonce, which would let the signed swap be replayed later', () => {
    const b64 = edit(fx.tx, (v) => {
      const data = new Uint8Array(4); data[0] = 4;
      v.ixs.unshift({ programIdIndex: keyIndex(v, SYSTEM), accountKeyIndexes: [keyIndex(v, LIVE_USER), keyIndex(v, LIVE_USER), keyIndex(v, LIVE_USER)], data });
    });
    expect(refusal(b64)).toMatch(/system call other than wrapping/);
  });

  it('the wrapped-SOL account closed into another wallet', () => {
    const b64 = edit(fx.tx, (v) => { find(v, TOKEN, 1).accountKeyIndexes[1] = keyIndex(v, fx.feeAccount); });
    expect(refusal(b64)).toMatch(/closes a token account into another wallet/);
  });

  it('the swap paying into an account that is not the user’s', () => {
    const b64 = edit(fx.tx, (v) => { find(v, JUPITER_SWAP_PROGRAM).accountKeyIndexes[2] = keyIndex(v, fx.feeAccount); });
    expect(refusal(b64)).toMatch(/pays into an account that is not yours/);
  });

  it('the output redirected through destination_token_account', () => {
    const b64 = edit(fx.tx, (v) => { find(v, JUPITER_SWAP_PROGRAM).accountKeyIndexes[7] = keyIndex(v, fx.feeAccount); });
    expect(refusal(b64)).toMatch(/redirects what you receive/);
  });

  it('the swap authorised by another wallet', () => {
    const b64 = edit(fx.tx, (v) => { find(v, JUPITER_SWAP_PROGRAM).accountKeyIndexes[0] = keyIndex(v, fx.feeAccount); });
    expect(refusal(b64)).toMatch(/authorised by another wallet/);
  });

  it('a different amount sold', () => {
    const b64 = edit(fx.tx, (v) => { putU64(find(v, JUPITER_SWAP_PROGRAM).data, 8, BigInt(fx.quote.inAmount) * 2n); });
    expect(refusal(b64)).toMatch(/sells a different amount/);
  });

  it('a worse minimum than the quote shown (quoted out or slippage)', () => {
    const lowOut = edit(fx.tx, (v) => { putU64(find(v, JUPITER_SWAP_PROGRAM).data, 16, 1n); });
    expect(refusal(lowOut)).toMatch(/worse price/);
    const looseSlip = edit(fx.tx, (v) => { putU16(find(v, JUPITER_SWAP_PROGRAM).data, 24, 10_000); });
    expect(refusal(looseSlip)).toMatch(/worse price/);
  });

  it('a quote the user never saw', () => {
    expect(refusal(fx.tx, { quote: { ...fx.quote, outAmount: String(BigInt(fx.quote.outAmount) + 1n) } })).toMatch(/worse price/);
  });

  it('positive slippage kept by whoever holds the fee account', () => {
    const b64 = edit(fx.tx, (v) => { putU16(find(v, JUPITER_SWAP_PROGRAM).data, 28, 50); });
    expect(refusal(b64)).toMatch(/keeps part of a better fill/);
  });

  it('a different fee rate than the venue set', () => {
    const b64 = edit(fx.tx, (v) => { putU16(find(v, JUPITER_SWAP_PROGRAM).data, 26, 1000); });
    expect(refusal(b64)).toMatch(/different fee/);
    expect(refusal(fx.tx, { feeBps: 0, feeAccount: null })).toMatch(/different fee/);
  });

  it("the venue's fee paid to another account", () => {
    const b64 = edit(fx.tx, (v) => { find(v, JUPITER_SWAP_PROGRAM).accountKeyIndexes[10] = keyIndex(v, LIVE_USER); });
    expect(refusal(b64)).toMatch(/venue's fee to another account/);
  });

  it("the venue's fee paid to another account in the shared-accounts form too", () => {
    const shared = SWAP_SHARED_USDC_SOL;
    const b64 = edit(shared.tx, (v) => { find(v, JUPITER_SWAP_PROGRAM).accountKeyIndexes[12] = keyIndex(v, LIVE_USER); });
    expect(jupiterTxRefusal(b64, swapExpect(shared))).toMatch(/venue's fee to another account/);
  });

  it('a priority fee above the disclosed 0.005 SOL cap', () => {
    const b64 = edit(fx.tx, (v) => {
      const price = v.ixs.find((i) => v.keys[i.programIdIndex] === COMPUTE_BUDGET && i.data[0] === 3)!;
      putU64(price.data, 1, 10n ** 12n);
    });
    expect(refusal(b64)).toMatch(/priority fee is above the disclosed cap/);
  });

  it('a second signer', () => {
    const b64 = edit(fx.tx, (v) => { v.header.numRequiredSignatures = 2; });
    expect(refusal(b64)).toMatch(/not signed by your wallet alone/);
  });

  it('a call into a program the swap does not use, beside the real swap', () => {
    // The swap itself is untouched, so only the program allowlist can refuse this.
    const b64 = edit(fx.tx, (v) => {
      v.ixs.push({ programIdIndex: keyIndex(v, fx.feeAccount), accountKeyIndexes: [keyIndex(v, LIVE_USER)], data: new Uint8Array([1, 2, 3]) });
    });
    expect(refusal(b64)).toMatch(/calls a program this trade does not use/);
  });

  it('a program loaded from a lookup table', () => {
    const b64 = edit(fx.tx, (v) => { find(v, JUPITER_SWAP_PROGRAM).programIdIndex = v.keys.length; });
    expect(refusal(b64)).toMatch(/runs a program from a lookup table/);
  });

  it('two swaps in one transaction', () => {
    const b64 = edit(fx.tx, (v) => { const j = find(v, JUPITER_SWAP_PROGRAM); v.ixs.push({ ...j, data: Uint8Array.from(j.data) }); });
    expect(refusal(b64)).toMatch(/more than one trade/);
  });

  it('a Jupiter instruction the site never asks for', () => {
    const b64 = edit(fx.tx, (v) => { find(v, JUPITER_SWAP_PROGRAM).data.set([0xe5, 0x17, 0xcb, 0x97, 0x7b, 0x6a, 0xe3, 0xad], 0); });
    expect(refusal(b64)).toMatch(/kind of Jupiter swap this site does not sign/);
  });

  it('bytes that are not a transaction', () => {
    expect(refusal('not-base64!')).toMatch(/could not be read/);
  });
});

describe('a tampered limit order is refused', () => {
  const ix = (v: View) => find(v, JUPITER_TRIGGER_PROGRAM);
  it('different amounts than shown', () => {
    const b64 = edit(TRIGGER_CREATE.tx, (v) => { putU64(ix(v).data, 24, 1n); });
    expect(jupiterTxRefusal(b64, triggerExpect())).toMatch(/different amounts/);
  });
  it('placed for another wallet', () => {
    const b64 = edit(TRIGGER_CREATE.tx, (v) => { ix(v).accountKeyIndexes[1] = ix(v).accountKeyIndexes[2]; });
    expect(jupiterTxRefusal(b64, triggerExpect())).toMatch(/another wallet/);
  });
  it('different coins than shown', () => {
    expect(jupiterTxRefusal(TRIGGER_CREATE.tx, triggerExpect({ outputMint: SWAP_SOL_BAYLA.quote.outputMint }))).toMatch(/different coins/);
  });
});

describe('a tampered recurring buy is refused', () => {
  const ix = (v: View) => find(v, JUPITER_RECURRING_PROGRAM);
  it('a larger deposit than shown', () => {
    const b64 = edit(RECURRING_CREATE.tx, (v) => { putU64(ix(v).data, 16, 10n ** 12n); });
    expect(jupiterTxRefusal(b64, recurringExpect())).toMatch(/different amounts/);
  });
  it('a different schedule than shown', () => {
    expect(jupiterTxRefusal(RECURRING_CREATE.tx, recurringExpect({ intervalSeconds: 3600 }))).toMatch(/different schedule/);
  });
  it('funded from an account that is not the user’s', () => {
    const b64 = edit(RECURRING_CREATE.tx, (v) => { ix(v).accountKeyIndexes[5] = ix(v).accountKeyIndexes[0]; });
    expect(jupiterTxRefusal(b64, recurringExpect())).toMatch(/funded from an account that is not yours/);
  });
});

describe('cancels', () => {
  const user = new PublicKey(LIVE_USER);
  it('refuse a transaction that is not a cancel at all', () => {
    expect(jupiterTxRefusal(TRIGGER_CREATE.tx, { kind: 'trigger-cancel', user: user.toBase58(), order: 'x', maxPriorityLamports: CAP })).toMatch(/not a limit-order cancel/);
    expect(jupiterTxRefusal(RECURRING_CREATE.tx, { kind: 'recurring-cancel', user: user.toBase58(), order: 'x', maxPriorityLamports: CAP })).toMatch(/not a recurring-buy cancel/);
  });
});
