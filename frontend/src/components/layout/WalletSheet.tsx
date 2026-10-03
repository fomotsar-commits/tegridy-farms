import { useEffect, useState, type ReactNode } from 'react';
import { Modal } from '../ui/Modal';
import { shortSolanaAddress, useSolanaSurface, wantOwnSolana } from '../../lib/solanaSurface';

/**
 * The top bar's wallet sheet: one row per network, Solana first.
 *
 * The top bar's Connect used to open the Ethereum list straight away, on every
 * page. A Trust wallet picked there was offered Ethereum, Robinhood Chain and
 * Base and nothing else (owner, 2026-10-02), because no Ethereum connect can
 * ask a wallet for Solana. So the button asks which network first, the way the
 * large two-network apps do (Jumper's "select an ecosystem" step; Uniswap's
 * one chip that lists both wallets). Each row then opens that network's own
 * list: the Solana wallet list, or RainbowKit, both unchanged.
 *
 * This sheet lists no wallets and connects nothing itself.
 *
 * ── CLOSE FIRST, OPEN ON THE NEXT FRAME ──
 *
 * Every row closes this sheet and opens the next dialog a frame later, never
 * in the same tick. Modal locks the page's scroll and remembers where focus
 * was, and gives both back when it closes; the Solana list does the same and
 * reads the page's state as it opens. Opened in the same tick it would read
 * this sheet's lock as the page's own and put it back when it closed (a page
 * that no longer scrolls), and it would hand focus back to a row that is gone.
 * A frame later this sheet has let go of both.
 *
 * ── THE SOLANA ROW WAITS HERE, WITH THE SHEET OPEN ──
 *
 * Where the page has no Solana section, the top bar's own connection is loaded
 * on the first tap (TopBarSolana.tsx). The sheet stays open and says so until
 * it has loaded and any saved wallet has finished reconnecting; then it closes,
 * and opens the list only if that did not connect. Closing the sheet while it
 * waits cancels the open, so a list never appears later, uninvited.
 */

/** The Ethereum side, as RainbowKit's ConnectButton.Custom hands it over. */
export interface EvmWallet {
  /** The account's display name, or null when none is connected. */
  readonly label: string | null;
  readonly connect: (() => void) | undefined;
  readonly account: (() => void) | undefined;
}

interface WalletSheetProps {
  open: boolean;
  onClose: () => void;
  evm: EvmWallet;
}

const ROW_CLASS =
  'w-full text-left rounded-xl px-4 py-3 min-h-[64px] flex items-center justify-between gap-3 transition-colors hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6]';
const ROW_STYLE = { background: 'rgba(4,9,18,0.85)', border: '1px solid rgba(139,92,246,0.45)' };

function Row({
  name,
  detail,
  value,
  busy,
  onClick,
}: {
  name: string;
  detail: ReactNode;
  value: string | null;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button type="button" onClick={onClick} aria-busy={busy || undefined} className={ROW_CLASS} style={ROW_STYLE}>
        <span className="min-w-0">
          <span className="block text-white text-[15px] font-semibold">{name}</span>
          <span className="block text-white/70 text-[12.5px] leading-snug">{detail}</span>
        </span>
        {value && <span className="flex-shrink-0 font-mono text-[12.5px] text-white/85">{value}</span>}
      </button>
    </li>
  );
}

export function WalletSheet({ open, onClose, evm }: WalletSheetProps) {
  const { surface, ownFailed } = useSolanaSurface();
  const solanaAddress = surface?.address ?? null;
  const anyConnected = solanaAddress !== null || evm.label !== null;
  // The Solana row was tapped with no Solana connection mounted yet.
  const [waiting, setWaiting] = useState(false);
  // However the sheet closes, it stops waiting (state from the previous
  // render, compared in render: no effect, no extra pass). That is also what
  // makes the effect below act once, and never after the visitor closed it.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open && waiting) setWaiting(false);
  }

  const closeThen = (next: (() => void) | undefined) => {
    onClose();
    if (next) requestAnimationFrame(() => next());
  };

  // The top bar's own connection has loaded and its restore is over.
  useEffect(() => {
    if (!waiting || !surface || surface.connecting) return;
    onClose();
    // A saved wallet that reconnected answers the tap; otherwise the list opens.
    const openList = surface.open;
    if (!surface.address) requestAnimationFrame(() => openList());
  }, [waiting, surface, onClose]);

  const onSolana = () => {
    if (surface) {
      closeThen(surface.open);
      return;
    }
    setWaiting(true);
    wantOwnSolana();
  };

  const onEthereum = () => closeThen(evm.label ? evm.account : evm.connect);

  const loading = waiting && !surface && !ownFailed;
  const solanaDetail = solanaAddress
    ? 'Switch wallet or disconnect'
    : ownFailed
      ? 'Couldn’t load Solana wallets. Check your connection and tap to try again.'
      : loading
        ? 'Loading Solana wallets…'
        : surface?.connecting
          ? 'Connecting…'
          : 'Phantom, Trust, Jupiter, Solflare and more';
  const ethereumDetail = evm.label ? 'Account and disconnect' : 'MetaMask, Trust, Rainbow and more';

  return (
    <Modal open={open} onClose={onClose} title={anyConnected ? 'Your wallets' : 'Connect a wallet'} maxWidth="max-w-sm">
      {!anyConnected && (
        <p className="text-white/80 text-[13px] leading-relaxed mb-3">Pick a network. Each one connects on its own.</p>
      )}
      <ul className="flex flex-col gap-2.5 list-none p-0 m-0">
        <Row
          name="Solana"
          detail={<span role={ownFailed ? 'alert' : undefined}>{solanaDetail}</span>}
          value={solanaAddress ? shortSolanaAddress(solanaAddress) : null}
          busy={loading}
          onClick={onSolana}
        />
        <Row name="Ethereum, Base, Robinhood Chain" detail={ethereumDetail} value={evm.label} onClick={onEthereum} />
      </ul>
    </Modal>
  );
}
