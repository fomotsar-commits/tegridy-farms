// The buy surface for a launch this rail just created — the one-signature,
// single-address, fully-disclosed atomic buy of docs/LAUNCHER_LIQUIDITY_AND_UX_RESEARCH.md
// Part B. One wallet, one confirmation, one address; nothing here splits a buy across
// wallets and nothing here hides who is buying.
//
// Every number this panel shows is a number it read or encoded. There is no estimated
// output, no "≈", and no default minimum: the quote comes from Doppler's V4 Quoter
// simulating the real auction hook, and the minimum shown is byte-for-byte the minimum
// inside the calldata the wallet is asked to sign. When any of that is missing the panel
// says which part is missing and offers no button — a launch is already paid for by the
// time this renders, so a buy that might revert or might fill at any price is strictly
// worse than a stated "not right now".
//
// DECIMALS ARE KNOWN, NOT ASSUMED: this panel renders only for tokens created through
// this rail, which are DopplerERC20V1 clones (18 decimals), paired against native ETH or
// TOWELI (verified 18 on-chain). Pointing it at an arbitrary token would break that.

import { useCallback, useEffect, useState } from 'react';
import { usePublicClient } from 'wagmi';
import { toast } from 'sonner';
import { formatEther, type Address } from 'viem';
import { useOneClickLaunchBuy } from '../../hooks/useOneClickLaunchBuy';
import {
  planLaunchBuy,
  DOPPLER_HOOK_POOL_KEY_ABI,
  DEFAULT_LAUNCH_BUY_SLIPPAGE_BPS,
  MIN_LAUNCH_BUY_SLIPPAGE_BPS,
  MAX_LAUNCH_BUY_SLIPPAGE_BPS,
  type LaunchBuyPlan,
} from '../../lib/launcher/launchBuy';
import { isLauncherEnabled } from '../../lib/launcher/config';
import type { V4PoolKey } from '../../lib/launcher/afterlife';
import { NATIVE_ETH } from '../../lib/launcher/airlock';
import { CHAIN_ID } from '../../lib/constants';
import { safeParseEther } from '../../lib/safeParseEther';
import { sanitizeDecimalInput } from '../../lib/formatting';

/** How long a quote may be acted on. A Dutch auction reprices every epoch; a minute-old
 *  floor is a number the user was shown but the pool no longer stands behind. */
export const QUOTE_TTL_SECONDS = 45;
/** Signed-order lifetime. Long enough for a batch to land, short enough that the Permit2
 *  allowance it also expires cannot be reused later. */
const DEADLINE_WINDOW_SECONDS = 300;

type PoolState =
  | { k: 'loading' }
  | { k: 'ok'; key: V4PoolKey }
  | { k: 'unavailable' };

type Phase =
  | { k: 'idle' }
  | { k: 'quoting' }
  | { k: 'ready'; plan: Extract<LaunchBuyPlan, { ok: true }>; quotedAt: number }
  | { k: 'refused'; reason: string }
  | { k: 'submitting' }
  | { k: 'sent'; id: string };

export interface LaunchBuyPanelProps {
  /** The launch's Doppler auction hook. The pool key is read from it. */
  hookAddress: Address;
  /** The token that was launched — shown so the buyer can check what they are buying. */
  tokenAddress: Address;
  /** Ticker as launched. Display only. */
  tokenSymbol: string;
  /** Base pair the launch settled in: NATIVE_ETH, or TOWELI for an exotic launch. */
  numeraire: Address;
  /** Injectable clock (unix seconds) so staleness is deterministic under test. */
  now?: () => number;
}

function Note({ tone, children }: { tone: 'amber' | 'slate'; children: React.ReactNode }) {
  const cls =
    tone === 'amber'
      ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
      : 'border-white/10 bg-white/5 text-white/60';
  return <div className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${cls}`}>{children}</div>;
}

export function LaunchBuyPanel({
  hookAddress,
  tokenAddress,
  tokenSymbol,
  numeraire,
  now = () => Math.floor(Date.now() / 1000),
}: LaunchBuyPanelProps) {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { canBatch, buyOneClick } = useOneClickLaunchBuy();

  const [pool, setPool] = useState<PoolState>({ k: 'loading' });
  const [amount, setAmount] = useState('');
  const [slippageBps, setSlippageBps] = useState(DEFAULT_LAUNCH_BUY_SLIPPAGE_BPS);
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [tick, setTick] = useState(0);

  const isNative = numeraire.toLowerCase() === NATIVE_ETH.toLowerCase();
  const numeraireLabel = isNative ? 'ETH' : 'TOWELI';

  // Read the pool the launch actually created. A failed read is reported as a failed
  // read — never as "no pool", which would read as a legitimate absence.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!publicClient) {
        setPool({ k: 'unavailable' });
        return;
      }
      setPool({ k: 'loading' });
      try {
        const r = (await publicClient.readContract({
          address: hookAddress,
          abi: DOPPLER_HOOK_POOL_KEY_ABI,
          functionName: 'poolKey',
        })) as readonly [Address, Address, number, number, Address];
        if (cancelled) return;
        setPool({
          k: 'ok',
          key: { currency0: r[0], currency1: r[1], fee: r[2], tickSpacing: r[3], hooks: r[4] },
        });
      } catch {
        if (!cancelled) setPool({ k: 'unavailable' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [publicClient, hookAddress]);

  // Drives the staleness re-render only; the authority on staleness is `now()`.
  useEffect(() => {
    if (phase.k !== 'ready') return;
    const t = setInterval(() => setTick((n) => n + 1), 5_000);
    return () => clearInterval(t);
  }, [phase.k]);

  const amountWei = safeParseEther(amount);

  const getQuote = useCallback(async () => {
    if (pool.k !== 'ok' || !publicClient || amountWei === null) return;
    setPhase({ k: 'quoting' });
    try {
      const { Quoter, getAddresses } = await import('@whetstone-research/doppler-sdk/evm');
      const router = getAddresses(CHAIN_ID).universalRouter as Address;
      const quoter = new Quoter(publicClient, CHAIN_ID);
      const plan = await planLaunchBuy(quoter, {
        poolKey: pool.key,
        paymentToken: numeraire,
        amountInWei: amountWei,
        slippageBps,
        router,
        deadline: BigInt(now() + DEADLINE_WINDOW_SECONDS),
      });
      if (plan.ok) setPhase({ k: 'ready', plan, quotedAt: now() });
      else setPhase({ k: 'refused', reason: plan.reason });
    } catch {
      setPhase({
        k: 'refused',
        reason:
          'We couldn’t reach the pricing contracts just now, so we can’t quote this buy. Nothing was sent.',
      });
    }
  }, [pool, publicClient, amountWei, numeraire, slippageBps, now]);

  const submit = useCallback(async () => {
    if (phase.k !== 'ready') return;
    // Checked HERE and not only on the button: the staleness hint repaints on a timer, so
    // between the quote ageing out and the next repaint the button is still live. This is
    // the check that actually stands between a stale floor and the wallet.
    if (now() - phase.quotedAt > QUOTE_TTL_SECONDS) {
      setPhase({
        k: 'refused',
        reason: `That quote is more than ${QUOTE_TTL_SECONDS}s old and the auction has repriced since. Nothing was sent — get a fresh quote.`,
      });
      return;
    }
    setPhase({ k: 'submitting' });
    try {
      const id = await buyOneClick(phase.plan.buy);
      setPhase({ k: 'sent', id });
      toast.success('Buy submitted in one signature.');
    } catch (e) {
      const reason = e instanceof Error ? e.message : 'The wallet rejected the batch.';
      setPhase({ k: 'refused', reason });
      toast.error(reason);
    }
  }, [phase, buyOneClick, now]);

  if (!isLauncherEnabled()) return null;

  const stale = phase.k === 'ready' && now() - phase.quotedAt > QUOTE_TTL_SECONDS;
  void tick; // staleness is recomputed on each interval tick

  return (
    <div className="mt-3 pt-3 border-t border-emerald-500/20" data-testid="launch-buy-panel">
      <div className="font-semibold text-emerald-100 mb-1">Buy your launch in one signature</div>
      <p className="text-emerald-200/60 text-xs leading-relaxed mb-3">
        One wallet, one confirmation, one address — the whole buy is visible in a single
        transaction from the address you launched with. This is disclosure, not concealment:
        it is the opposite of splitting a buy across fresh wallets to hide concentration.
      </p>

      {pool.k === 'loading' && <Note tone="slate">Reading the auction pool…</Note>}

      {pool.k === 'unavailable' && (
        <Note tone="amber">
          We couldn’t read this launch’s pool just now, so we can’t build a buy for it. This is a
          problem on our side — it does <span className="font-semibold">not</span> mean the pool is
          missing. Your launch is unaffected; buy from the token’s page once the read recovers.
        </Note>
      )}

      {pool.k === 'ok' && !canBatch && (
        <Note tone="amber">
          Your wallet doesn’t advertise atomic batching (EIP-5792), so this buy can’t be made
          all-or-nothing in one signature. We won’t offer a partial version of it — buy from the
          token’s page instead, or reconnect with a wallet that supports batched calls.
        </Note>
      )}

      {pool.k === 'ok' && canBatch && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-3">
            <label className="flex-1 min-w-[10rem]">
              <span className="block text-[11px] uppercase tracking-wide text-emerald-200/50 mb-1">
                Spend ({numeraireLabel})
              </span>
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  setAmount(sanitizeDecimalInput(e.target.value));
                  setPhase({ k: 'idle' });
                }}
                placeholder="0.0"
                aria-label={`Amount of ${numeraireLabel} to spend`}
                className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm text-white font-mono"
              />
            </label>
            <label className="w-32">
              <span className="block text-[11px] uppercase tracking-wide text-emerald-200/50 mb-1">
                Slippage (bps)
              </span>
              <input
                inputMode="numeric"
                value={slippageBps}
                onChange={(e) => {
                  const n = Number(e.target.value.replace(/\D/g, ''));
                  setSlippageBps(Number.isFinite(n) ? n : 0);
                  setPhase({ k: 'idle' });
                }}
                aria-label="Slippage tolerance in basis points"
                className="w-full rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm text-white font-mono"
              />
              <span className="block text-[10px] text-emerald-200/40 mt-1">
                {MIN_LAUNCH_BUY_SLIPPAGE_BPS}–{MAX_LAUNCH_BUY_SLIPPAGE_BPS}
              </span>
            </label>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={getQuote}
              disabled={amountWei === null || amountWei <= 0n || phase.k === 'quoting' || phase.k === 'submitting'}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/90 text-black disabled:opacity-40 hover:bg-emerald-400 transition"
            >
              {phase.k === 'quoting' ? 'Quoting…' : phase.k === 'ready' ? 'Refresh quote' : 'Get quote'}
            </button>
            {amount !== '' && amountWei === null && (
              <span className="text-rose-300 text-xs">Enter a positive decimal amount.</span>
            )}
          </div>

          {phase.k === 'refused' && (
            <Note tone="amber">
              <span className="font-semibold">This buy wasn’t sent.</span> {phase.reason}
            </Note>
          )}

          {phase.k === 'ready' && (
            <div className="rounded-lg border border-emerald-500/20 bg-black/20 px-3 py-2 text-xs text-emerald-100 space-y-1">
              <div className="flex justify-between gap-3">
                <span className="text-emerald-200/60">Quoted out</span>
                <span className="font-mono break-all">
                  {formatEther(phase.plan.quotedAmountOut)} {tokenSymbol}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-emerald-200/60">Minimum you receive</span>
                <span className="font-mono break-all">
                  {formatEther(phase.plan.minAmountOut)} {tokenSymbol}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-emerald-200/60">Slippage encoded</span>
                <span className="font-mono">{phase.plan.slippageBps} bps</span>
              </div>
              <p className="text-emerald-200/50 pt-1 leading-relaxed">
                The minimum above is the exact figure inside the transaction you’ll sign. If the
                pool can’t deliver it, the whole batch reverts and you keep your {numeraireLabel}.
              </p>
              {phase.plan.tokenOut.toLowerCase() !== tokenAddress.toLowerCase() && (
                <Note tone="amber">
                  This pool pays out a different token than the one just launched. Refusing to buy —
                  re-read the pool before continuing.
                </Note>
              )}
            </div>
          )}

          {phase.k === 'ready' && (
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={submit}
                disabled={stale || phase.plan.tokenOut.toLowerCase() !== tokenAddress.toLowerCase()}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-500/90 text-black disabled:opacity-40 hover:bg-emerald-400 transition"
              >
                Buy {tokenSymbol}
              </button>
              {stale && (
                <span className="text-amber-200 text-xs">
                  This quote is over {QUOTE_TTL_SECONDS}s old and the auction has repriced. Refresh it
                  before buying.
                </span>
              )}
            </div>
          )}

          {phase.k === 'submitting' && <Note tone="slate">Confirm the batch in your wallet…</Note>}

          {phase.k === 'sent' && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-100 break-all">
              Batch submitted. Your wallet tracks it under id <code>{phase.id}</code>.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
