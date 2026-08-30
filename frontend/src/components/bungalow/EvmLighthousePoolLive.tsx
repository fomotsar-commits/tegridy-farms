import { useEffect, useMemo, useState } from 'react';
import { useAccount, useChainId, useReadContracts, useSwitchChain, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseUnits } from 'viem';
import { toast } from 'sonner';
import type { Bungalow } from '../../lib/bungalows';
import { LIGHTHOUSE_STAKING_ABI, ERC20_ABI } from '../../lib/contracts';
import { deriveEvmLighthouse, fmtRaw, fmtRunway } from '../../lib/evmLighthouse';
import { surfaceTxError } from '../../lib/txErrors';
import { getTxUrl, getAddressUrl } from '../../lib/explorer';
import { CopyButton } from '../ui/CopyButton';
import { shortenAddress } from '../../lib/formatting';

/**
 * The EVM lighthouse — live staking card for a bungalow whose pool is the
 * VENDORED Synthetix StakingRewards (contracts/src/vendor/, provenance D8).
 *
 * Same honesty contract as the Solana card, re-derived for this program
 * (the math lives in lib/evmLighthouse.ts so it is unit-pinned):
 *  - the VAULT headline is balance − principal (same-token law), never the
 *    raw pool balance;
 *  - paying-now vs configured are shown separately and never conflated;
 *    paying-now is a real labeled 0 the second the period ends;
 *  - a failed read is an OUTAGE card, never a rendered zero;
 *  - NO LOCKS: stake and withdraw are free at any time and withdraw moves
 *    principal only — an empty vault can never hold an exit hostage. (The
 *    Solana lighthouse HAS locks and its 6012 class; do not copy that copy
 *    here, and say the difference out loud.)
 *  - staking while unfunded is allowed (it is safe — exits are free) but the
 *    card says plainly that it earns nothing until funding lands.
 */

const CHAIN_IDS: Record<string, number> = { ethereum: 1, base: 8453 };
const CHAIN_LABEL: Record<number, string> = { 1: 'Ethereum', 8453: 'Base' };
// Static-shape read batch (wagmi types collapse on conditional spreads): user
// reads always run, against a placeholder when disconnected — same pattern as
// useAddLiquidity. Placeholder results are simply never shown.
const PLACEHOLDER_ADDR = '0x0000000000000000000000000000000000000001' as const;

export function EvmLighthousePoolLive({ bungalow }: { bungalow: Bungalow & { stakePool: string } }) {
  const pool = bungalow.stakePool as `0x${string}`;
  const token = (bungalow.address ?? '') as `0x${string}`;
  const poolChainId = CHAIN_IDS[bungalow.chain] ?? 1;
  const accent = bungalow.accent ?? 'var(--color-kyle)';

  const { address: user, isConnected } = useAccount();
  const walletChainId = useChainId();
  const { switchChain } = useSwitchChain();
  const onPoolChain = walletChainId === poolChainId;

  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState<null | 'approve' | 'stake' | 'withdraw' | 'claim' | 'exit'>(null);
  // Wall-clock for period/runway math, ticked outside render (hooks purity).
  const [nowSecs, setNowSecs] = useState<bigint>(0n);
  useEffect(() => {
    const tick = () => setNowSecs(BigInt(Math.floor(Date.now() / 1000)));
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, []);
  const userAddr = user ?? PLACEHOLDER_ADDR;

  // One pinned batch — reads always target the POOL's chain (F201 pattern),
  // so a wrong-network wallet still sees true figures instead of empty reverts.
  const poolC = { address: pool, abi: LIGHTHOUSE_STAKING_ABI, chainId: poolChainId } as const;
  const tokenC = { address: token, abi: ERC20_ABI, chainId: poolChainId } as const;
  const { data: reads, isLoading, refetch } = useReadContracts({
    contracts: [
      { ...poolC, functionName: 'totalSupply' },
      { ...tokenC, functionName: 'balanceOf', args: [pool] },
      { ...poolC, functionName: 'rewardRate' },
      { ...poolC, functionName: 'periodFinish' },
      { ...poolC, functionName: 'rewardsDuration' },
      { ...tokenC, functionName: 'decimals' },
      { ...poolC, functionName: 'balanceOf', args: [userAddr] },
      { ...poolC, functionName: 'earned', args: [userAddr] },
      { ...tokenC, functionName: 'balanceOf', args: [userAddr] },
      { ...tokenC, functionName: 'allowance', args: [userAddr, pool] },
    ],
    query: { refetchInterval: 30_000 },
  });

  const big = (i: number): bigint | null => {
    const r = reads?.[i];
    return r && r.status === 'success' ? (r.result as bigint) : null;
  };
  const decimals = (() => {
    const r = reads?.[5];
    return r && r.status === 'success' ? Number(r.result) : bungalow.decimals ?? 18;
  })();

  const view = useMemo(
    () =>
      deriveEvmLighthouse(
        {
          totalStakedRaw: big(0),
          poolTokenBalanceRaw: big(1),
          rewardRateRaw: big(2),
          periodFinishSecs: big(3),
          rewardsDurationSecs: big(4),
          userStakedRaw: user ? big(6) : null,
          userEarnedRaw: user ? big(7) : null,
        },
        nowSecs,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reads, user, nowSecs],
  );
  const userStakedRaw = user ? big(6) : null;
  const userEarnedRaw = user ? big(7) : null;
  const userTokenRaw = user ? big(8) : null;
  const allowanceRaw = user ? big(9) : null;

  const { writeContractAsync } = useWriteContract();
  const [lastHash, setLastHash] = useState<`0x${string}` | undefined>(undefined);
  const { data: receipt } = useWaitForTransactionReceipt({ hash: lastHash, chainId: poolChainId });
  // wagmi's isSuccess only means FETCHED; only receipt.status is the truth
  // (receipt-status audit, 2026-08-24).
  const lastConfirmed = receipt?.status === 'success';

  const amountRaw = (() => {
    try {
      return amount.trim() ? parseUnits(amount.trim(), decimals) : 0n;
    } catch {
      return null; // unparseable input — buttons disable, no throw at render
    }
  })();
  const needsApproval =
    amountRaw !== null && amountRaw > 0n && allowanceRaw !== null && allowanceRaw < amountRaw;

  async function send(kind: 'approve' | 'stake' | 'withdraw' | 'claim' | 'exit') {
    if (!user) return;
    setBusy(kind);
    try {
      let hash: `0x${string}`;
      if (kind === 'approve') {
        hash = await writeContractAsync({ ...tokenC, functionName: 'approve', args: [pool, amountRaw ?? 0n] });
      } else if (kind === 'stake') {
        hash = await writeContractAsync({ ...poolC, functionName: 'stake', args: [amountRaw ?? 0n] });
      } else if (kind === 'withdraw') {
        hash = await writeContractAsync({ ...poolC, functionName: 'withdraw', args: [amountRaw ?? 0n] });
      } else if (kind === 'claim') {
        hash = await writeContractAsync({ ...poolC, functionName: 'getReward' });
      } else {
        hash = await writeContractAsync({ ...poolC, functionName: 'exit' });
      }
      setLastHash(hash);
      toast.success(
        <span>
          {kind === 'approve' ? 'Approval submitted — stake once it confirms.' : 'Submitted.'}{' '}
          <a href={getTxUrl(poolChainId, hash)} target="_blank" rel="noopener noreferrer" className="underline">tx ↗</a>
        </span>,
      );
      setTimeout(() => { void refetch(); }, 4_000);
    } catch (e) {
      surfaceTxError(e, toast);
    } finally {
      setBusy(null);
    }
  }

  const unfunded = view.vaultRaw !== null && view.vaultRaw === 0n;
  const notPaying = view.payingNowRawPerSec !== null && view.payingNowRawPerSec === 0n;

  return (
    <div className="relative overflow-hidden rounded-2xl glass-card-animated" style={{ border: '1px solid var(--color-purple-75)' }}>
      <div className="absolute inset-0" style={{ background: 'rgba(4,9,18,0.85)' }} />
      <div className="relative z-10 p-6">
        <p className="text-[10px] uppercase tracking-wider mb-2" style={{ color: accent }}>
          The lighthouse · {CHAIN_LABEL[poolChainId]}
        </p>
        <h2 className="heading-luxury text-xl text-white mb-1">Stake {bungalow.symbol}</h2>
        <div className="flex items-center gap-2 mb-4">
          <CopyButton text={pool} display={shortenAddress(pool, 6)} className="font-mono text-[11px]" style={{ color: 'var(--color-kyle)' }} />
          <a href={getAddressUrl(poolChainId, pool)} target="_blank" rel="noopener noreferrer" aria-label="View pool on block explorer (opens in new tab)" className="text-[11px] underline underline-offset-2 text-white/60 hover:text-white">
            explorer ↗
          </a>
        </div>

        {!view.coreKnown && !isLoading ? (
          // OUTAGE, not zeros: some core read failed.
          <p className="text-[13px] mb-4" style={{ color: '#f0b26b' }}>
            The pool could not be read just now — figures are withheld rather than shown
            as zeros. Refresh, or check the explorer link above.
          </p>
        ) : (
          <>
            {/* The vault headline — balance MINUS principal, per the same-token law. */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <Stat label="Reward vault (funded)" value={`${fmtRaw(view.vaultRaw, decimals)} ${bungalow.symbol}`} title="token.balanceOf(pool) minus staked principal — the raw balance would count stakers' own tokens as funding." />
              <Stat label="Total staked" value={`${fmtRaw(big(0), decimals)} ${bungalow.symbol}`} />
              <Stat
                label="Paying now"
                value={
                  view.payingNowRawPerSec === null
                    ? '—'
                    : `${fmtRaw(view.payingNowRawPerSec * 86_400n, decimals)} ${bungalow.symbol}/day`
                }
                title="Pool-wide rate this second. Zero after the reward period ends — a real zero, not a display bug."
              />
              <Stat
                label="Runway"
                value={fmtRunway(view.runwaySecs)}
                title="periodFinish minus now — exact and on-chain, not an estimate."
              />
            </div>

            {unfunded && (
              <p className="text-[12px] mb-4 rounded-lg p-3" style={{ background: 'rgba(240,178,107,0.08)', border: '1px solid rgba(240,178,107,0.35)', color: '#f0b26b' }}>
                The reward vault is unfunded — staking works but earns nothing until funding
                lands. Unlike the Solana lighthouse, your principal is NEVER at the vault&apos;s
                mercy here: withdraw is free at any time and moves principal only.
              </p>
            )}
            {!unfunded && notPaying && (
              <p className="text-[12px] mb-4 text-white/70">
                The last reward period has ended — the pool is paying 0 until the next
                funding. Configured rate from the last notify:{' '}
                {view.configuredRawPerSec === null ? '—' : `${fmtRaw(view.configuredRawPerSec * 86_400n, decimals)} ${bungalow.symbol}/day`}.
              </p>
            )}

            <p className="text-[11px] text-white/55 mb-4">
              No locks on this pool: stake and withdraw are free at any time. Rewards
              accrue per second while a funded period runs, and claiming is separate
              from withdrawing.
            </p>

            {isConnected && user ? (
              !onPoolChain ? (
                <button
                  type="button"
                  onClick={() => switchChain({ chainId: poolChainId })}
                  className="btn-primary px-6 py-2.5 text-[13px]"
                >
                  Switch wallet to {CHAIN_LABEL[poolChainId]}
                </button>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <Stat label="Your stake" value={`${fmtRaw(userStakedRaw, decimals)} ${bungalow.symbol}`} />
                    <Stat label="Claimable" value={`${fmtRaw(userEarnedRaw, decimals)} ${bungalow.symbol}`} />
                  </div>
                  <div className="flex items-center gap-2 mb-3">
                    <input
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      inputMode="decimal"
                      placeholder={`Amount (${bungalow.symbol})`}
                      aria-label={`Amount of ${bungalow.symbol}`}
                      className="flex-1 min-w-0 rounded-lg px-3 py-2 text-[13px] bg-black/50 border border-white/15 text-white placeholder-white/35"
                    />
                    <button
                      type="button"
                      className="text-[11px] text-white/60 hover:text-white underline underline-offset-2"
                      onClick={() => userTokenRaw !== null && setAmount(fmtRaw(userTokenRaw, decimals, 6).replace(/,/g, ''))}
                    >
                      max
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {needsApproval ? (
                      <button type="button" disabled={busy !== null || !amountRaw} onClick={() => send('approve')} className="btn-primary px-5 py-2 text-[13px] disabled:opacity-50">
                        {busy === 'approve' ? 'Approving…' : `Approve ${bungalow.symbol}`}
                      </button>
                    ) : (
                      <button type="button" disabled={busy !== null || !amountRaw || amountRaw === 0n} onClick={() => send('stake')} className="btn-primary px-5 py-2 text-[13px] disabled:opacity-50">
                        {busy === 'stake' ? 'Staking…' : 'Stake'}
                      </button>
                    )}
                    <button type="button" disabled={busy !== null || !amountRaw || amountRaw === 0n || userStakedRaw === null || userStakedRaw === 0n} onClick={() => send('withdraw')} className="btn-secondary px-5 py-2 text-[13px] disabled:opacity-50">
                      {busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw'}
                    </button>
                    <button type="button" disabled={busy !== null || userEarnedRaw === null || userEarnedRaw === 0n} onClick={() => send('claim')} className="btn-secondary px-5 py-2 text-[13px] disabled:opacity-50">
                      {busy === 'claim' ? 'Claiming…' : 'Claim rewards'}
                    </button>
                    <button type="button" disabled={busy !== null || userStakedRaw === null || userStakedRaw === 0n} onClick={() => send('exit')} className="btn-secondary px-5 py-2 text-[13px] disabled:opacity-50" title="Withdraw everything and claim in one transaction.">
                      {busy === 'exit' ? 'Exiting…' : 'Exit (withdraw + claim)'}
                    </button>
                  </div>
                  {lastHash && (
                    <p className="text-[11px] text-white/55 mt-3">
                      Last tx:{' '}
                      <a href={getTxUrl(poolChainId, lastHash)} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                        {shortenAddress(lastHash, 6)} ↗
                      </a>{' '}
                      {lastConfirmed ? '· confirmed' : receipt ? '· REVERTED on-chain' : '· pending'}
                    </p>
                  )}
                </>
              )
            ) : (
              <p className="text-[12px] text-white/60">
                Connect a wallet to stake. Reading the pool needs no wallet — the figures
                above are live either way.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rounded-xl px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }} title={title}>
      <p className="text-[10px] uppercase tracking-wider text-white/50 mb-1">{label}</p>
      <p className="text-white text-[14px] tabular-nums">{value}</p>
    </div>
  );
}
