import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARVEST_VAULT_ADDRESS, venueAvailability, zapVenue, zapVenues } from './venues';
import {
  LP_FARMING_ADDRESS,
  TEGRIDY_LP_ADDRESS,
  TEGRIDY_ROUTER_ADDRESS,
  TEGRIDY_STAKING_ADDRESS,
  isDeployed,
} from '../constants';

describe('the venue catalog', () => {
  it('reports each venue against the addresses this build actually has', () => {
    const byId = Object.fromEntries(
      zapVenues().map((v) => [v.available ? v.venue.id : v.id, v]),
    );
    expect(byId['staking-lock']!.available).toBe(isDeployed(TEGRIDY_STAKING_ADDRESS));
    expect(byId['lp-farm']!.available).toBe(
      isDeployed(LP_FARMING_ADDRESS) && isDeployed(TEGRIDY_LP_ADDRESS) && isDeployed(TEGRIDY_ROUTER_ADDRESS),
    );
  });

  it('gives an unavailable venue a reason, never a bare false', () => {
    for (const entry of zapVenues()) {
      if (entry.available) continue;
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(zapVenue(entry.id)).toBeNull();
    }
  });

  it('names all three contracts an LP-shaped venue needs, so a partial deployment cannot read as ready', () => {
    // Not asserted through the live constants (router and LP are both set today, so the
    // branch would never run) — asserted on the source, which is what a future zeroing
    // edits. The vault's own gate is exercised for real, because it IS zero today.
    const source = readFileSync(join(process.cwd(), 'src', 'lib', 'zap', 'venues.ts'), 'utf-8');
    expect(source).toMatch(/isDeployed\(TEGRIDY_ROUTER_ADDRESS\)/);
    expect(source).toMatch(/isDeployed\(TEGRIDY_LP_ADDRESS\)/);
    expect(source).toMatch(/isDeployed\(venue\.target\)/);
    expect(venueAvailability('compounder-vault').available).toBe(false);
  });
});

describe('the compounder vault, which is routed but not deployed', () => {
  const root = process.cwd();

  it('is offered as a venue and reports itself unavailable, with the reason', () => {
    const vault = venueAvailability('compounder-vault');
    expect(vault.available).toBe(isDeployed(HARVEST_VAULT_ADDRESS));
    if (!vault.available) expect(vault.reason).toMatch(/not deployed yet/);
  });

  it('routes to the LP token the vault actually takes', () => {
    // TegridyHarvestVault's constructor asserts `farm.stakingToken() == asset`, and the
    // farm's staking token is the native pair. A zap that paired a different LP would
    // build a position the vault cannot accept.
    const source = readFileSync(join(root, '..', 'contracts', 'src', 'vaults', 'TegridyHarvestVault.sol'), 'utf-8');
    expect(source).toMatch(/farm\.stakingToken\(\)\s*!=\s*_asset/);
    const venues = readFileSync(join(root, 'src', 'lib', 'zap', 'venues.ts'), 'utf-8');
    expect(venues).toMatch(/id: 'compounder-vault'[\s\S]*?depositAsset: TEGRIDY_LP_ADDRESS/);
  });

  // STALE-GATE GUARD. `HARVEST_VAULT_ADDRESS` lives in venues.ts only because this slice
  // does not own constants.ts. The day the canonical constant lands there, the local one
  // is a second source of truth for a money destination — the worst kind — so this fails
  // and names the fix rather than letting the two drift.
  it('has exactly one gate: the moment constants.ts gains one, this local one must go', () => {
    const constants = readFileSync(join(root, 'src', 'lib', 'constants.ts'), 'utf-8');
    const canonical = /\b(COMPOUNDER|AUTO_?COMPOUND\w*|HARVEST_VAULT|LAAS_VAULT|ERC4626_VAULT)\w*_ADDRESS\b/;
    expect(
      canonical.test(constants),
      'src/lib/constants.ts now carries a vault address. Point src/lib/zap/venues.ts at it and DELETE the ' +
        'local HARVEST_VAULT_ADDRESS placeholder — two addresses for one destination is how a zap ends up ' +
        'depositing into the wrong contract.',
    ).toBe(false);
  });

  it('is zero-address-gated, so an operator turns it on rather than a redeploy', () => {
    expect(HARVEST_VAULT_ADDRESS).toBe('0x0000000000000000000000000000000000000000');
  });
});

describe('venueAvailability', () => {
  it('returns the live-address answer for a venue that is available', () => {
    const staking = venueAvailability('staking-lock');
    if (!staking.available) {
      expect(staking.reason).toBeTruthy();
      return;
    }
    expect(staking.venue.target.toLowerCase()).toBe(TEGRIDY_STAKING_ADDRESS.toLowerCase());
  });
});
