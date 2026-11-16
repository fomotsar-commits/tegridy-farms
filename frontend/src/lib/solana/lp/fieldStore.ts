import { useSyncExternalStore } from 'react';

/**
 * What /pools' tank farm (components/dwg/PoolField.tsx) knows past the registry: the pools All
 * pools read, published from that list's own read (VenuePoolList), never read twice; the pool a
 * pointer is on; and what a row's View does. In memory, for the page. Null until a list lands.
 */
export interface FieldPool {
  readonly address: string;
  readonly tokenMint: string;
  /** The pair as a tank's wall names it: "BAYLA/SOL". */
  readonly name: string;
  /** What it holds at Jupiter's listed prices, or null when that was not read: no level on the gauge. */
  readonly usd: number | null;
  /** The list read both of its reserves above nothing. Unset for a tank the registry names before any read. */
  readonly stocked?: boolean;
}

type View = (tokenMint: string) => void;

let pools: readonly FieldPool[] | null = null;
let hot: string | null = null;
let view: View | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const samePools = (a: readonly FieldPool[] | null, b: readonly FieldPool[] | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.length === b.length &&
    a.every(
      (p, i) =>
        p.address === b[i]!.address &&
        p.name === b[i]!.name &&
        p.usd === b[i]!.usd &&
        p.tokenMint === b[i]!.tokenMint &&
        Boolean(p.stocked) === Boolean(b[i]!.stocked),
    ));

/** The list All pools drew, in its order, or null when it has none to give (not read, or gone). */
export function publishFieldPools(next: readonly FieldPool[] | null): void {
  if (samePools(pools, next)) return;
  pools = next;
  emit();
}

/** The pool a pointer is on, in the list or in the drawing; null when on none. */
export function setFieldHot(address: string | null): void {
  if (hot === address) return;
  hot = address;
  emit();
}

/** A row's View, for a press on its tank. Returns the undo, which leaves a later one standing. */
export function setFieldView(next: View): () => void {
  view = next;
  emit();
  return () => {
    if (view !== next) return;
    view = null;
    emit();
  };
}

export function useFieldPools(): readonly FieldPool[] | null {
  return useSyncExternalStore(subscribe, () => pools, () => null);
}

export function useFieldHot(): string | null {
  return useSyncExternalStore(subscribe, () => hot, () => null);
}

export function useFieldView(): View | null {
  return useSyncExternalStore(subscribe, () => view, () => null);
}

/** Tests only. */
export function resetField(): void {
  pools = null;
  hot = null;
  view = null;
  emit();
}
