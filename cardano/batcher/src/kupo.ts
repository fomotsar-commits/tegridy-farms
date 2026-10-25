// Kupo v2, the primary source of UTxOs (hosted on Demeter, which indexes everything: --match *).
// Its JSON is rebuilt here into the outputs the chain holds. Read from Kupo's own source
// (v2.12.0): quantities are JSON numbers of any size (read exactly, src/json.ts); flags are bare
// (`?unspent`, never `?unspent=`, which Kupo refuses); a query Kupo does not index answers `[]`,
// exactly like "nothing there", so coverage is checked before any query is trusted; a broken body
// is unreadable, never empty. Each answer says how far Kupo has indexed (X-Most-Recent-Checkpoint):
// one round's answers must all come from the same point, at the node's tip.
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { parseExact } from './json.ts';
import { SourceUnavailable } from './ogmios.ts';
import type { ChainUtxo } from './view.ts';

export interface KupoConfig {
  url: string;
  /** Sent with every request, e.g. { 'dmtr-api-key': ... } for Demeter. Never logged. */
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

type Json = Record<string, unknown>;
const isObject = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);

export interface KupoHealth {
  connected: boolean;
  checkpoint: bigint | null;
  nodeTip: bigint | null;
  indexesInstalled: boolean;
  version: string;
}

export class Kupo {
  readonly #c: KupoConfig;
  /** The checkpoint of the last answer read (X-Most-Recent-Checkpoint). */
  lastCheckpoint: bigint | null = null;
  constructor(c: KupoConfig) {
    this.#c = c;
  }

  async #get(path: string): Promise<unknown> {
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${this.#c.url}${path}`, {
        headers: { accept: 'application/json;asset-quantity=string', ...this.#c.headers },
        signal: AbortSignal.timeout(this.#c.timeoutMs ?? 30_000),
      });
      text = await res.text();
    } catch (e) {
      throw new SourceUnavailable(`Kupo ${path.split('?')[0]}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status !== 200) throw new SourceUnavailable(`Kupo ${path.split('?')[0]}: HTTP ${res.status}: ${text.slice(0, 300)}`);
    const checkpoint = res.headers.get('x-most-recent-checkpoint');
    this.lastCheckpoint = checkpoint && /^\d+$/.test(checkpoint) ? BigInt(checkpoint) : null;
    try {
      return parseExact(text);
    } catch {
      // Kupo writes 200 and the opening bracket before it reads: a failure after that is a broken body.
      throw new SourceUnavailable(`Kupo ${path.split('?')[0]}: an unreadable answer (${text.length} bytes)`);
    }
  }

  async health(): Promise<KupoHealth> {
    let res: Response;
    let text: string;
    try {
      // Without "application/json" Kupo answers /health in Prometheus text (Node's fetch sends */*).
      res = await fetch(`${this.#c.url}/health`, { headers: { accept: 'application/json', ...this.#c.headers }, signal: AbortSignal.timeout(this.#c.timeoutMs ?? 30_000) });
      text = await res.text();
    } catch (e) {
      throw new SourceUnavailable(`Kupo /health: ${e instanceof Error ? e.message : String(e)}`);
    }
    let h: unknown;
    try {
      h = parseExact(text);
    } catch {
      throw new SourceUnavailable(`Kupo /health: HTTP ${res.status}, not JSON`);
    }
    if (!isObject(h)) throw new SourceUnavailable('Kupo /health: not an object');
    const slot = (x: unknown) => (typeof x === 'bigint' ? x : null);
    return {
      connected: h.connection_status === 'connected',
      checkpoint: slot(h.most_recent_checkpoint),
      nodeTip: slot(h.most_recent_node_tip),
      indexesInstalled: isObject(h.configuration) && h.configuration.indexes === 'installed',
      version: String(h.version ?? 'unknown'),
    };
  }

  /** Whether Kupo indexes `pattern` (GET /patterns/{pattern}: the configured patterns covering it). */
  async covers(pattern: string): Promise<boolean> {
    const r = await this.#get(`/patterns/${pattern}`);
    if (!Array.isArray(r)) throw new SourceUnavailable('Kupo /patterns: not a list');
    return r.length > 0;
  }

  /** Unspent outputs matching `pattern`, with their datums and reference scripts resolved. */
  async unspent(pattern: string, filter = ''): Promise<ChainUtxo[]> {
    const r = await this.#get(`/matches/${pattern}?unspent&resolve_hashes${filter}`);
    if (!Array.isArray(r)) throw new SourceUnavailable('Kupo /matches: not a list');
    return (r as unknown[]).map((m) => utxoFromKupo(m));
  }

  /** A datum by its hash: the original bytes, or null if Kupo has not seen it. */
  async datum(hash: string): Promise<string | null> {
    const r = await this.#get(`/datums/${hash}`);
    if (r === null) return null;
    if (!isObject(r) || typeof r.datum !== 'string') throw new SourceUnavailable('Kupo /datums: unreadable');
    return r.datum;
  }
}

/**
 * Refuses a Kupo that would answer "nothing there" for what it does not hold: it must be
 * connected, have its indexes built (queries scan the whole table until then), and index every
 * pattern the batcher asks about.
 */
export async function checkKupoReady(k: Kupo, patterns: string[]): Promise<void> {
  const h = await k.health();
  if (!h.connected) throw new Error('Kupo is not connected to its node');
  if (!h.indexesInstalled) throw new Error('Kupo has not built its indexes yet');
  for (const p of patterns) if (!(await k.covers(p))) throw new Error(`Kupo does not index ${p}: it would answer [] for it, as if nothing were there`);
}

const quantity = (x: unknown, what: string): string => {
  if (typeof x === 'bigint' && x >= 0n) return x.toString();
  if (typeof x === 'string' && /^\d+$/.test(x)) return x;
  throw new SourceUnavailable(`Kupo: ${what} is not a quantity`);
};

const LANGUAGE: Record<string, () => CSL.Language> = {
  'plutus:v1': () => CSL.Language.new_plutus_v1(),
  'plutus:v2': () => CSL.Language.new_plutus_v2(),
  'plutus:v3': () => CSL.Language.new_plutus_v3(),
};

/** One Kupo match (with resolve_hashes) as the output the chain holds. */
export function utxoFromKupo(m: unknown): ChainUtxo {
  if (!isObject(m) || typeof m.transaction_id !== 'string' || typeof m.output_index !== 'bigint' || typeof m.address !== 'string') throw new SourceUnavailable('Kupo: a match without a reference or address');
  const ref = `${m.transaction_id}#${m.output_index}`;
  const fail = (what: string): never => {
    throw new SourceUnavailable(`Kupo: ${ref}: ${what}`);
  };
  if (m.spent_at !== null && m.spent_at !== undefined) fail('spent (asked for unspent outputs only)');
  const v = m.value;
  if (!isObject(v) || !isObject(v.assets)) fail('no value');
  const val = v as Json;
  const ma = CSL.MultiAsset.new();
  for (const [unit, q] of Object.entries(val.assets as Json)) {
    // "policy.name", or "policy" alone for an empty asset name.
    const [policy, name = ''] = unit.split('.') as [string, string?];
    if (!/^[0-9a-f]{56}$/.test(policy) || !/^([0-9a-f]{2}){0,32}$/.test(name)) fail(`an unreadable asset ${unit}`);
    const p = CSL.ScriptHash.from_hex(policy);
    const assets = ma.get(p) ?? CSL.Assets.new();
    assets.insert(CSL.AssetName.new(Buffer.from(name, 'hex')), CSL.BigNum.from_str(quantity(q, unit)));
    ma.insert(p, assets);
  }
  const coin = CSL.BigNum.from_str(quantity(val.coins, 'coins'));
  const o = CSL.TransactionOutput.new(CSL.Address.from_bech32(m.address), ma.len() ? CSL.Value.new_with_assets(coin, ma) : CSL.Value.new(coin));
  let witnessDatum: string | undefined;
  if (typeof m.datum_hash === 'string') {
    if (m.datum_type === 'inline') {
      if (typeof m.datum !== 'string') fail('an inline datum Kupo did not resolve');
      const data = CSL.PlutusData.from_hex(m.datum as string);
      if (CSL.hash_plutus_data(data).to_hex() !== m.datum_hash) fail('an inline datum whose bytes do not hash to its hash');
      o.set_plutus_data(data);
    } else if (m.datum_type === 'hash') {
      o.set_data_hash(CSL.DataHash.from_hex(m.datum_hash));
      // resolve_hashes sends the datum along when Kupo has seen it in a witness.
      if (typeof m.datum === 'string') {
        if (CSL.hash_plutus_data(CSL.PlutusData.from_hex(m.datum)).to_hex() !== m.datum_hash) fail('a datum whose bytes do not hash to its hash');
        witnessDatum = m.datum;
      }
    }
    else fail(`a datum of type ${String(m.datum_type)}`);
  }
  if (typeof m.script_hash === 'string') {
    if (!isObject(m.script) || typeof m.script.script !== 'string') fail('a reference script Kupo did not resolve');
    const s = m.script as Json;
    const lang = LANGUAGE[String(s.language)];
    const sr = lang
      ? CSL.ScriptRef.new_plutus_script(CSL.PlutusScript.new_with_version(Buffer.from(s.script as string, 'hex'), lang()))
      : s.language === 'native'
        ? CSL.ScriptRef.new_native_script(CSL.NativeScript.from_hex(s.script as string))
        : fail(`a reference script in ${String(s.language)}`);
    const hash = sr.is_plutus_script() ? sr.plutus_script()!.hash().to_hex() : sr.native_script()!.hash().to_hex();
    if (hash !== m.script_hash) fail('a reference script whose bytes do not hash to its hash');
    o.set_script_ref(sr);
  }
  const created = m.created_at;
  if (!isObject(created) || typeof created.slot_no !== 'bigint') fail('no creation point');
  return {
    ref,
    outputHex: o.to_hex(),
    createdSlot: (created as Json).slot_no as bigint,
    createdTxIndex: typeof m.transaction_index === 'bigint' ? Number(m.transaction_index) : null,
    ...(witnessDatum ? { witnessDatum } : {}),
  };
}
