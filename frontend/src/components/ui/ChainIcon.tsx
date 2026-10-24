import { useId } from 'react';
import type { VenueChain } from '../../lib/sectionChains';

/**
 * A network's mark, drawn inline so it needs no request and no gateway. Decorative: the
 * network's name is always written beside it.
 */
export function ChainIcon({ chain, size = 20 }: { chain: VenueChain; size?: number }) {
  const gradientId = useId();
  const common = { width: size, height: size, viewBox: '0 0 32 32', 'aria-hidden': true, focusable: false } as const;
  switch (chain) {
    case 'ethereum':
      return (
        <svg {...common} data-chain-icon="ethereum">
          <circle cx="16" cy="16" r="16" fill="#627EEA" />
          <g fill="#FFF">
            <path fillOpacity=".602" d="M16.498 4v8.87l7.497 3.35z" />
            <path d="M16.498 4L9 16.22l7.498-3.35z" />
            <path fillOpacity=".602" d="M16.498 21.968v6.027L24 17.616z" />
            <path d="M16.498 27.995v-6.028L9 17.616z" />
            <path fillOpacity=".2" d="M16.498 20.573l7.497-4.353-7.497-3.348z" />
            <path fillOpacity=".602" d="M9 16.22l7.498 4.353v-7.701z" />
          </g>
        </svg>
      );
    case 'base':
      return (
        <svg {...common} data-chain-icon="base">
          <rect width="32" height="32" rx="8" fill="#0052FF" />
        </svg>
      );
    case 'robinhood':
      return (
        <svg {...common} data-chain-icon="robinhood">
          <rect width="32" height="32" rx="8" fill="#CCFF00" />
          <path
            d="M24.5 6.5c-6.3.6-11.2 5.2-12.6 11.6l-.7 3.2-3.7 4.9 1.5.9 3.4-4.6 3.4-.8c5.9-1.4 9.6-7.1 8.7-15.2zm-9.4 13.3l4.6-6.6"
            fill="#111"
            stroke="#111"
            strokeWidth=".6"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'solana':
      return (
        <svg {...common} data-chain-icon="solana">
          <defs>
            <linearGradient id={gradientId} x1="7" y1="24" x2="25" y2="8" gradientUnits="userSpaceOnUse">
              <stop offset="0" stopColor="#9945FF" />
              <stop offset="1" stopColor="#14F195" />
            </linearGradient>
          </defs>
          <circle cx="16" cy="16" r="16" fill="#111" />
          <g fill={`url(#${gradientId})`}>
            <path d="M11.2 9.4h13.2l-2.8 3H8.4z" />
            <path d="M8.4 14.5h13.2l2.8 3H11.2z" />
            <path d="M11.2 19.6h13.2l-2.8 3H8.4z" />
          </g>
        </svg>
      );
  }
}
