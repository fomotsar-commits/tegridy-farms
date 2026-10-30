// The venue's own Cardano pools: the deployment record (api/_lib/cardano-own-pools.js), read
// and checked once. Every own-pool reader and writer takes the OwnPools this returns, never a
// constant of its own, so nothing here can fall back to Minswap's deployment.
//
// A record carrying any of Minswap's mainnet hashes, its pool stake key or one of its
// reference-script UTxOs is refused whole (Minswap V2 deployed/mainnet, @ c3293ad43): copied
// unpatched, those send our users' orders into Minswap's pools and our fees to Minswap.

import { OWN_POOLS_DEPLOYMENT } from '../../../../api/_lib/cardano-own-pools.js';
import type { OwnPoolsDeploymentRecord, ScriptRefRecord } from '../../../../api/_lib/cardano-own-pools';
import { MAINNET_NETWORK_ID, parseAddressBech32, type ParsedAddress } from '../address';
import { MINSWAP_V2, type DexScripts } from '../minswapV2';

/** Minswap V2 mainnet: authen, order, pool, factory, pool-batching and expired-cancel scripts. */
const MINSWAP_SCRIPTS: ReadonlySet<string> = new Set([
  MINSWAP_V2.authenPolicy,
  MINSWAP_V2.orderScriptHash,
  MINSWAP_V2.poolScriptHash,
  '7bc5fbd41a95f561be84369631e0e35895efb0b73e0a7480bb9ed730',
  '1eae96baf29e27682ea3f815aba361a0c6059d45e4bfbe95bbd2f44a',
]);
/** The stake key on Minswap's pools and on its reference-script UTxOs. */
const MINSWAP_STAKE_KEY = '52563c5410bff6a0d43ccebb7c37e1f69f5eb260552521adff33b9c2';
/** Minswap's reference-script transactions (deployed/mainnet/references.json). */
const MINSWAP_REF_TXS: ReadonlySet<string> = new Set([
  'cf4ecddde0d81f9ce8fcc881a85eb1f8ccdaf6807f03fea4cd02da896a621776',
  'ef3acc7dfc5a98bffe8f4d4400e65a9ade5a1316b2fcb7145c3b83dba38a66f5',
  '59c7fa5c30cbab4e6d38f65e15d1adef71495321365588506ad089d237b602e0',
  'dbc1498500a6e79baa0f34d10de55cdb4289ca6c722bd70e1e1b78a858f136b9',
  '2536194d2a976370a932174c10975493ab58fd7c16395d50e62b7c0e1949baea',
  'd46bd227bd2cf93dedd22ae9b6d92d30140cf0d68b756f6608e38d680c61ad17',
]);

/** A whole-number budget no single transaction can exceed (mainnet: 16.5M memory, 10B steps). */
const MAX_TX_MEM = 16_500_000;
const MAX_TX_STEPS = 10_000_000_000;

export interface ScriptRef {
  txHash: string;
  index: number;
  scriptSize: number;
}

export interface ExBudget {
  mem: bigint;
  steps: bigint;
}

export interface OwnPools extends DexScripts {
  poolBatchingScriptHash: string;
  poolAddress: ParsedAddress;
  factoryScriptHash: string;
  factoryRef: ScriptRef;
  authenRef: ScriptRef;
  openingFee: bigint;
  treasury: ParsedAddress;
  batcherFee: bigint;
  openPoolBudget: { factory: ExBudget; authen: ExBudget };
}

export type OwnPoolsState = { kind: 'not-deployed' } | { kind: 'refused'; reason: string } | { kind: 'deployed'; pools: OwnPools };

const HASH = /^[0-9a-f]{56}$/;
const DECIMAL = /^\d{1,20}$/;

function scriptRef(r: ScriptRefRecord | undefined): ScriptRef | null {
  const m = typeof r?.ref === 'string' ? /^([0-9a-f]{64})#(\d{1,5})$/.exec(r.ref) : null;
  if (!m || !Number.isInteger(r?.scriptSize) || r!.scriptSize <= 0 || r!.scriptSize > 16_384) return null;
  return { txHash: m[1]!, index: Number(m[2]), scriptSize: r!.scriptSize };
}

function budget(b: { mem: number; steps: number } | undefined): ExBudget | null {
  if (!b || !Number.isSafeInteger(b.mem) || !Number.isSafeInteger(b.steps)) return null;
  if (b.mem <= 0 || b.steps <= 0 || b.mem > MAX_TX_MEM || b.steps > MAX_TX_STEPS) return null;
  return { mem: BigInt(b.mem), steps: BigInt(b.steps) };
}

/** The record, checked whole: `deployed` only when every field reads and none is Minswap's. */
export function readOwnPoolsDeployment(raw: OwnPoolsDeploymentRecord | null = OWN_POOLS_DEPLOYMENT): OwnPoolsState {
  if (raw === null) return { kind: 'not-deployed' };
  const no = (reason: string): OwnPoolsState => ({ kind: 'refused', reason });
  const hashes = [raw.authenPolicy, raw.poolScriptHash, raw.poolBatchingScriptHash, raw.orderScriptHash, raw.factoryScriptHash];
  if (!hashes.every((h) => typeof h === 'string' && HASH.test(h))) return no('a script hash is not 28 bytes of hex');
  if (hashes.some((h) => MINSWAP_SCRIPTS.has(h))) return no('it names one of Minswap’s own scripts');
  const poolAddress = parseAddressBech32(raw.poolAddress);
  if (!poolAddress || poolAddress.network !== MAINNET_NETWORK_ID) return no('the pool address is not a mainnet address');
  if (poolAddress.payment.kind !== 'script' || poolAddress.payment.hash !== raw.poolScriptHash) return no('the pool address is not at the pool script');
  if (poolAddress.stake?.hash === MINSWAP_STAKE_KEY) return no('the pool address carries Minswap’s stake key');
  const factoryRef = scriptRef(raw.factoryRef);
  const authenRef = scriptRef(raw.authenRef);
  if (!factoryRef || !authenRef) return no('a reference script is not "txhash#index" with its size');
  if (MINSWAP_REF_TXS.has(factoryRef.txHash) || MINSWAP_REF_TXS.has(authenRef.txHash)) return no('a reference script is one of Minswap’s');
  const treasury = parseAddressBech32(raw.treasury);
  if (!treasury || treasury.network !== MAINNET_NETWORK_ID) return no('the treasury is not a mainnet address');
  if (typeof raw.openingFeeLovelace !== 'string' || !DECIMAL.test(raw.openingFeeLovelace)) return no('the opening fee is not a whole lovelace amount');
  if (typeof raw.batcherFeeLovelace !== 'string' || !DECIMAL.test(raw.batcherFeeLovelace)) return no('the batcher fee is not a whole lovelace amount');
  const openingFee = BigInt(raw.openingFeeLovelace);
  const batcherFee = BigInt(raw.batcherFeeLovelace);
  // A fee a Cardano output cannot hold, or one far past the owner's ruling, is a typo, not a fee.
  if (openingFee < 1_000_000n || openingFee > 1_000_000_000n) return no('the opening fee is outside 1 to 1,000 ADA');
  if (batcherFee <= 0n || batcherFee > 5_000_000n) return no('the batcher fee is outside 0 to 5 ADA');
  const factory = budget(raw.openPoolBudget?.factory);
  const authen = budget(raw.openPoolBudget?.authen);
  if (!factory || !authen || factory.mem + authen.mem > BigInt(MAX_TX_MEM) || factory.steps + authen.steps > BigInt(MAX_TX_STEPS)) {
    return no('the pool-opening budget is not one a transaction can carry');
  }
  return {
    kind: 'deployed',
    pools: {
      authenPolicy: raw.authenPolicy,
      poolScriptHash: raw.poolScriptHash,
      orderScriptHash: raw.orderScriptHash,
      poolBatchingScriptHash: raw.poolBatchingScriptHash,
      poolAddress,
      factoryScriptHash: raw.factoryScriptHash,
      factoryRef,
      authenRef,
      openingFee,
      treasury,
      batcherFee,
      openPoolBudget: { factory, authen },
    },
  };
}

/** The deployment as the site ships it. */
export const OWN_POOLS: OwnPoolsState = readOwnPoolsDeployment();
