import { useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Modal } from '../ui/Modal';
import { reloadPage } from '../../lib/reloadPage';
import {
  SOLANA_CONNECT_WAIT_NOTICE_MS,
  getSolanaSurfaceState,
  noteOwnSolanaFailed,
  shortSolanaAddress,
  useSolanaSurface,
  wantOwnSolana,
} from '../../lib/solanaSurface';

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
 * ── THE NEXT DIALOG OPENS FROM THE COMMIT THAT CLOSED THIS ONE ──
 *
 * Modal locks the page's scroll and remembers where focus was, and gives both
 * back when it closes. The Solana list does the same, and reads the page's
 * state as it opens. If it opens while this sheet still holds the lock, it
 * takes the lock for the page's own and puts it back when it closes: a page
 * that no longer scrolls until a reload, with focus dropped on <body>.
 *
 * "Close, then open on the next animation frame" was the first attempt, and it
 * was wrong: a close asked for from an effect is rendered by a later task, and
 * nothing orders that task before a frame. On a phone the frame came first
 * most of the time (review, 2026-10-03). So no clock is used. A row leaves what
 * to open in `afterClose` and closes the sheet; the effect on `open` below
 * opens it. In the commit that closes the sheet React runs every effect
 * cleanup, Modal's among them, before any effect body, so by the time this one
 * runs the scroll lock is released and focus is back on the top bar's button.
 *
 * ── THE SOLANA ROW WAITS HERE, WITH THE SHEET OPEN ──
 *
 * Where the page has no Solana section, the top bar's own connection loads on
 * the first tap (TopBarSolana.tsx). The sheet stays open until it has loaded
 * and a saved wallet's restore is over; then it closes, and opens the list
 * unless that connected. Both waits have a limit: a load that does not end is
 * said to have failed, and a restore that does not end (a locked wallet) opens
 * the list, which names the wallet. Closing the sheet cancels the open.
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

/** How long "Loading Solana wallets…" may stand before it is called failed. */
const LOAD_LIMIT_MS = 15_000;

const ROW_CLASS =
  'w-full text-left rounded-xl px-4 py-3 min-h-[64px] flex items-center justify-between gap-3 transition-colors hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6]';
const ROW_STYLE = { background: 'rgba(4,9,18,0.85)', border: '1px solid rgba(139,92,246,0.45)' };

/** Opens whichever Solana list is mounted NOW: a connect handler captured earlier may belong to a wallet since cleared. */
const openSolanaList = () => getSolanaSurfaceState().surface?.open();

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
        {/* A long ENS name must not crush the row's own words on a phone. */}
        {value && (
          <span title={value} className="flex-shrink-0 max-w-[55%] truncate font-mono text-[12.5px] text-white/85">
            {value}
          </span>
        )}
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
  // makes the waiting effect below act once, and never after the visitor closed it.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open && waiting) setWaiting(false);
  }

  // What to open once this sheet has closed (see the header).
  const afterClose = useRef<(() => void) | null>(null);
  const closeThen = (next: (() => void) | undefined) => {
    afterClose.current = next ?? null;
    onClose();
  };
  useEffect(() => {
    const next = afterClose.current;
    if (open || !next) return;
    afterClose.current = null;
    next();
  }, [open]);

  // The top bar's own connection has loaded and its restore is over: a saved
  // wallet that reconnected answers the tap; otherwise the list opens.
  useEffect(() => {
    if (!waiting || !surface || surface.connecting) return;
    afterClose.current = surface.address ? null : openSolanaList;
    onClose();
  }, [waiting, surface, onClose]);

  // A restore that does not end stops holding the sheet: the list opens, and
  // names the wallet. The wallet's own wait goes on (a prompt may be open).
  const stalled = waiting && Boolean(surface?.connecting);
  useEffect(() => {
    if (!stalled) return;
    const timer = setTimeout(() => {
      afterClose.current = openSolanaList;
      onClose();
    }, SOLANA_CONNECT_WAIT_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [stalled, onClose]);

  const loading = waiting && !surface && !ownFailed;
  // A load that never ends is a failed one: say so, and stop the spinner.
  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(noteOwnSolanaFailed, LOAD_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [loading]);

  // With an Ethereum wallet connected the chip keeps naming that account, so a
  // Solana connect made from this sheet changes nothing in the top bar: say it.
  const askedSolana = useRef(false);
  const hasEvm = evm.label !== null;
  useEffect(() => {
    if (!askedSolana.current || !solanaAddress) return;
    askedSolana.current = false;
    if (hasEvm) toast(`Solana wallet ${shortSolanaAddress(solanaAddress)} connected. Tap your wallet at the top to see both.`);
  }, [solanaAddress, hasEvm]);

  const onSolana = () => {
    if (ownFailed) {
      // A failed chunk or stylesheet is not fetched again in the same tab, and
      // after a deploy its old name is gone for good: only a new page gets it.
      reloadPage();
      return;
    }
    if (!solanaAddress) askedSolana.current = true;
    if (surface) {
      closeThen(openSolanaList);
      return;
    }
    setWaiting(true);
    wantOwnSolana();
  };

  const onEthereum = () => closeThen(evm.label ? evm.account : evm.connect);

  const solanaDetail = solanaAddress
    ? 'Switch wallet or disconnect'
    : ownFailed
      ? 'Couldn’t load Solana wallets. Tap to reload the page.'
      : loading
        ? 'Loading Solana wallets…'
        : surface?.connecting
          ? 'Connecting…'
          : 'Phantom, Trust, Jupiter, Solflare and more';
  const ethereumDetail = evm.label ? 'Account and disconnect' : 'MetaMask, Trust, Rainbow and more';
  // Said once, outside the row: a status inside a button is not read out.
  const solanaStatus = ownFailed ? 'Couldn’t load Solana wallets.' : loading ? 'Loading Solana wallets…' : '';

  return (
    <Modal open={open} onClose={onClose} title={anyConnected ? 'Your wallets' : 'Connect a wallet'} maxWidth="max-w-sm">
      {!anyConnected && (
        <p className="text-white/80 text-[13px] leading-relaxed mb-3">Pick a network. Each one connects on its own.</p>
      )}
      <ul className="flex flex-col gap-2.5 list-none p-0 m-0">
        <Row
          name="Solana"
          detail={solanaDetail}
          value={solanaAddress ? shortSolanaAddress(solanaAddress) : null}
          busy={loading}
          onClick={onSolana}
        />
        <Row name="Ethereum, Base, Robinhood Chain" detail={ethereumDetail} value={evm.label} onClick={onEthereum} />
      </ul>
      <p role="status" className="sr-only">
        {solanaStatus}
      </p>
    </Modal>
  );
}
