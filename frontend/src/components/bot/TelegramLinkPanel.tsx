import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount } from 'wagmi';
import {
  claimLinkCode,
  listLinks,
  revokeLinkById,
  LINK_CODE_RE,
  type LinkStoreResult,
  type TelegramLink,
} from './botLinkClient';

// The browser half of the Telegram link, and the only place a binding can be created.
//
// WHY THE BINDING HAPPENS HERE AND NOT IN THE CHAT. A Telegram message cannot prove
// who owns a wallet; a signature can. The bot mints a one-time code, the user carries
// it here, and this panel spends it against a session that already required a SIWE
// signature. The bot's own credential can mint a code, read one chat's state and
// destroy a binding — it can never attach a wallet to one. That asymmetry is the
// whole architecture, and it is why this venue's bot has no key to lose.
//
// WHAT THIS PANEL DELIBERATELY DOES NOT RENDER:
//
//   * A "connect your wallet to the bot for trading" affordance. There is none and
//     there will not be one in this shape.
//   * The Telegram account behind a binding. The server never returns it — the id is
//     stored only as an HMAC digest (migration 020) — so there is nothing to show,
//     and inventing a label would be describing a row we deliberately cannot read.
//   * An empty list when the store could not be read. Every non-ready state prints
//     itself instead, because "no chats linked" and "we could not ask" lead a user
//     to opposite conclusions about whether someone else's chat is reading their
//     wallet.
//
// The bot itself runs nowhere yet — it is built and unhosted, like the indexer. The
// notice below says so rather than letting a user link a chat and wait for a reply
// that no process exists to send.

interface Props {
  /** Test seam. Production passes nothing. */
  fetchImpl?: typeof fetch;
}

const OPERATOR_PREFIX = 'Operator: ';

/**
 * The link code the bot put in the URL, read from `window.location` rather than
 * from react-router.
 *
 * Deliberate: this panel is a leaf of AlertsPanel, which AlertsPage.test.tsx and
 * anything else may render on its own. A `useSearchParams` here makes a Router a
 * hard requirement of every ancestor's tests, and the first symptom is an
 * unrelated page suite failing with an invariant from a library it does not use.
 * The URL is the fact; the router is one way of reading it.
 *
 * Captured ONCE at mount, so a claim in flight cannot be re-read mid-render.
 */
function readPendingCode(): string {
  if (typeof window === 'undefined') return '';
  return (new URLSearchParams(window.location.search).get('tglink') ?? '').trim().toUpperCase();
}

function whenLinked(seconds: number): string {
  if (!seconds) return 'at an unrecorded time';
  return `on ${new Date(seconds * 1000).toISOString().slice(0, 10)}`;
}

export function TelegramLinkPanel({ fetchImpl }: Props) {
  const [store, setStore] = useState<LinkStoreResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [spent, setSpent] = useState(false);
  const [claimMessage, setClaimMessage] = useState<string | null>(null);
  const [claimStep, setClaimStep] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const { isConnected } = useAccount();

  const urlCode = useMemo(() => readPendingCode(), []);
  const pendingCode = spent ? '' : urlCode;

  const refresh = useCallback(async () => {
    setStore(await listLinks({ fetchImpl }));
  }, [fetchImpl]);

  // A binding is keyed to a wallet, so with no wallet there is no question to ask.
  // Asking anyway would spend a request to be told 401 and would render as
  // "signed out" a beat later — the same answer, arrived at more slowly and at the
  // cost of a rate-limit slot on every page load by every visitor.
  useEffect(() => {
    if (!isConnected) {
      setStore(null);
      return;
    }
    void refresh();
  }, [isConnected, refresh]);

  const onClaim = useCallback(async () => {
    setBusy(true);
    setClaimMessage(null);
    setClaimStep(null);
    const outcome = await claimLinkCode(pendingCode, { fetchImpl });
    setBusy(false);
    if (outcome.status === 'linked') {
      setClaimMessage('Linked. That chat can now ask this wallet’s read-only questions, and nothing else.');
      // Retire the offer so the button cannot be pressed twice against a code the
      // server has already spent. The URL is left alone on purpose — rewriting it
      // behind react-router's back desynchronises its location, and a refresh that
      // re-offers the code is answered honestly ("that code is not open") by a
      // server that already burned it.
      setSpent(true);
      await refresh();
      return;
    }
    setClaimMessage(outcome.detail);
    setClaimStep(outcome.status === 'failed' ? outcome.operatorStep : null);
  }, [fetchImpl, pendingCode, refresh]);

  const onRevoke = useCallback(
    async (link: TelegramLink) => {
      setBusy(true);
      setRevokeError(null);
      const result = await revokeLinkById(link.id, { fetchImpl });
      setBusy(false);
      // Only re-read on success. Re-reading after a failure would repaint the list
      // and make a binding that is still live look as though it had been dealt with.
      if (result.ok) await refresh();
      else setRevokeError(result.detail);
    },
    [fetchImpl, refresh],
  );

  return (
    <section
      className="rounded-xl p-4"
      style={{ background: '#000', border: '1px solid var(--color-purple-75)' }}
      aria-label="Telegram"
    >
      <h3 className="text-white text-[13px] font-medium">Telegram</h3>

      <p className="mt-2 text-white/70 text-[11px] leading-snug">
        Link a Telegram chat to this wallet and the bot can answer read-only questions there — your standing, your
        venue-routed swaps, a token scan. It is a <strong>read</strong> grant and nothing more.
      </p>

      <p className="mt-2 text-white/70 text-[11px] leading-snug">
        The bot holds no key and can sign nothing. Anything that would move value comes back to you as a link you open
        and sign in your own wallet, here. It will never ask you for a recovery phrase, a private key or a password —
        anything that does is not us, whatever it is called.
      </p>

      {pendingCode.length > 0 && (
        <div className="mt-3 rounded-lg p-3" style={{ border: '1px solid var(--color-purple-75)' }}>
          <p className="text-white text-[12px]">
            A chat is waiting to be linked with code <code className="text-white/80">{pendingCode}</code>.
          </p>
          {LINK_CODE_RE.test(pendingCode) ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void onClaim()}
              className="mt-2 px-3 py-1 rounded-lg text-[11px] text-white disabled:opacity-50"
              style={{ background: 'var(--color-purple-80)' }}
            >
              {busy ? 'Linking…' : 'Link that chat to this wallet'}
            </button>
          ) : (
            <p className="mt-1 text-white/70 text-[11px] leading-snug">
              That is not the shape of a link code, so nothing was sent. Send the bot /link for a fresh one.
            </p>
          )}
        </div>
      )}

      {claimMessage && (
        <p className="mt-2 text-white/80 text-[11px] leading-snug" role="status">
          {claimMessage}
        </p>
      )}
      {claimStep && (
        <p className="mt-1 text-white/50 text-[11px] leading-snug">
          <span className="uppercase tracking-wide">{OPERATOR_PREFIX}</span>
          {claimStep}
        </p>
      )}

      <h4 className="mt-4 text-white/80 text-[12px] font-medium">Chats linked to this wallet</h4>

      {!isConnected && (
        <p className="mt-1 text-white/70 text-[11px] leading-snug">
          Bindings are stored against your wallet, so nothing was read. Connect and sign in to see which chats can ask
          about it — this is not a statement that none can.
        </p>
      )}

      {isConnected && store === null && <p className="mt-1 text-white/50 text-[11px]">Reading…</p>}

      {/* Every non-ready state prints ITSELF. There is no branch here that falls
          through to an empty list, because an empty list is an answer. */}
      {store !== null && store.status !== 'ready' && (
        <>
          <p className="mt-1 text-white/70 text-[11px] leading-snug">{store.detail}</p>
          {store.operatorStep && (
            <p className="mt-1 text-white/50 text-[11px] leading-snug">
              <span className="uppercase tracking-wide">{OPERATOR_PREFIX}</span>
              {store.operatorStep}
            </p>
          )}
        </>
      )}

      {store !== null && store.status === 'ready' && store.links.length === 0 && (
        <p className="mt-1 text-white/70 text-[11px] leading-snug">
          No chat is linked to this wallet. Send the bot <code>/link</code> to start one.
        </p>
      )}

      {store !== null && store.status === 'ready' && store.links.length > 0 && (
        <ul className="mt-2 space-y-2">
          {store.links.map((link) => (
            <li key={link.id} className="flex items-center justify-between gap-3">
              <span className="text-white/80 text-[11px]">Linked {whenLinked(link.linkedAt)}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void onRevoke(link)}
                className="px-2 py-[2px] rounded-full text-[11px] text-white/80 disabled:opacity-50"
                style={{ border: '1px solid currentColor' }}
              >
                Unlink
              </button>
            </li>
          ))}
        </ul>
      )}

      {revokeError && (
        <p className="mt-2 text-[11px] leading-snug" style={{ color: '#FFD37C' }} role="alert">
          {revokeError}
        </p>
      )}

      <details className="mt-3">
        <summary className="text-white/60 text-[11px] cursor-pointer">Where the bot runs, and what it cannot do</summary>
        <ul className="mt-2 space-y-1 list-disc pl-4">
          <li className="text-white/50 text-[11px] leading-snug">
            The bot is built and hosted nowhere. Until an operator brings it up, no chat will answer — see
            <code className="ml-1">bot/DEPLOY.md</code>. Linking a chat before then is harmless and simply waits.
          </li>
          <li className="text-white/50 text-[11px] leading-snug">
            Nothing in this venue runs on a schedule, so no alert is delivered to Telegram. Rules are evaluated in this
            browser tab while the app is open, and the delivery panel above says the same.
          </li>
          <li className="text-white/50 text-[11px] leading-snug">
            Balances and fills answer only once an indexer is hosted. Until then the bot says so rather than answering
            zero.
          </li>
          <li className="text-white/50 text-[11px] leading-snug">
            Unlinking takes effect immediately and can also be done from the chat itself with <code>/unlink</code>.
          </li>
        </ul>
      </details>
    </section>
  );
}

export default TelegramLinkPanel;
