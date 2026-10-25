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

/**
 * order_validation.ak is_valid_datum, for a script receiver. An inline datum is hashed from
 * Plutus's own serialisation of it on chain; this compares CSL's encoding of the same data,
 * so it is only trusted when the bytes we carry are the canonical ones (the builder refuses
 * inline-datum receivers it cannot reproduce).
 */
export function datumMatches(rule: ExtraOrderDatum, d: OutputDatum): boolean {
  if (rule.kind === 'none') return d.kind === 'none';
  if (rule.kind === 'hash') return d.kind === 'hash' && d.hash === rule.hash;
  return d.kind === 'inline' && CSL.hash_plutus_data(d.data).to_hex() === rule.hash;
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
