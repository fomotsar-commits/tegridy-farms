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
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { collectFacts, renderLlmsTxt, isLiveInLedger, type AddressLedger, type LlmsFacts } from './llmsTxt';
import { VENUE, heatExampleLine } from './arrival';
import { BUNGALOWS } from './bungalows';
import { OPEN_DOOR_IDS } from '../components/VenueDoors';
import { SITE_URL, EARLY_WITHDRAWAL_PENALTY_BPS, MIN_BOOST_BPS, MAX_BOOST_BPS, JBAC_BONUS_BPS } from './constants';
import { PENALTY_BPS } from './lighthouseLadder';
import { heatLaunchFloor } from './heat/heatGateConfig';
import { tierAtFloor } from './heat/heatOracle';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO = join(FRONTEND, '..');
const ledger = JSON.parse(readFileSync(join(FRONTEND, 'scripts', 'addresses.json'), 'utf8')) as AddressLedger;
const facts = collectFacts(ledger);
const text = renderLlmsTxt(facts, { date: '2026-09-17', commit: 'abc1234' });

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

  it('carries no community link, no APR and no price', () => {
    expect(text).not.toMatch(/discord|t\.me|telegram/i);
    expect(text).not.toMatch(/\bAP[RY]\b/i);
    expect(text).not.toMatch(/\$\s?\d/);
    expect(text).not.toMatch(/\d[\d,.]*\s?(ETH|WETH|SOL|USDC|USD)\b/);
  });

  it('points only at the venue’s own origin', () => {
    for (const url of text.match(/https?:\/\/[^\s)]+/g) ?? []) {
      expect(url.startsWith(SITE_URL), url).toBe(true);
    }
  });
});

describe('every generated number equals its source', () => {
  it('TOWELI staking: the constant, and the Solidity it mirrors', () => {
    const sol = readFileSync(join(REPO, 'contracts', 'src', 'TegridyStaking.sol'), 'utf8');
    const onChain = Number(/EARLY_WITHDRAWAL_PENALTY_BPS\s*=\s*([\d_]+)/.exec(sol)![1]!.replace(/_/g, ''));
    expect(EARLY_WITHDRAWAL_PENALTY_BPS).toBe(onChain);
    expect(facts.toweliStaking.earlyExitBps).toBe(EARLY_WITHDRAWAL_PENALTY_BPS);
    expect(text).toContain(`leaving a lock early costs ${EARLY_WITHDRAWAL_PENALTY_BPS / 100}% of the amount staked`);
    expect(text).toContain(`boost from ${MIN_BOOST_BPS / 10_000}x to ${MAX_BOOST_BPS / 10_000}x`);
    expect(text).toContain(`plus ${JBAC_BONUS_BPS / 10_000}x with a JBAC NFT`);
  });

  it('the ladder pools: the constant, and the Solidity it mirrors', () => {
    const sol = readFileSync(join(REPO, 'contracts', 'src', 'LighthouseLadder.sol'), 'utf8');
    const onChain = Number(/EARLY_EXIT_PENALTY_BPS\s*=\s*([\d_]+)/.exec(sol)![1]!.replace(/_/g, ''));
    expect(Number(PENALTY_BPS)).toBe(onChain);
    expect(facts.ladderStaking.earlyExitBps).toBe(Number(PENALTY_BPS));
  });

  it('DERIVES what it prints: a synthetic 12.34% exit and 123-degree floor render as such', () => {
    // The mutation the holder's own guide suffered: a typed "25%" that a later
    // change made false. Nothing here can render 12.34% unless it is computed.
    const synthetic: LlmsFacts = {
      ...facts,
      launchFloorLine: heatExampleLine(123, tierAtFloor(123)),
      toweliStaking: { ...facts.toweliStaking, earlyExitBps: 1234, minLockSeconds: 3 * 86_400, maxLockSeconds: 2 * 365 * 86_400 },
    };
    const out = renderLlmsTxt(synthetic, { date: '2026-09-17' });
    expect(out).toContain('leaving a lock early costs 12.34% of the amount staked');
    expect(out).toContain('locks from 3 days to 2 years');
    expect(out).toContain('The launch door opens at 123 degrees.');
    expect(out).not.toContain('commit ');
  });

  it('prints the BAYLA ladder terms only when a deployed program is configured', () => {
    // No mainnet bayla-ladder exists; publishing its 75% unconditionally would tell
    // BAYLA holders the rules of a pool they cannot use.
    expect(facts.baylaLadderStaking === null).toBe(!import.meta.env.VITE_BAYLA_LADDER_PROGRAM);
    if (facts.baylaLadderStaking === null) expect(text).not.toContain('BAYLA ladder');
  });
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
