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
import type { AlertRuleKind } from './rules';

export type AlertSourceId = 'indexer' | 'heat-oracle' | 'launch-radar' | 'explorer';

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
};

export const RULE_SOURCE: Record<AlertRuleKind, AlertSourceId> = {
  'whale-move': 'indexer',
  'lp-unlock': 'indexer',
  'deployer-reputation': 'explorer',
  'launch-live': 'launch-radar',
  'heat-tier': 'heat-oracle',
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
  return {
    indexer: {
      readable: indexerReadable,
      detail: indexerReadable ? null : (indexerConfigProblem() ?? INDEXER_UNSET_DETAIL),
    },
    // Same-origin resources on the aggregator catchall. They ship with every
    // deployment, so there is no configuration that could make them absent; a
    // failure is an outage and is reported as one at read time.
    'heat-oracle': { readable: true, detail: null },
    'launch-radar': { readable: true, detail: null },
    explorer: { readable: true, detail: null },
  };
}

export function readinessForRule(kind: AlertRuleKind): SourceReadiness {
  return sourceReadiness()[RULE_SOURCE[kind]];
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
