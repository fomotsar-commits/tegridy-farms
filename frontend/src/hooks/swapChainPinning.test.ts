import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * EVERY contract call in the swap stack must name the chain it is for.
 *
 * 🔴 WHY THIS IS A TEST AND NOT A CONVENTION. Seven addresses in this repo are a
 * DIFFERENT, LIVE contract on a different chain, because deterministic CREATE
 * reused nonces across deploys. Verified on-chain 2026-09-05: 0xa24C7287…67a52
 * is the mainnet TegridyFactory, Base's swapFeeRouter and Robinhood's twap, and
 * it returns 43,064 hex chars of runtime code on Base against 29,956 on
 * Robinhood — genuinely different contracts at one address. 0x12a249A0… is
 * Base's factory and Robinhood's sequencerUptimeFeed.
 *
 * So an unpinned call does NOT fail loudly. It does not revert, it does not
 * return empty 0x — it executes against a real contract of the wrong type. The
 * `chainId:` on each call is the only thing standing between a user and that,
 * and it is one deletion away at fifteen separate sites.
 *
 * THIS EXISTS BEFORE THE MULTICHAIN REFACTOR, ON PURPOSE. The whole point of
 * making the swap stack chain-parametric is to stop pinning everything to
 * CHAIN_ID — which means the refactor's failure mode is silently dropping a pin
 * on the way. Building the net first means that shows up as a red test instead
 * of as a wrong-contract transaction. When the refactor lands, this assertion
 * should get STRICTER (the resolved chain must come from the venue), never
 * deleted.
 *
 * It reads source text rather than behaviour deliberately: a runtime test would
 * need a live wallet on three chains to catch what one regex catches for free.
 * `doorThumbLuma.test.ts` establishes the same source-reading pattern here.
 */

const ROOT = join(__dirname, '..');

/** Files where a contract call carries real money or real approval. */
const SWAP_STACK = [
  'hooks/useSwap.ts',
  'hooks/useSwapQuote.ts',
  'hooks/useSwapAllowance.ts',
];

/**
 * The wagmi entry points that actually reach a chain.
 *
 * `publicClient.readContract` is deliberately NOT here. A call can be pinned two
 * ways — on the call, or on the CLIENT it is made through — and useSwap pins the
 * client (`usePublicClient({ chainId: CHAIN_ID })`). My first version of this
 * test flagged those two reads as unpinned and it was WRONG: it would have had
 * me "fix" correct code by adding a redundant key. The client's pin is asserted
 * separately below, so the invariant is still closed, just at the right place.
 */
const CALLS = ['writeContract', 'useReadContract', 'simulateContract'];

/**
 * Pull out the balanced `{...}` that follows `name(` — a regex alone cannot,
 * because these objects contain nested arrays and objects (`args: [...]`).
 */
function objectLiteralsAfter(source: string, name: string): string[] {
  const out: string[] = [];
  const needle = `${name}({`;
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) return out;
    let depth = 0;
    let i = at + name.length + 1;
    const start = i;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(source.slice(start, i + 1));
    from = i + 1;
  }
}

describe('swap stack chain pinning', () => {
  const sources = SWAP_STACK.map((rel) => ({
    rel,
    text: readFileSync(join(ROOT, rel), 'utf8'),
  }));

  it('the fixture is not vacuous — the swap stack really does make contract calls', () => {
    // Without this, a rename could empty every list below and the suite would
    // report "all passed" while proving nothing. This is the exact failure mode
    // that let a whole test file go missing earlier in this repo.
    const total = sources.reduce(
      (n, { text }) => n + CALLS.reduce((m, c) => m + objectLiteralsAfter(text, c).length, 0),
      0,
    );
    expect(total, 'found no contract calls at all — the selectors must have drifted').toBeGreaterThan(
      10,
    );
  });

  it.each(SWAP_STACK)('%s pins a chain on every contract call', (rel) => {
    const { text } = sources.find((s) => s.rel === rel)!;
    const unpinned: string[] = [];

    for (const call of CALLS) {
      for (const literal of objectLiteralsAfter(text, call)) {
        // `chainId` as a KEY. A bare mention in a comment must not satisfy this.
        if (!/\bchainId\s*:/.test(literal)) {
          unpinned.push(`${call}(${literal.replace(/\s+/g, ' ').slice(0, 110)}…`);
        }
      }
    }

    expect(
      unpinned,
      `${rel} has ${unpinned.length} contract call(s) with no chainId. Seven addresses in ` +
        `this repo are a different LIVE contract on another chain, so an unpinned call ` +
        `executes against the wrong type instead of reverting:\n  ${unpinned.join('\n  ')}`,
    ).toEqual([]);
  });

  it('a chain-pinned CLIENT is the other way a call can be safe, so pin every client', () => {
    // The exemption above is only sound while this holds. If a publicClient is
    // ever created without a chainId, the reads made through it silently follow
    // the wallet's chain — which is the collision hazard by another door.
    let seen = 0;
    for (const { rel, text } of sources) {
      for (const literal of objectLiteralsAfter(text, 'usePublicClient')) {
        seen++;
        expect(
          literal.includes('chainId:'),
          `${rel} builds a publicClient with no chainId — every read through it ` +
            `follows the wallet instead of a chain we chose`,
        ).toBe(true);
      }
    }
    expect(seen, 'no publicClient found — the exemption above is now unguarded').toBeGreaterThan(0);
  });

  it('the two money paths still refuse a wrong chain', () => {
    // These are what stop a wrong-chain wallet reaching the writes at all. The
    // refactor will replace them with a per-chain resolve; until it does,
    // deleting one is how the collision hazard goes live.
    const { text } = sources.find((s) => s.rel === 'hooks/useSwap.ts')!;
    // There are FOUR `chainId !== CHAIN_ID` gates, not two — I assumed two and
    // this test corrected me. The other two guard custom-token verification and
    // token import. So assert the two that stand in front of MONEY (approve and
    // swap), by their refusal, rather than a raw total that a legitimate fifth
    // gate would break.
    const refusals = text.match(/Please switch to Ethereum Mainnet/g) ?? [];
    expect(
      refusals.length,
      'useSwap lost a wrong-chain refusal — the approve path and the swap path each need one',
    ).toBe(2);
    const gates = text.match(/if \(chainId !== CHAIN_ID\)/g) ?? [];
    expect(gates.length, 'the wrong-chain gates vanished entirely').toBeGreaterThanOrEqual(2);
  });
});
