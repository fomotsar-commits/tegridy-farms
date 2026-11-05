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
  /**
   * A policy id: its coins are looked up. `name`, the coin's name in letters when the text gave
   * one (pool.pm writes it so), picks among them; without it, the one coin is taken, or the
   * visitor picks from several.
   */
  | { kind: 'policy'; policyId: string; name?: string }
  | { kind: 'fingerprint'; fingerprint: string }
  /** A trading pair's page, or a pool's share token: it names a pool, not a coin. */
  | { kind: 'pair' }
  | { kind: 'unknown' };

/** Sites whose coin-chart links name a trading pair (a pool), never the coin itself. */
const PAIR_HOSTS = ['dexscreener.com', 'geckoterminal.com'];

const HEX_NAME = /^(?:[0-9a-f]{2}){0,32}$/;

/** CIP-67 label prefixes of the two CIP-68 tokens that come in amounts: 333 (fungible) and 444 (rich fungible). */
export const CIP67_AMOUNT_PREFIXES = ['0014df10', '001bc280'];

/** Whether a policy mints a pool's share tokens (Minswap V2's): such a token names a pair, not a coin. */
export function isPoolShare(policyId: string): boolean {
  return policyId === MINSWAP_V2.authenPolicy;
}

/** Whether a coin's asset name is `name` in letters, bare or behind a CIP-68 amount prefix. */
export function namesCoin(assetName: string, name: string): boolean {
  const hex = Array.from(new TextEncoder().encode(name), (b) => b.toString(16).padStart(2, '0')).join('');
  return hex !== '' && (assetName === hex || CIP67_AMOUNT_PREFIXES.some((p) => assetName === p + hex));
}

function fromPolicy(policyId: string, assetName: string | null, name?: string): CoinInput {
  if (isPoolShare(policyId)) return { kind: 'pair' };
  if (assetName !== null) return { kind: 'coin', policyId, assetName };
  return name ? { kind: 'policy', policyId, name } : { kind: 'policy', policyId };
}

/** One id as typed, or null when the text is not one. `nameInLetters`: a name after the policy id is text, never hex (pool.pm). */
function parseId(text: string, nameInLetters = false): CoinInput | null {
  const t = text.trim();
  if (/^asset1/i.test(t)) {
    const fingerprint = t.toLowerCase();
    try {
      const { prefix, words } = bech32.decode(fingerprint as `${string}1${string}`);
      if (prefix === 'asset' && bech32.fromWords(words).length === 20) return { kind: 'fingerprint', fingerprint };
    } catch {
      /* not one: a typo fails the checksum */
    }
    return null;
  }
  // "<policy id>.<name>": a name in hex is that name; one in letters picks among the coins the
  // chain lists under the policy id.
  const dotted = /^([0-9a-fA-F]{56})\s*\.(.*)$/.exec(t);
  if (dotted) {
    const [, policy = '', name = ''] = dotted;
    const hexName = name.replace(/\s/g, '').toLowerCase();
    if (!nameInLetters && HEX_NAME.test(hexName)) return fromPolicy(policy.toLowerCase(), hexName === '' ? null : hexName);
    return fromPolicy(policy.toLowerCase(), null, name.trim());
  }
  const hex = t.replace(/\s/g, '').toLowerCase();
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
  // cexplorer.io/asset/asset1…, pool.pm/<policy id>.<name in letters>).
  const nameInLetters = host === 'pool.pm' || host.endsWith('.pool.pm');
  for (const raw of url.pathname.split('/')) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      continue;
    }
    const found = parseId(segment, nameInLetters);
    if (found) return found;
  }
  return { kind: 'unknown' };
}
