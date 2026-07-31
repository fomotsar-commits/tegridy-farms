import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import {
  AIRLOCK_CREATE_EVENT,
  AIRLOCK_GET_ASSET_DATA,
  filterOurAssets,
  assetsToBaselines,
  poolByTokenFrom,
  sameAddress,
  type AssetRecord,
} from './ourLaunches';
import { LAUNCHER_INTEGRATOR_ADDRESS } from './config';

const OURS = LAUNCHER_INTEGRATOR_ADDRESS;
const THEIRS = '0x00000000000000000000000000000000deadbeef' as Address;
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const TOKEN_A = '0x00000000000000000000000000000000000000aa' as Address;
const TOKEN_B = '0x00000000000000000000000000000000000000bb' as Address;
const POOL_A = '0x00000000000000000000000000000000000000c1' as Address;

function rec(o: Partial<AssetRecord> = {}): AssetRecord {
  return { asset: TOKEN_A, integrator: OURS, migrationPool: POOL_A, createdAt: 1_800_000_000, ...o };
}

// The whole reason this module exists. If someone "optimises" discovery into a topic
// filter, these two tests are what should stop them.
describe('the Create event cannot identify our launches', () => {
  it('indexes ONLY numeraire — there is no integrator topic to filter on', () => {
    const indexed = AIRLOCK_CREATE_EVENT.inputs.filter((i) => i.indexed).map((i) => i.name);
    expect(indexed).toEqual(['numeraire']);
    expect(AIRLOCK_CREATE_EVENT.inputs.map((i) => i.name)).not.toContain('integrator');
  });

  it('exposes the integrator at getAssetData output index 9', () => {
    const names = AIRLOCK_GET_ASSET_DATA.outputs.map((o) => o.name);
    expect(names[9]).toBe('integrator');
    expect(names[6]).toBe('migrationPool');
    expect(names).toHaveLength(10);
  });
});

describe('filterOurAssets', () => {
  it('keeps ours and drops everyone else', () => {
    const out = filterOurAssets([
      rec({ asset: TOKEN_A, integrator: OURS }),
      rec({ asset: TOKEN_B, integrator: THEIRS }),
    ]);
    expect(out.map((r) => r.asset)).toEqual([TOKEN_A]);
  });

  it('is case-insensitive on the integrator address', () => {
    const lower = OURS.toLowerCase() as Address;
    const upper = ('0x' + OURS.slice(2).toUpperCase()) as Address;
    expect(filterOurAssets([rec({ integrator: lower })], upper)).toHaveLength(1);
    expect(filterOurAssets([rec({ integrator: upper })], lower)).toHaveLength(1);
  });

  // Fail-closed: these surfaces assert provenance. Claiming an asset we cannot prove
  // is ours is strictly worse than showing nothing.
  it('drops records with a zero or malformed integrator', () => {
    expect(filterOurAssets([rec({ integrator: ZERO })])).toHaveLength(0);
    expect(filterOurAssets([rec({ integrator: undefined as unknown as Address })])).toHaveLength(0);
    expect(filterOurAssets([rec({ integrator: 'not-an-address' as Address })])).toHaveLength(0);
  });

  it('claims NOTHING when our own integrator is unset, rather than everything', () => {
    expect(filterOurAssets([rec({ integrator: ZERO })], ZERO)).toHaveLength(0);
    expect(filterOurAssets([rec({ integrator: OURS })], ZERO)).toHaveLength(0);
  });
});

describe('assetsToBaselines', () => {
  it('maps asset → token and carries the timestamp', () => {
    const [b] = assetsToBaselines([rec({ createdAt: 1_700_000_000 })]);
    expect(b?.token).toBe(TOKEN_A);
    expect(b?.launchedAt).toBe(1_700_000_000);
  });

  // Baselines are AT-GRADUATION facts. The Airlock record has none, so these must stay
  // 0 ("unknown" to outcomesReader) rather than carry an invented number into a trust
  // surface.
  it('reports price and liquidity as 0/unknown, never invented', () => {
    const [b] = assetsToBaselines([rec()]);
    expect(b?.launchPriceEth).toBe(0);
    expect(b?.launchLiquidityEth).toBe(0);
  });

  it('does not claim a tier or a creator it cannot know', () => {
    const [b] = assetsToBaselines([rec()]);
    expect(b?.tier).toBe('none');
    expect(b?.creator).toBeNull();
  });

  it('collapses a garbage or negative timestamp to 0', () => {
    expect(assetsToBaselines([rec({ createdAt: -5 })])[0]?.launchedAt).toBe(0);
    expect(assetsToBaselines([rec({ createdAt: NaN })])[0]?.launchedAt).toBe(0);
  });
});

describe('poolByTokenFrom', () => {
  it('keys by lowercased token and omits un-migrated assets', () => {
    const out = poolByTokenFrom([
      rec({ asset: TOKEN_A, migrationPool: POOL_A }),
      rec({ asset: TOKEN_B, migrationPool: ZERO }), // still auctioning
    ]);
    expect(out).toEqual({ [TOKEN_A.toLowerCase()]: POOL_A });
  });
});

describe('sameAddress', () => {
  it('compares case-insensitively and never throws on junk', () => {
    expect(sameAddress('0xAbC', '0xabc')).toBe(true);
    expect(sameAddress('0xAbC', '0xdef')).toBe(false);
    for (const junk of [null, undefined, 0, {}, [], NaN]) {
      expect(() => sameAddress(junk, OURS)).not.toThrow();
      expect(sameAddress(junk, OURS)).toBe(false);
    }
  });
});
