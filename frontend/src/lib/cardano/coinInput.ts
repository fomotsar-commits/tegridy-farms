// What a visitor pastes as "the coin": what most people call its contract address. A Cardano
// coin has no contract of its own; it is its policy id (the rule that mints it) and its name.
// Every form people copy is taken: the whole id (policy id + name, hex: what DexScreener shows
// as the coin's address), the policy id alone, an asset1… fingerprint, or an explorer link
// holding one of those.

import { bech32 } from '@scure/base';
import { MINSWAP_V2 } from './minswapV2';

export type CoinInput =
  /** The whole id: nothing to look up. */
  | { kind: 'coin'; policyId: string; assetName: string }
  /** A policy id alone: its coins are looked up, and picked from when there are several. */
  | { kind: 'policy'; policyId: string }
  | { kind: 'fingerprint'; fingerprint: string }
  /** A trading pair's page, or a pool's share token: it names a pool, not a coin. */
  | { kind: 'pair' }
  | { kind: 'unknown' };

/** Sites whose coin-chart links name a trading pair (a pool), never the coin itself. */
const PAIR_HOSTS = ['dexscreener.com', 'geckoterminal.com'];

const HEX_NAME = /^(?:[0-9a-f]{2}){0,32}$/;

function fromPolicy(policyId: string, assetName: string | null): CoinInput {
  if (policyId === MINSWAP_V2.authenPolicy) return { kind: 'pair' };
  return assetName === null ? { kind: 'policy', policyId } : { kind: 'coin', policyId, assetName };
}

/** One id as typed, or null when the text is not one. */
function parseId(text: string): CoinInput | null {
  const t = text.trim().toLowerCase();
  if (t.startsWith('asset1')) {
    try {
      const { prefix, words } = bech32.decode(t as `${string}1${string}`);
      if (prefix === 'asset' && bech32.fromWords(words).length === 20) return { kind: 'fingerprint', fingerprint: t };
    } catch {
      /* not one: a typo fails the checksum */
    }
    return null;
  }
  // "<policy id>.<name>": the name in hex is that name; in letters (as pool.pm writes it), only
  // the policy id is kept and the coin is picked from what the chain lists under it.
  const dotted = /^([0-9a-f]{56})\.(.+)$/.exec(t);
  if (dotted) {
    const [, policyId = '', name = ''] = dotted;
    return fromPolicy(policyId, HEX_NAME.test(name) ? name : null);
  }
  const hex = t.replace(/\s/g, '');
  if (!/^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/.test(hex)) return null;
  return fromPolicy(hex.slice(0, 56), hex.length === 56 ? null : hex.slice(56));
}

function asUrl(t: string): URL | null {
  if (/\s/.test(t)) return null;
  const withScheme = /^https?:\/\//i.test(t) ? t : /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i.test(t) ? `https://${t}` : null;
  if (!withScheme) return null;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

/** What the pasted text names; null for an empty box. */
export function parseCoinInput(text: string): CoinInput | null {
  const t = text.trim();
  if (t === '') return null;
  const direct = parseId(t);
  if (direct) return direct;
  const url = asUrl(t);
  if (!url) return { kind: 'unknown' };
  const host = url.hostname.toLowerCase();
  if (PAIR_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return { kind: 'pair' };
  // An explorer's coin page holds the id as one piece of its path (cardanoscan.io/token/<id>,
  // cexplorer.io/asset/asset1…, pool.pm/<policy id>.<name>).
  for (const raw of url.pathname.split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      continue;
    }
    const dottedPolicy = /^([0-9a-fA-F]{56})\./.exec(segment)?.[1];
    const found = dottedPolicy ? fromPolicy(dottedPolicy.toLowerCase(), null) : parseId(segment);
    if (found) return found;
  }
  return { kind: 'unknown' };
}
