import { describe, it, expect } from 'vitest';
import { USDC_MINT } from '../lp/tokenSafety';
import type { TokenSafety } from '../lp/tokenSafety';
import { BAN_MS, PLAIN_AFTER_DROP_MS, SAFE_CAP_USD, TripBans, capUsd, coinBounds, judgeTrip, publishedRule, rankTrips, robotRule, runLegs, ruleSettingsFromEnv, tokenGate, tripFeeLamports, type CpLeg, type PublishedRule, type RuleSettings } from './rule';

const SOL_USD = 100;
const settings = (over: Partial<RuleSettings> = {}): RuleSettings => ({ maxTradeUsd: 25, minProfitUsd: 0.01, microLamports: 10_000, lighthouseProven: false, ...over });

/** SOL → token in a pool where it is cheap, token → SOL where it is dear: 1% fee each, a 4% gap. */
const cheap: CpLeg = { rin: 100e9, rout: 1_000_000e6, fee: 0.01 }; // 1 SOL buys ~10,000 tokens
const dear: CpLeg = { rin: 960_000e6, rout: 100e9, fee: 0.01 }; // ~9,600 tokens buy 1 SOL: tokens are worth ~4% more here
const trip = [cheap, dear];

describe('the cap', () => {
  it('holds a trip to $25 until the Lighthouse check is proven, then gives the setting', () => {
    expect(capUsd(settings({ maxTradeUsd: 500 }))).toBe(SAFE_CAP_USD);
    expect(capUsd(settings({ maxTradeUsd: 500, lighthouseProven: true }))).toBe(500);
    expect(capUsd(settings({ maxTradeUsd: 10 }))).toBe(10);
  });

  it('reads the robot’s own settings from the environment', () => {
    const s = ruleSettingsFromEnv({ KEEPER_MAX_TRADE_USD: '300', KEEPER_MIN_PROFIT_USD: '0.02', KEEPER_PRIORITY_MICROLAMPORTS: '5000' }, false);
    expect(s).toEqual({ maxTradeUsd: 300, minProfitUsd: 0.02, microLamports: 5000, lighthouseProven: false });
    expect(() => ruleSettingsFromEnv({ KEEPER_MAX_TRADE_USD: '-1' }, false)).toThrow('KEEPER_MAX_TRADE_USD');
  });
});

describe('the rule the robot publishes, read back by the scanner', () => {
  // The live robot of 2026-11-06: a $100 cap, a $0.002 floor, Lighthouse proven, SOL loans on.
  const live: PublishedRule = { ...settings({ maxTradeUsd: 100, minProfitUsd: 0.002, lighthouseProven: true }), flashLoans: true };

  it('gives back exactly what the robot runs with, and none of its other settings', () => {
    const robotSettings = { ...live, slippageBps: 50, jito: true, raydiumPrograms: ['x'] };
    const page: unknown = JSON.parse(JSON.stringify({ wallet: 'w', lighthouse: { proven: true }, rule: publishedRule(robotSettings) }));
    expect((page as { rule: unknown }).rule).toEqual(live);
    expect(robotRule(page)).toEqual(live);
    expect(robotRule({ rule: { ...live, flashLoans: false, lighthouseProven: false } })).toEqual({ ...live, flashLoans: false, lighthouseProven: false });
  });

  it('says why not when the page has no rule (a robot on an older build), or one the robot did not write', () => {
    // What the robot started on 2026-11-06 06:22Z publishes: its cap, but no floor.
    expect(robotRule({ lighthouse: { proven: true, why: null, capUsd: 100, settingUsd: 100 } })).toMatch(/does not give its settings/);
    for (const page of [null, undefined, 'rule', 7, { rule: null }, { rule: 'x' }]) expect(robotRule(page)).toMatch(/does not give its settings/);
    for (const bad of [{ maxTradeUsd: '100' }, { maxTradeUsd: Infinity }, { minProfitUsd: 0 }, { minProfitUsd: Number.NaN }, { microLamports: -1 }, { microLamports: undefined }]) {
      expect(robotRule({ rule: { ...live, ...bad } })).toMatch(/not a positive number/);
    }
    for (const bad of [{ lighthouseProven: 'yes' }, { lighthouseProven: undefined }, { flashLoans: 1 }, { flashLoans: undefined }]) {
      expect(robotRule({ rule: { ...live, ...bad } })).toMatch(/yes or no/);
    }
  });
});

describe('the floor', () => {
  it('is the network fee at the most a trip may use plus the minimum profit', () => {
    expect(tripFeeLamports(10_000)).toBe(5_000 + 14_000);
    const b = coinBounds({ decimals: 9 }, SOL_USD, SOL_USD, settings());
    if (typeof b === 'string') throw new Error(b);
    // $0.01 is 100,000 lamports at $100; the fee is 19,000 more.
    expect(b.floor).toBe(119_000n);
    expect(b.cap).toBe(250_000_000n);
  });

  it('counts the fee in a USDC trip at SOL’s price', () => {
    const b = coinBounds({ decimals: 6 }, 1, SOL_USD, settings());
    if (typeof b === 'string') throw new Error(b);
    expect(b.floor).toBe(11_900n);
  });

  it('refuses to size a trip with no SOL price to count the fee', () => {
    expect(coinBounds({ decimals: 6 }, 1, undefined, settings())).toBe('no SOL price to count the network fee');
  });
});

describe('judgeTrip', () => {
  const judge = (holdsRaw: number | null, s = settings()) => {
    const j = judgeTrip(trip, { decimals: 9, coinUsd: SOL_USD, solUsd: SOL_USD, holdsRaw, settings: s });
    if (typeof j === 'string') throw new Error(j);
    return j;
  };

  it('finds the size where the gap closes, and makes the most money there', () => {
    const j = judge(null, settings({ maxTradeUsd: 1e9, lighthouseProven: true }));
    expect(j.sizedBy).toBe('gap');
    // No other size makes more.
    const at = (x: number) => runLegs(trip, x) - x;
    for (const f of [0.5, 0.9, 0.99, 1.01, 1.1, 2]) expect(at(j.inRaw * f)).toBeLessThanOrEqual(at(j.inRaw) + 1);
    expect(j.gapInUsd).toBeCloseTo(j.inUsd, 0);
    expect(j.takes).toBe(true);
  });

  it('sizes down to the cap, and to the robot’s float when that is smaller', () => {
    const capped = judge(null);
    expect(capped.sizedBy).toBe('cap');
    expect(capped.inUsd).toBeLessThanOrEqual(25 + 1e-6);
    expect(capped.inUsd).toBeGreaterThan(24.99);
    expect(capped.gapInUsd).toBeGreaterThan(capped.inUsd);
    const float = judge(0.1e9);
    expect(float.sizedBy).toBe('float');
    expect(float.inRaw).toBeLessThanOrEqual(0.1e9);
    expect(float.floatUsd).toBeCloseTo(10, 6);
  });

  it('gives profit after the network fee, and ROI as that over the money put in', () => {
    const j = judge(null);
    expect(j.netUsd).toBeCloseTo(j.gainUsd - j.feeUsd, 9);
    expect(j.roiPct).toBeCloseTo((j.netUsd / j.inUsd) * 100, 9);
  });

  it('leaves a gap that does not pay its pools’ fees', () => {
    // A 1.5% gap does not pay two 1% fees: no size makes money.
    const thin = [cheap, { ...dear, rin: 985_000e6 }];
    const j = judgeTrip(thin, { decimals: 9, coinUsd: SOL_USD, solUsd: SOL_USD, holdsRaw: null, settings: settings() });
    if (typeof j === 'string') throw new Error(j);
    expect(j.takes).toBe(false);
    expect(j.why).toBe('no size pays');
  });

  it('leaves a trip that makes money, but less than the network fee and $0.01', () => {
    // 0.0005 SOL ($0.05) of float: a 4% gap makes about $0.001.
    const j = judge(500_000);
    expect(j.gainUsd).toBeGreaterThan(0);
    expect(j.takes).toBe(false);
    expect(j.why).toMatch(/under the floor/);
  });

  it('takes nothing when the robot holds none of the coin', () => {
    const j = judge(0);
    expect(j.takes).toBe(false);
    expect(j.why).toBe('the robot holds none of the coin');
  });

  it('refuses a pool with no fee read', () => {
    expect(judgeTrip([cheap, { ...dear, fee: Number.NaN }], { decimals: 9, coinUsd: SOL_USD, solUsd: SOL_USD, holdsRaw: null, settings: settings() })).toBe('a pool has no depth or no fee read');
  });
});

describe('rankTrips', () => {
  const t = (netUsd: number, roiPct: number, takes = true) => ({ judged: { netUsd, roiPct, takes } as never });
  it('puts the trips the robot takes first, then by profit or by ROI', () => {
    const list = [t(1, 2), t(3, 1), t(9, 9, false), t(2, 5)];
    expect(rankTrips(list, 'profit').map((x) => (x.judged as { netUsd: number }).netUsd)).toEqual([3, 2, 1, 9]);
    expect(rankTrips(list, 'roi').map((x) => (x.judged as { roiPct: number }).roiPct)).toEqual([5, 2, 1, 9]);
  });
});

describe('tokenGate', () => {
  const read = (mint: string, freezeAuthority: string | null, extensions: number[] = []): TokenSafety =>
    ({ kind: 'read', mint, verdict: 'ok', blocks: [], warnings: [], name: null, symbol: null, metadataSource: 'none', facts: { program: 'token-2022', mintAuthority: null, freezeAuthority, supply: 1n, decimals: 6, isInitialized: true, extensions, metadataPointer: null, tokenMetadata: null } }) as TokenSafety;
  const MINT = 'GtAEjZbnimbJKDo6BD7Gz8i9SN3fLUs4RoeUBPCfpump';
  const FREEZER = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';

  it('lets a plain token through', () => {
    expect(tokenGate(read(MINT, null, [18, 19]))).toBeNull();
  });
  it('refuses a live freeze authority, but not USDC’s', () => {
    expect(tokenGate(read(MINT, FREEZER))).toMatch(/freeze/);
    expect(tokenGate(read(USDC_MINT, FREEZER))).toBeNull();
  });
  it('refuses a hook, a permanent delegate, a pause switch, frozen-at-start accounts, a token that cannot move', () => {
    for (const ext of [6, 9, 12, 14, 26]) expect(tokenGate(read(MINT, null, [18, ext]))).not.toBeNull();
  });
  it('lets a transfer fee through: the robot counts it, and the Lighthouse check undoes a trip it leaves short', () => {
    expect(tokenGate(read(MINT, null, [18, 1]))).toBeNull();
  });
  it('refuses a token it could not read', () => {
    expect(tokenGate(undefined)).toBe('its mint was not read');
    expect(tokenGate({ kind: 'unread', mint: MINT, detail: 'x' })).toBe('its mint was not read');
  });
});

describe('TripBans', () => {
  const POOL = 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4';
  it('bans a pool for a day after two refused trips within a day', () => {
    const b = new TripBans();
    b.reverted([POOL], 0);
    expect(b.banned([POOL], 1)).toBeNull();
    b.reverted([POOL], 1000);
    expect(b.banned(['other', POOL], 2000)).toMatch(/left alone/);
    expect(b.banned([POOL], 1000 + BAN_MS - 1)).not.toBeNull();
    expect(b.banned([POOL], 1000 + BAN_MS)).toBeNull();
  });
  it('does not ban for two refusals more than a day apart', () => {
    const b = new TripBans();
    b.reverted([POOL], 0);
    b.reverted([POOL], BAN_MS + 1);
    expect(b.banned([POOL], BAN_MS + 2)).toBeNull();
  });
  it('sends a pool’s trips the usual way for a while after a Jito bundle through it did not land, never banning it', () => {
    expect(PLAIN_AFTER_DROP_MS).toBe(10 * 60_000);
    const b = new TripBans();
    expect(b.plainOnly([POOL], 0)).toBe(false);
    b.jitoDropped(['other', POOL], 1000);
    expect(b.plainOnly([POOL], 1000 + PLAIN_AFTER_DROP_MS - 1)).toBe(true);
    expect(b.plainOnly(['third', 'other'], 2000)).toBe(true);
    expect(b.plainOnly([POOL], 1000 + PLAIN_AFTER_DROP_MS)).toBe(false);
    expect(b.plainOnly(['third'], 2000)).toBe(false);
    expect(b.banned([POOL], 2000)).toBeNull();
  });
});
