import { useState, useMemo, useEffect } from 'react';
import { useReadContract, useWriteContract, useWaitForTransactionReceipt, useAccount, useBalance } from 'wagmi';
import { parseEther, formatEther } from 'viem';
import { UNISWAP_V2_ROUTER_ABI, ERC20_ABI, UNISWAP_V2_PAIR_ABI } from '../lib/contracts';
import { UNISWAP_V2_ROUTER, WETH_ADDRESS, TOWELI_ADDRESS, TOWELI_WETH_LP_ADDRESS } from '../lib/constants';

export type SwapDirection = 'buy' | 'sell'; // buy = ETH->TOWELI, sell = TOWELI->ETH

export function useSwap() {
  const { address } = useAccount();
  const [direction, setDirection] = useState<SwapDirection>('buy');
  const [inputAmount, setInputAmount] = useState('');
  const [slippage, setSlippage] = useState(5); // 5% default for meme token
  const [deadline, setDeadline] = useState(5); // 5 minutes default

  const { data: ethBalance } = useBalance({ address });

  const path = direction === 'buy'
    ? [WETH_ADDRESS, TOWELI_ADDRESS]
    : [TOWELI_ADDRESS, WETH_ADDRESS];

  const parsedAmount = useMemo(() => {
    try {
      const val = parseFloat(inputAmount);
      if (isNaN(val) || val <= 0) return 0n;
      return parseEther(inputAmount);
    } catch {
      return 0n;
    }
  }, [inputAmount]);

  // Get quote from router
  const { data: amountsOut } = useReadContract({
    address: UNISWAP_V2_ROUTER,
    abi: UNISWAP_V2_ROUTER_ABI,
    functionName: 'getAmountsOut',
    args: [parsedAmount, path],
    query: { enabled: parsedAmount > 0n },
  });

  // Get reserves for real price impact calculation
  const { data: reserves } = useReadContract({
    address: TOWELI_WETH_LP_ADDRESS,
    abi: UNISWAP_V2_PAIR_ABI,
    functionName: 'getReserves',
    query: { enabled: parsedAmount > 0n },
  });

  const { data: token0 } = useReadContract({
    address: TOWELI_WETH_LP_ADDRESS,
    abi: UNISWAP_V2_PAIR_ABI,
    functionName: 'token0',
  });

  // Check allowance for sell direction
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: TOWELI_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [address!, UNISWAP_V2_ROUTER],
    query: { enabled: direction === 'sell' && !!address },
  });

  // Check TOWELI balance
  const { data: toweliBalance } = useReadContract({
    address: TOWELI_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address!],
    query: { enabled: !!address },
  });

  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash });

  // Refetch allowance after successful approval
  useEffect(() => {
    if (isSuccess && direction === 'sell') {
      refetchAllowance();
    }
  }, [isSuccess, direction, refetchAllowance]);

  const outputAmount = amountsOut ? amountsOut[1] : 0n;
  const outputFormatted = formatEther(outputAmount);

  // Real price impact from reserves — use BigInt math to avoid float precision loss
  const priceImpact = useMemo(() => {
    if (!reserves || !token0 || parsedAmount === 0n || outputAmount === 0n) return 0;

    try {
      const isToken0Toweli = token0.toLowerCase() === TOWELI_ADDRESS.toLowerCase();
      const toweliReserve = isToken0Toweli ? reserves[0] : reserves[1];
      const wethReserve = isToken0Toweli ? reserves[1] : reserves[0];

      if (toweliReserve <= 0n || wethReserve <= 0n) return 0;

      // Use BigInt scaled math: compute mid-price ratio scaled by 1e18
      // For buy: midPrice = toweliReserve / wethReserve (TOWELI per ETH)
      //   executionPrice = outputAmount / parsedAmount
      // For sell: midPrice = wethReserve / toweliReserve (ETH per TOWELI)
      //   executionPrice = outputAmount / parsedAmount
      const midPriceScaled = direction === 'buy'
        ? (toweliReserve * 10n ** 18n) / wethReserve
        : (wethReserve * 10n ** 18n) / toweliReserve;

      const execPriceScaled = (outputAmount * 10n ** 18n) / parsedAmount;

      // impact = |midPrice - execPrice| / midPrice * 100
      const diff = midPriceScaled > execPriceScaled
        ? midPriceScaled - execPriceScaled
        : execPriceScaled - midPriceScaled;
      const impactBps = (diff * 10000n) / midPriceScaled;
      return Number(impactBps) / 100; // convert basis points to percentage with 2dp
    } catch {
      return 0;
    }
  }, [reserves, token0, parsedAmount, outputAmount, direction]);

  // Slippage: use integer basis points to avoid float→BigInt issues
  const minimumReceived = useMemo(() => {
    if (outputAmount === 0n) return 0n;
    const slippageBps = BigInt(Math.round(slippage * 10)); // e.g. 5% = 50 bps out of 1000
    return outputAmount - (outputAmount * slippageBps) / 1000n;
  }, [outputAmount, slippage]);

  const needsApproval = direction === 'sell' && parsedAmount > 0n && (allowance ?? 0n) < parsedAmount;

  // Balance validation
  const insufficientBalance = useMemo(() => {
    if (parsedAmount === 0n) return false;
    if (direction === 'buy') {
      const ethBal = ethBalance?.value ?? 0n;
      return parsedAmount > ethBal;
    } else {
      return parsedAmount > (toweliBalance ?? 0n);
    }
  }, [parsedAmount, direction, ethBalance, toweliBalance]);

  const approve = () => {
    // Approve only the exact amount needed, not maxUint256
    writeContract({
      address: TOWELI_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [UNISWAP_V2_ROUTER, parsedAmount],
    });
  };

  const executeSwap = () => {
    if (!address || parsedAmount === 0n || insufficientBalance) return;
    const deadlineTs = BigInt(Math.floor(Date.now() / 1000) + deadline * 60);

    if (direction === 'buy') {
      writeContract({
        address: UNISWAP_V2_ROUTER,
        abi: UNISWAP_V2_ROUTER_ABI,
        functionName: 'swapExactETHForTokens',
        args: [minimumReceived, path, address, deadlineTs],
        value: parsedAmount,
      });
    } else {
      writeContract({
        address: UNISWAP_V2_ROUTER,
        abi: UNISWAP_V2_ROUTER_ABI,
        functionName: 'swapExactTokensForETH',
        args: [parsedAmount, minimumReceived, path, address, deadlineTs],
      });
    }
  };

  const flipDirection = () => {
    setDirection(d => d === 'buy' ? 'sell' : 'buy');
    setInputAmount('');
    reset();
  };

  return {
    direction,
    inputAmount,
    setInputAmount,
    slippage,
    setSlippage,
    deadline,
    setDeadline,
    outputFormatted,
    outputAmount,
    priceImpact,
    minimumReceived: formatEther(minimumReceived),
    needsApproval,
    insufficientBalance,
    approve,
    executeSwap,
    flipDirection,
    isPending,
    isConfirming,
    isSuccess,
    isTxError,
    writeError,
    reset,
    toweliBalance: toweliBalance ?? 0n,
    refetchAllowance,
  };
}
