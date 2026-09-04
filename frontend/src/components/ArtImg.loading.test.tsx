// PERF-05. Art is the heaviest thing this site ships — 110 MB across 423 files
// under public/art, 135 of them over 300 KB — so whether an <img> is fetched at
// all before it scrolls into view is the single biggest lever available without
// a build-time derivative pipeline.
//
// The rule was being followed by hand at 119 of 120 call sites, which is another
// way of saying it was one forgotten prop away from being broken on a new
// surface. It lives in the primitive now. The second test is the one that keeps
// this from being a regression: defaulting `loading` must never reach the LCP
// image, and the only thing that distinguishes it is `fetchPriority`.

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ArtImg } from './ArtImg';

function imgOf(container: HTMLElement): HTMLImageElement {
  const img = container.querySelector('img');
  if (!img) throw new Error('ArtImg rendered no <img>');
  return img;
}

describe('ArtImg decides its own fetch priority', () => {
  it('defaults to lazy, so a new surface cannot forget it', () => {
    const { container } = render(<ArtImg pageId="gallery" idx={3} alt="" />);
    expect(imgOf(container).getAttribute('loading')).toBe('lazy');
  });

  it('never lazies the priority image', () => {
    // The home hero is the LCP element and is preloaded by /theme-init.js.
    // `loading="lazy"` on it would defer the very fetch the preload exists for.
    const { container } = render(<ArtImg pageId="home" idx={0} alt="" fetchPriority="high" />);
    const img = imgOf(container);
    expect(img.getAttribute('loading')).toBe('eager');
    expect(img.getAttribute('fetchpriority')).toBe('high');
  });

  it('still lets a caller say otherwise', () => {
    const { container } = render(<ArtImg pageId="gallery" idx={1} alt="" loading="eager" />);
    expect(imgOf(container).getAttribute('loading')).toBe('eager');
  });

  it('keeps reserving layout, so lazy loading does not buy CLS', () => {
    const img = imgOf(render(<ArtImg pageId="gallery" idx={2} alt="" />).container);
    expect(img.getAttribute('width')).toBeTruthy();
    expect(img.getAttribute('height')).toBeTruthy();
    expect(img.getAttribute('decoding')).toBe('async');
  });
});
