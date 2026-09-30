// The fee-rail reads of revenue-watch.yml (lines 90-205), in Node instead of bash + jq.
// Same rails, same public RPC defaults, same three buckets: EARNED (non-zero), UNKNOWN
// (tried and could not read, never "zero") and UNCONFIGURED (not watched, by decision).

export const ETH_RPC_DEFAULT = 'https://ethereum-rpc.publicnode.com';
export const SOL_RPC_DEFAULT = 'https://api.mainnet-beta.solana.com';
const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TIMEOUT_MS = 20_000;

export const EVM_CALLS = [
  // Selectors derived with `cast sig` (see the workflow): totalETHFees(), totalDistributed().
  { name: 'SwapFeeRouter.totalETHFees()', to: '0x6d5791A660e79175F74C6D639584C98422d5956E', data: '0x6b3128c2' },
  { name: 'RevenueDistributor.totalDistributed()', to: '0xF993316E2fC079de4358c489A935E01e03E23E17', data: '0xefca2eed' },
];
export const EVM_BALANCES = [
  { name: 'RevenueDistributor ETH balance', address: '0xF993316E2fC079de4358c489A935E01e03E23E17' },
  { name: 'Launcher integrator EOA', address: '0xD355A072d6bBbA275DBD83A3149f6347b06d1051' },
];
export const SQUADS_VAULT = 'GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd';

async function rpc(fetchImpl, url, method, params) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
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
  const ethRpc = env.ETH_RPC || ETH_RPC_DEFAULT;
  const solRpc = env.SOL_RPC || SOL_RPC_DEFAULT;
  const earned = [];
  const unknown = [];
  const unconfigured = [];

  const evm = async (name, method, params, unit = '') => {
    let json;
    try {
      json = await rpc(fetchImpl, ethRpc, method, params);
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

  for (const c of EVM_CALLS) await evm(c.name, 'eth_call', [{ to: c.to, data: c.data }, 'latest']);
  for (const b of EVM_BALANCES) await evm(b.name, 'eth_getBalance', [b.address, 'latest'], ' wei');

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
  else unconfigured.push('- Solana swap-fee wallet: set SOLANA_FEE_ACCOUNT to watch this rail');

  const state = earned.length ? 'earned' : unknown.length ? 'partial' : 'zero';
  return { earned, unknown, unconfigured, state };
}
