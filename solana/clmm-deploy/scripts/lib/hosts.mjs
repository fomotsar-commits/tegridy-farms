// The only hosts the deploy pack's scripts, page and staging ask anything of: Solana's public RPCs
// and the second one the page checks against, GitHub (the notice), and the website (the position
// link). A rehearsal's local chain and stand-ins answer on this machine only.
const HOSTS = new Set([
  'api.mainnet-beta.solana.com', 'api.devnet.solana.com', 'api.testnet.solana.com', 'solana-rpc.publicnode.com',
  'api.github.com', 'raw.githubusercontent.com', 'memetics.finance',
]);
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** `url` itself when it is https on one of those hosts, or http on this machine for a rehearsal
 *  (`loopback`); anything else throws before a byte is sent. */
export function allowedUrl(url, { loopback = false } = {}) {
  const u = new URL(url);
  if (!u.username && !u.password) {
    if (u.protocol === 'https:' && !u.port && HOSTS.has(u.hostname)) return u.href;
    if (loopback && u.protocol === 'http:' && LOOPBACK.has(u.hostname)) return u.href;
  }
  throw new Error(`${u.origin} is not a host this pack may ask: only ${[...HOSTS].join(', ')}${loopback ? ', or this machine' : ''}`);
}
