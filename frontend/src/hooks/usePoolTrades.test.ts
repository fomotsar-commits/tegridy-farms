// The tape's one real trap: which leg of a swap is the bungalow's own token.
//
// GeckoTerminal reports a fill as from_token → to_token. On a BUY the bungalow
// token is what you RECEIVE (`to_token_amount`); on a SELL it is what you GIVE
// (`from_token_amount`). Reading the wrong one prints the SOL leg as a token
// size — 0.61 instead of 116,200 — which looks like a plausible number and is
// therefore the kind of mistake nobody notices. Both directions are pinned.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { usePoolTrades } from './usePoolTrades';

const MINT = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const SOL = 'So11111111111111111111111111111111111111112';

function trade(kind: 'buy' | 'sell', tokenAmount: string, solAmount: string) {
  return {
    attributes: {
      block_timestamp: '2026-08-28T07:42:18Z',
      kind,
      tx_hash: `tx-${kind}-${tokenAmount}`,
      tx_from_address: 'DJFP3qJroFzcvZj3YowPmrNu6WoMo6njVB3dywTewua5',
      // buy: SOL in → token out. sell: token in → SOL out.
      from_token_address: kind === 'buy' ? SOL : MINT,
      from_token_amount: kind === 'buy' ? solAmount : tokenAmount,
      to_token_address: kind === 'buy' ? MINT : SOL,
      to_token_amount: kind === 'buy' ? tokenAmount : solAmount,
      volume_in_usd: '65.19',
    },
  };
}

function mockFetch(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response);
}

beforeEach(() => { vi.stubGlobal('fetch', mockFetch({ data: [] })); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('usePoolTrades', () => {
  it('takes the RECEIVED leg on a buy and the GIVEN leg on a sell', async () => {
    vi.stubGlobal('fetch', mockFetch({
      data: [trade('buy', '522.26', '0.0003'), trade('sell', '116200.35', '0.61')],
    }));
    const { result } = renderHook(() => usePoolTrades('solana', 'pool'));
    await waitFor(() => expect(result.current.trades.length).toBe(2));

    const [buy, sell] = result.current.trades;
    expect(buy.kind).toBe('buy');
    expect(buy.tokenAmount, 'a buy must report the token received, not the SOL paid').toBeCloseTo(522.26);
    expect(sell.kind).toBe('sell');
    expect(sell.tokenAmount, 'a sell must report the token given, not the SOL received').toBeCloseTo(116200.35);
  });

  it('reports a failed read as an outage, and leaves the tape empty rather than fake', async () => {
    vi.stubGlobal('fetch', mockFetch({}, false));
    const { result } = renderHook(() => usePoolTrades('solana', 'pool'));
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.error).toMatch(/outage/i);
    expect(result.current.trades).toEqual([]);
  });

  it('rejects a payload whose shape it cannot trust rather than rendering it', async () => {
    // `kind` outside buy|sell — the tape has no label for it, so validation must
    // fail instead of rendering an unlabelled row.
    vi.stubGlobal('fetch', mockFetch({
      data: [{ attributes: { block_timestamp: 'x', kind: 'mint', tx_hash: 't' } }],
    }));
    const { result } = renderHook(() => usePoolTrades('solana', 'pool'));
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.trades).toEqual([]);
  });

  it('issues nothing when the bungalow declares no pool', () => {
    const spy = mockFetch({ data: [] });
    vi.stubGlobal('fetch', spy);
    renderHook(() => usePoolTrades(null, null));
    expect(spy).not.toHaveBeenCalled();
  });
});
