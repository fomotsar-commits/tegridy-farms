import { useSyncExternalStore } from 'react';
import type { Bungalow } from './bungalows';
import type { SheetKind, SheetNet } from './sheet';

/**
 * The open sheet (island answer twenty-five, build 3) and who draws its form.
 *
 * The sheet's frame is drawn by the layout on every page (components/sheet/ActionSheet.tsx),
 * but its form signs with a Solana connection, and the venue keeps ONE live Solana connection
 * per page (lib/solanaSurface.ts). So the form is drawn by an outlet: the page's own Solana
 * section hosts one where it has a section (the home's cards, BAYLA's room), and the sheet
 * brings its own connection only where the page has none. The first page outlet mounted draws
 * the form; the others stand by. Entry-chunk code: no Solana import here.
 */
export interface SheetOpen {
  kind: SheetKind;
  /** Add always has one; Buy has none until its bungalow row picks a coin (island answer twenty-seven). */
  room: Bungalow | null;
  /** Where the form is drawn: a node inside the sheet's frame. */
  slot: HTMLElement;
  close: () => void;
  /** Add on every pool: the whole pools section, in the sheet. */
  all: boolean;
  /** The sheet's network drop-down: a pick changes its form in place. */
  pickNet: (net: SheetNet) => void;
}

let open: SheetOpen | null = null;
const outlets: symbol[] = [];
const listeners = new Set<() => void>();
let outletHead: symbol | null = null;

function emit(): void {
  outletHead = outlets[0] ?? null;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setSheetOpen(next: SheetOpen | null): void {
  if (next === open) return;
  open = next;
  emit();
}

export function useSheetOpen(): SheetOpen | null {
  return useSyncExternalStore(subscribe, () => open, () => null);
}

/** A page's Solana section says it can draw the sheet's form; the release says it no longer can. */
export function holdSheetOutlet(token: symbol): () => void {
  outlets.push(token);
  emit();
  return () => {
    const at = outlets.indexOf(token);
    if (at >= 0) outlets.splice(at, 1);
    emit();
  };
}

/** The page outlet that draws the form, or null when the page has none (the sheet then brings its own connection). */
export function useSheetOutletHead(): symbol | null {
  return useSyncExternalStore(subscribe, () => outletHead, () => null);
}

/** Tests only. */
export function resetSheetStore(): void {
  open = null;
  outlets.length = 0;
  emit();
}
