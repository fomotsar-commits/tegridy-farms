// @vitest-environment node
//
// The LP section's two short blocks: how a provider earns and how the venue does. Every
// number in them is the fee tier's as read (here: tier 1 exactly as mainnet returned it,
// mainnetVenue.fixture.ts on 2026-10-03, and both tiers as mainnet holds them since the
// island split, SPLIT_TIER_BYTES), so a changed tier changes the sentence, and no tier
// means no number. Each expected sentence is written out here, never built from earnCopy.ts.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { PLATFORM_TREASURY_VAULT } from '../../launcher/solana/curve/program';
import { WORKSHOP_WALLET } from '../../launcher/solana/write/plant';
import { RECORDING, recordedTier, splitTier } from '../cpswap/mainnetVenueReplay.fixture';
import type { AmmConfigView } from '../cpswap/program';
import { AGREED_SPLIT, EARN_TITLES, howVenueEarns, howYouEarn } from './earnCopy';
import { FORECAST_WORDS } from './format';

const VAULT = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';
const WORKSHOP = 'G2EHPseTXetHbBvvRDs27XQyXfQikXXyxP9uMbsKrbu';
const OTHER = '2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa';
/** Tier 1 as recorded on 2026-10-03, before the island split: the whole 16% to the vault. */
const tier1 = (): AmmConfigView => recordedTier(1);
/** Tier 1 as mainnet holds it since the split (2026-10-19). */
const split1 = (): AmmConfigView => splitTier(1);
const jupiter = { bps: 50, wallet: VAULT };
const NOTHING_TO_CLAIM = 'Nothing to claim: you receive it when you remove liquidity.';
const FEW_TRADES = 'Few trades means small fees.';
const VAULT_ROW = { label: 'Team’s shared wallet', address: VAULT };
const WORKSHOP_ROW = { label: 'Island’s Workshop', address: WORKSHOP };
const SPLIT_WHERE =
  'Of each trade’s fee, 10.4% (0.104% of the trade) goes to the team’s shared wallet, which needs two signatures and can change the pool rates, and 5.6% (0.056% of the trade) to the island’s Workshop, the island’s agreed share.';
const NOT_AGREED = 'The venue’s cut does not follow the agreed split (10.4% of each trade’s fee to the team’s shared wallet, 5.6% to the island’s Workshop).';

describe('the recorded chain says what the sentences say', () => {
  it('tier 1 on 2026-10-03: traders pay 1%, 16% of that is the venue’s, 0.15 SOL to open; its owner is the team’s 2-of-2 vault', () => {
    const t = tier1();
    expect([t.tradeFeeRate, t.protocolFeeRate, t.fundFeeRate, t.creatorFeeRate, t.createPoolFee]).toEqual([10_000n, 160_000n, 0n, 0n, 150_000_000n]);
    expect(t.protocolOwner).toBe(VAULT);
    expect(PLATFORM_TREASURY_VAULT.toBase58()).toBe(VAULT);
  });

  it('since the island split (read 2026-10-21), each tier holds its agreed split: the vault as owner, the Workshop as fund owner', () => {
    const one = split1();
    expect([one.index, one.tradeFeeRate, one.protocolFeeRate, one.fundFeeRate, one.creatorFeeRate, one.createPoolFee]).toEqual([1, 10_000n, 104_000n, 56_000n, 0n, 150_000_000n]);
    const zero = splitTier(0);
    expect([zero.index, zero.tradeFeeRate, zero.protocolFeeRate, zero.fundFeeRate, zero.creatorFeeRate, zero.createPoolFee]).toEqual([0, 2_500n, 130_000n, 70_000n, 5_000n, 0n]);
    for (const t of [one, zero]) expect([t.protocolOwner, t.fundOwner]).toEqual([VAULT, WORKSHOP]);
    expect(WORKSHOP_WALLET.toBase58()).toBe(WORKSHOP);
    expect(AGREED_SPLIT).toEqual({ 0: { protocol: 130_000n, fund: 70_000n }, 1: { protocol: 104_000n, fund: 56_000n } });
  });

  it('the account the opening fee is paid to (a program constant) is a token account that vault owns', () => {
    // An SPL token account: mint 0..32, owner 32..64.
    const data = Buffer.from(RECORDING.answers[`getAccountInfo:${RECORDING.feeReceiver}`].value.data[0], 'base64');
    expect(new PublicKey(data.subarray(32, 64)).toBase58()).toBe(VAULT);
  });
});

describe('How you earn', () => {
  it('on the public tier as mainnet holds it: 1% a trade, 0.84% of the trade to the pool, nothing to claim', () => {
    for (const t of [tier1(), split1()]) {
      expect(howYouEarn([t])).toEqual([
        'Each trade in a public pool pays a 1% fee. 0.84% of the trade stays in the pool, and your part is added to your position automatically.',
        NOTHING_TO_CLAIM,
        FEW_TRADES,
      ]);
    }
  });

  it('the numbers are the tier’s: another tier, another sentence', () => {
    // 2% a trade with a fifth to the venue: 1.6% stays in the pool.
    expect(howYouEarn([{ ...tier1(), tradeFeeRate: 20_000n, protocolFeeRate: 200_000n }])[0]).toBe(
      'Each trade in a public pool pays a 2% fee. 1.6% of the trade stays in the pool, and your part is added to your position automatically.',
    );
  });

  it('two public tiers: each rate, the 0.25% one for SOL against USDC only (owner, 2026-10-24), and what stays in each pool', () => {
    const low = { ...split1(), index: 2, tradeFeeRate: 2_500n };
    expect(howYouEarn([split1(), low])[0]).toBe(
      "Each trade in a public pool pays a 1% fee (0.25% for SOL against USDC), by the pool's tier. Of the trade, 0.84% (1% pool) or 0.21% (0.25% pool) stays in the pool, and your part is added to your position automatically.",
    );
    // A 0.25% tier alone is still said as SOL against USDC only.
    expect(howYouEarn([low])[0]).toMatch(/^Each trade in a public pool pays a 0\.25% fee \(SOL against USDC only\)\. /);
  });

  it('with no tier read there is no number at all, and what is true without one is still said', () => {
    const lines = howYouEarn([]);
    expect(lines).toEqual(['Each trade in a pool pays a fee. Part of it stays in the pool, and your part is added to your position automatically.', NOTHING_TO_CLAIM, FEW_TRADES]);
    expect(lines.join(' ')).not.toMatch(/\d/);
  });
});

describe('How the venue earns', () => {
  it('on the public tier as mainnet holds it since the split: three sources, and each part of the cut said as a share of the fee and of the trade', () => {
    expect(howVenueEarns([split1()], jupiter)).toEqual({
      sources: ['0.16% of each trade in a public pool.', '0.15 SOL when a public pool is opened.', '0.5% of a swap sent through Jupiter, where the route allows it.'],
      where: `${SPLIT_WHERE} The swap fee goes to the team’s shared wallet.`,
      wallets: [VAULT_ROW, WORKSHOP_ROW],
      elsewhere: false,
    });
    expect(howVenueEarns([split1()], null).where).toBe(SPLIT_WHERE);
  });

  it('the launch tier as mainnet holds it: its own agreed split, not tier 1’s', () => {
    const v = howVenueEarns([splitTier(0)], null);
    expect(v.elsewhere).toBe(false);
    expect(v.where).toBe(
      'Of each trade’s fee, 13% (0.0325% of the trade) goes to the team’s shared wallet, which needs two signatures and can change the pool rates, and 7% (0.0175% of the trade) to the island’s Workshop, the island’s agreed share.',
    );
    // Tier 0's rates on tier 1 are not tier 1's agreed split.
    expect(howVenueEarns([{ ...split1(), protocolFeeRate: 130_000n, fundFeeRate: 70_000n }], null).elsewhere).toBe(true);
  });

  // The program's default fund owner is the vault, and the vault can point it back there: the island's part is then lost quietly.
  it('a fund owner that is the team’s vault keeps the island’s part: said in bold, with the whole cut summed on the vault', () => {
    const v = howVenueEarns([{ ...split1(), fundOwner: VAULT }], jupiter);
    expect(v.elsewhere).toBe(true);
    expect(v.where).toBe(`${NOT_AGREED} Of each trade’s fee, this tier sends 16% (0.16% of the trade) to the team’s shared wallet and nothing to the island’s Workshop. The swap fee goes to the team’s shared wallet.`);
    expect(v.wallets).toEqual([{ label: 'Team’s shared wallet, 16% of each trade’s fee', address: VAULT }, WORKSHOP_ROW]);
    // The tier as it stood before the split (no fund part at all) says the same.
    expect(howVenueEarns([tier1()], null)).toMatchObject({
      elsewhere: true,
      where: `${NOT_AGREED} Of each trade’s fee, this tier sends 16% (0.16% of the trade) to the team’s shared wallet and nothing to the island’s Workshop.`,
    });
  });

  it('the right wallets at other rates are not the agreed split either: said in bold, each part as set', () => {
    const v = howVenueEarns([{ ...split1(), protocolFeeRate: 120_000n, fundFeeRate: 40_000n }], null);
    expect(v.elsewhere).toBe(true);
    expect(v.where).toBe(`${NOT_AGREED} Of each trade’s fee, this tier sends 12% (0.12% of the trade) to the team’s shared wallet and 4% (0.04% of the trade) to the island’s Workshop.`);
    expect(v.wallets).toEqual([
      { label: 'Team’s shared wallet, 12% of each trade’s fee', address: VAULT },
      { label: 'Island’s Workshop, 4% of each trade’s fee', address: WORKSHOP },
    ]);
    // More to the island is still not what was agreed, and neither is the fund part switched off.
    expect(howVenueEarns([{ ...split1(), fundFeeRate: 112_000n }], null).elsewhere).toBe(true);
    expect(howVenueEarns([{ ...split1(), protocolFeeRate: 160_000n, fundFeeRate: 0n }], null).elsewhere).toBe(true);
  });

  it('a tier with no agreed split is said in bold, whatever it pays', () => {
    const v = howVenueEarns([{ ...split1(), index: 2 }], null);
    expect(v.elsewhere).toBe(true);
    expect(v.where).toBe(
      'This fee tier has no split agreed with the island. Of each trade’s fee, this tier sends 10.4% (0.104% of the trade) to the team’s shared wallet and 5.6% (0.056% of the trade) to the island’s Workshop.',
    );
  });

  it('another wallet collecting a part: named as another wallet with what it collects, the vault and the Workshop with theirs', () => {
    const fund = howVenueEarns([{ ...split1(), fundOwner: OTHER }], null);
    expect(fund.elsewhere).toBe(true);
    expect(fund.where).toBe(
      `${NOT_AGREED} Of each trade’s fee, this tier sends 10.4% (0.104% of the trade) to the team’s shared wallet, nothing to the island’s Workshop and 5.6% (0.056% of the trade) to another wallet.`,
    );
    expect(fund.wallets).toEqual([
      { label: 'Team’s shared wallet, 10.4% of each trade’s fee', address: VAULT },
      WORKSHOP_ROW,
      { label: 'Another wallet, 5.6% of each trade’s fee', address: OTHER },
    ]);
    const protocol = howVenueEarns([{ ...split1(), protocolOwner: OTHER }], null);
    expect(protocol.where).toMatch(/this tier sends nothing to the team’s shared wallet, 5\.6% \(0\.056% of the trade\) to the island’s Workshop and 10\.4% \(0\.104% of the trade\) to another wallet\.$/);
    // One wallet collecting both parts collects their sum.
    const both = howVenueEarns([{ ...split1(), protocolOwner: OTHER, fundOwner: OTHER }], null);
    expect(both.wallets).toEqual([VAULT_ROW, WORKSHOP_ROW, { label: 'Another wallet, 16% of each trade’s fee', address: OTHER }]);
    expect(both.where).toMatch(/nothing to the team’s shared wallet, nothing to the island’s Workshop and 16% \(0\.16% of the trade\) to another wallet\.$/);
  });

  it('every number is read: the cut, the fee to open and the swap fee each follow what they are given', () => {
    const other = howVenueEarns([{ ...tier1(), tradeFeeRate: 2_500n, protocolFeeRate: 200_000n, createPoolFee: 2_000_000_000n }], { bps: 100, wallet: VAULT });
    expect(other.sources).toEqual(['0.05% of each trade in a public pool.', '2 SOL when a public pool is opened.', '1% of a swap sent through Jupiter, where the route allows it.']);
    expect(howVenueEarns([{ ...tier1(), createPoolFee: 0n }], jupiter).sources[1]).toBe('No fee when a public pool is opened.');
  });

  it('no swap fee set up: said as that, never as a rate', () => {
    const v = howVenueEarns([split1()], null);
    expect(v.sources[2]).toBe('No fee on a swap sent through Jupiter: none is set up.');
    expect(v.wallets).toEqual([VAULT_ROW, WORKSHOP_ROW]);
  });

  it('a swap fee paid to another wallet is not said to go to the vault: it gets its own address', () => {
    const v = howVenueEarns([split1()], { bps: 50, wallet: OTHER });
    expect(v.where).toBe(`${SPLIT_WHERE} The swap fee goes to its own wallet.`);
    expect(v.wallets).toEqual([VAULT_ROW, WORKSHOP_ROW, { label: 'Swap fee wallet', address: OTHER }]);
  });

  it('every wallet a sentence speaks of is shown once: no address twice, and a fund owner the tier does not pay is not shown', () => {
    const third = 'DKxZsjMKVtoRedcHuPRsjnso9Ezj6jVHwSmqnQwU3RJm';
    const all = howVenueEarns([{ ...split1(), protocolOwner: OTHER, fundOwner: third }], { bps: 50, wallet: OTHER });
    expect(all.wallets).toEqual([
      VAULT_ROW,
      WORKSHOP_ROW,
      { label: 'Another wallet, 10.4% of each trade’s fee, and swap fee wallet', address: OTHER },
      { label: 'Another wallet, 5.6% of each trade’s fee', address: third },
    ]);
    // A swap fee paid to a wallet of its own gets its own row and its own sentence.
    const apart = howVenueEarns([{ ...split1(), protocolOwner: OTHER }], { bps: 50, wallet: third });
    expect(apart.wallets.map((w) => w.label)).toEqual(['Team’s shared wallet', 'Island’s Workshop, 5.6% of each trade’s fee', 'Another wallet, 10.4% of each trade’s fee', 'Swap fee wallet']);
    expect(apart.where).toMatch(/ The swap fee goes to its own wallet\.$/);
    // Fund fee 0: the fund owner takes nothing, so it is not shown.
    expect(howVenueEarns([{ ...split1(), fundFeeRate: 0n, fundOwner: OTHER }], jupiter).wallets).toEqual([
      { label: 'Team’s shared wallet, 10.4% of each trade’s fee', address: VAULT },
      WORKSHOP_ROW,
    ]);
  });

  it('two tiers on the agreed split: each tier’s parts by its rate, what the vault can do said once', () => {
    const v = howVenueEarns([split1(), splitTier(0)], null);
    expect(v.elsewhere).toBe(false);
    expect(v.where).toBe(
      'In a 1% pool, of each trade’s fee, 10.4% (0.104% of the trade) goes to the team’s shared wallet, which needs two signatures and can change the pool rates, and 5.6% (0.056% of the trade) to the island’s Workshop, the island’s agreed share. In a 0.25% pool, of each trade’s fee, 13% (0.0325% of the trade) goes to the team’s shared wallet and 7% (0.0175% of the trade) to the island’s Workshop, the island’s agreed share.',
    );
    expect(v.wallets).toEqual([VAULT_ROW, WORKSHOP_ROW]);
  });

  it('a second tier with no agreed split is said first, in bold, by its rate; the agreed one after', () => {
    const v = howVenueEarns([split1(), { ...split1(), index: 2, tradeFeeRate: 2_500n }], jupiter);
    expect(v.elsewhere).toBe(true);
    expect(v.sources.slice(0, 2)).toEqual(['0.16% of each trade in a 1% pool.', '0.04% of each trade in a 0.25% pool.']);
    expect(v.where).toBe(
      'The 0.25% fee tier has no split agreed with the island. Of each trade’s fee, this tier sends 10.4% (0.026% of the trade) to the team’s shared wallet and 5.6% (0.014% of the trade) to the island’s Workshop. In a 1% pool, of each trade’s fee, 10.4% (0.104% of the trade) goes to the team’s shared wallet, which needs two signatures and can change the pool rates, and 5.6% (0.056% of the trade) to the island’s Workshop, the island’s agreed share. The swap fee goes to the team’s shared wallet.',
    );
    expect(v.wallets).toEqual([VAULT_ROW, WORKSHOP_ROW]);
  });

  it('with no tier read: no pool number, no wallet and no claim about where it goes', () => {
    const v = howVenueEarns([], null);
    expect(v).toEqual({ sources: ['A cut of each trade in its pools.', 'A fee when a public pool is opened.', 'No fee on a swap sent through Jupiter: none is set up.'], where: null, wallets: [], elsewhere: false });
    expect(v.sources.join(' ')).not.toMatch(/\d/);
    // The swap fee is the build's own setting, not the tier's: it is still said.
    expect(howVenueEarns([], jupiter).sources[2]).toBe('0.5% of a swap sent through Jupiter, where the route allows it.');
  });
});

describe('short, and promising nothing', () => {
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  const all = (tier: readonly AmmConfigView[], j: typeof jupiter | null) => {
    const v = howVenueEarns(tier, j);
    return [EARN_TITLES.you, ...howYouEarn(tier), EARN_TITLES.venue, ...v.sources, ...(v.where ? [v.where] : []), ...v.wallets.map((w) => w.label)];
  };

  // Owner, 2026-10-09: "no need to be too wordy but be transparent". 90 words of sentences,
  // 100 with titles and labels, until the island split (2026-10-19) put two wallets' shares,
  // each of the fee and of the trade, in the sentence: 120 and 135 since.
  it('the two blocks as the live site prints them stay short', () => {
    const count = (lines: string[]) => lines.reduce((n, s) => n + words(s), 0);
    const v = howVenueEarns([split1()], jupiter);
    expect(count([...howYouEarn([split1()]), ...v.sources, v.where ?? ''])).toBeLessThanOrEqual(120);
    expect(count(all([split1()], jupiter))).toBeLessThanOrEqual(135);
  });

  it('no line forecasts a return or carries an em dash, in any of its forms', () => {
    const forms = [
      all([split1()], jupiter), all([split1()], null), all([split1()], { bps: 50, wallet: OTHER }), all([tier1()], jupiter), all([{ ...split1(), protocolOwner: OTHER }], jupiter),
      all([{ ...split1(), fundOwner: OTHER }], jupiter), all([{ ...split1(), protocolOwner: OTHER }], { bps: 50, wallet: OTHER }), all([{ ...split1(), index: 2 }], null), all([], null),
    ];
    for (const line of forms.flat()) {
      expect(line).not.toMatch(FORECAST_WORDS);
      expect(line).not.toMatch(/guarantee|\bearn up to\b|yield/i);
      expect(line).not.toContain('—');
    }
  });
});
