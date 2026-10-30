import { describe, expect, it } from 'vitest';
import { parseCoinInput } from './coinInput';

// SNEK, read from mainnet (Koios policy_asset_list and asset_list, 2026-10-30).
const POLICY = '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f';
const NAME = '534e454b';
const FINGERPRINT = 'asset108xu02ckwrfc8qs9d97mgyh4kn8gdu9w8f5sxk';
const COIN = { kind: 'coin', policyId: POLICY, assetName: NAME };

describe('parseCoinInput', () => {
  it('takes the whole id, as DexScreener shows a Cardano coin’s address', () => {
    expect(parseCoinInput(POLICY + NAME)).toEqual(COIN);
    expect(parseCoinInput(`  ${(POLICY + NAME).toUpperCase()} `)).toEqual(COIN);
    expect(parseCoinInput(`${POLICY}.${NAME}`)).toEqual(COIN);
  });

  it('takes the policy id alone, for the coin to be found under it', () => {
    expect(parseCoinInput(POLICY)).toEqual({ kind: 'policy', policyId: POLICY });
    // A name in letters is never read as hex: only the policy id is kept.
    expect(parseCoinInput(`${POLICY}.SNEK`)).toEqual({ kind: 'policy', policyId: POLICY });
  });

  it('takes an asset1… id only when its checksum holds', () => {
    expect(parseCoinInput(FINGERPRINT)).toEqual({ kind: 'fingerprint', fingerprint: FINGERPRINT });
    expect(parseCoinInput(FINGERPRINT.toUpperCase())).toEqual({ kind: 'fingerprint', fingerprint: FINGERPRINT });
    expect(parseCoinInput(`${FINGERPRINT.slice(0, -1)}q`)).toEqual({ kind: 'unknown' });
    expect(parseCoinInput('addr1q96a7')).toEqual({ kind: 'unknown' });
  });

  it('finds the id in an explorer’s link to the coin', () => {
    expect(parseCoinInput(`https://cardanoscan.io/token/${POLICY}${NAME}`)).toEqual(COIN);
    expect(parseCoinInput(`https://cardanoscan.io/token/${FINGERPRINT}?tab=holders`)).toEqual({ kind: 'fingerprint', fingerprint: FINGERPRINT });
    expect(parseCoinInput(`cardanoscan.io/tokenPolicy/${POLICY}`)).toEqual({ kind: 'policy', policyId: POLICY });
    expect(parseCoinInput(`https://cexplorer.io/asset/${FINGERPRINT}`)).toEqual({ kind: 'fingerprint', fingerprint: FINGERPRINT });
    expect(parseCoinInput(`https://pool.pm/${POLICY}.SNEK`)).toEqual({ kind: 'policy', policyId: POLICY });
    // pool.pm writes the name in letters: one that happens to look like hex is still not read as hex.
    expect(parseCoinInput(`https://pool.pm/${POLICY}.BEEF`)).toEqual({ kind: 'policy', policyId: POLICY });
  });

  it('says a trading pair’s page, or a pool’s share token, is not a coin', () => {
    const pair = `f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c2ffadbb87144e875749122e0bbb9f535eeaa7f5660c6c4a91bcc4121e477f08d`;
    expect(parseCoinInput(`https://dexscreener.com/cardano/${pair}`)).toEqual({ kind: 'pair' });
    expect(parseCoinInput(`https://www.geckoterminal.com/cardano/pools/${pair}`)).toEqual({ kind: 'pair' });
    expect(parseCoinInput(pair)).toEqual({ kind: 'pair' });
    // A WingRiders pair: its id is no Minswap share token, and the link is still a pair's.
    expect(parseCoinInput('https://dexscreener.com/cardano/6fdc63a1d71dc2c65502b79baae7fb543185702b12c3c5fb639ed737e3b382a85249ef92357e00bd42c088c69c1eac2a736ae2df34dd2b89de11de1a')).toEqual({ kind: 'pair' });
  });

  it('refuses what is not a Cardano coin', () => {
    for (const text of [
      'SNEK',
      '0x1234567890abcdef1234567890abcdef12345678',
      'So11111111111111111111111111111111111111112',
      `${POLICY}${'ab'.repeat(33)}`,
      `${POLICY.slice(1)}`,
      'https://example.com/about',
      'not a link/at all',
    ]) {
      expect(parseCoinInput(text), text).toEqual({ kind: 'unknown' });
    }
    expect(parseCoinInput('   ')).toBeNull();
  });
});
