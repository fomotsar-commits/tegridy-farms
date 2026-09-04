import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { ArtImg } from './ArtImg';

/**
 * A MISSING DERIVATIVE MUST DEGRADE TO THE ORIGINAL, NEVER TO THE PLACEHOLDER.
 *
 * Found in CI, not by reasoning: after responsive `srcset` was added, the
 * bungalow-doors spec failed with
 *
 *     Expected substring: "/art/bayla/"
 *     Received string:    "/placeholder-nft.svg"
 *
 * One srcset candidate 404'd, the <img> errored, and the single-step onError
 * swapped real art for a placeholder. The manifest and the PROD gate are supposed
 * to make that impossible, but they are promises about the BUILD — a stale
 * manifest, a skipped `prebuild`, a partial artifact upload or a CDN miss all
 * break them, and the user sees a placeholder where a painting should be.
 *
 * So the fallback has two steps, and this pins both.
 */
// MUST be a source that actually HAS derivatives, or there is no srcset and the
// first error is a genuine missing-original — which correctly goes straight to the
// placeholder and proves nothing. An earlier version of this file used
// /art/bayla/bayla-14.jpg, which is under the generator's 150 KB floor and absent
// from the manifest, so the test failed against correct code.
const WITH_DERIVATIVES = '/art/ape-hug.jpg';

vi.mock('../lib/artConfig', () => ({
  pageArt: () => ({ src: '/art/ape-hug.jpg' }),
}));

afterEach(() => vi.unstubAllEnvs());

describe('ArtImg — srcset failure recovery', () => {
  it('falls back to the ORIGINAL, not the placeholder, on the first error', () => {
    vi.stubEnv('PROD', true);
    const { container } = render(<ArtImg pageId="home" idx={12} />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(WITH_DERIVATIVES);

    // Simulate a 404 on whichever candidate the browser chose.
    fireEvent.error(img);

    const after = container.querySelector('img')!;
    expect(after.getAttribute('src'), 'a missing derivative must not become a placeholder')
      .toBe(WITH_DERIVATIVES);
    expect(after.getAttribute('srcset'), 'srcset must be dropped so the original is retried')
      .toBeNull();
  });

  it('only reaches the placeholder when the ORIGINAL also fails', () => {
    vi.stubEnv('PROD', true);
    const { container } = render(<ArtImg pageId="home" idx={12} />);
    const img = container.querySelector('img')!;
    fireEvent.error(img);                                  // candidate failed
    fireEvent.error(container.querySelector('img')!);      // original failed too
    expect(container.querySelector('img')!.getAttribute('src')).toContain('placeholder');
  });

  it('still calls the caller onError on every failure', () => {
    vi.stubEnv('PROD', true);
    const onError = vi.fn();
    const { container } = render(<ArtImg pageId="home" idx={12} onError={onError} />);
    fireEvent.error(container.querySelector('img')!);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
