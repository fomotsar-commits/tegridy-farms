// NFT lending, on Gondi's own v3.2 loan contract (contracts/vendor/gondi-v3.2), unchanged.
//
// How money moves: a lender signs an offer for free and keeps their WETH until a borrower
// takes it; the loan contract then moves the WETH from the lender to the borrower and locks
// the borrower's NFT. The borrower repays principal + interest for the days used; the venue
// keeps the protocol fee (5% at deploy) of the interest, the lender the rest. Unpaid at the
// deadline, the lender takes the NFT. Offers live in the offer book (lib/gondi/offerBook.ts);
// every screen re-checks them on chain before it offers a button.
import { useState, useMemo, useEffect } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import {
  useAccount,
  useBalance,
  useReadContract,
  useReadContracts,
  useWriteContract,
  useWaitForTransactionReceipt,
  useChainId,
  useSignTypedData,
} from 'wagmi';
import { type Address, type Hex } from 'viem';
import { toast } from 'sonner';
import { CHAIN_ID } from '../../lib/constants';
import { ERC20_ABI, ERC721_ABI } from '../../lib/contracts';
import { GONDI_LOAN_ABI } from '../../lib/gondi/abi.js';
import {
  GONDI_LOAN_ADDRESS,
  LOAN_OFFER_TYPES,
  WETH_ADDRESS,
  ZERO_ADDRESS,
  acceptsToken,
  gondiDomain,
  isWholeCollectionOffer,
  loansPerOffer,
  offerToMessage,
  sameAddress,
  validateOfferShape,
  wholeCollectionValidators,
  type LoanOfferJson,
} from '../../lib/gondi/loanOffer.js';
import { interestFor } from '../../lib/gondi/loanMath';
import { postOffer, recordLoanTx, syncOffer, useBookOffers, useRefreshBook, type BookOffer } from '../../lib/gondi/offerBook';
import { InfoTooltip, HowItWorks, StepIndicator, RiskBanner, TxSummary } from '../ui/InfoTooltip';
import { ART, pageArt, artStyle } from '../../lib/artConfig';
import { ArtImg } from '../ArtImg';
import { CardArt } from '../ui/CardArt';
import { FinePrint } from '../ui/FinePrint';
import { useTabListKeys } from '../../hooks/useTabListKeys';
import { useSafeConnectModal } from '../../hooks/useSafeConnectModal';
import { useReceiptOutcome } from '../../hooks/useReceiptOutcome';
import { surfaceTxError, noteReplacement } from '../../lib/txErrors';
import { artImgProps } from '../../lib/artSrcSet';
import { MyLoansTab } from './NFTLendingLoans';
import {
  CARD_BG,
  CARD_BORDER,
  COLLECTIONS,
  COLLECTION_ART,
  EASE,
  LABEL_STYLE,
  LENDING_LIVE,
  SELECTED_BG,
  WETH_DEPOSIT_ABI,
  bpsToPercent,
  collectionSymbol,
  fmtWeth,
  formatDuration,
  newOfferId,
  nowSeconds,
  parseAmount,
  parseTokenId,
  shortenAddress,
} from './nftLendingShared';

const DURATION_PRESETS = [
  { label: '7d', seconds: 7 * 86400 },
  { label: '14d', seconds: 14 * 86400 },
  { label: '30d', seconds: 30 * 86400 },
  { label: '90d', seconds: 90 * 86400 },
  { label: '180d', seconds: 180 * 86400 },
  { label: '365d', seconds: 365 * 86400 },
];

// How long a signed offer stays takeable. The book takes 30 days at most.
const OPEN_PRESETS = [
  { label: '1d', seconds: 1 * 86400 },
  { label: '3d', seconds: 3 * 86400 },
  { label: '7d', seconds: 7 * 86400 },
  { label: '14d', seconds: 14 * 86400 },
  { label: '30d', seconds: 30 * 86400 },
];

const TABS = ['Lend', 'Borrow', 'My Loans'] as const;
type Tab = (typeof TABS)[number];

/* ─── Main Component ────────────────────────────────────────────── */
export function NFTLendingSection() {
  void useAccount(); // keep wagmi context alive
  const [activeTab, setActiveTab] = useState<Tab>('Lend');
  // Explicit <Tab>: inference widens T under the test project's `strictFunctionTypes: false`.
  const tabKeys = useTabListKeys<Tab>(TABS, activeTab, setActiveTab);

  const book = useBookOffers({ enabled: LENDING_LIVE });
  const { data: loansIssued } = useReadContract({
    address: GONDI_LOAN_ADDRESS,
    abi: GONDI_LOAN_ABI,
    functionName: 'getTotalLoansIssued',
    chainId: CHAIN_ID,
    query: { enabled: LENDING_LIVE },
  });
  const { data: protocolFee, isLoading: protocolFeeLoading } = useReadContract({
    address: GONDI_LOAN_ADDRESS,
    abi: GONDI_LOAN_ABI,
    functionName: 'getProtocolFee',
    chainId: CHAIN_ID,
    query: { enabled: LENDING_LIVE },
  });

  // OUTAGE-AS-ZERO: a failed read is not a 0% fee. No read, no number: null, and the tile
  // says so. The fee is the venue's cut of a lender's interest, so it prices every offer.
  const feeBps = protocolFee && typeof protocolFee.fraction === 'bigint' ? Number(protocolFee.fraction) : null;
  const feeUnread = LENDING_LIVE && !protocolFeeLoading && feeBps === null;
  const offerCount = book.data ? book.data.count : null;

  return (
    <div className="space-y-6">
      <m.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ease: EASE }}>
        <h2 className="heading-luxury text-xl md:text-2xl text-white mb-2">NFT Lending</h2>
        <p className="text-white/70 text-[13px]">Borrow WETH against your NFT, or lend WETH and earn the interest.</p>
      </m.div>

      {!LENDING_LIVE && (
        <div className="relative isolate rounded-xl p-4" style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}>
          <CardArt pageId="nft-finance" idx={17} />
          <p className="text-white text-[13px] font-semibold" style={LABEL_STYLE}>
            Opening soon on Gondi&apos;s lending contracts.
          </p>
          <FinePrint summary="Why">
            <p>
              Loans here will run on Gondi&apos;s own v3.2 contracts, unchanged. Gondi&apos;s v3 contracts have opened over
              70,000 loans (refinances included). Offers open once they are deployed.
            </p>
          </FinePrint>
        </div>
      )}

      {/* Stats: two across on a phone so the tabs sit within one scroll of the top. */}
      <m.div className="grid grid-cols-2 lg:grid-cols-4 gap-3" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ease: EASE, delay: 0.03 }}>
        {[
          {
            label: 'Open Offers',
            value: !LENDING_LIVE ? '–' : offerCount !== null ? offerCount.toString() : book.isError ? 'Unavailable' : '–',
            tooltip: book.isError ? 'The offer book could not be read, so no count is shown.' : 'Signed offers waiting for a borrower',
            art: pageArt('nft-lending', 0),
          },
          {
            label: 'Loans Made',
            value: typeof loansIssued === 'bigint' ? loansIssued.toString() : '–',
            tooltip: 'Every loan the contract has opened, refinances included',
            art: pageArt('nft-lending', 1),
          },
          {
            label: 'Venue Fee',
            value: feeBps !== null ? `${bpsToPercent(feeBps)}%` : feeUnread ? 'Unavailable' : '–',
            tooltip:
              feeBps !== null
                ? 'The venue keeps this share of the interest a lender earns. The lender keeps the rest.'
                : 'The fee could not be read from the loan contract, so none is shown. It is unknown right now, not zero.',
            art: pageArt('nft-lending', 2),
          },
          {
            label: 'Collections',
            value: COLLECTIONS.length.toString(),
            tooltip: `Supported collections: ${COLLECTIONS.map((c) => c.symbol).join(', ')}`,
            art: pageArt('nft-lending', 3),
          },
        ].map((s) => (
          <div key={s.label} className="relative overflow-hidden rounded-xl" style={{ border: `1px solid ${CARD_BORDER}` }}>
            <img src={s.art.src} {...artImgProps(s.art.src)} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" style={artStyle(s.art)} />
            <div
              className="relative z-10 m-2 rounded-lg p-3 md:p-4"
              style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', border: '1px solid rgba(255,255,255,0.08)' }}
            >
              <p className="text-white/90 text-[11px] uppercase tracking-wider mb-1 flex items-center gap-1" style={LABEL_STYLE}>
                {s.label}
                <InfoTooltip text={s.tooltip} />
              </p>
              <p className="text-white text-xl font-semibold" style={LABEL_STYLE}>
                {s.value}
              </p>
            </div>
          </div>
        ))}
      </m.div>

      {/* Tabs: a solid black box so the labels stay readable over the art. */}
      <m.div
        role="tablist"
        aria-label="NFT lending sections"
        onKeyDown={tabKeys.onKeyDown}
        className="flex gap-1 rounded-xl p-1"
        style={{ background: 'rgba(0, 0, 0, 0.85)', border: `1px solid ${CARD_BORDER}` }}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ease: EASE, delay: 0.05 }}
      >
        {TABS.map((tab) => (
          <button
            key={tab}
            role="tab"
            aria-selected={activeTab === tab}
            tabIndex={tabKeys.tabIndex(tab)}
            ref={tabKeys.ref(tab)}
            onClick={() => setActiveTab(tab)}
            className={`relative flex-1 min-h-[44px] rounded-lg text-[13px] font-medium transition-colors ${
              activeTab === tab ? 'text-white' : 'text-white/70 hover:text-white/70'
            }`}
          >
            {activeTab === tab && (
              <m.div
                layoutId="lending-tab-indicator"
                className="absolute inset-0 rounded-lg"
                style={{ background: 'var(--color-stan)', boxShadow: '0 4px 12px var(--color-stan-40)' }}
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              />
            )}
            <span className="relative z-10">{tab}</span>
          </button>
        ))}
      </m.div>

      <AnimatePresence mode="wait">
        {activeTab === 'Lend' && (
          <m.div key="lend" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ ease: EASE }}>
            <LendTab feeBps={feeBps} />
          </m.div>
        )}
        {activeTab === 'Borrow' && (
          <m.div key="borrow" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ ease: EASE }}>
            <BorrowTab />
          </m.div>
        )}
        {activeTab === 'My Loans' && (
          <m.div key="myloans" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ ease: EASE }}>
            <MyLoansTab />
          </m.div>
        )}
      </AnimatePresence>

      {/* How it works, one press away; the visible line is the risk line. */}
      <div className="space-y-1">
        <p className="text-white/80 text-[13px]" style={LABEL_STYLE}>
          Lock NFT, get WETH. Repay on time or the lender keeps it.
        </p>
        <FinePrint summary="How it works" testId="nft-lending-how">
          <HowItWorks
            storageKey="tegridy-nft-lending-how"
            title="How does NFT Lending work?"
            steps={[
              { label: 'Sign an Offer', description: 'A lender picks a collection, an amount, an APR and a length, and signs. No gas, and the WETH stays in their wallet.' },
              { label: 'Lock NFT', description: 'A borrower who holds one locks it and receives the WETH from the lender in the same transaction.' },
              { label: 'Repay Loan', description: 'The borrower repays the amount plus interest for the days used, and gets the NFT back.' },
              { label: 'Default', description: 'Unpaid at the deadline, the lender takes the NFT. No oracles, no price liquidations.' },
            ]}
          />
        </FinePrint>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   LEND TAB
   ═══════════════════════════════════════════════════════════════════ */
function LendTab({ feeBps }: { feeBps: number | null }) {
  const { address, isConnected } = useAccount();
  // A disabled "Connect Wallet" button dispatches no click; it opens the modal instead.
  const openConnectModal = useSafeConnectModal();
  const chainId = useChainId();
  const refreshBook = useRefreshBook();
  const [selectedCollection, setSelectedCollection] = useState<Address>(COLLECTIONS[0]!.address);
  // Default: any NFT in the collection (owner, 2026-10-27). One specific NFT stays an option.
  const [anyToken, setAnyToken] = useState(true);
  const [tokenId, setTokenId] = useState('');
  const [principal, setPrincipal] = useState('');
  const [aprBps, setAprBps] = useState('');
  const [duration, setDuration] = useState(DURATION_PRESETS[2]!.seconds); // 30d
  const [openFor, setOpenFor] = useState(OPEN_PRESETS[2]!.seconds); // 7d
  const [loanCount, setLoanCount] = useState('1');
  const [signing, setSigning] = useState(false);
  const selectedSymbol = collectionSymbol(selectedCollection);

  const principalWei = parseAmount(principal);
  const aprValue = /^\d{1,6}$/.test(aprBps) ? BigInt(aprBps) : null;
  const loansN = /^\d{1,3}$/.test(loanCount) && Number(loanCount) >= 1 && Number(loanCount) <= 100 ? BigInt(loanCount) : null;
  const needed = principalWei !== null && loansN !== null ? principalWei * loansN : null;

  const { data: wethBalance, refetch: refetchWeth } = useReadContract({
    address: WETH_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address ?? ZERO_ADDRESS],
    chainId: CHAIN_ID,
    query: { enabled: !!address },
  });
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: WETH_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [address ?? ZERO_ADDRESS, GONDI_LOAN_ADDRESS],
    chainId: CHAIN_ID,
    query: { enabled: !!address && LENDING_LIVE },
  });
  const { data: ethBalance } = useBalance({ address, chainId: CHAIN_ID, query: { enabled: !!address } });

  const wethShort = needed !== null && typeof wethBalance === 'bigint' ? (wethBalance < needed ? needed - wethBalance : 0n) : null;
  const needsApproval = needed !== null && typeof allowance === 'bigint' ? allowance < needed : null;
  // 0 wrap, 1 approve, 2 sign. Unknown balances keep it at the first step: never skip a
  // step on a read that did not come back.
  const step = wethShort === null || needsApproval === null ? 0 : wethShort > 0n ? 0 : needsApproval ? 1 : 2;

  const { writeContract: wrap, data: wrapTx, isPending: wrapping, reset: resetWrap } = useWriteContract();
  const wrapQuery = useWaitForTransactionReceipt({ hash: wrapTx, onReplaced: noteReplacement });
  const { isSuccess: wrapOk, isReverted: wrapReverted } = useReceiptOutcome(wrapQuery, {
    hash: wrapTx,
    chainId: CHAIN_ID,
    repeatCost: 'wrapping again turns more of your ETH into WETH, which you can unwrap.',
  });
  const { writeContract: approve, data: approveTx, isPending: approving, reset: resetApprove } = useWriteContract();
  const approveQuery = useWaitForTransactionReceipt({ hash: approveTx, onReplaced: noteReplacement });
  const { isSuccess: approveOk, isReverted: approveReverted } = useReceiptOutcome(approveQuery, {
    hash: approveTx,
    chainId: CHAIN_ID,
    repeatCost: 'a second approval only costs gas.',
  });
  const { signTypedDataAsync } = useSignTypedData();

  useEffect(() => {
    if (wrapOk) {
      toast.success('ETH wrapped to WETH.');
      void refetchWeth();
      resetWrap();
    }
  }, [wrapOk, refetchWeth, resetWrap]);
  useEffect(() => {
    if (wrapReverted) toast.error('Wrapping reverted on-chain. No ETH moved.');
  }, [wrapReverted]);
  useEffect(() => {
    if (approveOk) {
      toast.success('WETH approved. Now sign the offer.');
      void refetchAllowance();
      resetApprove();
    }
  }, [approveOk, refetchAllowance, resetApprove]);
  useEffect(() => {
    if (approveReverted) toast.error('Approval reverted on-chain. Nothing was approved.');
  }, [approveReverted]);

  const busy = wrapping || wrapQuery.isLoading || approving || approveQuery.isLoading || signing;

  const preflight = (): boolean => {
    // Wrong chain: the loan contract only exists on Ethereum mainnet.
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return false; }
    if (!LENDING_LIVE) { toast.error('NFT lending is not live yet'); return false; }
    if (principalWei === null) { toast.error('Enter a valid loan amount'); return false; }
    if (aprValue === null || aprValue === 0n) { toast.error('Enter a valid APR in basis points'); return false; }
    if (loansN === null) { toast.error('Loans this offer can fund: 1 to 100'); return false; }
    return true;
  };

  const handleWrap = () => {
    if (!preflight() || wethShort === null || wethShort === 0n) return;
    if (ethBalance && ethBalance.value < wethShort) {
      toast.error(`You need ${fmtWeth(wethShort)} more ETH to wrap.`);
      return;
    }
    wrap(
      { chainId: CHAIN_ID, address: WETH_ADDRESS, abi: WETH_DEPOSIT_ABI, functionName: 'deposit', value: wethShort },
      { onError: (err) => surfaceTxError(err, toast, { component: 'NFTLendingSection.wrap' }) },
    );
  };

  const handleApprove = () => {
    if (!preflight() || needed === null) return;
    approve(
      { chainId: CHAIN_ID, address: WETH_ADDRESS, abi: ERC20_ABI, functionName: 'approve', args: [GONDI_LOAN_ADDRESS, needed] },
      { onError: (err) => surfaceTxError(err, toast, { component: 'NFTLendingSection.approveWeth' }) },
    );
  };

  const handleSign = async () => {
    if (!preflight() || !address || principalWei === null || aprValue === null || loansN === null) return;
    let token = 0n;
    if (!anyToken) {
      const parsed = parseTokenId(tokenId);
      if (parsed === null) { toast.error('Enter the token ID, a whole number'); return; }
      if (parsed === 0n) { toast.error('Token #0 can only be lent against with "Any NFT in the collection".'); return; }
      token = parsed;
    }
    const now = nowSeconds();
    const offer: LoanOfferJson = {
      offerId: newOfferId().toString(),
      lender: address,
      fee: '0',
      capacity: loansN === 1n ? '0' : (principalWei * loansN).toString(),
      nftCollateralAddress: selectedCollection,
      nftCollateralTokenId: token.toString(),
      principalAddress: WETH_ADDRESS,
      principalAmount: principalWei.toString(),
      aprBps: aprValue.toString(),
      expirationTime: (now + BigInt(openFor)).toString(),
      duration: String(duration),
      maxSeniorRepayment: '0',
      validators: anyToken ? wholeCollectionValidators() : [],
      lenderRefinanceDisabled: false,
      borrower: ZERO_ADDRESS,
    };
    const checked = validateOfferShape(offer, now);
    if (!checked.ok) { toast.error(checked.error); return; }
    setSigning(true);
    try {
      const signature = await signTypedDataAsync({
        domain: gondiDomain(GONDI_LOAN_ADDRESS, CHAIN_ID),
        types: LOAN_OFFER_TYPES as unknown as Record<string, { name: string; type: string }[]>,
        primaryType: 'LoanOffer',
        message: offerToMessage(checked.offer) as unknown as Record<string, unknown>,
      });
      await postOffer(checked.offer, signature);
      toast.success('Offer posted. Your WETH stays in your wallet until a borrower takes it.');
      setPrincipal('');
      setAprBps('');
      setTokenId('');
      setLoanCount('1');
      refreshBook();
    } catch (err) {
      surfaceTxError(err, toast, { component: 'NFTLendingSection.signOffer' });
    } finally {
      setSigning(false);
    }
  };

  const interestPerLoan = principalWei !== null && aprValue !== null ? interestFor(principalWei, aprValue, BigInt(duration)) : null;
  const venueCut = interestPerLoan !== null && feeBps !== null ? (interestPerLoan * BigInt(feeBps) + 9_999n) / 10_000n : null;

  const primary = !isConnected
    ? { label: 'Connect Wallet', onClick: openConnectModal ?? (() => {}) }
    : step === 0 && wethShort !== null && wethShort > 0n
    ? { label: wrapping ? 'Confirm in Wallet...' : wrapQuery.isLoading ? 'Wrapping...' : `Wrap ${fmtWeth(wethShort)} ETH to WETH`, onClick: handleWrap }
    : step === 1
    ? { label: approving ? 'Confirm in Wallet...' : approveQuery.isLoading ? 'Approving...' : `Approve ${needed !== null ? fmtWeth(needed) : ''} WETH`, onClick: handleApprove }
    : { label: signing ? 'Sign in Wallet...' : 'Sign Offer (no gas)', onClick: () => void handleSign() };
  const primaryDisabled = isConnected ? busy || (step < 2 && (wethShort === null || needsApproval === null)) : !openConnectModal;

  return (
    <div className="space-y-5">
      <div>
        <label className="text-white/90 text-[11px] uppercase tracking-wider mb-2 block" style={LABEL_STYLE}>Collection</label>
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          {COLLECTIONS.map((c) => (
            <button
              key={c.address}
              onClick={() => setSelectedCollection(c.address)}
              className={`relative overflow-hidden aspect-square rounded-xl text-left transition-all ${
                selectedCollection === c.address ? 'border-2 border-emerald-500/70 text-white' : 'border border-white/10 text-white hover:border-white/25'
              }`}
            >
              <img src={COLLECTION_ART[c.symbol]} {...artImgProps(COLLECTION_ART[c.symbol])} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
              <div className="absolute inset-0 p-2 sm:p-3 flex flex-col justify-end items-start">
                <span className="inline-block text-[11px] sm:text-[15px] font-semibold px-2 py-0.5 rounded" style={{ color: '#22c55e', background: 'rgba(0,0,0,0.85)', textShadow: '0 1px 4px rgba(0,0,0,0.95)' }}>
                  {c.name}
                </span>
                <span className="inline-block text-[9px] sm:text-[11px] font-mono px-2 py-0.5 mt-0.5 rounded" style={{ color: '#22c55e', background: 'rgba(0,0,0,0.85)', textShadow: '0 1px 4px rgba(0,0,0,0.95)' }}>
                  {c.symbol}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Lend against: any NFT in the collection (default) or one specific NFT. */}
      <div>
        <label className="text-white/90 text-[11px] uppercase tracking-wider mb-2 flex items-center gap-1.5" style={LABEL_STYLE}>
          Lend against
          <InfoTooltip text="Any NFT: anyone holding one from this collection can take the offer and lock the NFT they choose. One specific NFT: only that token can be locked." />
        </label>
        <div className="grid grid-cols-2 gap-2">
          {[
            { any: true, label: 'Any NFT in the collection' },
            { any: false, label: 'One specific NFT' },
          ].map((o) => (
            <button
              key={o.label}
              aria-pressed={anyToken === o.any}
              onClick={() => setAnyToken(o.any)}
              className={`min-h-[44px] px-3 py-2 rounded-xl text-[13px] font-medium transition-all ${
                anyToken === o.any ? 'border border-emerald-500/60 text-emerald-300' : 'border border-white/10 text-white/80 hover:border-white/25'
              }`}
              style={{ background: anyToken === o.any ? SELECTED_BG : CARD_BG }}
            >
              {o.label}
            </button>
          ))}
        </div>
        {anyToken ? (
          <p className="text-white/70 text-[11px] mt-2" style={LABEL_STYLE}>
            Borrowers usually lock their cheapest one, so lend at the floor price.
          </p>
        ) : (
          <input
            type="number"
            step="1"
            min="0"
            inputMode="numeric"
            placeholder="Token ID, e.g. 1234"
            aria-label="Token ID"
            value={tokenId}
            onChange={(e) => setTokenId(e.target.value)}
            className="mt-2 w-full min-h-[44px] rounded-xl px-4 py-2 text-white text-[13px] bg-transparent outline-none focus:ring-1 focus:ring-purple-500/50 placeholder:text-white/85"
            style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
          />
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="text-white/90 text-[11px] uppercase tracking-wider mb-2 block" style={LABEL_STYLE}>Loan amount (WETH)</label>
          <input
            type="number"
            step="0.01"
            min="0"
            placeholder="0.00"
            aria-label="Loan amount (WETH)"
            value={principal}
            onChange={(e) => setPrincipal(e.target.value)}
            className="w-full min-h-[44px] rounded-xl px-4 py-2 text-white text-[13px] bg-transparent outline-none focus:ring-1 focus:ring-purple-500/50 placeholder:text-white/85"
            style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
          />
        </div>
        <div>
          <label className="text-white/90 text-[11px] uppercase tracking-wider mb-2 flex items-center gap-1.5" style={LABEL_STYLE}>
            APR (bps){' '}
            {aprValue !== null && aprValue > 0n && <span className="text-emerald-400 normal-case">({bpsToPercent(Number(aprValue))}%)</span>}
            <InfoTooltip text="Annual rate in basis points: 100 bps = 1%, 1000 bps = 10%. Borrowers pay interest only for the days they borrow." />
          </label>
          <input
            type="number"
            step="1"
            min="0"
            placeholder="e.g. 1000 = 10%"
            aria-label="APR (bps)"
            value={aprBps}
            onChange={(e) => setAprBps(e.target.value)}
            className="w-full min-h-[44px] rounded-xl px-4 py-2 text-white text-[13px] bg-transparent outline-none focus:ring-1 focus:ring-purple-500/50 placeholder:text-white/85"
            style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
          />
        </div>
      </div>

      <PresetRow label="Loan length" presets={DURATION_PRESETS} value={duration} onChange={setDuration} />
      <PresetRow
        label="Offer open for"
        tooltip="How long borrowers can take this offer. Cancel it any time from My Loans."
        presets={OPEN_PRESETS}
        value={openFor}
        onChange={setOpenFor}
      />

      <div>
        <label className="text-white/90 text-[11px] uppercase tracking-wider mb-2 flex items-center gap-1.5" style={LABEL_STYLE}>
          Loans this offer can fund
          <InfoTooltip text="Each loan uses the full amount. With 3, up to three borrowers can each take one. Your wallet needs WETH for all of them while the offer is open." />
        </label>
        <input
          type="number"
          step="1"
          min="1"
          max="100"
          aria-label="Loans this offer can fund"
          value={loanCount}
          onChange={(e) => setLoanCount(e.target.value)}
          className="w-full sm:w-40 min-h-[44px] rounded-xl px-4 py-2 text-white text-[13px] bg-transparent outline-none focus:ring-1 focus:ring-purple-500/50"
          style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
        />
      </div>

      {interestPerLoan !== null && principalWei !== null && (
        <m.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative isolate rounded-xl p-3 md:p-5"
          style={{ background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)' }}
        >
          <CardArt pageId="nft-finance" idx={17} />
          <p className="text-white/85 text-[11px] uppercase tracking-wider mb-1">Interest a loan earns, repaid at term</p>
          <p className="text-emerald-400 text-xl font-semibold">
            {venueCut !== null ? fmtWeth(interestPerLoan - venueCut, 6) : fmtWeth(interestPerLoan, 6)} WETH
          </p>
          <p className="text-white/70 text-[11px] mt-1">
            {fmtWeth(principalWei)} WETH at {bpsToPercent(Number(aprValue))}% APR for {formatDuration(duration)}
            {venueCut !== null && feeBps !== null ? `, after the venue's ${bpsToPercent(feeBps)}% of the interest` : ''}
          </p>
        </m.div>
      )}

      {needed !== null && (
        <TxSummary art={<CardArt pageId="nft-finance" idx={25} />}>
          You offer <span className="font-mono text-white font-semibold">{fmtWeth(principalWei!)} WETH</span>
          {anyToken ? <> to anyone holding a {selectedSymbol}</> : <> to whoever holds {selectedSymbol} #{tokenId || '?'}</>}
          {loansN !== null && loansN > 1n ? <>, up to {loansN.toString()} loans ({fmtWeth(needed)} WETH in all)</> : null}. Your WETH stays in your
          wallet until a borrower takes the offer; then the loan contract sends it to them.
        </TxSummary>
      )}

      {isConnected && needed !== null && <StepIndicator steps={['Wrap ETH', 'Approve WETH', 'Sign Offer']} currentStep={step} />}

      <button
        onClick={primary.onClick}
        disabled={primaryDisabled}
        className="w-full min-h-[44px] rounded-xl text-[13px] font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        style={{
          background: busy ? 'var(--color-purple-15)' : 'linear-gradient(135deg, rgba(16,185,129,0.3), var(--color-purple-30))',
          border: '1px solid var(--color-purple-30)',
          color: 'white',
        }}
      >
        {primary.label}
      </button>
      <FinePrint summary="About signed offers">
        <p>
          The offer is a signature: posting it costs no gas and moves no WETH. It is checked by Gondi&apos;s loan contract
          when a borrower takes it. To withdraw it, cancel it on-chain from My Loans; that is the only cancel that binds.
        </p>
      </FinePrint>
    </div>
  );
}

function PresetRow({
  label,
  tooltip,
  presets,
  value,
  onChange,
}: {
  label: string;
  tooltip?: string;
  presets: { label: string; seconds: number }[];
  value: number;
  onChange: (s: number) => void;
}) {
  return (
    <div>
      <label className="text-white/90 text-[11px] uppercase tracking-wider mb-2 flex items-center gap-1.5" style={LABEL_STYLE}>
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </label>
      <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
        {presets.map((d) => (
          <button
            key={d.seconds}
            aria-pressed={value === d.seconds}
            onClick={() => onChange(d.seconds)}
            className={`min-h-[44px] px-4 py-2 rounded-xl text-[13px] font-medium transition-all ${
              value === d.seconds ? 'border border-emerald-500/60 text-emerald-300' : 'border border-white/5 text-white/70 hover:text-white/70 hover:border-white/15'
            }`}
            style={{ background: value === d.seconds ? SELECTED_BG : CARD_BG }}
          >
            {d.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   BORROW TAB
   ═══════════════════════════════════════════════════════════════════ */
type OfferStatus = 'live' | 'checking' | 'unknown' | 'taken' | 'unfunded';

function BorrowTab() {
  const [filter, setFilter] = useState<string>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const collection = filter === 'all' ? undefined : COLLECTIONS.find((c) => c.symbol === filter)?.address;
  const book = useBookOffers({ collection, enabled: LENDING_LIVE });
  const rows = useMemo(() => book.data?.offers ?? [], [book.data]);

  // Every listed offer is re-read on chain: unused, and backed by WETH the lender still
  // holds and has approved. The book cannot vouch for either.
  const checks = useReadContracts({
    contracts: rows.flatMap((r) => [
      { address: GONDI_LOAN_ADDRESS, abi: GONDI_LOAN_ABI, functionName: 'isOfferCancelled', args: [r.offer.lender, BigInt(r.offer.offerId)], chainId: CHAIN_ID } as const,
      { address: GONDI_LOAN_ADDRESS, abi: GONDI_LOAN_ABI, functionName: 'getUsedCapacity', args: [r.offer.lender, BigInt(r.offer.offerId)], chainId: CHAIN_ID } as const,
      { address: WETH_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [r.offer.lender], chainId: CHAIN_ID } as const,
      { address: WETH_ADDRESS, abi: ERC20_ABI, functionName: 'allowance', args: [r.offer.lender, GONDI_LOAN_ADDRESS], chainId: CHAIN_ID } as const,
    ]),
    query: { enabled: LENDING_LIVE && rows.length > 0, refetchInterval: 30_000 },
  });

  const offers = useMemo(
    () =>
      rows.map((row, i) => {
        const c = checks.data?.slice(i * 4, i * 4 + 4);
        let status: OfferStatus = 'checking';
        if (c && c.length === 4) {
          if (c.some((x) => x.status !== 'success')) status = 'unknown';
          else {
            const [cancelled, used, balance, allowance] = c.map((x) => x.result) as [boolean, bigint, bigint, bigint];
            const principal = BigInt(row.offer.principalAmount);
            const capacity = BigInt(row.offer.capacity);
            if (cancelled || (capacity !== 0n && capacity - used < principal)) status = 'taken';
            else if (balance < principal || allowance < principal) status = 'unfunded';
            else status = 'live';
          }
        } else if (checks.isError) status = 'unknown';
        return { row, status };
      }),
    [rows, checks.data, checks.isError],
  );
  const shown = offers.filter((o) => o.status === 'live' || o.status === 'checking' || o.status === 'unknown');
  const live = shown.filter((o) => o.status === 'live').map((o) => o.row.offer);
  const bestApr = live.length ? Math.min(...live.map((o) => Number(o.aprBps))) : null;
  const largest = live.length ? live.reduce((max, o) => (BigInt(o.principalAmount) > max ? BigInt(o.principalAmount) : max), 0n) : null;

  return (
    <div className="space-y-5">
      {/* Collection filter, the same picker as the Lend tab; "All" uses the gallery collage. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {(['all', ...COLLECTIONS.map((c) => c.symbol)] as const).map((f) => {
          const art = f === 'all' ? ART.galleryCollage.src : COLLECTION_ART[f] ?? ART.galleryCollage.src;
          const col = f === 'all' ? null : COLLECTIONS.find((c) => c.symbol === f) ?? null;
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`relative overflow-hidden aspect-square rounded-xl text-left transition-all ${
                filter === f ? 'border-2 border-emerald-500/70 text-white' : 'border border-white/10 text-white hover:border-white/25'
              }`}
            >
              <img src={art} {...artImgProps(art)} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
              <div className="absolute inset-0 p-3 flex flex-col justify-end items-start">
                <span className="inline-block text-[15px] font-semibold px-2 py-0.5 rounded" style={{ color: '#22c55e', background: 'rgba(0,0,0,0.85)', textShadow: '0 1px 4px rgba(0,0,0,0.95)' }}>
                  {f === 'all' ? 'All Collections' : col?.name ?? f}
                </span>
                <span className="inline-block text-[11px] font-mono px-2 py-0.5 mt-0.5 rounded" style={{ color: '#22c55e', background: 'rgba(0,0,0,0.85)', textShadow: '0 1px 4px rgba(0,0,0,0.95)' }}>
                  {f === 'all' ? 'ALL' : f}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {bestApr !== null && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl px-4 py-2.5" style={{ background: 'rgba(16, 185, 129, 0.06)', border: '1px solid rgba(16, 185, 129, 0.12)' }}>
          <span className="text-[11px] text-white/85 uppercase tracking-wider">Highlights:</span>
          <span className="text-[12px] text-emerald-400 font-medium">Best APR: {bpsToPercent(bestApr)}%</span>
          {largest !== null && <span className="text-[12px] text-blue-400 font-medium">Largest: {fmtWeth(largest, 2)} WETH</span>}
        </div>
      )}

      {book.isLoading ? (
        <div className="text-center py-12 text-white/70 text-[13px]">Loading offers...</div>
      ) : book.isError ? (
        <EmptyCard title="Couldn't load offers." line="The offer book did not answer. Try again in a moment." />
      ) : shown.length === 0 ? (
        <EmptyCard title={`No offers ${filter !== 'all' ? `for ${filter} ` : ''}yet.`} line="Be the first! Switch to the Lend tab to make one." />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {shown.map(({ row, status }) => {
            const key = `${row.offer.lender}:${row.offer.offerId}`;
            return (
              <OfferCard
                key={key}
                row={row}
                status={status}
                isExpanded={expanded === key}
                onToggle={() => setExpanded(expanded === key ? null : key)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function EmptyCard({ title, line }: { title: string; line: string }) {
  return (
    <div className="relative overflow-hidden rounded-xl" style={{ border: `1px solid ${CARD_BORDER}` }}>
      <ArtImg pageId="nft-lending" idx={4} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />
      <div className="relative z-10 m-2 rounded-lg p-6 md:p-8 text-center" style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', border: '1px solid rgba(255,255,255,0.08)' }}>
        <p className="text-[13px]" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{title}</p>
        <p className="text-[11px] mt-1" style={{ color: '#22c55e', opacity: 0.85, textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}>{line}</p>
      </div>
    </div>
  );
}

/* ─── Offer Card ────────────────────────────────────────────────── */
function OfferCard({ row, status, isExpanded, onToggle }: { row: BookOffer; status: OfferStatus; isExpanded: boolean; onToggle: () => void }) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const refreshBook = useRefreshBook();
  const offer = row.offer;
  const symbol = collectionSymbol(offer.nftCollateralAddress);
  const anyToken = isWholeCollectionOffer(offer);
  const principal = BigInt(offer.principalAmount);
  const apr = BigInt(offer.aprBps);
  const duration = BigInt(offer.duration);
  const perOffer = loansPerOffer(offer);

  // The token to lock: the borrower's pick on a whole-collection offer, the lender's on a
  // one-NFT offer.
  const [pickedId, setPickedId] = useState('');
  const pledgedId = anyToken ? parseTokenId(pickedId) : BigInt(offer.nftCollateralTokenId);
  const takesIt = pledgedId !== null && acceptsToken(offer, pledgedId);
  const collateralLabel = pledgedId !== null ? `${symbol} #${pledgedId.toString()}` : `your ${symbol}`;

  const ownerQuery = useReadContract({
    address: offer.nftCollateralAddress,
    abi: ERC721_ABI,
    functionName: 'ownerOf',
    args: [pledgedId ?? 0n],
    chainId: CHAIN_ID,
    query: { enabled: isExpanded && pledgedId !== null && !!address },
  });
  const owner = ownerQuery.data as Address | undefined;
  const ownsPledged = !!address && !!owner && sameAddress(owner, address);
  const knownNotOwned = !!address && !!owner && !ownsPledged;

  const { writeContract: approveNft, data: approveTx, isPending: approving } = useWriteContract();
  const approveQuery = useWaitForTransactionReceipt({ hash: approveTx, onReplaced: noteReplacement });
  const { isSuccess: approveOk, isReverted: approveReverted } = useReceiptOutcome(approveQuery, {
    hash: approveTx,
    chainId: CHAIN_ID,
    repeatCost: 'a second approval only costs gas.',
  });
  const [approvedId, setApprovedId] = useState<bigint | null>(null);
  const approvedForPledged = approveOk && approvedId !== null && approvedId === pledgedId;

  const { writeContract: emitLoan, data: borrowTx, isPending: borrowing } = useWriteContract();
  const borrowQuery = useWaitForTransactionReceipt({ hash: borrowTx, onReplaced: noteReplacement });
  const { isSuccess: borrowOk, isReverted: borrowReverted } = useReceiptOutcome(borrowQuery, {
    hash: borrowTx,
    chainId: CHAIN_ID,
    repeatCost: 'borrowing again opens a second loan if the offer still has room, or reverts.',
  });

  useEffect(() => {
    if (approveOk) toast.success('NFT approved. Now take the loan.');
  }, [approveOk]);
  useEffect(() => {
    if (approveReverted) toast.error('Approval reverted on-chain. The NFT was not approved.');
  }, [approveReverted]);
  useEffect(() => {
    if (borrowReverted) toast.error('The loan reverted on-chain. No loan was opened, your NFT did not move and no WETH was paid out.');
  }, [borrowReverted]);
  useEffect(() => {
    if (!borrowOk || !borrowTx) return;
    toast.success('Loan opened. The WETH is in your wallet.');
    // Record it so My Loans can show it (Gondi stores only the loan's hash), then close
    // the offer in the book if the chain says it is used up.
    recordLoanTx(borrowTx)
      .catch(() => toast.error('Loan opened, but it could not be saved to My Loans. Use "Find a loan" there with the transaction hash.'))
      .finally(() => {
        void syncOffer(offer.lender, offer.offerId).catch(() => undefined);
        refreshBook();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per confirmed tx
  }, [borrowOk, borrowTx]);

  const preflight = (): boolean => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return false; }
    if (!LENDING_LIVE) { toast.error('NFT lending is not live yet'); return false; }
    if (pledgedId === null) { toast.error('Enter the token ID of the NFT you want to lock'); return false; }
    if (!takesIt) { toast.error(`This offer does not take ${collateralLabel}.`); return false; }
    return true;
  };

  const handleApprove = () => {
    if (!preflight()) return;
    setApprovedId(pledgedId);
    approveNft(
      { chainId: CHAIN_ID, address: offer.nftCollateralAddress, abi: ERC721_ABI, functionName: 'approve', args: [GONDI_LOAN_ADDRESS, pledgedId!] },
      { onError: (err) => surfaceTxError(err, toast, { component: 'NFTLendingSection.approveNft' }) },
    );
  };

  const handleBorrow = () => {
    if (!preflight() || !address) return;
    const message = offerToMessage(offer);
    emitLoan(
      {
        chainId: CHAIN_ID,
        address: GONDI_LOAN_ADDRESS,
        abi: GONDI_LOAN_ABI,
        functionName: 'emitLoan',
        args: [
          {
            executionData: {
              offerExecution: [{ offer: message, amount: principal, lenderOfferSignature: row.signature }],
              loanId: 0n,
              nftCollateralAddress: offer.nftCollateralAddress,
              tokenId: pledgedId!,
              duration,
              // The borrower's own deadline for this call (Gondi's ExecutionData.expirationTime).
              expirationTime: nowSeconds() + 900n,
              principalReceiver: address,
              callbackData: '0x' as Hex,
            },
            borrower: address,
            borrowerOfferSignature: '0x' as Hex,
          },
        ],
      },
      { onError: (err) => surfaceTxError(err, toast, { component: 'NFTLendingSection.emitLoan' }) },
    );
  };

  const atTerm = principal + interestFor(principal, apr, duration);
  const blocked = status !== 'live';

  return (
    <div
      className="relative isolate rounded-xl overflow-hidden cursor-pointer transition-all hover:border-purple-500/25"
      style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
      onClick={onToggle}
    >
      <CardArt pageId="nft-finance" idx={18} />
      <div className="p-3 md:p-5 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-white/70 text-[11px] font-mono truncate">{perOffer > 1n ? `Up to ${perOffer.toString()} loans` : 'One loan'}</span>
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 whitespace-nowrap">
            {anyToken ? `${symbol} · any NFT` : `${symbol} #${offer.nftCollateralTokenId}`}
          </span>
        </div>
        <div>
          <p className="text-white text-xl font-semibold">{fmtWeth(principal)} WETH</p>
          <p className="text-white/70 text-[11px]">Loan amount</p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <p className="text-emerald-400 text-[13px] font-medium">{bpsToPercent(Number(apr))}%</p>
            <p className="text-white/70 text-[11px]">APR</p>
          </div>
          <div>
            <p className="text-purple-400 text-[13px] font-medium">{formatDuration(Number(duration))}</p>
            <p className="text-white/70 text-[11px]">Length</p>
          </div>
          <div className="truncate">
            <p className="text-white/80 text-[13px] font-mono truncate">{shortenAddress(offer.lender)}</p>
            <p className="text-white/70 text-[11px]">Lender</p>
          </div>
        </div>
        {status === 'checking' && <p className="text-white/70 text-[11px]">Checking this offer on chain...</p>}
        {status === 'unknown' && <p className="text-yellow-300 text-[11px]">Couldn&apos;t check this offer on chain right now. Try again in a moment.</p>}
      </div>

      <AnimatePresence>
        {isExpanded && (
          <m.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ ease: EASE }}
            className="overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-3 pb-3 md:px-5 md:pb-5 space-y-3 border-t border-white/5 pt-3">
              {anyToken ? (
                <div>
                  <label className="text-white/85 text-[11px] uppercase tracking-wider flex items-center gap-1.5 mb-1.5" style={LABEL_STYLE}>
                    Your {symbol} to lock
                    <InfoTooltip text="This offer takes any NFT from the collection. Enter the token ID of the one you want to lock." />
                  </label>
                  <input
                    type="number"
                    step="1"
                    min="0"
                    inputMode="numeric"
                    placeholder="Token ID, e.g. 1234"
                    aria-label={`Your ${symbol} to lock`}
                    value={pickedId}
                    onChange={(e) => setPickedId(e.target.value)}
                    className="w-full min-h-[44px] rounded-xl px-4 py-2 text-white text-[13px] bg-transparent outline-none focus:ring-1 focus:ring-purple-500/50 placeholder:text-white/85"
                    style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
                  />
                </div>
              ) : (
                <div className="rounded-xl p-3 flex items-center justify-between gap-3" style={{ background: 'rgba(13,21,48,0.8)', border: `1px solid ${CARD_BORDER}` }}>
                  <div>
                    <p className="text-white/85 text-[11px] uppercase tracking-wider" style={LABEL_STYLE}>Required NFT</p>
                    <p className="text-white text-[15px] font-semibold font-mono mt-0.5">{collateralLabel}</p>
                  </div>
                  <span className="text-[10px] px-2 py-1 rounded-full bg-purple-500/15 text-purple-300 border border-purple-500/30 whitespace-nowrap">Fixed by lender</span>
                </div>
              )}

              {pledgedId !== null && (
                <p className={`text-[11px] ${knownNotOwned ? 'text-red-300' : ownsPledged ? 'text-emerald-300' : 'text-white/70'}`}>
                  {!isConnected
                    ? `Connect a wallet to check you own ${collateralLabel}.`
                    : ownerQuery.isLoading
                    ? `Checking who owns ${collateralLabel}...`
                    : ownsPledged
                    ? `You own ${collateralLabel}.`
                    : knownNotOwned
                    ? `${collateralLabel} is not in your wallet.`
                    : `Couldn't find ${collateralLabel}. Check the token ID.`}
                </p>
              )}

              <TxSummary>
                You lock <span className="font-mono text-white font-semibold">{collateralLabel}</span> and receive{' '}
                <span className="font-mono text-white font-semibold">{fmtWeth(principal)} WETH</span>. Repaid at the end it costs{' '}
                <span className="font-mono text-emerald-400 font-semibold">{fmtWeth(atTerm, 6)} WETH</span>
                <span className="block text-[11px] text-white/70 mt-1">Repay early to pay less: interest counts only the days you borrow.</span>
              </TxSummary>

              <RiskBanner variant="warning">
                <span className="font-semibold">Miss the deadline and the lender keeps {collateralLabel} for good.</span>
                <FinePrint summary="Details">
                  <p>
                    {collateralLabel} is locked in Gondi&apos;s loan contract for up to {formatDuration(Number(duration))}. If it is not
                    repaid by then, the lender can take it, permanently.
                  </p>
                </FinePrint>
              </RiskBanner>

              <StepIndicator steps={['Approve NFT', 'Take Loan']} currentStep={approvedForPledged ? 1 : 0} />

              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={handleApprove}
                  disabled={!isConnected || blocked || approving || approveQuery.isLoading || approvedForPledged || pledgedId === null || knownNotOwned}
                  className="min-h-[44px] rounded-xl text-[13px] font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed text-white"
                  style={{ background: approvedForPledged ? 'rgba(16,185,129,0.15)' : 'var(--color-purple-20)', border: `1px solid ${approvedForPledged ? 'rgba(16,185,129,0.3)' : 'var(--color-purple-30)'}` }}
                >
                  {approvedForPledged ? 'Approved' : approving ? 'Confirm...' : approveQuery.isLoading ? 'Approving...' : 'Approve NFT'}
                </button>
                <button
                  onClick={handleBorrow}
                  disabled={!isConnected || blocked || borrowing || borrowQuery.isLoading || pledgedId === null || knownNotOwned}
                  className="min-h-[44px] rounded-xl text-[13px] font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed text-white"
                  style={{ background: 'linear-gradient(135deg, rgba(16,185,129,0.25), var(--color-purple-25))', border: '1px solid rgba(16,185,129,0.3)' }}
                >
                  {borrowing ? 'Confirm...' : borrowQuery.isLoading ? 'Opening loan...' : 'Take Loan'}
                </button>
              </div>
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}
