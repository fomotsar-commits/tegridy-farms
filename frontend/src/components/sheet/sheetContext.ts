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
  room: Bungalow;
  /** Bayla's line as the sheet draws it, with no button: the sheet's own green button is her move. */
  bayla: ReactNode;
}

export const SheetContext = createContext<SheetPlace | null>(null);

export const useSheet = (): SheetPlace | null => useContext(SheetContext);
