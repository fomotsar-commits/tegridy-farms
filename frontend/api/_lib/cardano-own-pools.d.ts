// Types for cardano-own-pools.js, shared by the API and the browser.

/** A reference-script UTxO the pool-opening transaction reads, and its script's size in bytes. */
export interface ScriptRefRecord {
  /** "txhash#index". */
  ref: string;
  scriptSize: number;
}

export interface OwnPoolsDeploymentRecord {
  /** The authen minting policy (also the global-setting script): mints MSF, MSP, MSGS and every LP token. */
  authenPolicy: string;
  poolScriptHash: string;
  /** The pool-batching script: every pool datum's stake credential. */
  poolBatchingScriptHash: string;
  /** The factory's `pool_address` parameter, whole bech32: our pool script with the venue's stake part. */
  poolAddress: string;
  orderScriptHash: string;
  factoryScriptHash: string;
  factoryRef: ScriptRefRecord;
  authenRef: ScriptRefRecord;
  /** The first GlobalSetting's pool_creation_fee, lovelace, decimal: "73000000". */
  openingFeeLovelace: string;
  /** pool_creation_fee_receiver: the two-key treasury, whole bech32. */
  treasury: string;
  /**
   * The max_batcher_fee every order this site writes carries, lovelace. AT LEAST the batcher's own
   * settings `batcherFee`: the batcher skips any order allowing less (cardano/batcher src/select.ts),
   * and such an order waits until its owner cancels it.
   */
  batcherFeeLovelace: string;
  /** What a pool opening's two scripts may use, measured with the node's evaluator at the deploy, with headroom. */
  openPoolBudget: { factory: { mem: number; steps: number }; authen: { mem: number; steps: number } };
}

export declare const OWN_POOLS_DEPLOYMENT: OwnPoolsDeploymentRecord | null;
