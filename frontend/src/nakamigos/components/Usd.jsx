import { formatUsd } from "../lib/formatPrice";
import { useEthUsd } from "../hooks/useEthUsd";

/**
 * Small "≈ $X" USD denomination shown beside an ETH amount.
 *
 * Additive + honest: it pulls a real ETH/USD rate from useEthUsd (Chainlink via
 * PriceContext when available, else a cached CoinGecko feed). When no real rate
 * is reachable the rate is 0, formatUsd returns "", and this renders nothing —
 * we never paint a fabricated dollar figure.
 *
 * @param {number} eth   ETH value to convert
 * @param {object} [style]  extra inline style merged onto the default dim text
 * @param {number} [size]   font-size in px (default 11)
 * @param {string} [prefix] override the "≈ " prefix (e.g. "" or "~ ")
 */
export default function Usd({ eth, style, size = 11, prefix = "≈ " }) {
  const rate = useEthUsd();
  const text = formatUsd(eth, rate, { prefix });
  if (!text) return null;
  return (
    <span
      style={{
        fontFamily: "var(--mono)",
        fontSize: size,
        color: "var(--text-dim)",
        fontWeight: 400,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {text}
    </span>
  );
}
