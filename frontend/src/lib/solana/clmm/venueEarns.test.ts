import { describe, it, expect } from 'vitest';
import { PLATFORM_TREASURY_VAULT } from '../../launcher/solana/curve/program';
import { WORKSHOP_WALLET } from '../../launcher/solana/write/plant';
import { rangeVenueEarns } from './venueEarns';

/**
 * Where a range pool's venue cut goes, from the fee tier's own rates and wallets. The
 * island's split (owner, 2026-10-20: of each fee 84% to positions, 10.4% to the vault and
 * 5.6% to the island's Workshop) is said plainly; any other wallet is flagged.
 */

const VAULT = PLATFORM_TREASURY_VAULT.toBase58();
const WORKSHOP = WORKSHOP_WALLET.toBase58();
const STRANGER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const tier = (o: Partial<{ tradeFeeRate: number; protocolFeeRate: number; fundFeeRate: number; owner: string; fundOwner: string }> = {}) => ({
  tradeFeeRate: 10_000, protocolFeeRate: 104_000, fundFeeRate: 56_000, owner: VAULT, fundOwner: WORKSHOP, ...o,
});

describe('where a range pool’s venue cut goes', () => {
  it('the island’s split is named, with its two wallets, and flags nothing', () => {
    const v = rangeVenueEarns(tier());
    expect(v.cut).toBe('16% of each swap’s fee (0.16% of the swap)');
    expect(v.where).toBe('The venue’s cut is split: 65% to the team’s shared wallet, which needs two signatures and can change the pool rates, and 35% to the island’s Workshop, the island’s agreed share.');
    expect(v.wallets).toEqual([{ label: 'Team’s shared wallet', address: VAULT }, { label: 'Island’s Workshop', address: WORKSHOP }]);
    expect(v.elsewhere).toBe(false);
    // The 0.25% tier: the same split of a smaller fee.
    expect(rangeVenueEarns(tier({ tradeFeeRate: 2_500 })).cut).toBe('16% of each swap’s fee (0.04% of the swap)');
  });

  it('a tier with no fund part that pays the vault says so', () => {
    const v = rangeVenueEarns(tier({ protocolFeeRate: 160_000, fundFeeRate: 0, fundOwner: STRANGER }));
    expect(v.where).toBe('It goes to the team’s shared wallet, which needs two signatures and can change the pool rates.');
    expect(v.elsewhere).toBe(false);
  });

  it('a stranger collecting either part, or the Workshop collecting the team’s part, is flagged, naming only what misses the split', () => {
    const fund = rangeVenueEarns(tier({ fundOwner: STRANGER }));
    expect(fund.elsewhere).toBe(true);
    expect(fund.where).toMatch(/the island’s part, to the wallet below/);
    expect(fund.wallets).toEqual([{ label: 'Collects the island’s part', address: STRANGER }]);
    const team = rangeVenueEarns(tier({ owner: STRANGER }));
    expect(team.elsewhere).toBe(true);
    expect(team.wallets).toEqual([{ label: 'Collects the team’s part', address: STRANGER }]);
    const both = rangeVenueEarns(tier({ owner: STRANGER, fundOwner: STRANGER }));
    expect(both.where).toMatch(/the team’s part and the island’s part, to the wallets below/);
    expect(rangeVenueEarns(tier({ owner: WORKSHOP })).elsewhere).toBe(true);
  });
});
