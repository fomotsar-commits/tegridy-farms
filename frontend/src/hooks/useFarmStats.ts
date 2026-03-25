import { useState, useEffect } from 'react';
import { useReadContracts } from 'wagmi';
import { formatEther } from 'viem';
import { TEGRIDY_STAKING_ABI } from '../lib/contracts';
import { TEGRIDY_STAKING_ADDRESS, TOWELI_ADDRESS, isDeployed as checkDeployed } from '../lib/constants';
import { useToweliPrice } from './useToweliPrice';
import { formatCurrency } from '../lib/formatting';

export function useFarmStats() {
  const addr = TEGRIDY_STAKING_ADDRESS;
  const isDeployed = checkDeployed(addr);
  const price = useToweliPrice();

  // Direct API fallback — always works, no wallet needed
  const [apiPrice, setApiPrice] = useState<number>(() => {
    try {
      const c = localStorage.getItem('tegridy_api_price');
      if (c) { const { price: p, ts } = JSON.parse(c); if (Date.now() - ts < 600_000 && p > 0) return p; }
    } catch {} return 0;
  });
  useEffect(() => {
    fetch(`https://api.geckoterminal.com/api/v2/simple/networks/eth/token_price/${TOWELI_ADDRESS.toLowerCase()}`)
      .then(r => r.json()).then(d => {
        const p = parseFloat(d?.data?.attributes?.token_prices?.[TOWELI_ADDRESS.toLowerCase()] ?? '0');
        if (p > 0) { setApiPrice(p); localStorage.setItem('tegridy_api_price', JSON.stringify({ price: p, ts: Date.now() })); }
      }).catch(() => {});
  }, []);

  const effectivePrice = price.priceInUsd > 0 ? price.priceInUsd : apiPrice;

  const { data } = useReadContracts({
    contracts: [
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalStaked' },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalRewardsFunded' },
      { address: addr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalPenaltiesCollected' },
    ],
    query: { enabled: isDeployed, refetchInterval: 30_000 },
  });

  const totalStaked = (data?.[0]?.status === 'success' ? data[0].result as bigint : 0n);
  const totalFunded = (data?.[1]?.status === 'success' ? data[1].result as bigint : 0n);

  const totalStakedNum = Number(formatEther(totalStaked));
  const totalFundedNum = Number(formatEther(totalFunded));

  return {
    tvl: isDeployed ? (totalStakedNum > 0 ? `${totalStakedNum.toLocaleString()} TOWELI` : '0 TOWELI') : '–',
    toweliPrice: effectivePrice > 0 ? formatCurrency(effectivePrice, 6) : '–',
    rewardsDistributed: isDeployed ? `${totalFundedNum.toLocaleString()} TOWELI` : '–',
    isDeployed,
  };
}
