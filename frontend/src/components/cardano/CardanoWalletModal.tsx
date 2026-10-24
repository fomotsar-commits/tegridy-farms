import { useEffect, useState } from 'react';
import { CopyButton } from '../ui/CopyButton';
import { Modal } from '../ui/Modal';
import { detectWallets } from '../../lib/cardano/cip30';
import { connectCardanoWallet, disconnectCardanoWallet, useCardanoWallet } from '../../lib/cardano/walletStore';

/**
 * The Cardano wallet list. Every row says what a press does (Connect / Install), nothing is
 * folded behind "more", as SolanaWalletModal does it. Detection polls for a moment, because an
 * extension can inject its object after the page has loaded. The shared Modal gives it the
 * site's focus trap, Escape, backdrop and scroll lock.
 */
export function CardanoWalletModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const wallet = useCardanoWallet();
  const [rows, setRows] = useState(() => detectWallets());

  useEffect(() => {
    if (!open) return;
    let n = 0;
    const first = setTimeout(() => setRows(detectWallets()), 0);
    const timer = setInterval(() => {
      setRows(detectWallets());
      if (++n >= 6) clearInterval(timer);
    }, 500);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [open]);

  useEffect(() => {
    if (wallet.status === 'connected' && open) onClose();
    // Closes once, on the connect that happened while the list was open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.status]);

  return (
    <Modal open={open} onClose={onClose} title={wallet.status === 'connected' ? 'Your Cardano wallet' : 'Connect a Cardano wallet'} maxWidth="max-w-sm">
      <div className="text-white">

        {wallet.status === 'connected' ? (
          <div className="space-y-3">
            <p className="text-[12px] text-white/70">{wallet.name}</p>
            <p className="font-mono text-[11px] break-all text-white/85">{wallet.address.bech32}</p>
            <div className="flex gap-3">
              <CopyButton text={wallet.address.bech32} display="Copy address" className="min-h-[44px] text-[12px] underline" />
              <button
                type="button"
                onClick={() => {
                  disconnectCardanoWallet();
                  onClose();
                }}
                className="min-h-[44px] text-[12px] underline text-white/80 hover:text-white"
              >
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <ul className="space-y-2">
            {rows.map(({ info, installed }) => (
              <li key={info.key}>
                {installed ? (
                  <button
                    type="button"
                    onClick={() => void connectCardanoWallet(info.key)}
                    disabled={wallet.status === 'connecting'}
                    className="w-full min-h-[48px] flex items-center justify-between rounded-xl px-4 text-[14px] disabled:opacity-60"
                    style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.14)' }}
                  >
                    <span>{info.name}</span>
                    <span className="text-[11px] text-success">
                      {wallet.status === 'connecting' && wallet.key === info.key ? 'Waiting for the wallet…' : 'Detected · Connect'}
                    </span>
                  </button>
                ) : (
                  <a
                    href={info.site}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="w-full min-h-[48px] flex items-center justify-between rounded-xl px-4 text-[14px]"
                    style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.10)' }}
                  >
                    <span className="text-white/80">{info.name}</span>
                    <span className="text-[11px] text-white/60">Install ↗</span>
                  </a>
                )}
              </li>
            ))}
          </ul>
        )}
        {wallet.status === 'error' && (
          <p role="alert" className="mt-3 text-[12px] text-danger">
            {wallet.message}
          </p>
        )}
        <p className="mt-4 text-[11px] text-white/55">On a phone, open this page inside your wallet’s own browser (Eternl or VESPR).</p>
      </div>
    </Modal>
  );
}
