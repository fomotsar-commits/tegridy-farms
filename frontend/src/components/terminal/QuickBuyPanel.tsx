import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSwap } from '../../hooks/useSwap';
import { DEFAULT_TOKENS, type TokenInfo } from '../../lib/tokenList';
import { terminalFeeDisclosure } from '../../lib/terminal/terminalFee';
import { isKnownSafe, type RowSafety } from '../../lib/terminal/rowSafety';
import { SafetyBadge } from './SafetyBadge';

// One-click buy, over the EXISTING swap path.
//
// `useSwap` is the venue's swap hook, unmodified: same quote, same allowance
// flow, same SwapFeeRouter / UniswapV2Router submission. Nothing here builds a
// transaction, and nothing here computes a fee — `terminalFeeDisclosure` reads
// the one venue dial in lib/fees/swapFee.ts, so the terminal cannot charge on a
// build where swaps do not.
//
// TOKEN IMPORT IS NOT DONE HERE, on purpose. FE-HIGH-6 established that a token
// entering the swap state must have had its on-chain `symbol()`/`decimals()`
// checked against the import data first, and TokenSelectModal is where that
// check lives. A terminal that quietly set an arbitrary feed address as the
// output token would route an approval at whatever that address turns out to be
// — the precise attack that fix closed. So a token off the list is a link to the
// verifying importer, not a shortcut around it.
//
// THE ACKNOWLEDGEMENT IS NOT A DISCLAIMER. It fires on `!isKnownSafe`, which is
// the same predicate the green badge and the "fully read" filter use — so it
// appears for a row that came back risky AND for a row that could not be read,
// and it names which. A trader is never asked to accept a risk the page is
// pretending to have measured.

export interface QuickBuyPanelProps {
  /** Output token address for the selected row, or empty when nothing is selected. */
  token: string;
  safety: RowSafety;
}

export function QuickBuyPanel({ token, safety }: QuickBuyPanelProps) {
  const swap = useSwap();
  const [acknowledged, setAcknowledged] = useState(false);

  const known = isKnownSafe(safety);
  const target = (token ?? '').trim();

  const resolved: TokenInfo | null = useMemo(() => {
    if (!target) return null;
    const lower = target.toLowerCase();
    const listed = [...DEFAULT_TOKENS, ...swap.customTokens];
    return listed.find((t) => t.address.toLowerCase() === lower) ?? null;
  }, [target, swap.customTokens]);

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

  return (
    <section className="rounded-xl border border-white/15 bg-white/[0.03] p-4" aria-label="Quick buy">
      <h2 className="text-sm font-semibold text-white">Quick buy</h2>

      {!target ? (
        <p className="mt-2 text-xs text-white/70">Select a pair to load a buy.</p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] text-white/70">{target}</span>
            <SafetyBadge safety={safety} />
          </div>

          {!resolved ? (
            <p className="mt-3 text-xs leading-relaxed text-white/80">
              This token is not on your swap token list. Import it from{' '}
              <Link to="/swap" className="underline decoration-white/40 underline-offset-2">
                Trade
              </Link>
              , where its on-chain symbol and decimals are checked against the import data before it
              can be routed. It becomes buyable here once it is on the list.
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
                  className="mt-1 w-full rounded-md border border-white/20 bg-black/30 px-2 py-1.5 font-mono text-sm text-white"
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
                  <span>
                    {safety.kind === 'unscored'
                      ? 'This row could not be scored, so nothing about this token has been measured. I am buying without a safety read.'
                      : safety.coverage === 'partial'
                        ? 'This row was only partly read, so it carries no safety result. I am buying without a complete safety read.'
                        : 'This row was read and it showed findings. I have read them and am buying anyway.'}
                  </span>
                </label>
              ) : null}

              <div className="mt-3 flex gap-2">
                {swap.needsApproval ? (
                  <button
                    type="button"
                    onClick={() => swap.approve()}
                    disabled={blocked || swap.isPending}
                    className="rounded-md border border-white/25 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                  >
                    Approve
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => swap.executeSwap()}
                  disabled={blocked || swap.needsApproval || swap.isPending || swap.insufficientBalance}
                  className="rounded-md border border-emerald-400/50 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                >
                  {swap.isPending || swap.isConfirming ? 'Submitting…' : 'Buy'}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
