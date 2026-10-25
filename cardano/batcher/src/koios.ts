// Koios v1, the backup source (https://api.koios.rest/api/v1, the batcher's own key; never the
// site's). A db-sync database behind a REST API: a block or so behind the node, amounts as
// strings. UTxOs come back as JSON and are rebuilt here into the outputs the chain holds: same
// address, value, datum bytes and reference script.
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import type { ProtocolParams } from './build.ts';
import { MAINNET_TIME, type NetworkTime } from './chain.ts';
import { parseExact, stringifyExact } from './json.ts';
import { ogmiosEvaluator, SourceUnavailable, SubmitRefused, type Endpoint, type Tip } from './ogmios.ts';
import type { Evaluator } from './prepare.ts';
import type { ChainUtxo } from './view.ts';

export interface KoiosConfig {
  url: string;
  /** The batcher's own Koios key, sent as a bearer token. Never logged. */
  token?: string;
  timeoutMs?: number;
  time?: NetworkTime;
}

type Json = Record<string, unknown>;
const isObject = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);
const PAGE = 1000;

export class Koios {
  readonly #c: KoiosConfig;
  constructor(c: KoiosConfig) {
    this.#c = c;
  }

  async #call(path: string, body?: unknown, raw?: Uint8Array<ArrayBuffer>): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.#c.token) headers.authorization = `Bearer ${this.#c.token}`;
    if (raw) headers['content-type'] = 'application/cbor';
    else if (body !== undefined) headers['content-type'] = 'application/json';
    let status: number;
    let text: string;
    try {
      const res = await fetch(`${this.#c.url}${path}`, {
        method: body === undefined && !raw ? 'GET' : 'POST',
        headers,
        body: raw ?? (body === undefined ? undefined : stringifyExact(body)),
        signal: AbortSignal.timeout(this.#c.timeoutMs ?? 30_000),
      });
      status = res.status;
      text = await res.text();
    } catch (e) {
      throw new SourceUnavailable(`Koios ${path.split('?')[0]}: ${e instanceof Error ? e.message : String(e)}`);
    }
    // submittx answers 400 with the node's reason when the node refuses the transaction.
    if (raw && status === 400) {
      // cardano-submit-api's reason, in the ledger's own words.
      const benign = /BadInputsUTxO|OutsideValidityIntervalUTxO|UnknownUTxO/.test(text);
      throw new SubmitRefused(`Koios submittx: ${text.slice(0, 4000)}`, benign, /WithdrawalsNotInRewards|IncompleteWithdrawals/.test(text));
    }
    // submittx answers 202 with the id, quoted or not.
    if (raw && status >= 200 && status < 300 && /^[0-9a-f]{64}$/.test(text.trim())) return text.trim();
    if (status < 200 || status >= 300) throw new SourceUnavailable(`Koios ${path.split('?')[0]}: HTTP ${status}: ${text.slice(0, 300)}`);
    try {
      return parseExact(text);
    } catch {
      throw new SourceUnavailable(`Koios ${path.split('?')[0]}: not JSON: ${text.slice(0, 200)}`);
    }
  }

  /** Every page of a list endpoint, in a stable order. */
  async #all(path: string, body: unknown): Promise<Json[]> {
    const out: Json[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const sep = path.includes('?') ? '&' : '?';
      const page = await this.#call(`${path}${sep}order=block_height.asc,tx_hash.asc,tx_index.asc&offset=${offset}&limit=${PAGE}`, body);
      if (!Array.isArray(page)) throw new SourceUnavailable(`Koios ${path}: not a list`);
      out.push(...(page as Json[]));
      if (page.length < PAGE) return out;
    }
  }

  async tip(): Promise<Tip> {
    const r = await this.#call('/tip');
    const t = Array.isArray(r) ? r[0] : undefined;
    if (!isObject(t) || typeof t.hash !== 'string' || typeof t.abs_slot !== 'bigint') throw new SourceUnavailable('Koios: no tip');
    return { slot: t.abs_slot, id: t.hash };
  }

  async protocolParams(): Promise<ProtocolParams> {
    return protocolParamsFromKoios(await this.#call('/cli_protocol_params'));
  }

  /** Unspent outputs whose payment credential (key or script hash) is `cred`. */
  async utxosAtCredential(cred: string): Promise<ChainUtxo[]> {
    const items = await this.#all('/credential_utxos', { _payment_credentials: [cred], _extended: true });
    return items.filter((u) => u.is_spent !== true).map((u) => utxoFromKoios(u, this.#c.time));
  }

  /** Unspent outputs holding `policy.name`, optionally only at payment credential `cred`. */
  async utxosWithAsset(policy: string, name: string, cred?: string): Promise<ChainUtxo[]> {
    const filter = cred ? `?payment_cred=eq.${cred}` : '';
    const items = await this.#all(`/asset_utxos${filter}`, { _asset_list: [[policy, name]], _extended: true });
    return items.filter((u) => u.is_spent !== true).map((u) => utxoFromKoios(u, this.#c.time));
  }

  /** The outputs at these references that are still unspent (spent or unknown ones are left out). */
  async utxos(refs: string[]): Promise<ChainUtxo[]> {
    if (!refs.length) return [];
    const items = await this.#call('/utxo_info', { _utxo_refs: refs, _extended: true });
    if (!Array.isArray(items)) throw new SourceUnavailable('Koios utxo_info: not a list');
    return (items as Json[]).filter((u) => u.is_spent === false).map((u) => utxoFromKoios(u, this.#c.time));
  }

  /** The datum whose hash is `hash`, as its original bytes, or null if Koios has not seen it. */
  async datum(hash: string): Promise<string | null> {
    const r = await this.#call('/datum_info', { _datum_hashes: [hash] });
    const d = Array.isArray(r) ? r[0] : undefined;
    return isObject(d) && typeof d.bytes === 'string' ? d.bytes : null;
  }

  /** What a registered reward account holds; refuses an unregistered one (no batch can withdraw from it). */
  async rewardBalance(stakeAddress: string): Promise<bigint> {
    const r = await this.#call('/account_info', { _stake_addresses: [stakeAddress] });
    const a = Array.isArray(r) ? r[0] : undefined;
    if (!isObject(a) || a.status !== 'registered') throw new SourceUnavailable(`Koios: ${stakeAddress} is not a registered reward account`);
    return BigInt(String(a.rewards_available));
  }

  /** The transaction id; SubmitRefused with the node's reason. */
  async submit(txHex: string): Promise<string> {
    const r = await this.#call('/submittx', undefined, Buffer.from(txHex, 'hex'));
    if (typeof r !== 'string') throw new SourceUnavailable('Koios submittx: no transaction id');
    return r;
  }

  /** Confirmations of each transaction (0 or absent: not on chain as far as Koios knows). */
  async confirmations(txIds: string[]): Promise<Map<string, bigint>> {
    if (!txIds.length) return new Map();
    const r = await this.#call('/tx_status', { _tx_hashes: txIds });
    const out = new Map<string, bigint>();
    for (const t of Array.isArray(r) ? (r as Json[]) : []) if (typeof t.tx_hash === 'string' && typeof t.num_confirmations === 'bigint') out.set(t.tx_hash, t.num_confirmations);
    return out;
  }

  /** The node's own evaluator, through Koios's Ogmios proxy. */
  evaluator(): Evaluator {
    const ep: Endpoint = { url: `${this.#c.url}/ogmios`, headers: this.#c.token ? { authorization: `Bearer ${this.#c.token}` } : {}, timeoutMs: this.#c.timeoutMs ?? 60_000 };
    return ogmiosEvaluator(ep);
  }
}

export function protocolParamsFromKoios(r: unknown): ProtocolParams {
  if (!isObject(r) || !isObject(r.costModels) || !isObject(r.executionUnitPrices) || !isObject(r.maxTxExecutionUnits)) throw new SourceUnavailable('Koios: protocol parameters are missing fields');
  const n = (x: unknown, what: string) => {
    if (typeof x !== 'bigint') throw new SourceUnavailable(`Koios: ${what} is not an integer`);
    return Number(x);
  };
  const costs = (x: unknown, what: string) => {
    if (!Array.isArray(x)) throw new SourceUnavailable(`Koios: ${what} is not a list`);
    return x.map((v) => n(v, what));
  };
  const price = (x: unknown) => (typeof x === 'bigint' ? x.toString() : (x as number));
  const v3 = r.costModels.PlutusV3;
  return {
    txFeePerByte: n(r.txFeePerByte, 'txFeePerByte'),
    txFeeFixed: n(r.txFeeFixed, 'txFeeFixed'),
    utxoCostPerByte: n(r.utxoCostPerByte, 'utxoCostPerByte'),
    maxTxSize: n(r.maxTxSize, 'maxTxSize'),
    maxValueSize: n(r.maxValueSize, 'maxValueSize'),
    collateralPercentage: n(r.collateralPercentage, 'collateralPercentage'),
    executionUnitPrices: { priceMemory: price(r.executionUnitPrices.priceMemory), priceSteps: price(r.executionUnitPrices.priceSteps) },
    minFeeRefScriptCostPerByte: price(r.minFeeRefScriptCostPerByte),
    stakeAddressDeposit: n(r.stakeAddressDeposit, 'stakeAddressDeposit'),
    stakePoolDeposit: n(r.stakePoolDeposit, 'stakePoolDeposit'),
    costModelPlutusV2: costs(r.costModels.PlutusV2, 'PlutusV2 cost model'),
    ...(v3 === undefined ? {} : { costModelPlutusV3: costs(v3, 'PlutusV3 cost model') }),
    maxTxExecutionUnits: { memory: n(r.maxTxExecutionUnits.memory, 'max memory'), steps: n(r.maxTxExecutionUnits.steps, 'max steps') },
  };
}

const SCRIPT_LANGUAGE: Record<string, () => CSL.Language> = {
  plutusV1: () => CSL.Language.new_plutus_v1(),
  plutusV2: () => CSL.Language.new_plutus_v2(),
  plutusV3: () => CSL.Language.new_plutus_v3(),
};

/** An amount as Koios sends it: a string of digits today; lovelace becomes a number in v1.5 (read exactly). */
const amount = (x: unknown): string | null => (typeof x === 'bigint' && x >= 0n ? x.toString() : typeof x === 'string' && /^\d+$/.test(x) ? x : null);

/** One Koios UTxO (with `_extended`) as the output the chain holds. */
export function utxoFromKoios(u: Json, time: NetworkTime = MAINNET_TIME): ChainUtxo {
  const ref = `${String(u.tx_hash)}#${String(u.tx_index)}`;
  const fail = (what: string): never => {
    throw new SourceUnavailable(`Koios: ${ref}: ${what}`);
  };
  if (typeof u.tx_hash !== 'string' || typeof u.tx_index !== 'bigint' || typeof u.address !== 'string') fail('no reference or address');
  const ma = CSL.MultiAsset.new();
  for (const a of Array.isArray(u.asset_list) ? (u.asset_list as Json[]) : []) {
    const q = amount(a.quantity);
    if (typeof a.policy_id !== 'string' || typeof a.asset_name !== 'string' || q === null) fail('an unreadable asset');
    const policy = CSL.ScriptHash.from_hex(a.policy_id as string);
    const assets = ma.get(policy) ?? CSL.Assets.new();
    assets.insert(CSL.AssetName.new(Buffer.from(a.asset_name as string, 'hex')), CSL.BigNum.from_str(q as string));
    ma.insert(policy, assets);
  }
  const coin = CSL.BigNum.from_str(amount(u.value) ?? fail('an unreadable value'));
  const value = ma.len() ? CSL.Value.new_with_assets(coin, ma) : CSL.Value.new(coin);
  const o = CSL.TransactionOutput.new(CSL.Address.from_bech32(u.address as string), value);
  // Koios gives the hash of an inline datum too: inline when the bytes are there, else hash only.
  const inline = isObject(u.inline_datum) ? u.inline_datum.bytes : null;
  if (typeof inline === 'string') o.set_plutus_data(CSL.PlutusData.from_hex(inline));
  else if (typeof u.datum_hash === 'string') o.set_data_hash(CSL.DataHash.from_hex(u.datum_hash));
  if (isObject(u.reference_script)) {
    const rs = u.reference_script;
    if (typeof rs.bytes !== 'string') fail('a reference script without its bytes');
    const lang = SCRIPT_LANGUAGE[String(rs.type)];
    if (lang) o.set_script_ref(CSL.ScriptRef.new_plutus_script(CSL.PlutusScript.new_with_version(Buffer.from(rs.bytes as string, 'hex'), lang())));
    else if (rs.type === 'timelock' || rs.type === 'multisig') o.set_script_ref(CSL.ScriptRef.new_native_script(CSL.NativeScript.from_hex(rs.bytes as string)));
    else fail(`a reference script of type ${String(rs.type)}`);
  }
  if (typeof u.block_time !== 'bigint') fail('no block time');
  const slot = time.zeroSlot + ((u.block_time as bigint) * 1000n - time.zeroTimeMs) / time.slotLengthMs;
  return { ref, outputHex: o.to_hex(), createdSlot: slot, createdTxIndex: null };
}
