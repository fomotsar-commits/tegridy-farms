import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PageArtBackdrop } from './PageArtBackdrop';

// PageArtBackdrop gives otherwise art-less standalone pages (launch, scanner,
// deployer, wallet-exposure, launch-simulator) real art without touching their
// layout. These tests pin the two things that make that safe: it actually renders
// an art image, and it stays a non-interactive layer painted BEHIND page content.
describe('PageArtBackdrop', () => {
  it('renders a decorative art image behind the page', () => {
    const { container } = render(<PageArtBackdrop pageId="scanner" />);
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    // ArtImg resolves to a real asset path from the rotation pool.
    expect(img!.getAttribute('src')).toMatch(/^\/(art|splash|nakamigos)\//);
    // Decorative only — must not be announced to assistive tech.
    expect(img!.getAttribute('alt')).toBe('');
  });

  it('is a non-interactive layer stacked behind content (absolute, -z-10, no pointer events)', () => {
    const { container } = render(<PageArtBackdrop pageId="launch" />);
    const layer = container.firstElementChild as HTMLElement;
    expect(layer).toBeTruthy();
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    expect(layer.className).toContain('absolute');
    expect(layer.className).toContain('inset-0');
    expect(layer.className).toContain('-z-10');
    expect(layer.className).toContain('pointer-events-none');
  });

  it('applies a scrim over the art for legibility', () => {
    const { container } = render(<PageArtBackdrop pageId="deployer" />);
    // Two children: the art <img> and the scrim overlay div with a background.
    const scrim = container.querySelector('div > div[style*="background"]');
    expect(scrim).toBeTruthy();
  });

  it('renders valid pooled art for every real page key it is wired into', () => {
    for (const pageId of ['launch', 'scanner', 'deployer', 'wallet-exposure', 'launch-simulator']) {
      const { container } = render(<PageArtBackdrop pageId={pageId} />);
      const src = container.querySelector('img')!.getAttribute('src');
      expect(src, `${pageId} should resolve to a real asset`).toMatch(/^\/(art|splash|nakamigos)\//);
    }
  });
});
