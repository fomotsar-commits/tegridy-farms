import { useCallback, useEffect, useRef, useState } from 'react';
import {
  referralLinkForAddress,
  referralLinkForCode,
  truncatedLinkLabel,
  tweetIntentUrl,
} from '../../lib/referrals/link';
import { REF_CODE_RE } from '../../lib/referrals/attribution';
import { claimCode, readOwnCode, type CodeStoreStatus } from '../../lib/referrals/codesClient';

// The link a referrer carries off-site, and the two forms it comes in.
//
// ─── THE LONG FORM IS THE PRODUCT; THE SHORT FORM IS A CONVENIENCE ───────────
//
// `/?ref=0xabc…` is self-contained. It resolves in the visitor's browser with no
// server, no database and no migration, so it cannot 404 into "we could not tell
// who referred you" on a link that has already gone out. It is what this card
// mints by default and what the Copy and Tweet controls always carry.
//
// `/?r=code` is shorter and strictly weaker: it needs the code store, which
// needs `019_referral_codes.sql` applied by hand. Every failure of that store is
// rendered as itself below — never as "you have no code", which would tell a
// wallet that has minted one that it has not.
//
// The ordering matters. The short form is offered UNDER the long one, as an
// extra, so a reader who ignores the whole section still leaves with a working
// link. Inverting that would put the fragile artefact in the primary slot.
//
// ─── WHAT THIS CARD DOES NOT DECIDE ─────────────────────────────────────────
//
// Whether sharing is a good idea. That is the qualification threshold, and it is
// ReferralQualificationNotice's job, rendered above this card by ReferralsPanel.
// This card takes `warnBeforeSharing` and repeats a one-line pointer, because a
// user who scrolled straight to the Copy button should not be able to reach it
// without the warning being adjacent — but it deliberately does NOT restate the
// rule, so there is exactly one place the threshold is authored.

interface Props {
  /** The connected wallet. Null renders the connect prompt, not an empty link. */
  address: string | null;
  /**
   * True when the qualification verdict is anything other than `qualified` —
   * including `unknown`. See lib/referrals/qualification.ts:shouldWarnBeforeSharing.
   */
  warnBeforeSharing: boolean;
  /** Injection seam for tests; production uses the global. */
  fetchImpl?: typeof fetch;
}

/** Store states that are NOT "you have no code" and must not render as one. */
const STORE_PROBLEM: Record<Exclude<CodeStoreStatus, 'ready'>, string> = {
  'signed-out': 'Short codes are stored against your wallet. Sign in to mint or read one.',
  'not-configured': 'This deployment has no code store, so short links cannot be minted here.',
  'schema-missing': 'The code table has not been created on this deployment, so no code could ever have been minted.',
  unreachable: 'The code store did not answer, so nothing is known about your code either way.',
  rejected: 'The code store refused that request.',
};

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Clipboard API is unavailable over http, in some embedded webviews, and
    // without a user-gesture in others. Fall through rather than failing the
    // one action this card exists for.
  }
  const el = document.createElement('textarea');
  el.value = text;
  Object.assign(el.style, { position: 'fixed', left: '-9999px', opacity: '0' });
  document.body.appendChild(el);
  el.select();
  document.execCommand('copy');
  document.body.removeChild(el);
}

export function ReferralShareCard({ address, warnBeforeSharing, fetchImpl }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [status, setStatus] = useState<CodeStoreStatus | 'loading'>('loading');
  const [detail, setDetail] = useState<string | null>(null);
  const [operatorStep, setOperatorStep] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  // Read the wallet's own code once it is connected. A disconnected wallet is
  // not an outage: there is genuinely nothing to read, and `signed-out` says so
  // in its own words.
  useEffect(() => {
    if (!address) {
      setStatus('signed-out');
      setCode(null);
      setDetail(null);
      setOperatorStep(null);
      return;
    }
    let cancelled = false;
    const ac = new AbortController();
    setStatus('loading');
    void (async () => {
      const result = await readOwnCode({ signal: ac.signal, fetchImpl });
      if (cancelled) return;
      setStatus(result.status);
      setCode(result.code);
      setDetail(result.detail);
      setOperatorStep(result.operatorStep);
    })();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [address, fetchImpl]);

  const onCopy = useCallback(async (key: string, text: string) => {
    await copyText(text);
    setCopied(key);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(null), 2000);
  }, []);

  const onMint = useCallback(async () => {
    const wanted = draft.trim().toLowerCase();
    if (!REF_CODE_RE.test(wanted)) return;
    setMinting(true);
    const result = await claimCode({ code: wanted }, { fetchImpl });
    setStatus(result.status);
    setCode(result.code);
    setDetail(result.detail);
    setOperatorStep(result.operatorStep);
    setMinting(false);
  }, [draft, fetchImpl]);

  if (!address) {
    return (
      <section
        className="rounded-xl p-4"
        style={{ background: '#000', border: '1px solid var(--color-purple-75)' }}
        aria-label="Your referral link"
      >
        <h3 className="text-white text-[13px] font-medium">Your referral link</h3>
        <p className="mt-2 text-white/60 text-[12px] leading-relaxed">
          A referral link points at a payee address, so there is nothing to mint until a wallet is connected. This is
          not an error — no link exists yet because no address does.
        </p>
      </section>
    );
  }

  const longLink = referralLinkForAddress(address);
  const shortLink = code ? referralLinkForCode(code) : null;
  const draftValid = REF_CODE_RE.test(draft.trim().toLowerCase());
  const problem = status !== 'ready' && status !== 'loading' ? (detail ?? STORE_PROBLEM[status]) : null;

  return (
    <section
      className="rounded-xl p-4"
      style={{ background: '#000', border: '1px solid var(--color-purple-75)' }}
      aria-label="Your referral link"
    >
      <h3 className="text-white text-[13px] font-medium">Your referral link</h3>

      {warnBeforeSharing && (
        <p role="alert" className="mt-2 text-[11px] leading-relaxed" style={{ color: '#FFD37C' }}>
          Read the requirement above before you share this. On today’s reading your referees’ fees do not reach you.
        </p>
      )}

      <p className="mt-2 text-white/50 text-[11px] leading-relaxed">
        This form needs no server and cannot expire. It is the one to share.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <div className="flex-1 min-w-0 bg-black/40 rounded-lg px-3 py-2.5 border border-white/20">
          <p className="text-white text-[13px] truncate font-mono">{truncatedLinkLabel(address)}</p>
        </div>
        <button
          type="button"
          onClick={() => void onCopy('long', longLink)}
          aria-label="Copy referral link"
          className="flex-shrink-0 btn-primary px-4 py-2.5 text-[12px] min-w-[72px]"
        >
          {copied === 'long' ? 'Copied!' : 'Copy'}
        </button>
      </div>

      <div className="mt-3">
        <a
          href={tweetIntentUrl(longLink)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Tweet referral link (opens in new tab)"
          className="inline-flex items-center gap-2 bg-black/40 hover:bg-black/60 border border-white/20 rounded-lg px-4 py-2.5 text-white hover:text-white text-[12px] transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
          Tweet it
        </a>
      </div>

      {/* ─── The optional short form ─────────────────────────────────────── */}
      <div className="mt-5 pt-4 border-t border-white/10">
        <h4 className="text-white/80 text-[12px] font-medium">A shorter link (optional)</h4>
        <p className="mt-1 text-white/50 text-[11px] leading-relaxed">
          Nicer to paste, and strictly weaker: it needs this deployment’s code store to resolve. The link above keeps
          working whatever this section says.
        </p>

        {status === 'loading' && <p className="mt-2 text-white/50 text-[11px]">Reading your code…</p>}

        {status === 'ready' && shortLink && (
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 min-w-0 bg-black/40 rounded-lg px-3 py-2.5 border border-white/20">
              <p className="text-white text-[13px] truncate font-mono">{shortLink}</p>
            </div>
            <button
              type="button"
              onClick={() => void onCopy('short', shortLink)}
              aria-label="Copy short referral link"
              className="flex-shrink-0 btn-primary px-4 py-2.5 text-[12px] min-w-[72px]"
            >
              {copied === 'short' ? 'Copied!' : 'Copy'}
            </button>
          </div>
        )}

        {status === 'ready' && !shortLink && (
          <div className="mt-2">
            <label htmlFor="referral-code-draft" className="block text-white/70 text-[11px] mb-1">
              Choose a code — 4 to 12 lowercase letters or digits
            </label>
            <div className="flex items-center gap-2">
              <input
                id="referral-code-draft"
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value.trim().toLowerCase())}
                placeholder="towelie"
                className="flex-1 bg-black/40 border border-white/20 rounded-lg px-3 py-2.5 text-white text-[13px] font-mono focus:border-purple-500 outline-none transition-colors"
              />
              <button
                type="button"
                onClick={() => void onMint()}
                disabled={!draftValid || minting}
                className="flex-shrink-0 btn-primary px-4 py-2.5 text-[12px] disabled:opacity-40"
              >
                {minting ? 'Saving…' : 'Mint'}
              </button>
            </div>
            {draft.length > 0 && !draftValid && (
              <p className="mt-1 text-[11px]" style={{ color: '#FFD37C' }}>
                4–12 characters, lowercase letters and digits only.
              </p>
            )}
          </div>
        )}

        {/* Every non-ready state prints itself. `code` stays null throughout, so a
            caller that ignores `status` shows no link rather than a wrong one. */}
        {problem && (
          <p role="status" className="mt-2 text-white/70 text-[11px] leading-relaxed">
            {problem}
          </p>
        )}
        {operatorStep && (
          <p className="mt-1 text-white/50 text-[11px] leading-relaxed">
            <span className="uppercase tracking-wide">Operator: </span>
            {operatorStep}
          </p>
        )}
      </div>
    </section>
  );
}

export default ReferralShareCard;
