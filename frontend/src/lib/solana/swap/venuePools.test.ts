// @vitest-environment node
//
// Which of our pools a swap of a pair can trade in, and what each pays. The cases that
// matter are the ones the swap page got wrong for as long as it looked at one address:
// a pool on the public fee tier (tier 1, where this site opens every pool) was never
// found, and a found pool was priced with tier 0's fee whatever tier it was on.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { AMM_CONFIG_OFFSETS, CREATOR_FEE_ON_BOTH, POOL_STATE_OFFSETS, POOL_STATUS_DISABLE_SWAP } from '../cpswap/program';
import { BAYLA_QUOTE, USDC_QUOTE } from '../lp/quotes';
import { BAYLA_MINT, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, USDC_MINT, WSOL_MINT } from '../lp/tokenSafety';
import {
  CLOCK,
  LAUNCH,
  PROGRAM,
  buildPool,
  clockAccount,
  configBytes,
  fakeIndex,
  fakeRpc,
  key,
  mintBytes,
  type FakeAccount,
} from '../lp/testkit.fixture';
import { EXT, encodeMint2022 } from '../../launcher/solana/write/testkit.fixture';
import { chooseRoute, type RouteCandidate } from '../route';
import { quoteVenuePools, readVenuePools, rememberingFetch } from './venuePools';

const NOW = 2_000_000_000n;
const OPTS = { programId: PROGRAM, launchProgramId: LAUNCH };
const SOL = 10n ** 9n;
const TOK = 10n ** 6n;

/** The pool program's own sum, written out: fee rounded up, payout rounded down. */
function expectedOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, feePpm: bigint): bigint {
  const fee = (amountIn * feePpm + 999_999n) / 1_000_000n;
  const net = amountIn - fee;
  return (net * reserveOut) / (reserveIn + net);
}

const classicMint = (): FakeAccount => ({ owner: TOKEN_PROGRAM, data: mintBytes(null, 6) });
const base = (mint: PublicKey, more: Record<string, FakeAccount> = {}): Record<string, FakeAccount> => ({
  [CLOCK]: clockAccount(NOW),
  [mint.toBase58()]: classicMint(),
  ...more,
});
const agg = (out: bigint): RouteCandidate => ({ venue: 'aggregator', outAmount: out, label: 'Jupiter' });

async function read(accounts: Record<string, FakeAccount>, mint: PublicKey, o: { index?: Record<string, string[]>; indexStatus?: number; other?: string; truncated?: boolean } = {}) {
  return readVenuePools(fakeRpc(accounts), WSOL_MINT, o.other ?? mint.toBase58(), {
    ...OPTS,
    fetchImpl: fakeIndex(o.index ?? {}, { status: o.indexStatus, truncated: o.truncated }),
  });
}

describe('a pool on the public fee tier (tier 1) is found and priced with its own fee', () => {
  it('finds the pool at tier 1’s standard address, which tier 0’s address never holds', async () => {
    const mint = key();
    const pool = buildPool({ mint, configIndex: 1, quoteReserve: 10n * SOL, tokenReserve: 1_000_000n * TOK });
    const r = await read(base(mint, pool.accounts), mint);
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.pools.map((p) => p.address)).toEqual([pool.address.toBase58()]);
    expect(r.pools[0]!.config?.index).toBe(1);
    const q = quoteVenuePools(r, WSOL_MINT, SOL);
    expect(q.state).toBe('quoted');
    // 1% on tier 1. Tier 0's 0.25% would pay 90,720,... and the route would lean our way.
    expect(q.candidates[0]!.outAmount).toBe(expectedOut(SOL, 10n * SOL, 1_000_000n * TOK, 10_000n));
    expect(q.candidates[0]!.poolAddress).toBe(pool.address.toBase58());
  });

  it('prices each pool with the fee of the tier it is on, not one tier for all', async () => {
    const mint = key();
    const t1 = buildPool({ mint, configIndex: 1, quoteReserve: 10n * SOL, tokenReserve: 1_000_000n * TOK });
    const t0 = buildPool({ mint, configIndex: 0, quoteReserve: 10n * SOL, tokenReserve: 1_000_000n * TOK });
    // Tier 0 as it is on mainnet: 0.25%.
    t0.accounts[t0.config.toBase58()] = { owner: PROGRAM.toBase58(), data: configBytes(0, 2_500n, 120_000n) };
    const r = await read(base(mint, { ...t1.accounts, ...t0.accounts }), mint);
    if (r.kind !== 'ok') throw new Error(r.kind);
    const q = quoteVenuePools(r, WSOL_MINT, SOL);
    const out = new Map(q.candidates.map((c) => [c.poolAddress, c.outAmount]));
    expect(out.get(t1.address.toBase58())).toBe(expectedOut(SOL, 10n * SOL, 1_000_000n * TOK, 10_000n));
    expect(out.get(t0.address.toBase58())).toBe(expectedOut(SOL, 10n * SOL, 1_000_000n * TOK, 2_500n));
    // Same reserves, so the cheaper tier is the one the router takes.
    expect(chooseRoute(q.candidates).chosen?.poolAddress).toBe(t0.address.toBase58());
  });

  it('finds a pool at its own address when the pool index names it', async () => {
    const mint = key();
    const pool = buildPool({ mint, address: key(), quoteReserve: 5n * SOL, tokenReserve: 500_000n * TOK });
    const r = await read(base(mint, pool.accounts), mint, { index: { [`mint:${mint.toBase58()}`]: [pool.address.toBase58()] } });
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.pools.map((p) => p.address)).toEqual([pool.address.toBase58()]);
    expect(r.pools[0]!.origin).toBe('other');
  });

  it('prices a pool that charges its creator a fee with that fee, and one with the switch off without it', async () => {
    // The tier names a creator fee of 0.5%. Only a pool whose own switch is on charges it.
    const withFee = (accounts: Record<string, FakeAccount>, b: ReturnType<typeof buildPool>, switchOn: boolean) => {
      const cfg = accounts[b.config.toBase58()]!.data;
      new DataView(cfg.buffer).setBigUint64(AMM_CONFIG_OFFSETS.creatorFeeRate, 5_000n, true);
      const pool = accounts[b.address.toBase58()]!.data;
      pool[POOL_STATE_OFFSETS.creatorFeeOn] = CREATOR_FEE_ON_BOTH;
      pool[POOL_STATE_OFFSETS.enableCreatorFee] = switchOn ? 1 : 0;
    };
    for (const switchOn of [true, false]) {
      const mint = key();
      const pool = buildPool({ mint, quoteReserve: 10n * SOL, tokenReserve: 1_000_000n * TOK });
      const accounts = base(mint, pool.accounts);
      withFee(accounts, pool, switchOn);
      const q = quoteVenuePools(await read(accounts, mint), WSOL_MINT, SOL);
      // On: trade fee and creator fee both come off what is paid in (1.5% in all).
      expect(q.candidates[0]!.outAmount, `switch ${switchOn ? 'on' : 'off'}`).toBe(expectedOut(SOL, 10n * SOL, 1_000_000n * TOK, switchOn ? 15_000n : 10_000n));
    }
  });

  it('quotes a sale the other way round, in the same pool', async () => {
    const mint = key();
    const pool = buildPool({ mint, quoteReserve: 10n * SOL, tokenReserve: 1_000_000n * TOK });
    const r = await readVenuePools(fakeRpc(base(mint, pool.accounts)), mint.toBase58(), WSOL_MINT, { ...OPTS, fetchImpl: fakeIndex({}) });
    const q = quoteVenuePools(r, mint.toBase58(), 1_000n * TOK);
    expect(q.candidates[0]!.outAmount).toBe(expectedOut(1_000n * TOK, 1_000_000n * TOK, 10n * SOL, 10_000n));
  });
});

describe('the rule the quotes feed: our pool unless somewhere else pays more', () => {
  async function ourQuote() {
    const mint = key();
    const pool = buildPool({ mint, quoteReserve: 10n * SOL, tokenReserve: 1_000_000n * TOK });
    const r = await read(base(mint, pool.accounts), mint);
    const q = quoteVenuePools(r, WSOL_MINT, SOL);
    return { ours: q.candidates, out: q.candidates[0]!.outAmount, pool: pool.address.toBase58() };
  }

  it('loses to an aggregator quote one raw unit better', async () => {
    const { ours, out } = await ourQuote();
    const d = chooseRoute([...ours, agg(out + 1n)]);
    expect(d.chosen?.venue).toBe('aggregator');
  });

  it('keeps a tie', async () => {
    const { ours, out, pool } = await ourQuote();
    const d = chooseRoute([...ours, agg(out)]);
    expect(d.chosen).toMatchObject({ venue: 'own-pool', poolAddress: pool });
    expect(d.edge).toBe(0);
  });

  it('wins by one raw unit', async () => {
    const { ours, out, pool } = await ourQuote();
    expect(chooseRoute([...ours, agg(out - 1n)]).chosen?.poolAddress).toBe(pool);
  });
});

describe('what was not found is said as what it is', () => {
  it('no pool, when every read answered and none holds this pair', async () => {
    const mint = key();
    const r = await read(base(mint), mint);
    expect(quoteVenuePools(r, WSOL_MINT, SOL)).toEqual({ state: 'absent', candidates: [] });
  });

  it('never "no pool" when the pool index did not answer', async () => {
    const mint = key();
    const r = await read(base(mint), mint, { indexStatus: 502 });
    expect(quoteVenuePools(r, WSOL_MINT, SOL).state).toBe('error');
  });

  it('never "no pool" when the index holds more pools than it listed', async () => {
    const mint = key();
    const r = await read(base(mint), mint, { truncated: true });
    expect(quoteVenuePools(r, WSOL_MINT, SOL).state).toBe('error');
  });

  it('never "no pool" when the chain could not be read', async () => {
    const mint = key();
    const r = await readVenuePools(fakeRpc(base(mint), { fail: new Set(['getMultipleAccounts']) }), WSOL_MINT, mint.toBase58(), { ...OPTS, fetchImpl: fakeIndex({}) });
    expect(r.kind).toBe('unread');
    expect(quoteVenuePools(r, WSOL_MINT, SOL).state).toBe('error');
  });

  it('a pair with no pairing coin is not searched, and no read is made for it', async () => {
    const calls: [string, unknown[]][] = [];
    const indexCalls: string[] = [];
    const r = await readVenuePools(fakeRpc({}, { calls }), key().toBase58(), key().toBase58(), { ...OPTS, fetchImpl: fakeIndex({}, { calls: indexCalls }) });
    expect(r).toEqual({ kind: 'not-searched' });
    expect(calls).toEqual([]);
    expect(indexCalls).toEqual([]);
    expect(quoteVenuePools(r, WSOL_MINT, SOL).state).toBe('not-searched');
  });

  it('the token’s pool with ANOTHER coin is not this pair’s pool', async () => {
    const mint = key();
    const usdcPool = buildPool({ mint, quote: USDC_QUOTE, quoteReserve: 1_000n * TOK, tokenReserve: 1_000_000n * TOK });
    const r = await read(base(mint, usdcPool.accounts), mint);
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.pools).toEqual([]);
    expect(quoteVenuePools(r, WSOL_MINT, SOL).state).toBe('absent');
    // Asked as token and USDC, it is.
    const asUsdc = await readVenuePools(fakeRpc(base(mint, usdcPool.accounts)), USDC_MINT, mint.toBase58(), { ...OPTS, fetchImpl: fakeIndex({}) });
    if (asUsdc.kind !== 'ok') throw new Error(asUsdc.kind);
    expect(asUsdc.pools.map((p) => p.address)).toEqual([usdcPool.address.toBase58()]);
  });

  it('a BAYLA and SOL pool is found whichever of the two is paid in', async () => {
    const bayla = new PublicKey(BAYLA_MINT);
    const pool = buildPool({ mint: bayla, quoteReserve: 24n * SOL, tokenReserve: 5_000_000n * TOK });
    const accounts = { ...base(bayla, pool.accounts), [BAYLA_MINT]: { owner: TOKEN_2022_PROGRAM, data: encodeMint2022([[EXT.MetadataPointer, 64], [EXT.TokenMetadata, 76]]) } };
    for (const [a, b] of [[WSOL_MINT, BAYLA_MINT], [BAYLA_MINT, WSOL_MINT]] as const) {
      const r = await readVenuePools(fakeRpc(accounts), a, b, { ...OPTS, fetchImpl: fakeIndex({}) });
      if (r.kind !== 'ok') throw new Error(r.kind);
      expect(r.tokenMint).toBe(BAYLA_MINT);
      expect(r.quote.symbol).toBe('SOL');
      expect(quoteVenuePools(r, a, a === WSOL_MINT ? SOL : 1_000n * TOK).state).toBe('quoted');
    }
    expect(BAYLA_QUOTE.mint).toBe(BAYLA_MINT);
  });
});

describe('a search that did not finish, with nothing that trades, is "could not be quoted", never "cannot be traded"', () => {
  it('the index did not answer and the one pool read cannot trade, while a pool that trades sits where only the index names it', async () => {
    const mint = key();
    const frozen = buildPool({ mint, configIndex: 1, quoteReserve: 10n * SOL, tokenReserve: 1_000_000n * TOK, frozenVault: true });
    const good = buildPool({ mint, configIndex: 1, address: key(), quoteReserve: 10n * SOL, tokenReserve: 1_000_000n * TOK });
    const accounts = base(mint, { ...frozen.accounts, ...good.accounts });
    expect(quoteVenuePools(await read(accounts, mint, { indexStatus: 502 }), WSOL_MINT, SOL).state).toBe('error');
    // With the index answering, the pool that trades is found and quoted.
    expect(quoteVenuePools(await read(accounts, mint, { index: { [`mint:${mint.toBase58()}`]: [good.address.toBase58()] } }), WSOL_MINT, SOL).state).toBe('quoted');
  });

  it('the chain’s clock was not read: a pool not open by the viewer’s clock could not be quoted', async () => {
    const mint = key();
    const later = buildPool({ mint, quoteReserve: 10n * SOL, tokenReserve: 1_000_000n * TOK, openTime: NOW + 60n });
    const accounts = base(mint, later.accounts);
    delete accounts[CLOCK];
    expect(quoteVenuePools(await read(accounts, mint), WSOL_MINT, SOL, Number(NOW)).state).toBe('error');
  });

  it('a token no pool of ours can price is "cannot be traded", whether the search finished or not', async () => {
    const mint = key();
    const pool = buildPool({ mint, quoteReserve: 10n * SOL, tokenReserve: 1_000_000n * TOK });
    const accounts = base(mint, pool.accounts);
    accounts[mint.toBase58()] = { owner: TOKEN_2022_PROGRAM, data: encodeMint2022([[EXT.TransferFeeConfig, 108]]) };
    expect(quoteVenuePools(await read(accounts, mint, { indexStatus: 502 }), WSOL_MINT, SOL).state).toBe('unquotable');
  });
});

describe('rememberingFetch: the pool list is asked for once in a while, not on every quote', () => {
  function counting(answers: Array<{ status: number; body: string }>) {
    const calls: string[] = [];
    const base = (async (url: string) => {
      calls.push(url);
      const a = answers[Math.min(calls.length - 1, answers.length - 1)]!;
      return new Response(a.body, { status: a.status });
    }) as unknown as typeof fetch;
    return { calls, base };
  }

  it('answers from the kept answer while it is fresh, and asks again once it is not', async () => {
    let t = 1_000;
    const [one, two] = ['{"pools":["A"],"truncated":false}', '{"pools":["A","B"],"truncated":false}'];
    const { calls, base } = counting([{ status: 200, body: one }, { status: 200, body: two }]);
    const f = rememberingFetch(60_000, base, () => t);
    expect(await (await f('/api/pools?mint=X')).text()).toBe(one);
    t += 59_999;
    const again = await f('/api/pools?mint=X');
    expect(again.status).toBe(200);
    expect(await again.text()).toBe(one);
    expect(calls).toHaveLength(1);
    t += 1;
    expect(await (await f('/api/pools?mint=X')).text()).toBe(two);
    expect(calls).toHaveLength(2);
  });

  it('keeps each token’s answer apart', async () => {
    const { calls, base } = counting([{ status: 200, body: '{"pools":[],"truncated":false}' }]);
    const f = rememberingFetch(60_000, base, () => 0);
    await f('/api/pools?mint=X');
    await f('/api/pools?mint=Y');
    await f('/api/pools?mint=X');
    expect(calls).toEqual(['/api/pools?mint=X', '/api/pools?mint=Y']);
  });

  it('never keeps a good status with a body that is no pool list (an error page, another shape)', async () => {
    const { calls, base } = counting([{ status: 200, body: '<html>busy</html>' }, { status: 200, body: '{"error":"x"}' }, { status: 200, body: '{"pools":[],"truncated":false}' }]);
    const f = rememberingFetch(60_000, base, () => 0);
    await f('/api/pools?mint=X');
    await f('/api/pools?mint=X');
    await f('/api/pools?mint=X');
    await f('/api/pools?mint=X');
    expect(calls).toHaveLength(3);
  });

  it('never keeps a refusal or an outage: the next quote asks again', async () => {
    const { calls, base } = counting([{ status: 429, body: '{}' }, { status: 502, body: '{}' }, { status: 200, body: '{"pools":[],"truncated":false}' }]);
    const f = rememberingFetch(60_000, base, () => 0);
    expect((await f('/api/pools?mint=X')).status).toBe(429);
    expect((await f('/api/pools?mint=X')).status).toBe(502);
    expect((await f('/api/pools?mint=X')).status).toBe(200);
    expect((await f('/api/pools?mint=X')).status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it('a kept list still has its pools read from the chain every time', async () => {
    const mint = key();
    const pool = buildPool({ mint, address: key(), quoteReserve: 5n * SOL, tokenReserve: 500_000n * TOK });
    const indexCalls: string[] = [];
    const rpcCalls: [string, unknown[]][] = [];
    const fetchImpl = rememberingFetch(60_000, fakeIndex({ [`mint:${mint.toBase58()}`]: [pool.address.toBase58()] }, { calls: indexCalls }), () => 0);
    for (let i = 0; i < 2; i++) {
      const r = await readVenuePools(fakeRpc(base(mint, pool.accounts), { calls: rpcCalls }), WSOL_MINT, mint.toBase58(), { ...OPTS, fetchImpl });
      if (r.kind !== 'ok') throw new Error(r.kind);
      expect(r.pools.map((p) => p.address)).toEqual([pool.address.toBase58()]);
      expect(r.complete).toBe(true);
    }
    expect(indexCalls).toHaveLength(1);
    // Two reads of the chain each time for the pools (and one for the token's mint).
    expect(rpcCalls.filter(([m]) => m === 'getMultipleAccounts').length).toBe(6);
  });
});

describe('a pool that cannot be traded or cannot be read gives no candidate, and is never "no pool"', () => {
  async function stateOf(change: (b: ReturnType<typeof buildPool>, mint: PublicKey, accounts: Record<string, FakeAccount>) => void, spec: Partial<Parameters<typeof buildPool>[0]> = {}) {
    const mint = key();
    const pool = buildPool({ mint, quoteReserve: 10n * SOL, tokenReserve: 1_000_000n * TOK, ...spec });
    const accounts = base(mint, pool.accounts);
    change(pool, mint, accounts);
    return quoteVenuePools(await read(accounts, mint), WSOL_MINT, SOL);
  }

  it('a token that takes a fee on every transfer', async () => {
    const q = await stateOf((_b, mint, accounts) => {
      accounts[mint.toBase58()] = { owner: TOKEN_2022_PROGRAM, data: encodeMint2022([[EXT.TransferFeeConfig, 108]]) };
    });
    expect(q).toEqual({ state: 'unquotable', candidates: [] });
  });

  it('a token whose mint is not there', async () => {
    const q = await stateOf((_b, mint, accounts) => {
      delete accounts[mint.toBase58()];
    });
    expect(q.state).toBe('unquotable');
  });

  // Read whole, and the program would refuse the swap: "cannot be traded", which is not
  // the passing "could not be quoted this time" of a read that failed.
  it('a pool with a frozen vault', async () => {
    expect((await stateOf(() => {}, { frozenVault: true })).state).toBe('unquotable');
  });

  it('a pool with swaps switched off', async () => {
    expect((await stateOf(() => {}, { status: POOL_STATUS_DISABLE_SWAP })).state).toBe('unquotable');
  });

  it('a pool that does not open until later', async () => {
    expect((await stateOf(() => {}, { openTime: NOW + 60n })).state).toBe('unquotable');
  });

  it('a pool beside a second one that trades: the one that trades is the candidate', async () => {
    const mint = key();
    const frozen = buildPool({ mint, configIndex: 0, quoteReserve: 10n * SOL, tokenReserve: 1_000_000n * TOK, frozenVault: true });
    const good = buildPool({ mint, configIndex: 1, quoteReserve: 10n * SOL, tokenReserve: 1_000_000n * TOK });
    const q = quoteVenuePools(await read(base(mint, { ...frozen.accounts, ...good.accounts }), mint), WSOL_MINT, SOL);
    expect(q.state).toBe('quoted');
    expect(q.candidates.map((c) => c.poolAddress)).toEqual([good.address.toBase58()]);
  });

  it('is open or not by the chain’s clock, whatever the viewer’s says', async () => {
    const mint = key();
    const opensAt = NOW - 10n;
    const pool = buildPool({ mint, quoteReserve: 10n * SOL, tokenReserve: 1_000_000n * TOK, openTime: opensAt });
    const r = await read(base(mint, pool.accounts), mint);
    // The viewer's clock is an hour behind the chain: the pool is open all the same.
    expect(quoteVenuePools(r, WSOL_MINT, SOL, Number(NOW) - 3_600).state).toBe('quoted');
    const later = buildPool({ mint, quoteReserve: 10n * SOL, tokenReserve: 1_000_000n * TOK, openTime: NOW + 60n });
    const r2 = await read(base(mint, later.accounts), mint);
    // And an hour ahead: the pool is still not open.
    expect(quoteVenuePools(r2, WSOL_MINT, SOL, Number(NOW) + 3_600).state).toBe('unquotable');
  });

  it('a pool whose fee settings could not be read', async () => {
    const q = await stateOf((b, _mint, accounts) => {
      delete accounts[b.config.toBase58()];
    });
    expect(q.state).toBe('error');
  });
});
