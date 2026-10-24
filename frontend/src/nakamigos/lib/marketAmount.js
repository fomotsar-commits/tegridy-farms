import { formatPrice } from "./formatPrice";

// An amount a market read produced, in that market's own unit. ETH keeps the
// venue's four decimals; SOL shows up to four, trimmed; an amount on Base says
// so, since it is not mainnet ETH. null when there is no finite number or no
// unit, so a caller renders its own unread placeholder rather than a zero or a
// unit nobody read. A caller that knows the unit (volume in ETH) passes it.
export function formatMarketAmount(value, symbol, collection) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (typeof symbol !== "string" || symbol === "") return null;
  const unit = symbol;
  const digits = unit === "SOL"
    ? value.toLocaleString("en-US", { maximumFractionDigits: 4 })
    : formatPrice(value);
  const where = collection?.chain === "base" && unit !== "SOL" ? " on Base" : "";
  return `${digits} ${unit}${where}`;
}
