// @vitest-environment node
//
// The command line (BUILD-SPEC 3.5 step 9): every command and option is checked before anything
// runs; anything unknown is refused, never ignored; the commands that act for real need their
// explicit words (--live, --confirm), and a canary price goes DOWN to the tick.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canaryBlockers, main, parseArgs, stopExitCode, UsageError } from '../../../house-bidder.mjs';
import { DEFAULT_KEYS_DIR } from '../../brain/config.mjs';
import { VENUE_FEE_SAFE, WETH } from '../../brain/constants.mjs';

const bad = (argv) => {
  try {
    parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) return e.message;
    throw e;
  }
  return null;
};

describe('house-bidder command line', () => {
  it('runs shadow by default, with the default keys folder', () => {
    expect(parseArgs([])).toEqual({ cmd: 'shadow', opts: { keys: DEFAULT_KEYS_DIR } });
    expect(parseArgs(['--fresh']).opts.fresh).toBe(true);
  });

  it('bids for real only with run --live', () => {
    expect(bad(['run'])).toMatch(/--live/);
    expect(parseArgs(['run', '--live'])).toMatchObject({ cmd: 'run', opts: { live: true } });
    expect(bad(['shadow', '--live'])).toMatch(/does not take --live/);
    expect(bad(['run', '--live=yes'])).toMatch(/takes no value/);
  });

  it('refuses an unknown command, an unknown option and a stray word', () => {
    expect(bad(['trade'])).toMatch(/not a command/);
    expect(bad(['status', '--force'])).toMatch(/does not take --force/);
    expect(bad(['stop', 'now'])).toMatch(/unexpected/);
  });

  it('refuses a keys folder in OneDrive, in either option form', () => {
    expect(bad(['status', '--keys', 'C:\\Users\\jimbo\\OneDrive\\Desktop\\k'])).toMatch(/OneDrive/);
    expect(bad(['status', '--keys=C:\\Users\\jimbo\\OneDrive\\k'])).toMatch(/OneDrive/);
    expect(parseArgs(['status', '--keys=D:\\keys']).opts.keys).toBe('D:\\keys');
    expect(bad(['status', '--keys'])).toMatch(/needs a value/);
  });

  it('places a canary only with --confirm and a price, rounded down to the 0.00001 ETH tick', () => {
    expect(bad(['canary', '--price', '0.03'])).toMatch(/--confirm/);
    expect(bad(['canary', '--confirm'])).toMatch(/--price/);
    expect(bad(['canary', '--confirm', '--price', 'cheap'])).toMatch(/not an amount/);
    expect(bad(['canary', '--confirm', '--price', '0.000001'])).toMatch(/rounds down to 0/);
    expect(parseArgs(['canary', '--confirm', '--price', '0.0300099']).opts.priceWei).toBe(30_000_000_000_000_000n);
    expect(bad(['canary', '--confirm', '--price', '0.03', '--hold-min', '40'])).toMatch(/0 to 25/);
    expect(bad(['canary', '--confirm', '--price', '0.03', '--live'])).toMatch(/does not take --live/);
  });

  it('checks report, backtest and board options', () => {
    expect(parseArgs(['report', '--month', '2026-11', '--shadow']).opts).toMatchObject({ month: '2026-11', shadow: true });
    expect(bad(['report', '--month', '2026-13'])).toMatch(/2026-11/);
    expect(parseArgs(['backtest']).opts.days).toBe(30);
    expect(bad(['backtest', '--days', '0'])).toMatch(/1 to 90/);
    expect(bad(['backtest', '--days', '2.5'])).toMatch(/1 to 90/);
    expect(parseArgs(['board', '--port', '8800']).opts.port).toBe(8800);
    expect(bad(['board', '--port', '80'])).toMatch(/1024/);
  });

  it('takes --ack-halt only where a halt can be acknowledged', () => {
    expect(parseArgs(['run', '--live', '--ack-halt']).opts.ackHalt).toBe(true);
    expect(bad(['report', '--ack-halt'])).toMatch(/does not take/);
  });

  it('exits as failed after a STOP whose kill was needed and did not go through', () => {
    expect(stopExitCode({ clean: false, killed: false, needKill: true })).not.toBe(0);
    expect(stopExitCode({ clean: true, killed: false, needKill: false })).toBe(0);
    expect(stopExitCode({ clean: true, killed: true, needKill: true })).toBe(0);
  });
});

describe('the canary', () => {
  const T = 1_794_800_000;
  const A = `0x${'0a'.repeat(32)}`;
  const fill = { kind: 'fill', at: (T - 3600) * 1000, txHash: `0x${'1b'.repeat(32)}`, block: 1, time: T - 3600, orderHash: A, slug: 'junglebay', tokenId: '77', unitPriceWei: '30000000000000000', seller: '0x3333333333333333333333333333333333333333', fulfiller: '0x3333333333333333333333333333333333333333' };
  const order = { orderHash: A, slug: 'junglebay', qty: 1, unitPriceWei: '30000000000000000', startTime: T - 600, endTime: T + 1200, counter: '7' };
  const base = { entries: [], signerOrders: [], chainFills: [], accountOffers: [], counter: 7n, nowSec: T };

  it('runs only on a house that holds nothing and has no live bid', () => {
    expect(canaryBlockers(base)).toEqual([]);
    expect(canaryBlockers({ ...base, entries: [fill] })).toEqual([expect.stringMatching(/holds 1 NFT/)]);
    // one sent back to the funding wallet is not held
    const back = { kind: 'nft-returned', at: T * 1000, slug: 'junglebay', tokenId: '77', to: '0x1111111111111111111111111111111111111111', txHash: `0x${'2c'.repeat(32)}` };
    expect(canaryBlockers({ ...base, entries: [fill, back] })).toEqual([]);
    expect(canaryBlockers({ ...base, signerOrders: [order] })).toEqual([expect.stringMatching(/bid/)]);
    expect(canaryBlockers({ ...base, accountOffers: [{ orderHash: `0x${'0c'.repeat(32)}`, slug: 'junglebay', qty: 1, remainingQty: 1, endTime: T + 900 }] })).toEqual([expect.stringMatching(/OpenSea/)]);
  });
});

describe('the backtest command', () => {
  it('counts a sale by a venue contract into the bid as an insider sale, like the live loop', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'house-bidder-backtest-'));
    try {
      const keys = path.join(tmp, 'keys');
      const data = path.join(tmp, 'data');
      fs.mkdirSync(keys);
      fs.mkdirSync(data);
      const END = 1_794_800_000;
      const H = 3600;
      const who = (n) => `0x${String(n).padStart(40, '0')}`;
      const sale = (n, time, priceWei, seller) => ({ txHash: `0x${String(n).padStart(64, '0')}`, time, tokenId: String(n), priceWei, paymentToken: WETH, seller, buyer: who(900 + n), orderHash: null });
      const sales = [];
      for (let i = 0; i < 12; i++) sales.push(sale(i + 1, END - 10 * 24 * H + i * 18 * H, '40000000000000000', who(100 + (i % 6))));
      sales.push(sale(50, END - 12 * H, '30000000000000000', VENUE_FEE_SAFE)); // the treasury Safe sells into the house bid
      sales.push(sale(51, END, '40000000000000000', who(106)));
      const listing = (n) => ({ orderHash: `0x${String(n).padStart(64, 'e')}`, tokenId: String(500 + n), priceWei: '50000000000000000', maker: who(200 + n), startTime: END - 20 * 24 * H, endTime: END + 10 * 24 * H });
      fs.writeFileSync(path.join(data, 'junglebay-sales.json'), JSON.stringify(sales));
      fs.writeFileSync(path.join(data, 'junglebay-listings.json'), JSON.stringify([1, 2, 3].map(listing)));
      const out = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...a) => out.push(a.join(' ')));
      try {
        await main(['backtest', '--keys', keys, '--data', data, '--days', '2']);
      } finally {
        spy.mockRestore();
      }
      expect(out.join('\n')).toMatch(/insider sales into the bid: 1/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
