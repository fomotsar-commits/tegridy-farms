// ELEMENT D's HONEST POOL LINE, pinned on the SOURCE of the room: what each branch
// claims. A registry address proves a record, never that a pool is deployed, funded
// or live. A members-only Streamflow pool (closed, a ladder beside it) is shown only
// to wallets staked in it, and this page reads no wallet, so its line names the ladder.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { BUNGALOWS, stakePoolMembersOnly } from '../lib/bungalows';

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

  it('renders a line for every branch, chosen by the registry', () => {
    expect(block).toContain('stakePoolMembersOnly(bungalowIdentity) ? (');
    expect(block).toContain('bungalowIdentity.stakePool ? (');
    expect(block).toContain('is on record at');
    expect(block).toContain('staking program exists on-chain today');
  });

  it('⚠️ never names a members-only pool: that branch names the ladder, and is tested first', () => {
    // That pool still carries a `stakePool`, so a branch tested second would print it.
    const membersAt = block.indexOf('stakePoolMembersOnly(bungalowIdentity) ? (');
    const openAt = block.indexOf(') : bungalowIdentity.stakePool ? (');
    expect(membersAt, 'the members-only branch exists').toBeGreaterThan(-1);
    expect(openAt, 'and the open-pool branch follows it').toBeGreaterThan(membersAt);
    const membersBranch = block.slice(membersAt, openAt);
    expect(membersBranch).toContain('shortenAddress(bungalowIdentity.ladderPool)');
    // A substring, not a word-boundary regex (see the claim test below).
    expect(membersBranch).not.toContain('.stakePool');
    expect(membersBranch).toContain('read live on');
    expect(membersBranch).toContain('to="/farm"');
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

  it('the members-only branch is one env var away, not dead code', () => {
    // The ladder is env-only (VITE_BAYLA_LADDER_POOL): configuring it flips the line.
    const closed = BUNGALOWS.filter((b) => b.chain === 'solana' && b.stakePool && b.depositsClosed);
    expect(closed.length).toBeGreaterThan(0);
    for (const b of closed) expect(stakePoolMembersOnly({ ...b, ladderPool: 'LADDER' }), b.id).toBe(true);
  });
});
