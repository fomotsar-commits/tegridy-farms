// Reading and writing Plutus data (the contracts' datums and redeemers) through EMURGO's
// cardano-serialization-lib. Every reader fails loudly on a shape it does not expect: a datum
// the batcher misreads must stop the batch, never be guessed at.
import CSL from '@emurgo/cardano-serialization-lib-nodejs';

export type PlutusData = CSL.PlutusData;

export class DecodeError extends Error {
  constructor(what: string) {
    super(`unreadable Plutus data: ${what}`);
  }
}

const KIND = { constr: 0, map: 1, list: 2, integer: 3, bytes: 4 } as const;

/** A constructor: its index (CBOR tags 121-127 and 1280+ both come back as the plain index) and fields. */
export function constr(d: PlutusData, what: string): { alt: number; fields: PlutusData[] } {
  if (d.kind() !== KIND.constr) throw new DecodeError(`${what} is not a constructor`);
  const c = d.as_constr_plutus_data()!;
  const alt = Number(c.alternative().to_str());
  const list = c.data();
  const fields: PlutusData[] = [];
  for (let i = 0; i < list.len(); i++) fields.push(list.get(i));
  return { alt, fields };
}

/** A constructor with exactly this index and field count. */
export function fieldsOf(d: PlutusData, alt: number, count: number, what: string): PlutusData[] {
  const c = constr(d, what);
  if (c.alt !== alt || c.fields.length !== count) throw new DecodeError(`${what}: expected constructor ${alt} with ${count} fields, got ${c.alt} with ${c.fields.length}`);
  return c.fields;
}

export function int(d: PlutusData, what: string): bigint {
  if (d.kind() !== KIND.integer) throw new DecodeError(`${what} is not an integer`);
  return BigInt(d.as_integer()!.to_str());
}

export function bytes(d: PlutusData, what: string): string {
  if (d.kind() !== KIND.bytes) throw new DecodeError(`${what} is not bytes`);
  return Buffer.from(d.as_bytes()!).toString('hex');
}

export function list(d: PlutusData, what: string): PlutusData[] {
  if (d.kind() !== KIND.list) throw new DecodeError(`${what} is not a list`);
  const l = d.as_list()!;
  const out: PlutusData[] = [];
  for (let i = 0; i < l.len(); i++) out.push(l.get(i));
  return out;
}

/** Aiken's Bool: False = constructor 0, True = constructor 1, no fields. */
export function bool(d: PlutusData, what: string): boolean {
  const c = constr(d, what);
  if (c.fields.length !== 0 || c.alt > 1) throw new DecodeError(`${what} is not a Bool`);
  return c.alt === 1;
}

/** Aiken's Option: Some(x) = constructor 0 [x], None = constructor 1 []. */
export function option<T>(d: PlutusData, what: string, inner: (x: PlutusData) => T): T | null {
  const c = constr(d, what);
  if (c.alt === 0 && c.fields.length === 1) return inner(c.fields[0]!);
  if (c.alt === 1 && c.fields.length === 0) return null;
  throw new DecodeError(`${what} is not an Option`);
}

// ---- writing ----

export function mkConstr(alt: number, fields: PlutusData[]): PlutusData {
  const l = CSL.PlutusList.new();
  for (const f of fields) l.add(f);
  return CSL.PlutusData.new_constr_plutus_data(CSL.ConstrPlutusData.new(CSL.BigNum.from_str(String(alt)), l));
}

export function mkInt(n: bigint): PlutusData {
  return CSL.PlutusData.new_integer(CSL.BigInt.from_str(n.toString()));
}

export function mkBytes(hex: string): PlutusData {
  return CSL.PlutusData.new_bytes(Buffer.from(hex, 'hex'));
}

export function mkList(items: PlutusData[]): PlutusData {
  const l = CSL.PlutusList.new();
  for (const i of items) l.add(i);
  return CSL.PlutusData.new_list(l);
}
