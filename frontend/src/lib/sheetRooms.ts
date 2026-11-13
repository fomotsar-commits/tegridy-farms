import type { Bungalow } from './bungalows';
import { roomNet, roomSheetHref, sheetRoom, type SheetKind } from './sheet';
import { tabServes, venueChain } from './sectionChains';
import { swapTokensFor } from './tokenList';

/**
 * Which rooms open the sheet, on every network (owner, 2026-11-11: the sheet is not one coin's, it
 * "leverages all the functionality our platform offers"). A Solana room with its SOL pool on the
 * venue opens the sheet as before (lib/sheet.ts sheetRoom). A room on Ethereum or Base opens it on
 * its own network: Swap where that network's swap lists the room's coin, so the form opens on it
 * (/swap's form, its checks and its routes); Add where the venue's add / remove form runs there.
 */
export function evmRoomToken(room: Bungalow | null | undefined): { chainId: number; address: string } | null {
  const net = roomNet(room);
  if (!room?.live || !room.address || !net || net === 'solana' || net === 'cardano') return null;
  const chainId = venueChain(net).evmChainId;
  if (chainId === null) return null;
  const listed = swapTokensFor(chainId).some((t) => t.address.toLowerCase() === room.address!.toLowerCase());
  return listed ? { chainId, address: room.address } : null;
}

export function roomOpensSheet(room: Bungalow | null | undefined, kind: SheetKind): boolean {
  if (!room) return false;
  if (sheetRoom(room.id)) return true;
  const net = roomNet(room);
  if (!room.live || !net || net === 'solana' || net === 'cardano') return false;
  return kind === 'buy' ? tabServes('/swap', net) && evmRoomToken(room) !== null : tabServes('/liquidity', net);
}

/** The room's own page with its sheet over it, or null where the room has none of that kind. */
export function roomSheetOr(room: Bungalow | null | undefined, kind: SheetKind): string | null {
  return room && roomOpensSheet(room, kind) ? roomSheetHref(room, kind) : null;
}
