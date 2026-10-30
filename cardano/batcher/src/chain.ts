// Reading transactions and outputs (EMURGO's CSL objects) into the contract's terms.
import CSL from '@emurgo/cardano-serialization-lib-nodejs';
import { DecodeError, type PlutusData } from './plutus.ts';
import type { Address, Asset, Credential, ExtraOrderDatum } from './types.ts';
import { add, type Value } from './value.ts';

function credentialFromCsl(c: CSL.Credential): Credential {
  const key = c.to_keyhash();
  if (key) return { kind: 'key', hash: key.to_hex() };
  const script = c.to_scripthash();
  if (script) return { kind: 'script', hash: script.to_hex() };
  throw new DecodeError('a credential that is neither a key nor a script');
}

/** A Shelley address as the contract sees it: payment credential and stake part. Byron is refused. */
export function addressFromCsl(a: CSL.Address): Address {
  const base = CSL.BaseAddress.from_address(a);
  if (base) return { payment: credentialFromCsl(base.payment_cred()), stake: { kind: 'inline', credential: credentialFromCsl(base.stake_cred()) } };
  const enterprise = CSL.EnterpriseAddress.from_address(a);
  if (enterprise) return { payment: credentialFromCsl(enterprise.payment_cred()), stake: null };
  const pointer = CSL.PointerAddress.from_address(a);
  if (pointer) {
    const p = pointer.stake_pointer();
    return {
      payment: credentialFromCsl(pointer.payment_cred()),
      stake: { kind: 'pointer', slot: BigInt(p.slot_bignum().to_str()), txIndex: BigInt(p.tx_index_bignum().to_str()), certIndex: BigInt(p.cert_index_bignum().to_str()) },
    };
  }
  throw new DecodeError(`an address the contract cannot hold: ${a.to_bech32(undefined)}`);
}

export function valueFromCsl(v: CSL.Value): Value {
  let out: Value = add(new Map(), { policyId: '', assetName: '' }, BigInt(v.coin().to_str()));
  const ma = v.multiasset();
  if (!ma) return out;
  const policies = ma.keys();
  for (let i = 0; i < policies.len(); i++) {
    const policy = policies.get(i);
    const assets = ma.get(policy)!;
    const names = assets.keys();
    for (let j = 0; j < names.len(); j++) {
      const name = names.get(j);
      const asset: Asset = { policyId: policy.to_hex(), assetName: Buffer.from(name.name()).toString('hex') };
      out = add(out, asset, BigInt(assets.get(name)!.to_str()));
    }
  }
  return out;
}

export type OutputDatum = { kind: 'none' } | { kind: 'hash'; hash: string } | { kind: 'inline'; data: PlutusData };

export function outputDatum(o: CSL.TransactionOutput): OutputDatum {
  const inline = o.plutus_data();
  if (inline) return { kind: 'inline', data: inline };
  const hash = o.data_hash();
  if (hash) return { kind: 'hash', hash: hash.to_hex() };
  return { kind: 'none' };
}

// ---- Plutus's own serialisation of Data (builtin serialise_data) ----
// plutus-core PlutusCore.Data encodeData: Constr i -> tag 121+i (i < 7), tag 1280+(i-7)
// (i < 128), else tag 102 [i, fields]; lists definite when empty, indefinite otherwise; maps
// definite; integers as CBOR ints, past 64 bits as bignum tags 2/3; byte strings definite up to
// 64 bytes, else indefinite in 64-byte chunks. CSL keeps whatever bytes data arrived in, so a
// hash of CSL's bytes is not what the contract computes.

function head(major: number, n: bigint): number[] {
  const m = major << 5;
  if (n < 24n) return [m | Number(n)];
  if (n < 0x100n) return [m | 24, Number(n)];
  if (n < 0x10000n) return [m | 25, Number(n >> 8n), Number(n & 0xffn)];
  if (n < 0x100000000n) return [m | 26, ...[24n, 16n, 8n, 0n].map((s) => Number((n >> s) & 0xffn))];
  return [m | 27, ...[56n, 48n, 40n, 32n, 24n, 16n, 8n, 0n].map((s) => Number((n >> s) & 0xffn))];
}

function encBytes(b: Uint8Array): number[] {
  if (b.length <= 64) return [...head(2, BigInt(b.length)), ...b];
  const out = [0x5f];
  for (let i = 0; i < b.length; i += 64) {
    const chunk = b.subarray(i, i + 64);
    out.push(...head(2, BigInt(chunk.length)), ...chunk);
  }
  out.push(0xff);
  return out;
}

function encInteger(n: bigint): number[] {
  const U64 = 1n << 64n;
  if (n >= 0n && n < U64) return head(0, n);
  if (n < 0n && -1n - n < U64) return head(1, -1n - n);
  const mag = n >= 0n ? n : -1n - n;
  let hex = mag.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return [...head(6, n >= 0n ? 2n : 3n), ...encBytes(Buffer.from(hex, 'hex'))];
}

function encList(items: PlutusData[]): number[] {
  if (items.length === 0) return [0x80];
  return [0x9f, ...items.flatMap(encData), 0xff];
}

function encData(d: PlutusData): number[] {
  switch (d.kind()) {
    case 0: {
      const c = d.as_constr_plutus_data()!;
      const alt = BigInt(c.alternative().to_str());
      const fields: PlutusData[] = [];
      for (let i = 0; i < c.data().len(); i++) fields.push(c.data().get(i));
      if (alt < 7n) return [...head(6, 121n + alt), ...encList(fields)];
      if (alt < 128n) return [...head(6, 1280n + alt - 7n), ...encList(fields)];
      return [...head(6, 102n), 0x82, ...encInteger(alt), ...encList(fields)];
    }
    case 1: {
      const m = d.as_map()!;
      const keys = m.keys();
      const out = head(5, BigInt(keys.len()));
      for (let i = 0; i < keys.len(); i++) {
        const k = keys.get(i);
        const vals = m.get(k)!;
        if (vals.len() !== 1) throw new DecodeError('a map with a repeated key');
        out.push(...encData(k), ...encData(vals.get(0)!));
      }
      return out;
    }
    case 2: {
      const l = d.as_list()!;
      const items: PlutusData[] = [];
      for (let i = 0; i < l.len(); i++) items.push(l.get(i));
      return encList(items);
    }
    case 3:
      return encInteger(BigInt(d.as_integer()!.to_str()));
    case 4:
      return encBytes(d.as_bytes()!);
    default:
      throw new DecodeError('unknown Plutus data kind');
  }
}

/** builtin serialise_data: the bytes the contract hashes. */
export function plutusSerialise(d: PlutusData): Uint8Array {
  return Uint8Array.from(encData(d));
}

/** blake2b-256 of builtin serialise_data, as is_valid_datum computes it on chain. */
export function plutusDataHash(d: PlutusData): string {
  return CSL.hash_plutus_data(CSL.PlutusData.from_bytes(plutusSerialise(d))).to_hex();
}

/**
 * order_validation.ak is_valid_datum, for a script receiver: an inline datum is hashed from
 * Plutus's own serialisation of it, never from the bytes it arrived in.
 */
export function datumMatches(rule: ExtraOrderDatum, d: OutputDatum): boolean {
  if (rule.kind === 'none') return d.kind === 'none';
  if (rule.kind === 'hash') return d.kind === 'hash' && d.hash === rule.hash;
  return d.kind === 'inline' && plutusDataHash(d.data) === rule.hash;
}

/** "txhash#index", the key spent outputs are looked up by. */
export const refKey = (i: CSL.TransactionInput): string => `${i.transaction_id().to_hex()}#${i.index()}`;

/** The ledger's input order (and the script context's): by transaction id bytes, then index. */
export function ledgerOrder(inputs: CSL.TransactionInputs | undefined): CSL.TransactionInput[] {
  const out: CSL.TransactionInput[] = [];
  for (let i = 0; inputs && i < inputs.len(); i++) out.push(inputs.get(i));
  return out.sort((a, b) => {
    const x = a.transaction_id().to_hex();
    const y = b.transaction_id().to_hex();
    return x < y ? -1 : x > y ? 1 : a.index() - b.index();
  });
}

/** Mainnet Shelley time: slot 4,492,800 began at POSIX 1,596,059,091 s, one slot a second since. */
export const MAINNET_TIME = { zeroSlot: 4_492_800n, zeroTimeMs: 1_596_059_091_000n, slotLengthMs: 1_000n };
export type NetworkTime = typeof MAINNET_TIME;

export function slotToPosixMs(slot: bigint, t: NetworkTime = MAINNET_TIME): bigint {
  return (slot - t.zeroSlot) * t.slotLengthMs + t.zeroTimeMs;
}
