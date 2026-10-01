import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { IpfsImg } from './IpfsImg';
import { IPFS_GATEWAYS, IPFS_STEP_TIMEOUT_MS } from '../lib/ipfsGateways';

const CID = 'QmaTrk9RrN3yhwyB1EbRFrxBEEtcbBaGs2NppJGn262Bid';
const ON = (i: number, file = '1.png') => `${IPFS_GATEWAYS[i]}${CID}/${file}`;
const LAST = IPFS_GATEWAYS.length - 1;

afterEach(() => { vi.useRealTimers(); });

describe('IpfsImg', () => {
  // The last gateway gets a timer too: a hang there (orbitor and aleph take
  // ~30s to 504) reaches the caller's own fallback instead of a blank image.
  it('calls onExhausted when the LAST gateway hangs', async () => {
    vi.useFakeTimers();
    const onExhausted = vi.fn();
    render(<IpfsImg src={ON(LAST)} alt="art" onExhausted={onExhausted} />);
    await act(async () => { vi.advanceTimersByTime(IPFS_STEP_TIMEOUT_MS); });
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted.mock.calls[0][0]).toBe(screen.getByAltText('art'));
  });

  it('calls onExhausted once every gateway has errored, not before', () => {
    const onExhausted = vi.fn();
    render(<IpfsImg src={`ipfs://${CID}/1.png`} alt="art" onExhausted={onExhausted} />);
    for (let i = 0; i < IPFS_GATEWAYS.length; i++) {
      expect(screen.getByAltText('art')).toHaveAttribute('src', ON(i));
      expect(onExhausted).not.toHaveBeenCalled();
      fireEvent.error(screen.getByAltText('art'));
    }
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it('a non-IPFS image behaves like a plain <img>: no timer, onExhausted on error', async () => {
    vi.useFakeTimers();
    const onExhausted = vi.fn();
    const onError = vi.fn();
    render(<IpfsImg src="https://nft-cdn.alchemy.com/x" alt="art" onError={onError} onExhausted={onExhausted} />);
    await act(async () => { vi.advanceTimersByTime(IPFS_STEP_TIMEOUT_MS * 3); });
    expect(onExhausted).not.toHaveBeenCalled();
    fireEvent.error(screen.getByAltText('art'));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(screen.getByAltText('art')).toHaveAttribute('src', 'https://nft-cdn.alchemy.com/x');
  });

  it('starts over on the first gateway when the src prop changes', () => {
    const { rerender } = render(<IpfsImg src={ON(0)} alt="art" />);
    fireEvent.error(screen.getByAltText('art'));
    expect(screen.getByAltText('art')).toHaveAttribute('src', ON(1));
    rerender(<IpfsImg src={ON(0, '2.png')} alt="art" />);
    expect(screen.getByAltText('art')).toHaveAttribute('src', ON(0, '2.png'));
  });
});
