import { createContext, useContext, type ReactNode } from 'react';
import type { Bungalow } from '../../lib/bungalows';
import type { SheetKind } from '../../lib/sheet';

/**
 * Inside the sheet (island answer twenty-five, build 3): the forms it hosts draw the island's
 * drawing instead of their page layout. The add (AddOneCoinPanel) and the swap
 * (SolanaSwapInner) read it; so do the pool card's rows and the door frame they ride in.
 */
export interface SheetPlace {
  kind: SheetKind;
  /** The room whose coin the sheet acts on. Add always has one; Buy has none until its bungalow row picks a coin. */
  room: Bungalow | null;
  /** Bayla's line as the sheet draws it, with no button: the sheet's own green button is her move. */
  bayla: ReactNode;
  /** Opens the form again from its start, on the room's coin: the room's chip pressed after a pick from the You get press. */
  reopen?: () => void;
  /** Add on every pool (lib/sheet.ts SHEET_ALL). */
  all?: boolean;
}

/**
 * The bungalow row's words (island answer twenty-seven), as the island gave them: the row's name
 * and her line in the Buy sheet before a coin is picked.
 */
export const SHEET_ROW_WORDS = {
  group: 'Pick a coin',
  pick: 'Pick a coin.',
} as const;

/**
 * What the sheet holds while its form loads: about the form's height (Add's as drawn, Buy's before an
 * amount), so the sheet rises once instead of climbing and dropping as its pieces land. `line` is for
 * a waiting line; `slot` for the sheet's own frame before anything is drawn in it.
 */
export const SHEET_WAIT: Record<SheetKind, { line: string; slot: string }> = {
  add: { line: 'min-h-[320px]', slot: 'empty:min-h-[320px]' },
  buy: { line: 'min-h-[204px]', slot: 'empty:min-h-[204px]' },
};

export const SheetContext = createContext<SheetPlace | null>(null);

export const useSheet = (): SheetPlace | null => useContext(SheetContext);
