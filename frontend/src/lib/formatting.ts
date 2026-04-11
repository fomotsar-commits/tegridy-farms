export function formatCurrency(value: number, decimals = 2): string {
  if (!isFinite(value) || isNaN(value)) return '–';
  if (value >= 1_000_000_000_000) return `$${(value / 1_000_000_000_000).toFixed(decimals)}T`;
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(decimals)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(decimals)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(decimals)}K`;
  if (value > 0 && value < 0.000001) return `$${value.toExponential(2)}`;
  if (value > 0 && value < 0.01) return `$${value.toFixed(Math.max(decimals, 8))}`;
  return `$${value.toFixed(decimals)}`;
}

export function formatNumber(value: number, decimals = 2): string {
  if (!isFinite(value) || isNaN(value)) return '–';
  if (value >= 1_000_000_000_000) return `${(value / 1_000_000_000_000).toFixed(decimals)}T`;
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(decimals)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(decimals)}M`;
  if (value >= 1_000) return `${value.toLocaleString(undefined, { maximumFractionDigits: decimals })}`;
  return value.toFixed(decimals);
}

export function formatTokenAmount(value: string | number, decimals = 4): string {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  if (!isFinite(num) || isNaN(num)) return '–';
  if (num === 0) return (0).toFixed(decimals);
  if (num > 0 && num < 0.000001) return num.toExponential(2);
  if (num > 0 && num < 0.0001) return num.toFixed(8);
  return num.toFixed(decimals);
}

export function formatPercent(value: number): string {
  if (value >= 10000) return `${formatNumber(value, 0)}%`;
  return `${value.toFixed(2)}%`;
}

export function shortenAddress(address: string, chars = 4): string {
  return `${address.slice(0, chars + 2)}...${address.slice(-chars)}`;
}

export function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
