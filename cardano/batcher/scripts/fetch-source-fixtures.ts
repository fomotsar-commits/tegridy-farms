// Records real Koios answers about Minswap V2's mainnet deployment (keyless, read-only, about ten
// requests) into test/fixtures/koios-responses.json, with the raw transaction that made each
// UTxO: the tests rebuild every UTxO from Koios's JSON and check it against those bytes.
//   node scripts/fetch-source-fixtures.ts
import { writeFileSync } from 'node:fs';

const KOIOS = 'https://api.koios.rest/api/v1';
const ORDER_SCRIPT = 'c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c';
const POOL_SCRIPT = 'ea07b733d932129c378af627436e7cbc2ef0bf96e0036bb51b3bde6b';
const AUTHEN = 'f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c';
// Minswap V2's reference scripts (order, pool, pool batching) and its global setting.
const REFS = [
  'cf4ecddde0d81f9ce8fcc881a85eb1f8ccdaf6807f03fea4cd02da896a621776#0',
  '2536194d2a976370a932174c10975493ab58fd7c16395d50e62b7c0e1949baea#0',
  'd46bd227bd2cf93dedd22ae9b6d92d30140cf0d68b756f6608e38d680c61ad17#0',
  '0dc17712e37a4e741767db2f90d4ffbf69faf88b9bed4c47864f7bd912924bea#0',
];
const BATCHING_REWARD_ADDRESS = 'stake17y02a946720zw6pw50upt2arvxsvvpvaghjtl054h0f0gjsfyjz59';

const responses: Record<string, string> = {};
async function call(path: string, body?: unknown): Promise<string> {
  const res = await fetch(`${KOIOS}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}: ${text.slice(0, 200)}`);
  responses[`${body === undefined ? 'GET' : 'POST'} ${path} ${body === undefined ? '' : JSON.stringify(body)}`.trim()] = text;
  return text;
}

const page = 'order=block_height.asc,tx_hash.asc,tx_index.asc&offset=0&limit=3';
const orders = JSON.parse(await call(`/credential_utxos?${page}`, { _payment_credentials: [ORDER_SCRIPT], _extended: true }));
const pools = JSON.parse(await call(`/asset_utxos?payment_cred=eq.${POOL_SCRIPT}&${page}`, { _asset_list: [[AUTHEN, '4d5350']], _extended: true }));
const refs = JSON.parse(await call('/utxo_info', { _utxo_refs: REFS, _extended: true }));
await call('/tip');
await call('/cli_protocol_params');
await call('/account_info', { _stake_addresses: [BATCHING_REWARD_ADDRESS] });
const hashOnly = [...orders, ...pools].find((u: { inline_datum: unknown; datum_hash: string | null }) => !u.inline_datum && u.datum_hash);
if (hashOnly) await call('/datum_info', { _datum_hashes: [hashOnly.datum_hash] });

const txs = [...new Set([...orders, ...pools, ...refs].map((u: { tx_hash: string }) => u.tx_hash))];
const cbor = JSON.parse(await call('/tx_cbor', { _tx_hashes: txs })) as { tx_hash: string; cbor: string }[];
const creatingTxs = Object.fromEntries(cbor.map((t) => [t.tx_hash, t.cbor]));

writeFileSync(
  new URL('../test/fixtures/koios-responses.json', import.meta.url),
  `${JSON.stringify({ source: `Koios mainnet (keyless), ${new Date().toISOString()}: Minswap V2's own deployment`, responses, creatingTxs }, null, 1)}\n`,
);
console.log(`recorded ${Object.keys(responses).length} answers, ${txs.length} creating transactions`);
