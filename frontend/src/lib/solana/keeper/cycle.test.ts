import { describe, it, expect } from 'vitest';
import { Keypair, TransactionInstruction } from '@solana/web3.js';
import { jupiterLeg } from './cycle';
import type { JupiterApi, JupiterQuote, SwapInstructions } from './jupiterApi';
import { NAMES_OTHER_ACCOUNT } from './plan';

const owner = Keypair.generate().publicKey;
const quote = {} as JupiterQuote;
const leg = (tag: number, extra = 0): SwapInstructions => ({
  swap: new TransactionInstruction({ programId: owner, keys: [], data: Buffer.from([tag]) }),
  lookupTables: [],
  extra,
});
const PLAIN = 1;
const SHARED = 2;
const tagOf = (si: SwapInstructions) => si.swap.data[0];

/** Jupiter answering the plain ask with one route and the shared-accounts ask with another. */
function jupiter(plain: SwapInstructions, shared: SwapInstructions) {
  const asked: boolean[] = [];
  const api = {
    swapInstructions: async (_q: JupiterQuote, _u: unknown, o?: { shared?: boolean }) => {
      asked.push(o?.shared === true);
      return o?.shared ? shared : plain;
    },
  } as unknown as JupiterApi;
  return { api, asked };
}

describe('jupiterLeg', () => {
  it('asks again through Jupiter’s shared accounts when the route names the keeper’s other coin’s account', async () => {
    const j = jupiter(leg(PLAIN), leg(SHARED));
    const si = await jupiterLeg(j.api, owner, quote, (x) => (tagOf(x) === PLAIN ? NAMES_OTHER_ACCOUNT : null));
    expect(tagOf(si)).toBe(SHARED);
    expect(j.asked).toEqual([false, true]);
  });

  it('takes a route that passes as it is, with no second ask', async () => {
    const j = jupiter(leg(PLAIN), leg(SHARED));
    const si = await jupiterLeg(j.api, owner, quote, () => null);
    expect(tagOf(si)).toBe(PLAIN);
    expect(j.asked).toEqual([false]);
  });

  it('refuses any other problem at once', async () => {
    const j = jupiter(leg(PLAIN), leg(SHARED));
    await expect(jupiterLeg(j.api, owner, quote, () => 'the swap asks another signer')).rejects.toThrow('the swap asks another signer');
    expect(j.asked).toEqual([false]);
  });

  it('checks the shared route the same way', async () => {
    const still = jupiter(leg(PLAIN), leg(SHARED));
    await expect(jupiterLeg(still.api, owner, quote, () => NAMES_OTHER_ACCOUNT)).rejects.toThrow(NAMES_OTHER_ACCOUNT);
    const other = jupiter(leg(PLAIN), leg(SHARED));
    await expect(jupiterLeg(other.api, owner, quote, (x) => (tagOf(x) === PLAIN ? NAMES_OTHER_ACCOUNT : 'the swap is for other coins'))).rejects.toThrow('the swap is for other coins');
  });

  it('refuses a route Jupiter added instructions to, either way', async () => {
    const plain = jupiter(leg(PLAIN, 1), leg(SHARED));
    await expect(jupiterLeg(plain.api, owner, quote, () => null)).rejects.toThrow('Jupiter added instructions');
    const shared = jupiter(leg(PLAIN), leg(SHARED, 1));
    await expect(jupiterLeg(shared.api, owner, quote, (x) => (tagOf(x) === PLAIN ? NAMES_OTHER_ACCOUNT : null))).rejects.toThrow('Jupiter added instructions');
  });
});
