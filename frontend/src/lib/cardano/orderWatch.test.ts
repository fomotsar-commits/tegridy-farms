// Follows two real orders to their real fills (__fixtures__/koios-tx-info-two-fills.json),
// through the same parsing the page uses, with the proxy's answers stubbed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAddressBech32 } from './address';
import { ADA } from './minswapV2';
import { readOrderNotes, readOrderStatus, writeOrderNote, dropOrderNote, type PendingOrder } from './orderWatch';
import { ASCEND, ORDER_TXS, fixture } from './testkit.fixture';

const NIGHT = { policyId: '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa', assetName: '4e49474854' };
const FILLS = fixture<{ tx_hash: string }[]>('koios-tx-info-two-fills.json');

function note(txHash: string, bech: string, assetIn: PendingOrder['assetIn'], assetOut: PendingOrder['assetOut']): PendingOrder {
  const a = parseAddressBech32(bech)!;
  return { txHash, orderIndex: 0, traderHex: a.hex, traderPaymentCred: a.payment.hash, assetIn, assetOut, amountIn: '1', minimumReceive: '1', placedAt: 1 };
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

  it('says placed, with its depth, while the order waits', async () => {
    stubProxy({ utxo: [{ tx_hash: BUY_NIGHT.txHash, tx_index: 0, is_spent: false }], txstatus: [{ tx_hash: BUY_NIGHT.txHash, num_confirmations: 3 }] });
    expect(await readOrderStatus(BUY_NIGHT)).toEqual({ kind: 'placed', depth: 3 });
  });

  it('says not seen when the chain has not shown the transaction', async () => {
    stubProxy({ utxo: [], txstatus: [{ tx_hash: BUY_NIGHT.txHash, num_confirmations: null }] });
    expect(await readOrderStatus(BUY_NIGHT)).toEqual({ kind: 'not-seen' });
  });

  it('says unknown, never failed, when a read fails', async () => {
    stubProxy({});
    const s = await readOrderStatus(BUY_NIGHT);
    expect(s.kind).toBe('unknown');
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

  it('forget notes a week old and anything malformed', () => {
    localStorage.setItem('tegridy.cardano.orders.v1', JSON.stringify([{ ...BUY_NIGHT, placedAt: 0 }, { txHash: 'x' }, 7]));
    expect(readOrderNotes()).toEqual([]);
  });
});
