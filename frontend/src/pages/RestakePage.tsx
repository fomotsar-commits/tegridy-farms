import { useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { useAccount, useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
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
  const { data: restakeData, refetch } = useReadContracts({
    contracts: [
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'restakers', args: [address!] },
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'pendingBonus', args: [address!] },
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'pendingBase', args: [address!] },
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'totalRestaked' },
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'bonusRewardPerSecond' },
    ],
    query: { enabled: isDeployed && !!address, refetchInterval: 10_000 },
  });

  // Check NFT approval separately (different ABI)
  const { data: approvedAddress, refetch: refetchApproval } = useReadContract({
    address: TEGRIDY_STAKING_ADDRESS,
    abi: TEGRIDY_STAKING_ABI,
    functionName: 'getApproved',
    args: [pos.tokenId],
    query: { enabled: isDeployed && !!address && pos.tokenId > 0n, refetchInterval: 10_000 },
  });

  const restaker = restakeData?.[0]?.result as readonly [bigint, bigint, bigint, bigint, bigint] | undefined;
  const pendingBonus = (restakeData?.[1]?.result as bigint) ?? 0n;
  const pendingBase = (restakeData?.[2]?.result as bigint) ?? 0n;
  const totalRestaked = (restakeData?.[3]?.result as bigint) ?? 0n;

  const isRestaked = restaker && restaker[0] > 0n;
  const restakedAmount = restaker ? restaker[1] : 0n;
  const isNFTApproved = (approvedAddress as string)?.toLowerCase() === TEGRIDY_RESTAKING_ADDRESS.toLowerCase();

  // Refetch + toast on success (moved into useEffect to avoid firing during render)
  const prevHashRef = useRef<string | undefined>();
  useEffect(() => {
    if (isSuccess && hash && hash !== prevHashRef.current) {
      prevHashRef.current = hash;
      toast.success('Transaction confirmed', {
        id: hash,
        action: { label: 'Etherscan', onClick: () => window.open(`https://etherscan.io/tx/${hash}`, '_blank') },
      });
      refetch();
      refetchApproval();
    }
  }, [isSuccess, hash, refetch, refetchApproval]);

  // Step 1: Approve NFT
  const handleApprove = () => {
    if (!pos.hasPosition) return;
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'approve',
      args: [TEGRIDY_RESTAKING_ADDRESS, pos.tokenId],
    });
  };

  // Step 2: Deposit NFT into restaking contract
  const handleDeposit = () => {
    if (!pos.hasPosition) return;
    writeContract({
      address: TEGRIDY_RESTAKING_ADDRESS,
      abi: TEGRIDY_RESTAKING_ABI,
      functionName: 'restake',
      args: [pos.tokenId],
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
            <div className="py-8 px-2">
              <div className="flex items-center justify-center gap-2 mb-4">
                <span className="text-white text-[16px] font-medium">Restaking</span>
                <span className="px-2 py-0.5 rounded text-[9px] font-semibold tracking-wider uppercase" style={{ background: 'rgba(139,92,246,0.12)', color: '#8b5cf6', border: '1px solid rgba(139,92,246,0.2)' }}>Coming Soon</span>
              </div>
              <p className="text-white/35 text-[12px] leading-relaxed text-center max-w-md mx-auto mb-5">
                Restaking will let you deposit your tsTOWELI staking NFT to earn bonus WETH yield from protocol fees on top of your base TOWELI rewards. Double-dip your staking position without unstaking.
              </p>
              <div className="grid grid-cols-3 gap-2 max-w-sm mx-auto">
                {[
                  { title: 'Base Rewards', desc: 'Keep earning TOWELI' },
                  { title: 'Bonus WETH', desc: 'From protocol fees' },
                  { title: 'Flexible', desc: 'Unrestake anytime' },
                ].map((item) => (
                  <div key={item.title} className="rounded-lg p-2.5 text-center" style={{ background: 'rgba(139,92,246,0.04)', border: '1px solid rgba(139,92,246,0.08)' }}>
                    <p className="text-white/60 text-[11px] font-medium mb-0.5">{item.title}</p>
                    <p className="text-white/25 text-[10px]">{item.desc}</p>
                  </div>
                ))}
              </div>
              <p className="text-white/15 text-[10px] text-center mt-4">Contract deployment pending. Check back soon.</p>
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
            /* Has position, not restaked — two-step: approve then deposit */
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
              {/* Step indicator */}
              <div className="flex items-center justify-center gap-3 mb-4">
                <div className={`flex items-center gap-1.5 ${isNFTApproved ? 'opacity-40' : ''}`}>
                  <span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px]" style={{ background: isNFTApproved ? 'rgba(34,197,94,0.3)' : 'rgba(139,92,246,0.2)', color: isNFTApproved ? '#22c55e' : '#8b5cf6' }}>
                    {isNFTApproved ? '\u2713' : '1'}
                  </span>
                  <span className="text-white/50 text-[11px]">Approve</span>
                </div>
                <span className="text-white/20 text-[10px]">&rarr;</span>
                <div className={`flex items-center gap-1.5 ${!isNFTApproved ? 'opacity-40' : ''}`}>
                  <span className="w-5 h-5 rounded-full flex items-center justify-center text-[10px]" style={{ background: 'rgba(139,92,246,0.2)', color: '#8b5cf6' }}>2</span>
                  <span className="text-white/50 text-[11px]">Deposit</span>
                </div>
              </div>
              {!isNFTApproved ? (
                <button onClick={handleApprove}
                  disabled={isPending || isConfirming}
                  className="btn-secondary px-8 py-3 text-[14px] disabled:opacity-35 disabled:cursor-not-allowed">
                  {isPending || isConfirming ? 'Approving...' : 'Step 1: Approve NFT'}
                </button>
              ) : (
                <button onClick={handleDeposit}
                  disabled={isPending || isConfirming}
                  className="btn-primary px-8 py-3 text-[14px] disabled:opacity-35 disabled:cursor-not-allowed">
                  {isPending || isConfirming ? 'Depositing...' : 'Step 2: Deposit & Restake'}
                </button>
              )}
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
