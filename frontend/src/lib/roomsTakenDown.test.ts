import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUNGALOWS } from './bungalows';
import { EVM_BASKET, SOL_BASKET } from './islandBasket';
import { ISLAND_ROOMS } from './heat/torchesClient';
import { BUNGALOW_BURN_FACTS } from './bungalowBurn';
import { BUNGALOW_ART_FILES } from './bungalowArtPools';
import { BUNGALOW_ART_OVERRIDES } from './bungalowArtOverrides';
import { DOOR_ART_OVERRIDES } from './bungalowDoorArt';
import { DOORS } from '../../scripts/render-bungalow-doors.mjs';

// A room the island takes down leaves every venue surface in the same change (island answer 37).
// $QR: the owner's word, 2026-11-12 9:40 PM Pacific: "remove the $QR bungalow from all surfaces".
// The island took it down 2026-11-14 11:23 PM Pacific (memetics.wtf: 11 bungalows, /b/qr answers 404).
// Records stay as they are: scripts/addresses.json and what reads it (the trust page, the TVL sum,
// the address checks), contracts/broadcast, docs, CHANGELOG. The next room to leave is one more line
// in TAKEN_DOWN, and this file names every list it still sits in.
const TAKEN_DOWN = [
  { id: 'qr', chain: 'base', address: '0x2b5050f01d64fbb3e4ac44dc07f0732bfb5ecadf' },
] as const;

const same = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
const sitemap = readFileSync(resolve(process.cwd(), 'public/sitemap.xml'), 'utf8');
const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

describe.each(TAKEN_DOWN)('a room the island took down ($id on $chain)', ({ id, address }) => {
  it('is not a room: no row by its id or by its coin', () => {
    expect(BUNGALOWS.filter((b) => b.id === id || same(b.address, address)).map((b) => b.id)).toEqual([]);
  });

  it('is not in "Buy all bungalows" on any chain', () => {
    const evm = [...EVM_BASKET.ethereum, ...EVM_BASKET.base].filter((c) => c.room === id || same(c.token, address));
    const sol = SOL_BASKET.filter((c) => c.room === id || same(c.mint, address));
    expect([...evm, ...sol].map((c) => c.symbol)).toEqual([]);
  });

  it('has no place on the torch rail', () => {
    expect(ISLAND_ROOMS[id]).toBeUndefined();
    expect(Object.values(ISLAND_ROOMS).filter((p) => p.place.includes(address.toLowerCase()))).toEqual([]);
  });

  it('has no burn line, no art, no door art and no art overrides', () => {
    expect(BUNGALOW_BURN_FACTS[id]).toBeUndefined();
    expect(BUNGALOW_ART_FILES[id]).toBeUndefined();
    expect(DOOR_ART_OVERRIDES[id]).toBeUndefined();
    expect(Object.keys(BUNGALOW_ART_OVERRIDES).filter((k) => k.startsWith(`${id}|`))).toEqual([]);
  });

  it('has no door page, no alias door and no sitemap entry', () => {
    expect(DOORS.map((d: { path: string }) => d.path)).not.toContain(id);
    expect(appSource).not.toContain(`id: '${id}' }`);
    expect(sitemap).not.toContain(`memetics.finance/${id}<`);
  });
});

describe('"Buy all bungalows" buys rooms only', () => {
  it('every coin in every basket belongs to a live room', () => {
    const live = new Set(BUNGALOWS.filter((b) => b.live).map((b) => b.id));
    const rooms = [...EVM_BASKET.ethereum, ...EVM_BASKET.base, ...SOL_BASKET].map((c) => c.room);
    expect(rooms.filter((r) => !live.has(r))).toEqual([]);
  });
});
