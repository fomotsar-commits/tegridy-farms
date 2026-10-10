// @vitest-environment node
//
// The LP section's two short blocks: how a provider earns and how the venue does. Every
// number in them is the fee tier's as read (here: tier 1 exactly as mainnet returned it,
// mainnetVenue.fixture.ts), so a changed tier changes the sentence, and no tier means no
// number. Each expected sentence is written out here, never built from earnCopy.ts.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { PLATFORM_TREASURY_VAULT } from '../../launcher/solana/curve/program';
import { RECORDING, recordedTier } from '../cpswap/mainnetVenueReplay.fixture';
import type { AmmConfigView } from '../cpswap/program';
import { EARN_TITLES, howVenueEarns, howYouEarn } from './earnCopy';
import { FORECAST_WORDS } from './format';

const VAULT = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';
const OTHER = '2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa';
const tier1 = (): AmmConfigView => recordedTier(1);
const jupiter = { bps: 50, wallet: VAULT };
const NOTHING_TO_CLAIM = 'Nothing to claim: you receive it when you remove liquidity.';
const FEW_TRADES = 'Few trades means small fees.';

describe('the recorded chain says what the sentences say', () => {
  it('tier 1: traders pay 1%, 16% of that is the venue’s, 0.15 SOL to open; its owner is the team’s 2-of-2 vault', () => {
    const t = tier1();
    expect([t.tradeFeeRate, t.protocolFeeRate, t.fundFeeRate, t.creatorFeeRate, t.createPoolFee]).toEqual([10_000n, 160_000n, 0n, 0n, 150_000_000n]);
    expect(t.protocolOwner).toBe(VAULT);
    expect(PLATFORM_TREASURY_VAULT.toBase58()).toBe(VAULT);
  });

  it('the account the opening fee is paid to (a program constant) is a token account that vault owns', () => {
    // An SPL token account: mint 0..32, owner 32..64.
    const data = Buffer.from(RECORDING.answers[`getAccountInfo:${RECORDING.feeReceiver}`].value.data[0], 'base64');
    expect(new PublicKey(data.subarray(32, 64)).toBase58()).toBe(VAULT);
  });
});

describe('How you earn', () => {
  it('on the public tier as mainnet holds it: 1% a trade, 0.84% of the trade to the pool, nothing to claim', () => {
    expect(howYouEarn(tier1())).toEqual([
      'Each trade in a public pool pays a 1% fee. 0.84% of the trade stays in the pool, and your part is added to your position automatically.',
      NOTHING_TO_CLAIM,
      FEW_TRADES,
    ]);
  });

  it('the numbers are the tier’s: another tier, another sentence', () => {
    // 0.25% a trade with a fifth to the venue: 0.2% stays in the pool.
    expect(howYouEarn({ ...tier1(), tradeFeeRate: 2_500n, protocolFeeRate: 200_000n })[0]).toBe(
      'Each trade in a public pool pays a 0.25% fee. 0.2% of the trade stays in the pool, and your part is added to your position automatically.',
    );
  });

  it('with no tier read there is no number at all, and what is true without one is still said', () => {
    const lines = howYouEarn(null);
    expect(lines).toEqual(['Each trade in a pool pays a fee. Part of it stays in the pool, and your part is added to your position automatically.', NOTHING_TO_CLAIM, FEW_TRADES]);
    expect(lines.join(' ')).not.toMatch(/\d/);
  });
});

describe('How the venue earns', () => {
  it('on the public tier as mainnet holds it, with the swap fee paid to the same vault: three sources, one wallet', () => {
    expect(howVenueEarns(tier1(), jupiter)).toEqual({
      sources: ['0.16% of each trade in a public pool.', '0.15 SOL when a public pool is opened.', '0.5% of a swap sent through Jupiter, where the route allows it.'],
      where: 'It goes to the team’s shared wallet, which needs two signatures and can change the pool rates.',
      wallets: [{ label: 'Team’s shared wallet', address: VAULT }],
    });
  });

  it('every number is read: the cut, the fee to open and the swap fee each follow what they are given', () => {
    const other = howVenueEarns({ ...tier1(), tradeFeeRate: 2_500n, protocolFeeRate: 200_000n, createPoolFee: 2_000_000_000n }, { bps: 100, wallet: VAULT });
    expect(other.sources).toEqual(['0.05% of each trade in a public pool.', '2 SOL when a public pool is opened.', '1% of a swap sent through Jupiter, where the route allows it.']);
    expect(howVenueEarns({ ...tier1(), createPoolFee: 0n }, jupiter).sources[1]).toBe('No fee when a public pool is opened.');
  });

  it('no swap fee set up: said as that, never as a rate', () => {
    const v = howVenueEarns(tier1(), null);
    expect(v.sources[2]).toBe('No fee on a swap sent through Jupiter: none is set up.');
    expect(v.where).toBe('It goes to the team’s shared wallet, which needs two signatures and can change the pool rates.');
    expect(v.wallets).toEqual([{ label: 'Team’s shared wallet', address: VAULT }]);
  });

  it('a swap fee paid to another wallet is not said to go to the vault: it gets its own address', () => {
    const v = howVenueEarns(tier1(), { bps: 50, wallet: OTHER });
    expect(v.where).toBe('The pool fees go to the team’s shared wallet, which needs two signatures and can change the pool rates. The swap fee goes to its own wallet.');
    expect(v.wallets).toEqual([{ label: 'Team’s shared wallet', address: VAULT }, { label: 'Swap fee wallet', address: OTHER }]);
  });

  it('a tier that names another wallet for its cut: shown as read, never called the shared one, and the admin vault is shown beside it', () => {
    const v = howVenueEarns({ ...tier1(), protocolOwner: OTHER }, null);
    expect(v.where).toBe('The cut of each trade goes to the wallet this fee tier names. The team’s shared wallet, which needs two signatures and can change the pool rates, is the program’s admin.');
    expect(v.wallets).toEqual([{ label: 'Wallet this fee tier names', address: OTHER }, { label: 'Team’s shared wallet', address: VAULT }]);
    expect(v.where).not.toMatch(/goes to the team/);
  });

  it('a fund part paid to another wallet: both takers are shown, the vault as the vault and the fund wallet as its own', () => {
    // The vault keeps the protocol part; the tier pays its fund part (4% of the fee) elsewhere.
    const v = howVenueEarns({ ...tier1(), fundFeeRate: 40_000n, fundOwner: OTHER }, jupiter);
    expect(v.where).toBe(
      'The cut of each trade goes to the two wallets this fee tier names. The team’s shared wallet, which needs two signatures and can change the pool rates, is the program’s admin. The swap fee goes to the team’s shared wallet.',
    );
    expect(v.wallets).toEqual([{ label: 'Team’s shared wallet', address: VAULT }, { label: 'Fund wallet this fee tier names', address: OTHER }]);
    // The wallet that differs is on the page, and the vault is never under a label that hides it.
    expect(v.wallets.map((w) => w.address)).toContain(OTHER);
    expect(v.wallets.find((w) => w.address === VAULT)?.label).toBe('Team’s shared wallet');
  });

  it('every wallet a sentence speaks of is shown once: no address twice, and a fund owner the tier does not pay is not shown', () => {
    const third = 'DKxZsjMKVtoRedcHuPRsjnso9Ezj6jVHwSmqnQwU3RJm';
    const all = howVenueEarns({ ...tier1(), protocolOwner: OTHER, fundFeeRate: 40_000n, fundOwner: third }, { bps: 50, wallet: OTHER });
    expect(all.wallets).toEqual([
      { label: 'Wallet this fee tier names, and swap fee wallet', address: OTHER },
      { label: 'Fund wallet this fee tier names', address: third },
      { label: 'Team’s shared wallet', address: VAULT },
    ]);
    // A swap fee paid to a wallet of its own gets its own row and its own sentence.
    const apart = howVenueEarns({ ...tier1(), protocolOwner: OTHER }, { bps: 50, wallet: third });
    expect(apart.wallets.map((w) => w.label)).toEqual(['Wallet this fee tier names', 'Team’s shared wallet', 'Swap fee wallet']);
    expect(apart.where).toMatch(/ The swap fee goes to its own wallet\.$/);
    // Fund fee 0: the fund owner takes nothing, so the tier still pays the vault alone.
    expect(howVenueEarns({ ...tier1(), fundFeeRate: 0n, fundOwner: OTHER }, jupiter).wallets).toEqual([{ label: 'Team’s shared wallet', address: VAULT }]);
  });

  it('with no tier read: no pool number, no wallet and no claim about where it goes', () => {
    const v = howVenueEarns(null, null);
    expect(v).toEqual({ sources: ['A cut of each trade in its pools.', 'A fee when a public pool is opened.', 'No fee on a swap sent through Jupiter: none is set up.'], where: null, wallets: [] });
    expect(v.sources.join(' ')).not.toMatch(/\d/);
    // The swap fee is the build's own setting, not the tier's: it is still said.
    expect(howVenueEarns(null, jupiter).sources[2]).toBe('0.5% of a swap sent through Jupiter, where the route allows it.');
  });
});

describe('short, and promising nothing', () => {
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  const all = (tier: AmmConfigView | null, j: typeof jupiter | null) => {
    const v = howVenueEarns(tier, j);
    return [EARN_TITLES.you, ...howYouEarn(tier), EARN_TITLES.venue, ...v.sources, ...(v.where ? [v.where] : []), ...v.wallets.map((w) => w.label)];
  };

  // Owner, 2026-10-09: "no need to be too wordy but be transparent". Both blocks are read in
  // under 20 seconds: at most 90 words of sentences, 100 with the two titles and the label.
  it('the two blocks as the live site prints them stay short', () => {
    const count = (lines: string[]) => lines.reduce((n, s) => n + words(s), 0);
    const v = howVenueEarns(tier1(), jupiter);
    expect(count([...howYouEarn(tier1()), ...v.sources, v.where ?? ''])).toBeLessThanOrEqual(90);
    expect(count(all(tier1(), jupiter))).toBeLessThanOrEqual(100);
  });

  it('no line forecasts a return or carries an em dash, in any of its forms', () => {
    const forms = [
      all(tier1(), jupiter), all(tier1(), null), all(tier1(), { bps: 50, wallet: OTHER }), all({ ...tier1(), protocolOwner: OTHER }, jupiter),
      all({ ...tier1(), fundFeeRate: 40_000n, fundOwner: OTHER }, jupiter), all({ ...tier1(), protocolOwner: OTHER }, { bps: 50, wallet: OTHER }), all(null, null),
    ];
    for (const line of forms.flat()) {
      expect(line).not.toMatch(FORECAST_WORDS);
      expect(line).not.toMatch(/guarantee|\bearn up to\b|yield/i);
      expect(line).not.toContain('—');
    }
  });
});
