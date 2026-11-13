// Coverage is a claim, and an unstated one defaults to "everything".
//
// The dangerous state for this feature is a borrower with an Aave position
// reading a calm shield page. Nothing on the page would be false — there simply
// would be no row — and they would conclude they are watched. So the assertions
// here are about the venues this app CANNOT read: each one must be present, must
// be marked unreadable, and must carry a sentence saying so.
//
// The second assertion set separates DEPLOYED from READABLE. A live third-party
// market with no adapter in this app is exactly as invisible as an undeployed
// one, and a readiness function that keyed on the address alone would eventually
// report coverage the moment someone pasted a pool address into an env file.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// GONDI_LOAN_ADDRESS is zero until the deploy. A getter, so each test picks the address the
// real gate (ADAPTER_BUILT && deployed) sees.
const gondi = vi.hoisted(() => ({ address: '0x0000000000000000000000000000000000000000' }));
vi.mock('../gondi/loanOffer.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  get GONDI_LOAN_ADDRESS() {
    return gondi.address;
  },
}));

import {
  ADAPTER_BUILT,
  SHIELD_VENUES,
  SHIELD_VENUE_IDS,
  readableVenues,
  shieldVenueReadiness,
  unreadableVenues,
  type ShieldVenueId,
} from './venues';

const EXTERNAL: ShieldVenueId[] = ['aave-v3', 'morpho-blue'];
const ZERO = '0x0000000000000000000000000000000000000000';
const STAND_IN = '0x5555555555555555555555555555555555555555';

beforeEach(() => {
  gondi.address = ZERO;
});

describe('NFT lending on Gondi’s loan contract: watched once it is deployed', () => {
  it('has an adapter: loans come from useMyLoans, each checked against getLoanHash', () => {
    expect(ADAPTER_BUILT['tegridy-nft-lending']).toBe(true);
    expect(SHIELD_VENUES['tegridy-nft-lending'].operatorStep).toMatch(/checked against Gondi.s loan contract on chain/);
  });

  it('before the deploy (zero address) it is unreadable, says so, and exposes no address', () => {
    const r = shieldVenueReadiness()['tegridy-nft-lending'];
    expect(r.readable).toBe(false);
    expect(r.detail).toMatch(/not deployed/i);
    expect(r.address).toBeNull();
    expect(unreadableVenues()).toContain('tegridy-nft-lending');
  });

  it('once deployed it is readable, with no detail, from that address', () => {
    gondi.address = STAND_IN;
    const r = shieldVenueReadiness()['tegridy-nft-lending'];
    expect(r).toEqual({ readable: true, detail: null, address: STAND_IN });
    expect(readableVenues()).toEqual(['tegridy-nft-lending']);
  });
});

describe('every venue is described before it is read', () => {
  it.each(SHIELD_VENUE_IDS)('%s has a label, a loss statement and an operator step', (id) => {
    const v = SHIELD_VENUES[id];
    expect(v.label.length).toBeGreaterThan(0);
    expect(v.lossOnTrigger.length).toBeGreaterThan(0);
    expect(v.operatorStep.length).toBeGreaterThan(0);
  });

  it.each(SHIELD_VENUE_IDS.flatMap((id) => [[id, ZERO], [id, STAND_IN]] as const))(
    '%s readiness carries a detail exactly when it is unreadable (Gondi at %s)',
    (id, address) => {
      gondi.address = address;
      const r = shieldVenueReadiness()[id];
      expect(r.readable ? r.detail : typeof r.detail).toBe(r.readable ? null : 'string');
      if (!r.readable) expect((r.detail ?? '').length).toBeGreaterThan(0);
    },
  );
});

describe('external money markets are visibly not covered', () => {
  it.each(EXTERNAL)('%s has no adapter in this app', (id) => {
    expect(ADAPTER_BUILT[id]).toBe(false);
  });

  it.each(EXTERNAL)('%s is unreadable and says why', (id) => {
    const r = shieldVenueReadiness()[id];
    expect(r.readable).toBe(false);
    expect(r.detail).toMatch(/invisible to this surface/i);
  });

  it.each(EXTERNAL)('%s exposes no address, so nothing can look wired', (id) => {
    expect(shieldVenueReadiness()[id].address).toBeNull();
  });

  it('lists both external markets among the unreadable venues', () => {
    for (const id of EXTERNAL) expect(unreadableVenues()).toContain(id);
  });

  it('never counts an external market as readable, even with Gondi deployed', () => {
    gondi.address = STAND_IN;
    for (const id of EXTERNAL) expect(readableVenues()).not.toContain(id);
  });
});

describe('the two liquidation mechanisms are not conflated', () => {
  it('the venue’s own loans default on a deadline, not on a price', () => {
    expect(SHIELD_VENUES['tegridy-nft-lending'].mechanism).toBe('deadline-default');
  });

  it('external markets are the price-based kind', () => {
    for (const id of EXTERNAL) {
      expect(SHIELD_VENUES[id].mechanism).toBe('price-health-factor');
    }
  });

  it('the venue’s loss statement says the whole item is taken, with no penalty percentage', () => {
    const loss = SHIELD_VENUES['tegridy-nft-lending'].lossOnTrigger;
    expect(loss).toMatch(/entire collateral NFT/i);
    expect(loss).toMatch(/no penalty percentage/i);
    expect(loss).not.toMatch(/\d+\s*%/);
  });
});

describe('readable and unreadable partition the venue list', () => {
  it.each([ZERO, STAND_IN])('every venue is in exactly one of the two lists (Gondi at %s)', (address) => {
    gondi.address = address;
    const both = [...readableVenues(), ...unreadableVenues()].sort();
    expect(both).toEqual([...SHIELD_VENUE_IDS].sort());
    expect(new Set(both).size).toBe(SHIELD_VENUE_IDS.length);
  });

  it('the unreadable list is never empty on this deployment', () => {
    gondi.address = STAND_IN;
    expect(unreadableVenues().length).toBeGreaterThan(0);
  });
});
