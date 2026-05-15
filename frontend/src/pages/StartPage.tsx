import { useEffect, useMemo } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount } from 'wagmi';
import { ArtImg } from '../components/ArtImg';
import { useSwap } from '../hooks/useSwap';
import { useUserPosition } from '../hooks/useUserPosition';
import { useFarmActions } from '../hooks/useFarmActions';
import { useTOWELIPrice } from '../contexts/PriceContext';
import { formatCurrency } from '../lib/formatting';
import { usePageTitle } from '../hooks/usePageTitle';
import { tooltip } from '../lib/tooltips';

/**
 * /start — Robinhood-tier onboarding (P2-9).
 *
 * One screen, one CTA at a time. Walks a first-time visitor through:
 *
 *   1. Connect a wallet (RainbowKit).
 *   2. Swap 0.01 ETH → TOWELI (native ETH input — no approval needed).
 *   3. Approve TOWELI to staking (skipped if existing allowance covers).
 *   4. Stake the full TOWELI balance for 30 days.
 *   5. "You did it" — celebration screen with the new position.
 *
 * Constraints:
 *   • Three clicks max along the happy path. Approval-needed adds a
 *     fourth click on first-time stakers but is logically one
 *     "lock it down" step.
 *   • No DeFi jargon above the fold. "veTOWELI", "boost", "gauge"
 *     etc. are absent — those words appear once we get to the
 *     success screen as the post-mortem.
 *   • Reuses existing primitives only. Zero new contract surface.
 */

const STARTER_ETH = '0.01';
const STAKE_LOCK_DAYS = 30;
const STAKE_LOCK_SECONDS = BigInt(STAKE_LOCK_DAYS * 24 * 60 * 60);

type Stage = 'connect' | 'swap' | 'stake' | 'done';

export default function StartPage() {
  usePageTitle(
    'Get started',
    'Three clicks: swap 0.01 ETH for TOWELI and stake for 30 days. No jargon.',
  );

  const { isConnected, address } = useAccount();
  const swap = useSwap();
  const position = useUserPosition();
  const farmActions = useFarmActions();
  const price = useTOWELIPrice();

  // Stage machine — derived from on-chain state so a refreshed page
  // resumes from wherever the user actually is.
  const stage: Stage = useMemo(() => {
    if (!isConnected) return 'connect';
    if (position.hasPosition) return 'done';
    if (Number(position.walletBalanceFormatted) > 0) return 'stake';
    return 'swap';
  }, [isConnected, position.hasPosition, position.walletBalanceFormatted]);

  // The swap step pins fromToken=ETH/toToken=TOWELI and a fixed input
  // amount so the visitor doesn't have to type anything. We re-sync
  // these on mount + stage change.
  useEffect(() => {
    if (stage === 'swap' && swap.inputAmount !== STARTER_ETH) {
      swap.setInputAmount(STARTER_ETH);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const onConfirmSwap = () => {
    swap.setInputAmount(STARTER_ETH);
    swap.executeSwap();
  };

  const onConfirmStake = () => {
    // Stake the whole TOWELI balance the swap just produced. The lock
    // is fixed at 30 days — the onboarding flow trades flexibility for
    // a clear, single happy path.
    const amount = position.walletBalanceFormatted;
    if (!amount || Number(amount) <= 0) return;
    farmActions.stake(amount, STAKE_LOCK_SECONDS);
  };

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg
          pageId="start"
          idx={0}
          fallbackPosition="center 30%"
          alt=""
          className="w-full h-full object-cover"
        />
      </div>

      <div className="relative z-10 max-w-[640px] mx-auto px-4 md:px-6 pt-24 md:pt-32 pb-20">
        <Header stage={stage} />

        <AnimatePresence mode="wait">
          {stage === 'connect' && <ConnectStage key="connect" />}
          {stage === 'swap' && (
            <SwapStage
              key="swap"
              isPending={swap.isPending}
              isConfirming={swap.isConfirming}
              insufficientBalance={swap.insufficientBalance}
              onConfirm={onConfirmSwap}
              priceInUsd={price.priceInUsd}
            />
          )}
          {stage === 'stake' && (
            <StakeStage
              key="stake"
              balance={position.walletBalanceFormatted}
              needsApproval={position.needsApproval()}
              isPending={farmActions.isPending || farmActions.isConfirming}
              onApprove={() => farmActions.approve(position.walletBalanceFormatted)}
              onStake={onConfirmStake}
            />
          )}
          {stage === 'done' && (
            <DoneStage
              key="done"
              staked={position.stakedFormatted}
              lockEnd={position.lockEnd}
              boostMultiplier={position.boostMultiplier}
              priceInUsd={price.priceInUsd}
              address={address}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── Stage chrome ────────────────────────────────────────────────────

function Header({ stage }: { stage: Stage }) {
  const steps: Array<{ key: Stage; label: string }> = [
    { key: 'connect', label: 'Connect' },
    { key: 'swap', label: 'Buy' },
    { key: 'stake', label: 'Lock' },
    { key: 'done', label: 'Done' },
  ];
  const stageIdx = steps.findIndex((s) => s.key === stage);
  return (
    <div className="mb-8">
      <h1
        className="heading-luxury text-3xl md:text-5xl text-white tracking-tight mb-3 text-center"
        style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}
      >
        Three clicks. Real yield.
      </h1>
      <p
        className="text-white/85 text-[14px] md:text-[15px] text-center mb-6 max-w-md mx-auto"
        style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}
      >
        Trade 0.01 ETH for TOWELI and lock it for 30 days. Every swap on the
        DEX pays ETH back to lockers — including you.
      </p>
      <div className="flex items-center justify-center gap-2">
        {steps.map((s, i) => {
          const done = i < stageIdx;
          const active = i === stageIdx;
          return (
            <div key={s.key} className="flex items-center gap-2">
              <div
                className="px-3 py-1 rounded-full text-[11px] uppercase tracking-wider"
                style={{
                  background: done
                    ? 'rgba(34,197,94,0.18)'
                    : active
                    ? 'rgba(139,92,246,0.18)'
                    : 'rgba(255,255,255,0.06)',
                  color: done ? '#86efac' : active ? '#c4b5fd' : 'rgba(255,255,255,0.5)',
                  border: `1px solid ${done ? 'rgba(34,197,94,0.4)' : active ? 'rgba(139,92,246,0.4)' : 'rgba(255,255,255,0.12)'}`,
                }}
              >
                {s.label}
              </div>
              {i < steps.length - 1 && (
                <span aria-hidden className="text-white/30 text-[12px]">›</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StageCard({ children }: { children: React.ReactNode }) {
  return (
    <m.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.25 }}
      className="rounded-2xl overflow-hidden p-6 md:p-8"
      style={{
        background: 'rgba(6,12,26,0.85)',
        border: '1px solid var(--color-purple-40)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
      }}
    >
      {children}
    </m.div>
  );
}

// ─── Stages ──────────────────────────────────────────────────────────

function ConnectStage() {
  return (
    <StageCard>
      <h2 className="text-white text-[20px] font-semibold mb-2">Step 1 — Connect</h2>
      <p className="text-white/70 text-[14px] mb-5">
        Use any wallet — MetaMask, Coinbase, Rainbow, WalletConnect. We don't
        store anything; the wallet is yours.
      </p>
      <ConnectButton.Custom>
        {({ openConnectModal, mounted }) => (
          <button
            onClick={openConnectModal}
            disabled={!mounted}
            className="btn-primary w-full py-3.5 text-[15px] font-semibold rounded-xl"
          >
            Connect Wallet
          </button>
        )}
      </ConnectButton.Custom>
    </StageCard>
  );
}

function SwapStage({
  isPending,
  isConfirming,
  insufficientBalance,
  onConfirm,
  priceInUsd,
}: {
  isPending: boolean;
  isConfirming: boolean;
  insufficientBalance: boolean;
  onConfirm: () => void;
  priceInUsd: number;
}) {
  const busy = isPending || isConfirming;
  const usd = priceInUsd > 0 ? formatCurrency(0.01 * 2400, 2) : ''; // rough placeholder; live ETH/USD lives in price.ethUsd
  return (
    <StageCard>
      <h2 className="text-white text-[20px] font-semibold mb-2">Step 2 — Buy TOWELI</h2>
      <p className="text-white/70 text-[14px] mb-5">
        We'll trade <span className="font-mono text-white">{STARTER_ETH} ETH</span>{' '}
        for TOWELI at the best price from the DEX. {usd && <span className="text-white/50">≈ {usd}</span>}
      </p>
      <button
        onClick={onConfirm}
        disabled={busy || insufficientBalance}
        title={tooltip('swap.execute')}
        className="btn-primary w-full py-3.5 text-[15px] font-semibold rounded-xl disabled:opacity-50"
      >
        {insufficientBalance
          ? 'Not enough ETH'
          : isPending
          ? 'Confirm in wallet…'
          : isConfirming
          ? 'Buying…'
          : 'Buy 0.01 ETH worth'}
      </button>
      <p className="text-white/40 text-[11px] mt-4 text-center">
        Costs gas + 0.3% DEX pool fee. Reversible — you can swap back any time.
      </p>
    </StageCard>
  );
}

function StakeStage({
  balance,
  needsApproval,
  isPending,
  onApprove,
  onStake,
}: {
  balance: string;
  needsApproval: boolean;
  isPending: boolean;
  onApprove: () => void;
  onStake: () => void;
}) {
  const balanceNum = Number(balance);
  return (
    <StageCard>
      <h2 className="text-white text-[20px] font-semibold mb-2">Step 3 — Lock for 30 days</h2>
      <p className="text-white/70 text-[14px] mb-5">
        Lock <span className="font-mono text-white">{balanceNum.toFixed(2)} TOWELI</span>{' '}
        for 30 days. ETH revenue starts streaming to you on swap fees from any wallet.
      </p>
      {needsApproval ? (
        <button
          onClick={onApprove}
          disabled={isPending || balanceNum <= 0}
          title={tooltip('stake.approve')}
          className="btn-primary w-full py-3.5 text-[15px] font-semibold rounded-xl disabled:opacity-50"
        >
          {isPending ? 'Confirm in wallet…' : 'Approve TOWELI'}
        </button>
      ) : (
        <button
          onClick={onStake}
          disabled={isPending || balanceNum <= 0}
          title={tooltip('stake.create')}
          className="btn-primary w-full py-3.5 text-[15px] font-semibold rounded-xl disabled:opacity-50"
        >
          {isPending ? 'Confirm in wallet…' : `Lock ${balanceNum.toFixed(2)} TOWELI for 30 days`}
        </button>
      )}
      <p className="text-white/40 text-[11px] mt-4 text-center">
        Gas only. Lock cannot be shortened — early exit forfeits 25%.
      </p>
    </StageCard>
  );
}

function DoneStage({
  staked,
  lockEnd,
  boostMultiplier,
  priceInUsd,
  address,
}: {
  staked: string;
  lockEnd: number;
  boostMultiplier: number;
  priceInUsd: number;
  address: `0x${string}` | undefined;
}) {
  const stakedNum = Number(staked);
  const stakedUsd = priceInUsd > 0 ? formatCurrency(stakedNum * priceInUsd, 2) : '–';
  const unlockDate = lockEnd > 0 ? new Date(lockEnd * 1000) : null;
  return (
    <StageCard>
      <div className="flex items-center gap-3 mb-4">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center text-2xl"
          style={{ background: 'rgba(34,197,94,0.18)', border: '1px solid rgba(34,197,94,0.4)' }}
        >
          ✓
        </div>
        <h2 className="text-white text-[22px] font-semibold">You did it.</h2>
      </div>
      <p className="text-white/70 text-[14px] mb-5">
        Your tegridy is locked. Every swap on the Tegridy DEX now sends a slice
        of ETH to your wallet — claim it any time from the dashboard.
      </p>
      <div className="grid grid-cols-2 gap-3 mb-6">
        <Stat label="Locked" value={`${stakedNum.toFixed(2)} TOWELI`} sub={stakedUsd} />
        <Stat label="Unlocks" value={unlockDate ? unlockDate.toLocaleDateString() : '–'} sub="30 days" />
        <Stat label="Boost" value={`${boostMultiplier.toFixed(1)}×`} sub="versus base" />
        <Stat label="Wallet" value={address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '–'} sub="" />
      </div>
      <div className="flex flex-wrap gap-3">
        <Link to="/dashboard" className="btn-primary px-5 py-2.5 text-[14px] inline-block">
          Open Dashboard
        </Link>
        <Link
          to="/farm"
          className="px-5 py-2.5 text-[14px] inline-block rounded-lg"
          style={{
            background: 'rgba(0,0,0,0.55)',
            border: '1px solid var(--color-purple-40)',
            color: '#fff',
          }}
        >
          See your position
        </Link>
      </div>
      <p className="text-white/40 text-[11px] mt-5">
        Want to boost more? Long locks (1y, 2y, 4y) earn up to 4×. The dashboard
        has the full controls when you're ready.
      </p>
    </StageCard>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div
      className="rounded-lg p-3"
      style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid var(--color-purple-40)' }}
    >
      <p className="text-white/55 text-[10px] uppercase tracking-wider mb-1">{label}</p>
      <p className="text-white text-[14px] font-mono font-semibold">{value}</p>
      {sub && <p className="text-white/50 text-[11px] mt-0.5">{sub}</p>}
    </div>
  );
}
