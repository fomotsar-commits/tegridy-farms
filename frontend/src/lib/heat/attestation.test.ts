// THE ATTESTATION SEAM, LAID DARK — Wave 3, phase 06(c).
//
// The island has ruled that signed launch vouchers are coming. They are not here: there
// is no island key and no island route to fetch one from. The wave asks for the verify
// hook to exist now, config-shaped and INACTIVE, against one pinned shape — so that the
// day the island publishes, this venue sets a route and nothing else.
//
// The pinned shape, verbatim from the wave:
//   island-key signature over canonical JSON of
//   { address, degrees, tier, floor, as_of_unix, expires_unix, nonce }
//   island public key read from an island route that does not exist yet.
//
// WHAT THESE TESTS ARE REALLY FOR. A dark seam is dangerous in one specific way: it can
// quietly become load-bearing. Someone wires `verifyLaunchVoucher` into the gate, it
// returns a falsy "not configured", the caller reads that as "not attested", and a
// voucher check that has never run starts deciding who may launch. So the contract is
// deliberately NOT boolean — an unconfigured seam is its own state, and it can never be
// mistaken for a verdict.
//
// The other half: it must be impossible to activate by accident. No key, no route, no
// activation today — enforced, not just intended.

import { describe, it, expect } from 'vitest';
import {
  canonicalVoucherBytes,
  islandKeyRoute,
  verifyLaunchVoucher,
  VOUCHER_FIELDS,
  type LaunchVoucher,
} from './attestation';

const VOUCHER: LaunchVoucher = {
  address: '0xd71caf9fdbbd3dd7f974431edf7f9f2c7ba8f93a',
  degrees: 195.54,
  tier: 'Builder',
  floor: 80,
  as_of_unix: 1_786_000_000,
  expires_unix: 1_786_600_000,
  nonce: 'a3f1c2',
};

describe('the seam cannot activate while the island route is unset', () => {
  it('has no island key route configured', () => {
    // The route does not exist yet, on either side. If this ever returns a value by
    // default, someone has invented an island endpoint.
    expect(islandKeyRoute()).toBeNull();
  });

  it('reports UNCONFIGURED — not a pass, and not a denial', () => {
    const r = verifyLaunchVoucher(VOUCHER, 'deadbeef');
    expect(r.state).toBe('unconfigured');
  });

  it('is not a boolean, so it cannot be read as a verdict by accident', () => {
    // The failure this prevents: `if (!verify(v)) deny()` on a seam that has never run.
    const r = verifyLaunchVoucher(VOUCHER, 'deadbeef');
    expect(typeof r).toBe('object');
    expect('valid' in r).toBe(false);
  });

  it('never claims a voucher is valid while unconfigured, whatever it is handed', () => {
    for (const sig of ['', 'deadbeef', 'x'.repeat(128)]) {
      expect(verifyLaunchVoucher(VOUCHER, sig).state).toBe('unconfigured');
    }
    // Including a voucher that is already expired — still unconfigured, because we
    // cannot judge it at all. "Unknown is never a confident value" applies to the
    // negative direction too: this is not a denial.
    const stale = { ...VOUCHER, expires_unix: 1 };
    expect(verifyLaunchVoucher(stale, 'deadbeef').state).toBe('unconfigured');
  });
});

describe('the canonical shape is pinned to the island word', () => {
  it('carries exactly the seven fields, in the island order', () => {
    expect(VOUCHER_FIELDS).toEqual([
      'address',
      'degrees',
      'tier',
      'floor',
      'as_of_unix',
      'expires_unix',
      'nonce',
    ]);
  });

  it('serialises those seven and nothing else, whatever the caller adds', () => {
    const withExtra = { ...VOUCHER, sneaky: 'value' } as unknown as LaunchVoucher;
    const parsed = JSON.parse(new TextDecoder().decode(canonicalVoucherBytes(withExtra)));
    expect(Object.keys(parsed)).toEqual(VOUCHER_FIELDS);
  });

  it('is key-order independent — the same voucher is the same bytes', () => {
    // A signature is over BYTES. If field order followed object construction order, two
    // encoders of the same voucher would disagree and every signature would look
    // forged. This is the same "sign the exact wire bytes" discipline the birth socket
    // already keeps.
    const shuffled: LaunchVoucher = {
      nonce: VOUCHER.nonce,
      floor: VOUCHER.floor,
      address: VOUCHER.address,
      expires_unix: VOUCHER.expires_unix,
      tier: VOUCHER.tier,
      as_of_unix: VOUCHER.as_of_unix,
      degrees: VOUCHER.degrees,
    };
    expect(canonicalVoucherBytes(shuffled)).toEqual(canonicalVoucherBytes(VOUCHER));
  });

  it('refuses to encode a voucher missing a pinned field', () => {
    const { nonce: _drop, ...missing } = VOUCHER;
    expect(() => canonicalVoucherBytes(missing as unknown as LaunchVoucher)).toThrow(/nonce/);
  });
});
