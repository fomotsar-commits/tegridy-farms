import { motion } from 'framer-motion';
import { useAccount, useBalance, useReadContract } from 'wagmi';
import { formatEther } from 'viem';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { Link } from 'react-router-dom';
import { ERC20_ABI } from '../lib/contracts';
import { TOWELI_ADDRESS, TOWELI_WETH_LP_ADDRESS } from '../lib/constants';
import { useUserPosition } from '../hooks/useUserPosition';
import { usePoolData } from '../hooks/usePoolData';
import { useToweliPrice } from '../hooks/useToweliPrice';
import { ART } from '../lib/artConfig';
import { formatTokenAmount, formatCurrency } from '../lib/formatting';

export default function DashboardPage() {
  const { isConnected, address } = useAccount();
  const { data: ethBalance } = useBalance({ address });
  const price = useToweliPrice();

  const { data: toweliBalance } = useReadContract({
    address: TOWELI_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address!],
    query: { enabled: !!address },
  });

  const lpPos = useUserPosition(0n, TOWELI_WETH_LP_ADDRESS);
  const tokPos = useUserPosition(1n, TOWELI_ADDRESS);
  const lpPool = usePoolData(0n);
  const tokPool = usePoolData(1n);

  const walletToweli = toweliBalance ? Number(formatEther(toweliBalance)) : 0;
  const pendingTotal = Number(lpPos.pendingFormatted) + Number(tokPos.pendingFormatted);
  const stakedLP = Number(lpPos.stakedFormatted);
  const stakedTok = Number(tokPos.stakedFormatted);

  if (!isConnected) {
    return (
      <div className="-mt-14 relative min-h-screen">
        <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
          <img src={ART.busCrew.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 5%' }} />
          <div className="absolute inset-0" style={{
            background: 'radial-gradient(ellipse at center, rgba(0,0,0,0.15) 0%, rgba(0,0,0,0.1) 60%, rgba(0,0,0,0.25) 100%)',
          }} />
        </div>
        <div className="relative z-10 min-h-screen flex items-center justify-center px-6">
          <motion.div className="text-center max-w-sm" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }}>
            <h2 className="heading-luxury text-2xl text-white mb-2">Connect Wallet</h2>
            <p className="text-white/40 text-[13px] mb-6">View your portfolio, positions, and earnings.</p>
            <ConnectButton.Custom>
              {({ openConnectModal, mounted }) => (
                <div {...(!mounted && { style: { opacity: 0, pointerEvents: 'none' } })}>
                  <button onClick={openConnectModal} className="btn-primary px-7 py-2.5 text-[14px]">
                    Connect Wallet
                  </button>
                </div>
              )}
            </ConnectButton.Custom>
          </motion.div>
        </div>
      </div>
    );
  }

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.towelieWindow.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 30%' }} />
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.05) 0%, rgba(0,0,0,0.15) 30%, rgba(0,0,0,0.3) 60%, rgba(0,0,0,0.55) 100%)',
        }} />
      </div>

      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6 pt-20 pb-12">
        <motion.div className="mb-8" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-3xl md:text-4xl text-white tracking-tight mb-1">Dashboard</h1>
          <p className="text-white/50 text-[14px]">Your portfolio overview</p>
        </motion.div>

        {/* Summary */}
        <motion.div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-10" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          {[
            { l: 'TOWELI Balance', v: formatTokenAmount(walletToweli.toString(), 0), sub: formatCurrency(walletToweli * price.priceInUsd) },
            { l: 'ETH Balance', v: ethBalance ? Number(ethBalance.formatted).toFixed(4) : '0', sub: ethBalance ? formatCurrency(Number(ethBalance.formatted) * price.ethUsd) : '$0' },
            { l: 'Claimable', v: formatTokenAmount(pendingTotal.toString(), 2), sub: formatCurrency(pendingTotal * price.priceInUsd), accent: true },
            { l: 'TOWELI Price', v: formatCurrency(price.priceInUsd, 6), sub: 'Live' },
          ].map((s) => (
            <div key={s.l} className="rounded-xl p-4" style={{ background: 'rgba(6,12,26,0.82)', backdropFilter: 'blur(12px)', border: '1px solid rgba(139,92,246,0.12)' }}>
              <p className="text-white/40 text-[11px] uppercase tracking-wider mb-1">{s.l}</p>
              <p className={`stat-value text-lg ${s.accent ? 'text-primary' : 'text-white'}`}>{s.v}</p>
              <p className="text-white/30 text-[11px] mt-0.5">{s.sub}</p>
            </div>
          ))}
        </motion.div>

        {/* Positions */}
        <h2 className="heading-luxury text-[16px] text-white mb-4">Positions</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-10">
          <PosCard name="TOWELI/ETH LP" apr={lpPool.isDeployed ? lpPool.apr : '–'}
            staked={stakedLP} earned={Number(lpPos.pendingFormatted)} art={ART.poolParty.src}
            isDeployed={lpPool.isDeployed} />
          <PosCard name="TOWELI Staking" apr={tokPool.isDeployed ? tokPool.apr : '–'}
            staked={stakedTok} earned={Number(tokPos.pendingFormatted)} art={ART.boxingRing.src}
            isDeployed={tokPool.isDeployed} />
        </div>

        {/* Projections */}
        {(stakedLP > 0 || stakedTok > 0) && (
          <motion.div className="mb-10" initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
            <h3 className="heading-luxury text-[16px] text-white mb-4">Earnings Projection</h3>
            <Projections stakedLP={stakedLP} stakedTok={stakedTok}
              lpApr={parseFloat(lpPool.isDeployed ? lpPool.apr : '0')}
              tokApr={parseFloat(tokPool.isDeployed ? tokPool.apr : '0')}
              price={price.priceInUsd} />
          </motion.div>
        )}

        {/* Chart */}
        <motion.div initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
          <div className="flex items-center justify-between mb-3">
            <h3 className="heading-luxury text-[16px] text-white">Price Chart</h3>
            <a href={`https://dexscreener.com/ethereum/${TOWELI_ADDRESS}`} target="_blank" rel="noopener noreferrer"
              className="text-primary text-[12px] font-medium hover:opacity-80 transition-opacity">
              DexScreener →
            </a>
          </div>
          <div className="relative rounded-xl overflow-hidden" style={{ height: '220px', border: '1px solid rgba(139,92,246,0.12)' }}>
            <iframe
              src={`https://dexscreener.com/ethereum/${TOWELI_ADDRESS}?embed=1&theme=dark&trades=0&info=0`}
              className="w-full h-full border-0"
              title="DexScreener Chart"
              allow="clipboard-write"
              loading="lazy"
            />
          </div>
        </motion.div>
      </div>
    </div>
  );
}

function PosCard({ name, apr, staked, earned, art, isDeployed }: {
  name: string; apr: string; staked: number; earned: number; art: string; isDeployed: boolean;
}) {
  const hasPosition = staked > 0;
  return (
    <motion.div className="relative rounded-xl overflow-hidden" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <div className="absolute inset-0">
        <img src={art} alt="" className="w-full h-full object-cover" />
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(to bottom, rgba(6,12,26,0.35) 0%, rgba(6,12,26,0.8) 45%, rgba(6,12,26,0.95) 100%)',
        }} />
      </div>
      <div className="relative z-10 p-5">
        <div className="flex items-center justify-between mb-16">
          <h4 className="heading-luxury text-[17px] text-white">{name}</h4>
          <span className="badge badge-primary text-[10px]">{apr === '–' ? '– APR' : `${apr}% APR`}</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg p-3" style={{ background: 'rgba(6,12,26,0.6)', border: '1px solid rgba(139,92,246,0.08)' }}>
            <p className="text-white/30 text-[10px] mb-0.5">Staked</p>
            <p className="stat-value text-[14px] text-white">{formatTokenAmount(staked.toString(), 2)}</p>
          </div>
          <div className="rounded-lg p-3" style={{ background: 'rgba(6,12,26,0.6)', border: '1px solid rgba(139,92,246,0.08)' }}>
            <p className="text-white/30 text-[10px] mb-0.5">Earned</p>
            <p className="stat-value text-[14px] text-primary">{formatTokenAmount(earned.toString(), 4)}</p>
          </div>
        </div>
        {!isDeployed ? (
          <p className="mt-3 text-center text-white/25 text-[11px]">Farm not yet deployed</p>
        ) : !hasPosition ? (
          <Link to="/farm" className="block mt-3 text-center text-white/30 text-[11px] hover:text-primary transition-colors">
            No position &middot; Start farming &#8594;
          </Link>
        ) : null}
      </div>
    </motion.div>
  );
}

function Projections({ stakedLP, stakedTok, lpApr, tokApr, price }: {
  stakedLP: number; stakedTok: number; lpApr: number; tokApr: number; price: number;
}) {
  const daily = (stakedLP * lpApr / 100 + stakedTok * tokApr / 100) / 365;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {[{ l: '7 Days', m: 7 }, { l: '30 Days', m: 30 }, { l: '90 Days', m: 90 }, { l: '1 Year', m: 365 }].map(({ l, m }) => (
        <div key={l} className="rounded-lg p-3 text-center" style={{ background: 'rgba(6,12,26,0.82)', border: '1px solid rgba(139,92,246,0.12)', backdropFilter: 'blur(8px)' }}>
          <p className="text-white/40 text-[10px] mb-1">{l}</p>
          <p className="stat-value text-[14px] text-primary">{formatTokenAmount((daily * m).toString(), 0)}</p>
          <p className="text-white/25 text-[9px]">~{formatCurrency(daily * m * price)}</p>
        </div>
      ))}
    </div>
  );
}
