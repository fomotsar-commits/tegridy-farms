import { useState } from 'react';
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatEther, parseEther, type Address } from 'viem';
import { VOTE_INCENTIVES_ADDRESS, TEGRIDY_LP_ADDRESS } from '../../lib/constants';
import { VOTE_INCENTIVES_ABI } from '../../lib/contracts';
import { shortenAddress, formatTokenAmount, formatWei } from '../../lib/formatting';
import { InfoTooltip } from '../ui/InfoTooltip';
import { GOVERNANCE_COPY } from '../../lib/copy';
import { useBribes } from '../../hooks/useBribes';

const CARD_BG = 'rgba(13, 21, 48, 0.6)';
const CARD_BORDER = 'var(--color-purple-12)';

export function VoteIncentivesSection() {
  const { address } = useAccount();
  const [bribeAmount, setBribeAmount] = useState('');

  // Consolidated hook for pair-agnostic state + write actions (session 11 rewire).
  // We still reach directly for pair-specific reads/writes below because
  // `useBribes` hardcodes TOWELI_WETH_LP_ADDRESS (the Uniswap V2 pair) for
  // its `claimable` query, whereas this section shows incentives on the
  // native TegridyPair (TEGRIDY_LP_ADDRESS). Surfaces the wrong pair's
  // claimables if we blindly swap them — and the two constants resolve to
  // different contracts.
  const bribes = useBribes();
  const viAddr = VOTE_INCENTIVES_ADDRESS as Address;

  // Pair-specific reads stay inline.
  const { data: pendingETH } = useReadContract({
    address: viAddr, abi: VOTE_INCENTIVES_ABI, functionName: 'pendingETHWithdrawals', args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  // Claimable bribes for the current epoch on the native LP pair.
  const currentEpoch = bribes.currentEpoch;
  const { data: claimableData } = useReadContract({
    address: viAddr, abi: VOTE_INCENTIVES_ABI, functionName: 'claimable',
    args: address && currentEpoch > 0 ? [address, BigInt(currentEpoch - 1), TEGRIDY_LP_ADDRESS as Address] : undefined,
    query: { enabled: !!address && currentEpoch > 0 },
  });

  // Pair-specific writes (withdraw pending ETH) stay on a local useWriteContract
  // so they don't interfere with the bribes-hook's own tx lifecycle.
  const { writeContract: writeLocal, data: withdrawTxHash, isPending: isLocalSigning } = useWriteContract();
  const { isLoading: isLocalConfirming } = useWaitForTransactionReceipt({ hash: withdrawTxHash });

  // Convenience flags — buttons disable on EITHER hook's busy state.
  const isBusy = bribes.isPending || bribes.isConfirming || isLocalSigning || isLocalConfirming;

  const epoch = currentEpoch;
  const fee = bribes.bribeFeeBps;
  const epochCount = bribes.epochCount;
  const pendingBig = (pendingETH as bigint) ?? 0n;
  const claimable = claimableData as [Address[], bigint[]] | undefined;
  const hasClaimable = claimable && claimable[1]?.some((a: bigint) => a > 0n);

  const handleDepositETH = () => {
    if (!bribeAmount) return;
    bribes.depositBribeETH(TEGRIDY_LP_ADDRESS as Address, parseEther(bribeAmount));
  };

  const handleClaimBribes = () => {
    if (!address || epoch < 1) return;
    bribes.claimBribes(epoch - 1, TEGRIDY_LP_ADDRESS as Address);
  };

  const handleWithdrawPending = () => {
    writeLocal({
      address: viAddr, abi: VOTE_INCENTIVES_ABI, functionName: 'withdrawPendingETH',
    });
  };

  const handleAdvanceEpoch = () => {
    bribes.advanceEpoch();
  };

  return (
    <div className="space-y-4">
      {/* Stats Row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {[
          { label: 'Current Epoch', value: epoch > 0 ? `#${epoch}` : '--' },
          { label: 'Total Epochs', value: epochCount > 0 ? epochCount.toString() : '--' },
          { label: 'Bribe Fee', value: fee > 0 ? `${fee / 100}%` : '--' },
        ].map(({ label, value }) => (
          <div key={label} className="rounded-xl p-4" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
            <p className="text-[11px] text-white/40 uppercase tracking-wider mb-1">{label}</p>
            <p className="text-lg font-semibold text-white">{value}</p>
          </div>
        ))}
      </div>

      {/* Pending Withdrawals */}
      {pendingBig > 0n && (
        <div className="rounded-xl p-4 flex items-center justify-between"
          style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)' }}>
          <div>
            <p className="text-[11px] text-emerald-400/60 uppercase tracking-wider mb-0.5">Pending ETH Withdrawal</p>
            <p className="text-lg font-semibold text-emerald-400">{formatWei(pendingBig, 18, 6)} ETH</p>
          </div>
          <button onClick={handleWithdrawPending} disabled={isBusy}
            className="px-4 py-2 rounded-lg text-[12px] font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/25 transition-colors disabled:opacity-40">
            Withdraw
          </button>
        </div>
      )}

      {/* Claimable Bribes */}
      {hasClaimable && (
        <div className="rounded-xl p-4 flex items-center justify-between"
          style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.2)' }}>
          <div>
            <p className="text-[11px] text-purple-400/60 uppercase tracking-wider mb-0.5">Claimable Bribes (Epoch #{Math.max(0, epoch - 1)})</p>
            <div className="flex gap-3">
              {claimable?.[0]?.map((token: Address, i: number) => (
                <span key={token} className="text-sm font-semibold text-purple-300">
                  {formatTokenAmount(formatEther(claimable[1]![i]!), 4)} {shortenAddress(token)}
                </span>
              ))}
            </div>
          </div>
          <button onClick={handleClaimBribes} disabled={isBusy}
            className="px-4 py-2 rounded-lg text-[12px] font-semibold bg-purple-500/15 text-purple-400 border border-purple-500/20 hover:bg-purple-500/25 transition-colors disabled:opacity-40">
            Claim
          </button>
        </div>
      )}

      {/* Deposit Bribe — "Cartman's Market" */}
      <div className="rounded-2xl overflow-hidden" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
        <div className="px-5 py-4 border-b border-white/5 flex items-center gap-2">
          <h3 className="text-sm font-semibold text-white">{GOVERNANCE_COPY.bribesSectionTitle}</h3>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300 border border-purple-500/20">
            {GOVERNANCE_COPY.bribesSectionTag}
          </span>
          <InfoTooltip text="Deposit ETH to incentivize gauge voters for the TOWELI/WETH LP pool. Voters earn a pro-rata share of deposited incentives." />
        </div>
        <div className="p-5 space-y-4">
          <p className="text-[12px] text-white/70">
            {GOVERNANCE_COPY.bribesSubheading}
          </p>
          <div>
            <label className="text-[11px] text-white/40 uppercase tracking-wider block mb-1">Amount (ETH)</label>
            <input type="number" step="0.01" value={bribeAmount} onChange={(e) => setBribeAmount(e.target.value)}
              placeholder="0.1" className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 text-white text-sm font-mono focus:border-emerald-500 outline-none transition-colors" />
            {fee > 0 && bribeAmount && (
              <p className="text-[10px] text-white/30 mt-1">
                Fee: {(Number(bribeAmount) * fee / 10000).toFixed(6)} ETH ({fee / 100}%)
              </p>
            )}
          </div>
          <button onClick={handleDepositETH} disabled={!bribeAmount || Number(bribeAmount) <= 0 || isBusy}
            className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-40"
            style={{ background: 'linear-gradient(135deg, rgb(16 185 129), rgb(5 150 105))', color: 'white' }}>
            {bribes.isPending ? 'Confirm in Wallet...' : bribes.isConfirming ? 'Depositing...' : `Deposit ${bribeAmount || '0'} ETH Bribe`}
          </button>
        </div>
      </div>

      {/* Advance Epoch */}
      <button onClick={handleAdvanceEpoch} disabled={isBusy}
        className="w-full py-2.5 rounded-xl text-[12px] font-semibold text-white/70 border border-white/10 hover:border-white/20 hover:text-white/60 transition-colors disabled:opacity-40">
        Advance Epoch (permissionless)
      </button>

      {/* Contract Link */}
      <div className="text-center pt-2">
        <a href={`https://etherscan.io/address/${VOTE_INCENTIVES_ADDRESS}`} target="_blank" rel="noopener noreferrer"
          className="text-white/30 text-[11px] hover:text-white/70 transition-colors font-mono">
          VoteIncentives: {shortenAddress(VOTE_INCENTIVES_ADDRESS)} &#8599;
        </a>
      </div>
    </div>
  );
}
