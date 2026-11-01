// @vitest-environment node
//
// The dashboard's reading of the keeper's transactions. The figures are the keeper's own of
// 2026-10-31 (its BRAINLET trip that opened Pump.fun's trader account, a deposit, a wrap),
// with a withdrawal and a refused trip added.
import { describe, it, expect } from 'vitest';
import { JUPITER_PROGRAM } from './plan';
import { byDay, expectedHoldings, madeSol, readActivity, results, type RpcTx } from './history';

const KEEPER = '9WAugU3g3YECwuEuoPy3NEH5Co475fHATGdjr2dy2Fcz';
const OWNER_WALLET = 'Upmhw8i6RSLXoj4yGzq9ZYLXb4UzZMRm7BSX8BxCdEd';
const VENUE = 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT';
const POOL = 'HaRnur2ETP4bFtjUU4haQcFVYrCDTSaJfjKY3E3bDDD';
const JUP = JUPITER_PROGRAM.toBase58();
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BRAINLET = '4XKGjKaKowFvL5sYwh2AKx72vj9iwC8MNvpL44E9pump';
const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const SYSTEM = '11111111111111111111111111111111';
const POOLS = new Set([POOL]);

interface Acct {
  address: string;
  pre: number;
  post: number;
  token?: { mint: string; owner: string; pre: number | null; post: number | null; decimals?: number };
}

/** A transaction: the first account pays; `programs` are the top-level instructions' programs. */
function tx(o: { sig: string; slot?: number; at?: number; accounts: Acct[]; programs: string[]; loaded?: Acct[]; fee?: number; err?: unknown }): RpcTx {
  const all = [...o.accounts, ...(o.loaded ?? [])];
  const keys = [...o.accounts.map((a) => a.address), ...o.programs];
  const index = (a: Acct) => all.indexOf(a) < o.accounts.length ? all.indexOf(a) : keys.length + all.indexOf(a) - o.accounts.length;
  const balance = (a: Acct, side: 'pre' | 'post') => ({ accountIndex: index(a), mint: a.token!.mint, owner: a.token!.owner, uiTokenAmount: { amount: String(a.token![side]), decimals: a.token!.decimals ?? 6 } });
  const lamports = (side: 'pre' | 'post') => [...o.accounts.map((a) => a[side]), ...o.programs.map(() => 1), ...(o.loaded ?? []).map((a) => a[side])];
  return {
    slot: o.slot ?? 100,
    blockTime: o.at ?? 1_793_484_000,
    transaction: { signatures: [o.sig], message: { accountKeys: keys, instructions: o.programs.map((_, i) => ({ programIdIndex: o.accounts.length + i })) } },
    meta: {
      err: o.err ?? null,
      fee: o.fee ?? 5000,
      preBalances: lamports('pre'),
      postBalances: lamports('post'),
      preTokenBalances: all.filter((a) => a.token && a.token.pre !== null).map((a) => balance(a, 'pre')),
      postTokenBalances: all.filter((a) => a.token && a.token.post !== null).map((a) => balance(a, 'post')),
      loadedAddresses: { writable: (o.loaded ?? []).map((a) => a.address), readonly: [] },
    },
  };
}

const read = (t: RpcTx) => readActivity(t, KEEPER, VENUE, POOLS);

// The BRAINLET trip of 2026-10-31 21:36Z: the keeper's wallet paid the fee, its new BRAINLET
// account's rent, and Pump.fun's trader account; its wrapped SOL grew by the gap.
const trip = tx({
  sig: 'trip',
  fee: 6294,
  accounts: [
    { address: KEEPER, pre: 97_006_405, post: 94_165_471 },
    { address: 'DhPyHxCizgkhgYzkrGvF5vFushKRMqdmYvULkn4GGbHC', pre: 0, post: 1_488_440, token: { mint: BRAINLET, owner: KEEPER, pre: null, post: 48_298_714 } },
    { address: '2GK38o149SdbNrzKhNdEuQfWf4EWdrhd2ZZ7UYhPB5y2', pre: 403_926_365, post: 404_408_174, token: { mint: WSOL, owner: KEEPER, pre: 402_437_925, post: 402_919_734, decimals: 9 } },
    { address: '75eYSo91WgFbK3NYYgcbjywReXVtffDoh3QZuu5iXKCN', pre: 0, post: 1_346_200 },
    { address: 'E3rz9nA3rnYShuHFK5kjbzwJSyhJEi7kQJkNNd4gncMM', pre: 344_737_109, post: 331_838_692, token: { mint: WSOL, owner: 'Bkr8XPZySJmcUAxKSDNCcH5KE2WDs2Y3GeZLRbeATSfB', pre: 343_000_000, post: 330_101_583, decimals: 9 } },
    { address: POOL, pre: 5_000_000, post: 5_000_000 },
  ],
  programs: [JUP, VENUE],
});

// The owner's BAYLA send: the owner paid, and the rent of the keeper's new BAYLA account.
const deposit = tx({
  sig: 'deposit',
  accounts: [
    { address: OWNER_WALLET, pre: 66_001_465, post: 64_407_627 },
    { address: 'C71vx3isFdj3AyjyRA3HjJLb1nnZ1yptwkzu4TvnXyXA', pre: 0, post: 1_513_840, token: { mint: BAYLA, owner: KEEPER, pre: null, post: 4_455_000_000 } },
    { address: KEEPER, pre: 94_165_471, post: 94_165_471 },
    // An account the sender opened for itself: its rent is no deposit of the keeper's.
    { address: 'SendersOwnNewAccount111111111111111111111111', pre: 0, post: 2_039_280 },
  ],
  programs: [SYSTEM],
});

describe('readActivity: one transaction, as what the keeper gained or spent', () => {
  it('reads a trip: the gap it made, its fee, the deposit it left in an account not its own, the leftover tokens', () => {
    const a = read(trip)!;
    expect(a.kind).toBe('trade');
    expect(a.ok).toBe(true);
    expect(a.fee).toBe(6294n);
    // The wallet, the keeper's new account and its wrapped SOL: everything else is someone else's.
    expect(a.sol).toBe(-2_840_934n + 1_488_440n + 481_809n);
    expect(a.deposits).toBe(1_346_200n);
    expect(madeSol(a)).toBe(481_809n); // what the wrapped SOL grew by
    expect(a.tokens).toEqual([{ mint: BRAINLET, change: 48_298_714n, decimals: 6 }]);
    expect(a.pools).toEqual([POOL]);
    expect(a.from).toBeNull();
  });

  it('reads money sent in: the rent the sender paid into the keeper’s account is the keeper’s', () => {
    const a = read(deposit)!;
    expect(a).toMatchObject({ kind: 'in', fee: 0n, sol: 1_513_840n, deposits: 0n, from: OWNER_WALLET });
    expect(a.tokens).toEqual([{ mint: BAYLA, change: 4_455_000_000n, decimals: 6 }]);
  });

  it('reads a send into an existing account, where the keeper’s wallet is not in the transaction at all', () => {
    const t = tx({
      sig: 'usdc-in',
      accounts: [
        { address: OWNER_WALLET, pre: 9_000_000, post: 8_995_000 },
        { address: 'UsdcAtaOfTheKeeper1111111111111111111111111', pre: 2_039_280, post: 2_039_280, token: { mint: USDC, owner: KEEPER, pre: 1_919_627, post: 6_672_846 } },
      ],
      programs: [SYSTEM],
    });
    expect(read(t)).toMatchObject({ kind: 'in', sol: 0n, tokens: [{ mint: USDC, change: 4_753_219n, decimals: 6 }] });
  });

  it('reads the accounts a transaction reaches through a lookup table: the keeper’s, a new one, our pool', () => {
    const t = tx({
      sig: 'loaded',
      accounts: [{ address: KEEPER, pre: 10_000_000, post: 8_648_800 }],
      loaded: [
        { address: 'LoadedWsolOfTheKeeper1111111111111111111111', pre: 100_000_000, post: 100_700_000, token: { mint: WSOL, owner: KEEPER, pre: 97_960_720, post: 98_660_720, decimals: 9 } },
        { address: 'LoadedNewAccount111111111111111111111111111', pre: 0, post: 1_346_200 },
        { address: POOL, pre: 5_000_000, post: 5_000_000 },
      ],
      programs: [VENUE],
    });
    const a = read(t)!;
    expect(a.deposits).toBe(1_346_200n);
    expect(madeSol(a)).toBe(700_000n);
    expect(a.pools).toEqual([POOL]);
  });

  it('tells a wrap, a withdrawal, a leftover sale and a refused trip apart', () => {
    const wrap = tx({
      sig: 'wrap',
      accounts: [
        { address: KEEPER, pre: 500_000_000, post: 98_501_560 },
        { address: 'WsolAta1111111111111111111111111111111111111', pre: 0, post: 401_493_440, token: { mint: WSOL, owner: KEEPER, pre: null, post: 400_000_000, decimals: 9 } },
      ],
      programs: [SYSTEM],
    });
    expect(read(wrap)).toMatchObject({ kind: 'setup', sol: -5000n, deposits: 0n });

    const withdraw = tx({
      sig: 'withdraw',
      accounts: [
        { address: KEEPER, pre: 98_000_000, post: 10_000_000 },
        { address: OWNER_WALLET, pre: 1, post: 87_995_001 },
      ],
      programs: [SYSTEM],
    });
    expect(read(withdraw)).toMatchObject({ kind: 'out', sol: -88_000_000n });

    const sale = tx({ sig: 'sale', accounts: [{ address: KEEPER, pre: 10_000_000, post: 11_000_000 }], programs: [JUP] });
    expect(read(sale)?.kind).toBe('sale');

    const refused = tx({ sig: 'refused', err: { InstructionError: [3, { Custom: 6022 }] }, accounts: [{ address: KEEPER, pre: 10_000_000, post: 9_995_000 }], programs: [JUP, VENUE] });
    expect(read(refused)).toMatchObject({ kind: 'trade', ok: false, sol: -5000n });
    expect(madeSol(read(refused)!)).toBe(0n);
  });

  it('is null for a transaction the chain gave no result for, or that is not the keeper’s', () => {
    expect(read({ ...trip, meta: null })).toBeNull();
    expect(readActivity(trip, OWNER_WALLET, VENUE, POOLS)).toBeNull();
  });
});

describe('results: the totals', () => {
  const withdraw = read(tx({ sig: 'w', accounts: [{ address: KEEPER, pre: 98_000_000, post: 10_000_000 }, { address: OWNER_WALLET, pre: 1, post: 87_995_001 }], programs: [SYSTEM] }))!;
  const refused = read(tx({ sig: 'r', err: { Custom: 1 }, accounts: [{ address: KEEPER, pre: 10_000_000, post: 9_995_000 }], programs: [VENUE] }))!;
  const all = [read(trip)!, read(deposit)!, withdraw, refused];

  it('adds what the trips made, every fee and deposit, and money in and out apart', () => {
    const r = results(all);
    expect(r).toMatchObject({ trades: 1, refused: 1, sales: 0 });
    expect(r.madeSol).toBe(481_809n);
    expect(r.madeTokens).toEqual([{ mint: BRAINLET, change: 48_298_714n, decimals: 6 }]);
    expect(r.fees).toBe(6294n + 5000n + 5000n);
    expect(r.deposits).toBe(1_346_200n);
    expect(r.putInSol).toBe(1_513_840n);
    expect(r.putInTokens).toEqual([{ mint: BAYLA, change: 4_455_000_000n, decimals: 6 }]);
    expect(r.takenOutSol).toBe(-88_000_000n + 5000n); // the withdrawal's fee is a fee
    expect(r.takenOutTokens).toEqual([]);
  });

  it('groups trips by UTC day, newest first, leaving money in and out out', () => {
    const day2 = { ...read(trip)!, signature: 'later', at: 1_793_484_000 + 86_400 };
    const days = byDay([...all, day2]);
    expect(days.map((d) => d.day)).toEqual(['2026-11-01', '2026-10-31']);
    expect(days[1].results).toMatchObject({ trades: 1, refused: 1, putInSol: 0n });
  });

  it('explains the holdings up to a slot, and nothing after it', () => {
    const later = { ...read(deposit)!, signature: 'later', slot: 101 };
    const e = expectedHoldings([read(trip)!, read(deposit)!, later], 100);
    expect(e.sol).toBe(-870_685n + 1_513_840n);
    expect(e.tokens.get(BRAINLET)).toBe(48_298_714n);
    expect(e.tokens.get(BAYLA)).toBe(4_455_000_000n);
    expect(expectedHoldings([later], 100).sol).toBe(0n);
  });
});
