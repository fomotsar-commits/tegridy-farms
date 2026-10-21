import { describe, it, expect } from 'vitest';
import { PLATFORM_TREASURY_VAULT } from '../../launcher/solana/curve/program';
import { WORKSHOP_WALLET } from '../../launcher/solana/write/plant';
import { rangeVenueEarns } from './venueEarns';

/**
 * Where a range pool's venue cut goes, from the fee tier's own rates and wallets, by the
 * wallet that actually collects each part. The island's split (owner, 2026-10-20: of each
 * fee 84% to positions, 10.4% to the vault and 5.6% to the island's Workshop) is said
 * plainly; anything else is flagged.
 */

const VAULT = PLATFORM_TREASURY_VAULT.toBase58();
const WORKSHOP = WORKSHOP_WALLET.toBase58();
const STRANGER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const tier = (o: Partial<{ tradeFeeRate: number; protocolFeeRate: number; fundFeeRate: number; owner: string; fundOwner: string }> = {}) => ({
  tradeFeeRate: 10_000, protocolFeeRate: 104_000, fundFeeRate: 56_000, owner: VAULT, fundOwner: WORKSHOP, ...o,
});
const DIFFERS = 'The venue’s cut does not follow the agreed split (10.4% of each fee to the team’s shared wallet and 5.6% to the island’s Workshop). As this fee tier stands: ';

describe('where a range pool’s venue cut goes', () => {
  it('the island’s split is named, each part as a share of the fee and of the swap, with its two wallets, and flags nothing', () => {
    const v = rangeVenueEarns(tier());
    expect(v.cut).toBe('16% of each swap’s fee (0.16% of the swap)');
    expect(v.where).toBe(
      'The venue’s cut is split: 10.4% of each fee (0.104% of the swap) to the team’s shared wallet, which needs two signatures and can change the pool rates, and 5.6% of each fee (0.056% of the swap) to the island’s Workshop, the island’s agreed share.',
    );
    expect(v.wallets).toEqual([{ label: 'Team’s shared wallet', address: VAULT }, { label: 'Island’s Workshop', address: WORKSHOP }]);
    expect(v.elsewhere).toBe(false);
    // The 0.25% tier: the same split of a smaller fee.
    const quarter = rangeVenueEarns(tier({ tradeFeeRate: 2_500 }));
    expect(quarter.cut).toBe('16% of each swap’s fee (0.04% of the swap)');
    expect(quarter.where).toContain('10.4% of each fee (0.026% of the swap) to the team’s shared wallet');
  });

  it('the vault as fund owner (the program’s default) takes the island’s share: flagged, never said as the agreed split', () => {
    const v = rangeVenueEarns(tier({ fundOwner: VAULT }));
    expect(v.elsewhere).toBe(true);
    expect(v.where).toBe(`${DIFFERS}16% of each fee (0.16% of the swap) to the team’s shared wallet, 0% of each fee (0% of the swap) to the island’s Workshop.`);
    expect(v.wallets).toEqual([{ label: 'Team’s shared wallet, 16% of each fee (0.16% of the swap)', address: VAULT }]);
    // A tier with no fund part at all leaves the island nothing too.
    expect(rangeVenueEarns(tier({ protocolFeeRate: 160_000, fundFeeRate: 0, fundOwner: STRANGER })).elsewhere).toBe(true);
  });

  it('each share follows the wallet that collects it: a stranger as the tier’s owner leaves the team nothing', () => {
    const v = rangeVenueEarns(tier({ owner: STRANGER }));
    expect(v.elsewhere).toBe(true);
    expect(v.where).toBe(
      `${DIFFERS}0% of each fee (0% of the swap) to the team’s shared wallet, 5.6% of each fee (0.056% of the swap) to the island’s Workshop, 10.4% of each fee (0.104% of the swap) to another wallet.`,
    );
    expect(v.wallets).toEqual([
      { label: 'Island’s Workshop, 5.6% of each fee (0.056% of the swap)', address: WORKSHOP },
      { label: 'Another wallet, 10.4% of each fee (0.104% of the swap)', address: STRANGER },
    ]);
    const both = rangeVenueEarns(tier({ owner: STRANGER, fundOwner: STRANGER }));
    expect(both.wallets).toEqual([{ label: 'Another wallet, 16% of each fee (0.16% of the swap)', address: STRANGER }]);
    expect(rangeVenueEarns(tier({ owner: WORKSHOP })).elsewhere).toBe(true);
  });

  it('the agreed wallets at other rates are not the agreed split either', () => {
    for (const r of [{ protocolFeeRate: 160_000, fundFeeRate: 0 }, { protocolFeeRate: 104_000, fundFeeRate: 96_000 }, { protocolFeeRate: 100_000, fundFeeRate: 20_000 }]) {
      expect(rangeVenueEarns(tier(r)).elsewhere, JSON.stringify(r)).toBe(true);
    }
  });
});
