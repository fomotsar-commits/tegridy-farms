import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { LaunchImage } from './LaunchIdentity';
import { IPFS_GATEWAYS, IPFS_STEP_TIMEOUT_MS, ipfsGatewayUrls } from '../../../lib/ipfsGateways';

// A launch's picture (list rows and the launch page) is on IPFS, and a gateway can
// HANG: no answer and no error event, ever. A plain <img> with an onError walk sits
// on a hung gateway forever, so the picture stays blank. LaunchImage must move on
// after one step with no error event, and fall back to its placeholder when every
// gateway has hung.

const CID = 'bafkreigh2akiscaildcqabsyg3dfr6chu3fgpregiymsck7e7aqa4s52zy';
const URLS = ipfsGatewayUrls(`ipfs://${CID}`);
const img = (c: HTMLElement) => c.querySelector('img');

afterEach(() => {
  vi.useRealTimers();
});

describe('LaunchImage: a picture on a hung IPFS gateway', () => {
  it('starts on a live gateway, not the ipfs:// address itself', () => {
    const { container } = render(<LaunchImage src={`ipfs://${CID}`} />);
    expect(img(container)).toHaveAttribute('src', URLS[0]);
  });

  it('moves to the next gateway after one step, with no error event', async () => {
    vi.useFakeTimers();
    const { container } = render(<LaunchImage src={`ipfs://${CID}`} />);
    expect(img(container)).toHaveAttribute('src', URLS[0]);
    await act(async () => {
      vi.advanceTimersByTime(IPFS_STEP_TIMEOUT_MS - 1);
    });
    expect(img(container), 'a slow gateway gets its whole step').toHaveAttribute('src', URLS[0]);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(img(container)).toHaveAttribute('src', URLS[1]);
  });

  it('shows the placeholder, not a blank picture, once every gateway has hung', async () => {
    vi.useFakeTimers();
    const { container } = render(<LaunchImage src={`ipfs://${CID}`} />);
    for (let i = 0; i < IPFS_GATEWAYS.length; i++) {
      expect(img(container)).toHaveAttribute('src', URLS[i]);
      await act(async () => {
        vi.advanceTimersByTime(IPFS_STEP_TIMEOUT_MS);
      });
    }
    expect(img(container)).toBeNull();
    expect(container.querySelector('div[aria-hidden="true"]')).not.toBeNull();
  });

  it('still moves on when a gateway answers with an error', () => {
    const { container } = render(<LaunchImage src={`ipfs://${CID}`} />);
    fireEvent.error(img(container)!);
    expect(img(container)).toHaveAttribute('src', URLS[1]);
  });
});
