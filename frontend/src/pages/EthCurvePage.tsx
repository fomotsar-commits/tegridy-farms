// The EVM own-curve surface — create a launch on the zero-toll Tegridy curve and
// trade any live curve token. Distinct from /curve-launch (Solana) and /launch
// (the Doppler auction rail): this is OUR curve, no Airlock, no petition, 100%
// of the fee kept in-house.
//
// Gated on deployment the same way every L2 piece is: until the operator
// broadcasts DeployCurveLauncher (M.16), curveLauncherOn(CHAIN_ID) answers
// 'not-deployed' and the page shows the coming-soon state + how-it-works, never
// a dead button.

import { useEffect, useMemo, useState } from 'react';
import { m } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { useChainId } from 'wagmi';
import { isAddress, type Address } from 'viem';
import { usePageTitle } from '../hooks/usePageTitle';
import { trackPageView } from '../lib/analytics';
import { PageArtBackdrop } from '../components/PageArtBackdrop';
import { FeatureNotDeployed } from '../components/ui/FeatureNotDeployed';
import { WrongChainBanner } from '../components/ui/WrongChainGuard';
import { CHAIN_ID } from '../lib/constants';
import { getChainConfig } from '../lib/chains/registry';
import { curveLauncherOn } from '../lib/launcher/curve';
import { CurveCreatePanel } from '../components/launcher/CurveCreatePanel';
import { CurveTradePanel } from '../components/launcher/CurveTradePanel';
import { CurveLaunchesGrid } from '../components/launcher/CurveLaunchesGrid';

const PAGE_ID = 'eth-curve';
const cardStyle = { border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(6,12,26,0.6)' } as const;

/** Pure, prop-free explainer of the curve's economics — safe to render anywhere. */
export function CurveHowItWorks() {
  const points: { k: string; v: string }[] = [
    { k: 'Zero third-party tolls', v: 'No Airlock, no migrator, no petition. 100% of the 1% trade fee stays in-house.' },
    { k: 'Fee split 40 / 25 / 35', v: 'Every trade funds the creator (40%), the Jungle Bay treasury (25%) and the protocol (35%).' },
    { k: 'Graduate to us', v: 'Hitting the raise target seeds the Tegridy pool with all raised ETH + unsold tokens — LP burned to 0x…dEaD, nobody can pull it.' },
    { k: '3.69% survival reserve', v: "Carved from each launch's supply and released to fund that pool's LP incentives, bribes and bounties." },
  ];
  return (
    <div className="rounded-2xl p-5 space-y-3" style={cardStyle}>
      <h2 className="text-white font-semibold text-sm">How the Tegridy curve works</h2>
      <ul className="space-y-2">
        {points.map((p) => (
          <li key={p.k} className="text-[12px] leading-relaxed">
            <span className="text-white/90 font-medium">{p.k}. </span>
            <span className="text-white/60">{p.v}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Trade any curve token by pasting its address (until a launch explorer exists).
 *  `prefill` lets the create flow hand its fresh token straight to the trade
 *  panel — the "Trade it now" jump on the success card. */
function TradeByAddress({ launcher, chainId, prefill }: { launcher: Address; chainId: number; prefill?: Address | null }) {
  const [input, setInput] = useState('');
  useEffect(() => {
    if (prefill) setInput(prefill);
  }, [prefill]);
  const token = useMemo<Address | null>(() => (isAddress(input) ? (input as Address) : null), [input]);
  return (
    <div className="space-y-3">
      <div className="rounded-2xl p-5" style={cardStyle}>
        <label className="block text-[11px] text-white/55 mb-1">Trade a curve token — paste its address</label>
        <input
          className="w-full px-3 py-2 rounded-lg bg-black/55 text-white text-[13px] font-mono outline-none"
          style={{ border: '1px solid rgba(255,255,255,0.18)' }}
          aria-label="Curve token address to trade"
          placeholder="0x…"
          value={input}
          onChange={(e) => setInput(e.target.value.trim())}
        />
        {input.length > 0 && !token && <p className="text-amber-300/80 text-[11px] mt-1">Not a valid address.</p>}
      </div>
      {token && <CurveTradePanel launcher={launcher} token={token} chainId={chainId} />}
    </div>
  );
}

export default function EthCurvePage() {
  usePageTitle('Tegridy Curve', 'Launch and trade on the zero-toll Tegridy bonding curve.');
  useEffect(() => {
    trackPageView('/eth-curve');
  }, []);

  // The create success card hands the fresh token here — the creator lands on
  // their coin's permanent, shareable page, not a dead-end toast.
  const navigate = useNavigate();

  // Chain-aware: the Tegridy curve is LIVE on Ethereum, Base and Robinhood. Show the
  // launcher for the wallet's chain when it has one; otherwise default to mainnet
  // (a disconnected wallet resolves to mainnet too). A wallet already on a served
  // curve chain then reads + writes on that chain with no wrong-chain banner.
  const walletChainId = useChainId();
  const activeChainId =
    curveLauncherOn(walletChainId).status === 'deployed' ? walletChainId : CHAIN_ID;
  const availability = curveLauncherOn(activeChainId);
  const chainName = getChainConfig(activeChainId)?.name ?? 'Ethereum';

  return (
    <>
      <PageArtBackdrop pageId={PAGE_ID} />
      <div className="relative z-10 max-w-xl mx-auto px-4 py-8 space-y-4">
        <div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="heading-luxury text-2xl">Tegridy Curve</h1>
            {availability.status === 'deployed' && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[10px] font-semibold leading-none px-2 py-1 uppercase tracking-wide">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" aria-hidden="true" />
                Live on {chainName}
              </span>
            )}
          </div>
          <p className="text-white/60 text-[13px] mt-1 leading-relaxed">
            Our own bonding curve. Launch a token in one signature, trade it as it climbs, and
            graduate into a Tegridy pool with the liquidity burned — no third party takes a cut.
          </p>
        </div>

        {availability.status === 'deployed' ? (
          <m.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="space-y-4">
            <WrongChainBanner requiredChainId={activeChainId} />
            <CurveCreatePanel
              launcher={availability.address}
              chainId={activeChainId}
              onTrade={(token) => navigate(`/eth-curve/${token}?c=${activeChainId}`)}
            />
            <CurveLaunchesGrid launcher={availability.address} chainId={activeChainId} chainName={chainName} />
            <TradeByAddress launcher={availability.address} chainId={activeChainId} />
            <CurveHowItWorks />
          </m.div>
        ) : (
          <div className="space-y-4">
            <FeatureNotDeployed
              title="The Tegridy curve is coming to Ethereum."
              subtitle="The contract is audited and ready; it goes live the moment the launcher is broadcast. Here's what it does."
              pageId={PAGE_ID}
              idx={0}
            />
            <CurveHowItWorks />
          </div>
        )}
      </div>
    </>
  );
}
