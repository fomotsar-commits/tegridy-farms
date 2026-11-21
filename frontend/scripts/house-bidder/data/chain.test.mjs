// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ChainError, createChain, decodeFill, diffSnapshots } from './chain.mjs';
import { GNSS_SEED_SLOT, OPENSEA_CONDUIT, OPENSEA_CONDUIT_KEY, NO_CONDUIT_KEY, SEAPORT_16, TOPICS, WETH } from './constants.mjs';

const { cases } = JSON.parse(readFileSync(fileURLToPath(new URL('../__fixtures__/order-fulfilled-receipts.json', import.meta.url)), 'utf8'));
const CONTRACTS = { junglebay: '0xd37264c71e9af940e49795f0d3a8336afaafdda9', gnssart: '0xa1de9f93c56c290c48849b1393b09eb616d55dbb' };
const OS_FEE = '0x0000a26b00c1f0df003000390027140000faa719';
const RPC = 'https://rpc.example.invalid/v2/secret-key-in-path';
const caseNamed = (n) => cases.find((c) => c.name === n);
const fillLog = (c) => c.receipt.logs.find((l) => l.logIndex === c.logIndex);
const decode = (c, house = c.house) => decodeFill({ log: fillLog(c), receipt: c.receipt, house, contracts: CONTRACTS, time: c.blockTime });
const pad = (a) => `0x${a.slice(2).padStart(64, '0')}`;

describe('decodeFill on real Seaport 1.6 fills (saved receipts, 2026-11-15)', () => {
  it('decodes a JBAC bid fill: the NFT, the WETH per unit, the seller who got the WETH, tx.from', () => {
    expect(decode(caseNamed('jbac-bid-fill-plain'))).toMatchObject({
      txHash: '0x0b8793c5cc69112abce96097033f564bfc08f7ab759b7b9371fda42284213a79', block: 25819307, time: 1787505551, logIndex: 917,
      orderHash: '0x866afafd85c3c1a18c264f35cfb9636f8829a2628b91b21aff223f0a9ced68dd', slug: 'junglebay', tokenId: '3450', unitPriceWei: 110000000000000000n,
      seller: '0x2299aeb4baa0b102382ae0df95660fd004bd5ffa', fulfiller: '0x2299aeb4baa0b102382ae0df95660fd004bd5ffa', nftFrom: '0x2299aeb4baa0b102382ae0df95660fd004bd5ffa',
      sellerGotWeth: true, anomaly: null, fees: [{ recipient: OS_FEE, token: WETH, amount: 1100000000000000n }],
    });
  });

  it('keeps seller and fulfiller apart for a smart-account fill, where tx.from is the bundler', () => {
    expect(decode(caseNamed('jbac-bid-fill-smart-account'))).toMatchObject({
      tokenId: '3827', unitPriceWei: 35000000000000000n,
      seller: '0x074dbd6d7f78faf68a4ee1059b0a30cdb5b06cfa', nftFrom: '0x074dbd6d7f78faf68a4ee1059b0a30cdb5b06cfa', fulfiller: '0x2d3faeac23567d32b249b2325689f6f76dda4a28',
      sellerGotWeth: true, anomaly: null,
    });
  });

  it('decodes a GNSS bid fill', () => {
    expect(decode(caseNamed('gnss-bid-fill'))).toMatchObject({ slug: 'gnssart', tokenId: '6443', unitPriceWei: 17100000000000000n, seller: '0xa1f885f11e625400711d386c951446b7217d3c51', block: 25804441 });
  });

  it('ignores another wallet\'s fill and flags a house order that did not buy one known NFT', () => {
    const listing = caseNamed('junglebay-listing-fill');
    expect(decode(listing, '0x00000000000000000000000000000000000000aa')).toBe(null);
    // Decoded as if the listing's maker were the house: it SOLD an NFT, which a bid never does.
    expect(decode(listing)).toMatchObject({ tokenId: null, unitPriceWei: null, anomaly: 'not-one-known-nft' });
  });
});

describe('diffSnapshots', () => {
  const snap = (over = {}) => ({
    block: 1, time: 1, house: {},
    jbac: { maxSupply: 5555n, totalSupply: 5555n, owner: '0xaa', ...over.jbac },
    gnss: { totalSupply: 9697n, owner: '0xbb', contractLocked: false, seed: '0xcc', seedWord: pad('0xcc'), ...over.gnss },
  });
  it('reports every admin and supply field that changed, and nothing else', () => {
    expect(diffSnapshots(snap(), snap())).toEqual([]);
    const after = { ...snap({ jbac: { maxSupply: 6000n, owner: '0xdd' }, gnss: { contractLocked: true, seedWord: pad('0xee'), totalSupply: 9698n } }), block: 2 };
    expect(diffSnapshots(snap(), after).map((c) => c.field)).toEqual(['jbac.maxSupply', 'jbac.owner', 'gnss.totalSupply', 'gnss.contractLocked', 'gnss.seed']);
    expect(diffSnapshots(snap(), after)[0]).toEqual({ field: 'jbac.maxSupply', before: 5555n, after: 6000n, block: 2 });
  });
});

/** A fake viem public client: answers from the given handlers and records every call. */
function fakeClient(h = {}) {
  const calls = [];
  const rec = (name, fn) => async (args) => {
    calls.push({ name, args });
    return fn(args, calls);
  };
  return {
    calls,
    client: {
      getBlockNumber: rec('getBlockNumber', h.getBlockNumber ?? (() => 100n)),
      getBlock: rec('getBlock', h.getBlock ?? ((a) => ({ number: a?.blockNumber ?? 100n, timestamp: 1_800_000_000n }))),
      multicall: rec('multicall', h.multicall ?? (() => [])),
      getStorageAt: rec('getStorageAt', h.getStorageAt ?? (() => pad('0xa6a5ec7b1b8a34ff2dcb2926b7c78f52a5ce3b90'))),
      getLogs: rec('getLogs', h.getLogs ?? (() => [])),
      getTransactionReceipt: rec('getTransactionReceipt', h.getTransactionReceipt ?? (() => ({ logs: [], from: null }))),
      getCode: rec('getCode', h.getCode ?? (() => undefined)),
    },
  };
}
const manualTimers = { setInterval: () => 0, clearInterval: () => {} };
const chainOn = (fake, house = '0x00000000000000000000000000000000000000a0') => createChain({ httpUrls: [RPC], house, contracts: CONTRACTS, viemImpl: { client: fake.client }, timers: manualTimers });
const SNAP_VALUES = [5555n, 5555n, '0xDc4AEe24d421B2697f3E09da761b88d06F13e12e', 9697n, '0x209Aa937AC59F60384a70b98fec5Daf54Ac7b967', false, 10n ** 17n, 15n * 10n ** 16n, 3n, 10n ** 16n, 1_800_000_012n];

describe('createChain: snapshot', () => {
  it('reads everything in one multicall pinned to a block, plus the GNSS seed slot at that same block', async () => {
    const fake = fakeClient({ multicall: () => SNAP_VALUES });
    const s = await chainOn(fake).snapshot();
    expect(s).toEqual({
      block: 100, time: 1_800_000_012,
      house: { weth: 10n ** 17n, allowance: 15n * 10n ** 16n, counter: 3n, eth: 10n ** 16n },
      jbac: { maxSupply: 5555n, totalSupply: 5555n, owner: '0xdc4aee24d421b2697f3e09da761b88d06f13e12e' },
      gnss: { totalSupply: 9697n, owner: '0x209aa937ac59f60384a70b98fec5daf54ac7b967', contractLocked: false, seed: '0xa6a5ec7b1b8a34ff2dcb2926b7c78f52a5ce3b90', seedWord: pad('0xa6a5ec7b1b8a34ff2dcb2926b7c78f52a5ce3b90') },
    });
    const mc = fake.calls.find((c) => c.name === 'multicall').args;
    expect(mc).toMatchObject({ allowFailure: false, blockNumber: 100n, batchSize: 0 });
    expect(mc.contracts.map((c) => `${c.functionName}@${c.address}`)).toEqual([
      `maxSupply@${CONTRACTS.junglebay}`, `totalSupply@${CONTRACTS.junglebay}`, `owner@${CONTRACTS.junglebay}`,
      `totalSupply@${CONTRACTS.gnssart}`, `owner@${CONTRACTS.gnssart}`, `contractLocked@${CONTRACTS.gnssart}`,
      `balanceOf@${WETH}`, `allowance@${WETH}`, `getCounter@${SEAPORT_16}`, 'getEthBalance@0xca11bde05977b3631167028862be2a173976ca11', 'getCurrentBlockTimestamp@0xca11bde05977b3631167028862be2a173976ca11',
    ]);
    expect(mc.contracts[7].args).toEqual(['0x00000000000000000000000000000000000000a0', OPENSEA_CONDUIT]);
    expect(fake.calls.find((c) => c.name === 'getStorageAt').args).toEqual({ address: CONTRACTS.gnssart, slot: GNSS_SEED_SLOT, blockNumber: 100n });
  });

  it('fails as a whole, with the RPC URL scrubbed from the message', async () => {
    const fake = fakeClient({
      multicall: () => {
        throw new Error(`HTTP request failed. URL: ${RPC}`);
      },
    });
    const e = await chainOn(fake).snapshot().catch((err) => err);
    expect(e).toBeInstanceOf(ChainError);
    expect(e.message).not.toContain('secret-key-in-path');
    expect(e.message).toContain('<rpc>');
  });
});

describe('createChain: listingFillable', () => {
  it('needs the maker to own the NFT and to have approved the operator its order pulls through', async () => {
    const maker = '0x00000000000000000000000000000000000000b1';
    const other = '0x00000000000000000000000000000000000000b2';
    const L = (n, o = {}) => ({ orderHash: `0x${String(n).padStart(64, '0')}`, tokenId: String(n), maker, contract: CONTRACTS.junglebay, conduitKey: OPENSEA_CONDUIT_KEY, protocol: SEAPORT_16, ...o });
    const listings = [L(1), L(2), L(3), L(4, { conduitKey: NO_CONDUIT_KEY }), L(5, { conduitKey: `0x${'12'.repeat(32)}` }), L(6, { contract: '0x00000000000000000000000000000000000000c3' }), L(7)];
    const fake = fakeClient({
      multicall: ({ contracts }) => contracts.map((c) => {
        const id = c.functionName === 'ownerOf' ? Number(c.args[0]) : null;
        if (c.functionName === 'ownerOf') return id === 7 ? { status: 'failure', error: new Error('reverted') } : { status: 'success', result: id === 2 ? other : maker };
        return { status: 'success', result: !(contracts.indexOf(c) === 5) };
      }),
    });
    const r = await chainOn(fake).listingFillable(listings);
    expect(Object.fromEntries([...r].map(([h, v]) => [Number(h), v.fillable ? 'ok' : v.reason]))).toEqual({ 1: 'ok', 2: 'not-owner', 3: 'not-approved', 4: 'ok', 5: 'unknown-conduit', 6: 'unknown-collection', 7: 'read-failed' });
    const mc = fake.calls.find((c) => c.name === 'multicall').args;
    expect(fake.calls.filter((c) => c.name === 'multicall')).toHaveLength(1);
    expect(mc.batchSize).toBe(0);
    // A zero conduit key means Seaport itself moves the NFT, so that is the approval that matters.
    const approvals = mc.contracts.filter((c) => c.functionName === 'isApprovedForAll').map((c) => c.args[1]);
    expect(approvals).toEqual([OPENSEA_CONDUIT, OPENSEA_CONDUIT, OPENSEA_CONDUIT, SEAPORT_16, OPENSEA_CONDUIT]);
  });
});

describe('createChain: watch', () => {
  const fill = caseNamed('jbac-bid-fill-plain');
  const fillLogFixture = { ...fillLog(fill), blockNumber: 100n, logIndex: 917, transactionHash: fill.receipt.transactionHash };
  const t = (a, b, c, d) => ({ address: CONTRACTS.junglebay, topics: [TOPICS.Transfer, pad(a), pad(b), pad(c)], data: '0x', blockNumber: 100n, logIndex: d, transactionHash: `0x${'aa'.repeat(31)}${String(d).padStart(2, '0')}` });
  const mint = t('0x0000000000000000000000000000000000000000', '0x00000000000000000000000000000000000000c1', '0x5', 1);
  const owner = { address: CONTRACTS.gnssart, topics: [TOPICS.OwnershipTransferred, pad('0x209aa937ac59f60384a70b98fec5daf54ac7b967'), pad('0x00000000000000000000000000000000000000c2')], data: '0x', blockNumber: 100n, logIndex: 2, transactionHash: `0x${'bb'.repeat(32)}` };

  function world({ failFillsOnce = false, repeatMint = false } = {}) {
    let head = 100n;
    let failed = false;
    let maxSupply = 5555n;
    const fake = fakeClient({
      getBlockNumber: () => head,
      getLogs: (args) => {
        if (args.event?.name === 'OrderFulfilled') {
          if (failFillsOnce && !failed) {
            failed = true;
            throw new Error('upstream timeout');
          }
          return args.fromBlock <= 100n && args.toBlock >= 100n ? [fillLogFixture] : [];
        }
        // `repeatMint`: a provider that hands the same log back for a later range (a reorg, a bad node).
        if (repeatMint) return [mint];
        return args.fromBlock <= 100n && args.toBlock >= 100n ? [mint, owner] : [];
      },
      getTransactionReceipt: () => fill.receipt,
      multicall: () => [maxSupply, ...SNAP_VALUES.slice(1)],
    });
    const seen = [];
    const handlers = Object.fromEntries(['onMint', 'onOwnerChange', 'onFill', 'onAdmin', 'onHouseTransfer'].map((k) => [k, (e) => seen.push([k, e])]));
    const w = chainOn(fake, fill.house).watch(handlers);
    return { fake, seen, w, setHead: (b) => (head = b), setMaxSupply: (v) => (maxSupply = v) };
  }

  it('emits mints, owner changes and house fills for the new block, then admin changes between snapshots', async () => {
    const x = world();
    await x.w.ready;
    expect(x.seen.map(([k]) => k)).toEqual(['onMint', 'onOwnerChange', 'onFill']);
    expect(x.seen[0][1]).toMatchObject({ slug: 'junglebay', tokenId: '5', to: '0x00000000000000000000000000000000000000c1' });
    expect(x.seen[1][1]).toMatchObject({ slug: 'gnssart', from: '0x209aa937ac59f60384a70b98fec5daf54ac7b967', to: '0x00000000000000000000000000000000000000c2' });
    expect(x.seen[2][1]).toMatchObject({ tokenId: '3450', unitPriceWei: 110000000000000000n, seller: '0x2299aeb4baa0b102382ae0df95660fd004bd5ffa' });
    await x.w.tick(); // same block: nothing new
    expect(x.seen).toHaveLength(3);
    x.setHead(101n);
    x.setMaxSupply(6000n);
    await x.w.tick();
    expect(x.seen.at(-1)).toEqual(['onAdmin', { field: 'jbac.maxSupply', before: 5555n, after: 6000n, block: 101 }]);
    x.w.stop();
  });

  it('emits nothing for a range until every read of it succeeded, then emits each event once', async () => {
    const x = world({ failFillsOnce: true });
    await x.w.ready;
    expect(x.seen).toHaveLength(0);
    await x.w.tick();
    expect(x.seen.map(([k]) => k)).toEqual(['onMint', 'onOwnerChange', 'onFill']);
    const fillReads = x.fake.calls.filter((c) => c.name === 'getLogs' && c.args.event?.name === 'OrderFulfilled');
    expect(fillReads.map((c) => [c.args.fromBlock, c.args.toBlock])).toEqual([[100n, 100n], [100n, 100n]]);
    expect(fillReads[0].args.args).toEqual({ offerer: fill.house });
    x.w.stop();
  });

  it('never emits the same log twice, even if a provider returns it again', async () => {
    const x = world({ repeatMint: true });
    await x.w.ready;
    x.setHead(101n);
    await x.w.tick();
    expect(x.seen.filter(([k]) => k === 'onMint')).toHaveLength(1);
    x.w.stop();
  });

  it('emits mints, owner changes and fills even while the snapshot read keeps failing, and reports that failure', async () => {
    let head = 100n;
    let snapshotFails = true;
    const fake = fakeClient({
      getBlockNumber: () => head,
      getLogs: (args) => (args.event?.name === 'OrderFulfilled' ? (args.fromBlock <= 100n && args.toBlock >= 100n ? [fillLogFixture] : []) : args.fromBlock <= 100n && args.toBlock >= 100n ? [mint, owner] : []),
      getTransactionReceipt: () => fill.receipt,
      multicall: () => {
        if (snapshotFails) throw new Error('execution reverted / header not found');
        return SNAP_VALUES;
      },
    });
    const seen = [];
    const errors = [];
    const w = chainOn(fake, fill.house).watch({
      onMint: (e) => seen.push(['onMint', e.tokenId]),
      onOwnerChange: () => seen.push(['onOwnerChange']),
      onFill: (f) => seen.push(['onFill', f.tokenId]),
      onAdmin: (a) => seen.push(['onAdmin', a.field]),
      onError: (e) => errors.push(e.message),
    });
    await w.ready;
    expect(seen).toEqual([['onMint', '5'], ['onOwnerChange'], ['onFill', '3450']]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/snapshot/);
    head = 101n;
    snapshotFails = false;
    await w.tick();
    expect(seen).toHaveLength(3); // each event once, and nothing more when the snapshot comes back
    w.stop();
  });
});

describe('createChain: receipt', () => {
  it('reads a transaction’s block and whether it succeeded, and null while it is not mined', async () => {
    const mined = `0x${'aa'.repeat(32)}`;
    const reverted = `0x${'bb'.repeat(32)}`;
    const fake = fakeClient({
      getTransactionReceipt: ({ hash }) => {
        if (hash === mined) return { blockNumber: 123n, status: 'success' };
        if (hash === reverted) return { blockNumber: 124n, status: 'reverted' };
        throw Object.assign(new Error(`Transaction receipt with hash "${hash}" could not be found.`), { name: 'TransactionReceiptNotFoundError' });
      },
    });
    const chain = chainOn(fake);
    expect(await chain.receipt(mined)).toEqual({ blockNumber: 123, success: true });
    expect(await chain.receipt(reverted)).toEqual({ blockNumber: 124, success: false });
    expect(await chain.receipt(`0x${'cc'.repeat(32)}`)).toBe(null);
    await expect(chain.receipt('0x1234')).rejects.toThrow();
  });
});

describe('createChain: history reads', () => {
  it('shrinks a log range the provider refuses, and still covers every block once', async () => {
    const ranges = [];
    const fake = fakeClient({
      getBlock: () => ({ number: 30_000n, timestamp: 1_800_000_000n }),
      getLogs: ({ fromBlock, toBlock }) => {
        if (toBlock - fromBlock + 1n > 1_000n) throw new Error('eth_getLogs block range too large, max 1000');
        ranges.push([fromBlock, toBlock]);
        return [];
      },
    });
    await chainOn(fake).houseFills({ sinceSec: 1_800_000_000 - 3 * 86_400 });
    const from = 30_000n - BigInt(Math.ceil((3 * 86_400) / 12) + 1);
    expect(ranges[0][0]).toBe(from);
    expect(ranges.at(-1)[1]).toBe(30_000n);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1] + 1n);
  });

  it('lists one token\'s transfers in the window, oldest first', async () => {
    const tlog = (block, from, to, logIndex) => ({ address: CONTRACTS.junglebay, topics: [TOPICS.Transfer, pad(from), pad(to), pad('0x1')], data: '0x', blockNumber: block, logIndex, transactionHash: `0x${String(block).padStart(64, '0')}` });
    const fake = fakeClient({
      // The head is block 700,000; block 60,000's timestamp is far older than 90 days.
      getBlock: (a) => (a?.blockNumber ? { number: a.blockNumber, timestamp: a.blockNumber === 60_000n ? 1_000n : 1_799_990_000n } : { number: 700_000n, timestamp: 1_800_000_000n }),
      // Like a node: only the logs inside the asked range (the scan is split into chunks).
      getLogs: ({ fromBlock, toBlock }) => [tlog(600_000n, '0x00000000000000000000000000000000000000d2', '0x00000000000000000000000000000000000000d3', 0), tlog(60_000n, '0x00000000000000000000000000000000000000d1', '0x00000000000000000000000000000000000000d2', 0)].filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock),
    });
    const c = createChain({ httpUrls: [RPC], house: '0x00000000000000000000000000000000000000a0', contracts: CONTRACTS, viemImpl: { client: fake.client }, timers: manualTimers, now: () => 1_800_000_000_000 });
    const rows = await c.tokenProvenance('junglebay', '1', { sinceDays: 90 });
    // The block-60,000 transfer is inside the scanned blocks but its time is outside the 90 days.
    expect(rows).toEqual([{ from: '0x00000000000000000000000000000000000000d2', to: '0x00000000000000000000000000000000000000d3', txHash: `0x${'600000'.padStart(64, '0')}`, time: 1_799_990_000, block: 600_000, logIndex: 0 }]);
    expect(fake.calls.find((x) => x.name === 'getLogs').args.args).toEqual({ tokenId: 1n });
  });

  it('reads code, "0x" for an account without any', async () => {
    const fake = fakeClient({ getCode: ({ address }) => (address.endsWith('a1') ? '0xEF0100AABB' : undefined) });
    const c = chainOn(fake);
    expect(await c.code('0x00000000000000000000000000000000000000a1')).toBe('0xef0100aabb');
    expect(await c.code('0x00000000000000000000000000000000000000a2')).toBe('0x');
  });
});
