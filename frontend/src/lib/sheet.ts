import { BUNGALOWS, type Bungalow } from './bungalows';
import { SOL_MINT } from './solana';

/**
 * The sheet (island answer twenty-five, build 3): Add or Buy as one screen over the page,
 * the room staying behind it. It lives in the address, `?sheet=add` or `?sheet=buy` on the
 * page it rises over, so Back closes it and the page is still there. `coin` names the room
 * whose coin it acts on when that is not the room entered last (the bungalow row's pick);
 * with neither, the sheet opens on the bungalow row and the visitor picks the coin.
 */
export type SheetKind = 'add' | 'buy';
export const SHEET_PARAM = 'sheet';
export const SHEET_COIN_PARAM = 'coin';
/** The sheet's own network (owner, 2026-11-11): a pick in its drop-down changes the form in place, and the address holds it. */
export const SHEET_NET_PARAM = 'net';
/** Every network a sheet can name. Whether the venue has a form there is the module's to say (layout/moduleNetwork.tsx). */
export const SHEET_NETS = ['solana', 'base', 'robinhood', 'ethereum', 'cardano'] as const;
export type SheetNet = (typeof SHEET_NETS)[number];
/** A room's own network, when the sheet can name it. */
export function roomNet(room: Bungalow | null | undefined): SheetNet | null {
  return SHEET_NETS.find((n) => n === room?.chain) ?? null;
}

export interface SheetAsk {
  kind: SheetKind;
  /** The room named in the address, when it is one the sheet can act on. */
  coin: Bungalow | null;
  /** The network named in the address; null when none is (the sheet then opens on its room's, else Solana). */
  net: SheetNet | null;
  /** Add's whole section instead of one room's pool: every pool, your positions, remove, claim, open (`coin=all`). */
  all: boolean;
}

/** `coin=all`: the Add sheet on every pool. */
export const SHEET_ALL = 'all';

/** The rooms a sheet acts on: a live Solana coin with its SOL pool on the venue, in the hall's order. */
export function sheetRooms(): Bungalow[] {
  return BUNGALOWS.filter((b) => b.live && b.chain === 'solana' && !!b.address && !!b.venueSolPool);
}

/** The sheet room by its id, or by its coin's mint; null for any other. */
export function sheetRoom(idOrMint: string | null | undefined): Bungalow | null {
  if (!idOrMint) return null;
  return sheetRooms().find((b) => b.id === idOrMint || b.address === idOrMint) ?? null;
}

export function readSheet(search: string): SheetAsk | null {
  const params = new URLSearchParams(search);
  const kind = params.get(SHEET_PARAM);
  if (kind !== 'add' && kind !== 'buy') return null;
  const net = params.get(SHEET_NET_PARAM);
  const all = kind === 'add' && params.get(SHEET_COIN_PARAM) === SHEET_ALL;
  return { kind, all, coin: sheetRoom(params.get(SHEET_COIN_PARAM)), net: SHEET_NETS.find((n) => n === net) ?? null };
}

function withParams(pathname: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** The address with the sheet open over the page; `coin` (a room id) when the sheet's coin is not the room's. */
export function sheetHref(pathname: string, search: string, kind: SheetKind, coin?: string | null, net?: SheetNet | null): string {
  const params = new URLSearchParams(search);
  params.set(SHEET_PARAM, kind);
  if (coin) params.set(SHEET_COIN_PARAM, coin);
  else params.delete(SHEET_COIN_PARAM);
  // Solana is the sheet's own network: the address names only another one.
  if (net && net !== 'solana') params.set(SHEET_NET_PARAM, net);
  else params.delete(SHEET_NET_PARAM);
  return withParams(pathname, params);
}

/** The address with the sheet closed: the page it rose over. */
export function withoutSheet(pathname: string, search: string): string {
  const params = new URLSearchParams(search);
  params.delete(SHEET_PARAM);
  params.delete(SHEET_COIN_PARAM);
  params.delete(SHEET_NET_PARAM);
  return withParams(pathname, params);
}

/** The address state a press that opens the sheet carries: Back then pops back to the page it was on. */
export const SHEET_PRESS = { sheet: true } as const;

/** Does this address open the sheet? (A bar word's target, a door's.) */
export function opensSheet(to: string): boolean {
  const at = to.indexOf('?');
  return at >= 0 && readSheet(to.slice(at)) !== null;
}

/** Where a room's door opens its sheet: the room's own page, with the sheet over it. */
export function roomSheetHref(room: Bungalow, kind: SheetKind): string {
  return `/${room.id}?${SHEET_PARAM}=${kind}`;
}

/**
 * The island's deep links that open a sheet over the coin's room instead of a page (answer
 * twenty-four, build 3): `/pools?mint=<coin>&task=add` and `/solana?in=&out=<coin>`, for a
 * sheet room's coin paid with SOL. Null for every other address: the page stays the page.
 */
export function deepLinkSheet(pathname: string, search: string): string | null {
  const params = new URLSearchParams(search);
  if (pathname === '/pools' && params.get('task') === 'add') {
    const room = sheetRoom(params.get('mint'));
    const pool = params.get('pool');
    if (!room || (pool && pool !== room.venueSolPool)) return null;
    return roomSheetHref(room, 'add');
  }
  if (pathname === '/solana' && params.has('out')) {
    const room = sheetRoom(params.get('out'));
    const paid = params.get('in');
    if (!room || (paid && paid !== SOL_MINT && paid.toUpperCase() !== 'SOL')) return null;
    return roomSheetHref(room, 'buy');
  }
  return null;
}
