/**
 * llms.txt: A GENERATED FIELD THAT DISAGREES WITH ITS SOURCE FAILS HERE.
 *
 * The island's done-means for llms.txt, verbatim in spirit: "a test fails when a
 * generated field disagrees with its source constant; zero em dashes." Three kinds
 * of disagreement are covered:
 *
 *   1. RENDERING. The renderer must DERIVE percentages, multipliers and durations,
 *      never type them. Proven with synthetic facts nobody would hardcode: a 12.34%
 *      exit and a 123-degree floor.
 *   2. SOURCE. Each staking term equals the constant the app uses AND the Solidity
 *      that constant mirrors, so a stale mirror cannot publish a stale number.
 *   3. LEDGER. Every contract printed is registered LIVE under its own chain in
 *      scripts/addresses.json, which is a history ledger: registered is not wired,
 *      and a retired or third-party entry must never be offered as the venue's.
 *
 * And the island's limits: ASCII only, no community links (owner, 09-17: the old
 * Discord is dead and there will never be a Telegram), no APR, no prices.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  collectFacts,
  renderLlmsTxt,
  isLiveInLedger,
  duration,
  multiplier,
  percent,
  type AddressLedger,
  type LlmsFacts,
} from './llmsTxt';
import { VENUE, heatExampleLine } from './arrival';
import { BUNGALOWS } from './bungalows';
import { OPEN_DOOR_IDS } from '../components/VenueDoors';
import {
  SITE_URL,
  EARLY_WITHDRAWAL_PENALTY_BPS,
  MIN_BOOST_BPS,
  MAX_BOOST_BPS,
  JBAC_BONUS_BPS,
  MIN_LOCK_DURATION,
  MAX_LOCK_DURATION,
} from './constants';
import * as ladder from './lighthouseLadder';
import { heatLaunchFloor } from './heat/heatGateConfig';
import { tierAtFloor } from './heat/heatOracle';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = join(FRONTEND, '..');
const ledger = JSON.parse(readFileSync(join(FRONTEND, 'scripts', 'addresses.json'), 'utf8')) as AddressLedger;
const facts = collectFacts(ledger);
const text = renderLlmsTxt(facts, { date: '2026-09-17', commit: 'abc1234' });

/** A `uint256 public constant NAME = <expr>;` from Solidity, evaluated: `4 * 365 days`, `2_500`. */
function solConstant(sol: string, name: string): number {
  const m = new RegExp(`constant\\s+${name}\\s*=\\s*([^;]+);`).exec(sol);
  if (!m) throw new Error(`${name} is not declared in this contract`);
  const unit: Record<string, number> = { seconds: 1, minutes: 60, hours: 3600, days: 86_400 };
  return m[1]!.split('*').reduce((acc, term) => {
    const t = /^\s*([\d_]+)\s*(seconds|minutes|hours|days)?\s*$/.exec(term);
    if (!t) throw new Error(`${name}: cannot evaluate "${m[1]}"`);
    return acc * Number(t[1]!.replace(/_/g, '')) * (t[2] ? unit[t[2]]! : 1);
  }, 1);
}

/** The door ids listed between two headings of the rendered file. */
function doorIdsBetween(from: string, to: string): string[] {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start);
  expect(start, `no "${from}" heading`).toBeGreaterThan(-1);
  expect(end, `no "${to}" after "${from}"`).toBeGreaterThan(start);
  const origin = SITE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...text.slice(start, end).matchAll(new RegExp(`${origin}/([a-z0-9-]+) token `, 'g'))].map((x) => x[1]!).sort();
}

describe('llms.txt says only what the venue itself says', () => {
  it('opens as llms.txt does, in plain ASCII, with not one em dash', () => {
    expect(text.startsWith('# memetics.finance\n')).toBe(true);
    expect([...text].every((c) => c.charCodeAt(0) < 128), 'a non-ASCII character reached llms.txt').toBe(true);
    expect(text).not.toContain('—');
  });

  it('quotes the held-time sentences verbatim from the constants the page renders', () => {
    for (const sentence of [VENUE.description, VENUE.heroLine, VENUE.heatPlain, VENUE.heatPerWallet]) {
      expect(text).toContain(sentence);
    }
    const floor = heatLaunchFloor();
    expect(text).toContain(heatExampleLine(floor, tierAtFloor(floor)));
  });

  it('lists exactly the doors the hall lists as open, and every settled door with its token', () => {
    const open = facts.doors.filter((d) => d.open).map((d) => d.id).sort();
    expect(open).toEqual([...OPEN_DOOR_IDS].sort());
    for (const b of BUNGALOWS.filter((x) => x.chain !== 'tbd' && x.address)) {
      expect(text, `${b.id} is missing`).toContain(`${SITE_URL}/${b.id} token ${b.address}`);
    }
  });

  it('prints each door under the heading the hall gives it, not merely somewhere in the file', () => {
    // The facts can be right and the file still wrong: a swapped filter would tell
    // assistants the settled rooms are open for business.
    const listed = BUNGALOWS.filter((b) => b.chain !== 'tbd' && b.address);
    expect(doorIdsBetween('Open for business:', 'Settled:')).toEqual(
      listed.filter((b) => OPEN_DOOR_IDS.has(b.id)).map((b) => b.id).sort(),
    );
    expect(doorIdsBetween('Settled:', '## Staking terms')).toEqual(
      listed.filter((b) => !OPEN_DOOR_IDS.has(b.id)).map((b) => b.id).sort(),
    );
  });

  it('carries no community link, no APR and no price', () => {
    expect(text).not.toMatch(/discord|t\.me|telegram/i);
    expect(text).not.toMatch(/\bAP[RY]\b/i);
    expect(text).not.toMatch(/\$\s?\d/);
    expect(text).not.toMatch(/\d[\d,.]*\s?(ETH|WETH|SOL|USDC|USD)\b/);
  });

  // Answer eleven: "say in that file only what CI resolves." It used to say "memetic.fun
  // redirects to it", an alias nothing here resolves. So no host but the venue's own is
  // named at all, as a URL or as a bare domain.
  it('names no host but the venue’s own, not even as a bare domain', () => {
    const host = new URL(SITE_URL).host;
    const named: string[] = text.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:fun|finance|com|xyz|io|wtf|app|gg|me|org|net)\b/gi) ?? [];
    expect(named.filter((h) => h.toLowerCase() !== host)).toEqual([]);
  });

  it('points only at the venue’s own origin', () => {
    for (const url of text.match(/https?:\/\/[^\s)]+/g) ?? []) {
      expect(url.startsWith(SITE_URL), url).toBe(true);
    }
  });
});

describe('every generated number equals its source', () => {
  it('TOWELI staking: every term is the constant, and the Solidity it mirrors', () => {
    const sol = readFileSync(join(REPO, 'contracts', 'src', 'TegridyStaking.sol'), 'utf8');
    const terms = {
      minLockSeconds: [MIN_LOCK_DURATION, solConstant(sol, 'MIN_LOCK_DURATION')],
      maxLockSeconds: [MAX_LOCK_DURATION, solConstant(sol, 'MAX_LOCK_DURATION')],
      earlyExitBps: [EARLY_WITHDRAWAL_PENALTY_BPS, solConstant(sol, 'EARLY_WITHDRAWAL_PENALTY_BPS')],
      minBoostBps: [MIN_BOOST_BPS, solConstant(sol, 'MIN_BOOST_BPS')],
      maxBoostBps: [MAX_BOOST_BPS, solConstant(sol, 'MAX_BOOST_BPS')],
      bonusBps: [JBAC_BONUS_BPS, solConstant(sol, 'JBAC_BONUS_BPS')],
    } as const;
    for (const [field, [constant, onChain]] of Object.entries(terms)) {
      expect(constant, `${field}: the app's constant disagrees with TegridyStaking.sol`).toBe(onChain);
      expect(facts.toweliStaking[field as keyof typeof terms], `${field} is not read from its constant`).toBe(constant);
    }
    expect(text).toContain(
      `- TOWELI staking on Ethereum: locks from ${duration(MIN_LOCK_DURATION)} to ${duration(MAX_LOCK_DURATION)}; ` +
        `boost from ${multiplier(MIN_BOOST_BPS)} to ${multiplier(MAX_BOOST_BPS)}; plus ${multiplier(JBAC_BONUS_BPS)} with a JBAC NFT; ` +
        `leaving a lock early costs ${percent(EARLY_WITHDRAWAL_PENALTY_BPS)} of the amount staked.`,
    );
  });

  it('the ladder pools: every term is the constant, and the Solidity it mirrors', () => {
    const sol = readFileSync(join(REPO, 'contracts', 'src', 'LighthouseLadder.sol'), 'utf8');
    const terms = {
      minLockSeconds: [Number(ladder.MIN_LOCK_SECS), solConstant(sol, 'MIN_LOCK_DURATION')],
      maxLockSeconds: [Number(ladder.MAX_LOCK_SECS), solConstant(sol, 'MAX_LOCK_DURATION')],
      earlyExitBps: [Number(ladder.PENALTY_BPS), solConstant(sol, 'EARLY_EXIT_PENALTY_BPS')],
      minBoostBps: [Number(ladder.MIN_BOOST_BPS), solConstant(sol, 'MIN_BOOST_BPS')],
      maxBoostBps: [Number(ladder.MAX_BOOST_BPS), solConstant(sol, 'MAX_BOOST_BPS')],
    } as const;
    for (const [field, [constant, onChain]] of Object.entries(terms)) {
      expect(constant, `${field}: lighthouseLadder.ts disagrees with LighthouseLadder.sol`).toBe(onChain);
      expect(facts.ladderStaking[field as keyof typeof terms], `${field} is not read from its constant`).toBe(constant);
    }
    // The rendered line, read on its own: these numbers happen to equal TOWELI's, so a
    // check anywhere in the file would pass on the TOWELI line. The ladder pools carry
    // no JBAC bonus, and saying they do would be false on every one of them.
    const line = text.split('\n').find((l) => l.startsWith('- Ladder pools ('));
    expect(line, 'the ladder pools line is missing').toBeDefined();
    expect(line).toContain(
      `: locks from ${duration(terms.minLockSeconds[0])} to ${duration(terms.maxLockSeconds[0])}; ` +
        `boost from ${multiplier(terms.minBoostBps[0])} to ${multiplier(terms.maxBoostBps[0])}; ` +
        `leaving a lock early costs ${percent(terms.earlyExitBps[0])} of the amount staked.`,
    );
    expect(line).not.toContain('JBAC');
  });

  it('DERIVES what it prints: a synthetic 12.34% exit and 123-degree floor render as such', () => {
    // The mutation the holder's own guide suffered: a typed "25%" that a later
    // change made false. Nothing here can render 12.34% unless it is computed.
    const synthetic: LlmsFacts = {
      ...facts,
      launchFloorLine: heatExampleLine(123, tierAtFloor(123)),
      toweliStaking: { ...facts.toweliStaking, earlyExitBps: 1234, minLockSeconds: 3 * 86_400, maxLockSeconds: 2 * 365 * 86_400 },
      ladderStaking: { ...facts.ladderStaking, earlyExitBps: 4321, minBoostBps: 2_500, maxBoostBps: 55_000 },
    };
    const out = renderLlmsTxt(synthetic, { date: '2026-09-17' });
    const toweliLine = out.split('\n').find((l) => l.startsWith('- TOWELI staking'));
    const ladderLine = out.split('\n').find((l) => l.startsWith('- Ladder pools ('));
    expect(toweliLine).toContain('leaving a lock early costs 12.34% of the amount staked');
    expect(toweliLine).toContain('locks from 3 days to 2 years');
    // Each line from its own terms: the ladder's synthetic numbers, never TOWELI's.
    expect(ladderLine).toContain('boost from 0.25x to 5.5x; leaving a lock early costs 43.21% of the amount staked');
    expect(out).toContain('The launch door opens at 123 degrees.');
    expect(out).not.toContain('commit ');
  });

  it('prints the BAYLA ladder terms only when the venue offers the pool: program AND pool', async () => {
    // No mainnet bayla-ladder exists; publishing its 75% unconditionally would tell
    // BAYLA holders the rules of a pool they cannot use. The app needs BOTH variables
    // to mount the card, so an operator halfway through the ceremony, program set and
    // pool not, must publish nothing either.
    const build = async (env: Record<string, string>) => {
      vi.resetModules();
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      const mod = await import('./llmsTxt');
      const f = mod.collectFacts(ledger);
      return { f, out: mod.renderLlmsTxt(f, { date: '2026-09-17' }) };
    };
    const PROGRAM = 'LadrProg1111111111111111111111111111111111';
    const POOL = 'LadrPoo11111111111111111111111111111111111';

    const neither = await build({ VITE_BAYLA_LADDER_PROGRAM: '', VITE_BAYLA_LADDER_POOL: '' });
    expect(neither.f.baylaLadderStaking).toBeNull();
    expect(neither.out).not.toContain('BAYLA ladder');

    const programOnly = await build({ VITE_BAYLA_LADDER_PROGRAM: PROGRAM, VITE_BAYLA_LADDER_POOL: '' });
    expect(programOnly.f.baylaLadderStaking, 'published a ladder the app does not mount').toBeNull();
    expect(programOnly.out).not.toContain('BAYLA ladder');

    const both = await build({ VITE_BAYLA_LADDER_PROGRAM: PROGRAM, VITE_BAYLA_LADDER_POOL: POOL });
    expect(both.f.baylaLadderStaking).not.toBeNull();
    const bayla = await import('./ladder/program');
    // NOT A FLAT RATE (trunk #592, 2026-09-17): veYFI's schedule, the time left on the
    // lock over four years, capped at 75%. A flat "costs 75%" would overstate every exit
    // with under three years left, so the line names the schedule, read from the program.
    const line = both.out.split('\n').find((l) => l.startsWith('- BAYLA ladder on Solana: '));
    expect(line).toBe(
      `- BAYLA ladder on Solana: locks from ${duration(bayla.MIN_LOCK_SECS)} to ${duration(bayla.MAX_LOCK_SECS)}; ` +
        `boost from ${multiplier(bayla.MIN_BOOST_BPS)} to ${multiplier(bayla.MAX_BOOST_BPS)}; ` +
        `leaving a lock early costs the time left on it over ${duration(bayla.MAX_LOCK_SECS)} as a share of the amount staked, ` +
        `capped at ${percent(bayla.MAX_EARLY_EXIT_PENALTY_BPS)}.`,
    );
    // And the sentence is what the program's own arithmetic charges, not a paraphrase.
    const principal = 1_000_000n;
    const now = 1_800_000_000n;
    const fourYears = BigInt(bayla.MAX_LOCK_SECS);
    expect(bayla.penaltyFor(principal, now + fourYears / 4n, now), 'one year left of four').toBe(250_000n);
    expect(bayla.penaltyFor(principal, now + fourYears, now), 'four years left: the cap').toBe(750_000n);
    expect(bayla.penaltyFor(principal, now, now), 'matured').toBe(0n);
  }, 30_000);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('every contract printed is a live entry in the ledger', () => {
  it('under its own chain, and never a retired or third-party entry', () => {
    expect(facts.contracts.length).toBeGreaterThan(0);
    for (const c of facts.contracts) {
      expect(isLiveInLedger(ledger, c.chain, c.address), `${c.label} ${c.address}`).toBe(true);
      expect(text).toContain(`${c.label}: ${c.address}`);
    }
  });

  it('refuses an address the ledger calls retired or external', () => {
    const fake: AddressLedger = {
      ethereum: [
        { id: 'old', address: '0x1111111111111111111111111111111111111111', status: 'retired' },
        { id: 'ext', address: '0x2222222222222222222222222222222222222222', status: 'live, external' },
        { id: 'ok', address: '0x3333333333333333333333333333333333333333', status: 'live' },
      ],
    };
    expect(isLiveInLedger(fake, 'ethereum', '0x1111111111111111111111111111111111111111')).toBe(false);
    expect(isLiveInLedger(fake, 'ethereum', '0x2222222222222222222222222222222222222222')).toBe(false);
    expect(isLiveInLedger(fake, 'ethereum', '0x3333333333333333333333333333333333333333')).toBe(true);
    expect(isLiveInLedger(fake, 'base', '0x3333333333333333333333333333333333333333')).toBe(false);
  });
});
