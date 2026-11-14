// Borrower requests: the other way into a loan. A borrower names an NFT they hold and the
// terms they want (AskForLoan, Borrow tab); lenders see it and answer with an ordinary offer
// on that one NFT (BorrowerRequests, Lend tab), which the borrower then takes from the
// Borrow tab as usual.
//
// How money moves: a request moves none. It is a free signature under its own domain that no
// contract reads (lib/gondi/loanRequest.js). Lenders earn interest and the venue its share of
// that interest only if a loan follows, exactly as for any other offer.
import { useEffect, useId, useRef, useState } from 'react';
import { useAccount, useChainId, useReadContract, useReadContracts, useSignTypedData } from 'wagmi';
import type { Address } from 'viem';
import { toast } from 'sonner';
import { CHAIN_ID } from '../../lib/constants';
import { ERC721_ABI } from '../../lib/contracts';
import { sameAddress, type LoanOfferJson } from '../../lib/gondi/loanOffer.js';
import {
  CANCEL_REQUEST_TYPES,
  LOAN_REQUEST_TYPES,
  offerAnswersRequest,
  requestDomain,
  requestToMessage,
  validateRequestShape,
  type LoanRequestJson,
} from '../../lib/gondi/loanRequest.js';
import { interestFor } from '../../lib/gondi/loanMath';
import { cancelRequest, postRequest, syncRequest, useBookRequests, useRefreshRequests, useRequestBookOpen } from '../../lib/gondi/requestBook';
import { useWalletCollectionNfts } from '../../lib/gondi/walletNfts';
import { useSafeConnectModal } from '../../hooks/useSafeConnectModal';
import { surfaceTxError } from '../../lib/txErrors';
import { CardArt } from '../ui/CardArt';
import { FinePrint } from '../ui/FinePrint';
import { BoxHint, PresetRow } from './nftLendingBits';
import {
  CARD_BG,
  CARD_BORDER,
  COLLECTIONS,
  DURATION_PRESETS,
  FADED,
  LABEL_STYLE,
  LENDING_LIVE,
  SELECTED_BG,
  bpsToPercent,
  collectionSymbol,
  fmtWeth,
  formatDue,
  formatDuration,
  newOfferId,
  nowSeconds,
  parseAmount,
  parseAprPercent,
  parseTokenId,
  shortenAddress,
} from './nftLendingShared';

// How long a request stays listed. The book takes 30 days at most.
const ASK_OPEN_PRESETS = [
  { label: '1d', seconds: 1 * 86400 },
  { label: '3d', seconds: 3 * 86400 },
  { label: '7d', seconds: 7 * 86400 },
];

const TYPES = (t: unknown) => t as Record<string, { name: string; type: string }[]>;
const INPUT =
  'w-full min-h-[44px] rounded-xl px-4 py-2 text-white text-[13px] bg-transparent outline-none focus:ring-1 focus:ring-purple-500/50 placeholder:text-white/85';
const ROW_BG = 'rgba(13,21,48,0.8)';

function termsLine(r: LoanRequestJson): string {
  return `${fmtWeth(BigInt(r.principalAmount))} WETH · up to ${bpsToPercent(Number(r.maxAprBps))}% APR · ${formatDuration(Number(r.duration))}`;
}

function nftName(r: LoanRequestJson): string {
  return `${collectionSymbol(r.nftCollateralAddress)} #${r.nftCollateralTokenId}`;
}

/* ─── Borrow tab: ask lenders for a loan ────────────────────────── */
// `liveOffers` are the offers the Borrow tab lists above this card, each read on chain as
// takeable now, so "an offer matches" always points at one the borrower can see and take.
// Nothing renders until the book says it takes requests (lib/gondi/requestBook.ts).
export function AskForLoan({ filterCollection, liveOffers }: { filterCollection?: Address; liveOffers: readonly LoanOfferJson[] }) {
  const { address, isConnected } = useAccount();
  const bookOpen = useRequestBookOpen(LENDING_LIVE);
  const openConnectModal = useSafeConnectModal();
  const chainId = useChainId();
  const refresh = useRefreshRequests();
  const hint = useId();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Address>(COLLECTIONS[0]!.address);
  const collection = filterCollection ?? picked;
  const symbol = collectionSymbol(collection);
  const [tokenId, setTokenId] = useState('');
  const [principal, setPrincipal] = useState('');
  const [aprPct, setAprPct] = useState('');
  const [duration, setDuration] = useState(DURATION_PRESETS[2]!.seconds); // 30d
  const [openFor, setOpenFor] = useState(ASK_OPEN_PRESETS[1]!.seconds); // 3d
  const [busy, setBusy] = useState(false);
  const { signTypedDataAsync } = useSignTypedData();

  const token = parseTokenId(tokenId);
  const principalWei = parseAmount(principal);
  const aprValue = parseAprPercent(aprPct);
  const typedBad = {
    token: tokenId.trim() !== '' && !((token ?? 0n) > 0n),
    amount: principal.trim() !== '' && principalWei === null,
    apr: aprPct.trim() !== '' && aprValue === null,
  };

  const owned = useWalletCollectionNfts(address, collection, open && LENDING_LIVE);
  const ownerQuery = useReadContract({
    address: collection,
    abi: ERC721_ABI,
    functionName: 'ownerOf',
    args: [token ?? 0n],
    chainId: CHAIN_ID,
    query: { enabled: open && token !== null && token > 0n && !!address },
  });
  const owner = ownerQuery.data as Address | undefined;
  const ownsIt = !!address && !!owner && sameAddress(owner, address);
  const knownNotOwned = !!address && !!owner && !ownsIt;

  const mine = useBookRequests({ borrower: address, enabled: LENDING_LIVE && bookOpen && !!address });
  // With one collection picked above, only its requests: the offers listed are that collection's.
  const myRequests = (mine.data?.requests ?? []).filter(
    ({ request: r }) => !filterCollection || sameAddress(r.nftCollateralAddress, filterCollection),
  );

  const formReady = token !== null && token > 0n && principalWei !== null && aprValue !== null;
  const atMost = principalWei !== null && aprValue !== null ? principalWei + interestFor(principalWei, aprValue, BigInt(duration)) : null;

  const onChain = (): boolean => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return false; }
    if (!LENDING_LIVE) { toast.error('NFT lending is not live yet'); return false; }
    return true;
  };

  const handleAsk = async () => {
    if (!onChain() || !address || token === null || principalWei === null || aprValue === null) return;
    const now = nowSeconds();
    const request: LoanRequestJson = {
      borrower: address,
      nftCollateralAddress: collection,
      nftCollateralTokenId: token.toString(),
      principalAmount: principalWei.toString(),
      maxAprBps: aprValue.toString(),
      duration: String(duration),
      expirationTime: (now + BigInt(openFor)).toString(),
      nonce: newOfferId().toString(),
    };
    const checked = validateRequestShape(request, now);
    if (!checked.ok) { toast.error(checked.error); return; }
    setBusy(true);
    try {
      const signature = await signTypedDataAsync({
        domain: requestDomain(CHAIN_ID),
        types: TYPES(LOAN_REQUEST_TYPES),
        primaryType: 'LoanRequest',
        message: requestToMessage(checked.request) as unknown as Record<string, unknown>,
      });
      await postRequest(checked.request, signature);
      toast.success('Request posted. Lenders see it on the Lend tab; offers for it show up here.');
      setTokenId('');
      setPrincipal('');
      setAprPct('');
      refresh();
    } catch (err) {
      surfaceTxError(err, toast, { component: 'LoanRequests.ask' });
    } finally {
      setBusy(false);
    }
  };

  const handleWithdraw = async (r: LoanRequestJson) => {
    if (!onChain() || !address) return;
    setBusy(true);
    try {
      const signature = await signTypedDataAsync({
        domain: requestDomain(CHAIN_ID),
        types: TYPES(CANCEL_REQUEST_TYPES),
        primaryType: 'CancelLoanRequest',
        message: { borrower: address, nonce: BigInt(r.nonce) },
      });
      await cancelRequest(address, r.nonce, signature);
      toast.success('Request withdrawn.');
      refresh();
    } catch (err) {
      surfaceTxError(err, toast, { component: 'LoanRequests.withdraw' });
    } finally {
      setBusy(false);
    }
  };

  const askDisabled = isConnected ? busy || !formReady || !ownsIt : !openConnectModal;

  if (!bookOpen) return null;

  return (
    <div
      className="relative isolate rounded-xl p-3 md:p-5 space-y-4"
      style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
      data-testid="ask-for-loan"
    >
      <CardArt pageId="nft-finance" idx={28} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-white text-[15px] font-semibold" style={LABEL_STYLE}>Ask for a loan</p>
          <p className="text-white/80 text-[12px]" style={LABEL_STYLE}>Name your terms. Lenders answer with offers.</p>
        </div>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="btn-primary min-h-[44px] px-4 rounded-xl text-[13px]">
          {open ? 'Close' : 'Ask lenders'}
        </button>
      </div>

      {myRequests.length > 0 && (
        <ul className="space-y-2" aria-label="Your requests">
          {myRequests.map(({ request: r }) => {
            const answers = liveOffers.filter((o) => offerAnswersRequest(o, r)).length;
            return (
              <li
                key={r.nonce}
                className="rounded-xl p-3 flex flex-wrap items-center justify-between gap-2"
                style={{ background: ROW_BG, border: `1px solid ${CARD_BORDER}` }}
              >
                <div>
                  <p className="text-white text-[13px] font-semibold font-mono">{nftName(r)}</p>
                  <p className="text-white/80 text-[12px]">{termsLine(r)}</p>
                  <p className={`text-[11px] ${answers > 0 ? 'text-emerald-300' : 'text-white/70'}`}>
                    {answers > 0
                      ? `${answers} ${answers === 1 ? 'offer matches' : 'offers match'}. Look in the list above.`
                      : `Waiting for a lender. Listed until ${formatDue(BigInt(r.expirationTime))}.`}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Withdraw the request on ${nftName(r)}`}
                  onClick={() => void handleWithdraw(r)}
                  className="min-h-[44px] px-4 rounded-xl text-[13px] border border-white/20 text-white/90 hover:border-white/40 disabled:cursor-not-allowed"
                  style={busy ? FADED : undefined}
                >
                  Withdraw
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {open && (
        <div className="space-y-4">
          {!filterCollection && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Collection to borrow against">
              {COLLECTIONS.map((c) => (
                <button
                  key={c.address}
                  type="button"
                  aria-pressed={picked === c.address}
                  onClick={() => {
                    setPicked(c.address);
                    setTokenId('');
                  }}
                  className={`min-h-[44px] px-4 py-2 rounded-xl text-[13px] font-medium transition-all ${
                    picked === c.address ? 'border border-emerald-500/60 text-emerald-300' : 'border border-white/10 text-white/80 hover:border-white/25'
                  }`}
                  style={{ background: picked === c.address ? SELECTED_BG : CARD_BG }}
                >
                  {c.symbol}
                </button>
              ))}
            </div>
          )}

          <div>
            {owned.data && owned.data.tokens.length > 0 && (
              <div role="group" aria-label={`Your ${symbol} to ask against`} className="flex gap-2 overflow-x-auto no-scrollbar pb-2 mb-1">
                {owned.data.tokens.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={tokenId === t.id}
                    aria-label={`Ask against ${symbol} #${t.id}`}
                    onClick={() => setTokenId(t.id)}
                    className={`relative shrink-0 w-[72px] h-[72px] rounded-lg overflow-hidden transition-all ${
                      tokenId === t.id ? 'border-2 border-emerald-500/80' : 'border border-white/15 hover:border-white/40'
                    }`}
                    style={{ background: CARD_BG }}
                  >
                    {t.image && <img src={t.image} alt="" loading="lazy" className="absolute inset-0 w-full h-full object-cover" />}
                    <span className="absolute bottom-0 inset-x-0 text-[10px] font-mono text-white text-center truncate px-1" style={{ background: 'rgba(0,0,0,0.8)' }}>
                      #{t.id}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {owned.data && owned.data.complete && owned.data.tokens.length === 0 && (
              <p className="text-yellow-300 text-[11px] mb-1.5">No {symbol} found in this wallet.</p>
            )}
            <label className="text-white/90 text-[11px] uppercase tracking-wider mb-2 block" style={LABEL_STYLE}>
              Your {symbol} to borrow against
            </label>
            <input
              type="number"
              step="1"
              min="1"
              inputMode="numeric"
              placeholder="Token ID, e.g. 1234"
              aria-label={`Your ${symbol} to borrow against`}
              aria-invalid={typedBad.token || undefined}
              aria-describedby={typedBad.token ? `${hint}-token` : undefined}
              value={tokenId}
              onChange={(e) => setTokenId(e.target.value)}
              className={INPUT}
              style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
            />
            {typedBad.token && <BoxHint id={`${hint}-token`} testId="ask-hint-token" text="The NFT's number: a whole number above 0, like 1234." />}
            {token !== null && token > 0n && isConnected && (
              <p className={`text-[11px] mt-1 ${knownNotOwned ? 'text-red-300' : ownsIt ? 'text-emerald-300' : 'text-white/70'}`} data-testid="ask-owner">
                {ownerQuery.isLoading
                  ? `Checking who owns ${symbol} #${token.toString()}...`
                  : ownsIt
                  ? `You own ${symbol} #${token.toString()}.`
                  : knownNotOwned
                  ? `${symbol} #${token.toString()} is not in your wallet.`
                  : `Couldn't find ${symbol} #${token.toString()}. Check the token ID.`}
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="text-white/90 text-[11px] uppercase tracking-wider mb-2 block" style={LABEL_STYLE}>Amount you want (WETH)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                aria-label="Amount you want (WETH)"
                aria-invalid={typedBad.amount || undefined}
                aria-describedby={typedBad.amount ? `${hint}-amount` : undefined}
                value={principal}
                onChange={(e) => setPrincipal(e.target.value)}
                className={INPUT}
                style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
              />
              {typedBad.amount && <BoxHint id={`${hint}-amount`} testId="ask-hint-amount" text="An amount of WETH above 0, like 0.02." />}
            </div>
            <div>
              <label className="text-white/90 text-[11px] uppercase tracking-wider mb-2 block" style={LABEL_STYLE}>Highest APR you will pay (%)</label>
              <input
                type="number"
                step="0.01"
                min="0"
                max="1000"
                inputMode="decimal"
                placeholder="e.g. 40"
                aria-label="Highest APR you will pay (%)"
                aria-invalid={typedBad.apr || undefined}
                aria-describedby={typedBad.apr ? `${hint}-apr` : undefined}
                value={aprPct}
                onChange={(e) => setAprPct(e.target.value)}
                className={INPUT}
                style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
              />
              {typedBad.apr && (
                <BoxHint id={`${hint}-apr`} testId="ask-hint-apr" text="A yearly rate from 0.01 to 1000, at most two decimals: 40 means 40% a year." />
              )}
            </div>
          </div>

          <PresetRow label="Loan length" presets={DURATION_PRESETS} value={duration} onChange={setDuration} />
          <PresetRow label="Keep asking for" presets={ASK_OPEN_PRESETS} value={openFor} onChange={setOpenFor} />

          {atMost !== null && principalWei !== null && (
            <p className="text-white/85 text-[12px]" style={LABEL_STYLE} data-testid="ask-at-most">
              At your highest rate, repaying at the end costs {fmtWeth(atMost, 6)} WETH for {fmtWeth(principalWei)} WETH borrowed. A lender may
              offer less.
            </p>
          )}

          <button
            type="button"
            onClick={isConnected ? () => void handleAsk() : openConnectModal ?? (() => {})}
            disabled={askDisabled}
            className="btn-primary w-full min-h-[44px] rounded-xl transition-all disabled:cursor-not-allowed"
            style={askDisabled ? FADED : undefined}
          >
            {!isConnected ? 'Connect Wallet' : busy ? 'Sign in Wallet...' : 'Sign Request (no gas)'}
          </button>
          <FinePrint summary="About requests">
            <p>
              A request is a signature that costs no gas. It locks nothing, approves nothing and does not commit you: your NFT moves only if
              you later take an offer. A new request on the same NFT replaces the old one.
            </p>
          </FinePrint>
        </div>
      )}
    </div>
  );
}

/* ─── Lend tab: borrowers asking ────────────────────────────────── */
export function BorrowerRequests({ collection, onOffer }: { collection: Address; onOffer: (r: LoanRequestJson) => void }) {
  const { address } = useAccount();
  const book = useBookRequests({ collection, enabled: LENDING_LIVE });
  const rows = book.data?.requests ?? [];
  // Each request is re-read on chain: the borrower still holds the NFT. The book cannot vouch.
  const owners = useReadContracts({
    contracts: rows.map(
      (r) =>
        ({
          address: r.request.nftCollateralAddress,
          abi: ERC721_ABI,
          functionName: 'ownerOf',
          args: [BigInt(r.request.nftCollateralTokenId)],
          chainId: CHAIN_ID,
        }) as const,
    ),
    query: { enabled: LENDING_LIVE && rows.length > 0, refetchInterval: 30_000 },
  });

  const checked = rows.map((row, i) => {
    const c = owners.data?.[i];
    const held = c?.status === 'success' ? sameAddress(c.result, row.request.borrower) : null;
    return { row, held };
  });
  // A request whose NFT has moved on: ask the book to close it, once.
  const synced = useRef(new Set<string>());
  useEffect(() => {
    for (const { row, held } of checked) {
      const key = `${row.request.borrower}:${row.request.nonce}`;
      if (held !== false || synced.current.has(key)) continue;
      synced.current.add(key);
      void syncRequest(row.request.nftCollateralAddress, row.request.nftCollateralTokenId).catch(() => undefined);
    }
  });

  const shown = checked.filter(({ row, held }) => held === true && !(address && sameAddress(row.request.borrower, address)));
  if (shown.length === 0) return null;

  return (
    <div
      className="relative isolate rounded-xl p-3 md:p-5 space-y-3"
      style={{ background: CARD_BG, border: `1px solid ${CARD_BORDER}` }}
      data-testid="borrower-requests"
    >
      <CardArt pageId="nft-finance" idx={29} />
      <div>
        <p className="text-white text-[15px] font-semibold" style={LABEL_STYLE}>Borrowers asking</p>
        <p className="text-white/80 text-[12px]" style={LABEL_STYLE}>Each holds the NFT now. Press one to fill in an offer for it.</p>
      </div>
      <ul className="space-y-2">
        {shown.map(({ row }) => {
          const r = row.request;
          return (
            <li
              key={`${r.borrower}:${r.nonce}`}
              className="rounded-xl p-3 flex flex-wrap items-center justify-between gap-2"
              style={{ background: ROW_BG, border: `1px solid ${CARD_BORDER}` }}
            >
              <div>
                <p className="text-white text-[13px] font-semibold font-mono">{nftName(r)}</p>
                <p className="text-white/80 text-[12px]">{termsLine(r)}</p>
                <p className="text-white/70 text-[11px] font-mono">{shortenAddress(r.borrower)}</p>
              </div>
              <button type="button" onClick={() => onOffer(r)} className="btn-primary min-h-[44px] px-4 rounded-xl text-[13px]" aria-label={`Offer on ${nftName(r)}`}>
                Offer this
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
