import { CopyButton } from './CopyButton';

/** An address's head and tail, as a coin's name wears it: "7hmV … pump". Never what leaves the page: the press copies the whole address. */
export function headTail(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)} … ${address.slice(-4)}` : address;
}

/**
 * A coin's name as a press that copies its whole address (island answer twenty-four, §4):
 * the name, its head and tail beside it, "Copied" for one second, the phone's tick where
 * the browser gives one. One component for the swap's picker, the pool rows, a room's
 * header and the panels, so every coin on the venue copies the same way.
 */
export function CoinName({ name, address, className = '', nameClassName = '', addressClassName = 'text-white/55' }: {
  name: string;
  address: string;
  className?: string;
  nameClassName?: string;
  addressClassName?: string;
}) {
  return (
    <CopyButton
      text={address}
      copiedMs={1000}
      copiedWord="Copied"
      aria-label={`${name}: copy its address ${address}`}
      className={`min-h-[44px] max-w-full gap-2 ${className}`}
      testId="coin-name"
    >
      <span className={`font-semibold ${nameClassName}`}>{name}</span>
      <span className={`font-mono text-[11px] ${addressClassName}`}>{headTail(address)}</span>
    </CopyButton>
  );
}
