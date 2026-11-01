import { describe, it, expect, vi } from 'vitest';
import { solTokenFromSafety, tokenFromChain } from './chainToken';
import { BAYLA_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type TokenSafety } from '../lp/tokenSafety';

const h = vi.hoisted(() => ({ readTokenSafety: vi.fn() }));
vi.mock('../lp/tokenSafety', async (orig) => ({
  ...(await orig<typeof import('../lp/tokenSafety')>()),
  readTokenSafety: h.readTokenSafety,
}));

const CORN = 'CornMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';

type Read = Extract<TokenSafety, { kind: 'read' }>;
const read = (o: Partial<Read> = {}): Read => ({
  kind: 'read',
  mint: CORN,
  verdict: 'ok',
  blocks: [],
  warnings: [],
  name: 'Corn Coin',
  symbol: 'CORN',
  metadataSource: 'metaplex',
  facts: { program: 'spl-token', mintAuthority: null, freezeAuthority: null, supply: 1n, decimals: 6, isInitialized: true, extensions: [], metadataPointer: null, tokenMetadata: null },
  ...o,
});

describe('solTokenFromSafety: a coin for the swap form, from the chain', () => {
  it('takes the decimals and the program from the mint, the ticker and name from its metadata, and is never verified', () => {
    expect(solTokenFromSafety(read())).toEqual({ mint: CORN, symbol: 'CORN', name: 'Corn Coin', decimals: 6, tokenProgram: TOKEN_PROGRAM, verified: false });
    const facts = { ...read().facts!, program: 'token-2022' as const, decimals: 9 };
    expect(solTokenFromSafety(read({ facts }))).toMatchObject({ decimals: 9, tokenProgram: TOKEN_2022_PROGRAM });
  });

  it('names a coin as the pool screens do: a copy of a well-known ticker reads "fake", our own coin by the registry', () => {
    expect(solTokenFromSafety(read({ symbol: 'SOL' }))!.symbol).toBe('fake SOL');
    expect(solTokenFromSafety(read({ mint: BAYLA_MINT, symbol: 'whatever' }))!.symbol).toBe('BAYLA');
  });

  it('a coin with no ticker is named by its first characters, and one with no name by its ticker', () => {
    const t = solTokenFromSafety(read({ symbol: null, name: null }))!;
    expect(t.symbol).toBe('Corn…');
    expect(t.name).toBe('Corn…');
  });

  it('a mint that was not read, is absent, or has no facts gives no coin: the default pair stands', () => {
    expect(solTokenFromSafety(undefined)).toBeNull();
    expect(solTokenFromSafety({ kind: 'unread', mint: CORN, detail: 'HTTP 429' })).toBeNull();
    expect(solTokenFromSafety({ kind: 'absent', mint: CORN })).toBeNull();
    expect(solTokenFromSafety(read({ facts: null }))).toBeNull();
  });
});

describe('tokenFromChain', () => {
  const rpc = vi.fn();

  it('reads the one mint and maps its check', async () => {
    h.readTokenSafety.mockResolvedValueOnce(new Map([[CORN, read()]]));
    expect(await tokenFromChain(rpc, CORN)).toMatchObject({ mint: CORN, symbol: 'CORN', decimals: 6 });
    expect(h.readTokenSafety).toHaveBeenCalledWith(rpc, [CORN]);
  });

  it('a read that throws is null, never an exception on the page', async () => {
    h.readTokenSafety.mockRejectedValueOnce(new Error('the chain did not answer in 20 seconds'));
    expect(await tokenFromChain(rpc, CORN)).toBeNull();
  });
});
