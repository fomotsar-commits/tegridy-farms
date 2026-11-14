// Koios v1, the backup source (https://api.koios.rest/api/v1, the batcher's own key; never the
// site's). A db-sync database behind a REST API: a block or so behind the node, amounts as
// strings. UTxOs come back as JSON and are rebuilt here into the outputs the chain holds: same
// address, value, datum bytes and reference script, each hash checked against its bytes, and
// anything nested deeper than src/cbor.ts allows refused before EMURGO's library sees it. One
// unreadable UTxO is left out with its reason (`onRefused`); it never fails the whole read. One
// EMURGO's library breaks on is named (LibraryTrapped); one an earlier process named is never
// decoded again (`skip`).
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import type { ProtocolParams } from './build.ts';
import { MAINNET_TIME, type NetworkTime } from './chain.ts';
import { blaming, isWasmTrap, shallowCbor } from './cbor.ts';
import { parseExact, stringifyExact } from './json.ts';
import { ogmiosEvaluator, protocolParamsFromOgmios, rpc, SourceUnavailable, SubmitRefused, type Endpoint, type Tip } from './ogmios.ts';
import type { Evaluator } from './prepare.ts';
import type { ChainUtxo } from './view.ts';

export interface KoiosConfig {
  url: string;
  /** The batcher's own Koios key, sent as a bearer token. Never logged. */
  token?: string;
  timeoutMs?: number;
  time?: NetworkTime;
  /** Told of every UTxO left out because it could not be read, and why. */
  onRefused?: (ref: string, reason: string) => void;
  /** UTxOs never decoded: EMURGO's library broke on them before. */
  skip?: (ref: string) => boolean;
}

type Json = Record<string, unknown>;
const isObject = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);
const PAGE = 1000;

export class Koios {
  readonly #c: KoiosConfig;
  constructor(c: KoiosConfig) {
    this.#c = c;
  }

  #headers(extra: Record<string, string>): Record<string, string> {
    return { accept: 'application/json', ...extra, ...(this.#c.token ? { authorization: `Bearer ${this.#c.token}` } : {}) };
  }

  async #fetch(path: string, init: RequestInit): Promise<{ status: number; text: string; headers: Headers }> {
    try {
      const res = await fetch(`${this.#c.url}${path}`, { ...init, signal: AbortSignal.timeout(this.#c.timeoutMs ?? 30_000) });
      return { status: res.status, text: await res.text(), headers: res.headers };
    } catch (e) {
      throw new SourceUnavailable(`Koios ${path.split('?')[0]}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  #json(path: string, status: number, text: string): unknown {
    if (status < 200 || status >= 300) throw new SourceUnavailable(`Koios ${path.split('?')[0]}: HTTP ${status}: ${text.slice(0, 300)}`);
    try {
      return parseExact(text);
    } catch {
      throw new SourceUnavailable(`Koios ${path.split('?')[0]}: not JSON: ${text.slice(0, 200)}`);
    }
  }

  async #call(path: string, body?: unknown): Promise<unknown> {
    const r = await this.#fetch(path, body === undefined ? { headers: this.#headers({}) } : { method: 'POST', headers: this.#headers({ 'content-type': 'application/json' }), body: stringifyExact(body) });
    return this.#json(path, r.status, r.text);
  }

  /**
   * Every page of a list endpoint, in a stable order. The total is asked for (Prefer: count=exact)
   * and paging goes on until it is reached, so a server capping pages below 1,000 loses nothing.
   */
  async #all(path: string, body: unknown): Promise<Json[]> {
    const out: Json[] = [];
    for (let offset = 0; ; ) {
      const sep = path.includes('?') ? '&' : '?';
      const p = `${path}${sep}order=block_height.asc,tx_hash.asc,tx_index.asc&offset=${offset}&limit=${PAGE}`;
      const r = await this.#fetch(p, { method: 'POST', headers: this.#headers({ 'content-type': 'application/json', prefer: 'count=exact' }), body: stringifyExact(body) });
      const page = this.#json(p, r.status, r.text);
      if (!Array.isArray(page)) throw new SourceUnavailable(`Koios ${path.split('?')[0]}: not a list`);
      const total = /\/(\d+)$/.exec(r.headers.get('content-range') ?? '');
      out.push(...(page as Json[]));
      offset += page.length;
      if (page.length === 0 || (total ? offset >= Number(total[1]) : page.length < PAGE)) return out;
    }
  }

  /** Rebuilds each item; one that cannot be read is left out and reported, never the whole list. */
  #rebuild(items: Json[]): ChainUtxo[] {
    const out: ChainUtxo[] = [];
    for (const u of items) {
      const ref = `${String(u.tx_hash)}#${String(u.tx_index)}`;
      if (this.#c.skip?.(ref)) continue;
      try {
        out.push(blaming([ref], () => utxoFromKoios(u, this.#c.time)));
      } catch (e) {
        if (!(e instanceof SourceUnavailable)) throw e;
        this.#c.onRefused?.(ref, e.message);
      }
    }
    return out;
  }

  #ogmios(): Endpoint {
    return { url: `${this.#c.url}/ogmios`, headers: this.#c.token ? { authorization: `Bearer ${this.#c.token}` } : {}, timeoutMs: this.#c.timeoutMs ?? 60_000 };
  }

  async tip(): Promise<Tip> {
    const r = await this.#call('/tip');
    const t = Array.isArray(r) ? r[0] : undefined;
    if (!isObject(t) || typeof t.hash !== 'string' || typeof t.abs_slot !== 'bigint') throw new SourceUnavailable('Koios: no tip');
    return { slot: t.abs_slot, id: t.hash };
  }

  /** From Koios's Ogmios proxy: the node's own parameters, prices exact ("n/d"). */
  async protocolParams(): Promise<ProtocolParams> {
    return protocolParamsFromOgmios(await rpc(this.#ogmios(), 'queryLedgerState/protocolParameters'));
  }

  /** Unspent outputs whose payment credential (key or script hash) is `cred`. */
  async utxosAtCredential(cred: string): Promise<ChainUtxo[]> {
    const items = await this.#all('/credential_utxos', { _payment_credentials: [cred], _extended: true });
    return this.#rebuild(items.filter((u) => u.is_spent !== true));
  }

  /** Unspent outputs holding `policy.name`, optionally only at payment credential `cred`. */
  async utxosWithAsset(policy: string, name: string, cred?: string): Promise<ChainUtxo[]> {
    const filter = cred ? `?payment_cred=eq.${cred}` : '';
    const items = await this.#all(`/asset_utxos${filter}`, { _asset_list: [[policy, name]], _extended: true });
    return this.#rebuild(items.filter((u) => u.is_spent !== true));
  }

  /** The outputs at these references that are still unspent (spent or unknown ones are left out). */
  async utxos(refs: string[]): Promise<ChainUtxo[]> {
    if (!refs.length) return [];
    const items = await this.#call('/utxo_info', { _utxo_refs: refs, _extended: true });
    if (!Array.isArray(items)) throw new SourceUnavailable('Koios utxo_info: not a list');
    return this.#rebuild((items as Json[]).filter((u) => u.is_spent === false));
  }

  /** The datum whose hash is `hash`, as its original bytes, or null if Koios has not seen it. */
  async datum(hash: string): Promise<string | null> {
    const r = await this.#call('/datum_info', { _datum_hashes: [hash] });
    if (!Array.isArray(r)) throw new SourceUnavailable('Koios datum_info: not a list');
    const d = r[0];
    return isObject(d) && typeof d.bytes === 'string' ? d.bytes : null;
  }

  /** What a registered reward account holds; refuses an unregistered one (no batch can withdraw from it). */
  async rewardBalance(stakeAddress: string): Promise<bigint> {
    const r = await this.#call('/account_info', { _stake_addresses: [stakeAddress] });
    const a = Array.isArray(r) ? r[0] : undefined;
    if (!isObject(a) || a.status !== 'registered') throw new SourceUnavailable(`Koios: ${stakeAddress} is not a registered reward account`);
    const q = amount(a.rewards_available);
    if (q === null) throw new SourceUnavailable(`Koios: ${stakeAddress}: no readable rewards_available`);
    return BigInt(q);
  }

  /** The transaction id; SubmitRefused with the node's reason (cardano-submit-api, HTTP 400). */
  async submit(txHex: string): Promise<string> {
    const r = await this.#fetch('/submittx', { method: 'POST', headers: this.#headers({ 'content-type': 'application/cbor' }), body: Buffer.from(txHex, 'hex') });
    if (r.status === 400) {
      // The ledger's own words: an input gone or the window passed is normal, a withdrawal names the account.
      const benign = /BadInputsUTxO|OutsideValidityIntervalUTxO|UnknownUTxO/.test(r.text);
      throw new SubmitRefused(`Koios submittx: ${r.text.slice(0, 4000)}`, benign, /WithdrawalsNotInRewards|IncompleteWithdrawals/.test(r.text));
    }
    // 202 with the id, quoted or not; anything else may or may not have reached the node.
    if (r.status >= 200 && r.status < 300 && /^[0-9a-f]{64}$/.test(r.text.trim())) return r.text.trim();
    const id = this.#json('/submittx', r.status, r.text);
    if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) throw new SourceUnavailable('Koios submittx: no transaction id');
    return id;
  }

  /** The node's own evaluator, through Koios's Ogmios proxy. */
  evaluator(): Evaluator {
    return ogmiosEvaluator(this.#ogmios());
  }
}

const SCRIPT_LANGUAGE: Record<string, () => CSL.Language> = {
  plutusV1: () => CSL.Language.new_plutus_v1(),
  plutusV2: () => CSL.Language.new_plutus_v2(),
  plutusV3: () => CSL.Language.new_plutus_v3(),
};

/** An amount as Koios sends it: a string of digits today; lovelace becomes a number in v1.5 (read exactly). */
const amount = (x: unknown): string | null => (typeof x === 'bigint' && x >= 0n ? x.toString() : typeof x === 'string' && /^\d+$/.test(x) ? x : null);

/** One Koios UTxO (with `_extended`) as the output the chain holds, or SourceUnavailable saying why not. */
export function utxoFromKoios(u: Json, time: NetworkTime = MAINNET_TIME): ChainUtxo {
  const ref = `${String(u.tx_hash)}#${String(u.tx_index)}`;
  const fail = (what: string): never => {
    throw new SourceUnavailable(`Koios: ${ref}: ${what}`);
  };
  if (typeof u.tx_hash !== 'string' || typeof u.tx_index !== 'bigint' || typeof u.address !== 'string') fail('no reference or address');
  // With _extended the list is always there ([] for ADA only); null means Koios did not say, never "no tokens".
  if (!Array.isArray(u.asset_list)) fail('no asset list (asked without _extended?)');
  const inline = isObject(u.inline_datum) ? u.inline_datum.bytes : null;
  if (typeof inline === 'string' && !shallowCbor(inline)) fail('a datum nested too deep to read safely');
  const rs = isObject(u.reference_script) ? u.reference_script : null;
  if (rs && (typeof rs.bytes !== 'string' || !shallowCbor(rs.bytes))) fail('a reference script without readable bytes');
  if (typeof u.block_time !== 'bigint') fail('no block time');
  try {
    const ma = CSL.MultiAsset.new();
    for (const a of u.asset_list as Json[]) {
      const q = amount(a.quantity);
      if (typeof a.policy_id !== 'string' || typeof a.asset_name !== 'string' || q === null) fail('an unreadable asset');
      const policy = CSL.ScriptHash.from_hex(a.policy_id as string);
      const assets = ma.get(policy) ?? CSL.Assets.new();
      assets.insert(CSL.AssetName.new(Buffer.from(a.asset_name as string, 'hex')), CSL.BigNum.from_str(q as string));
      ma.insert(policy, assets);
    }
    const coin = CSL.BigNum.from_str(amount(u.value) ?? fail('an unreadable value'));
    const o = CSL.TransactionOutput.new(CSL.Address.from_bech32(u.address as string), ma.len() ? CSL.Value.new_with_assets(coin, ma) : CSL.Value.new(coin));
    // Koios gives the hash of an inline datum too: inline when the bytes are there, else hash only.
    if (typeof inline === 'string') {
      const data = CSL.PlutusData.from_hex(inline);
      if (typeof u.datum_hash === 'string' && CSL.hash_plutus_data(data).to_hex() !== u.datum_hash) fail('an inline datum whose bytes do not hash to its hash');
      o.set_plutus_data(data);
    } else if (typeof u.datum_hash === 'string') o.set_data_hash(CSL.DataHash.from_hex(u.datum_hash));
    if (rs) {
      const lang = SCRIPT_LANGUAGE[String(rs.type)];
      const sr = lang
        ? CSL.ScriptRef.new_plutus_script(CSL.PlutusScript.new_with_version(Buffer.from(rs.bytes as string, 'hex'), lang()))
        : rs.type === 'timelock' || rs.type === 'multisig'
          ? CSL.ScriptRef.new_native_script(CSL.NativeScript.from_hex(rs.bytes as string))
          : fail(`a reference script of type ${String(rs.type)}`);
      const hash = sr.is_plutus_script() ? sr.plutus_script()!.hash().to_hex() : sr.native_script()!.hash().to_hex();
      if (typeof rs.hash === 'string' && hash !== rs.hash) fail('a reference script whose bytes do not hash to its hash');
      o.set_script_ref(sr);
    }
    const slot = time.zeroSlot + ((u.block_time as bigint) * 1000n - time.zeroTimeMs) / time.slotLengthMs;
    return { ref, outputHex: o.to_hex(), createdSlot: slot, createdTxIndex: null };
  } catch (e) {
    if (e instanceof SourceUnavailable || isWasmTrap(e)) throw e;
    // EMURGO throws bare strings for what it cannot hold (a 33-byte asset name...): this UTxO is unreadable.
    return fail(`unreadable (${e instanceof Error ? e.message : String(e)})`);
  }
}
