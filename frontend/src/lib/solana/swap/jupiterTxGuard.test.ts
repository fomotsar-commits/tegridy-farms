// @vitest-environment node
//
// NODE, like the other Solana tests (lib/ladder/program.test.ts): under jsdom a
// Uint8Array from the other realm fails web3.js's address and encoding checks.
import { describe, it, expect } from 'vitest';
import { base58 } from '@scure/base';
import { Message, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { NATIVE_MINT, getAssociatedTokenAddressSync } from '@solana/spl-token';
import {
  JUPITER_RECURRING_PROGRAM, JUPITER_SWAP_PROGRAM, JUPITER_TRIGGER_PROGRAM, ROUTE_RENT_CAP_LAMPORTS, balanceRefusal, jupiterTxRefusal, type JupiterTxExpectation,
} from './jupiterTxGuard';
import {
  LIVE_USER, RECURRING_CREATE, RUN_SHARED_SOL_BAYLA, RUN_SOL_BAYLA, SWAP_SHARED_SOL_BAYLA, SWAP_SHARED_USDC_SOL, SWAP_SOL_BAYLA, SWAP_SOL_USDC, SWAP_USDC_SOL, TRIGGER_CREATE,
  TRIGGER_CREATE_EXPIRING,
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

/** Re-encode a transaction after `f` edits its instructions, or swaps a key in place (v0 and legacy alike). */
function edit(b64: string, f: (v: View) => void): string {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'));
  const m = tx.message;
  if (m instanceof Message) {
    const ixs: Ix[] = m.instructions.map((i) => ({ programIdIndex: i.programIdIndex, accountKeyIndexes: [...i.accounts], data: base58.decode(i.data) }));
    const v = { keys: m.accountKeys.map((k) => k.toBase58()), ixs, header: m.header };
    f(v);
    m.accountKeys = v.keys.map((k) => new PublicKey(k));
    m.instructions = ixs.map((i) => ({ programIdIndex: i.programIdIndex, accounts: i.accountKeyIndexes, data: base58.encode(i.data) }));
  } else {
    const ixs = m.compiledInstructions.map((i) => ({ programIdIndex: i.programIdIndex, accountKeyIndexes: [...i.accountKeyIndexes], data: Uint8Array.from(i.data) }));
    const v = { keys: m.staticAccountKeys.map((k) => k.toBase58()), ixs, header: m.header };
    f(v);
    m.staticAccountKeys = v.keys.map((k) => new PublicKey(k));
    m.compiledInstructions = ixs;
  }
  return Buffer.from(new VersionedTransaction(m).serialize()).toString('base64');
}
const find = (v: View, program: string, nth = 0): Ix => v.ixs.filter((i) => v.keys[i.programIdIndex] === program)[nth];
const keyIndex = (v: View, key: string): number => v.keys.indexOf(key);
const putU64 = (d: Uint8Array, at: number, n: bigint) => new DataView(d.buffer, d.byteOffset).setBigUint64(at, n, true);
const putU16 = (d: Uint8Array, at: number, n: number) => new DataView(d.buffer, d.byteOffset).setUint16(at, n, true);
/** System `transfer` of `lamports` from key `from` to key `to`: the wrap Jupiter puts before a swap that sells SOL. */
const transfer = (v: View, from: string, to: string, lamports: bigint): Ix => {
  const data = new Uint8Array(12); data[0] = 2; putU64(data, 4, lamports);
  return { programIdIndex: keyIndex(v, SYSTEM), accountKeyIndexes: [keyIndex(v, from), keyIndex(v, to)], data };
};
const WSOL_ATA = getAssociatedTokenAddressSync(NATIVE_MINT, new PublicKey(LIVE_USER), true).toBase58();

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

describe('the swap sells only from the user’s own account of the coin sold (XCHL-01)', () => {
  // route_v2 names the account it sells from at 1 and pays into at 2; the shared form at 2 and 5.
  const captures = { SWAP_SOL_USDC, SWAP_USDC_SOL, SWAP_SOL_BAYLA, SWAP_SHARED_USDC_SOL, SWAP_SHARED_SOL_BAYLA };
  for (const [name, fx] of Object.entries(captures)) {
    const shared = name.startsWith('SWAP_SHARED');
    it(`${name}: the user’s account of another coin (here the coin bought) as the source is refused`, () => {
      const b64 = edit(fx.tx, (v) => { const j = find(v, JUPITER_SWAP_PROGRAM); j.accountKeyIndexes[shared ? 2 : 1] = j.accountKeyIndexes[shared ? 5 : 2]!; });
      expect(jupiterTxRefusal(b64, swapExpect(fx))).toMatch(/sells from an account that is not your account of the coin shown/);
    });
    it(`${name}: a source loaded from a lookup table is refused`, () => {
      const b64 = edit(fx.tx, (v) => { find(v, JUPITER_SWAP_PROGRAM).accountKeyIndexes[shared ? 2 : 1] = v.keys.length; });
      expect(jupiterTxRefusal(b64, swapExpect(fx))).toMatch(/sells from an account that is not your account of the coin shown/);
    });
  }
});

describe('the test run holds the payer’s balances to the trade shown (XCHL-01, second fence)', () => {
  type Row = { accountIndex: number; mint: string; owner: string; uiTokenAmount: { amount: string } };
  type Run = { fee: number; preBalances: number[]; postBalances: number[]; preTokenBalances: Row[]; postTokenBalances: Row[] };
  const SOL = SWAP_SOL_BAYLA.quote.inputMint;
  const USDC = SWAP_SOL_USDC.quote.outputMint;
  const SOLD = { user: LIVE_USER, inputMint: SOL, inAmount: SWAP_SOL_BAYLA.quote.inAmount };
  const copy = (r: Run): Run => JSON.parse(JSON.stringify(r));
  /** The run with account `i` holding `before`, then `after`, of `mint` for `owner`. */
  const holding = (r: Run, i: number, mint: string, before: string, after: string, owner = LIVE_USER): Run => {
    const c = copy(r);
    c.preTokenBalances.push({ accountIndex: i, mint, owner, uiTokenAmount: { amount: before } });
    c.postTokenBalances.push({ accountIndex: i, mint, owner, uiTokenAmount: { amount: after } });
    return c;
  };

  it('the real runs pass: route_v2 with the rent of the record its exchange opens, and the shared form', () => {
    expect(balanceRefusal(RUN_SOL_BAYLA, SOLD)).toBeNull();
    expect(balanceRefusal(RUN_SHARED_SOL_BAYLA, SOLD)).toBeNull();
  });

  it('one lamport past the amount sold, the network fee and that rent is refused', () => {
    const r = copy(RUN_SOL_BAYLA);
    r.postBalances[0] -= 1;
    expect(balanceRefusal(r, SOLD)).toMatch(/takes more than the amount shown/);
  });

  it('a coin the payer is not selling, taken from an account loaded from the lookup table, is refused', () => {
    // Index 13 is a writable account loaded from the transaction's lookup table: the transaction check cannot read it.
    expect(balanceRefusal(holding(RUN_SOL_BAYLA, 13, USDC, '10000000000', '0'), SOLD)).toMatch(/takes a coin you are not selling/);
    expect(balanceRefusal(holding(RUN_SOL_BAYLA, 13, USDC, '10000000000', '10000000000'), SOLD)).toBeNull();
  });

  it('of the coin sold, exactly the amount shown passes and one unit more is refused', () => {
    const usdcSale = { user: LIVE_USER, inputMint: USDC, inAmount: '5000000' };
    const base: Run = { fee: 5000, preBalances: [1_000_000_000, 2_039_280], postBalances: [999_995_000, 2_039_280], preTokenBalances: [], postTokenBalances: [] };
    expect(balanceRefusal(holding(base, 1, USDC, '9000000', '4000000'), usdcSale)).toBeNull();
    expect(balanceRefusal(holding(base, 1, USDC, '9000000', '3999999'), usdcSale)).toMatch(/takes more than the amount shown/);
  });

  it('the payer’s new account of the coin bought, handed to another owner, is refused: its rent is not an exchange’s record', () => {
    const r = copy(RUN_SOL_BAYLA);
    r.postTokenBalances.find((b) => b.accountIndex === 3)!.owner = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';
    expect(balanceRefusal(r, SOLD)).toMatch(/takes more than the amount shown/);
  });

  it('rent for accounts the route opens is room up to 0.005 SOL in one run, never past it', () => {
    const sale = { user: LIVE_USER, inputMint: SOL, inAmount: '1000' };
    const opens = (rent: bigint): Run => ({
      fee: 5000, preBalances: [10_000_000_000, 0], postBalances: [10_000_000_000 - 5000 - 1000 - Number(rent), Number(rent)], preTokenBalances: [], postTokenBalances: [],
    });
    expect(balanceRefusal(opens(ROUTE_RENT_CAP_LAMPORTS), sale)).toBeNull();
    expect(balanceRefusal(opens(ROUTE_RENT_CAP_LAMPORTS + 1n), sale)).toMatch(/takes more than the amount shown/);
  });

  it('another account past 2^53 lamports (a large pool vault) is no reason to refuse; the payer’s own past it is no verdict', () => {
    const huge = 2 ** 53 + 2;
    const pool = copy(RUN_SOL_BAYLA);
    pool.preBalances[15] = huge;
    pool.postBalances[15] = huge;
    expect(balanceRefusal(pool, SOLD)).toBeNull();
    const payer = copy(RUN_SOL_BAYLA);
    payer.postBalances[0] = huge;
    expect(() => balanceRefusal(payer, SOLD)).toThrow(/balance could not be read/);
  });

  it('a run that gave no balances, or balances it cannot read, is no verdict: it throws', () => {
    const { preBalances: _p, ...noLamports } = RUN_SOL_BAYLA;
    expect(() => balanceRefusal(noLamports, SOLD)).toThrow(/gave no balances/);
    expect(() => balanceRefusal({ ...RUN_SOL_BAYLA, fee: null }, SOLD)).toThrow();
    expect(() => balanceRefusal({ ...RUN_SOL_BAYLA, postTokenBalances: [{ accountIndex: 3, mint: SOL }] }, SOLD)).toThrow(/token balance could not be read/);
  });
});

describe('SOL is wrapped only when SOL is the coin sold (XCHL-01)', () => {
  it('a swap that sells USDC refuses a wrap, even one no larger than the amount sold', () => {
    const fx = SWAP_USDC_SOL;
    const b64 = edit(fx.tx, (v) => {
      // A key the check never reads (Jupiter's event authority) becomes the System program, so a wrap can be added.
      v.keys[keyIndex(v, 'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf')] = SYSTEM;
      v.ixs.unshift(transfer(v, LIVE_USER, WSOL_ATA, BigInt(fx.quote.inAmount)));
    });
    expect(jupiterTxRefusal(b64, swapExpect(fx))).toMatch(/wraps more SOL than the trade sells/);
  });

  it('a limit order funded with USDC refuses a wrap of its amount', () => {
    const b64 = edit(TRIGGER_CREATE.tx, (v) => { v.ixs.push(transfer(v, LIVE_USER, WSOL_ATA, BigInt(TRIGGER_CREATE.makingAmount))); });
    expect(jupiterTxRefusal(b64, triggerExpect())).toMatch(/wraps more SOL than the trade sells/);
  });

  it('a recurring buy funded with USDC refuses a wrap of its deposit', () => {
    const b64 = edit(RECURRING_CREATE.tx, (v) => {
      // The order's own deposit account (unread by the check) becomes the user's wrapped-SOL account.
      v.keys[find(v, JUPITER_RECURRING_PROGRAM).accountKeyIndexes[6]!] = WSOL_ATA;
      v.ixs.push(transfer(v, LIVE_USER, WSOL_ATA, BigInt(RECURRING_CREATE.inAmount)));
    });
    expect(jupiterTxRefusal(b64, recurringExpect())).toMatch(/wraps more SOL than the trade sells/);
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

describe('a limit order’s fields after its two amounts are read (XCHL-05)', () => {
  const ix = (v: View) => find(v, JUPITER_TRIGGER_PROGRAM);
  /** The real order, with every field after the amounts replaced by `tail`. */
  const withTail = (tail: number[]) => edit(TRIGGER_CREATE.tx, (v) => { const j = ix(v); j.data = Uint8Array.from([...j.data.subarray(0, 32), ...tail]); });
  const some16 = (n: number) => [1, n & 0xff, n >> 8];
  const NO_EXPIRY = [0];
  const NO_FEE = [0];
  const SLIPPAGE_0 = some16(0);
  const SEVENTH = [1, 0, 0, 0, 0, 0, 0, 0, 0];

  it('the real orders pass: no expiry, and a 7-day expiry held to the one asked for', () => {
    expect(withTail([...NO_EXPIRY, ...NO_FEE, ...SLIPPAGE_0, ...SEVENTH])).toBe(TRIGGER_CREATE.tx);
    expect(jupiterTxRefusal(TRIGGER_CREATE_EXPIRING.tx, triggerExpect({ ...TRIGGER_CREATE_EXPIRING }))).toBeNull();
  });

  it('an expiry other than the one asked for is refused, and so is one where none was asked, or none where one was', () => {
    const at = TRIGGER_CREATE_EXPIRING.expiredAt;
    expect(jupiterTxRefusal(TRIGGER_CREATE_EXPIRING.tx, triggerExpect({ ...TRIGGER_CREATE_EXPIRING, expiredAt: at + 1 }))).toMatch(/expires at a different time/);
    expect(jupiterTxRefusal(TRIGGER_CREATE_EXPIRING.tx, triggerExpect())).toMatch(/expires at a different time/);
    expect(jupiterTxRefusal(TRIGGER_CREATE.tx, triggerExpect({ expiredAt: at }))).toMatch(/expires at a different time/);
  });

  it.each([1, 10, 81, 9_999])('a fee of %s basis points is refused', (bps) => {
    expect(jupiterTxRefusal(withTail([...NO_EXPIRY, ...some16(bps), ...SLIPPAGE_0, ...SEVENTH]), triggerExpect())).toMatch(/carries a fee/);
  });

  it('a slippage of none passes; any other than 0 is refused', () => {
    expect(jupiterTxRefusal(withTail([...NO_EXPIRY, ...NO_FEE, 0, ...SEVENTH]), triggerExpect())).toBeNull();
    for (const bps of [1, 100, 10_000, 65_535]) {
      expect(jupiterTxRefusal(withTail([...NO_EXPIRY, ...NO_FEE, ...some16(bps), ...SEVENTH]), triggerExpect())).toMatch(/worse price than shown/);
    }
  });

  it('a referral account in its slot is refused (unset is the program’s own id)', () => {
    const b64 = edit(TRIGGER_CREATE.tx, (v) => { ix(v).accountKeyIndexes[6] = ix(v).accountKeyIndexes[4]!; });
    expect(jupiterTxRefusal(b64, triggerExpect())).toMatch(/names a referral account/);
  });

  it('a seventh value other than real orders carry, or none, or anything after it, is refused', () => {
    const head = [...NO_EXPIRY, ...NO_FEE, ...SLIPPAGE_0];
    for (const tail of [[0], [1, 1, 0, 0, 0, 0, 0, 0, 0], [], [...SEVENTH, 0]]) {
      expect(jupiterTxRefusal(withTail([...head, ...tail]), triggerExpect())).toMatch(/carries a value this site does not read/);
    }
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
