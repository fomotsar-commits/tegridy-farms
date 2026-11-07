// My Loans: the wallet's loans (borrowed or lent) and its open offers.
//
// Gondi stores only a hash of each loan, and repaying or claiming must send the whole loan
// back. So the loans come from the offer book's records (lib/gondi/offerBook.ts) and each is
// checked against getLoanHash before any button: an unread or mismatched hash never offers
// one.
import { useState, useEffect, useRef } from 'react';
import { useAccount, useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt, useChainId } from 'wagmi';
import { type Address, type Hex } from 'viem';
import { toast } from 'sonner';
import { CHAIN_ID } from '../../lib/constants';
import { ERC20_ABI } from '../../lib/contracts';
import { GONDI_LOAN_ABI } from '../../lib/gondi/abi.js';
import { GONDI_LOAN_ADDRESS, WETH_ADDRESS, isWholeCollectionOffer, sameAddress } from '../../lib/gondi/loanOffer.js';
import { loanEnd, loanFromJson, loanHash, owedAt, type Loan } from '../../lib/gondi/loanMath';
import { recordLoanTx, syncOffer, useBookLoans, useBookOffers, useRefreshBook, type BookLoan, type BookOffer } from '../../lib/gondi/offerBook';
import { CardArt } from '../ui/CardArt';
import { FinePrint } from '../ui/FinePrint';
import { useCountdown } from '../../hooks/useCountdown';
import { useReceiptOutcome } from '../../hooks/useReceiptOutcome';
import { surfaceTxError, noteReplacement } from '../../lib/txErrors';
import {
  CARD_BG,
  CARD_BORDER,
  LABEL_STYLE,
  LENDING_LIVE,
  WETH_DEPOSIT_ABI,
  bpsToPercent,
  collectionSymbol,
  fmtWeth,
  formatDuration,
  nowSeconds,
} from './nftLendingShared';

const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;
// Repaying pulls interest up to the block it lands in; approve and hold enough for 10
// more minutes so a slow confirmation does not revert.
const REPAY_PAD_SECONDS = 600n;

const STATUS_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  active: { bg: 'rgba(16,185,129,0.12)', text: 'text-emerald-400', border: 'border-emerald-500/30' },
  overdue: { bg: 'rgba(234,179,8,0.12)', text: 'text-yellow-400', border: 'border-yellow-500/30' },
  repaid: { bg: 'var(--color-purple-12)', text: 'text-purple-400', border: 'border-purple-500/30' },
  defaulted: { bg: 'rgba(239,68,68,0.12)', text: 'text-red-400', border: 'border-red-500/30' },
  closed: { bg: 'var(--color-purple-12)', text: 'text-purple-400', border: 'border-purple-500/30' },
  unknown: { bg: 'rgba(255,255,255,0.05)', text: 'text-white/80', border: 'border-white/20' },
};

export function MyLoansTab() {
  const { address, isConnected } = useAccount();
  const loans = useBookLoans(LENDING_LIVE ? address : undefined);
  const offers = useBookOffers({ lender: address, enabled: LENDING_LIVE && !!address });
  const rows = loans.data?.loans ?? [];
  const openRows = rows.filter((r) => r.status === 'open');

  const hashes = useReadContracts({
    contracts: openRows.map((r) => ({
      address: GONDI_LOAN_ADDRESS,
      abi: GONDI_LOAN_ABI,
      functionName: 'getLoanHash',
      args: [BigInt(r.loanId)],
      chainId: CHAIN_ID,
    }) as const),
    query: { enabled: LENDING_LIVE && openRows.length > 0, refetchInterval: 30_000 },
  });

  if (!isConnected || !address) {
    return <Notice title="Connect your wallet to view your loans." />;
  }

  return (
    <div className="space-y-6">
      {loans.isLoading ? (
        <div className="text-center py-12 text-white/70 text-[13px]">Loading loans...</div>
      ) : loans.isError ? (
        <Notice title="Couldn't load your loans." line="The offer book did not answer. Your loans are safe on chain; try again in a moment." />
      ) : rows.length === 0 ? (
        <Notice title="No loans yet." line="Take an offer in the Borrow tab, or make one in the Lend tab." />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {rows.map((row) => {
            const i = openRows.indexOf(row);
            const read = i >= 0 ? hashes.data?.[i] : undefined;
            const chainHash = read?.status === 'success' ? (read.result as Hex) : read?.status === 'failure' || (i >= 0 && hashes.isError) ? 'unread' : undefined;
            return <LoanCard key={row.loanId} row={row} chainHash={chainHash} userAddress={address} />;
          })}
        </div>
      )}

      <MyOffers rows={offers.data?.offers ?? []} loading={offers.isLoading} failed={offers.isError} />
      <FindLoan />
    </div>
  );
}

function Notice({ title, line }: { title: string; line?: string }) {
  return (
    <div className="relative isolate rounded-xl p-8 text-center" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
      <CardArt pageId="nft-finance" idx={19} />
      <p className="text-white/70 text-[13px]">{title}</p>
      {line && <p className="text-white/70 text-[11px] mt-1">{line}</p>}
    </div>
  );
}

/* ─── Loan Card ─────────────────────────────────────────────────── */
type LoanView = 'active' | 'overdue' | 'repaid' | 'defaulted' | 'closed' | 'unknown';

function LoanCard({ row, chainHash, userAddress }: { row: BookLoan; chainHash: Hex | 'unread' | undefined; userAddress: Address }) {
  const chainId = useChainId();
  const refreshBook = useRefreshBook();
  const loan: Loan = loanFromJson(row.loan);
  const lender = loan.tranche[0]!.lender;
  const isBorrower = sameAddress(loan.borrower, userAddress);
  const isLender = sameAddress(lender, userAddress);
  const end = loanEnd(loan);
  const countdown = useCountdown(end);

  // The record says open; the chain decides. Same hash: open. Zero: closed since the
  // record (repaid, claimed or refinanced). Anything else or no read: no button.
  let view: LoanView;
  if (row.status === 'repaid') view = 'repaid';
  else if (row.status === 'liquidated') view = 'defaulted';
  else if (row.status === 'refinanced') view = 'closed';
  else if (chainHash === undefined || chainHash === 'unread') view = 'unknown';
  else if (chainHash === ZERO_HASH) view = 'closed';
  else if (chainHash.toLowerCase() !== loanHash(loan).toLowerCase()) view = 'unknown';
  else view = countdown.isExpired ? 'overdue' : 'active';
  const colors = STATUS_COLORS[view]!;
  const open = view === 'active' || view === 'overdue';

  const { data: wethBalance, refetch: refetchWeth } = useReadContract({
    address: WETH_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [userAddress],
    chainId: CHAIN_ID,
    query: { enabled: isBorrower && open },
  });
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: WETH_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [userAddress, GONDI_LOAN_ADDRESS],
    chainId: CHAIN_ID,
    query: { enabled: isBorrower && open },
  });

  // Ticks with the countdown, so the figure moves as interest accrues.
  const now = nowSeconds();
  const owedNow = owedAt(loan, now);
  const owedPadded = owedAt(loan, now + REPAY_PAD_SECONDS).total;
  const wethShort = typeof wethBalance === 'bigint' ? (wethBalance < owedPadded ? owedPadded - wethBalance : 0n) : null;
  const needsApproval = typeof allowance === 'bigint' ? allowance < owedPadded : null;
  const repayStep = wethShort === null || needsApproval === null ? null : wethShort > 0n ? 'wrap' : needsApproval ? 'approve' : 'repay';

  const tx = useWriteContract();
  const txQuery = useWaitForTransactionReceipt({ hash: tx.data, onReplaced: noteReplacement });
  const { isSuccess: txOk, isReverted: txReverted } = useReceiptOutcome(txQuery, {
    hash: tx.data,
    chainId: CHAIN_ID,
    repeatCost: 'sending it again reverts if the loan is already settled.',
  });
  // Which step the one transaction hook is carrying, for its confirmation toast. A ref: it
  // changes nothing on screen (the buttons read the hook's own pending state).
  const pending = useRef<'wrap' | 'approve' | 'repay' | 'claim' | null>(null);

  useEffect(() => {
    const step = pending.current;
    if (!txOk || !tx.data || !step) return;
    if (step === 'wrap') {
      toast.success('ETH wrapped to WETH.');
      void refetchWeth();
    } else if (step === 'approve') {
      toast.success('WETH approved. Now repay.');
      void refetchAllowance();
    } else {
      toast.success(step === 'repay' ? 'Loan repaid. Your NFT is back in your wallet.' : 'The NFT is yours: it is in your wallet now.');
      void recordLoanTx(tx.data).catch(() => undefined).finally(refreshBook);
    }
    pending.current = null;
    tx.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per confirmed tx
  }, [txOk]);
  useEffect(() => {
    if (txReverted) {
      toast.error('The transaction reverted on-chain. The loan is unchanged.');
      pending.current = null;
    }
  }, [txReverted]);

  const preflight = () => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return false; }
    if (!LENDING_LIVE) { toast.error('NFT lending is not live yet'); return false; }
    return true;
  };
  const onError = (component: string) => ({
    onError: (err: Error) => {
      pending.current = null;
      surfaceTxError(err, toast, { component });
    },
  });

  const handleRepayStep = () => {
    if (!preflight() || !repayStep) return;
    pending.current = repayStep;
    if (repayStep === 'wrap') {
      tx.writeContract({ chainId: CHAIN_ID, address: WETH_ADDRESS, abi: WETH_DEPOSIT_ABI, functionName: 'deposit', value: wethShort! }, onError('NFTLendingLoans.wrap'));
    } else if (repayStep === 'approve') {
      tx.writeContract({ chainId: CHAIN_ID, address: WETH_ADDRESS, abi: ERC20_ABI, functionName: 'approve', args: [GONDI_LOAN_ADDRESS, owedPadded] }, onError('NFTLendingLoans.approve'));
    } else {
      tx.writeContract(
        {
          chainId: CHAIN_ID,
          address: GONDI_LOAN_ADDRESS,
          abi: GONDI_LOAN_ABI,
          functionName: 'repayLoan',
          args: [{ data: { loanId: BigInt(row.loanId), callbackData: '0x' as Hex, shouldDelegate: false }, loan, borrowerSignature: '0x' as Hex }],
        },
        onError('NFTLendingLoans.repay'),
      );
    }
  };

  const handleClaim = () => {
    if (!preflight()) return;
    pending.current = 'claim';
    tx.writeContract(
      { chainId: CHAIN_ID, address: GONDI_LOAN_ADDRESS, abi: GONDI_LOAN_ABI, functionName: 'liquidateLoan', args: [BigInt(row.loanId), loan] },
      onError('NFTLendingLoans.claim'),
    );
  };

  const busy = tx.isPending || txQuery.isLoading;
  const deadlineStr = (() => {
    if (!open) return '--';
    if (countdown.isExpired) return 'Expired';
    const r = countdown.secondsRemaining;
    const days = Math.floor(r / 86400);
    const hrs = Math.floor((r % 86400) / 3600);
    if (days > 0) return `${days}d ${hrs}h`;
    const mins = Math.floor((r % 3600) / 60);
    return `${hrs}h ${String(mins).padStart(2, '0')}m ${String(r % 60).padStart(2, '0')}s`;
  })();
  const label: Record<LoanView, string> = { active: 'Active', overdue: 'Overdue', repaid: 'Repaid', defaulted: 'Claimed', closed: 'Closed', unknown: 'Checking' };

  return (
    <div className="relative isolate rounded-xl p-3 md:p-5 space-y-3" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
      <CardArt pageId="nft-finance" idx={20} />
      <div className="flex items-center justify-between">
        <span className="text-white/70 text-[11px] font-mono">Loan #{row.loanId}</span>
        <div className="flex items-center gap-2">
          <span className={`text-[11px] px-2 py-0.5 rounded-full border ${colors.text} ${colors.border}`} style={{ background: colors.bg }}>
            {label[view]}
          </span>
          <span className={`text-[11px] px-2 py-0.5 rounded-full border ${isBorrower ? 'text-blue-400 border-blue-500/30 bg-blue-500/10' : 'text-amber-400 border-amber-500/30 bg-amber-500/10'}`}>
            {isBorrower ? 'Borrower' : 'Lender'}
          </span>
        </div>
      </div>

      <div>
        <p className="text-white text-xl font-semibold">{fmtWeth(loan.principalAmount)} WETH</p>
        <p className="text-white/70 text-[11px]">Loan amount</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div>
          <p className="text-emerald-400 text-[13px] font-medium">{bpsToPercent(Number(loan.tranche[0]!.aprBps))}%</p>
          <p className="text-white/70 text-[11px]">APR</p>
        </div>
        <div>
          <p className="text-purple-400 text-[13px] font-medium">{collectionSymbol(loan.nftCollateralAddress)}</p>
          <p className="text-white/70 text-[11px]">Collection</p>
        </div>
        <div>
          <p className="text-white/70 text-[13px] font-mono">#{loan.nftCollateralTokenId.toString()}</p>
          <p className="text-white/70 text-[11px]">Token</p>
        </div>
      </div>

      {view === 'unknown' && (
        <p className="text-yellow-300 text-[11px]">Checking this loan on chain. No action until it reads back.</p>
      )}

      {open && (
        <div
          className="rounded-lg p-2 text-center"
          style={{
            background: view === 'overdue' ? 'rgba(234,179,8,0.08)' : 'var(--color-purple-08)',
            border: `1px solid ${view === 'overdue' ? 'rgba(234,179,8,0.2)' : 'var(--color-purple-15)'}`,
          }}
        >
          <p className={`text-[11px] ${view === 'overdue' ? 'text-yellow-400' : 'text-white/70'}`}>{view === 'overdue' ? 'OVERDUE' : 'Time Remaining'}</p>
          <p className={`text-[13px] font-semibold ${view === 'overdue' ? 'text-yellow-400' : 'text-white'}`}>{deadlineStr}</p>
        </div>
      )}

      {open && (
        <div className="rounded-lg p-2 text-center" style={{ background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.15)' }}>
          <p className="text-white/70 text-[11px]">{isBorrower ? 'To repay now' : 'Owed to you now'}</p>
          <p className="text-emerald-400 text-[13px] font-semibold">
            {fmtWeth(isBorrower ? owedNow.total : owedNow.toLenders, 6)} WETH
          </p>
          <FinePrint summary="Where it goes">
            <p>
              {fmtWeth(loan.principalAmount, 6)} WETH back to the lender, plus {fmtWeth(owedNow.interest, 6)} WETH interest so far. The venue keeps{' '}
              {bpsToPercent(Number(loan.protocolFee))}% of the interest ({fmtWeth(owedNow.toVenue, 6)} WETH); the lender gets the rest.
            </p>
          </FinePrint>
        </div>
      )}

      {/* Gondi lets a borrower repay until the loan is claimed, even after the deadline. */}
      {isBorrower && open && (
        <button
          onClick={handleRepayStep}
          disabled={busy || repayStep === null}
          className="w-full min-h-[44px] rounded-xl text-[13px] font-semibold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: 'linear-gradient(135deg, rgba(16,185,129,0.25), var(--color-purple-25))', border: '1px solid rgba(16,185,129,0.3)' }}
        >
          {busy
            ? 'Confirm in Wallet...'
            : repayStep === 'wrap'
            ? `Wrap ${fmtWeth(wethShort!)} ETH to WETH`
            : repayStep === 'approve'
            ? 'Approve WETH to repay'
            : repayStep === 'repay'
            ? 'Repay Loan'
            : 'Reading your WETH...'}
        </button>
      )}

      {isLender && view === 'overdue' && (
        <button
          onClick={handleClaim}
          disabled={busy}
          className="w-full min-h-[44px] rounded-xl text-[13px] font-semibold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)' }}
        >
          {busy ? 'Confirm in Wallet...' : 'Claim the NFT'}
        </button>
      )}
    </div>
  );
}

/* ─── My open offers ────────────────────────────────────────────── */
function MyOffers({ rows, loading, failed }: { rows: BookOffer[]; loading: boolean; failed: boolean }) {
  if (loading) return null;
  return (
    <div className="space-y-2">
      <p className="text-white/90 text-[11px] uppercase tracking-wider" style={LABEL_STYLE}>Your open offers</p>
      {failed ? (
        <p className="text-white/70 text-[12px]">Couldn&apos;t load your offers right now.</p>
      ) : rows.length === 0 ? (
        <p className="text-white/70 text-[12px]">None. Make one in the Lend tab.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {rows.map((r) => (
            <MyOfferRow key={r.offer.offerId} row={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function MyOfferRow({ row }: { row: BookOffer }) {
  const chainId = useChainId();
  const refreshBook = useRefreshBook();
  const o = row.offer;
  const cancel = useWriteContract();
  const cancelQuery = useWaitForTransactionReceipt({ hash: cancel.data, onReplaced: noteReplacement });
  const { isSuccess: cancelled, isReverted } = useReceiptOutcome(cancelQuery, {
    hash: cancel.data,
    chainId: CHAIN_ID,
    repeatCost: 'cancelling again only costs gas.',
  });
  useEffect(() => {
    if (!cancelled) return;
    toast.success('Offer cancelled on-chain. Nobody can take it now.');
    void syncOffer(o.lender, o.offerId).catch(() => undefined).finally(refreshBook);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per confirmed tx
  }, [cancelled]);
  useEffect(() => {
    if (isReverted) toast.error('Cancelling reverted on-chain. The offer is still open.');
  }, [isReverted]);

  const handleCancel = () => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    cancel.writeContract(
      { chainId: CHAIN_ID, address: GONDI_LOAN_ADDRESS, abi: GONDI_LOAN_ABI, functionName: 'cancelOffer', args: [BigInt(o.offerId)] },
      { onError: (err) => surfaceTxError(err, toast, { component: 'NFTLendingLoans.cancelOffer' }) },
    );
  };
  const symbol = collectionSymbol(o.nftCollateralAddress);
  return (
    <div className="rounded-xl p-3 flex items-center justify-between gap-3" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
      <div className="min-w-0">
        <p className="text-white text-[13px] font-semibold">
          {fmtWeth(BigInt(o.principalAmount))} WETH · {bpsToPercent(Number(o.aprBps))}% · {formatDuration(Number(o.duration))}
        </p>
        <p className="text-white/70 text-[11px] truncate">{isWholeCollectionOffer(o) ? `${symbol} · any NFT` : `${symbol} #${o.nftCollateralTokenId}`}</p>
      </div>
      <button
        onClick={handleCancel}
        disabled={cancel.isPending || cancelQuery.isLoading || !LENDING_LIVE}
        className="min-h-[44px] px-3 rounded-xl text-[12px] font-medium text-white disabled:opacity-40"
        style={{ background: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)' }}
      >
        {cancel.isPending ? 'Confirm...' : cancelQuery.isLoading ? 'Cancelling...' : 'Cancel'}
      </button>
    </div>
  );
}

/* ─── Find a loan by its transaction ────────────────────────────── */
function FindLoan() {
  const refreshBook = useRefreshBook();
  const [hash, setHash] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^0x[0-9a-fA-F]{64}$/.test(hash.trim());
  const handleFind = async () => {
    setBusy(true);
    try {
      const out = await recordLoanTx(hash.trim() as Hex);
      toast.success(`Found ${out.loans.length === 1 ? 'a loan' : `${out.loans.length} loans`} in that transaction.`);
      setHash('');
      refreshBook();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not read that transaction');
    } finally {
      setBusy(false);
    }
  };
  return (
    <FinePrint summary="A loan is missing?">
      <div className="space-y-2">
        <p>Paste the transaction that opened it. The site reads the loan from the chain and adds it here.</p>
        <div className="flex gap-2">
          <input
            value={hash}
            onChange={(e) => setHash(e.target.value)}
            placeholder="0x... transaction hash"
            aria-label="Loan transaction hash"
            className="flex-1 min-w-0 min-h-[44px] rounded-xl px-3 text-white text-[12px] font-mono bg-transparent outline-none"
            style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
          />
          <button
            onClick={() => void handleFind()}
            disabled={!valid || busy || !LENDING_LIVE}
            className="min-h-[44px] px-3 rounded-xl text-[12px] font-medium text-white disabled:opacity-40"
            style={{ background: 'var(--color-purple-20)', border: '1px solid var(--color-purple-30)' }}
          >
            {busy ? 'Reading...' : 'Find'}
          </button>
        </div>
      </div>
    </FinePrint>
  );
}

