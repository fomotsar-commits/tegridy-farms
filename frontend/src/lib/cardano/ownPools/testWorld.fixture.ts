// Test-only. The venue's own pools as the batcher's test world has them (feat/cardano-batcher
// cardano/batcher/test/world.ts, our contracts compiled with TEST parameters: a made-up seed,
// nothing on any network), written to __fixtures__/own-pools-test-world.json from that branch.
// The test deployment compiles no factory, so its hash, the two reference UTxOs, the treasury
// and the budgets below are made up too.
import type { OwnPoolsDeploymentRecord } from '../../../../api/_lib/cardano-own-pools';
import { composeAddress, parseAddressBech32, type ParsedAddress } from '../address';
import type { Csl } from '../csl';
import type { ProtocolParams } from '../chain';
import type { WalletUtxo } from '../orderTx';
import { fixture } from '../testkit.fixture';
import type { PlutusParams } from './chainReads';

export interface TestWorld {
  scripts: Record<'authen' | 'pool' | 'poolBatching' | 'order' | 'globalSetting' | 'expiredOrderCancel', { hash: string; size: number }>;
  poolStakeKeyHash: string;
  token: { policyId: string; assetName: string };
  lpName: string;
  pool: { txHash: string; index: number; addressBech32: string; addressHex: string; outputHex: string; datumHex: string; reserveA: string; reserveB: string; totalLiquidity: string };
  traders: Record<'1' | '2', { addressBech32: string; paymentKey: string }>;
  orders: {
    deposit: { trader: number; a: string; b: string; minLp: string; maxBatcherFee: string; datumHex: string };
    withdraw: { trader: number; lp: string; minA: string; minB: string; maxBatcherFee: string; datumHex: string };
  };
  orderAddress: Record<'1', string>;
}

export const WORLD = fixture<TestWorld>('own-pools-test-world.json');

/** Made up: an enterprise script address standing for the two-key treasury. */
export const TEST_TREASURY: ParsedAddress = composeAddress({ kind: 'script', hash: '7e'.repeat(28) }, null);

export const TEST_RECORD: OwnPoolsDeploymentRecord = {
  authenPolicy: WORLD.scripts.authen.hash,
  poolScriptHash: WORLD.scripts.pool.hash,
  poolBatchingScriptHash: WORLD.scripts.poolBatching.hash,
  poolAddress: WORLD.pool.addressBech32,
  orderScriptHash: WORLD.scripts.order.hash,
  factoryScriptHash: 'fa'.repeat(28),
  factoryRef: { ref: `${'f1'.repeat(32)}#0`, scriptSize: 3400 },
  authenRef: { ref: `${'f2'.repeat(32)}#0`, scriptSize: WORLD.scripts.authen.size },
  openingFeeLovelace: '73000000',
  treasury: TEST_TREASURY.bech32,
  batcherFeeLovelace: '2000000',
  openPoolBudget: { factory: { mem: 1_500_000, steps: 500_000_000 }, authen: { mem: 800_000, steps: 300_000_000 } },
};

export function trader(n: '1' | '2'): ParsedAddress {
  return parseAddressBech32(WORLD.traders[n].addressBech32)!;
}

/** Mainnet's parameters as Koios read them on 2026-10-24 (the swap's tests use the same). */
export const PARAMS: ProtocolParams = {
  txFeePerByte: 44n,
  txFeeFixed: 155381n,
  utxoCostPerByte: 4310n,
  maxTxSize: 16384,
  maxValueSize: 5000,
  stakeAddressDeposit: 2000000n,
  stakePoolDeposit: 500000000n,
  minFeeRefScriptCostPerByte: 15,
};

/** Mainnet's Plutus V2 cost model and prices (the batcher's test/fixtures/protocol-params.json, Koios, 2026-10-25). */
export const PLUTUS: PlutusParams = {
  costModelV2: fixture<{ costModelV2: number[] }>('mainnet-plutus-v2-params.json').costModelV2,
  priceMem: { n: 577n, d: 10_000n },
  priceSteps: { n: 721n, d: 10_000_000n },
  collateralPercentage: 150,
  maxCollateralInputs: 3,
};

/** A wallet UTxO of `ada` lovelace and these tokens at `to`, with a made-up transaction id. */
export function walletUtxo(csl: Csl, i: number, to: ParsedAddress, ada: bigint, tokens: [string, string, bigint][] = []): WalletUtxo {
  const value = csl.Value.new(csl.BigNum.from_str(ada.toString()));
  if (tokens.length) {
    const ma = csl.MultiAsset.new();
    for (const [p, n, q] of tokens) ma.set_asset(csl.ScriptHash.from_hex(p), csl.AssetName.new(Uint8Array.from(Buffer.from(n, 'hex'))), csl.BigNum.from_str(q.toString()));
    value.set_multiasset(ma);
  }
  const input = csl.TransactionInput.new(csl.TransactionHash.from_hex(i.toString(16).padStart(64, 'c')), i);
  const u = csl.TransactionUnspentOutput.new(input, csl.TransactionOutput.new(csl.Address.from_bytes(Uint8Array.from(Buffer.from(to.hex, 'hex'))), value));
  return { txHash: input.transaction_id().to_hex(), index: i, hex: u.to_hex() };
}
