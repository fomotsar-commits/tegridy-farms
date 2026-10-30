// A multi-asset value as exact integers: unit '' is lovelace, '<policy>.<name>' a token (hex).
// Zero entries are dropped, as Aiken's value.add drops them, so two values are equal exactly
// when they hold the same non-zero quantities.
import { isAda, type Asset } from './types.ts';

export type Value = ReadonlyMap<string, bigint>;

export const unitOf = (a: Asset): string => (isAda(a) ? '' : `${a.policyId}.${a.assetName}`);

export function quantityOf(v: Value, a: Asset): bigint {
  return v.get(unitOf(a)) ?? 0n;
}

/** Aiken value.add: a new value with `delta` added to asset `a`; a zero result is removed. */
export function add(v: Value, a: Asset, delta: bigint): Value {
  const out = new Map(v);
  const unit = unitOf(a);
  const next = (out.get(unit) ?? 0n) + delta;
  if (next === 0n) out.delete(unit);
  else out.set(unit, next);
  return out;
}

export function valueOf(entries: [Asset, bigint][]): Value {
  let v: Value = new Map();
  for (const [a, q] of entries) v = add(v, a, q);
  return v;
}

export function equals(a: Value, b: Value): boolean {
  const nz = (v: Value) => [...v].filter(([, q]) => q !== 0n);
  const x = nz(a);
  const y = nz(b);
  return x.length === y.length && x.every(([u, q]) => b.get(u) === q);
}

/** True when any quantity is negative: no output can hold it. */
export function hasNegative(v: Value): boolean {
  return [...v.values()].some((q) => q < 0n);
}

export function show(v: Value): string {
  return [...v].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([u, q]) => `${u === '' ? 'lovelace' : u}=${q}`).join(', ');
}
