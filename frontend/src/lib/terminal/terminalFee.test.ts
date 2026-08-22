// The terminal must not be able to charge on a build where swaps do not.
//
// Battle plan #1 prices this surface at 0.75%, which is real money on somebody
// else's trade. The rule that keeps that honest is that the rate has exactly one
// home — lib/fees/swapFee.ts — and this module reads it. So the tests below are
// about ABSENCE: no rate constant here, no path from an unconfigured deployment
// to a nonzero figure, and no displayed fee that the request did not carry.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { terminalFeeDisclosure } from './terminalFee';
import { MAX_SWAP_FEE_BPS } from '../fees/swapFee';
import type { AggregatorSource } from '../aggregator';

const RECIPIENT = '0x6d5791A660e79175F74C6D639584C98422d5956E';
const ALL_SOURCES: AggregatorSource[] = [
  'swapapi', 'odos', 'cowswap', 'lifi', 'kyberswap', 'openocean', 'paraswap',
];

function enableFee(bps: string, recipient = RECIPIENT) {
  vi.stubEnv('VITE_SWAP_FEE_BPS', bps);
  vi.stubEnv('VITE_SWAP_FEE_RECIPIENT', recipient);
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe('there is no second fee mechanism in here', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'terminalFee.ts'),
    'utf-8',
  );

  it('declares no rate of its own — the 0.75% from the plan is not hardcoded anywhere', () => {
    // A bps or percent literal in this file would be a rate that the venue dial
    // cannot switch off, which is the whole failure mode.
    const codeOnly = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    // No nonzero rate may be written into a returned disclosure…
    expect(codeOnly).not.toMatch(/\bbps:\s*[1-9]/);
    // …and no rate constant may be declared to feed one.
    expect(codeOnly).not.toMatch(/_BPS\b\s*=/);
    expect(codeOnly).not.toMatch(/0\.75/);
  });

  it('reads the venue dial rather than re-implementing it', () => {
    expect(source).toMatch(/from '\.\.\/fees\/swapFee'/);
    expect(source).toMatch(/providerFeeAttachment/);
  });
});

describe('off by default, for every route', () => {
  it('reports None on the in-app router path — what a terminal buy actually submits', () => {
    const d = terminalFeeDisclosure({ source: null, executes: true });
    expect(d.bps).toBe(0);
    expect(d.charged).toBe(false);
    expect(d.value).toBe('None');
  });

  it('reports None for every aggregator with the dial unset', () => {
    for (const source of ALL_SOURCES) {
      const d = terminalFeeDisclosure({ source, executes: true });
      expect(d.bps, `${source} charged with no dial configured`).toBe(0);
      expect(d.charged).toBe(false);
    }
  });

  it('stays off with a rate but no recipient — a rate alone is a donation', () => {
    vi.stubEnv('VITE_SWAP_FEE_BPS', '75');
    for (const source of ALL_SOURCES) {
      expect(terminalFeeDisclosure({ source, executes: true }).bps).toBe(0);
    }
    expect(terminalFeeDisclosure({ source: null, executes: true }).bps).toBe(0);
  });

  it('stays off on the in-app path even with BOTH dials set — that route has no fee leg', () => {
    enableFee('75');
    const d = terminalFeeDisclosure({ source: null, executes: true });
    expect(d.bps).toBe(0);
    expect(d.charged).toBe(false);
  });

  it('never advertises a fee for a provider whose leg is withheld', () => {
    enableFee('75');
    for (const source of ALL_SOURCES) {
      const d = terminalFeeDisclosure({ source, executes: true });
      // paraswap is the one ready leg today; everything else must read None even
      // though the policy is on, because those requests never carry the rate.
      if (source === 'paraswap') {
        expect(d.bps).toBe(75);
      } else {
        expect(d.bps, `${source} advertised a fee its request does not carry`).toBe(0);
        expect(d.value).toBe('None');
      }
    }
  });

  it('respects the venue ceiling rather than defining one', () => {
    enableFee(String(MAX_SWAP_FEE_BPS * 10));
    expect(terminalFeeDisclosure({ source: 'paraswap', executes: true }).bps).toBe(MAX_SWAP_FEE_BPS);
  });
});

describe('what is displayed is what would be taken', () => {
  it('marks a comparison quote as not charged', () => {
    enableFee('75');
    const d = terminalFeeDisclosure({ source: 'paraswap', executes: false });
    expect(d.charged).toBe(false);
    expect(d.value).toMatch(/not charged/);
  });

  it('names the fee on the route that will actually be submitted', () => {
    enableFee('75');
    const d = terminalFeeDisclosure({ source: 'paraswap', executes: true });
    expect(d.charged).toBe(true);
    expect(d.value).toBe('0.75%');
    expect(d.note).toMatch(/before you sign/i);
  });

  it('the zero state never claims there are no fees at all', () => {
    const d = terminalFeeDisclosure({ source: null, executes: true });
    expect(d.note).toMatch(/pool, aggregator and network gas costs/i);
    expect(d.note).not.toMatch(/no fees/i);
  });

  it('tells a withheld leg apart from a switched-off dial', () => {
    enableFee('75');
    const withheld = terminalFeeDisclosure({ source: 'odos', executes: true });
    expect(withheld.note).toMatch(/configured but is not attached/i);

    vi.unstubAllEnvs();
    const off = terminalFeeDisclosure({ source: 'odos', executes: true });
    expect(off.note).toMatch(/adds no fee/i);
  });
});
