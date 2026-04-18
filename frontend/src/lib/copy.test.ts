import { describe, it, expect } from 'vitest';
import {
  RECEIPT_COPY,
  LOCK_DURATIONS,
  PENALTY_COPY,
  GOVERNANCE_COPY,
  FAQ_INTRO,
  TOWELIE_QUOTES,
  ERROR_COPY,
  POOL_FLAVOR,
  lockLabelForSeconds,
  randomToweliQuote,
  poolFlavorLabel,
} from './copy';

describe('RECEIPT_COPY', () => {
  it('covers every documented receipt type', () => {
    const expected = [
      'swap', 'stake', 'unstake', 'claim', 'vote', 'bounty', 'lock',
      'approve', 'liquidity_add', 'liquidity_remove', 'subscribe', 'claim_revenue',
    ];
    for (const key of expected) {
      expect(RECEIPT_COPY).toHaveProperty(key);
      const entry = (RECEIPT_COPY as Record<string, { label: string; verb: string }>)[key];
      expect(entry.label).toBeTruthy();
      expect(entry.verb).toBeTruthy();
    }
  });

  it('uses all-caps for receipt labels (match dapp receipt style)', () => {
    for (const v of Object.values(RECEIPT_COPY)) {
      expect(v.label).toBe(v.label.toUpperCase());
    }
  });

  it('uses in-voice copy where expected', () => {
    expect(RECEIPT_COPY.stake.label).toContain('TEGRIDY');
    expect(RECEIPT_COPY.claim.label).toMatch(/HARVEST/i);
    expect(RECEIPT_COPY.vote.label).toContain('TEGRIDY');
  });
});

describe('LOCK_DURATIONS', () => {
  it('exposes 6 tiers in ascending day-order', () => {
    expect(LOCK_DURATIONS).toHaveLength(6);
    for (let i = 1; i < LOCK_DURATIONS.length; i++) {
      expect(LOCK_DURATIONS[i].days).toBeGreaterThan(LOCK_DURATIONS[i - 1].days);
    }
  });

  it('covers the contract-level 7d → 4yr (1460d) range', () => {
    expect(LOCK_DURATIONS[0].days).toBe(7);
    expect(LOCK_DURATIONS[LOCK_DURATIONS.length - 1].days).toBe(1460);
  });

  it('every tier has label + sublabel + flavor', () => {
    for (const t of LOCK_DURATIONS) {
      expect(t.label).toBeTruthy();
      expect(t.sublabel).toBeTruthy();
      expect(t.flavor).toBeTruthy();
    }
  });
});

describe('lockLabelForSeconds', () => {
  it('returns the matching tier when seconds match a known day-count', () => {
    const taste = lockLabelForSeconds(7 * 86400);
    expect(taste?.label).toBe('The Taste Test');
    const long = lockLabelForSeconds(365 * 86400);
    expect(long?.label).toBe('The Long Haul');
  });

  it('rounds fractional day-values to the nearest whole day', () => {
    // 30 days + 30 seconds still rounds to 30d label.
    const close = lockLabelForSeconds(30 * 86400 + 30);
    expect(close?.label).toBe('One Month of Integrity');
  });

  it('returns undefined for durations that do not match any tier', () => {
    expect(lockLabelForSeconds(15 * 86400)).toBeUndefined();
    expect(lockLabelForSeconds(0)).toBeUndefined();
  });
});

describe('PENALTY_COPY', () => {
  it('exposes the in-voice "DEA Raid Tax" framing', () => {
    expect(PENALTY_COPY.earlyExitLabel).toMatch(/DEA/);
    expect(PENALTY_COPY.earlyExitTagline).toMatch(/kids/i);
    expect(PENALTY_COPY.earlyExitPct).toBe('25%');
  });

  it('provides tooltip text long enough to explain the mechanic', () => {
    expect(PENALTY_COPY.earlyExitTooltip.length).toBeGreaterThan(80);
  });
});

describe('GOVERNANCE_COPY', () => {
  it('re-brands bribes as "Cartman\'s Market"', () => {
    expect(GOVERNANCE_COPY.bribesSectionTitle).toMatch(/Cartman/);
    expect(GOVERNANCE_COPY.bribesSectionTag).toMatch(/Not Bribes/i);
  });
});

describe('FAQ_INTRO', () => {
  it('opens with a Randy-voice subheading', () => {
    expect(FAQ_INTRO.subheading).toMatch(/tegridy/i);
  });
});

describe('TOWELIE_QUOTES', () => {
  it('ships at least 5 rotatable quotes', () => {
    expect(TOWELIE_QUOTES.length).toBeGreaterThanOrEqual(5);
  });

  it('contains the canonical "bring a towel" reference', () => {
    const hay = TOWELIE_QUOTES.join(' | ').toLowerCase();
    expect(hay).toContain('towel');
  });
});

describe('randomToweliQuote', () => {
  it('always returns one of the configured quotes', () => {
    // Run enough iterations that every quote is likely sampled at least once.
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const q = randomToweliQuote();
      expect(TOWELIE_QUOTES).toContain(q);
      seen.add(q);
    }
    // We should sample at least 2 distinct quotes in 200 rolls across 7 options.
    // (Probability of sampling only 1 quote across 200 rolls ≈ 0 for N≥2.)
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('ERROR_COPY', () => {
  it('exposes the four documented error-flavor keys', () => {
    expect(ERROR_COPY).toMatchObject({
      insufficientBalance: expect.any(String),
      walletNotConnected: expect.any(String),
      txRejected: expect.any(String),
      networkError: expect.any(String),
    });
  });
});

describe('POOL_FLAVOR + poolFlavorLabel', () => {
  it('maps known pool IDs to flavor labels', () => {
    expect(poolFlavorLabel('TOWELI', 'fallback')).toBe(POOL_FLAVOR['TOWELI']);
    expect(poolFlavorLabel('TOWELI-WETH-LP', 'fallback')).toBe(POOL_FLAVOR['TOWELI-WETH-LP']);
  });

  it('returns the fallback for unknown pool IDs', () => {
    expect(poolFlavorLabel('UNKNOWN-POOL', 'fallback-label')).toBe('fallback-label');
  });
});
