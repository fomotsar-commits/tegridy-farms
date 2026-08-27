import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { parseEther } from 'viem';
import { CurveCreateView, type CurveCreateStage } from './CurveCreatePanel';
import { IDENTITY_IMAGE_MAX_BYTES } from '../../lib/launcher/curveIdentity';

vi.mock('framer-motion', () => {
  const passthrough = new Proxy({}, { get: () => ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div> });
  return { m: { ...passthrough, div: ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div> }, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>, LazyMotion: ({ children }: { children?: React.ReactNode }) => <>{children}</>, domAnimation: {} };
});

function pngFile(bytes = 1024, name = 'coin.png'): File {
  return new File([new Uint8Array(bytes)], name, { type: 'image/png' });
}

function view(overrides: Partial<{ stage: CurveCreateStage; createdToken: `0x${string}` | null }> = {}) {
  const onCreate = vi.fn();
  const onRetryIdentity = vi.fn();
  const onReset = vi.fn();
  const onTrade = vi.fn();
  render(
    <CurveCreateView
      stage={overrides.stage ?? 'idle'}
      createdToken={overrides.createdToken ?? null}
      onCreate={onCreate}
      onRetryIdentity={onRetryIdentity}
      onReset={onReset}
      onTrade={onTrade}
    />,
  );
  return { onCreate, onRetryIdentity, onReset, onTrade };
}

function fillBasics() {
  fireEvent.change(screen.getByLabelText(/token name/i), { target: { value: 'Towelie Jr' } });
  fireEvent.change(screen.getByLabelText(/token symbol/i), { target: { value: 'twljr' } });
}

function attachImage(file: File = pngFile()) {
  fireEvent.change(screen.getByLabelText(/^token image$/i), { target: { files: [file] } });
}

describe('CurveCreateView', () => {
  it('keeps Create disabled until name, symbol AND an image are present', () => {
    view();
    const btn = screen.getByRole('button', { name: /create launch/i });
    expect(btn).toBeDisabled();
    fillBasics();
    // Identity is the price of entry: no image, no launch.
    expect(btn).toBeDisabled();
    attachImage();
    expect(btn).not.toBeDisabled();
  });

  it('rejects an oversized or non-image file with a visible reason and stays disabled', () => {
    view();
    fillBasics();
    attachImage(new File([new Uint8Array(IDENTITY_IMAGE_MAX_BYTES + 1)], 'big.png', { type: 'image/png' }));
    expect(screen.getByText(/KB or smaller/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create launch/i })).toBeDisabled();
  });

  it('uppercases the symbol and passes the full field set with a zero opening buy', () => {
    const { onCreate } = view();
    fillBasics();
    attachImage();
    fireEvent.change(screen.getByLabelText(/token description/i), { target: { value: 'a fine coin' } });
    fireEvent.change(screen.getByLabelText(/x \(twitter\) handle/i), { target: { value: '@towelie' } });
    fireEvent.click(screen.getByRole('button', { name: /create launch/i }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    const fields = onCreate.mock.calls[0]![0];
    expect(fields.name).toBe('Towelie Jr');
    expect(fields.symbol).toBe('TWLJR');
    expect(fields.openingBuyWei).toBe(0n);
    expect(fields.image).toBeInstanceOf(File);
    expect(fields.description).toBe('a fine coin');
    expect(fields.twitter).toBe('@towelie');
  });

  it('parses a non-blank opening buy into wei', () => {
    const { onCreate } = view();
    fillBasics();
    attachImage();
    fireEvent.change(screen.getByLabelText(/opening buy/i), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: /create launch/i }));
    expect(onCreate.mock.calls[0]![0].openingBuyWei).toBe(parseEther('0.5'));
  });

  it('blocks an un-parseable opening buy', () => {
    view();
    fillBasics();
    attachImage();
    fireEvent.change(screen.getByLabelText(/opening buy/i), { target: { value: '.' } });
    expect(screen.getByRole('button', { name: /create launch/i })).toBeDisabled();
  });

  it('shows the busy stage on the button and blocks re-submit', () => {
    view({ stage: 'publishing-identity' });
    const btn = screen.getByRole('button', { name: /publishing identity/i });
    expect(btn).toBeDisabled();
  });

  it('done: shows the token address and hands it to Trade it now', () => {
    const token = ('0x' + 'a'.repeat(40)) as `0x${string}`;
    const { onTrade } = view({ stage: 'done', createdToken: token });
    expect(screen.getByText(token)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /trade it now/i }));
    expect(onTrade).toHaveBeenCalledWith(token);
  });

  it('identity-failed: trading is not blocked and retry re-runs only the publish', () => {
    const token = ('0x' + 'b'.repeat(40)) as `0x${string}`;
    const { onRetryIdentity } = view({ stage: 'identity-failed', createdToken: token });
    expect(screen.getByText(/trading works either way/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry publishing identity/i }));
    expect(onRetryIdentity).toHaveBeenCalledTimes(1);
  });
});
