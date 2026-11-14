// Follows two real orders to their real fills (__fixtures__/koios-tx-info-two-fills.json),
// through the same parsing the page uses, with the proxy's answers stubbed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAddressBech32 } from './address';
import { ADA } from './minswapV2';
import {
  EXPIRY_MARGIN_SLOTS,
  cancelInFlight,
  dropOrderNote,
  markOrderCancelSent,
  markOrderSettled,
  markOrderSubmitted,
  pollDelayMs,
  readOrderNotes,
  readOrderStatus,
  settledStatus,
  writeOrderNote,
  type PendingOrder,
} from './orderWatch';
import { ASCEND, ORDER_TXS, fixture } from './testkit.fixture';

const NIGHT = { policyId: '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa', assetName: '4e49474854' };
const FILLS = fixture<{ tx_hash: string }[]>('koios-tx-info-two-fills.json');

function note(txHash: string, bech: string, assetIn: PendingOrder['assetIn'], assetOut: PendingOrder['assetOut']): PendingOrder {
  const a = parseAddressBech32(bech)!;
  const label = (x: PendingOrder['assetIn']) => (x.policyId === '' ? { ticker: 'ADA', decimals: 6 } : { ticker: 'COIN', decimals: 0 });
  return { txHash, orderIndex: 0, traderHex: a.hex, traderPaymentHash: a.payment.hash, assetIn, assetOut, amountIn: '1', minimumReceive: '1', inLabel: label(assetIn), outLabel: label(assetOut), ttlSlot: 201256000, submitted: true, placedAt: 1 };
}

const SELL_ASCEND = note(ORDER_TXS.tokenIn, 'addr1qyawx3jznhwfhsen5kg3dq4nxgvkexrw7fa6uj8qkx95cynn60n5e0298xn7eyj7lzks2lv5tcmxsqsu7ne7sa7jf4xsulzg6g', ASCEND, ADA);
const BUY_NIGHT = note(ORDER_TXS.adaIn, 'addr1qxflw7x7effnuy8j699cw03e7px2efsxlhgs5gjsvmaqdj23uxk5phjd4ljhup35cu2dmmkzktaadra6v5j6amt2sm7spk6n2a', ADA, NIGHT);

/** Answers /api/cardano/<op> from a table; anything not in it is a 500. */
function stubProxy(table: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = new URL(url, 'https://site.test');
      const op = u.pathname.replace('/api/cardano/', '');
      const key = `${op}?${u.searchParams.toString()}`;
      const hit = key in table ? table[key] : op in table ? table[op] : undefined;
      if (hit === undefined) return new Response('no', { status: 500 });
      return new Response(JSON.stringify(hit), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('readOrderStatus', () => {
  it('finds the real fill of a token-for-ADA order and what it paid', async () => {
    stubProxy({
      utxo: [{ tx_hash: SELL_ASCEND.txHash, tx_index: 0, is_spent: true }],
      tip: [{ abs_slot: 201256000, block_height: 14108900, block_time: 1792822300 }],
      txstatus: [{ tx_hash: SELL_ASCEND.txHash, num_confirmations: 92 }],
      credtxs: [
        { tx_hash: SELL_ASCEND.txHash, block_height: 14108808 },
        { tx_hash: '1d0b2abf488f1861a63725e3d3bdc161ec5696bbf0c6f622e605f4a4afac58cd', block_height: 14108809 },
      ],
      tx: FILLS.filter((f) => f.tx_hash.startsWith('1d0b2abf')),
    });
    // 113,723,847 lovelace came back: the 2 ADA deposit and 111.723847 ADA bought.
    expect(await readOrderStatus(SELL_ASCEND)).toEqual({
      kind: 'filled',
      fillTx: '1d0b2abf488f1861a63725e3d3bdc161ec5696bbf0c6f622e605f4a4afac58cd',
      received: 111723847n,
      depositBack: 2000000n,
    });
  });

  it('finds the real fill of an ADA-for-token order', async () => {
    stubProxy({
      utxo: [{ tx_hash: BUY_NIGHT.txHash, tx_index: 0, is_spent: true }],
      tip: [{ abs_slot: 201256000, block_height: 14108900, block_time: 1792822300 }],
      txstatus: [{ tx_hash: BUY_NIGHT.txHash, num_confirmations: 93 }],
      credtxs: [{ tx_hash: 'e0418770aca5be8e9142c764c3c188d2b45df398e59c2b9a21def0f2359b09d7', block_height: 14108811 }],
      tx: FILLS.filter((f) => f.tx_hash.startsWith('e0418770')),
    });
    expect(await readOrderStatus(BUY_NIGHT)).toEqual({
      kind: 'filled',
      fillTx: 'e0418770aca5be8e9142c764c3c188d2b45df398e59c2b9a21def0f2359b09d7',
      received: 4063782168n,
      depositBack: 2000000n,
    });
  });

  // No returned order was in the mainnet sample, so these spenders are written by hand, in the
  // shape a batcher's refund takes: the order's own coins back to the trader, less its fee.
  function refund(order: PendingOrder, bech: string, value: string, assets: unknown[] | null) {
    return [
      {
        tx_hash: 'ab'.repeat(32),
        inputs: [{ tx_hash: order.txHash, tx_index: 0 }],
        outputs: [{ tx_index: 0, payment_addr: { bech32: bech }, value, inline_datum: null, asset_list: assets }],
      },
    ];
  }
  const spentAt = (order: PendingOrder) => ({
    utxo: [{ tx_hash: order.txHash, tx_index: 0, is_spent: true }],
    tip: [{ abs_slot: 1, block_height: 14108900, block_time: 1 }],
    txstatus: [{ tx_hash: order.txHash, num_confirmations: 5 }],
    credtxs: [{ tx_hash: 'ab'.repeat(32), block_height: 14108899 }],
  });

  it('says returned when a token-for-ADA order’s token comes back', async () => {
    const bech = 'addr1qyawx3jznhwfhsen5kg3dq4nxgvkexrw7fa6uj8qkx95cynn60n5e0298xn7eyj7lzks2lv5tcmxsqsu7ne7sa7jf4xsulzg6g';
    stubProxy({ ...spentAt(SELL_ASCEND), tx: refund(SELL_ASCEND, bech, '2000000', [{ policy_id: ASCEND.policyId, asset_name: ASCEND.assetName, quantity: '104749799' }]) });
    expect(await readOrderStatus(SELL_ASCEND)).toEqual({ kind: 'returned', fillTx: 'ab'.repeat(32) });
  });

  it('says returned when an ADA-for-token order’s ADA comes back with no token', async () => {
    const bech = 'addr1qxflw7x7effnuy8j699cw03e7px2efsxlhgs5gjsvmaqdj23uxk5phjd4ljhup35cu2dmmkzktaadra6v5j6amt2sm7spk6n2a';
    stubProxy({ ...spentAt(BUY_NIGHT), tx: refund(BUY_NIGHT, bech, '752000000', null) });
    expect(await readOrderStatus(BUY_NIGHT)).toEqual({ kind: 'returned', fillTx: 'ab'.repeat(32) });
  });

  it('says returned when the trader’s own cancel pays it all back, less the network fee', async () => {
    // cancelTx.ts's shape: the order its one input, one output to the trader (the collateral is
    // not among tx_info's inputs or outputs).
    const bech = 'addr1qxflw7x7effnuy8j699cw03e7px2efsxlhgs5gjsvmaqdj23uxk5phjd4ljhup35cu2dmmkzktaadra6v5j6amt2sm7spk6n2a';
    stubProxy({ ...spentAt(BUY_NIGHT), tx: refund(BUY_NIGHT, bech, '751763072', null) });
    expect(await readOrderStatus(BUY_NIGHT)).toEqual({ kind: 'returned', fillTx: 'ab'.repeat(32) });
  });

  it('says placed, with its depth, while the order waits', async () => {
    stubProxy({ utxo: [{ tx_hash: BUY_NIGHT.txHash, tx_index: 0, is_spent: false }], txstatus: [{ tx_hash: BUY_NIGHT.txHash, num_confirmations: 3 }] });
    expect(await readOrderStatus(BUY_NIGHT)).toEqual({ kind: 'placed', depth: 3 });
  });

  it('says not seen when the chain has not shown the transaction, before its expiry', async () => {
    stubProxy({ utxo: [], txstatus: [{ tx_hash: BUY_NIGHT.txHash, num_confirmations: null }], tip: [{ abs_slot: 201255999, block_height: 1, block_time: 1 }] });
    expect(await readOrderStatus(BUY_NIGHT)).toEqual({ kind: 'not-seen' });
  });

  it('still says not seen just past its expiry: the reads may lag each other (review 2026-10-24)', async () => {
    stubProxy({ utxo: [], txstatus: [{ tx_hash: BUY_NIGHT.txHash, num_confirmations: null }], tip: [{ abs_slot: 201256001, block_height: 1, block_time: 1 }] });
    expect(await readOrderStatus(BUY_NIGHT)).toEqual({ kind: 'not-seen' });
  });

  it('says expired, safe to retry, only well past its expiry', async () => {
    stubProxy({ utxo: [], txstatus: [{ tx_hash: BUY_NIGHT.txHash, num_confirmations: null }], tip: [{ abs_slot: 201256001 + EXPIRY_MARGIN_SLOTS, block_height: 1, block_time: 1 }] });
    expect(await readOrderStatus(BUY_NIGHT)).toEqual({ kind: 'expired' });
  });

  it('says spent, not a figure, when one batch pays the trader twice (two of their orders)', async () => {
    const bech = 'addr1qyawx3jznhwfhsen5kg3dq4nxgvkexrw7fa6uj8qkx95cynn60n5e0298xn7eyj7lzks2lv5tcmxsqsu7ne7sa7jf4xsulzg6g';
    const tx = [
      {
        tx_hash: 'ab'.repeat(32),
        inputs: [{ tx_hash: SELL_ASCEND.txHash, tx_index: 0 }],
        outputs: [
          { tx_index: 0, payment_addr: { bech32: bech }, value: '113723847', inline_datum: null, asset_list: null },
          { tx_index: 1, payment_addr: { bech32: bech }, value: '2000000', inline_datum: null, asset_list: [{ policy_id: ASCEND.policyId, asset_name: ASCEND.assetName, quantity: '5' }] },
        ],
      },
    ];
    stubProxy({ ...spentAt(SELL_ASCEND), tx });
    expect(await readOrderStatus(SELL_ASCEND)).toEqual({ kind: 'spent', fillTx: 'ab'.repeat(32) });
  });

  it('reads past a stranger output it cannot parse in the trader’s history', async () => {
    const bech = 'addr1qyawx3jznhwfhsen5kg3dq4nxgvkexrw7fa6uj8qkx95cynn60n5e0298xn7eyj7lzks2lv5tcmxsqsu7ne7sa7jf4xsulzg6g';
    const tx = [
      {
        tx_hash: 'ab'.repeat(32),
        inputs: [{ tx_hash: SELL_ASCEND.txHash, tx_index: 0 }],
        outputs: [
          { tx_index: 0, payment_addr: { bech32: 'Ae2tdPwUPEZ5faoeL5MHatcnmV9U5HW2NvfQRCRvjATKa1HNiBbHmmT5vKy' }, value: '1000000', inline_datum: null, asset_list: null },
          { tx_index: 1, payment_addr: { bech32: bech }, value: '113723847', inline_datum: null, asset_list: null },
        ],
      },
    ];
    stubProxy({ ...spentAt(SELL_ASCEND), tx });
    expect((await readOrderStatus(SELL_ASCEND)).kind).toBe('filled');
  });

  it('says unknown, never failed, when a read fails', async () => {
    stubProxy({});
    const s = await readOrderStatus(BUY_NIGHT);
    expect(s.kind).toBe('unknown');
  });

  it('finds the fill oldest first, however busy the wallet has been since (review 2026-10-24)', async () => {
    // Twenty later transactions of the trader's, listed newest first: the fill, a block after
    // the order, would sit past a newest-first search's twelve.
    const later = Array.from({ length: 20 }, (_, i) => ({ tx_hash: (i + 1).toString(16).padStart(64, 'c'), block_height: 14108900 - i }));
    stubProxy({
      utxo: [{ tx_hash: SELL_ASCEND.txHash, tx_index: 0, is_spent: true }],
      tip: [{ abs_slot: 201256000, block_height: 14108900, block_time: 1792822300 }],
      txstatus: [{ tx_hash: SELL_ASCEND.txHash, num_confirmations: 92 }],
      credtxs: [...later, { tx_hash: '1d0b2abf488f1861a63725e3d3bdc161ec5696bbf0c6f622e605f4a4afac58cd', block_height: 14108809 }, { tx_hash: SELL_ASCEND.txHash, block_height: 14108808 }],
      tx: FILLS.filter((f) => f.tx_hash.startsWith('1d0b2abf')),
    });
    expect((await readOrderStatus(SELL_ASCEND)).kind).toBe('filled');
  });

  it('says spent, not filled, when the spender is not in the trader’s history', async () => {
    stubProxy({
      utxo: [{ tx_hash: BUY_NIGHT.txHash, tx_index: 0, is_spent: true }],
      tip: [{ abs_slot: 1, block_height: 14108900, block_time: 1 }],
      txstatus: [{ tx_hash: BUY_NIGHT.txHash, num_confirmations: 93 }],
      credtxs: [],
    });
    expect(await readOrderStatus(BUY_NIGHT)).toEqual({ kind: 'spent', fillTx: null });
  });
});

describe('order notes', () => {
  it('keep an order across a reload, newest first, and drop it on request', () => {
    writeOrderNote({ ...BUY_NIGHT, placedAt: Date.now() });
    writeOrderNote({ ...SELL_ASCEND, placedAt: Date.now() });
    expect(readOrderNotes().map((n) => n.txHash)).toEqual([SELL_ASCEND.txHash, BUY_NIGHT.txHash]);
    dropOrderNote(SELL_ASCEND.txHash);
    expect(readOrderNotes().map((n) => n.txHash)).toEqual([BUY_NIGHT.txHash]);
  });

  it('say whether the wallet sent it, and are marked when it did', () => {
    expect(writeOrderNote({ ...BUY_NIGHT, submitted: false, placedAt: Date.now() })).toBe(true);
    expect(readOrderNotes()[0]?.submitted).toBe(false);
    markOrderSubmitted(BUY_NIGHT.txHash);
    expect(readOrderNotes()[0]?.submitted).toBe(true);
  });

  it('forget notes a week old and anything malformed', () => {
    localStorage.setItem('tegridy.minswap.orders.v1', JSON.stringify([{ ...BUY_NIGHT, placedAt: 0 }, { txHash: 'x' }, 7]));
    expect(readOrderNotes()).toEqual([]);
  });

  it('keep how an order ended, amounts and all, so a later visit need not read it again', () => {
    writeOrderNote({ ...BUY_NIGHT, placedAt: Date.now() });
    const filled = { kind: 'filled' as const, fillTx: 'f'.repeat(64), received: 1580426944n, depositBack: 2000000n };
    markOrderSettled(BUY_NIGHT.txHash, { kind: 'placed', depth: 3 });
    expect(settledStatus(readOrderNotes()[0]!)).toBeNull(); // not final: not kept
    markOrderSettled(BUY_NIGHT.txHash, filled);
    expect(settledStatus(readOrderNotes()[0]!)).toEqual(filled);
    markOrderSettled(BUY_NIGHT.txHash, { kind: 'spent', fillTx: 'a'.repeat(64) });
    expect(settledStatus(readOrderNotes()[0]!)).toEqual({ kind: 'spent', fillTx: 'a'.repeat(64) });
  });

  it('are read every 10 s while an open one is fresh, once a minute after (a stuck order must not spend the day’s reads)', () => {
    const now = 1_000_000_000;
    const fresh = { txHash: 'a'.repeat(64), placedAt: now - 60_000 };
    const old = { txHash: 'b'.repeat(64), placedAt: now - 11 * 60_000 };
    const open = () => false;
    expect(pollDelayMs([fresh, old], open, now)).toBe(10_000);
    expect(pollDelayMs([old], open, now)).toBe(60_000);
    // A fresh order that has ended does not keep the page fast.
    expect(pollDelayMs([fresh, old], (tx) => tx === fresh.txHash, now)).toBe(60_000);
    expect(pollDelayMs([], open, now)).toBe(60_000);
  });

  it('never keep "spent, spender not found": it may be a read lagging another, so the next visit looks again', () => {
    writeOrderNote({ ...BUY_NIGHT, placedAt: Date.now() });
    markOrderSettled(BUY_NIGHT.txHash, { kind: 'spent', fillTx: null });
    // Not written at all (the read below would also drop it: two layers, each held here).
    expect(JSON.parse(localStorage.getItem('tegridy.minswap.orders.v1') ?? '[]')[0]).not.toHaveProperty('settled');
    expect(readOrderNotes()[0]?.settled).toBeUndefined();
    // Nor is one read back if a note somehow holds it.
    localStorage.setItem('tegridy.minswap.orders.v1', JSON.stringify([{ ...BUY_NIGHT, placedAt: Date.now(), settled: { kind: 'spent', fillTx: null } }]));
    expect(settledStatus(readOrderNotes()[0]!)).toBeNull();
  });

  it('drop a malformed saved ending, never the note: that order is read again', () => {
    localStorage.setItem('tegridy.minswap.orders.v1', JSON.stringify([{ ...BUY_NIGHT, placedAt: Date.now(), settled: { kind: 'filled', fillTx: 'f'.repeat(64), received: '1e9', depositBack: '2' } }]));
    const [n] = readOrderNotes();
    expect(n?.txHash).toBe(BUY_NIGHT.txHash);
    expect(n?.settled).toBeUndefined();
    expect(settledStatus(n!)).toBeNull();
  });

  it('keep the trader’s cancel, so a reload shows it on its way and not a second Cancel', () => {
    writeOrderNote({ ...BUY_NIGHT, placedAt: Date.now() });
    const cancel = { txHash: 'c'.repeat(64), sentAt: Date.now(), ttlSlot: 201_300_900 };
    markOrderCancelSent(BUY_NIGHT.txHash, cancel);
    expect(readOrderNotes()[0]?.cancel).toEqual(cancel);
    expect(cancelInFlight(readOrderNotes()[0]!, Date.now())).toBe(true);
  });

  it('drop a malformed cancel, never the note', () => {
    localStorage.setItem('tegridy.minswap.orders.v1', JSON.stringify([{ ...BUY_NIGHT, placedAt: Date.now(), cancel: { txHash: 'zz', sentAt: 1, ttlSlot: 1 } }]));
    const [n] = readOrderNotes();
    expect(n?.txHash).toBe(BUY_NIGHT.txHash);
    expect(n?.cancel).toBeUndefined();
  });

  it('hold a cancel on its way until its expiry and the margin pass, then let the trader cancel again', () => {
    const sentAt = 1_000_000_000;
    const o = { cancel: { txHash: 'c'.repeat(64), sentAt, ttlSlot: 1 } };
    expect(cancelInFlight(o, sentAt + 34 * 60_000)).toBe(true);
    expect(cancelInFlight(o, sentAt + 36 * 60_000)).toBe(false);
    expect(cancelInFlight({}, sentAt)).toBe(false);
  });

  it('are read every 10 s again for 10 minutes after a cancel, even on an old order', () => {
    const now = 1_000_000_000;
    const old = { txHash: 'b'.repeat(64), placedAt: now - 60 * 60_000 };
    expect(pollDelayMs([old], () => false, now)).toBe(60_000);
    expect(pollDelayMs([{ ...old, cancel: { txHash: 'c'.repeat(64), sentAt: now - 30_000, ttlSlot: 1 } }], () => false, now)).toBe(10_000);
  });
});
