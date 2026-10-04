// A supply that was not read must throw, never arrive as 0: the burn is minted minus
// supply, so a zero supply would print "100% burnt" for an outage.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readSolanaSupply } from './bungalowBurnSolana';

const MINT = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';

function serve(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const spy = vi.fn(async () => ({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  }) as unknown as Response);
  vi.stubGlobal('fetch', spy);
  return spy;
}

const supply = (value: unknown) => [{ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value } }];

afterEach(() => vi.unstubAllGlobals());

describe('readSolanaSupply', () => {
  it('returns the supply in base units and the decimals', async () => {
    serve(supply({ amount: '989301008790751', decimals: 6, uiAmountString: '989301008.790751' }));
    await expect(readSolanaSupply(MINT)).resolves.toEqual({ supplyRaw: 989_301_008_790751n, decimals: 6 });
  });

  it('asks the same-origin proxy for getTokenSupply on that mint, never a Solana host', async () => {
    const spy = serve(supply({ amount: '1', decimals: 6 }));
    await readSolanaSupply(MINT);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/solrpc');
    expect(JSON.parse(String(init.body))).toEqual([{ jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [MINT] }]);
  });

  it('keeps a read zero supply as zero', async () => {
    serve(supply({ amount: '0', decimals: 6 }));
    await expect(readSolanaSupply(MINT)).resolves.toEqual({ supplyRaw: 0n, decimals: 6 });
  });

  it.each([
    ['an RPC error', [{ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'node is behind' } }]],
    ['"not a mint" (-32602)', [{ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid param' } }]],
    ['no answer for the call', []],
    ['a body with no result member', [{ jsonrpc: '2.0', id: 1 }]],
    ['a result with no value', [{ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 } } }]],
    ['a null value', supply(null)],
    ['an empty amount, which BigInt would read as 0', supply({ amount: '', decimals: 6 })],
    ['a missing amount', supply({ decimals: 6 })],
    ['a numeric amount', supply({ amount: 989301008790751, decimals: 6 })],
    ['missing decimals', supply({ amount: '989301008790751' })],
    ['decimals that are not a whole number', supply({ amount: '989301008790751', decimals: 6.5 })],
  ])('throws on %s', async (_name, body) => {
    serve(body);
    await expect(readSolanaSupply(MINT)).rejects.toThrow();
  });

  it('throws when the proxy answers 200 with a page that is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    }) as unknown as Response));
    await expect(readSolanaSupply(MINT)).rejects.toThrow();
  });

  it('throws on a rate limit and on a failed proxy', async () => {
    serve({}, { ok: false, status: 429 });
    await expect(readSolanaSupply(MINT)).rejects.toThrow();
    serve({}, { ok: false, status: 502 });
    await expect(readSolanaSupply(MINT)).rejects.toThrow();
  });

  it('throws when the network is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(readSolanaSupply(MINT)).rejects.toThrow();
  });
});
