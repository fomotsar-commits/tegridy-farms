import { useCallback, useEffect, useState } from 'react';
import {
  parseCreatedContracts,
  toBaselines,
  isDeployerAddress,
  type CreatedContract,
} from '../lib/detection/deployerLaunches';
import {
  classifyLaunch,
  summarizeDeployer,
  type DeployerReputation,
  type LaunchInput,
  type MarketRead,
} from '../lib/detection/deployerReputation';
import { fetchLauncherOutcomes } from '../lib/launcher/outcomesClient';
import type { OutcomeRecord } from '../lib/launcher/outcomes';

// Drives the Deployer Reputation Graph: given a deployer address it discovers the
// tokens the address deployed DIRECTLY (Etherscan txlist → contract creations),
// enriches each with a CURRENT live-pool read (the launcher-outcomes path), runs
// the pure reputation core, and exposes a small self-gating state machine.
//
// SELF-GATING (honest-framing brand): every non-success path is explicit.
//   - malformed address        → `invalid`
//   - no direct creations found → `empty`
//   - explorer/network failure  → `error`
// Enrichment failure does NOT fail the whole read: discovery already succeeded, so
// the tokens are still shown with their market state marked `unobserved` (unknown),
// never fabricated. Nothing here invents a number to fill a gap.
//
// ZERO NEW SERVERLESS FUNCTIONS: reuses /api/etherscan (discovery) and
// /api/aggregator?resource=launcher-outcomes (enrichment) — both already deployed.

export type DeployerStatus =
  | 'idle' // no address entered
  | 'invalid' // not a valid EVM address
  | 'loading'
  | 'success'
  | 'empty' // no direct contract-creations found for this address
  | 'error'; // explorer / network failure

export interface DeployerReputationState {
  status: DeployerStatus;
  reputation: DeployerReputation | null;
  errorMessage: string | null;
  /** Re-run the current read. */
  reload: () => void;
}

/** Max direct-creations to enrich in one pass — matches the enrichment MAX_BASELINES. */
const MAX_CREATIONS = 50;

/** Same-origin explorer proxy (server-side Etherscan key). */
const ETHERSCAN_PATH = '/api/etherscan';

interface EtherscanEnvelope {
  status?: string;
  message?: string;
  result?: unknown;
}

/**
 * PURE: does this 200-body envelope represent a FAILED READ? Returns the message to
 * show, or null when the envelope is a real answer.
 *
 * Etherscan signals errors inside a 200 body, and it does NOT put the reason in
 * `message`. A failed call is
 * `{"status":"0","message":"NOTOK","result":"Missing/Invalid API Key"}` — this repo
 * documents that exact body at api/etherscan.js:14, and it reproduces live today.
 * A rate-limit is the same envelope with "Max rate limit reached" in `result`.
 *
 * So the previous `message.includes('rate limit')` test caught NEITHER: "notok"
 * contains no "rate limit", so the string `result` fell through to
 * `parseCreatedContracts`, which returns `[]` for a non-array, and the page rendered
 * "No direct contract-creation transactions were found for this address" — a claim
 * about somebody's address manufactured from our own missing or throttled API key.
 *
 * The SHAPE is the reliable test, not the prose. Etherscan's genuine empty answer is
 * `{status:'0', message:'No transactions found', result:[]}` — an ARRAY — so that
 * stays the real answer it is regardless of wording. Extracted and exported so the
 * distinction is unit-testable rather than pinned only inside an effect.
 */
export function explorerEnvelopeFailure(envelope: EtherscanEnvelope): string | null {
  if (envelope.status !== '0' || Array.isArray(envelope.result)) return null;
  const msg = typeof envelope.message === 'string' ? envelope.message.toLowerCase() : '';
  const reason = typeof envelope.result === 'string' ? envelope.result.toLowerCase() : '';
  return msg.includes('rate limit') || reason.includes('rate limit')
    ? 'The explorer is rate-limiting right now — try again in a moment.'
    : 'The transaction explorer could not complete this read, so nothing was concluded about this address. Try again in a moment.';
}

async function fetchTxList(address: string, signal: AbortSignal): Promise<EtherscanEnvelope> {
  // NOTE: startblock/endblock are deliberately OMITTED. The /api/etherscan proxy
  // rejects a block range wider than 10k, and Etherscan defaults to the full
  // history (0..latest) when they are absent — which is exactly what we want.
  const url = `${ETHERSCAN_PATH}?module=account&action=txlist&address=${encodeURIComponent(
    address.toLowerCase(),
  )}&sort=desc`;
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal });
  if (res.status === 429) {
    throw new Error('rate-limited');
  }
  if (!res.ok) {
    throw new Error(`explorer-${res.status}`);
  }
  return (await res.json()) as EtherscanEnvelope;
}

/** Build a per-token market read from the enrichment outcomes map (null when absent). */
export function marketFor(token: string, outcomes: Record<string, OutcomeRecord>): MarketRead | null {
  const rec = outcomes[token.toLowerCase()];
  if (!rec) return null;
  // The upstream could not be read (429 / error / unparseable — see
  // OutcomeRecord.marketReadFailed). Returning null lands classifyLaunch on
  // `unobserved` — "State unknown — this is not a signal about the token" — which is
  // the status the core ships for exactly this and which was unreachable while the
  // server had no way to say it. Anything else renders our own throttling as a
  // finding about somebody's token.
  if (rec.marketReadFailed === true) return null;
  return {
    // `marketObserved` undefined means "observed" for back-compat records; here every
    // record is freshly built so it is always a real boolean, but default to false so
    // a malformed record degrades to `no-market`, never a fabricated active pool.
    observed: rec.marketObserved === true,
    liquidityEth: typeof rec.liquidityEth === 'number' ? rec.liquidityEth : 0,
    priceEth: typeof rec.priceEth === 'number' ? rec.priceEth : 0,
  };
}

/** Newest creator-activity timestamp across the outcome records (all share one creator). */
function latestActivity(outcomes: Record<string, OutcomeRecord>): number | null {
  let latest: number | null = null;
  for (const rec of Object.values(outcomes)) {
    const ts = rec?.lastTeamActivityAt;
    if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
      if (latest == null || ts > latest) latest = ts;
    }
  }
  return latest;
}

async function buildReputation(
  deployer: string,
  created: CreatedContract[],
  truncated: boolean,
  signal: AbortSignal,
): Promise<DeployerReputation> {
  const baselines = toBaselines(created, deployer);

  // Enrichment is best-effort: if it fails, every token degrades to `unobserved`
  // (honest unknown) and discovery data still renders.
  let outcomes: Record<string, OutcomeRecord> = {};
  try {
    const resp = await fetchLauncherOutcomes({ baselines, signal });
    outcomes = resp.outcomes ?? {};
  } catch {
    outcomes = {};
  }

  const observedAt = Math.floor(Date.now() / 1000);
  const trajectories = created.map((c) => {
    const input: LaunchInput = {
      token: c.address,
      createdAt: c.createdAt,
      txHash: c.txHash,
      market: marketFor(c.address, outcomes),
    };
    return classifyLaunch(input, observedAt);
  });

  return summarizeDeployer(trajectories, {
    deployer,
    observedAt,
    truncated,
    lastActivityAt: latestActivity(outcomes),
    holderCountsAvailable: false, // Etherscan Pro not wired — disclosed, never faked.
  });
}

export function useDeployerReputation(address: string): DeployerReputationState {
  const trimmed = (address ?? '').trim();
  const valid = isDeployerAddress(trimmed);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const [state, setState] = useState<Omit<DeployerReputationState, 'reload'>>({
    status: 'idle',
    reputation: null,
    errorMessage: null,
  });

  useEffect(() => {
    if (!trimmed) {
      setState({ status: 'idle', reputation: null, errorMessage: null });
      return;
    }
    if (!valid) {
      setState({
        status: 'invalid',
        reputation: null,
        errorMessage: 'That does not look like an Ethereum address (0x followed by 40 hex characters).',
      });
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setState({ status: 'loading', reputation: null, errorMessage: null });

    (async () => {
      let envelope: EtherscanEnvelope;
      try {
        envelope = await fetchTxList(trimmed, controller.signal);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        const msg =
          err instanceof Error && err.message === 'rate-limited'
            ? 'Too many reads right now — give the explorer a moment and try again.'
            : 'Could not reach the transaction explorer. This is a network hiccup, not a signal about the address.';
        setState({ status: 'error', reputation: null, errorMessage: msg });
        return;
      }

      const failure = explorerEnvelopeFailure(envelope);
      if (failure) {
        setState({ status: 'error', reputation: null, errorMessage: failure });
        return;
      }

      const { created, truncated } = parseCreatedContracts(envelope.result, {
        maxCreations: MAX_CREATIONS,
      });

      if (created.length === 0) {
        setState({
          status: 'empty',
          reputation: null,
          errorMessage:
            'No direct contract-creation transactions were found for this address. It may only have launched tokens through a factory (invisible without an event indexer), or it may not be a deployer at all.',
        });
        return;
      }

      let reputation: DeployerReputation;
      try {
        reputation = await buildReputation(trimmed, created, truncated, controller.signal);
      } catch {
        if (cancelled || controller.signal.aborted) return;
        setState({
          status: 'error',
          reputation: null,
          errorMessage: 'Something went wrong assembling the reputation read. Try again shortly.',
        });
        return;
      }

      if (cancelled || controller.signal.aborted) return;
      setState({ status: 'success', reputation, errorMessage: null });
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [trimmed, valid, reloadKey]);

  return { ...state, reload };
}
