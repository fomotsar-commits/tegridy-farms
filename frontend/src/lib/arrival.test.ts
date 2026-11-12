import { describe, it, expect, beforeEach } from 'vitest';
import { arrivalVoice, voiceAt, isToweliVoice, loaderIdentity, VENUE, RECEIPT_WORDS, COUNTDOWN_WORDS } from './arrival';
import { TOWELI_ROOM_PATHS } from './routeVoice';
import { onboardingSteps } from '../components/onboarding/onboardingSteps';
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

  it('is the venue on the home page, whatever room was opened last', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'toweli');
    expect(arrivalVoice()).toBe('venue');
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

/**
 * THE FARM SPEAKS ONLY IN ITS ROOM (docs/FACE_LAWS.md, law 21).
 *
 * One visit to /toweli stores the room, and the stored room used to speak on every
 * route after it: the farm's footer, Towelie and the farm's words on /start. The
 * stored room still dresses the art and the trade route. It speaks only on its own pages.
 */
describe('the room opened last speaks only on its own pages', () => {
  const VENUE_ROUTES = ['/', '/start', '/leaderboard', '/launch', '/nb1', '/swap', '/solana', '/earn', '/pools', '/scan', '/bayla', '/earn/bayla'];
  const FARM_PAGES = ['/toweli', '/towelie', ...TOWELI_ROOM_PATHS];

  it('is the venue on every venue route after a visit to /toweli', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'toweli');
    for (const path of VENUE_ROUTES) {
      goto(path);
      expect(arrivalVoice(), path).toBe('venue');
      expect(isToweliVoice(), path).toBe(false);
    }
  });

  it('is still the farm on the farm’s own pages, for a visitor who came through its door', () => {
    // The counter-test: a fix that silenced the farm everywhere would pass the case above.
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'toweli');
    expect(FARM_PAGES).toContain('/tokenomics');
    expect(FARM_PAGES).toContain('/earn/toweli');
    for (const path of FARM_PAGES) {
      goto(path);
      expect(arrivalVoice(), path).toBe('toweli');
    }
  });

  it('does not start speaking to a stranger who lands on a farm protocol page', () => {
    // As before: only the two doors speak with nothing stored (routeVoice.ts says why).
    for (const path of TOWELI_ROOM_PATHS) {
      goto(path);
      expect(arrivalVoice(), path).toBe('venue');
    }
  });

  it('follows the room last opened on /dashboard, which draws that room’s positions', () => {
    // The one route left: the farm's positions page has no address of its own yet.
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'toweli');
    goto('/dashboard');
    expect(arrivalVoice()).toBe('toweli');
    localStorage.clear();
    expect(arrivalVoice()).toBe('venue');
  });

  it('answers for a given path the same way, without reading the address bar', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'toweli');
    goto('/toweli');
    expect(voiceAt('/start', '')).toBe('venue');
    expect(voiceAt('/tokenomics', '')).toBe('toweli');
    goto('/start');
    expect(voiceAt('/toweli', '')).toBe('toweli');
  });

  it('keeps the venue’s words in step one of /start', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'toweli');
    goto('/start');
    const first = onboardingSteps()[0]!.body.join(' ');
    expect(first).toContain('stake a resident community’s token');
    expect(first).not.toContain('TOWELI');
  });

  it('never forms the farm’s loader words on a venue route', () => {
    localStorage.setItem(BUNGALOW_STORAGE_KEY, 'toweli');
    goto('/launch');
    expect(loaderIdentity().main).toBe('MEMETICS');
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

// Island answer thirty-four: the words that say "$TICKER" name a coin by a ticker of its own, once.
describe('the receipt card names a coin once, or not at all', () => {
  it('the shore and its mark drop a ticker’s own $, as the floor and the post do', () => {
    expect(RECEIPT_WORDS.shore('$WIF')).toBe("You're on $WIF's shore. Every light here holds it.");
    expect(RECEIPT_WORDS.shoreMark('$WIF')).toBe("$WIF's shore.");
    expect(RECEIPT_WORDS.shore('BAYLA')).toBe("You're on $BAYLA's shore. Every light here holds it.");
    expect(RECEIPT_WORDS.shore('$WIF')).toContain(RECEIPT_WORDS.shoreMark('$WIF'));
    expect(RECEIPT_WORDS.floor('$WIF')).toBe("You're part of $WIF's floor now. Every trade in the pool pays you.");
    expect(RECEIPT_WORDS.lpPost('$WIF')).toContain('to $WIF on memetics.finance');
  });

  it('the floor’s mark is the coin’s floor, inside the line', () => {
    expect(RECEIPT_WORDS.floorMark('BAYLA')).toBe("$BAYLA's floor");
    expect(RECEIPT_WORDS.floorMark('$WIF')).toBe("$WIF's floor");
    for (const coin of ['BAYLA', '$WIF', 'BRAINLET']) expect(RECEIPT_WORDS.floor(coin)).toContain(RECEIPT_WORDS.floorMark(coin));
  });

  it('with no ticker of the coin’s own, the line and the post name none', () => {
    expect(RECEIPT_WORDS.floor(null)).toBe("You're part of the floor now. Every trade in the pool pays you.");
    expect(RECEIPT_WORDS.lpPost(null)).toBe("Just added liquidity on memetics.finance. I'm part of the floor now. Every trade in the pool pays me.");
    const intent = new URL(RECEIPT_WORDS.lpIntent(null, 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'));
    expect(intent.searchParams.get('text')).toBe(`${RECEIPT_WORDS.lpPost(null)} https://memetics.finance/lp/EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm`);
    for (const words of [RECEIPT_WORDS.floor(null), RECEIPT_WORDS.lpPost(null)]) {
      expect(words).not.toContain('$');
      expect(words).not.toMatch(/—/);
    }
  });
});

describe('the countdown’s line under its number', () => {
  it('served days count from today; half a year counts from a first real buy', () => {
    expect(COUNTDOWN_WORDS.under).toBe('to the door, if you hold from today.');
    expect(COUNTDOWN_WORDS.underUnserved).toBe('to the door, from your first real buy.');
  });
});
