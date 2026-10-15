import { looksLikePubkey } from '../../launcher/solana/curve/format';

/**
 * `path` for a link between the two Solana LP tabs (/pools and /solana-lp), keeping the
 * token being looked at: the URL's `?mint=` when it has the shape of an address, and
 * nothing else from the URL. The finder on the other tab checks the mint again.
 */
export function withMint(path: string, params: URLSearchParams): string {
  const mint = params.get('mint')?.trim() ?? '';
  return looksLikePubkey(mint) ? `${path}?mint=${mint}` : path;
}
