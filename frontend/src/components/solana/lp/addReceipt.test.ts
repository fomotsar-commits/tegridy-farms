// Island answer thirty-two: an add's receipt card lays the pool's LPs on its floor. The card rises
// with no count (lps null); the count is then read from the pool's share holders (holders.ts) and
// settled onto that card. A read that fails leaves null: the floor is bedrock and you, never a
// wrong count. The adder's own share is in the read (it is at 'confirmed', like the add), and the
// adder already has a brick of their own: the count is the OTHER wallets.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { raiseAddReceipt } from './addReceipt';
import { clearReceipt, lastReceipt, raiseReceipt } from '../../../lib/receipt';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import type { Holder, HoldersRead } from '../../../lib/solana/lp/holders';

vi.mock('../../../lib/solana/receiptRead', () => ({ settleAddReceipt: vi.fn(() => Promise.resolve()) }));

const WALLET = '8SxYtKrtPZoEwtgpkXmn7TrS7VGa1qSiGPHnYjfFWQuv';
const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const SIG = 'add-' + 'x'.repeat(80);
const rpc = { getTransaction: vi.fn() } as unknown as Parameters<typeof raiseAddReceipt>[0];
const view = {
  address: 'Pool1111111111111111111111111111111111111111',
  tokenMint: BAYLA,
  quote: { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', decimals: 9 },
  quoteIsToken0: true,
  config: null,
} as unknown as PoolView;
const holder = (owner: string): Holder => ({ owner, amount: 1n, value: null, tooSmall: false });
const ok = (owners: string[]): HoldersRead => ({ kind: 'ok', holders: owners.map(holder), capped: false });
/** Every promise the read chained is settled. */
const settled = () => new Promise<void>((r) => setTimeout(r, 0));

function raise(holders: ((v: PoolView) => Promise<HoldersRead>) | undefined) {
  raiseAddReceipt(rpc, SIG, { view, wallet: WALLET, ticker: 'BAYLA', decimals: 6, holders });
}

beforeEach(() => clearReceipt());

describe('the add’s LP count', () => {
  it('the card rises at once with no count, before anything is read', () => {
    raise(() => new Promise(() => undefined));
    expect(lastReceipt()).toMatchObject({ signature: SIG, action: 'added', lps: null });
  });

  it('three other wallets holding a share of the pool settle 3, read for this pool', async () => {
    const holders = vi.fn(() => Promise.resolve(ok(['A1', 'B2', 'C3'])));
    raise(holders);
    await vi.waitFor(() => expect(lastReceipt()?.lps).toBe(3));
    expect(holders).toHaveBeenCalledTimes(1);
    expect(holders).toHaveBeenCalledWith(view);
  });

  it('the adder’s own share is not a second brick: it is left out of the count', async () => {
    raise(() => Promise.resolve(ok([WALLET, 'A1', 'B2'])));
    await vi.waitFor(() => expect(lastReceipt()?.lps).toBe(2));
  });

  it('the adder alone in the pool: no other brick', async () => {
    raise(() => Promise.resolve(ok([WALLET])));
    await vi.waitFor(() => expect(lastReceipt()?.lps).toBe(0));
  });

  it('a read the chain did not answer leaves null, never a count', async () => {
    raise(() => Promise.resolve({ kind: 'unread', detail: 'getTokenLargestAccounts failed' }));
    await settled();
    expect(lastReceipt()?.lps).toBeNull();
  });

  it('a read that throws settles nothing and throws nothing', async () => {
    raise(() => Promise.reject(new Error('rpc down')));
    await settled();
    expect(lastReceipt()?.lps).toBeNull();
  });

  it('a reader with no holders read reads nothing', async () => {
    raise(undefined);
    await settled();
    expect(lastReceipt()).toMatchObject({ signature: SIG, lps: null });
  });

  it('a late count never touches a newer card', async () => {
    let answer: (r: HoldersRead) => void = () => undefined;
    raise(() => new Promise<HoldersRead>((r) => (answer = r)));
    raiseReceipt({ ...lastReceipt()!, signature: 'newer', lps: null });
    answer(ok(['A1', 'B2']));
    await settled();
    expect(lastReceipt()).toMatchObject({ signature: 'newer', lps: null });
  });
});
