// The card-purchase surface. Four states, and three of them are refusals.
//
// The honesty rule this panel exists to satisfy: an unconfigured on-ramp must SAY it is
// unconfigured. Rendering nothing would be indistinguishable from a partner outage, and
// rendering a widget with no key would be a payment form that fails after the card number
// is typed. So the not-configured branch names the missing keys, states the alternative
// that always works (send ETH from somewhere you already have it), and stops.
//
// Nothing here opens a window on its own. The handoff is a link the user clicks, pointed at
// the partner's own origin, `rel="noopener noreferrer"` — payment details are collected by
// the licensed partner on their site, never by this venue, and never inside our chrome.

import { useMemo, useState, type ReactNode } from 'react';
import type { OnrampProviderId } from '../../lib/onramp/config';
import { onrampStatus } from '../../lib/onramp/config';
import {
  formatPartnerFeeBps,
  onrampPartnerFeeDisclosure,
} from '../../lib/onramp/partnerFee';
import { requiresSignature, type OnrampChain } from '../../lib/onramp/widgetUrl';
import { useOnrampSession } from '../../hooks/useOnrampSession';

export interface FiatOnrampPanelProps {
  /** The connected receiving address, or undefined when no wallet is connected. */
  walletAddress?: string;
  /**
   * Which chain the purchase should land on. Ethereum-only today: routing a Solana
   * purchase needs a Solana receiving address, which this flow does not ask for and must
   * not guess — an EVM address handed to a Solana ramp is funds sent nowhere.
   */
  chain?: OnrampChain;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-5">
      <h3 className="text-white/85 font-semibold text-sm mb-2">Buy ETH with a card</h3>
      {children}
    </div>
  );
}

/** The fee sentence. Never says "no fee" from an unset dial — see partnerFee.ts. */
function PartnerFeeLine() {
  const disclosure = onrampPartnerFeeDisclosure();
  if (!disclosure.declared) {
    return (
      <p className="text-white/40 text-[11px] leading-relaxed">
        This venue’s share of the purchase is not declared in this build, which is not the
        same as there being none. The partner’s checkout shows the complete breakdown —
        their fee, the network fee and the rate — and that breakdown is the authority:
        nothing on this page is a quote.
      </p>
    );
  }
  return (
    <p className="text-white/40 text-[11px] leading-relaxed">
      This venue receives a partner fee of {formatPartnerFeeBps(disclosure.bps)} on the
      purchase, charged by the partner on top of their own fee. Their checkout shows the
      complete breakdown, including the rate — nothing on this page is a quote.
    </p>
  );
}

export function FiatOnrampPanel({ walletAddress, chain = 'ethereum' }: FiatOnrampPanelProps) {
  const status = useMemo(() => onrampStatus(), []);
  const [selectedId, setSelectedId] = useState<OnrampProviderId | null>(
    status.providers[0]?.id ?? null,
  );
  const provider = status.providers.find((p) => p.id === selectedId) ?? null;
  const { state, prepare } = useOnrampSession({ provider, chain, walletAddress });

  if (status.providers.length === 0) {
    return (
      <Shell>
        <p className="text-white/70 text-[13px] leading-relaxed">
          Card purchases are <strong className="text-white/85">not configured</strong> on
          this deployment. No card rail is running here, and none is hidden behind a
          button — there is nothing to click.
        </p>
        <p className="text-white/60 text-[12px] mt-2 leading-relaxed">
          Fund your wallet by sending ETH from an exchange or another wallet you control.
          That path needs nothing from this venue and is what most people use anyway.
        </p>
        <div className="mt-3 rounded-lg border border-white/10 bg-black/30 p-3">
          <p className="text-white/45 text-[11px] mb-1.5">
            Operator: a partner account plus these keys turn this on.
          </p>
          <ul className="text-white/40 text-[11px] space-y-1">
            {status.unconfigured.map((u) => (
              <li key={u.id}>
                <span className="text-white/60">{u.label}</span> — missing{' '}
                <code className="text-white/50">{u.missing.join(', ')}</code>
              </li>
            ))}
          </ul>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      {status.providers.length > 1 && (
        <div className="flex gap-2 mb-3" role="group" aria-label="Card purchase partner">
          {status.providers.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelectedId(p.id)}
              aria-pressed={p.id === selectedId}
              className={`px-3 py-1.5 rounded-lg text-[12px] border transition-colors min-h-[36px] ${
                p.id === selectedId
                  ? 'border-emerald-400/50 text-white bg-emerald-500/10'
                  : 'border-white/15 text-white/60 hover:text-white/85'
              }`}
            >
              {p.descriptor.label}
            </button>
          ))}
        </div>
      )}

      <p className="text-white/60 text-[12px] leading-relaxed mb-3">
        {provider ? provider.descriptor.label : 'The partner'} is a licensed payment
        provider. Clicking through opens their site in a new tab, where you enter your card
        and identity details with them. This venue never receives them, and cannot see or
        reverse the purchase.
      </p>

      {state.kind === 'needs-address' && (
        <p className="text-white/50 text-[12px]">
          Connect a wallet first — the purchase needs an address to deliver to, and this
          page will not guess one.
        </p>
      )}

      {state.kind === 'invalid-address' && (
        <p className="text-amber-300/80 text-[12px]">
          That address is not a valid {chain} address, so no purchase can be prepared.
        </p>
      )}

      {state.kind === 'needs-preparation' && provider && (
        <button
          type="button"
          onClick={prepare}
          className="btn-primary px-5 py-2 text-[13px]"
        >
          Prepare purchase with {provider.descriptor.label}
        </button>
      )}

      {state.kind === 'preparing' && (
        <p className="text-white/50 text-[12px]" role="status">Preparing a secure handoff…</p>
      )}

      {state.kind === 'unavailable' && (
        <p className="text-amber-300/80 text-[12px]" role="status">
          {state.reason} Card purchases are unavailable right now — this is an outage, not
          a price or a limit on your account.
        </p>
      )}

      {state.kind === 'ready' && provider && (
        <a
          href={state.url}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-primary inline-block px-5 py-2 text-[13px]"
        >
          Continue to {provider.descriptor.label}
        </a>
      )}

      <div className="mt-3 space-y-1.5">
        <PartnerFeeLine />
        <p className="text-white/40 text-[11px] leading-relaxed">
          Availability, limits and accepted payment methods are decided by the partner from
          your own jurisdiction. This page cannot tell you whether you are eligible — their
          checkout can, and it is the only thing that knows.
        </p>
        {provider && requiresSignature(provider) && (
          <p className="text-white/35 text-[11px] leading-relaxed">
            {provider.descriptor.label} requires the purchase link to be signed by this
            venue before it opens, so the button above prepares it first.
          </p>
        )}
      </div>
    </Shell>
  );
}
