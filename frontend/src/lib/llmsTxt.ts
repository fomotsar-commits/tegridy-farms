/**
 * llms.txt: WHAT AN AI ASSISTANT MAY SAY ABOUT THIS VENUE, IN THE VENUE'S OWN WORDS.
 *
 * Adopted from a holder's notes and ruled in by the island (answer ten, §2). An
 * assistant is now a front door: a stranger asks it what this venue is before they
 * load it. So /llms.txt is served as a static file, generated at build by
 * scripts/llms-txt.mjs, which loads THIS module and writes its output to dist.
 *
 * NOTHING HERE IS TYPED THAT THE APP ALREADY KNOWS. The holder's own guide, written
 * 09-16, said an early exit costs 25%, and the BAYLA ladder's 75% made that false for
 * one rail within a day. So every number and every address below is read from the
 * constant the app itself uses, and src/lib/llmsTxt.test.ts fails the moment a
 * rendered field disagrees with its source (and, for the staking terms, with the
 * Solidity the constant mirrors).
 *
 * WHAT IT NEVER CARRIES, by the island's terms: a price, an APR, a balance, a cap,
 * instructions to the reading assistant beyond the safety facts, and any community
 * link (the owner ruled 09-17 that the old Discord invite is dead and that there
 * will never be a Telegram). ASCII only, so zero em dashes by construction.
 *
 * A PURE MODULE. collectFacts() reads the app's constants plus the address ledger
 * it is handed; renderLlmsTxt() turns facts into text. They are split so the test
 * can render SYNTHETIC facts and prove the renderer derives rather than hardcodes.
 */
import { VENUE, heatExampleLine } from './arrival';
import { BUNGALOWS, type Bungalow } from './bungalows';
import {
  SITE_URL,
  TOWELI_ADDRESS,
  TEGRIDY_STAKING_ADDRESS,
  SWAP_FEE_ROUTER_ADDRESS,
  MIN_LOCK_DURATION,
  MAX_LOCK_DURATION,
  MIN_BOOST_BPS,
  MAX_BOOST_BPS,
  JBAC_BONUS_BPS,
  EARLY_WITHDRAWAL_PENALTY_BPS,
} from './constants';
import * as ladder from './lighthouseLadder';
import * as baylaLadder from './ladder/program';
import { heatLaunchFloor } from './heat/heatGateConfig';
import { tierAtFloor } from './heat/heatOracle';
import { OPEN_DOOR_IDS } from '../components/VenueDoors';

/** The shape of frontend/scripts/addresses.json this module reads. */
export interface AddressLedger {
  [chain: string]: unknown;
}

export interface StakingTerms {
  minLockSeconds: number;
  maxLockSeconds: number;
  earlyExitBps: number;
  minBoostBps?: number;
  maxBoostBps?: number;
  bonusBps?: number;
}

export interface DoorFact {
  id: string;
  name: string;
  symbol: string;
  chain: Bungalow['chain'];
  address: string;
  open: boolean;
  stakeRail: 'ladder' | 'no-early-exit' | null;
  depositsClosed: boolean;
}

export interface LlmsFacts {
  siteUrl: string;
  description: string;
  heroLine: string;
  heatPlain: string;
  heatPerWallet: string;
  launchFloorLine: string;
  doors: DoorFact[];
  toweliStaking: StakingTerms;
  ladderStaking: StakingTerms;
  /**
   * Present only when the venue actually offers the pool: a bungalow carries a
   * `ladderPool` AND the build is pointed at a deployed program.
   */
  baylaLadderStaking: StakingTerms | null;
  /** Live contracts, confirmed against the ledger, grouped by chain. */
  contracts: { chain: string; label: string; address: string }[];
}

type LedgerEntry = { id?: string; address?: string; status?: unknown };

/** An address counts as a live contract only if the ledger says so, under its own chain. */
export function isLiveInLedger(ledger: AddressLedger, chain: string, address: string): boolean {
  const entries = ledger[chain];
  if (!Array.isArray(entries)) return false;
  return (entries as LedgerEntry[]).some(
    (e) =>
      typeof e.address === 'string' &&
      e.address.toLowerCase() === address.toLowerCase() &&
      typeof e.status === 'string' &&
      /^live\b/i.test(e.status) &&
      !/external|retired/i.test(e.status.split('.')[0] ?? ''),
  );
}

export function collectFacts(ledger: AddressLedger): LlmsFacts {
  const floor = heatLaunchFloor();
  const doors: DoorFact[] = BUNGALOWS.filter((b) => b.chain !== 'tbd' && b.address).map((b) => ({
    id: b.id,
    name: b.name,
    symbol: b.symbol,
    chain: b.chain,
    address: b.address as string,
    open: OPEN_DOOR_IDS.has(b.id),
    stakeRail: !b.stakePool ? null : b.poolKind === 'ladder' ? 'ladder' : b.chain === 'solana' ? 'no-early-exit' : null,
    depositsClosed: b.depositsClosed === true,
  }));

  const contracts: LlmsFacts['contracts'] = [];
  const add = (chain: string, label: string, address: string | undefined) => {
    if (!address || !isLiveInLedger(ledger, chain, address)) return;
    if (contracts.some((c) => c.chain === chain && c.address.toLowerCase() === address.toLowerCase())) return;
    contracts.push({ chain, label, address });
  };
  add('ethereum', 'TOWELI token', TOWELI_ADDRESS);
  add('ethereum', 'TOWELI staking (TegridyStaking)', TEGRIDY_STAKING_ADDRESS);
  add('ethereum', 'Swap fee router', SWAP_FEE_ROUTER_ADDRESS);
  for (const b of BUNGALOWS) {
    if (b.stakePool && b.chain !== 'tbd') add(b.chain, `${b.name} stake pool`, b.stakePool);
  }

  return {
    siteUrl: SITE_URL,
    description: VENUE.description,
    heroLine: VENUE.heroLine,
    heatPlain: VENUE.heatPlain,
    heatPerWallet: VENUE.heatPerWallet,
    launchFloorLine: heatExampleLine(floor, tierAtFloor(floor)),
    doors,
    toweliStaking: {
      minLockSeconds: MIN_LOCK_DURATION,
      maxLockSeconds: MAX_LOCK_DURATION,
      earlyExitBps: EARLY_WITHDRAWAL_PENALTY_BPS,
      minBoostBps: MIN_BOOST_BPS,
      maxBoostBps: MAX_BOOST_BPS,
      bonusBps: JBAC_BONUS_BPS,
    },
    ladderStaking: {
      minLockSeconds: Number(ladder.MIN_LOCK_SECS),
      maxLockSeconds: Number(ladder.MAX_LOCK_SECS),
      earlyExitBps: Number(ladder.PENALTY_BPS),
      minBoostBps: Number(ladder.MIN_BOOST_BPS),
      maxBoostBps: Number(ladder.MAX_BOOST_BPS),
    },
    // BOTH, as the app requires. The farm panel mounts the ladder card only for a
    // bungalow carrying `ladderPool`, and the card refuses to derive anything without
    // the program. An operator halfway through the ceremony (program set, pool not)
    // must not have llms.txt tell BAYLA holders the terms of a pool nobody can open.
    baylaLadderStaking: BUNGALOWS.some((b) => b.chain === 'solana' && b.ladderPool) && baylaLadder.isLadderConfigured()
      ? {
          minLockSeconds: baylaLadder.MIN_LOCK_SECS,
          maxLockSeconds: baylaLadder.MAX_LOCK_SECS,
          earlyExitBps: baylaLadder.EARLY_EXIT_PENALTY_BPS,
          minBoostBps: baylaLadder.MIN_BOOST_BPS,
          maxBoostBps: baylaLadder.MAX_BOOST_BPS,
        }
      : null,
    contracts,
  };
}

const DAY = 86_400;

/** "7 days", "4 years": whole units only, read from seconds. */
export function duration(seconds: number): string {
  if (seconds % (365 * DAY) === 0) {
    const y = seconds / (365 * DAY);
    return `${y} year${y === 1 ? '' : 's'}`;
  }
  const d = Math.round(seconds / DAY);
  return `${d} day${d === 1 ? '' : 's'}`;
}

/** 2500 -> "25%", 1234 -> "12.34%". */
export function percent(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** 4000 -> "0.4x", 40000 -> "4x". */
export function multiplier(bps: number): string {
  return `${Number((bps / 10_000).toFixed(2))}x`;
}

function terms(t: StakingTerms): string {
  const parts = [`locks from ${duration(t.minLockSeconds)} to ${duration(t.maxLockSeconds)}`];
  if (t.minBoostBps !== undefined && t.maxBoostBps !== undefined) {
    parts.push(`boost from ${multiplier(t.minBoostBps)} to ${multiplier(t.maxBoostBps)}`);
  }
  if (t.bonusBps) parts.push(`plus ${multiplier(t.bonusBps)} with a JBAC NFT`);
  parts.push(`leaving a lock early costs ${percent(t.earlyExitBps)} of the amount staked`);
  return parts.join('; ');
}

const CHAIN_NAME: Record<string, string> = { ethereum: 'Ethereum', base: 'Base', solana: 'Solana' };

export function renderLlmsTxt(f: LlmsFacts, meta: { date: string; commit?: string | null }): string {
  const out: string[] = [];
  out.push('# memetics.finance', '', `> ${f.description}`, '');

  out.push('## Held time', '');
  out.push(f.heroLine, '', f.heatPlain, '', f.heatPerWallet, '');
  out.push('Jungle Bay Island computes Heat and this venue reads it. Where the two disagree, the island is right.', '');
  out.push(f.launchFloorLine, '');

  out.push('## Read any wallet', '');
  out.push(`- ${f.siteUrl}/read/<address>: the held time of any Ethereum or Solana wallet. No wallet connection needed.`);
  out.push(`- ${f.siteUrl}/scan: holder concentration for a token. A descriptive measurement, not a verdict.`, '');

  const doorLine = (d: DoorFact) =>
    `- ${d.name} (${d.symbol}) on ${CHAIN_NAME[d.chain] ?? d.chain}: ${f.siteUrl}/${d.id} token ${d.address}`;
  out.push('## Doors', '');
  out.push('Open for business:', '');
  for (const d of f.doors.filter((x) => x.open)) out.push(doorLine(d));
  out.push('', 'Settled:', '');
  for (const d of f.doors.filter((x) => !x.open)) out.push(doorLine(d));
  out.push('');

  out.push('## Staking terms', '');
  out.push(`- TOWELI staking on Ethereum: ${terms(f.toweliStaking)}.`);
  const ladderDoors = f.doors.filter((d) => d.stakeRail === 'ladder').map((d) => d.name);
  if (ladderDoors.length > 0) {
    out.push(`- Ladder pools (${ladderDoors.join(', ')}): ${terms(f.ladderStaking)}.`);
  }
  const noExit = f.doors.filter((d) => d.stakeRail === 'no-early-exit');
  if (noExit.length > 0) {
    out.push(`- Solana pools (${noExit.map((d) => d.name).join(', ')}): a lock has no early exit at any price.`);
  }
  for (const d of f.doors.filter((x) => x.depositsClosed)) {
    out.push(`- ${d.name}: the venue is closed to new deposits into this pool.`);
  }
  if (f.baylaLadderStaking) out.push(`- BAYLA ladder on Solana: ${terms(f.baylaLadderStaking)}.`);
  out.push('');

  out.push('## Contracts', '');
  for (const chain of ['ethereum', 'base', 'solana']) {
    const rows = f.contracts.filter((c) => c.chain === chain);
    if (rows.length === 0) continue;
    out.push(`${CHAIN_NAME[chain]}:`, '');
    for (const c of rows) out.push(`- ${c.label}: ${c.address}`);
    out.push('');
  }

  out.push('## Safety facts', '');
  out.push(`- The canonical address is ${f.siteUrl}. memetic.fun redirects to it.`);
  out.push('- Every address in this file is written in full. Compare all of it against a block explorer before signing anything.');
  out.push('- Experimental protocol. Not financial advice.', '');

  out.push('## Build', '');
  out.push(`- generated ${meta.date}`);
  if (meta.commit) out.push(`- commit ${meta.commit}`);
  out.push('');
  return out.join('\n');
}
