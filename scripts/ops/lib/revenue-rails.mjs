// The fee-rail reads of revenue-watch.yml (its "Read every fee rail" step), in Node instead of
// bash + jq. Same rails, same public RPC defaults, same three buckets: EARNED (non-zero), UNKNOWN
// (tried and could not read, never "zero") and UNCONFIGURED (not watched, by decision).

export const ETH_RPC_DEFAULT = 'https://ethereum-rpc.publicnode.com';
export const BASE_RPC_DEFAULT = 'https://mainnet.base.org';
export const ROBINHOOD_RPC_DEFAULT = 'https://rpc.mainnet.chain.robinhood.com';
export const SOL_RPC_DEFAULT = 'https://api.mainnet-beta.solana.com';
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const REQUEST_TIMEOUT_MS = 20_000;

/** Each EVM read names the env var of its chain's RPC, the same one the workflow passes. */
export const RPC_DEFAULTS = Object.freeze({
  ETH_RPC: ETH_RPC_DEFAULT,
  BASE_RPC: BASE_RPC_DEFAULT,
  ROBINHOOD_RPC: ROBINHOOD_RPC_DEFAULT,
});

export const EVM_CALLS = [
  // Selector derived with `cast sig` (see the workflow): totalETHFees().
  { name: 'SwapFeeRouter.totalETHFees()', to: '0x6d5791A660e79175F74C6D639584C98422d5956E', data: '0x6b3128c2', rpcEnv: 'ETH_RPC' },
];
// Every EVM venue fee lands in its chain's treasury Safe (owner ruling 2026-11-15; Base and
// Robinhood share one address), not in the stakers' payout contract.
export const EVM_BALANCES = [
  { name: 'Ethereum treasury Safe ETH balance', address: '0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d', rpcEnv: 'ETH_RPC' },
  { name: 'Base treasury Safe ETH balance', address: '0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0', rpcEnv: 'BASE_RPC' },
  { name: 'Robinhood treasury Safe ETH balance', address: '0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0', rpcEnv: 'ROBINHOOD_RPC' },
  { name: 'Launcher integrator EOA', address: '0xD355A072d6bBbA275DBD83A3149f6347b06d1051', rpcEnv: 'ETH_RPC' },
];
export const SQUADS_VAULT = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';

async function rpc(fetchImpl, url, method, params) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: `HTTP ${res.status}, non-JSON answer` };
  }
}

const describeError = (json) => JSON.stringify(json?.error ?? 'empty').slice(0, 200);
const isHex = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v);
const nonZero = (hex) => hex.slice(2).replace(/^0+/, '') !== '';

/** Read every rail. Returns { earned, unknown, unconfigured, state: 'earned'|'partial'|'zero' }. */
export async function readRails({ fetchImpl = fetch, env = process.env } = {}) {
  const rpcFor = (rpcEnv) => env[rpcEnv] || RPC_DEFAULTS[rpcEnv];
  const solRpc = env.SOL_RPC || SOL_RPC_DEFAULT;
  const earned = [];
  const unknown = [];
  const unconfigured = [];

  const evm = async (name, rpcUrl, method, params, unit = '') => {
    let json;
    try {
      json = await rpc(fetchImpl, rpcUrl, method, params);
    } catch {
      unknown.push(`- ${name}: RPC request failed`);
      return;
    }
    const hex = json?.result;
    if (!isHex(hex) || hex === '0x') {
      unknown.push(`- ${name}: no result (${describeError(json)})`);
      return;
    }
    if (nonZero(hex)) earned.push(`- **${name}**: \`${hex}\`${unit}`);
  };

  for (const c of EVM_CALLS) await evm(c.name, rpcFor(c.rpcEnv), 'eth_call', [{ to: c.to, data: c.data }, 'latest']);
  for (const b of EVM_BALANCES) await evm(b.name, rpcFor(b.rpcEnv), 'eth_getBalance', [b.address, 'latest'], ' wei');

  const solTokens = async (name, owner) => {
    let json;
    try {
      json = await rpc(fetchImpl, solRpc, 'getTokenAccountsByOwner', [owner, { programId: SPL_TOKEN_PROGRAM }, { encoding: 'jsonParsed' }]);
    } catch {
      unknown.push(`- ${name}: RPC request failed`);
      return;
    }
    const accounts = json?.result?.value;
    if (!Array.isArray(accounts)) {
      unknown.push(`- ${name}: ${describeError(json)}`);
      return;
    }
    const held = accounts
      .map((a) => a?.account?.data?.parsed?.info)
      .filter((info) => (info?.tokenAmount?.amount ?? '0') !== '0')
      .map((info) => `${info.mint}:${info.tokenAmount.uiAmountString}`);
    if (held.length) earned.push(`- **${name}** (SPL): ${held.join(', ')}`);
  };

  await solTokens('Squads partner vault', SQUADS_VAULT);
  if (env.SOLANA_FEE_ACCOUNT) await solTokens('Solana swap-fee wallet', env.SOLANA_FEE_ACCOUNT);
  else unconfigured.push('- Solana swap-fee wallet: none set. Venue swap fees go to the Squads partner vault, which is watched; SOLANA_FEE_ACCOUNT adds one more wallet');

  const state = earned.length ? 'earned' : unknown.length ? 'partial' : 'zero';
  return { earned, unknown, unconfigured, state };
}
