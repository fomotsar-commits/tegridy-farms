import { describe, it, expect } from 'vitest';
import { ART } from './artConfig';
import { BUNGALOWS } from './bungalows';
import { DOOR_ART_OVERRIDES } from './bungalowDoorArt';
import { doorArt, resolveDoorArt, islandArtIndex } from './doorArt';

// THE DOOR RESOLVER, AND THE ASSUMPTION IT RESTS ON.
//
// A door pick names an artId and nothing else, and that id is resolved against
// EVERY bungalow's pool plus the classic map. That only works because an artId
// (the filename without its extension) is unique island-wide. If two residents
// ever ship a file with the same name, a door would silently resolve to the
// wrong resident's picture — a wrong shop window on the island's front page,
// with nothing failing anywhere. The first test is what keeps that true.
//
// NOTE ON STYLE: this file passes overrides in rather than mocking the module
// that holds them. The first version used `vi.doMock` + `vi.resetModules`, and
// it LEAKED — running it alongside src/nakamigos/ turned two passing volume
// tests red while both files passed alone. A module mock is global state, and
// `resolveDoorArt` taking its overrides as an argument removes the need for one
// (the studio wanted that seam anyway, to resolve against its working draft).

describe('island art index', () => {
  it('every artId is unique across all bungalow pools', () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const b of BUNGALOWS) {
      for (const piece of b.artPool ?? []) {
        const prior = seen.get(piece.id);
        if (prior && prior !== b.id) collisions.push(`${piece.id}: ${prior} vs ${b.id}`);
        else seen.set(piece.id, b.id);
      }
    }
    expect(seen.size, 'sanity: pools should hold many pieces').toBeGreaterThan(200);
    expect(
      collisions,
      'two residents ship art with the same filename — a door pick would resolve to whichever ' +
        'pool the index happened to read first:\n  ' + collisions.join('\n  '),
    ).toEqual([]);
  });

  it('indexes pool art and classic art together', () => {
    const index = islandArtIndex();
    const poolCount = BUNGALOWS.reduce((n, b) => n + (b.artPool?.length ?? 0), 0);
    expect(index.size).toBeGreaterThanOrEqual(poolCount);
    // A known classic piece is reachable, so a door can borrow from the classic map.
    expect(index.get(Object.values(ART)[0]!.id)).toBeTruthy();
  });

  it('a bungalow pool is never shadowed by a classic piece of the same id', () => {
    for (const b of BUNGALOWS) {
      for (const piece of b.artPool ?? []) {
        expect(islandArtIndex().get(piece.id)!.src, `${piece.id} resolved away from its pool`).toBe(piece.src);
      }
    }
  });
});

describe('resolveDoorArt', () => {
  it('falls back to the registry thumb when there is no pick', () => {
    for (const b of BUNGALOWS) {
      const d = resolveDoorArt(b, {});
      expect(d.src, `${b.id} resolved to no picture`).toBe(b.thumb);
      expect(d.objectPosition).toBe(b.thumbPosition);
    }
  });

  it('uses the picked piece and the picked framing', () => {
    const target = BUNGALOWS.find((b) => (b.artPool?.length ?? 0) > 0)!;
    const piece = target.artPool![0]!;
    const d = resolveDoorArt(target, { [target.id]: { artId: piece.id, objectPosition: '10% 90%' } });
    expect(d.src).toBe(piece.src);
    expect(d.objectPosition).toBe('10% 90%');
  });

  it('lets one resident wear another resident’s art — the point of a shop window', () => {
    const [a, b] = BUNGALOWS.filter((x) => (x.artPool?.length ?? 0) > 0);
    const borrowed = b!.artPool![0]!;
    const d = resolveDoorArt(a!, { [a!.id]: { artId: borrowed.id } });
    expect(d.src).toBe(borrowed.src);
  });

  // A door with no picture is a broken card on the island's front page, so an
  // override that cannot resolve has to degrade to the value that was always
  // there rather than render nothing.
  it('falls back to the registry thumb when the picked artId no longer exists', () => {
    const target = BUNGALOWS[0]!;
    const d = resolveDoorArt(target, { [target.id]: { artId: 'deleted-piece-that-is-gone' } });
    expect(d.src).toBe(target.thumb);
  });

  it('every registry thumb is a real path, so the fallback can never be empty', () => {
    for (const b of BUNGALOWS) {
      expect(b.thumb, `${b.id} has no thumb`).toMatch(/^\/(art|splash|nakamigos|collections)\//);
    }
  });
});

describe('doorArt (what actually ships)', () => {
  it('agrees with resolveDoorArt against the committed overrides', () => {
    for (const b of BUNGALOWS) {
      expect(doorArt(b)).toEqual(resolveDoorArt(b, DOOR_ART_OVERRIDES));
    }
  });

  it('every shipped override names an artId the island can resolve', () => {
    for (const [id, override] of Object.entries(DOOR_ART_OVERRIDES)) {
      expect(BUNGALOWS.some((b) => b.id === id), `door override "${id}" is not a bungalow`).toBe(true);
      expect(
        islandArtIndex().get(override.artId),
        `door "${id}" picks artId "${override.artId}", which no pool or the classic map holds — ` +
          'the door silently falls back to its registry thumb',
      ).toBeTruthy();
    }
  });
});
