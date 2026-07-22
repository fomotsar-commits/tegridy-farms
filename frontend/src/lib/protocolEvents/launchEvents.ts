// Pure mapper: graded-launch outcomes → proof-of-life pulse items.
//
// A "graded" launch is one that met a STRUCTURAL tier bar (flagship / listable) — see
// factSheet.ts / gate.ts. Tier is a structural gate, NOT a quality rating, so the copy
// stays descriptive ("met the flagship structural bar"), never an endorsement.
//
// HONEST-FRAMING + SELF-GATING: a launch appears ONLY because a real OutcomeRecord
// exists for it. No record → no item. Tier 'none' (no structural bar met) is excluded
// so the feed never implies a grade a launch didn't earn. Every value shown is read
// from the record; nothing is fabricated.
//
// DATA-SOURCE REALITY (documented, not worked around): the launcher-outcomes endpoint
// only ENRICHES a consumed launch list — it does not discover launches, and no live
// discovery feed for OUR launches is wired yet (none have graduated; the Ponder index
// is not deployed). So in production this mapper is fed an empty `outcomes` map and
// returns [] — correct self-gating. It lights up the moment a real graded-launch feed
// is passed in (see useProtocolEvents.ts + the blocker in the build report).

import type { Address } from 'viem';
import type { LaunchTier } from '../launcher/factSheet';
import type { OutcomeRecord } from '../launcher/outcomes';
import type { LauncherOutcomesResponse } from '../launcher/outcomesClient';
import type { PulseItem } from './types';

export interface LaunchEventOptions {
  /** Only surface launches graduated at/after this unix-seconds cutoff. 0 = no cutoff. */
  sinceTs?: number;
  /** Etherscan token URL builder (injected for testability). */
  etherscanTokenUrl?: (token: Address) => string;
}

const TIER_LABEL: Record<Exclude<LaunchTier, 'none'>, string> = {
  flagship: 'Flagship',
  listable: 'Listable',
};

function defaultEtherscanTokenUrl(token: Address): string {
  return `https://etherscan.io/token/${token}`;
}

/** Trim a non-negative ETH number to a compact string, no trailing-zero noise. */
function ethNumStr(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const s = n < 1 ? n.toFixed(4) : n.toFixed(3);
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Map a launcher-outcomes response to graded-launch pulse items. Pure and total:
 * never throws, never emits a launch that isn't structurally graded, never invents a
 * value. Returns newest-graduation-first (the merge step re-sorts across all streams).
 */
export function launchOutcomesToEvents(
  resp: LauncherOutcomesResponse | null | undefined,
  opts: LaunchEventOptions = {},
): PulseItem[] {
  const outcomes = resp?.outcomes;
  if (!outcomes || typeof outcomes !== 'object') return [];

  const sinceTs = typeof opts.sinceTs === 'number' && opts.sinceTs > 0 ? opts.sinceTs : 0;
  const urlFor = opts.etherscanTokenUrl ?? defaultEtherscanTokenUrl;

  const items: PulseItem[] = [];
  for (const rec of Object.values(outcomes) as OutcomeRecord[]) {
    if (!rec || typeof rec !== 'object') continue;
    const tier = rec.tier;
    if (tier !== 'flagship' && tier !== 'listable') continue; // only GRADED launches.

    const launchedAt =
      typeof rec.launchedAt === 'number' && Number.isFinite(rec.launchedAt) && rec.launchedAt > 0
        ? Math.floor(rec.launchedAt)
        : 0;
    if (launchedAt === 0) continue; // no honest timestamp → drop rather than guess.
    if (sinceTs && launchedAt < sinceTs) continue;

    const label = TIER_LABEL[tier];
    const gradLiq =
      typeof rec.launchLiquidityEth === 'number' && rec.launchLiquidityEth > 0
        ? rec.launchLiquidityEth
        : 0;
    const holders =
      typeof rec.holderCount === 'number' && rec.holderCount > 0 ? Math.floor(rec.holderCount) : 0;

    const parts: string[] = [`Met the ${label.toLowerCase()} structural bar`];
    if (gradLiq > 0) parts.push(`${ethNumStr(gradLiq)} ETH liquidity at graduation`);
    if (holders > 0) parts.push(`${holders.toLocaleString()} holders`);

    items.push({
      id: `launch:${rec.token}:${launchedAt}`,
      kind: 'launch',
      usd: 0,
      actor: '',
      txHash: '',
      ts: launchedAt,
      whale: tier === 'flagship',
      title: `${label} launch graduated`,
      detail: parts.join(' · '),
      href: urlFor(rec.token),
    });
  }

  items.sort((a, b) => b.ts - a.ts);
  return items;
}
