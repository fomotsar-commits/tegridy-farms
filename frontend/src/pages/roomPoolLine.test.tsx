// ELEMENT D's HONEST POOL LINE, pinned on the SOURCE of the room.
//
// §D asks a room for "its pool or its honest state". Before this the room could
// only get you TO a pool: the hero's button goes to Earn and reads "The
// lighthouse" instead of "Stake" when there is none, which is honest about the
// button and silent about the token.
//
// Asserted here rather than through a full HomePage render because the room's
// two branches are decided by one registry field, and the thing worth pinning is
// WHAT EACH BRANCH CLAIMS — specifically that the pool branch never says a pool
// is deployed, funded or live. In this repo REGISTERED, DEPLOYED and WIRED are
// three different facts, and a room that conflates them is the exact bug class
// the venue keeps writing memos about.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BUNGALOWS } from '../lib/bungalows';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'HomePage.tsx'), 'utf8');

/** The pool line's own JSX, and nothing else on the page. */
const block = src.slice(
  src.indexOf('element D: THE POOL, OR THE HONEST LINE'),
  src.indexOf('Who holds her'),
);

describe("element D — the room states its pool's honest state", () => {
  it('finds a non-empty block to assert against', () => {
    // GUARDS THE GUARD. Every assertion below is a substring test over `block`,
    // and a slice that came back empty would pass the negative ones silently —
    // which is how the first version of this file shipped a regex that could
    // never match anything.
    expect(block.length).toBeGreaterThan(300);
    expect(block).toContain('bungalowIdentity.stakePool');
  });

  it('renders a line for both branches, chosen by the registry field', () => {
    expect(block).toContain('bungalowIdentity.stakePool ? (');
    expect(block).toContain('is on record at');
    expect(block).toContain('staking program exists on-chain today');
  });

  it('never claims the pool is deployed, live, funded or earning', () => {
    // A registry address proves a record, not a contract. The live questions go
    // to the panel on Earn that actually reads them.
    //
    // `expect(block).not.toMatch(claim)`, NOT
    // `expect(claim.test(block)).toBe(false)`. The second form was written first
    // and passed under the very mutation it exists to catch, because the regex
    // literal had been mangled into one containing a backspace byte and could
    // not match anything at all. A guard that cannot fail is worse than none,
    // and this file is about honesty.
    // Scoped to a claim ABOUT THE POOL, not to the words. The first pattern was
    // a bare /(is deployed|is live|is funded|...)/ and it reddened on the honest
    // line itself — "Whether it is funded ... is read live on Earn" contains
    // "is funded" while asserting the opposite. A guard that cannot tell a claim
    // from a disclaimer would have been quietly weakened until it passed.
    const claim = /pool is (deployed|live|funded|earning)|now earning|earns? [0-9]/i;
    expect(block).not.toMatch(claim);
    expect(block).toContain('read live on');
  });

  it('sends the live question to Earn, where the panel that reads it lives', () => {
    expect(block).toContain('to="/farm"');
  });

  it('borrows the no-pool sentence from the panel, so there is one wording', () => {
    const panel = readFileSync(join(here, '..', 'components', 'bungalow', 'BungalowFarmPanel.tsx'), 'utf8');
    expect(panel).toContain('staking program exists on-chain today');
  });

  it('has both branches reachable in the registry, or one of them is dead code', () => {
    // If every room had a pool, the honest branch would never render and would
    // rot unseen. Two rooms carry no stakePool today.
    const withPool = BUNGALOWS.filter((b) => b.stakePool).length;
    expect(withPool).toBeGreaterThan(0);
    expect(withPool).toBeLessThan(BUNGALOWS.length);
  });
});
