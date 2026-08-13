import { describe, it, expect } from 'vitest';
import { pageArt } from './artConfig';
import { ART_OVERRIDES } from './artOverrides';

// The pop-up / modal cards (onboarding, consent, receipt, token picker, wallet
// gate, admin confirm) were wired through pageArt(pageId, idx) so they show up
// as adjustable surfaces in the art-studio. Each MUST have a registered override
// so it resolves to a deliberate piece instead of the hash-rotation fallback —
// otherwise a modal silently renders a random piece. We assert the surface is
// registered and resolves to real art, NOT which specific piece (the whole point
// is that the art-studio can change it), so studio edits never break this test.
const POPUP_SURFACES = [
  'onboarding:0',
  'onboarding:1',
  'onboarding:2',
  'onboarding:3',
  'consent-banner:0',
  'tx-receipt:0',
  'connect-prompt:0',
  'token-select:0',
  'typed-confirm:0',
  // Tradermigos pop-ups (src/nakamigos/), wired 2026-08-12. These live outside
  // src/components/ which is why every earlier "art on every popup" pass missed
  // them — they rendered no art at all, rather than losing it. Pinned here so
  // they cannot silently fall back to the hash rotation.
  'wallet-modal:0',
  'make-offer:0',
  'nft-detail:0',
];

describe('pop-up modal art surfaces (art-studio registered)', () => {
  it('every pop-up surface has a registered override', () => {
    for (const key of POPUP_SURFACES) {
      expect(ART_OVERRIDES[key], `${key} should be registered in ART_OVERRIDES`).toBeTruthy();
      expect(ART_OVERRIDES[key].artId, `${key} override needs an artId`).toBeTruthy();
    }
  });

  it('every pop-up surface resolves to a real art piece', () => {
    for (const key of POPUP_SURFACES) {
      const [pageId, idx] = key.split(':');
      const piece = pageArt(pageId, Number(idx));
      expect(piece, `${key} should resolve to a piece`).toBeTruthy();
      expect(piece.src, `${key} src should be a real asset`).toMatch(/^\/(art|splash|nakamigos)\//);
    }
  });
});
