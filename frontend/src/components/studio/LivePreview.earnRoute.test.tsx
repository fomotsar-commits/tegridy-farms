// The farm surfaces' page is TOWELI's pool, /earn/toweli, and a pool page enters
// its own room on arrival. In a bungalow's studio that would replace the studio's
// ?bungalow= skin with TOWELI's, so there the preview goes to THAT bungalow's pool
// — what /farm?bungalow=<id> rendered until 2026-09-30.
import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LivePreview } from './LivePreview';

// jsdom has none; the preview only measures its pane with it.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const frameSrc = () => screen.getByTitle(/^Live preview:/).getAttribute('src') ?? '';

describe('LivePreview and the Earn pool pages', () => {
  it('the classic studio previews the farm surfaces on TOWELI’s pool', () => {
    render(<LivePreview pageId="farm" surfaceKey="farm:0" artSrc="" nonce={0} />);
    expect(frameSrc()).toMatch(/^\/earn\/toweli\?/);
  });

  it('a bungalow’s studio previews them on that bungalow’s pool, never through TOWELI’s door', () => {
    render(<LivePreview pageId="farm" surfaceKey="farm:0" artSrc="" nonce={0} query={{ bungalow: 'bayla' }} />);
    expect(frameSrc()).toMatch(/^\/earn\/bayla\?/);
    expect(frameSrc()).not.toContain('/earn/toweli');
  });

  it('leaves every other page’s route alone', () => {
    render(<LivePreview pageId="swap" surfaceKey="swap:0" artSrc="" nonce={0} query={{ bungalow: 'bayla' }} />);
    expect(frameSrc()).not.toMatch(/^\/earn/);
  });
});
