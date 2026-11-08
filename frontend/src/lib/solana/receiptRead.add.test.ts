// An add's card names the pool's own pairing coin (SOL, USDC or BAYLA), read from the add's own
// deposit event. Pinned to real adds into the venue's pools on mainnet, one per pairing coin.
import { describe, expect, it, vi } from 'vitest';
import rows from './lp/__fixtures__/mainnet-history/pool.baylaSol.2026-10-10.transactions.json';
import { settleAddReceipt, type Coin } from './receiptRead';
import { settleReceipt } from '../receipt';

vi.mock('../receipt', async (actual) => ({ ...(await actual<typeof import('../receipt')>()), settleReceipt: vi.fn() }));

type Row = { signature: string; tx: { meta: { logMessages: string[] } } };
const SOL: Coin = { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9 };
const USDC: Coin = { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 };
const BAYLA: Coin = { mint: '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump', symbol: 'BAYLA', decimals: 6 };
const TBB: Coin = { mint: '42cXQvAAr7hcPBPWAS4ocVtDyeJ4Fa6gRR2uG4gppump', symbol: 'TBB', decimals: 6 };

const solAdd = (rows as unknown as Row[]).find((r) => r.signature.startsWith('2HgRKVtT'))!;

const ADDS = [
  {
    name: 'a SOL pool: BAYLA/SOL, 2026-10-10',
    signature: solAdd.signature,
    logs: solAdd.tx.meta.logMessages,
    ask: { pool: 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4', quote: SOL, token: BAYLA, quoteIsToken0: true },
    title: 'Added 0.514851486 SOL + 108,697 BAYLA',
    under: 'to the SOL + BAYLA pool',
  },
  {
    // BAYLA is token0 and USDC token1, so USDC is the pool's quote (quotes.ts: USDC outranks BAYLA).
    name: 'a USDC pool: BAYLA/USDC, 2026-11-01',
    signature: 'mpefmM5QQHZ12BwCvWk5NXPxLcyzgbFjafMB3BdZsici7LhKo8JgLZ3urmdNiiwNcsQHaKacbqfdeoBAsRtAAYg',
    logs: ['Program data: eaPNyTnadTz9HzpLvGLckblBbVMHCtvXzSKJrnp+e7uSd+OTAcSUelpJ8QQGAAAAGP/zMeQAAACbRcMoAAAAAFGGnIgRAAAAaM4hAwAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='],
    ask: { pool: 'J35mQ6UF9PpB6bQMes2TRVUMbJVPwMYjcfapbkdm8mYm', quote: USDC, token: BAYLA, quoteIsToken0: false },
    title: 'Added 52.5471 USDC + 75,306 BAYLA',
    under: 'to the USDC + BAYLA pool',
  },
  {
    name: 'a BAYLA pool: TBB/BAYLA, 2026-11-06',
    signature: '4rPuBCkb2M4jf3bt1CHUUesFGspqnB2vQob4x8x6GYqarwY5872uyrnAu5efvbVpcpaj8f87Ugw5pDM8YUTsMxM8',
    logs: ['Program data: eaPNyTnadTxLUMNVksBsVXaH4vmu1LjmyEORj9wtxZMmqhqETVCPmifaVwgBAAAAtYscaAEAAACsJQvCAAAAAJGiWGIAAAAAiED+NAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='],
    ask: { pool: '6511GLnToAGtwVREnLXVJ5rgat4cm2Uvgvyoj5oaLoLD', quote: BAYLA, token: TBB, quoteIsToken0: false },
    title: 'Added 889.0778 BAYLA + 1,649 TBB',
    under: 'to the BAYLA + TBB pool',
  },
];

describe('an add’s card, read from its transaction', () => {
  it.each(ADDS)('$name: the title and the line under it name the pool’s own pairing coin', async ({ signature, logs, ask, title, under }) => {
    const rpc = { getTransaction: vi.fn(async () => ({ meta: { err: null, fee: 5000, logMessages: logs } })) } as unknown as Parameters<typeof settleAddReceipt>[0];
    vi.mocked(settleReceipt).mockClear();
    await settleAddReceipt(rpc, signature, { ...ask, leg: null });
    expect(settleReceipt).toHaveBeenCalledOnce();
    expect(vi.mocked(settleReceipt).mock.calls[0]).toEqual([signature, { title, under, fee: { kind: 'add', network: '0.000005 SOL' } }]);
  });
});
