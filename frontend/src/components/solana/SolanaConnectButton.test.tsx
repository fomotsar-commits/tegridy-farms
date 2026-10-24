// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { WalletReadyState } from '@solana/wallet-adapter-base';

/**
 * The connect button while a wallet is being waited on (owner, 2026-10-03: "it
 * won't even recognize my phantom wallet").
 *
 * A connect lasts as long as the wallet takes to answer. A locked wallet, or an
 * approval window that opened where nobody saw it, takes for ever, and for that
 * whole time this button was switched off and said only "Connecting…": no way to
 * the wallet list, no word on which wallet, nothing to do but reload. Seen live
 * with a remembered Phantom, and reproduced with a wallet whose connect never
 * answers.
 *
 * The wait is never cancelled here: a person reading an approval prompt must not
 * have it pulled away. The button only stops being a dead end.
 */

const state = vi.hoisted(() => ({
  connecting: false,
  connected: false,
  connect: vi.fn(() => Promise.resolve()),
  setVisible: vi.fn(),
  wallet: null as null | { readyState: string; adapter: { name: string; url: string } },
}));

vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({ wallet: state.wallet, connecting: state.connecting, connected: state.connected, connect: state.connect }),
}));
vi.mock('@solana/wallet-adapter-react-ui', () => ({
  useWalletModal: () => ({ setVisible: state.setVisible }),
}));

import { SolanaConnectButton } from './SolanaConnectButton';
import { SOLANA_CONNECT_WAIT_NOTICE_MS } from '../../lib/solanaSurface';

const phantom = () => ({ readyState: WalletReadyState.Installed, adapter: { name: 'Phantom', url: 'https://phantom.app' } });

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(state, { connecting: false, connected: false, wallet: phantom() });
  state.connect.mockClear();
  state.setVisible.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SolanaConnectButton while a wallet is being waited on', () => {
  it('connects a remembered, installed wallet on a press (the control)', () => {
    render(<SolanaConnectButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Solana Wallet' }));
    expect(state.connect).toHaveBeenCalledTimes(1);
    expect(state.setVisible).not.toHaveBeenCalled();
  });

  it('stays pressable while it waits, and a press opens the wallet list, never a second connect', () => {
    state.connecting = true;
    render(<SolanaConnectButton />);
    const button = screen.getByRole('button', { name: 'Connecting…' });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute('aria-disabled');
    fireEvent.click(button);
    expect(state.setVisible).toHaveBeenCalledWith(true);
    expect(state.connect).not.toHaveBeenCalled();
  });

  it('says nothing for the first seconds, so a wallet that answers at once shows no notice', () => {
    state.connecting = true;
    render(<SolanaConnectButton />);
    act(() => {
      vi.advanceTimersByTime(SOLANA_CONNECT_WAIT_NOTICE_MS - 1);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('then names the wallet it is waiting for, says what to do, and offers the list', () => {
    state.connecting = true;
    render(<SolanaConnectButton />);
    act(() => {
      vi.advanceTimersByTime(SOLANA_CONNECT_WAIT_NOTICE_MS);
    });
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent(/waiting for Phantom/i);
    expect(notice).toHaveTextContent(/locked/);
    expect(notice).toHaveTextContent(/approve/);
    fireEvent.click(screen.getByRole('button', { name: 'pick another wallet' }));
    expect(state.setVisible).toHaveBeenCalledWith(true);
  });

  it('takes the notice away when the wallet answers, and starts the count again for the next wait', () => {
    state.connecting = true;
    const view = render(<SolanaConnectButton />);
    act(() => {
      vi.advanceTimersByTime(SOLANA_CONNECT_WAIT_NOTICE_MS);
    });
    expect(screen.getByRole('status')).toBeTruthy();
    state.connecting = false;
    view.rerender(<SolanaConnectButton />);
    expect(screen.queryByRole('status')).toBeNull();
    // A new wait starts from nothing: no notice carried over from the last one.
    state.connecting = true;
    view.rerender(<SolanaConnectButton />);
    expect(screen.queryByRole('status')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(SOLANA_CONNECT_WAIT_NOTICE_MS);
    });
    expect(screen.getByRole('status')).toBeTruthy();
  });

  // Inside the real WalletProvider a wallet picked while another is being waited
  // on never shows `connecting` false: the provider ends the old wait and starts
  // the new one in the same pass (a Wallet Standard wallet's disconnect answers
  // later, so nothing in between says "not connecting"). The card then said
  // "Still waiting for Backpack" the instant Backpack was picked.
  it('starts the count again when the wallet being waited on changes, though the waiting never paused', () => {
    state.connecting = true;
    const view = render(<SolanaConnectButton />);
    act(() => {
      vi.advanceTimersByTime(SOLANA_CONNECT_WAIT_NOTICE_MS);
    });
    expect(screen.getByRole('status')).toHaveTextContent(/waiting for Phantom/i);
    state.wallet = { readyState: WalletReadyState.Installed, adapter: { name: 'Backpack', url: 'https://backpack.app' } };
    view.rerender(<SolanaConnectButton />);
    expect(screen.queryByRole('status')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(SOLANA_CONNECT_WAIT_NOTICE_MS - 1);
    });
    expect(screen.queryByRole('status')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('status')).toHaveTextContent(/waiting for Backpack/i);
  });

  // WalletConnect waits on a QR code in the list, or on the restore of its saved
  // session. There is no app of that name to open and nothing that can be
  // locked, and the list says nothing for it either (SolanaWalletModal).
  it('says nothing for WalletConnect, and stays pressable', () => {
    state.connecting = true;
    state.wallet = { readyState: WalletReadyState.Loadable, adapter: { name: 'WalletConnect', url: 'https://walletconnect.network' } };
    render(<SolanaConnectButton />);
    act(() => {
      vi.advanceTimersByTime(SOLANA_CONNECT_WAIT_NOTICE_MS * 3);
    });
    expect(screen.queryByRole('status')).toBeNull();
    const button = screen.getByRole('button', { name: 'Connecting…' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(state.setVisible).toHaveBeenCalledWith(true);
    expect(state.connect).not.toHaveBeenCalled();
  });

  it('names the wallet as its row in the list does: Trust is "Trust Wallet"', () => {
    state.connecting = true;
    state.wallet = { readyState: WalletReadyState.Installed, adapter: { name: 'Trust', url: 'https://trustwallet.com' } };
    render(<SolanaConnectButton />);
    act(() => {
      vi.advanceTimersByTime(SOLANA_CONNECT_WAIT_NOTICE_MS);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Still waiting for Trust Wallet. Open Trust Wallet:');
  });
});
