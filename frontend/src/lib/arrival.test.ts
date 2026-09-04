import { describe, it, expect, beforeEach } from 'vitest';
import { arrivalVoice, isToweliVoice, loaderIdentity, VENUE } from './arrival';
import { BUNGALOW_STORAGE_KEY } from './bungalows';

/**
 * ARRIVAL IDENTITY 2026-08-27 -- the containment contract.
 *
 * The venue speaks as MEMETICS.FINANCE by default; the whole classic
 * Tegridy identity lives inside the TOWELI bungalow and NOWHERE else.
 * These tests pin the resolution matrix and the copy walls. A regression
 * here is a branding leak on the front door, which is exactly the defect
 * this change removed.
 */

function goto(path: string, search = '') {
  window.history.replaceState({}, '', `${path}${search}`);
}

beforeEach(() => {
  localStorage.clear();
  goto('/');
});

describe('arrivalVoice resolution matrix', () => {
  it('is the venue voice on a clean arrival at /', () => {
    expect(arrivalVoice()).toBe('venue');
    expect(isToweliVoice()).toBe(false);
  });

  it('is toweli on the /toweli door path, before any storage exists', () => {
    goto('/toweli');
    expect(arrivalVoice()).toBe('toweli');
  });

  it('honors the /towelie alias spelling', () => {
    goto('/towelie');
    expect(arrivalVoice()).toBe('toweli');
  });

  it('honors the ?bungalow=toweli deep link', () => {
    goto('/', '?bungalow=toweli');
    expect(arrivalVoice()).toBe('toweli');
  });

  it('is toweli when the stored choice is toweli', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'toweli');
    expect(arrivalVoice()).toBe('toweli');
  });

  it('is bungalow when a non-default identity bungalow is stored (bayla)', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    expect(arrivalVoice()).toBe('bungalow');
  });

  it('falls back to venue on an unknown stored id', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'not-a-bungalow');
    expect(arrivalVoice()).toBe('venue');
  });
});

describe('loaderIdentity -- the words the intro forms', () => {
  it('forms the venue name on a default arrival', () => {
    const id = loaderIdentity();
    expect(id.main).toBe('MEMETICS');
    expect(id.sub).toBe('.FINANCE');
    expect(id.gallery && id.gallery.length).toBeGreaterThan(0);
  });

  it('keeps the classic TEGRIDY FARMS intro inside the TOWELI bungalow', () => {
    goto('/toweli');
    const id = loaderIdentity();
    expect(id.main).toBe('TEGRIDY');
    expect(id.sub).toBe('FARMS');
    expect(id.gallery).toBeNull();
  });

  it('never flashes Tegridy words on a venue arrival', () => {
    const id = loaderIdentity();
    for (const w of id.subliminal) {
      expect(w.toUpperCase()).not.toContain('TEGRIDY');
      expect(w.toUpperCase()).not.toContain('TOWEL');
    }
  });
});

describe('VENUE copy walls', () => {
  it('places the venue on Jungle Bay Island', () => {
    expect(VENUE.tagline).toContain('Jungle Bay Island');
    expect(VENUE.description).toContain('Jungle Bay Island');
  });

  it('never self-declares certification -- the island certifies, the venue reads', () => {
    const all = Object.values(VENUE).join(' ').toLowerCase();
    expect(all).not.toContain('certified');
    expect(all).not.toContain('certification');
  });

  it('never prints the certification stamp sentence', () => {
    const all = Object.values(VENUE).join(' ');
    expect(all).not.toContain('Every lock verifiable onchain');
  });

  it('carries no Tegridy branding in any venue-voice string', () => {
    const all = Object.values(VENUE).join(' ').toLowerCase();
    expect(all).not.toContain('tegridy');
  });
});
