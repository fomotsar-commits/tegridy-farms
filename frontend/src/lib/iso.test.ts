// The drawing board under Earn's two figures: a length keeps its scale on every axis, so a
// height in a figure can be compared with another by eye. If that stops being true, the site
// model's ramps stop being the ladder "to scale".
import { describe, it, expect } from 'vitest';
import { bounds, groundMatrix, iso, pts, solid } from './iso';
import { mixHex } from './editorial';

describe('the axonometric', () => {
  it('sets x down to the right, y down to the left and z straight up, all at one scale', () => {
    expect(iso([0, 0, 0])).toEqual([0, 0]);
    const [xx, xy] = iso([1, 0, 0], 10);
    const [yx, yy] = iso([0, 1, 0], 10);
    expect(xx).toBeGreaterThan(0);
    expect(xy).toBeGreaterThan(0);
    expect(yx).toBeCloseTo(-xx);
    expect(yy).toBeCloseTo(xy);
    // A unit along either ground axis is as long on the sheet as a unit of height.
    expect(Math.hypot(xx, xy)).toBeCloseTo(10);
    expect(iso([0, 0, 1], 10)).toEqual([0, -10]);
  });

  it('a slab is as high at one end as at the other; a ramp rises along x, and its section shows the rise', () => {
    const u = 10;
    const slab = solid(0, 0, 2, 1, 3, 3, u);
    const heightAt = (face: readonly (readonly [number, number])[], top: number, foot: number) => face[foot]![1] - face[top]![1];
    expect(heightAt(slab.left, 0, 3)).toBeCloseTo(30);
    expect(heightAt(slab.left, 1, 2)).toBeCloseTo(30);

    const ramp = solid(0, 0, 2, 1, 0.4, 4, u);
    // The section (the face toward the lower left): low end, then high end, over their feet.
    expect(heightAt(ramp.left, 0, 3)).toBeCloseTo(4);
    expect(heightAt(ramp.left, 1, 2)).toBeCloseTo(40);
    // The tall end is a plain rectangle, as high as the ramp's top.
    expect(heightAt(ramp.right, 0, 3)).toBeCloseTo(40);
    expect(heightAt(ramp.right, 1, 2)).toBeCloseTo(40);
  });

  it('a plate lifted off the ground keeps its shape', () => {
    const down = solid(1, 1, 3, 3, 0.5, 0.5, 10);
    const up = solid(1, 1, 3, 3, 0.5, 0.5, 10, 2);
    up.top.forEach(([x, y], i) => {
      expect(x).toBeCloseTo(down.top[i]![0]);
      expect(y).toBeCloseTo(down.top[i]![1] - 20);
    });
  });

  it('measures a set of points, and writes them for an SVG', () => {
    expect(bounds([[1, 5], [-2, 3], [4, -1]])).toEqual([-2, -1, 6, 6]);
    expect(bounds([])).toEqual([0, 0, 0, 0]);
    expect(pts([[1.23456, -2], [3, 4.5]])).toBe('1.23,-2 3,4.5');
  });

  it('lays a word on the ground along x', () => {
    // Its first basis vector is the x axis on the sheet, its second the y axis: a letter's
    // baseline runs with the street.
    expect(groundMatrix([0, 0, 0])).toBe('matrix(0.866 0.5 -0.866 0.5 0 0)');
  });
});

describe('a face is one colour over the black', () => {
  it('mixes two colours to an opaque one', () => {
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(mixHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(mixHex('#000000', '#ff8000', 0.5)).toBe('#804000');
    // Past either end it stops there.
    expect(mixHex('#102030', '#405060', 2)).toBe('#405060');
  });

  it('hands back the first colour when either is not #rrggbb, rather than a broken one', () => {
    expect(mixHex('#05080f', 'green', 0.5)).toBe('#05080f');
    expect(mixHex('#05080f', '#fff', 0.5)).toBe('#05080f');
  });
});
