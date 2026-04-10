import { createContext, useContext, useState, useCallback } from 'react';

export type ReceiptType = 'swap' | 'stake' | 'unstake' | 'claim' | 'vote' | 'bounty' | 'lock' | 'approve' | 'liquidity_add' | 'liquidity_remove' | 'subscribe' | 'claim_revenue';

export interface ReceiptData {
  type: ReceiptType;
  data: {
    // For swaps
    fromToken?: string;
    fromAmount?: string;
    toToken?: string;
    toAmount?: string;
    rate?: string;
    fee?: string;
    slippage?: string;
    // For staking
    amount?: string;
    token?: string;
    lockDuration?: string;
    boost?: string;
    estimatedAPR?: string;
    // For claims
    rewardAmount?: string;
    // For votes
    poolName?: string;
    voteWeight?: string;
    // For bounties
    bountyTitle?: string;
    bountyReward?: string;
    // Common
    txHash?: string;
  };
}

interface TransactionReceiptContextValue {
  receiptData: ReceiptData | null;
  showReceipt: (data: ReceiptData) => void;
  hideReceipt: () => void;
}

export const TransactionReceiptContext = createContext<TransactionReceiptContextValue>({
  receiptData: null,
  showReceipt: () => {},
  hideReceipt: () => {},
});

export function useTransactionReceiptState() {
  const [receiptData, setReceiptData] = useState<ReceiptData | null>(null);

  const showReceipt = useCallback((data: ReceiptData) => {
    setReceiptData(data);
  }, []);

  const hideReceipt = useCallback(() => {
    setReceiptData(null);
  }, []);

  return { receiptData, showReceipt, hideReceipt };
}

export function useTransactionReceipt() {
  return useContext(TransactionReceiptContext);
}
