// DEEP LINKS INTO /chart, resolved before anything is fetched. Pure.
//
// `?network=`, `?pool=` and `?tf=` arrive from whoever wrote the link, which on
// a public venue means "from an attacker". The rule here is that a URL
// parameter never becomes part of an outbound URL: it is matched against a
// CLOSED SET first — the three network slugs, the registry's own pools, the
// five timeframe ids — and what the page then uses is the matched registry
// object, not the caller's string. A pool value shaped like `..%2F..%2Fsearch`
// therefore produces zero fetches and appears in no anchor: it never becomes a
// market, so there is nothing to build a URL out of.
//
// AND IT IS SAID OUT LOUD. Silent coercion is the other half of the bug: a link
// that asked for a pool this page does not list and quietly got TOWELI's chart
// instead would have the reader looking at one pool believing it is another.
// Every substitution returns a refusal sentence that the page renders.
//
// The refusal sentences deliberately do NOT quote the offending value back.
// Reflecting attacker-chosen text into the page is how a refusal becomes the
// injection's delivery mechanism, and the reader does not need the string
// echoed — it is in their address bar.

import { isGeckoNetwork, type GeckoNetwork } from '../geckoTerminal/pools';
import { defaultMarketFor, findMarket, type ChartableMarket } from './markets';
import { DEFAULT_GECKO_TIMEFRAME, isGeckoTimeframeId, type GeckoTimeframeId } from './ohlcv';

/** The network a link with no `?network=` means. */
export const DEFAULT_CHART_NETWORK: GeckoNetwork = 'eth';

export interface ChartParamRefusal {
  param: 'network' | 'pool' | 'tf';
  message: string;
}

export interface ChartParams {
  /** Always a registry market, or null when the registry is empty. */
  market: ChartableMarket | null;
  timeframe: GeckoTimeframeId;
  /** One sentence per parameter that was refused. Rendered by the page. */
  refusals: ChartParamRefusal[];
}

export interface RawChartParams {
  network: string | null;
  pool: string | null;
  tf: string | null;
}

export function resolveChartParams(raw: RawChartParams): ChartParams {
  const refusals: ChartParamRefusal[] = [];

  const rawNetwork = raw.network?.trim() ?? '';
  let network: GeckoNetwork = DEFAULT_CHART_NETWORK;
  if (rawNetwork.length > 0) {
    if (isGeckoNetwork(rawNetwork)) {
      network = rawNetwork;
    } else {
      refusals.push({
        param: 'network',
        message: 'The link named a network this page does not offer; showing Ethereum.',
      });
    }
  }

  // The fallback is resolved from the registry rather than hardcoded, so a
  // network whose last pool was removed falls back to nothing rather than to a
  // pool on a different chain.
  let market = defaultMarketFor(network);

  const rawPool = raw.pool?.trim() ?? '';
  if (rawPool.length > 0) {
    // The ONLY gate. `findMarket` compares against the registry under the
    // network's own case rule and returns the registry's object; the caller's
    // string is discarded either way and never reaches `ohlcvUrlFor`.
    const found = findMarket(network, rawPool);
    if (found) {
      market = found;
    } else {
      refusals.push({
        param: 'pool',
        message: 'The link named a pool this page does not list, so nothing was read for it.',
      });
    }
  }

  const rawTf = raw.tf?.trim() ?? '';
  let timeframe: GeckoTimeframeId = DEFAULT_GECKO_TIMEFRAME;
  if (rawTf.length > 0) {
    if (isGeckoTimeframeId(rawTf)) {
      timeframe = rawTf;
    } else {
      refusals.push({
        param: 'tf',
        message: 'The link named a timeframe this page does not offer; showing 1H.',
      });
    }
  }

  return { market, timeframe, refusals };
}
