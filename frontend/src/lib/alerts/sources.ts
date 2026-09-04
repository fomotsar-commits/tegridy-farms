// Which source answers which rule, and whether this deployment can ask it at all.
//
// The distinction this file exists to hold: WIRED is not UP. `readable: true`
// means a request would be sent to something that exists — it says nothing about
// whether that something answers. A read that is attempted and fails becomes an
// `unavailable` SourceReading at read time (readers.ts), and both paths land in
// the same place: `cannot-evaluate`, never `quiet`.
//
// The `operatorStep` on each source is the answer to "why is this rule dark?"
// printed for the person who can fix it. It is rendered verbatim in the UI, so a
// user asking why nothing fires and an operator asking what is left to configure
// read the same sentence.

import { indexerConfigProblem, isIndexerConfigured } from '../indexer/client';
import { TEGRIDY_NFT_LENDING_ADDRESS, isDeployed } from '../constants';
import { ALERT_RULE_KINDS, type AlertRuleKind } from './rules';

export type AlertSourceId =
  | 'indexer'
  | 'heat-oracle'
  | 'launch-radar'
  | 'explorer'
  | 'venue-lending'
  | 'gecko-pool';

export interface AlertSource {
  id: AlertSourceId;
  label: string;
  /** Who supplies the fact. Every fired alert carries this. */
  attribution: string;
  /** What has to happen for this source to become readable. */
  operatorStep: string;
}

export const ALERT_SOURCES: Record<AlertSourceId, AlertSource> = {
  indexer: {
    id: 'indexer',
    label: 'Ponder indexer',
    attribution: 'the venue’s own Ponder indexer',
    operatorStep:
      'Deploy the indexer (indexer/DEPLOY.md) and set VITE_INDEXER_URL to its public origin. Until then nothing reads indexed transfers or lock events.',
  },
  'heat-oracle': {
    id: 'heat-oracle',
    label: 'Jungle Bay Island held-time oracle',
    attribution: 'Jungle Bay Island’s held-time oracle (memetics.wtf)',
    operatorStep:
      'No operator step — this is read through /api/aggregator?resource=heat. When it is unreachable the reading is refused rather than guessed.',
  },
  'launch-radar': {
    id: 'launch-radar',
    label: 'Market-wide new-pool feed',
    attribution: 'GeckoTerminal new_pools, market-wide',
    operatorStep:
      'No operator step — this is read through /api/aggregator?resource=launch-radar. It covers the whole market, not only launches on this rail.',
  },
  explorer: {
    id: 'explorer',
    label: 'Block explorer + live pool reads',
    attribution: 'Etherscan contract-creation history enriched with current pool state',
    operatorStep:
      'Set ETHERSCAN_API_KEY on the deployment so /api/etherscan can answer. Without it the deployer’s creation history cannot be discovered.',
  },
  'venue-lending': {
    id: 'venue-lending',
    label: 'Venue lending contracts (direct reads)',
    attribution: 'direct reads of the venue’s own lending contracts',
    operatorStep:
      'No operator step — loans are read straight from the chain over this app’s RPC. Note the scope this buys: the read happens in the browser tab, so a rule of this kind is evaluated only while the page is open. Nothing watches a deadline overnight.',
  },
  'gecko-pool': {
    id: 'gecko-pool',
    label: 'GeckoTerminal pool feed',
    attribution: 'GeckoTerminal’s pool quote and recent-trades feed',
    operatorStep:
      'No operator step — read straight from api.geckoterminal.com, which this site’s connect-src already allows. It is keyless and rate-limited, so this page holds at most 10 rules over at most 5 pools and reads each pool once a minute; a failure is an outage and is reported as one at read time.',
  },
};

export const RULE_SOURCE: Record<AlertRuleKind, AlertSourceId> = {
  'whale-move': 'indexer',
  'lp-unlock': 'indexer',
  'deployer-reputation': 'explorer',
  'launch-live': 'launch-radar',
  'heat-tier': 'heat-oracle',
  'loan-deadline': 'venue-lending',
  'pool-price-above': 'gecko-pool',
  'pool-price-below': 'gecko-pool',
  'pool-large-trade': 'gecko-pool',
};

export interface SourceReadiness {
  /** A request would go somewhere real. NOT a claim that it answers. */
  readable: boolean;
  /** Non-null exactly when `readable` is false. Plain language, rendered as-is. */
  detail: string | null;
}

const INDEXER_UNSET_DETAIL =
  'This deployment has no indexer configured, so indexed transfers and lock events cannot be read. Rules that need them cannot be evaluated — that is not the same as there being nothing to report.';

/**
 * Read the live config. A function, not a module constant, so nothing snapshots
 * an env value at import time and so a test can stub it — same rule as
 * heatGateConfig.ts and indexer/client.ts.
 */
export function sourceReadiness(): Record<AlertSourceId, SourceReadiness> {
  const indexerReadable = isIndexerConfigured();
  const lendingDeployed = isDeployed(TEGRIDY_NFT_LENDING_ADDRESS);
  return {
    indexer: {
      readable: indexerReadable,
      detail: indexerReadable ? null : (indexerConfigProblem() ?? INDEXER_UNSET_DETAIL),
    },
    // Deployed is the whole gate here: the contract is read directly, so there is
    // no service to configure. A failed RPC read is an outage and is reported as
    // one at read time, exactly like the same-origin sources below.
    'venue-lending': {
      readable: lendingDeployed,
      detail: lendingDeployed
        ? null
        : 'The venue’s lending contract is not deployed on this network, so there are no loans to read and no deadline to watch.',
    },
    // Same-origin resources on the aggregator catchall. They ship with every
    // deployment, so there is no configuration that could make them absent; a
    // failure is an outage and is reported as one at read time.
    'heat-oracle': { readable: true, detail: null },
    'launch-radar': { readable: true, detail: null },
    explorer: { readable: true, detail: null },
    // Third-party, keyless, and reachable from the browser under the CSP this
    // site already ships (connect-src includes api.geckoterminal.com). There is
    // nothing an operator could set, so `readable` is unconditional and a
    // throttle or an outage is reported at read time like the sources above.
    'gecko-pool': { readable: true, detail: null },
  };
}

export function readinessForRule(kind: AlertRuleKind): SourceReadiness {
  return sourceReadiness()[RULE_SOURCE[kind]];
}

/**
 * The kinds whose source this deployment could actually ask, right now.
 *
 * Used by the builder to SPLIT its kind list rather than to shorten it: a kind
 * whose source is dark is still offerable — the rule is real and starts
 * evaluating the moment the source is wired — but it is grouped and labelled as
 * unreadable at the moment of choosing, not discovered later as silence.
 */
export function evaluableRuleKinds(): AlertRuleKind[] {
  const readiness = sourceReadiness();
  return ALERT_RULE_KINDS.filter((kind) => readiness[RULE_SOURCE[kind]].readable);
}

/** Source ids no rule of any listed kind could be evaluated against right now. */
export function darkSources(kinds: readonly AlertRuleKind[]): AlertSourceId[] {
  const readiness = sourceReadiness();
  const out = new Set<AlertSourceId>();
  for (const kind of kinds) {
    const id = RULE_SOURCE[kind];
    if (!readiness[id].readable) out.add(id);
  }
  return [...out];
}
