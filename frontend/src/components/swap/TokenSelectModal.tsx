import { useState, useMemo, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useReadContract } from 'wagmi';
import { ERC20_ABI } from '../../lib/contracts';
import { DEFAULT_TOKENS, isValidAddress, type TokenInfo } from '../../lib/tokenList';

interface TokenSelectModalProps {
  open: boolean;
  onClose: () => void;
  onSelect: (token: TokenInfo) => void;
  disabledAddress?: string; // the other token in the pair
  customTokens: TokenInfo[];
  onAddCustomToken: (token: TokenInfo) => void;
}

export function TokenSelectModal({ open, onClose, onSelect, disabledAddress, customTokens, onAddCustomToken }: TokenSelectModalProps) {
  const [search, setSearch] = useState('');
  const [importAddress, setImportAddress] = useState('');
  const [importRiskAccepted, setImportRiskAccepted] = useState(false);
  const [importError, setImportError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setSearch('');
      setImportAddress('');
      setImportRiskAccepted(false);
      setImportError('');
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  const allTokens = useMemo(() => [...DEFAULT_TOKENS, ...customTokens], [customTokens]);

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
  useEffect(() => {
    setImportError('');
    if (isValidAddress(search) && !allTokens.find(t => t.address.toLowerCase() === search.toLowerCase())) {
      setImportAddress(search);
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

  const handleImport = () => {
    if (!importSymbol || importDecimals === undefined) return;
    const token: TokenInfo = {
      address: importAddress,
      symbol: importSymbol as string,
      name: importSymbol as string,
      decimals: Number(importDecimals),
      logoURI: '',
    };
    onAddCustomToken(token);
    onSelect(token);
  };

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[100] flex items-center justify-center p-4"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      >
        {/* Backdrop */}
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

        {/* Modal */}
        <motion.div
          className="relative w-full max-w-[420px] max-h-[70vh] flex flex-col rounded-2xl overflow-hidden"
          style={{
            background: 'linear-gradient(180deg, #0f1a2e 0%, #0a1020 100%)',
            border: '1px solid rgba(139,92,246,0.2)',
            boxShadow: '0 24px 80px rgba(0,0,0,0.6), 0 0 1px rgba(139,92,246,0.3)',
          }}
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-4 pb-0">
            <h3 className="text-white text-[15px] font-semibold">Select Token</h3>
            <button onClick={onClose} className="text-white/40 hover:text-white/80 transition-colors p-1 cursor-pointer">
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
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search name, symbol, or paste address"
              className="w-full px-3.5 py-2.5 rounded-xl text-[13px] text-white placeholder-white/25 outline-none"
              style={{
                background: 'rgba(139,92,246,0.06)',
                border: '1px solid rgba(139,92,246,0.12)',
              }}
            />
          </div>

          {/* Popular quick-select chips */}
          <div className="px-4 pb-2 flex flex-wrap gap-1.5">
            {['ETH', 'TOWELI', 'USDC', 'USDT', 'WBTC', 'WETH'].map(sym => {
              const token = allTokens.find(t => t.symbol === sym);
              if (!token) return null;
              const isDisabled = token.address.toLowerCase() === disabledAddress?.toLowerCase();
              return (
                <button
                  key={sym}
                  onClick={() => !isDisabled && onSelect(token)}
                  disabled={isDisabled}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[12px] font-medium transition-all cursor-pointer disabled:opacity-25 disabled:cursor-not-allowed"
                  style={{
                    background: 'rgba(139,92,246,0.06)',
                    border: '1px solid rgba(139,92,246,0.10)',
                    color: isDisabled ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.8)',
                  }}
                >
                  {token.logoURI && (
                    <img src={token.logoURI} alt="" className="w-4 h-4 rounded-full"
                      onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  )}
                  {sym}
                </button>
              );
            })}
          </div>

          <div className="mx-4 h-px" style={{ background: 'rgba(139,92,246,0.1)' }} />

          {/* Token list */}
          <div className="flex-1 overflow-y-auto px-2 py-1" style={{ maxHeight: '340px' }}>
            {filtered.map(token => {
              const isDisabled = token.address.toLowerCase() === disabledAddress?.toLowerCase();
              return (
                <button
                  key={token.address}
                  onClick={() => !isDisabled && onSelect(token)}
                  disabled={isDisabled}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all cursor-pointer disabled:opacity-25 disabled:cursor-not-allowed hover:bg-white/[0.03]"
                >
                  <div className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0 flex items-center justify-center"
                    style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.12)' }}>
                    {token.logoURI ? (
                      <img src={token.logoURI} alt="" className="w-full h-full object-cover"
                        onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                    ) : (
                      <span className="text-[11px] font-bold text-white/40">{token.symbol.slice(0, 2)}</span>
                    )}
                  </div>
                  <div className="flex-1 text-left">
                    <p className="text-white text-[13px] font-semibold leading-tight">{token.symbol}</p>
                    <p className="text-white/35 text-[11px] leading-tight">{token.name}</p>
                  </div>
                  {token.isNative && (
                    <span className="text-[10px] text-primary/60 font-mono">Native</span>
                  )}
                </button>
              );
            })}

            {filtered.length === 0 && !isImporting && !importError && (
              <div className="text-center py-8 text-white/30 text-[13px]">
                No tokens found. Paste a contract address to import.
              </div>
            )}

            {importError && (
              <div className="text-center py-8 text-danger text-[13px]">
                {importError}
              </div>
            )}

            {/* Custom token import with safety warning */}
            {isImporting && (
              <div className="mx-2 my-2 rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,178,55,0.25)' }}>
                {importSymbol ? (
                  <div>
                    <div className="p-3 flex items-center gap-3" style={{ background: 'rgba(139,92,246,0.06)' }}>
                      <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(139,92,246,0.08)', border: '1px solid rgba(139,92,246,0.12)' }}>
                        <span className="text-[11px] font-bold text-white/40">{(importSymbol as string).slice(0, 2)}</span>
                      </div>
                      <div>
                        <p className="text-white text-[13px] font-semibold">{importSymbol as string}</p>
                        <p className="text-white/35 text-[11px] font-mono">{importAddress.slice(0, 8)}...{importAddress.slice(-6)}</p>
                      </div>
                    </div>
                    <div className="px-3 py-2.5" style={{ background: 'rgba(255,178,55,0.06)' }}>
                      <p className="text-warning text-[11px] font-medium mb-2">This token is not on any verified list. Anyone can create a token with any name. DYOR.</p>
                      <label className="flex items-center gap-2 cursor-pointer mb-2">
                        <input type="checkbox" checked={importRiskAccepted} onChange={e => setImportRiskAccepted(e.target.checked)}
                          className="w-3.5 h-3.5 rounded accent-primary cursor-pointer" />
                        <span className="text-white/50 text-[11px]">I understand the risks</span>
                      </label>
                      <button
                        onClick={handleImport}
                        disabled={!importRiskAccepted}
                        className="w-full py-2 rounded-lg text-[12px] font-semibold cursor-pointer transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                        style={{ background: 'rgba(139,92,246,0.15)', color: 'var(--color-primary)', border: '1px solid rgba(139,92,246,0.25)' }}
                      >
                        Import Token
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="p-3 flex items-center gap-2" style={{ background: 'rgba(139,92,246,0.06)' }}>
                    <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
                    <span className="text-white/40 text-[12px]">Looking up token...</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
