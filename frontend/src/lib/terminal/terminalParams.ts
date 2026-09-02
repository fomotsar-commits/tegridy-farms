// The terminal's URL state: which network, which view, which row.
//
// FAIL CLOSED ON INPUT. Every value here arrives from a query string, which is
// the one part of this page an attacker writes directly. `net` and `view` are
// CLOSED UNIONS with a fallback — an unrecognised value never travels onward as
// itself, so it can never reach a URL builder, a fetch, or a link. That matters
// specifically because the network slug is interpolated into a GeckoTerminal
// path: a wrong slug there is a silent 404 rather than an error, and an
// attacker-shaped one would be request-shaping.
//
// `pool` is the deliberate exception, and it is confined rather than validated
// against a chain here: it is only ever compared for EQUALITY against the keys
// of rows that came back from a read. It is never interpolated into a URL, an
// href, a scan link or a swap prefill. A value that matches nothing renders a
// sentence; it does not become a request. The length bound below exists so a
// pathological query string cannot be carried around in state.

import { isGeckoNetwork, type GeckoNetwork } from '../geckoTerminal/pools';

/**
 * The views the terminal can show.
 *
 * 'indexer' is the venue's own pair feed and is the only one that is NOT a
 * GeckoTerminal read; it appears as a tab only when an indexer is configured
 * (see feedSources.ts), so parsing it from a URL on a build without one falls
 * through to the tab list's own gate rather than rendering a dead view.
 */
export type TerminalView = 'new' | 'trending' | 'island' | 'watchlist' | 'indexer';

export const TERMINAL_VIEWS: readonly TerminalView[] = [
  'new',
  'trending',
  'island',
  'watchlist',
  'indexer',
];

export function isTerminalView(v: unknown): v is TerminalView {
  return typeof v === 'string' && (TERMINAL_VIEWS as readonly string[]).includes(v);
}

export interface TerminalParams {
  network: GeckoNetwork;
  view: TerminalView;
  /** A row key to preselect. Compared for equality only — never interpolated. */
  pool: string | null;
}

export const DEFAULT_TERMINAL_PARAMS: TerminalParams = {
  network: 'eth',
  view: 'new',
  pool: null,
};

/**
 * The longest a row key can honestly be: `solana:` plus a 44-character base58
 * key is 51. The bound is generous rather than exact because its job is to stop
 * an unbounded string entering component state, not to validate an address —
 * validation is the row-key comparison, which no over-long value can pass.
 */
const MAX_POOL_PARAM_LENGTH = 128;

export function parseTerminalParams(search: URLSearchParams): TerminalParams {
  const rawNet = search.get('net');
  const rawView = search.get('view');
  const rawPool = (search.get('pool') ?? '').trim();

  return {
    network: isGeckoNetwork(rawNet) ? rawNet : DEFAULT_TERMINAL_PARAMS.network,
    view: isTerminalView(rawView) ? rawView : DEFAULT_TERMINAL_PARAMS.view,
    pool: rawPool && rawPool.length <= MAX_POOL_PARAM_LENGTH ? rawPool : null,
  };
}

/**
 * The inverse, for share links.
 *
 * Defaults are OMITTED rather than written out, so the common URL stays
 * `/terminal` and a link someone pastes carries only the choices they actually
 * made. Only values that survived `parseTerminalParams`' unions are ever
 * serialised, so a round-trip cannot smuggle a value back in.
 */
export function serializeTerminalParams(params: TerminalParams): URLSearchParams {
  const out = new URLSearchParams();
  if (params.network !== DEFAULT_TERMINAL_PARAMS.network) out.set('net', params.network);
  if (params.view !== DEFAULT_TERMINAL_PARAMS.view) out.set('view', params.view);
  if (params.pool) out.set('pool', params.pool);
  return out;
}
