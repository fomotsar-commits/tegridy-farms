// Island answer twenty-five, build 3: the sheet lives in the address, over the page.
import { describe, expect, it } from 'vitest';
import { deepLinkSheet, opensSheet, readSheet, roomSheetHref, sheetHref, sheetRoom, sheetRooms, withoutSheet } from './sheet';
import { BAYLA_MINT, BUNGALOWS } from './bungalows';
import { SOL_MINT } from './solana';

const BAYLA = BUNGALOWS.find((b) => b.id === 'bayla')!;
const PEPE = BUNGALOWS.find((b) => b.id === 'pepe')!;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('the rooms a sheet acts on', () => {
  it('are the live Solana rooms with a SOL pool on the venue, in the hall’s order', () => {
    expect(sheetRooms().map((b) => b.id)).toEqual(['bayla', 'bobo', 'soy', 'brainlet', 'rizz']);
    for (const b of sheetRooms()) expect(b.venueSolPool, b.id).toBeTruthy();
  });
  it('are found by id or by mint, and no other room is', () => {
    expect(sheetRoom('bayla')).toBe(BAYLA);
    expect(sheetRoom(BAYLA_MINT)).toBe(BAYLA);
    expect(sheetRoom('pepe')).toBeNull();
    expect(sheetRoom(PEPE.address)).toBeNull();
    expect(sheetRoom(null)).toBeNull();
  });
});

describe('the address', () => {
  it('reads ?sheet=add and ?sheet=buy, with the coin when one is named, and nothing else', () => {
    expect(readSheet('?sheet=add')).toEqual({ kind: 'add', coin: null, net: null, all: false });
    expect(readSheet('?sheet=buy&coin=soy')).toEqual({ kind: 'buy', coin: sheetRoom('soy'), net: null, all: false });
    expect(readSheet('?sheet=buy&coin=pepe')).toEqual({ kind: 'buy', coin: null, net: null, all: false });
    expect(readSheet('?sheet=sell')).toBeNull();
    expect(readSheet('?coin=soy')).toBeNull();
    expect(readSheet('')).toBeNull();
  });
  it('holds the sheet’s own network and its every-pool view in the address; Solana, the sheet’s own, is never named', () => {
    expect(readSheet('?sheet=buy&net=base')).toEqual({ kind: 'buy', coin: null, net: 'base', all: false });
    expect(readSheet('?sheet=buy&net=dogechain')?.net).toBeNull();
    expect(readSheet('?sheet=add&coin=all')).toEqual({ kind: 'add', coin: null, net: null, all: true });
    expect(readSheet('?sheet=buy&coin=all')?.all, 'every pool is Add’s').toBe(false);
    expect(sheetHref('/bayla', '?sheet=buy', 'buy', null, 'base')).toBe('/bayla?sheet=buy&net=base');
    expect(sheetHref('/bayla', '?sheet=buy&net=base', 'buy', null, 'solana')).toBe('/bayla?sheet=buy');
    expect(sheetHref('/bayla', '?sheet=buy&net=base', 'buy', 'bobo'), 'a coin picked is a Solana room’s').toBe('/bayla?sheet=buy&coin=bobo');
    expect(withoutSheet('/bayla', '?sheet=add&coin=all&net=base&x=1')).toBe('/bayla?x=1');
  });
  it('opens over the page and keeps what the page had in its address; closing leaves the page as it was', () => {
    expect(sheetHref('/bayla', '', 'add')).toBe('/bayla?sheet=add');
    expect(sheetHref('/launch', '?tab=x', 'buy', 'soy')).toBe('/launch?tab=x&sheet=buy&coin=soy');
    expect(sheetHref('/launch', '?sheet=buy&coin=soy', 'add')).toBe('/launch?sheet=add');
    expect(withoutSheet('/launch', '?tab=x&sheet=buy&coin=soy')).toBe('/launch?tab=x');
    expect(withoutSheet('/bayla', '?sheet=add')).toBe('/bayla');
  });
  it('a room’s door opens the room’s own page with the sheet over it', () => {
    expect(roomSheetHref(BAYLA, 'add')).toBe('/bayla?sheet=add');
    expect(roomSheetHref(BAYLA, 'buy')).toBe('/bayla?sheet=buy');
    expect(opensSheet('/bayla?sheet=add')).toBe(true);
    expect(opensSheet(`/pools?mint=${BAYLA_MINT}`)).toBe(false);
    expect(opensSheet('/bayla')).toBe(false);
  });
});

describe('the island’s deep links open the sheet over the coin’s room', () => {
  it('/pools?mint=&task=add: its room’s Add sheet, for the room’s own pool or none named', () => {
    expect(deepLinkSheet('/pools', `?mint=${BAYLA_MINT}&task=add`)).toBe('/bayla?sheet=add');
    expect(deepLinkSheet('/pools', `?mint=${BAYLA_MINT}&task=add&pool=${BAYLA.venueSolPool}`)).toBe('/bayla?sheet=add');
  });
  it('a link naming another pool, no task, or a coin with no sheet stays the pools page', () => {
    expect(deepLinkSheet('/pools', `?mint=${BAYLA_MINT}&task=add&pool=Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV`)).toBeNull();
    expect(deepLinkSheet('/pools', `?mint=${BAYLA_MINT}`)).toBeNull();
    expect(deepLinkSheet('/pools', `?mint=${PEPE.address}&task=add`)).toBeNull();
    expect(deepLinkSheet('/pools', '')).toBeNull();
  });
  it('/solana?in=&out=: its room’s Buy sheet, paid in SOL or with nothing named', () => {
    expect(deepLinkSheet('/solana', `?out=${BAYLA_MINT}`)).toBe('/bayla?sheet=buy');
    expect(deepLinkSheet('/solana', `?in=${SOL_MINT}&out=${BAYLA_MINT}`)).toBe('/bayla?sheet=buy');
    expect(deepLinkSheet('/solana', `?in=SOL&out=${BAYLA_MINT}`)).toBe('/bayla?sheet=buy');
  });
  it('a link paying in another coin, or buying a coin with no sheet, stays the swap page', () => {
    expect(deepLinkSheet('/solana', `?in=${USDC}&out=${BAYLA_MINT}`)).toBeNull();
    expect(deepLinkSheet('/solana', `?out=${USDC}`)).toBeNull();
    expect(deepLinkSheet('/solana', '')).toBeNull();
    expect(deepLinkSheet('/swap', `?out=${BAYLA_MINT}`)).toBeNull();
  });
});
