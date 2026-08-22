// node --test contracts/monitoring/lib/arbLinkage.test.mjs
//
// The assertions that matter here are the negative ones. This monitor gates the
// oracle unlock, so the property under test is not "it computes a ratio" but
// "there is no input under which it reports GO without having read one."

import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  ReadFailure,
  decide,
  depthRatio,
  makeRpc,
  publicResult,
  readLinkage,
  readPair,
  redactEndpoint,
  renderHuman,
  resolveConfig,
} from './arbLinkage.mjs';

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const TOWELI = '0x420698cfdeddea6bc78d59bc17798113ad278f9d';
const NATIVE = '0x55875887B43C2E23aE424AF0FC8606Fdb058a481';
const UNI = '0x6682Ac593513cc0A6c25D0F3588e8fA4FF81104D';

const config = resolveConfig({});

const hexWord = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const eth = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;

const pool = (wethEth, otherEth, { wethIsToken0 = false } = {}) => ({
  weth: eth(wethEth),
  other: eth(otherEth),
  wethIsToken0,
});

/** A single fake endpoint. `pairs` maps a checksummed address to a pool. */
function fakeEndpoint({ pairs, chainId = 1, blockNumber = 25_790_000, blockTimestamp, fail }) {
  return async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    if (fail) return { ok: false, status: 503, json: async () => ({}) };
    const ok = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });

    if (method === 'eth_chainId') return ok(`0x${chainId.toString(16)}`);
    if (method === 'eth_getBlockByNumber') {
      return ok({ number: `0x${blockNumber.toString(16)}`, timestamp: `0x${blockTimestamp.toString(16)}` });
    }
    if (method === 'eth_call') {
      const { to, data } = params[0];
      const p = pairs[to];
      if (!p) return { ok: true, status: 200, json: async () => ({ error: { message: 'execution reverted' } }) };
      const t0 = p.wethIsToken0 ? WETH : TOWELI;
      const t1 = p.wethIsToken0 ? TOWELI : WETH;
      if (data === '0x0dfe1681') return ok(`0x${addrWord(t0)}`);
      if (data === '0xd21220a7') return ok(`0x${addrWord(t1)}`);
      if (data === '0x0902f1ac') {
        const r0 = p.wethIsToken0 ? p.weth : p.other;
        const r1 = p.wethIsToken0 ? p.other : p.weth;
        return ok(`0x${hexWord(r0)}${hexWord(r1)}${hexWord(1)}`);
      }
    }
    throw new Error(`unexpected ${method}`);
  };
}

function scenario(opts) {
  const nowMs = 1_770_000_000_000;
  const fetchImpl = fakeEndpoint({ blockTimestamp: Math.round(nowMs / 1000) - 12, ...opts });
  return { fetchImpl, now: () => nowMs };
}

const healthy = {
  pairs: { [NATIVE]: pool(1.5, 50_000_000), [UNI]: pool(9, 300_000_000) },
};

test('a healthy, deep, arb-linked pair of venues is GO', async () => {
  const { fetchImpl, now } = scenario(healthy);
  const r = await readLinkage(config, { fetchImpl, now });
  assert.equal(r.status, 'GO');
  assert.equal(r.code, 0);
  assert.equal(r.ratio, 6);
  assert.deepEqual(r.unreadable, []);
});

test('native below the live floor is WARN even when the ratio is enormous', async () => {
  const { fetchImpl, now } = scenario({ pairs: { [NATIVE]: pool(0.067, 1_000_000), [UNI]: pool(7.47, 280_000_000) } });
  const r = await readLinkage(config, { fetchImpl, now });
  assert.equal(r.status, 'WARN');
  assert.equal(r.code, 1);
  assert.ok(r.ratio > 100, 'the ratio is healthy; the floor is what fails');
});

test('a thin arb venue is HALT', async () => {
  const { fetchImpl, now } = scenario({ pairs: { [NATIVE]: pool(4, 50_000_000), [UNI]: pool(8, 100_000_000) } });
  const r = await readLinkage(config, { fetchImpl, now });
  assert.equal(r.status, 'HALT');
  assert.equal(r.code, 2);
});

test('a one-sided arb venue is HALT, not the healthiest ratio the monitor can print', async () => {
  // 9 WETH against zero TOWELI divides to a spectacular multiple and arbs nothing.
  const { fetchImpl, now } = scenario({ pairs: { [NATIVE]: pool(1.5, 50_000_000), [UNI]: pool(9, 0) } });
  const r = await readLinkage(config, { fetchImpl, now });
  assert.equal(r.status, 'HALT');
  assert.match(r.reason, /zero-side reserve/);
});

test('an empty native pool is HALT', async () => {
  const { fetchImpl, now } = scenario({ pairs: { [NATIVE]: pool(0, 0), [UNI]: pool(9, 300_000_000) } });
  const r = await readLinkage(config, { fetchImpl, now });
  assert.equal(r.status, 'HALT');
  assert.equal(r.code, 2);
});

test('an arb venue holding no WETH is HALT', async () => {
  const { fetchImpl, now } = scenario({ pairs: { [NATIVE]: pool(1.5, 50_000_000), [UNI]: pool(0, 300_000_000) } });
  const r = await readLinkage(config, { fetchImpl, now });
  assert.equal(r.status, 'HALT');
});

test('every endpoint failing is ERROR at exit 2 and never GO', async () => {
  const { now } = scenario(healthy);
  const fetchImpl = fakeEndpoint({ pairs: {}, blockTimestamp: 0, fail: true });
  const r = await readLinkage(config, { fetchImpl, now });
  assert.equal(r.status, 'ERROR');
  assert.equal(r.code, 2);
  assert.equal(r.nativeWethEth, null, 'no depth may be reported from a reading that did not happen');
  assert.equal(r.ratio, null);
  assert.equal(r.unreadable.length, config.rpcs.length, 'every endpoint tried is named');
});

test('a stale head is ERROR, not a confident reading of old depth', async () => {
  const nowMs = 1_770_000_000_000;
  const fetchImpl = fakeEndpoint({ ...healthy, blockTimestamp: Math.round(nowMs / 1000) - 4000 });
  const r = await readLinkage(config, { fetchImpl, now: () => nowMs });
  assert.equal(r.status, 'ERROR');
  assert.match(r.unreadable[0], /behind/);
});

test('an endpoint on the wrong chain is refused rather than believed', async () => {
  const { now } = scenario(healthy);
  const fetchImpl = fakeEndpoint({ ...healthy, chainId: 8453, blockTimestamp: 1_769_999_988 });
  const r = await readLinkage(config, { fetchImpl, now });
  assert.equal(r.status, 'ERROR');
  assert.match(r.unreadable[0], /serves chain 8453/);
});

test('a pair holding no WETH is refused rather than reported as WETH depth', async () => {
  const rpc = async (_m, params) => {
    if (params[0].data === '0x0dfe1681') return `0x${addrWord(TOWELI)}`;
    if (params[0].data === '0xd21220a7') return `0x${addrWord('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48')}`;
    return `0x${hexWord(eth(500))}${hexWord(eth(500))}${hexWord(1)}`;
  };
  await assert.rejects(() => readPair(rpc, NATIVE, WETH, 'latest'), /holds no WETH/);
});

test('WETH as token0 reads the token0 reserve', async () => {
  const rpc = async (_m, params) => {
    if (params[0].data === '0x0dfe1681') return `0x${addrWord(WETH)}`;
    if (params[0].data === '0xd21220a7') return `0x${addrWord(TOWELI)}`;
    return `0x${hexWord(eth(3))}${hexWord(eth(900))}${hexWord(1)}`;
  };
  const p = await readPair(rpc, NATIVE, WETH, 'latest');
  assert.equal(p.wethEth, 3);
  assert.equal(p.degenerate, false);
});

test('an empty eth_call return is named rather than decoded into a number', async () => {
  const rpc = async () => '0x';
  await assert.rejects(() => readPair(rpc, NATIVE, WETH, 'latest'), /not a pair contract/);
});

test('a truncated eth_call return is a read failure, not a silent zero', async () => {
  const rpc = async (_m, params) => {
    if (params[0].data === '0x0dfe1681') return `0x${addrWord(TOWELI)}`;
    if (params[0].data === '0xd21220a7') return `0x${addrWord(WETH)}`;
    return `0x${hexWord(eth(3))}`; // one word where three are due
  };
  await assert.rejects(() => readPair(rpc, NATIVE, WETH, 'latest'), ReadFailure);
});

test('a response carrying neither result nor error is a read failure', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1 }) });
  const rpc = makeRpc('http://x', { fetchImpl });
  await assert.rejects(() => rpc('eth_chainId', []), /neither result nor error/);
});

test('a failed endpoint is recorded even when a later one serves the reading', async () => {
  const nowMs = 1_770_000_000_000;
  const good = fakeEndpoint({ ...healthy, blockTimestamp: Math.round(nowMs / 1000) - 12 });
  let seen = 0;
  const fetchImpl = async (url, init) => {
    if (url === config.rpcs[0]) {
      seen += 1;
      return { ok: false, status: 502, json: async () => ({}) };
    }
    return good(url, init);
  };
  const r = await readLinkage(config, { fetchImpl, now: () => nowMs });
  assert.equal(r.status, 'GO');
  assert.equal(r.endpoint, config.rpcs[1]);
  assert.equal(r.unreadable.length, 1, 'a roster quietly shrinking to its last member is worth seeing');
  assert.ok(seen > 0);
});

test('the ratio divides exactly past float integer precision', () => {
  const huge = 10n ** 24n; // 1,000,000 ETH, far beyond Number.MAX_SAFE_INTEGER wei
  assert.equal(depthRatio(huge, huge * 7n), 7);
  assert.equal(depthRatio(0n, huge), null);
});

test('redaction keeps the provider and drops every place a key is carried', () => {
  assert.equal(redactEndpoint('https://x.example.com/v2/KEY?apikey=K2#f'), 'https://x.example.com');
  assert.equal(redactEndpoint('https://user:pass@x.example.com/'), 'https://x.example.com');
  assert.equal(redactEndpoint('not a url'), '[unparseable endpoint]');
  assert.equal(redactEndpoint(null), null);
});

test('a keyed operator RPC never reaches the rendered or machine-readable output', async () => {
  const secret = 'https://eth-mainnet.example.com/v2/REDACT-ME-PATH?apikey=REDACT-ME-QUERY';
  const nowMs = 1_770_000_000_000;
  const keyed = resolveConfig({ RPC: secret });
  const fetchImpl = fakeEndpoint({ ...healthy, blockTimestamp: Math.round(nowMs / 1000) - 12 });
  const r = await readLinkage(keyed, { fetchImpl, now: () => nowMs });

  assert.equal(r.status, 'GO');
  assert.equal(r.endpoint, 'https://eth-mainnet.example.com', 'only the origin identifies the provider');
  assert.equal(r.endpointUrl, secret, 'the caller that must reuse the view still gets the real URL');

  for (const rendered of [renderHuman(r), JSON.stringify(publicResult(r))]) {
    assert.equal(rendered.includes('REDACT-ME-PATH'), false);
    assert.equal(rendered.includes('REDACT-ME-QUERY'), false);
  }
});

test('a keyed operator RPC is redacted out of failure text too', async () => {
  const secret = 'https://eth-mainnet.example.com/v2/REDACT-ME-PATH';
  const keyed = resolveConfig({ RPC: secret });
  const fetchImpl = fakeEndpoint({ pairs: {}, blockTimestamp: 0, fail: true });
  const r = await readLinkage(keyed, { fetchImpl, now: () => 1_770_000_000_000 });

  assert.equal(r.status, 'ERROR');
  assert.equal(renderHuman(r).includes('REDACT-ME-PATH'), false);
  assert.match(r.unreadable[0], /^https:\/\/eth-mainnet\.example\.com:/);
});

test('decide never returns GO when a venue cannot quote', () => {
  const obs = {
    native: { wethWei: eth(2), wethEth: 2, degenerate: false },
    uniswap: { wethWei: eth(50), wethEth: 50, degenerate: true },
  };
  assert.equal(decide(obs, config).status, 'HALT');
});
