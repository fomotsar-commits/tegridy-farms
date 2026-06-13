import { Fragment, useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { m } from 'framer-motion';
import { useAccount } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { getTxUrl, getAddressUrl } from '../lib/explorer';
import { CHAIN_ID } from '../lib/constants';
// F383: import the shared, schema-validated history helpers instead of keeping
// a diverging inline copy. lib/txHistory is the single validated path for both
// HistoryPage and the Treasury activity feed.
import {
  type TxRecord, parseTxRecords, formatGasEth, categorizeTx, HISTORY_CONTRACTS,
} from '../lib/txHistory';
import { shortenAddress, formatTimeAgo } from '../lib/formatting';
import { Skeleton } from '../components/ui/Skeleton';
import { usePageTitle } from '../hooks/usePageTitle';
import { ArtImg } from '../components/ArtImg';

// Group by local calendar day. Returns stable sections in input order with
// the first tx's date used for the label; "Today" / "Yesterday" are promoted
// on top of the absolute date.
function dayLabel(unixSec: number, now: number = Date.now()): string {
  const d = new Date(unixSec * 1000);
  const nowD = new Date(now);
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(nowD) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  const sameYear = d.getFullYear() === nowD.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

export default function HistoryPage() {
  usePageTitle('History', 'Your transaction history — swaps, stakes, claims, and on-chain activity.');
  const { isConnected, address } = useAccount();
  // F390: tx data comes from the mainnet-only /api/etherscan proxy, so explorer
  // links must always point at the canonical chain — not the wallet's current
  // chain (a wallet on Base/Arbitrum would otherwise get dead basescan links).
  const chainId = CHAIN_ID;
  const [txs, setTxs] = useState<TxRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Pagination: 25/page avoids scrolling a wall of rows on mobile while still letting
  // active users drill back through months of activity without a URL param.
  const PAGE_SIZE = 25;
  const [page, setPage] = useState(0);

  const fetchHistory = useCallback((addr: string, signal: AbortSignal, skipCache = false) => {
    // Check cache first
    const cacheKey = `tegridy_tx_history_${addr}`;
    if (!skipCache) {
      try {
        const cached = localStorage.getItem(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          if (parsed && typeof parsed.ts === 'number' && Array.isArray(parsed.data) && Date.now() - parsed.ts < 300000) {
            // R040 H1: parse cached entries through the same schema as fresh
            // responses — a stale cache from before this fix may still have
            // unvalidated rows.
            setTxs(parseTxRecords(parsed.data));
            return;
          }
        }
      } catch { /* ignore */ }
    }

    setLoading(true);
    setError('');
    // F382/F383: single source of truth for the tracked-contract filter (lib),
    // now including live LP Farming + native Tegridy Router/LP so the footer's
    // "all protocol contracts" claim holds.
    const contracts = HISTORY_CONTRACTS;

    // SECURITY FIX: Route Etherscan calls through server-side proxy to keep API key hidden.
    // Previously used VITE_ETHERSCAN_API_KEY which was exposed in client-side bundle.
    //
    // BUG FIX: We previously sent startblock=0&endblock=99999999 to fetch the full
    // history. The proxy enforces a 10k-block range cap (it defends the upstream
    // quota), so that request always 400'd and the page broke. Etherscan's default
    // when no range is given is the full chain — combined with offset=500 to match
    // the client-side cap, that's exactly what we want.
    fetch(`/api/etherscan?module=account&action=txlist&address=${addr}&page=1&offset=500&sort=desc`, { signal })
      .then(async r => {
        // The proxy can return a Vercel HTML/comment error page instead of JSON
        // (e.g. during a deploy or when /api/etherscan is missing). r.json() on
        // that body surfaces a cryptic "Unexpected token '/'" to the user — catch
        // it here and fall back to a readable message.
        const text = await r.text();
        try {
          return JSON.parse(text);
        } catch {
          throw new Error(
            r.ok
              ? 'History service returned an unexpected response. Try again shortly.'
              : `History service unavailable (HTTP ${r.status}). Try again shortly.`
          );
        }
      })
      .then(data => {
        if (signal.aborted) return;
        if (data.status === '1' && Array.isArray(data.result)) {
          // R040 H1: schema-validate every row before rendering so a poisoned
          // proxy response can't slip a non-hex hash into a clickable href.
          // Fetch up to 500 protocol-relevant txns; pagination handled client-side below.
          // 500 is a UX cap, not a privacy one — Etherscan paginates server-side too.
          const validated = parseTxRecords(data.result);
          const relevant = validated
            .filter((tx) => contracts.includes(tx.to.toLowerCase()))
            .slice(0, 500);
          setTxs(relevant);
          try {
            localStorage.setItem(cacheKey, JSON.stringify({ data: relevant, ts: Date.now() }));
          } catch { /* ignore */ }
        } else if (data.status === '0' && data.message === 'No transactions found') {
          setTxs([]);
        } else {
          // Normalize Etherscan's terse `NOTOK` (usually means a misconfigured
          // API key on the server) into something a user can act on.
          const raw = (data.message || '').toString();
          const looksLikeAuthIssue = raw === 'NOTOK' || /api\s*key/i.test(data.result || '');
          setError(
            looksLikeAuthIssue
              ? "Tegridy Farms can't reach Etherscan right now. View your full history directly on Etherscan below."
              : (raw || 'Failed to load history. Try again later.')
          );
        }
      })
      .catch((err) => {
        if (!signal.aborted) setError(err?.message || 'Failed to load history. Try again later.');
      })
      .finally(() => {
        if (!signal.aborted) setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!address) return;
    const controller = new AbortController();
    // fetchHistory dispatches setLoading/setError/setTxs as part of the data
    // fetch lifecycle. This is the canonical "data-fetching in effect" use
    // case the React Compiler rule flags but doesn't have a cleaner pattern
    // for without bringing in react-query.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchHistory(address, controller.signal);
    return () => controller.abort();
  }, [address, fetchHistory]);

  // F394: track the latest manual (retry / refresh) fetch controller so it can
  // be aborted on unmount instead of leaking — the effect-driven fetch already
  // aborts via its own controller, but manual ones previously had no cleanup.
  const manualControllerRef = useRef<AbortController | null>(null);
  useEffect(() => () => manualControllerRef.current?.abort(), []);

  const forceRefetch = useCallback(() => {
    if (!address) return;
    const cacheKey = `tegridy_tx_history_${address}`;
    try { localStorage.removeItem(cacheKey); } catch { /* ignore */ }
    manualControllerRef.current?.abort();
    const controller = new AbortController();
    manualControllerRef.current = controller;
    fetchHistory(address, controller.signal, true);
  }, [address, fetchHistory]);

  const handleRetry = forceRefetch;

  const categorized = useMemo(() => txs.map(tx => ({
    ...tx,
    ...categorizeTx(tx),
  })), [txs]);

  // Reset to page 0 whenever the underlying tx set changes (connect different
  // wallet, refetch). Uses React's "adjusting state during render" pattern so
  // pagination resets in the same commit instead of a follow-up effect.
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [prevTxsLen, setPrevTxsLen] = useState(txs.length);
  if (txs.length !== prevTxsLen) {
    setPrevTxsLen(txs.length);
    setPage(0);
  }

  const totalPages = Math.max(1, Math.ceil(categorized.length / PAGE_SIZE));
  const pageStart = page * PAGE_SIZE;
  const pagedCategorized = categorized.slice(pageStart, pageStart + PAGE_SIZE);

  // AUDIT HISTORY-UX: group the current page's rows by local calendar day
  // so the user sees a "Today / Yesterday / Apr 14" section header between
  // stretches of activity. Stable in render order; no sorting changes.
  // Capture `now` at mount and tick once per minute so the "Today/Yesterday"
  // labels stay accurate across the day boundary without an impure Date.now()
  // read during render.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const groupedPage = useMemo(() => {
    const groups: Array<{ label: string; txs: typeof pagedCategorized }> = [];
    let current: { label: string; txs: typeof pagedCategorized } | null = null;
    for (const tx of pagedCategorized) {
      const label = dayLabel(parseInt(tx.timeStamp, 10), nowMs);
      if (!current || current.label !== label) {
        current = { label, txs: [] };
        groups.push(current);
      }
      current.txs.push(tx);
    }
    return groups;
  }, [pagedCategorized, nowMs]);

  const exportCSV = useCallback(() => {
    if (categorized.length === 0) return;
    const headers = ['Date', 'Type', 'Function', 'Tx Hash', 'To', 'Value (Wei)', 'Gas Cost (ETH)', 'Status'];
    const rows = categorized.map(tx => [
      new Date(parseInt(tx.timeStamp, 10) * 1000).toISOString(),
      tx.type,
      tx.functionName?.split('(')[0] || '',
      tx.hash,
      tx.to,
      tx.value || '0',
      formatGasEth(tx.gasUsed, tx.gasPrice) || '',
      tx.isError === '0' ? 'OK' : 'Failed',
    ]);
    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tegridy-transactions-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [categorized]);

  if (!isConnected) {
    return (
      <div className="-mt-14 relative min-h-screen">
        <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
          <ArtImg pageId="history" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <div className="relative z-10 min-h-screen flex items-center justify-center px-6">
          <m.div className="text-center max-w-sm" initial={{ opacity: 0, y: 15 }} animate={{ opacity: 1, y: 0 }}>
            <h2 className="heading-luxury text-2xl text-white mb-2">Transaction History</h2>
            <p className="text-white text-[13px] mb-6">Connect your wallet to view your history.</p>
            <ConnectButton.Custom>
              {({ openConnectModal, mounted }) => (
                <div {...(!mounted && { style: { opacity: 0, pointerEvents: 'none' } })}>
                  <button onClick={openConnectModal} className="btn-primary px-7 py-2.5 text-[14px]">Connect Wallet</button>
                </div>
              )}
            </ConnectButton.Custom>
          </m.div>
        </div>
      </div>
    );
  }

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="history" idx={1} fallbackPosition="center 40%" alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>

      <div className="relative z-10 max-w-[900px] mx-auto px-4 md:px-6 pt-32 pb-28 md:pb-12">
        <m.div className="mb-6" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="heading-luxury text-2xl md:text-3xl lg:text-4xl text-white tracking-tight mb-1">History</h1>
              <p className="text-white text-[14px]">Your recent transactions on Tegridy Farms</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* F394: force a fresh fetch (skipCache) so a user who just
                  transacted isn't stuck on ≤5-min stale cache. */}
              <button
                onClick={forceRefetch}
                disabled={loading}
                className="flex items-center gap-2 px-3 py-2 text-[12px] rounded-lg text-white/80 border border-white/15 hover:border-white/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                title="Refresh transaction history"
                aria-label="Refresh transaction history"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={loading ? 'animate-spin' : ''}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
                Refresh
              </button>
              {categorized.length > 0 && (
                <button onClick={exportCSV} className="btn-primary flex items-center gap-2 px-4 py-2 text-[12px]" title="Export transactions as CSV">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  Export CSV
                </button>
              )}
            </div>
          </div>
        </m.div>

        <m.div className="rounded-xl overflow-hidden relative" style={{ border: '1px solid var(--color-purple-12)' }} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          <div className="absolute inset-0">
            <ArtImg pageId="history" idx={2} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="relative z-10">
          {loading ? (
            <div className="p-6 space-y-3">
              {[1,2,3,4,5].map(i => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton width={60} height={20} />
                  <Skeleton width={120} height={16} />
                  <div className="flex-1" />
                  <Skeleton width={80} height={16} />
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="p-6 text-center">
              <p className="text-[13px] mb-3 font-medium" style={{ color: '#fca5a5', textShadow: '0 1px 6px rgba(0,0,0,0.95), 0 0 10px rgba(0,0,0,0.9)' }}>{error}</p>
              <div className="flex items-center justify-center gap-3">
                <button onClick={handleRetry} className="btn-primary px-5 py-1.5 text-[12px]">Retry</button>
                {address && (
                  <a
                    href={getAddressUrl(chainId, address)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[12px] text-purple-300 hover:text-purple-200 underline underline-offset-2"
                  >
                    View on Etherscan ↗
                  </a>
                )}
              </div>
            </div>
          ) : categorized.length === 0 ? (
            <div className="p-8 text-center">
              <p className="text-white text-[13px]" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95), 0 0 10px rgba(0,0,0,0.9)' }}>No transactions found. Start trading or staking to see your history here.</p>
              <p className="text-white/85 text-[11px] mt-1" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95), 0 0 10px rgba(0,0,0,0.9)' }}>Swaps, stakes, claims, and governance actions will appear automatically.</p>
            </div>
          ) : (
            <table className="w-full">
              <thead className="hidden md:table-header-group">
                <tr className="text-[11px] text-white uppercase tracking-wider label-pill"
                  style={{ borderBottom: '1px solid var(--color-purple-75)', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
                  <th className="px-4 md:px-5 py-3 text-left font-normal w-20">Type</th>
                  <th className="py-3 text-left font-normal w-24">Function</th>
                  <th className="py-3 text-left font-normal">Tx Hash</th>
                  <th className="py-3 text-right font-normal w-24">Gas (ETH)</th>
                  <th className="py-3 text-right font-normal w-20">Time</th>
                  <th className="px-4 md:px-5 py-3 text-right font-normal w-16">Status</th>
                </tr>
              </thead>
              <tbody>
                {groupedPage.map(group => (
                  <Fragment key={group.label}>
                    {/* Day-header row spans the full table; sticky-ish via
                        class styling so it pins while scrolling a long day. */}
                    <tr className="bg-black/50">
                      <td colSpan={6} className="px-4 md:px-5 py-2 text-[11px] uppercase tracking-wider text-white/60 font-semibold"
                        style={{ textShadow: '0 1px 4px rgba(0,0,0,0.8)' }}>
                        {group.label}
                        <span className="ml-2 text-white/35 lowercase font-normal">
                          · {group.txs.length} tx{group.txs.length === 1 ? '' : 's'}
                        </span>
                      </td>
                    </tr>
                    {group.txs.map(tx => {
                      const gasEth = formatGasEth(tx.gasUsed, tx.gasPrice);
                      return (
                        <tr key={tx.hash} className="hover:bg-black/60 transition-colors"
                          style={{ borderBottom: '1px solid var(--color-purple-75)' }}>
                          {/* Desktop cells */}
                          <td className="hidden md:table-cell px-4 md:px-5 py-3">
                            <a href={getTxUrl(chainId, tx.hash)} target="_blank" rel="noopener noreferrer"
                              className={`text-[12px] font-semibold ${tx.color}`}>{tx.type}</a>
                          </td>
                          <td className="hidden md:table-cell py-3">
                            <span className="text-[11px] text-white font-mono truncate block w-24">{tx.functionName?.split('(')[0] || '–'}</span>
                          </td>
                          <td className="hidden md:table-cell py-3">
                            <a href={getTxUrl(chainId, tx.hash)} target="_blank" rel="noopener noreferrer"
                              className="text-[11px] font-mono text-white truncate block">
                              {shortenAddress(tx.hash, 8)}
                            </a>
                          </td>
                          <td className="hidden md:table-cell py-3 text-right text-[11px] text-white/70 font-mono" title={gasEth ? `${gasEth} ETH spent on gas` : 'Gas cost unavailable'}>
                            {gasEth || '—'}
                          </td>
                          <td className="hidden md:table-cell py-3 text-right text-[11px] text-white">
                            {formatTimeAgo(parseInt(tx.timeStamp, 10))}
                          </td>
                          <td className="hidden md:table-cell px-4 md:px-5 py-3 text-right">
                            <span className={`text-[11px] font-medium ${tx.isError === '0' ? 'text-success' : 'text-danger'}`}>
                              {tx.isError === '0' ? 'OK' : 'Failed'}
                            </span>
                          </td>
                          {/* Mobile cell — single cell spanning full width */}
                          <td className="md:hidden px-4 py-3" colSpan={6}>
                            <a href={getTxUrl(chainId, tx.hash)} target="_blank" rel="noopener noreferrer"
                              className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-2 min-w-0">
                                <span className={`text-[12px] font-semibold flex-shrink-0 ${tx.color}`}>{tx.type}</span>
                                <span className="text-[11px] font-mono text-white truncate">
                                  {shortenAddress(tx.hash, 6)}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 flex-shrink-0">
                                {gasEth && <span className="text-[10px] text-white/60 font-mono">{gasEth} Ξ</span>}
                                <span className="text-[11px] text-white">{formatTimeAgo(parseInt(tx.timeStamp, 10))}</span>
                                <span className={`text-[11px] font-medium ${tx.isError === '0' ? 'text-success' : 'text-danger'}`}>
                                  {tx.isError === '0' ? 'OK' : 'Fail'}
                                </span>
                              </div>
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
          </div>
        </m.div>

        {categorized.length > PAGE_SIZE && (
          <div className="flex items-center justify-between mt-4 gap-3 flex-wrap">
            <div className="text-white/40 text-[11px]">
              Showing {pageStart + 1}&ndash;{Math.min(pageStart + PAGE_SIZE, categorized.length)} of {categorized.length}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-3 py-1.5 rounded-lg text-[11px] font-semibold text-white/80 border border-white/15 hover:border-white/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                aria-label="Previous page"
              >
                Prev
              </button>
              <span className="text-white/60 text-[11px] min-w-[60px] text-center">
                {page + 1} / {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="px-3 py-1.5 rounded-lg text-[11px] font-semibold text-white/80 border border-white/15 hover:border-white/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                aria-label="Next page"
              >
                Next
              </button>
            </div>
          </div>
        )}

        <p className="text-white/15 text-[10px] text-center mt-4">
          Showing interactions with all Tegridy Farms protocol contracts.
        </p>
      </div>
    </div>
  );
}
