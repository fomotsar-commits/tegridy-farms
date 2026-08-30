import { useMemo } from 'react';
import { formatEther } from 'viem';

/**
 * The EVM bonding curve, drawn from the launch's own on-chain state — pure
 * geometry, zero fabricated data.
 *
 * The curve is constant-product over a virtual reserve: at any point,
 * spot = (V + E) / T and (V + E) · T = k stays constant while the curve is
 * open (fees are carved out of msg.value BEFORE the swap leg, so the
 * invariant holds — same math as lib/launcher/curve.ts previewBuy/Sell).
 * With the CURRENT (V, E, T) read from getLaunch, k = (V + E) · T, and the
 * whole price path is price(E') = (V + E')² / k for E' in [0, graduationEth]
 * — including where the launch IS right now, which is the marker.
 *
 * No candles, no history, no volume: those need an indexer this deployment
 * does not run, and the surface never pretends otherwise. What it shows is
 * exactly what the contract guarantees: where the price sits on the curve
 * and how far graduation is.
 */
export function EvmCurveChart({
  virtualEth,
  ethReserve,
  tokenReserve,
  graduationEth,
}: {
  virtualEth: bigint;
  ethReserve: bigint;
  tokenReserve: bigint;
  graduationEth: bigint;
}) {
  const geometry = useMemo(() => {
    if (virtualEth <= 0n || tokenReserve <= 0n || graduationEth <= 0n) return null;
    const k = (virtualEth + ethReserve) * tokenReserve; // invariant, 1e36-scaled
    const W = 320;
    const H = 120;
    const PAD = 8;
    const N = 48;
    // price(E') in wei-per-token (1e18-scaled), as Number for pixel math only.
    const priceAt = (ePrimeWei: bigint): number => {
      const vPlusE = virtualEth + ePrimeWei;
      return Number((vPlusE * vPlusE * 10n ** 18n) / k) ;
    };
    const maxPrice = priceAt(graduationEth);
    const minPrice = priceAt(0n);
    if (!(maxPrice > 0) || !Number.isFinite(maxPrice)) return null;
    const span = Math.max(maxPrice - minPrice, maxPrice * 1e-9);
    const x = (eWei: bigint) => PAD + (Number(eWei) / Number(graduationEth)) * (W - 2 * PAD);
    const y = (p: number) => H - PAD - ((p - minPrice) / span) * (H - 2 * PAD);
    const pts: string[] = [];
    for (let i = 0; i <= N; i++) {
      const e = (graduationEth * BigInt(i)) / BigInt(N);
      pts.push(`${x(e).toFixed(1)},${y(priceAt(e)).toFixed(1)}`);
    }
    const clampedE = ethReserve > graduationEth ? graduationEth : ethReserve;
    const marker = { cx: x(clampedE), cy: y(priceAt(clampedE)) };
    // Filled area under the traveled part of the curve.
    const traveled: string[] = [];
    for (let i = 0; i <= N; i++) {
      const e = (clampedE * BigInt(i)) / BigInt(N);
      traveled.push(`${x(e).toFixed(1)},${y(priceAt(e)).toFixed(1)}`);
    }
    return { W, H, PAD, pts, marker, traveled };
  }, [virtualEth, ethReserve, tokenReserve, graduationEth]);

  if (!geometry) return null;
  const { W, H, PAD, pts, marker, traveled } = geometry;

  return (
    <div className="rounded-2xl p-4" style={{ border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(6,12,26,0.6)' }}>
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <p className="text-white/45 text-[11px]">The curve — price vs ETH raised</p>
        <p className="text-white/35 text-[10px]">
          drawn from on-chain state · no indexer, no history — geometry only
        </p>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label={`Bonding curve price path from launch to graduation at ${formatEther(graduationEth)} ETH raised; the marker shows the current position.`}
      >
        {/* full path to graduation */}
        <polyline points={pts.join(' ')} fill="none" stroke="rgba(125,211,252,0.35)" strokeWidth="1.5" strokeDasharray="3 3" />
        {/* traveled segment */}
        <polyline points={traveled.join(' ')} fill="none" stroke="#7dd3fc" strokeWidth="2" />
        {/* current position */}
        <circle cx={marker.cx} cy={marker.cy} r="3.5" fill="#34d399" stroke="rgba(6,12,26,0.9)" strokeWidth="1.5" />
        {/* graduation line */}
        <line x1={W - PAD} y1={PAD} x2={W - PAD} y2={H - PAD} stroke="rgba(52,211,153,0.35)" strokeWidth="1" strokeDasharray="2 3" />
      </svg>
      <div className="flex items-center justify-between mt-1">
        <p className="text-white/35 text-[10px]">launch</p>
        <p className="text-emerald-300/70 text-[10px]">graduation · {formatEther(graduationEth)} ETH</p>
      </div>
    </div>
  );
}
