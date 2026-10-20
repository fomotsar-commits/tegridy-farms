// What a visitor SEES when the edge answers with its last good copy (2026-10-15).
//
// The edge (api/_lib/gecko-upstream.js) can hand the bungalow's market strip and
// trade tape an earlier copy when GeckoTerminal refuses, instead of an error.
// That is only honest if the page says so: an old price that looks live is worse
// than "try again". These render the real strip and the real tape against a
// mocked edge and read the words off the screen.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { Bungalow } from '../../lib/bungalows';
import { BungalowMarket } from './BungalowMarket';

vi.mock('../chart/PriceChart', () => ({ PriceChart: () => null }));
vi.mock('../ui/CardArt', () => ({ CardArt: () => null }));
vi.mock('../../lib/heat/tapeNames', () => ({
  fetchTapeNames: async () => ({}),
  isNamed: () => false,
}));

const POOL = '31ZmTzEufRDBGKsJ7NicCkEKxtPQgAEMQvdbCuUfE6GX';
const BUNGALOW = {
  id: 'bayla',
  symbol: 'BAYLA',
  market: { network: 'solana', pool: POOL, label: 'BAYLA / SOL on PumpSwap' },
} as unknown as Bungalow;

const MARKET = { data: { attributes: { name: 'BAYLA / SOL', base_token_price_usd: '0.00056' } } };
const TAPE = {
  data: [{
    attributes: {
      block_timestamp: '2026-10-15T11:40:00Z',
      kind: 'buy',
      tx_hash: 'tx1',
      tx_from_address: 'DJFP3qJroFzcvZj3YowPmrNu6WoMo6njVB3dywTewua5',
      from_token_amount: '0.1',
      to_token_amount: '120',
      volume_in_usd: '19.5',
    },
  }],
};

function edge(stale: boolean) {
  return vi.fn(async (url: string) => {
    const headers = new Headers({ 'X-Gecko-Fetched-At': String(Date.now() - 20 * 60_000) });
    if (stale) headers.set('X-Gecko-Stale', '1');
    const body = String(url).includes('pool-market') ? MARKET : TAPE;
    return { ok: true, status: 200, headers, json: async () => body } as unknown as Response;
  });
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('the bungalow market says how old its figures are', () => {
  it('labels a kept copy on the strip and on the tape', async () => {
    vi.stubGlobal('fetch', edge(true));
    render(<BungalowMarket bungalow={BUNGALOW} />);

    const strip = await screen.findByTestId('market-as-of');
    expect(strip.textContent).toMatch(/^As of .+ last copy we read\.$/);
    const tape = await screen.findByTestId('trades-as-of');
    expect(tape.textContent).toMatch(/last copy we read/);
  });

  it('names the read time of a fresh but older answer, without calling it a kept copy', async () => {
    vi.stubGlobal('fetch', edge(false));
    render(<BungalowMarket bungalow={BUNGALOW} />);

    const strip = await screen.findByTestId('market-as-of');
    expect(strip.textContent).toMatch(/^As of /);
    expect(strip.textContent).not.toMatch(/last copy/);
    await waitFor(() => expect(screen.getByTestId('trades-as-of').textContent).toMatch(/^As of /));
  });
});
