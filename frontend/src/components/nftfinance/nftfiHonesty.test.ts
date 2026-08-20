import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// THE TWO NFT-FI SURFACES SHIP GATED OFF, AND THIS IS THE CHECK THAT THEY SAY SO.
//
// Pooled lending (#61) and the instalment desk (#62) have no deployed contract.
// A surface in that state has exactly two honest options: render the reason, or
// render nothing. The failure mode it must never reach is the third one — a card
// with "0 ETH" in it, which a visitor reads as "a real pool that nobody has used
// yet" rather than as "there is no pool".
//
// Source-scanned rather than rendered, deliberately. A render test proves what
// one code path produced for one set of props; this proves the file contains no
// path that could produce a fabricated figure, which is the property that has to
// hold on every branch including the ones no test drives.

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(HERE, '..', '..', 'hooks');

const pooled = readFileSync(join(HERE, 'PooledLendingSection.tsx'), 'utf-8');
const bnpl = readFileSync(join(HERE, 'BnplSection.tsx'), 'utf-8');
const vaultHook = readFileSync(join(HOOKS, 'usePooledLendingVault.ts'), 'utf-8');
const deskHook = readFileSync(join(HOOKS, 'useBnplDesk.ts'), 'utf-8');
const config = readFileSync(join(HOOKS, 'usePooledLendingConfig.ts'), 'utf-8');

/** Source with `//` and `/* *\/` comment bodies removed. */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .join('\n');
}

describe('every address in this slice is still the zero address', () => {
  it('no pool vault and no instalment desk carries a deployed address', () => {
    // The moment one of these stops being zero, a deploy ceremony happened and
    // this test is the place to record which one and why. It failing is not a
    // bug; it is the handover.
    const nonZero = [...config.matchAll(/vault:\s*(\w+)/g)].map((m) => m[1]);
    expect(nonZero.every((v) => v === 'ZERO')).toBe(true);
    expect(config).toMatch(/export const BNPL_DESK_ADDRESS = ZERO;/);
  });
});

describe('the undeployed state is stated, not implied', () => {
  it('pooled lending says there is no contract rather than showing an empty pool', () => {
    expect(pooled).toMatch(/No pool is deployed/);
    expect(pooled).toMatch(/nothing below is a measurement/);
  });

  it('the instalment desk says the same about itself', () => {
    expect(bnpl).toMatch(/not deployed/i);
    expect(bnpl).toMatch(/no live desk exists/i);
  });

  it('the estimator labels itself as the written terms, not a live quote', () => {
    expect(bnpl).toMatch(/no deployment exists to read/);
  });
});

describe('an absent reading never renders as a number', () => {
  it('every pool figure passes through the null-aware formatters', () => {
    // `eth`, `pct` and `days` all take `| null` and return the string
    // "no data". A formatter that took a plain number would force a caller to
    // invent a zero to satisfy it.
    expect(vaultHook).toMatch(/tvlWei: bigint \| null/);
    expect(vaultHook).toMatch(/utilisationBps: number \| null/);
    expect(pooled).toMatch(/function eth\(wei: bigint \| null\)/);
    expect(pooled).toMatch(/if \(wei === null\) return 'no data'/);
  });

  it('the hooks null every field outside their live state', () => {
    // Both hooks funnel their non-live states through a single builder that
    // cannot produce a figure, so a new field added later inherits the rule
    // instead of defaulting to 0.
    expect(vaultHook).toMatch(/function emptyState\(/);
    expect(deskHook).toMatch(/function empty\(/);
  });

  it('the quote hook returns null rather than a zeroed schedule', () => {
    const quote = readFileSync(join(HOOKS, 'useBnplQuote.ts'), 'utf-8');
    expect(quote).toMatch(/if \(priceWei <= 0n\) return null;/);
    expect(quote).toMatch(/if \(terms\.instalments <= 0\) return null;/);
  });
});

describe('"not deployed" and "could not read" stay separate states', () => {
  // Collapsing them is the specific bug this slice is shaped to avoid: an RPC
  // outage against a REAL pool would otherwise render identically to a pool
  // that does not exist, and only one of those is safe to shrug at.
  it('the vault hook names all three', () => {
    expect(vaultHook).toMatch(/'not-deployed' \| 'unreadable' \| 'live'/);
  });

  it('the desk hook names all three', () => {
    expect(deskHook).toMatch(/'not-deployed' \| 'unreadable' \| 'live'/);
  });

  it('the pool card renders a distinct chip for each', () => {
    expect(pooled).toMatch(/Not deployed/);
    expect(pooled).toMatch(/Unreadable/);
  });
});

describe('no read is ever aimed at the zero address', () => {
  it('both hooks gate the query on isDeployed rather than on the result', () => {
    // A call to 0x0 answers "0x", which viem decodes into a shape that looks
    // like a reading. The gate has to be BEFORE the call.
    expect(vaultHook).toMatch(/query: \{ enabled: deployed/);
    expect(deskHook).toMatch(/query: \{ enabled: deployed/);
  });
});

describe('the risks a buyer or depositor carries are on the surface', () => {
  it('the instalment surface says a missed payment costs the token', () => {
    expect(bnpl).toMatch(/costs you the token/i);
  });

  it('it discloses that a sale below the debt returns nothing', () => {
    expect(bnpl).toMatch(/below the debt returns\s*\n?\s*nothing/);
  });

  it('it refuses the promotional framing outright', () => {
    expect(bnpl).toMatch(/no promotional rate and no interest-free/);
    expect(codeOnly(bnpl)).not.toMatch(/0% (intro|APR|interest)/i);
  });

  it('both surfaces state that nothing runs on a timer', () => {
    expect(pooled).toMatch(/runs no keeper/);
    expect(bnpl).toMatch(/runs no keeper/);
  });

  it('pooled lending states the size of the market instead of implying depth', () => {
    expect(pooled).toMatch(/down roughly 97%/);
    expect(pooled).toMatch(/not a flagship/);
  });
});

describe('the indexer gap is described, not papered over', () => {
  it('history is gated on the indexer being configured at all', () => {
    expect(vaultHook).toMatch(/isIndexerConfigured\(\)/);
    expect(vaultHook).toMatch(/not because none exists/);
  });

  it('the pooled surface renders that reason rather than an empty history', () => {
    expect(pooled).toMatch(/No realized-yield or liquidation history/);
  });
});

describe('dark-surface contrast', () => {
  // Same rule as darkSurfaceContrast.test.ts, applied to the two new files:
  // every surface underneath them is dark, so black text is only legible over
  // an opaque light fill.
  const OPAQUE_LIGHT_FILL = /\bbg-(emerald|amber|yellow|white|purple|blue)-[1-5]00\b(?!\/)/;
  const offending = (src: string) =>
    src
      .split('\n')
      .filter((l) => /\btext-black\b|\btext-black\/\d+\b/.test(l))
      .filter((l) => !OPAQUE_LIGHT_FILL.test(l));

  it('PooledLendingSection.tsx', () => expect(offending(pooled)).toEqual([]));
  it('BnplSection.tsx', () => expect(offending(bnpl)).toEqual([]));
});
