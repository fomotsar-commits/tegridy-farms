// One whole look, end to end, against recorded mainnet pools and a stand-in Jupiter:
// what gets judged, what is called unread, and which alerts go out.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { alertsFor, cycle, line, makeContext } from '../src/watch.js';
import { decode } from '../src/base58.js';
import { snapshotFrom } from '../src/pool.js';
import { readEnv, BAYLA_MINT, PUMP_AMM_PROGRAM, PUMP_BAYLA_POOL, SOL_MINT, USDC_MINT, UNREAD_ALERT_MS, VENUE_VAULT, ISLAND_WORKSHOP } from '../src/config.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/mainnet.json', import.meta.url)));
const RPC = 'http://rpc.test';
const LABELS = { [PUMP_AMM_PROGRAM]: 'Pump.fun Amm', CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM', whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Whirlpool' };
const WHIRL_POOL = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE'; // any valid address standing in for a SOL/USDC pool

/** pump.fun stand-in: 333 SOL against enough BAYLA to price it 4% above our BAYLA/SOL pool as recorded. */
const X = 333_000_000_000n;
const recorded = (() => {
  const p = FIX.pools['BAYLA/SOL'];
  return snapshotFrom({ address: p.addresses[0], slot: 1, accounts: p.answer.value });
})();
const solIs0 = recorded.mint0 === SOL_MINT;
const ourLamportsPerUnit = Number(solIs0 ? recorded.reserve0 : recorded.reserve1) / Number(solIs0 ? recorded.reserve1 : recorded.reserve0);
const Y = BigInt(Math.round(Number(X) / (ourLamportsPerUnit * 1.04)));
const cpmm = (x, rin, rout) => {
  const xin = (x * 9_900n) / 10_000n;
  return (rout * xin) / (rin + xin);
};

function fakeNet({ jupiterDown = false, quotesDown = false, hopLabel = 'Whirlpool', rpcFailFor = null, protocolOwner = null, fundOwner = null, rates = null, market = { X, Y }, mutatePool = null } = {}) {
  return async (url, init) => {
    const u = new URL(String(url));
    if (String(url) === RPC) {
      const { method, params } = JSON.parse(init.body);
      assert.equal(method, 'getMultipleAccounts');
      const keys = params[0];
      const entry = Object.values(FIX.pools).find((p) => p.addresses[0] === keys[0]);
      if (rpcFailFor && keys[0] === rpcFailFor) return new Response('{}', { status: 503 });
      let value = keys.length === 1 ? [entry.answer.value[0]] : entry.answer.value;
      if (mutatePool) {
        // A re-pointed pool reads re-pointed in every request, the first one included.
        const pool = Buffer.from(value[0].data[0], 'base64');
        mutatePool(pool);
        value = [{ ...value[0], data: [pool.toString('base64'), 'base64'] }, ...value.slice(1)];
      }
      if ((protocolOwner || fundOwner || rates) && keys.length === 4) {
        const cfg = Buffer.from(value[1].data[0], 'base64');
        if (protocolOwner) Buffer.from(protocolOwnerBytes(protocolOwner)).copy(cfg, 44);
        if (fundOwner) Buffer.from(protocolOwnerBytes(fundOwner)).copy(cfg, 76);
        if (rates) {
          if (rates.trade !== undefined) cfg.writeBigUInt64LE(rates.trade, 12);
          if (rates.protocol !== undefined) cfg.writeBigUInt64LE(rates.protocol, 20);
          if (rates.fund !== undefined) cfg.writeBigUInt64LE(rates.fund, 28);
        }
        value = [value[0], { ...value[1], data: [cfg.toString('base64'), 'base64'] }, value[2], value[3]];
      }
      return Response.json({ jsonrpc: '2.0', id: 1, result: { context: entry.answer.context, value } });
    }
    if (jupiterDown) return new Response('{}', { status: 503 });
    if (u.pathname === '/swap/v1/program-id-to-label') return Response.json(LABELS);
    if (quotesDown) return new Response('{}', { status: 503 });
    const p = u.searchParams;
    const amount = BigInt(p.get('amount'));
    const inM = p.get('inputMint');
    const outM = p.get('outputMint');
    let out;
    let step;
    if (inM === SOL_MINT && outM === BAYLA_MINT) [out, step] = [cpmm(amount, market.X, market.Y), { ammKey: PUMP_BAYLA_POOL, label: 'Pump.fun Amm' }];
    else if (inM === BAYLA_MINT && outM === SOL_MINT) [out, step] = [cpmm(amount, market.Y, market.X), { ammKey: PUMP_BAYLA_POOL, label: 'Pump.fun Amm' }];
    else if (inM === SOL_MINT && outM === USDC_MINT) [out, step] = [(amount * 105n) / 1000n, { ammKey: WHIRL_POOL, label: hopLabel }];
    else if (inM === USDC_MINT && outM === SOL_MINT) [out, step] = [(amount * 1000n) / 105n, { ammKey: WHIRL_POOL, label: hopLabel }];
    return Response.json({ inputMint: inM, outputMint: outM, inAmount: amount.toString(), outAmount: out.toString(), routePlan: [{ swapInfo: step }] });
  };
}

const protocolOwnerBytes = (a) => decode(a);

const ctxWith = (net, now = () => Date.parse('2026-10-16T05:00:00Z')) => {
  const printed = [];
  const ctx = makeContext({ env: { ...readEnv({}), rpcUrl: RPC }, fetchImpl: net, jupiterGapMs: 0, now, print: (s) => printed.push(s) });
  return { ctx, printed };
};

test('a normal look judges both pools from the chain and pump.fun', async () => {
  const { ctx } = ctxWith(fakeNet());
  const rows = await cycle(ctx);
  assert.deepEqual(rows.map((r) => r.pool), ['BAYLA/SOL', 'BAYLA/USDC']);
  for (const r of rows) {
    assert.equal(r.unread, undefined, line(r));
    assert.equal(typeof r.gapPct, 'number');
    assert.equal(r.leak, false);
  }
  const sol = rows[0];
  assert.ok(sol.gapPct > 2.5, line(sol));
  assert.equal(sol.wouldTrade, true, line(sol));
  assert.deepEqual(sol.size, { notChecked: 'needs JUPITER_API_KEY and KEEPER_TAKER' });
});

test('a down Jupiter makes every pool UNREAD, never "no gap"', async () => {
  const { ctx } = ctxWith(fakeNet({ jupiterDown: true }));
  const rows = await cycle(ctx);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.unread, true);
    assert.equal(r.gapPct, undefined);
    assert.equal(r.wouldTrade, undefined);
  }
});

test('Jupiter answering its venue list but not its quotes is also UNREAD, for every pool', async () => {
  const { ctx } = ctxWith(fakeNet({ quotesDown: true }));
  const rows = await cycle(ctx);
  assert.deepEqual(rows.map((r) => [r.pool, r.unread, r.what]), [
    ['BAYLA/SOL', true, 'BAYLA’s outside price'],
    ['BAYLA/USDC', true, 'BAYLA’s outside price'],
  ]);
});

test('a SOL/USDC price through Raydium is refused: only the USDC pool goes unread', async () => {
  const { ctx } = ctxWith(fakeNet({ hopLabel: 'Raydium CLMM' }));
  const rows = await cycle(ctx);
  const [sol, usdc] = rows;
  assert.equal(sol.unread, undefined);
  assert.equal(usdc.unread, true);
  assert.match(usdc.detail, /Raydium/);
});

test('one pool that cannot be read does not stop the other', async () => {
  const { ctx } = ctxWith(fakeNet({ rpcFailFor: FIX.pools['BAYLA/USDC'].addresses[0] }));
  const rows = await cycle(ctx);
  const usdc = rows.find((r) => r.pool === 'BAYLA/USDC');
  const sol = rows.find((r) => r.pool === 'BAYLA/SOL');
  assert.equal(usdc.unread, true);
  assert.equal(typeof sol.gapPct, 'number');
});

test('a fee tier that pays someone other than our vault is flagged as money', async () => {
  const stranger = PUMP_BAYLA_POOL; // any address that is not our vault
  const { ctx, printed } = ctxWith(fakeNet({ protocolOwner: stranger }));
  const rows = await cycle(ctx);
  assert.ok(rows.every((r) => r.leak === true));
  assert.ok(stranger !== VENUE_VAULT);
  await alertsFor(rows, ctx);
  assert.ok(printed.some((s) => s.includes('MONEY') && s.includes(stranger)));
  assert.match(line(rows[0]), /FEE OWNERS ARE NOT THE AGREED SPLIT/);
});

test('the agreed split (venue to our vault, island to its Workshop) is not money: no flag, no alert', async () => {
  const { ctx, printed } = ctxWith(fakeNet());
  const rows = await cycle(ctx);
  assert.ok(rows.length > 0 && rows.every((r) => r.leak === false));
  await alertsFor(rows, ctx);
  assert.ok(!printed.some((s) => s.includes('MONEY')));
  assert.doesNotMatch(line(rows[0]), /AGREED SPLIT/);
});

test('the venue’s share paid to the island’s Workshop is money, and so are the two shares swapped', async () => {
  for (const owners of [{ protocolOwner: ISLAND_WORKSHOP }, { protocolOwner: ISLAND_WORKSHOP, fundOwner: VENUE_VAULT }]) {
    const { ctx, printed } = ctxWith(fakeNet(owners));
    const rows = await cycle(ctx);
    assert.ok(rows.every((r) => r.leak === true), JSON.stringify(owners));
    await alertsFor(rows, ctx);
    assert.ok(printed.some((s) => s.includes('MONEY') && s.includes(`protocol owner ${ISLAND_WORKSHOP}`)));
  }
});

test('the right owners at other rates are money too: the venue’s 10.4% moved to the island, or any change', async () => {
  const cases = [
    { protocol: 0n, fund: 160_000n }, // the venue's share moved to the island
    { protocol: 88_000n, fund: 72_000n }, // any other split
    { protocol: 0n }, // the venue's share alone cut to nothing
    { fund: 0n }, // the island's share alone cut to nothing
    { trade: 0n }, // a free tier: nobody is paid
  ];
  for (const rates of cases) {
    const { ctx, printed } = ctxWith(fakeNet({ rates }));
    const rows = await cycle(ctx);
    const said = `${rates.trade ?? 10_000n}/${rates.protocol ?? 104_000n}/${rates.fund ?? 56_000n}`;
    assert.ok(rows.every((r) => r.leak === true), said);
    await alertsFor(rows, ctx);
    assert.ok(printed.some((s) => s.includes('MONEY') && s.includes(`trade/protocol/fund rates ${said}`)), said);
  }
});

test('a pool on fee settings the keeper does not know is money, said with the settings it names', async () => {
  const OTHER_TIER = 'BHMteE8u6LAppswQmFmd2h7hp1fCfWtGahvVJnhRk8jW'; // tier 0, the launch tier
  const { ctx, printed } = ctxWith(fakeNet({ mutatePool: (pool) => Buffer.from(decode(OTHER_TIER)).copy(pool, 8) }));
  const rows = await cycle(ctx);
  assert.ok(rows.length > 0 && rows.every((r) => r.leak === true && !r.unread));
  await alertsFor(rows, ctx);
  assert.ok(printed.some((s) => s.includes('MONEY') && s.includes(`fee settings ${OTHER_TIER}`)));
});

test('the island’s share paid anywhere but its Workshop is money, the vault included (the pre-split shape)', async () => {
  for (const fundOwner of [VENUE_VAULT, PUMP_BAYLA_POOL]) {
    const { ctx, printed } = ctxWith(fakeNet({ fundOwner }));
    const rows = await cycle(ctx);
    assert.ok(rows.every((r) => r.leak === true), `fund owner ${fundOwner}`);
    await alertsFor(rows, ctx);
    assert.ok(printed.some((s) => s.includes('MONEY') && s.includes(`fund owner ${fundOwner}`)));
  }
});

test('alerts: a 3% gap is said once, not every look; unread for 10 minutes is said', async () => {
  let t = Date.parse('2026-10-16T05:00:00Z');
  const { ctx, printed } = ctxWith(fakeNet(), () => t);
  const rows = await cycle(ctx);
  await alertsFor(rows, ctx);
  const first = printed.filter((s) => s.includes('% cheaper here')).length;
  assert.ok(first >= 1);
  t += 30_000;
  await alertsFor(rows, ctx);
  assert.equal(printed.filter((s) => s.includes('% cheaper here')).length, first, 'the same gap is not repeated 30 s later');

  const down = ctxWith(fakeNet({ jupiterDown: true }), () => t);
  const unreadRows = await cycle(down.ctx);
  await alertsFor(unreadRows, down.ctx);
  assert.equal(down.printed.length, 0, 'a moment unread is not yet an alert');
  t += UNREAD_ALERT_MS;
  await alertsFor(unreadRows, down.ctx);
  assert.ok(down.printed.some((s) => /not been able to read/.test(s)));
});

test('a fee owner that is not our vault is flagged and alerted even when Jupiter is down', async () => {
  const stranger = PUMP_BAYLA_POOL; // any address that is not our vault
  const { ctx, printed } = ctxWith(fakeNet({ jupiterDown: true, protocolOwner: stranger }));
  const rows = await cycle(ctx);
  assert.ok(rows.every((r) => r.unread && r.leak === true));
  await alertsFor(rows, ctx);
  assert.ok(printed.some((s) => s.startsWith('ALERT  MONEY') && s.includes(stranger)));
  assert.match(line(rows[0]), /UNREAD .*FEE OWNERS ARE NOT THE AGREED SPLIT/);
});

test('a jump in pump.fun’s price pauses the count and is alerted, whatever else happened', async () => {
  let t = Date.parse('2026-10-16T05:00:00Z');
  const market = { X, Y };
  const { ctx, printed } = ctxWith(fakeNet({ market }), () => t);
  await cycle(ctx);
  t += 30_000;
  market.Y = (Y * 100n) / 125n; // BAYLA 25% dearer on pump.fun, 30 s later
  const rows = await cycle(ctx);
  const sol = rows.find((r) => r.pool === 'BAYLA/SOL');
  assert.equal(sol.bigMove, true);
  assert.equal(sol.wouldTrade, false, 'the live keeper would be paused');
  assert.equal(sol.paused, true);
  assert.match(sol.reason, /^paused/);
  await alertsFor(rows, ctx);
  assert.ok(printed.some((s) => /moved more than 15% within a minute/.test(s)));
});

test('a pool that names a different fee tier stays unread and is alerted as money at once', async () => {
  const { ctx, printed } = ctxWith(fakeNet());
  await cycle(ctx); // learns the pool's links
  const other = decode(PUMP_BAYLA_POOL);
  ctx.rpc = makeContext({ env: { ...readEnv({}), rpcUrl: RPC }, fetchImpl: fakeNet({ mutatePool: (b) => Buffer.from(other).copy(b, 8) }), jupiterGapMs: 0 }).rpc;
  for (let i = 0; i < 3; i++) {
    const rows = await cycle(ctx);
    for (const r of rows) {
      assert.equal(r.unread, true, `look ${i}: ${line(r)}`);
      assert.equal(r.repointed, true);
    }
    await alertsFor(rows, ctx);
  }
  assert.ok(printed.some((s) => s.startsWith('ALERT  MONEY') && /different fee tier or vault/.test(s)));
});

test('the gap alert says how far we are from pump.fun’s price, not from ours', async () => {
  const { ctx, printed } = ctxWith(fakeNet());
  const rows = await cycle(ctx);
  await alertsFor(rows, ctx);
  const sol = rows.find((r) => r.pool === 'BAYLA/SOL');
  const expected = ((1 - sol.ourPrice / sol.outsidePrice) * 100).toFixed(2);
  assert.ok(printed.some((s) => s.includes(`BAYLA/SOL: BAYLA is ${expected}% cheaper here than on pump.fun`)), printed.join('\n'));
});
