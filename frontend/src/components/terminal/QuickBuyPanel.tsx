import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useSwap } from '../../hooks/useSwap';
import { DEFAULT_TOKENS, type TokenInfo } from '../../lib/tokenList';
import { chartPoolUrl } from '../../lib/chart/market';
import { ETH_ADDRESS_RE, SOL_ADDRESS_RE } from '../../lib/scanner/scanner';
import type { GeckoNetwork } from '../../lib/geckoTerminal/pools';
import { terminalFeeDisclosure } from '../../lib/terminal/terminalFee';
import { buyAcknowledgement, isKnownSafe, type RowSafety } from '../../lib/terminal/rowSafety';
import { SafetyBadge } from './SafetyBadge';

// Buying, over the EXISTING paths — and saying plainly where there is no path.
//
// `useSwap` is the venue's swap hook, unmodified: same quote, same allowance
// flow, same SwapFeeRouter / UniswapV2Router submission. Nothing here builds a
// transaction, and nothing here computes a fee — `terminalFeeDisclosure` reads
// the one venue dial in lib/fees/swapFee.ts, so the terminal cannot charge on a
// build where swaps do not.
//
// THE FEED IS THREE CHAINS AND THE VENUE'S SWAP IS ONE. That mismatch is the
// whole design of this panel. The honest options are to say so per chain, or to
// grow the Base and Solana execution paths this build does not have — so:
//
//   Ethereum — the existing panel, unchanged, for tokens already imported.
//   Solana   — a LINK to /solana?out=<mint>, which is a hand-off, not a buy.
//   Base     — no buy at all, plus the two reads that do work there.
//
// TOKEN IMPORT IS NOT DONE HERE, on purpose. FE-HIGH-6 established that a token
// entering the swap state must have had its on-chain `symbol()`/`decimals()`
// checked against the import data first, and TokenSelectModal is where that
// check lives. A terminal that quietly set an arbitrary feed address as the
// output token would route an approval at whatever that address turns out to be
// — the precise attack that fix closed. So a token off the list is a link to the
// verifying importer, not a shortcut around it.
//
// EVERY ADDRESS IS RE-VALIDATED HERE before it reaches an href. The feed parser
// already validated it; this panel validates again because it is the module that
// builds the link, and a boundary that trusts its caller is a boundary that
// moves the day someone adds a second caller.
//
// THE ACKNOWLEDGEMENT IS NOT A DISCLAIMER. It fires on `!isKnownSafe`, the same
// predicate the green badge and the "fully read" filter use, so it appears for a
// row that came back risky AND for a row that could not be read — and
// `buyAcknowledgement` (lib/terminal/rowSafety.ts) names which, in an order that
// cannot contradict the badge sitting beside it.

export interface QuickBuyPanelProps {
  /** Output token address for the selected row, or empty when nothing is selected. */
  token: string;
  safety: RowSafety;
  /** Chain of the selected row. Undefined behaves as Ethereum (the indexer feed). */
  network?: GeckoNetwork;
  /** Pool address, for the external pool link on chains with no buy path. */
  pool?: string;
}

function validAddress(address: string, network: GeckoNetwork | undefined): string | null {
  const t = (address ?? '').trim();
  if (!t) return null;
  if (network === 'solana') return SOL_ADDRESS_RE.test(t) ? t : null;
  return ETH_ADDRESS_RE.test(t) ? t.toLowerCase() : null;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-xl border border-white/15 bg-white/[0.03] p-4" aria-label="Quick buy">
      <h2 className="text-sm font-semibold text-white">Quick buy</h2>
      {children}
    </section>
  );
}

const LINK = 'underline decoration-white/40 underline-offset-2 hover:decoration-white';

export function QuickBuyPanel({ token, safety, network, pool }: QuickBuyPanelProps) {
  const swap = useSwap();
  const [acknowledged, setAcknowledged] = useState(false);

  const known = isKnownSafe(safety);
  const target = (token ?? '').trim();
  const address = validAddress(target, network);

  const resolved: TokenInfo | null = useMemo(() => {
    // Only the Ethereum path may resolve against the swap token list. A Solana
    // mint or a Base address would never legitimately match, and matching one by
    // accident is exactly the wrong-chain routing this guard exists to prevent.
    if (!address || (network !== undefined && network !== 'eth')) return null;
    const listed = [...DEFAULT_TOKENS, ...swap.customTokens];
    return listed.find((t) => t.address.toLowerCase() === address) ?? null;
  }, [address, network, swap.customTokens]);

  // A new selection retracts the previous acknowledgement. Carrying it forward
  // would let a trader accept one row's unread state and buy a different one.
  useEffect(() => {
    setAcknowledged(false);
  }, [target]);

  useEffect(() => {
    if (resolved) swap.setToToken(resolved);
    // `swap` is rebuilt every render by useSwap; keying on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved]);

  const fee = terminalFeeDisclosure({ source: null, executes: true });
  const blocked = !resolved || (!known && !acknowledged);

  if (!target) {
    return (
      <Shell>
        <p className="mt-2 text-xs text-white/70">Select a row to load a buy.</p>
      </Shell>
    );
  }

  if (!address) {
    // The feed parser validates every row, so reaching this means something
    // upstream of it changed. Saying so beats rendering a link to a malformed
    // address, and beats silently rendering nothing.
    return (
      <Shell>
        <p className="mt-2 text-xs text-white/80">
          This row&rsquo;s token address could not be read as an address on {network ?? 'this chain'},
          so no link and no buy is offered for it.
        </p>
      </Shell>
    );
  }

  const header = (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className="break-all font-mono text-[11px] text-white/70">{address}</span>
      <SafetyBadge safety={safety} />
    </div>
  );

  // ── Solana: a hand-off, and it is called one ───────────────────────────────
  if (network === 'solana') {
    return (
      <Shell>
        {header}
        <p className="mt-3 text-xs leading-relaxed text-white/80">
          The venue&rsquo;s in-app swap is Ethereum mainnet only, so nothing is bought from this
          page. This is a link to the Solana swap page with this mint preset.
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-white/65">
          That page resolves the mint&rsquo;s decimals from Jupiter before it shows a quote. If
          Jupiter cannot resolve this mint it keeps its own default output token rather than
          guessing — so check the token on the page before you trade.
        </p>
        <p className="mt-3">
          <Link to={`/solana?out=${encodeURIComponent(address)}`} className={`text-xs ${LINK}`}>
            Open the Solana swap page with this mint &rarr;
          </Link>
        </p>
        {!known ? (
          // Information, not a gate. A checkbox in front of a LINK would imply
          // this page controls what happens on the other side of it.
          <p className="mt-3 rounded-md border border-amber-400/40 bg-amber-400/[0.07] p-2 text-[11px] leading-snug text-white/85">
            {buyAcknowledgement(safety)}
          </p>
        ) : null}
      </Shell>
    );
  }

  // ── Base: no rail, said out loud, with the two reads that do work ──────────
  if (network === 'base') {
    const poolAddress = pool ? validAddress(pool, 'base') : null;
    return (
      <Shell>
        {header}
        <p className="mt-3 text-xs leading-relaxed text-white/80">
          This pool is on Base. The venue&rsquo;s swap path is Ethereum mainnet only, so there is no
          in-app buy here and this page will not pretend otherwise.
        </p>
        <ul className="mt-3 space-y-2 text-xs">
          <li>
            <Link to={`/scan?token=${encodeURIComponent(address)}&chain=base`} className={LINK}>
              Scan this token&rsquo;s holder distribution on Base &rarr;
            </Link>
          </li>
          {poolAddress ? (
            <li>
              <a
                href={chartPoolUrl({ network: 'base', pool: poolAddress, label: 'pool' })}
                target="_blank"
                rel="noopener noreferrer"
                className={LINK}
              >
                GeckoTerminal pool page (external) &rarr;
              </a>
            </li>
          ) : null}
        </ul>
        {!known ? (
          <p className="mt-3 rounded-md border border-amber-400/40 bg-amber-400/[0.07] p-2 text-[11px] leading-snug text-white/85">
            {buyAcknowledgement(safety)}
          </p>
        ) : null}
      </Shell>
    );
  }

  // ── Ethereum: the existing path, unchanged ─────────────────────────────────
  return (
    <Shell>
      {header}
      {!resolved ? (
        <p className="mt-3 text-xs leading-relaxed text-white/80">
          Buy via Trade after import. In-app buys here route only tokens you have already imported
          and verified on{' '}
          <Link to="/swap" className={LINK}>
            Trade
          </Link>
          , where a token&rsquo;s on-chain symbol and decimals are checked against the import data
          before it can be routed. Everything else is a link to that importer. This token is not on
          the list yet.
        </p>
      ) : (
        <>
          <label className="mt-3 block text-[11px] font-medium uppercase tracking-wide text-white/60">
            Amount in {swap.fromToken?.symbol ?? 'ETH'}
            <input
              type="text"
              inputMode="decimal"
              value={swap.inputAmount}
              onChange={(e) => swap.setInputAmount(e.target.value)}
              className="mt-1 min-h-11 w-full rounded-md border border-white/20 bg-black/30 px-2 py-1.5 font-mono text-sm text-white"
              placeholder="0.0"
            />
          </label>

          <dl className="mt-3 space-y-1 text-xs">
            <div className="flex justify-between">
              <dt className="text-white/70">Estimated out</dt>
              <dd className="font-mono text-white">
                {swap.isQuoteLoading ? 'quoting…' : (swap.outputFormatted || '—')}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-white/70">{fee.label}</dt>
              <dd className={`font-mono ${fee.charged ? 'text-amber-200' : 'text-white'}`}>
                {fee.value}
              </dd>
            </div>
          </dl>
          <p className="mt-1 text-[10px] leading-snug text-white/60">{fee.note}</p>

          {!known ? (
            <label className="mt-3 flex items-start gap-2 rounded-md border border-amber-400/40 bg-amber-400/[0.07] p-2 text-[11px] leading-snug text-white/85">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
                className="mt-0.5"
              />
              <span>{buyAcknowledgement(safety)}</span>
            </label>
          ) : null}

          <div className="mt-3 flex gap-2">
            {swap.needsApproval ? (
              <button
                type="button"
                onClick={() => swap.approve()}
                disabled={blocked || swap.isPending}
                className="inline-flex min-h-11 items-center rounded-md border border-white/25 px-3 text-xs font-semibold text-white disabled:opacity-40"
              >
                Approve
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => swap.executeSwap()}
              disabled={blocked || swap.needsApproval || swap.isPending || swap.insufficientBalance}
              className="inline-flex min-h-11 items-center rounded-md border border-emerald-400/50 bg-emerald-400/10 px-3 text-xs font-semibold text-white disabled:opacity-40"
            >
              {swap.isPending || swap.isConfirming ? 'Submitting…' : 'Buy'}
            </button>
          </div>
        </>
      )}
    </Shell>
  );
}
