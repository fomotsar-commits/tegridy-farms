// @vitest-environment node
//
// The command line (BUILD-SPEC 3.5 step 9): every command and option is checked before anything
// runs; anything unknown is refused, never ignored; the commands that act for real need their
// explicit words (--live, --confirm), and a canary price goes DOWN to the tick.
import { describe, it, expect } from 'vitest';
import { parseArgs, UsageError } from '../../../house-bidder.mjs';
import { DEFAULT_KEYS_DIR } from '../../brain/config.mjs';

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
});
