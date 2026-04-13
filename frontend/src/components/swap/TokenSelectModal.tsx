import { useState, useMemo, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useReadContract } from 'wagmi';
import { toast } from 'sonner';
import { ERC20_ABI } from '../../lib/contracts';
import { DEFAULT_TOKENS, isValidAddress, validateAddress, type TokenInfo } from '../../lib/tokenList';

function FallbackIcon({ symbol, size, bg }: { symbol: string; size: string; bg: string }) {
  return (
    <span className={`${size} rounded-full flex items-center justify-center text-[8px] font-bold text-white`} style={{ background: bg }}>
      {symbol.charAt(0)}
    </span>
  );
}

function SafeTokenImg({ src, symbol, size, fallbackBg }: { src: string; symbol: string; size: string; fallbackBg: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <FallbackIcon symbol={symbol} size={size} bg={fallbackBg} />;
  return <img src={src} alt="" className={`${size} rounded-full`} onError={() => setFailed(true)} />;
}

interface TokenSelectModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (token: TokenInfo) => void;
  disabledAddress?: string; // the other token in the pair
  customTokens: TokenInfo[];
  onAddCustomToken: (token: TokenInfo) => void;
}

const RECENT_TOKENS_KEY = 'tegridy_recent_tokens';
const MAX_RECENT = 4;

function getRecentTokens(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_TOKENS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch { return []; }
}

function saveRecentToken(address: string) {
  try {
    const recent = getRecentTokens().filter(a => a.toLowerCase() !== address.toLowerCase());
    recent.unshift(address);
    localStorage.setItem(RECENT_TOKENS_KEY, JSON.stringify(recent.slice(0, MAX_RECENT)));
  } catch { /* ignore */ }
}

export function TokenSelectModal({ open, onClose, onSelect, disabledAddress, customTokens, onAddCustomToken }: TokenSelectModalProps) {
  const [search, setSearch] = useState('');
  const [importAddress, setImportAddress] = useState('');
  const [importRiskAccepted, setImportRiskAccepted] = useState(false);
  const [importError, setImportError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const [recentAddresses, setRecentAddresses] = useState<string[]>(getRecentTokens);

  useEffect(() => {
    if (open) {
      setSearch('');
      setImportAddress('');
      setImportRiskAccepted(false);
      setImportError('');
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  // Escape key to close
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  // Body scroll lock
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Focus trap
  useEffect(() => {
    if (!open) return;
    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !modalRef.current) return;
      const focusable = modalRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handleTab);
    return () => document.removeEventListener('keydown', handleTab);
  }, [open]);

  // Reset import risk checkbox when address changes
  useEffect(() => {
    setImportRiskAccepted(false);
  }, [importAddress]);

  const allTokens = useMemo(() => [...DEFAULT_TOKENS, ...customTokens], [customTokens]);

  const handleSelect = (token: TokenInfo) => {
    saveRecentToken(token.address);
    setRecentAddresses(getRecentTokens());
    onSelect(token);
  };

  const filtered = useMemo(() => {
    if (!search) return allTokens;
    const q = search.toLowerCase();
    // If it looks like an address, try to match exactly
    if (q.startsWith('0x') && q.length > 6) {
      const match = allTokens.filter(t => t.address.toLowerCase().includes(q));
      if (match.length > 0) return match;
      return [];
    }
    return allTokens.filter(t =>
      t.symbol.toLowerCase().includes(q) ||
      t.name.toLowerCase().includes(q)
    );
  }, [search, allTokens]);

  // Detect when search is a valid address not in the list — trigger import
  // Uses EIP-55 checksum validation via viem's getAddress
  useEffect(() => {
    setImportError('');
    if (isValidAddress(search)) {
      const checksummed = validateAddress(search);
      if (!checksummed) {
        setImportError('Invalid address checksum');
        setImportAddress('');
      } else if (!allTokens.find(t => t.address.toLowerCase() === checksummed.toLowerCase())) {
        setImportAddress(checksummed);
      } else {
        setImportAddress('');
      }
    } else {
      setImportAddress('');
    }
  }, [search, allTokens]);

  // For custom token import: read on-chain data
  const isImporting = isValidAddress(importAddress) && !allTokens.find(t => t.address.toLowerCase() === importAddress.toLowerCase());

  const { data: importSymbol } = useReadContract({
    address: importAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'symbol',
    query: { enabled: isImporting },
  });

  const { data: importDecimals } = useReadContract({
    address: importAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'decimals',
    query: { enabled: isImporting },
  });

  // Timeout for token import lookup
  useEffect(() => {
    if (!isImporting) return;
    const timer = setTimeout(() => {
      if (!importSymbol && !importDecimals) {
        setImportError('Could not find token at this address');
        setImportAddress('');
      }
    }, 8000);
    return () => clearTimeout(timer);
  }, [isImporting, importSymbol, importDecimals]);

  // SECURITY FIX: Detect symbol spoofing — warn if symbol matches a known token at a different address
  const isSpoofedSymbol = useMemo(() => {
    if (!importSymbol) return false;
    const sym = (importSymbol as string).toUpperCase();
    return DEFAULT_TOKENS.some(t =>
      t.symbol.toUpperCase() === sym &&
      t.address.toLowerCase() !== importAddress.toLowerCase()
    );
  }, [importSymbol, importAddress]);

  const handleImport = () => {
    if (!importSymbol || importDecimals === undefined) return;
    // SECURITY FIX: Block import of spoofed known tokens entirely
    if (isSpoofedSymbol) return;
    // L-04: Validate decimals range
    if (Number(importDecimals) > 18 || Number(importDecimals) < 0) {
      toast.error('Invalid token: decimals must be 0-18');
      return;
    }
    // L-05: Sanitize symbol — strip non-printable ASCII characters
    const rawSymbol = String(importSymbol);
    const sanitizedSymbol = rawSymbol.replace(/[^\x20-\x7E]/g, '').slice(0, 12);
    if (sanitizedSymbol !== rawSymbol.slice(0, 12)) {
      toast.warning('Token symbol contains non-standard characters');
    }
    const token: TokenInfo = {
      address: importAddress,
      symbol: sanitizedSymbol,
      name: sanitizedSymbol,
      decimals: Number(importDecimals),
      logoURI: '',
    };
    onAddCustomToken(token);
    handleSelect(token);
  };

  return (
    <AnimatePresence>
      {open && (
      <motion.div
        ref={modalRef}
        key="token-select-modal"
        className="fixed inset-0 z-[100] flex items-center justify-center p-4"
        role="dialog" aria-modal="true" aria-label="Select Token"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      >
        {/* Backdrop */}
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

        {/* Modal */}
        <motion.div
          className="relative w-full max-w-[420px] max-md:max-w-none max-md:max-h-none max-md:h-full max-md:rounded-none flex flex-col rounded-2xl overflow-hidden"
          style={{
            maxHeight: 'calc(100vh - 160px)',
            background: 'linear-gradient(180deg, #0f1a2e 0%, #0a1020 100%)',
            border: '1px solid rgba(139,92,246,0.2)',
            boxShadow: '0 24px 80px rgba(0,0,0,0.6), 0 0 1px rgba(139,92,246,0.3)',
          }}
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-4 pb-0">
            <h3 className="text-white text-[15px] font-semibold">Select Token</h3>
            <button onClick={onClose} aria-label="Close token selector" className="text-white hover:text-white transition-colors p-1 cursor-pointer">
              <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>

          {/* Search */}
          <div className="px-4 pt-3 pb-2">
            <input
              ref={inputRef}
              type="text"
              aria-label="Search tokens by name, symbol, or address"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search name, symbol, or paste address"
              className="w-full px-3.5 py-2.5 min-h-[44px] rounded-xl text-[13px] text-white placeholder-white/25 outline-none"
              style={{
                background: 'rgba(139,92,246,0.75)',
                border: '1px solid rgba(139,92,246,0.75)',
              }}
            />
          </div>

          {/* Popular quick-select chips */}
          <div className="px-4 pb-2 flex flex-wrap gap-1.5">
            {['ETH', 'TOWELI', 'USDC', 'USDT', 'WBTC', 'WETH'].map(sym => {
              const token = DEFAULT_TOKENS.find(t => t.symbol === sym);
              if (!token) return null;
              const isDisabled = token.address.toLowerCase() === disabledAddress?.toLowerCase();
              return (
                <button
                  key={sym}
                  onClick={() => !isDisabled && handleSelect(token)}
                  disabled={isDisabled}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-medium transition-all cursor-pointer disabled:opacity-25 disabled:cursor-not-allowed"
                  style={{
                    background: 'rgba(139,92,246,0.75)',
                    border: '1px solid rgba(139,92,246,0.75)',
                    color: isDisabled ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.8)',
                  }}
                >
                  {token.logoURI ? (
                    <SafeTokenImg src={token.logoURI} symbol={token.symbol} size="w-4 h-4" fallbackBg="rgba(139,92,246,0.75)" />
                  ) : (
                    <FallbackIcon symbol={token.symbol} size="w-4 h-4" bg="rgba(139,92,246,0.75)" />
                  )}
                  {sym}
                </button>
              );
            })}
          </div>

          {/* Recently used */}
          {recentAddresses.length > 0 && !search && (
            <div className="px-4 pb-2">
              <span className="text-white text-[10px] uppercase tracking-wider label-pill font-medium">Recent</span>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {recentAddresses.map(addr => {
                  const token = allTokens.find(t => t.address.toLowerCase() === addr.toLowerCase());
                  if (!token) return null;
                  const isDisabled = token.address.toLowerCase() === disabledAddress?.toLowerCase();
                  return (
                    <button
                      key={`recent-${addr}`}
                      onClick={() => !isDisabled && handleSelect(token)}
                      disabled={isDisabled}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-medium transition-all cursor-pointer disabled:opacity-25 disabled:cursor-not-allowed"
                      style={{
                        background: 'rgba(212,160,23,0.06)',
                        border: '1px solid rgba(212,160,23,0.15)',
                        color: isDisabled ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.7)',
                      }}
                    >
                      {token.logoURI ? (
                        <SafeTokenImg src={token.logoURI} symbol={token.symbol} size="w-4 h-4" fallbackBg="rgba(212,160,23,0.15)" />
                      ) : (
                        <FallbackIcon symbol={token.symbol} size="w-4 h-4" bg="rgba(212,160,23,0.15)" />
                      )}
                      {token.symbol}
                      {!DEFAULT_TOKENS.some(t => t.address.toLowerCase() === token.address.toLowerCase()) && (
                        <span className="text-[8px] text-warning/70 font-semibold ml-0.5">!</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="mx-4 h-px" style={{ background: 'rgba(139,92,246,0.1)' }} />

          {/* Token list */}
          <div className="flex-1 overflow-y-auto px-2 py-1 max-md:max-h-none" style={{ maxHeight: '340px' }}>
            {filtered.map(token => {
              const isDisabled = token.address.toLowerCase() === disabledAddress?.toLowerCase();
              return (
                <button
                  key={token.address}
                  onClick={() => !isDisabled && handleSelect(token)}
                  disabled={isDisabled}
                  className="w-full flex items-center gap-3 px-3 py-2.5 min-h-[44px] rounded-xl transition-all cursor-pointer disabled:opacity-25 disabled:cursor-not-allowed hover:bg-black/60"
                >
                  <div className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0 flex items-center justify-center"
                    style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}>
                    {token.logoURI ? (
                      <SafeTokenImg src={token.logoURI} symbol={token.symbol} size="w-full h-full" fallbackBg="transparent" />
                    ) : (
                      <span className="text-[11px] font-bold text-white">{token.symbol.charAt(0)}</span>
                    )}
                  </div>
                  <div className="flex-1 text-left">
                    <p className="text-white text-[13px] font-semibold leading-tight">{token.symbol}</p>
                    <p className="text-white text-[11px] leading-tight">{token.name}</p>
                  </div>
                  {!DEFAULT_TOKENS.some(t => t.address.toLowerCase() === token.address.toLowerCase()) && (
                    <span className="text-[9px] text-warning/70 font-semibold px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,178,55,0.10)', border: '1px solid rgba(255,178,55,0.20)' }}>Unverified</span>
                  )}
                  {token.isNative && (
                    <span className="text-[10px] text-white font-mono">Native</span>
                  )}
                </button>
              );
            })}

            {filtered.length === 0 && !isImporting && !importError && (
              <div className="text-center py-8 text-white text-[13px]">
                No tokens found. Paste a contract address to import.
              </div>
            )}

            {importError && (
              <div role="alert" className="text-center py-8 text-danger text-[13px]">
                {importError}
              </div>
            )}

            {/* Custom token import with safety warning */}
            {isImporting && (
              <div className="mx-2 my-2 rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,178,55,0.25)' }}>
                {importSymbol ? (
                  <div>
                    <div className="p-3 flex items-center gap-3" style={{ background: 'rgba(139,92,246,0.75)' }}>
                      <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(139,92,246,0.75)', border: '1px solid rgba(139,92,246,0.75)' }}>
                        <span className="text-[11px] font-bold text-white">{(importSymbol as string).slice(0, 2)}</span>
                      </div>
                      <div>
                        <p className="text-white text-[13px] font-semibold">{importSymbol as string}</p>
                        <p className="text-white text-[11px] font-mono">{importAddress.slice(0, 8)}...{importAddress.slice(-6)}</p>
                      </div>
                    </div>
                    <div className="px-3 py-2.5" style={{ background: 'rgba(255,178,55,0.06)' }}>
                      <div className="flex items-center gap-1.5 px-2.5 py-1.5 mb-2 rounded-lg" style={{ background: 'rgba(255,178,55,0.10)', border: '1px solid rgba(255,178,55,0.25)' }}>
                        <span className="text-warning text-[13px]">&#9888;</span>
                        <p className="text-warning text-[11px] font-medium">This token has not been verified. Trade at your own risk.</p>
                      </div>
                      <p className="text-white text-[10px] mb-2">Anyone can create a token with any name. Always do your own research.</p>
                      {isSpoofedSymbol && (
                        <div className="flex items-center gap-1.5 px-2.5 py-1.5 mb-2 rounded-lg" style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)' }}>
                          <span className="text-red-400 text-[13px]">&#128683;</span>
                          <p className="text-red-400 text-[11px] font-semibold">
                            SCAM WARNING: This token uses the symbol &quot;{importSymbol as string}&quot; but is NOT the real {importSymbol as string}. The contract address does not match the verified token. Import blocked.
                          </p>
                        </div>
                      )}
                      {!isSpoofedSymbol && (
                        <>
                          <label className="flex items-center gap-2 cursor-pointer mb-2">
                            <input type="checkbox" checked={importRiskAccepted} onChange={e => setImportRiskAccepted(e.target.checked)}
                              className="w-3.5 h-3.5 rounded accent-primary cursor-pointer" />
                            <span className="text-white text-[11px]">I understand the risks</span>
                          </label>
                          <button
                            onClick={handleImport}
                            disabled={!importRiskAccepted}
                            aria-disabled={!importRiskAccepted}
                            className="w-full py-2 rounded-lg text-[12px] font-semibold cursor-pointer transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                            style={{ background: 'rgba(139,92,246,0.75)', color: 'var(--color-primary)', border: '1px solid rgba(139,92,246,0.25)' }}
                          >
                            Import Token
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="p-3 flex items-center gap-2" style={{ background: 'rgba(139,92,246,0.75)' }}>
                    <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                    <span className="text-white text-[12px]">Looking up token...</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
      )}
    </AnimatePresence>
  );
}
