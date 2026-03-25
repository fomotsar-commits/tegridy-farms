import { motion } from 'framer-motion';
import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatEther } from 'viem';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { Link } from 'react-router-dom';
import { TEGRIDY_RESTAKING_ADDRESS, TEGRIDY_STAKING_ADDRESS, isDeployed as checkDeployed } from '../lib/constants';
import { TEGRIDY_RESTAKING_ABI, TEGRIDY_STAKING_ABI } from '../lib/contracts';
import { useUserPosition } from '../hooks/useUserPosition';
import { ART } from '../lib/artConfig';
import { formatTokenAmount } from '../lib/formatting';
import { toast } from 'sonner';

export default function RestakePage() {
  const { isConnected, address } = useAccount();
  const pos = useUserPosition();
  const isDeployed = checkDeployed(TEGRIDY_RESTAKING_ADDRESS);

  const { writeContract, data: hash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({ hash });

  // Read restaking info
  const { data: restakeData } = useReadContracts({
    contracts: [
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'restakers', args: [address!] },
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'pendingBonus', args: [address!] },
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'pendingBase', args: [address!] },
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'totalRestaked' },
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'bonusRewardPerSecond' },
    ],
    query: { enabled: isDeployed && !!address, refetchInterval: 10_000 },
  });

  const restaker = restakeData?.[0]?.result as readonly [bigint, bigint, bigint, bigint, bigint] | undefined;
  const pendingBonus = (restakeData?.[1]?.result as bigint) ?? 0n;
  const pendingBase = (restakeData?.[2]?.result as bigint) ?? 0n;
  const totalRestaked = (restakeData?.[3]?.result as bigint) ?? 0n;

  const isRestaked = restaker && restaker[0] > 0n;
  const restakedAmount = restaker ? restaker[1] : 0n;

  if (isSuccess && hash) {
    toast.success('Transaction confirmed', {
      id: hash,
      action: { label: 'Etherscan', onClick: () => window.open(`https://etherscan.io/tx/${hash}`, '_blank') },
    });
  }

  const handleRestake = () => {
    if (!pos.hasPosition) return;
    // First approve the NFT transfer
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'approve',
      args: [TEGRIDY_RESTAKING_ADDRESS, pos.tokenId],
    });
  };

  const handleClaimAll = () => {
    writeContract({
      address: TEGRIDY_RESTAKING_ADDRESS,
      abi: TEGRIDY_RESTAKING_ABI,
      functionName: 'claimAll',
    });
  };

  const handleUnrestake = () => {
    writeContract({
      address: TEGRIDY_RESTAKING_ADDRESS,
      abi: TEGRIDY_RESTAKING_ABI,
      functionName: 'unrestake',
    });
  };

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.beachVibes.src} alt="" className="w-full h-full object-cover" style={{ objectPosition: 'center 30%' }} />
        <div className="absolute inset-0" style={{
          background: 'linear-gradient(to bottom, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.45) 30%, rgba(0,0,0,0.65) 60%, rgba(0,0,0,0.85) 100%)',
        }} />
      </div>

      <div className="relative z-10 max-w-[800px] mx-auto px-4 md:px-6 pt-20 pb-12">
        <motion.div className="mb-8" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <h1 className="heading-luxury text-3xl md:text-4xl text-white tracking-tight mb-1">Restake</h1>
          <p className="text-white/50 text-[14px]">Deposit your staking NFT for bonus yield on top of base rewards</p>
        </motion.div>

        {/* How it works */}
        <motion.div className="relative overflow-hidden rounded-xl mb-6" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
          <div className="absolute inset-0">
            <img src={ART.mfersHeaven.src} alt="" className="w-full h-full object-cover" />
            <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, rgba(6,12,26,0.45) 0%, rgba(6,12,26,0.72) 50%, rgba(6,12,26,0.88) 100%)' }} />
          </div>
          <div className="relative z-10 p-5">
            <h3 className="text-white text-[14px] font-medium mb-3">How Restaking Works</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {[
                { step: '1', title: 'Stake TOWELI', desc: 'Lock TOWELI in Farm to get a tsTOWELI NFT' },
                { step: '2', title: 'Deposit NFT Here', desc: 'This contract holds your NFT and manages rewards' },
                { step: '3', title: 'Earn Double', desc: 'Base TOWELI rewards + bonus WETH from protocol fees' },
              ].map((s) => (
                <div key={s.step} className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.08)' }}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] text-primary" style={{ background: 'rgba(139,92,246,0.15)' }}>{s.step}</span>
                    <span className="text-white text-[12px] font-medium">{s.title}</span>
                  </div>
                  <p className="text-white/30 text-[11px]">{s.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </motion.div>

        {/* Stats */}
        <motion.div className="grid grid-cols-2 gap-3 mb-6" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          <div className="relative overflow-hidden rounded-xl" style={{ border: '1px solid rgba(139,92,246,0.12)' }}>
            <div className="absolute inset-0">
              <img src={ART.poolParty.src} alt="" className="w-full h-full object-cover" />
              <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, rgba(6,12,26,0.45) 0%, rgba(6,12,26,0.72) 50%, rgba(6,12,26,0.88) 100%)' }} />
            </div>
            <div className="relative z-10 p-4">
              <p className="text-white/40 text-[11px] uppercase tracking-wider mb-1">Total Restaked</p>
              <p className="stat-value text-lg text-white">{formatTokenAmount(formatEther(totalRestaked), 0)} TOWELI</p>
            </div>
          </div>
          <div className="relative overflow-hidden rounded-xl" style={{ border: '1px solid rgba(139,92,246,0.12)' }}>
            <div className="absolute inset-0">
              <img src={ART.swordOfLove.src} alt="" className="w-full h-full object-cover" />
              <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, rgba(6,12,26,0.45) 0%, rgba(6,12,26,0.72) 50%, rgba(6,12,26,0.88) 100%)' }} />
            </div>
            <div className="relative z-10 p-4">
              <p className="text-white/40 text-[11px] uppercase tracking-wider mb-1">Bonus Yield</p>
              <p className="stat-value text-lg text-primary">WETH</p>
              <p className="text-white/30 text-[11px]">From protocol fees</p>
            </div>
          </div>
        </motion.div>

        {/* Action Card */}
        <motion.div className="relative overflow-hidden rounded-xl" style={{ border: '1px solid rgba(139,92,246,0.12)' }}
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
          <div className="absolute inset-0">
            <img src={ART.chaosScene.src} alt="" className="w-full h-full object-cover" />
            <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, rgba(6,12,26,0.45) 0%, rgba(6,12,26,0.72) 50%, rgba(6,12,26,0.88) 100%)' }} />
          </div>
          <div className="relative z-10 p-6">
          {!isConnected ? (
            <div className="text-center py-8">
              <p className="text-white/40 text-[13px] mb-4">Connect wallet to restake</p>
              <ConnectButton.Custom>
                {({ openConnectModal, mounted }) => (
                  <div {...(!mounted && { style: { opacity: 0, pointerEvents: 'none' } })}>
                    <button onClick={openConnectModal} className="btn-primary px-7 py-2.5 text-[14px]">
                      Connect Wallet
                    </button>
                  </div>
                )}
              </ConnectButton.Custom>
            </div>
          ) : !isDeployed ? (
            <div className="text-center py-8">
              <p className="text-white/40 text-[13px]">Restaking contract not yet deployed</p>
              <p className="text-white/20 text-[11px] mt-1">Coming soon</p>
            </div>
          ) : isRestaked ? (
            /* Active restake position */
            <div>
              <h3 className="text-white text-[16px] font-medium mb-4">Your Restaked Position</h3>
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.10)' }}>
                  <p className="text-white/30 text-[10px] mb-0.5">Restaked Amount</p>
                  <p className="stat-value text-[16px] text-white">{formatTokenAmount(formatEther(restakedAmount), 2)}</p>
                </div>
                <div className="rounded-lg p-3" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.10)' }}>
                  <p className="text-white/30 text-[10px] mb-0.5">Pending Base (TOWELI)</p>
                  <p className="stat-value text-[16px] text-primary">{formatTokenAmount(formatEther(pendingBase), 4)}</p>
                </div>
                <div className="rounded-lg p-3 col-span-2" style={{ background: 'rgba(45,139,78,0.04)', border: '1px solid rgba(45,139,78,0.12)' }}>
                  <p className="text-white/30 text-[10px] mb-0.5">Pending Bonus (WETH)</p>
                  <p className="stat-value text-[16px] text-success">{Number(formatEther(pendingBonus)).toFixed(8)} WETH</p>
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={handleClaimAll}
                  disabled={isPending || isConfirming}
                  className="btn-primary flex-1 py-3 text-[14px] disabled:opacity-35 disabled:cursor-not-allowed">
                  {isPending || isConfirming ? 'Processing...' : 'Claim All Rewards'}
                </button>
                <button onClick={handleUnrestake}
                  disabled={isPending || isConfirming}
                  className="btn-secondary flex-1 py-3 text-[14px] disabled:opacity-35">
                  {isPending || isConfirming ? 'Processing...' : 'Unrestake (Get NFT Back)'}
                </button>
              </div>
            </div>
          ) : !pos.hasPosition ? (
            /* No staking position */
            <div className="text-center py-8">
              <p className="text-white/40 text-[13px] mb-3">You need a staking position first</p>
              <Link to="/farm" className="btn-primary px-6 py-2.5 text-[13px]">Go to Farm &#8594;</Link>
            </div>
          ) : (
            /* Has position, not restaked */
            <div className="text-center py-6">
              <p className="text-white text-[14px] font-medium mb-2">Ready to Restake</p>
              <p className="text-white/40 text-[12px] mb-4 max-w-md mx-auto">
                Deposit your tsTOWELI NFT (Position #{pos.tokenId.toString()}) to earn bonus WETH on top of your base TOWELI rewards.
              </p>
              <div className="rounded-lg p-4 mb-4 mx-auto max-w-xs" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.10)' }}>
                <p className="text-white/30 text-[10px] mb-0.5">Your Position</p>
                <p className="stat-value text-[18px] text-white">{formatTokenAmount(pos.stakedFormatted, 2)} TOWELI</p>
                <p className="text-primary/50 text-[11px]">{pos.boostMultiplier.toFixed(2)}x boost</p>
              </div>
              <button onClick={handleRestake}
                disabled={isPending || isConfirming}
                className="btn-primary px-8 py-3 text-[14px] disabled:opacity-35 disabled:cursor-not-allowed">
                {isPending || isConfirming ? 'Processing...' : 'Approve & Restake NFT'}
              </button>
              <p className="text-white/20 text-[10px] mt-3">
                Your NFT will be held by the restaking contract. Unrestake anytime to get it back.
              </p>
            </div>
          )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
