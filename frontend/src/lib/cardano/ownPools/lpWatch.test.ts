// Following an LP order to its end: a deposit filled is its LP tokens back, returned is the
// coins back; a withdrawal is the reverse. A filled deposit notes where it entered, so fees
// earned can be counted later; the notes' keys never name the chain (CodeQL reads that as a
// wallet secret).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADA } from '../minswapV2';
import { entryIndex } from './lpMath';
import { lastSentAt, lpCancelInFlight, markLpCancelSent, markLpSettled, readLpEntries, readLpNotes, readLpOrderStatus, settledLpStatus, writeLpNote, type LpOrderNote } from './lpWatch';
import { WORLD, trader } from './testWorld.fixture';

const T = trader('1');
const ORDER_TX = '0a'.repeat(32);
const FILL_TX = '0b'.repeat(32);
const LP = { policyId: WORLD.scripts.authen.hash, assetName: WORLD.lpName };

function note(kind: LpOrderNote['kind']): LpOrderNote {
  return {
    kind,
    txHash: ORDER_TX,
    orderIndex: 0,
    traderHex: T.hex,
    traderPaymentHash: T.payment.hash,
    token: WORLD.token,
    lp: LP,
    tokenLabel: { ticker: 'TOK', decimals: 6 },
    amountAda: '10000000',
    amountToken: '500000000',
    lpAmount: '2000000',
    ttlSlot: 201256000,
    submitted: true,
    placedAt: Date.now(),
  };
}

/** The proxy, answering the order spent by FILL_TX, which pays the trader `out`. */
function spentBy(out: { value: string; asset_list: { policy_id: string; asset_name: string; quantity: string }[] }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const op = new URL(url, 'https://site.test').pathname.replace('/api/cardano/', '');
      const body =
        op === 'utxo' ? [{ tx_hash: ORDER_TX, tx_index: 0, is_spent: true }]
        : op === 'tip' ? [{ abs_slot: 201256000, block_height: 14108900, block_time: 1792822300 }]
        : op === 'txstatus' ? [{ tx_hash: ORDER_TX, num_confirmations: 5 }]
        : op === 'credtxs' ? [{ tx_hash: ORDER_TX, block_height: 14108895 }, { tx_hash: FILL_TX, block_height: 14108897 }]
        : op === 'tx' ? [{ tx_hash: FILL_TX, inputs: [{ tx_hash: ORDER_TX, tx_index: 0 }], outputs: [{ payment_addr: { bech32: T.bech32 }, tx_index: 0, ...out }] }]
        : undefined;
      return body === undefined ? new Response('no', { status: 500 }) : new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('readLpOrderStatus', () => {
  it('a deposit paid back in LP tokens is filled, with how many', async () => {
    spentBy({ value: '2000000', asset_list: [{ policy_id: LP.policyId, asset_name: LP.assetName, quantity: '2236067' }] });
    expect(await readLpOrderStatus(note('deposit'))).toEqual({ kind: 'filled', fillTx: FILL_TX, lp: 2236067n, ada: 0n, token: 0n });
  });

  it('a deposit paid back in its own coins is returned', async () => {
    spentBy({ value: '10000000', asset_list: [{ policy_id: WORLD.token.policyId, asset_name: WORLD.token.assetName, quantity: '500000000' }] });
    expect((await readLpOrderStatus(note('deposit'))).kind).toBe('returned');
  });

  it('a withdrawal paid in both coins is filled; paid back in LP tokens, returned', async () => {
    spentBy({ value: '12000000', asset_list: [{ policy_id: WORLD.token.policyId, asset_name: WORLD.token.assetName, quantity: '200000000' }] });
    expect(await readLpOrderStatus(note('withdraw'))).toEqual({ kind: 'filled', fillTx: FILL_TX, lp: 0n, ada: 10_000_000n, token: 200_000_000n });
    spentBy({ value: '2000000', asset_list: [{ policy_id: LP.policyId, asset_name: LP.assetName, quantity: '2000000' }] });
    expect((await readLpOrderStatus(note('withdraw'))).kind).toBe('returned');
  });
});

describe('notes', () => {
  it('keep orders and entries under keys that never name the chain', () => {
    writeLpNote(note('deposit'));
    markLpSettled(note('deposit'), { kind: 'filled', fillTx: FILL_TX, lp: 2236067n, ada: 0n, token: 0n });
    const keys = Object.keys(localStorage);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k.toLowerCase()).not.toContain('cardano');
  });

  it('a filled deposit settles its note and notes where it entered the pool', () => {
    expect(writeLpNote(note('deposit'))).toBe(true);
    markLpSettled(note('deposit'), { kind: 'filled', fillTx: FILL_TX, lp: 2236067n, ada: 0n, token: 0n });
    expect(settledLpStatus(readLpNotes()[0]!)).toEqual({ kind: 'filled', fillTx: FILL_TX, lp: 2236067n, ada: 0n, token: 0n });
    expect(readLpEntries()).toEqual([{ traderHex: T.hex, lpName: LP.assetName, lp: '2236067', index: entryIndex(10_000_000n, 500_000_000n, 2236067n).toString(), txHash: ORDER_TX }]);
  });

  it('a returned deposit notes no entry: nothing entered', () => {
    writeLpNote(note('deposit'));
    markLpSettled(note('deposit'), { kind: 'returned', fillTx: FILL_TX });
    expect(readLpEntries()).toEqual([]);
  });

  it('drops a malformed note rather than reading it', () => {
    localStorage.setItem('tegridy.ownpools.orders.v1', JSON.stringify([{ ...note('deposit'), token: ADA, lpAmount: 'x' }]));
    expect(readLpNotes()).toEqual([]);
  });
});

describe('notes over time', () => {
  it('keep an order that has not settled past a week (its coins are still in it), and drop a settled one', () => {
    const old = { ...note('deposit'), placedAt: Date.now() - 8 * 24 * 3600 * 1000 };
    writeLpNote(old);
    expect(readLpNotes().map((n) => n.txHash)).toEqual([ORDER_TX]);
    markLpSettled(old, { kind: 'returned', fillTx: FILL_TX });
    expect(readLpNotes()).toEqual([]);
  });

  it('a filled withdrawal retires the oldest entries first, so fees are never counted on LP that left', () => {
    const d1 = { ...note('deposit'), txHash: '01'.repeat(32) };
    const d2 = { ...note('deposit'), txHash: '02'.repeat(32) };
    markLpSettled(d1, { kind: 'filled', fillTx: FILL_TX, lp: 1000n, ada: 0n, token: 0n });
    markLpSettled(d2, { kind: 'filled', fillTx: FILL_TX, lp: 500n, ada: 0n, token: 0n });
    const w = { ...note('withdraw'), txHash: '03'.repeat(32), lpAmount: '1200' };
    markLpSettled(w, { kind: 'filled', fillTx: FILL_TX, lp: 0n, ada: 1n, token: 1n });
    expect(readLpEntries().map((e) => [e.txHash, e.lp])).toEqual([['02'.repeat(32), '300']]);
  });
});

describe('a cancel of the order', () => {
  const CANCEL = { txHash: '0c'.repeat(32), sentAt: 1_000_000, ttlSlot: 201_256_900 };

  it('is noted on the order before it leaves, and read back with it', () => {
    writeLpNote(note('deposit'));
    markLpCancelSent(ORDER_TX, CANCEL);
    expect(readLpNotes()[0]!.cancel).toEqual(CANCEL);
  });

  it('a malformed cancel is dropped, never the order: it is read, and offered, again', () => {
    localStorage.setItem('tegridy.ownpools.orders.v1', JSON.stringify([{ ...note('deposit'), cancel: { ...CANCEL, txHash: 'x' } }]));
    const [n] = readLpNotes();
    expect(n?.txHash).toBe(ORDER_TX);
    expect(n?.cancel).toBeUndefined();
  });

  it('is on its way until its 15-minute expiry and the 20-minute margin have passed, then the button comes back', () => {
    const n = { ...note('deposit'), cancel: CANCEL };
    expect(lpCancelInFlight(note('deposit'), CANCEL.sentAt)).toBe(false);
    expect(lpCancelInFlight(n, CANCEL.sentAt + 34 * 60_000)).toBe(true);
    expect(lpCancelInFlight(n, CANCEL.sentAt + 35 * 60_000)).toBe(false);
  });

  it('counts as freshly sent for how often the order is read', () => {
    expect(lastSentAt({ placedAt: 5, cancel: CANCEL })).toBe(CANCEL.sentAt);
    expect(lastSentAt({ placedAt: 5 })).toBe(5);
  });

  it('once it lands, the order reads as returned by the cancel itself', async () => {
    spentBy({ value: '13750000', asset_list: [{ policy_id: WORLD.token.policyId, asset_name: WORLD.token.assetName, quantity: '500000000' }] });
    expect(await readLpOrderStatus(note('deposit'))).toEqual({ kind: 'returned', fillTx: FILL_TX });
    spentBy({ value: '3750000', asset_list: [{ policy_id: LP.policyId, asset_name: LP.assetName, quantity: '2000000' }] });
    expect(await readLpOrderStatus(note('withdraw'))).toEqual({ kind: 'returned', fillTx: FILL_TX });
  });
});
