import type { Read } from '../../../lib/launcher/solana/curve';
import type { LaunchOrigin } from './ports';

/** A number we either read or could not. "Could not read" never renders as 0. */
export type Fact<T> = { kind: 'ok'; value: T } | { kind: 'unreadable'; detail: string };

function why(r: Exclude<Read<unknown>, { kind: 'ok' }>, absent: string): string {
  return r.kind === 'unreadable' ? r.detail : r.kind === 'absent' ? absent : `it did not decode (${r.reason})`;
}

/** Tokens bought in the launch transaction by any wallet, from its token balances. */
export function openingBuyFact(tokens: bigint | null): Fact<bigint> {
  return tokens === null
    ? { kind: 'unreadable', detail: 'the launch transaction’s token balances could not be read' }
    : { kind: 'ok', value: tokens };
}

export function openingBuyFromOrigin(r: Read<LaunchOrigin>): Fact<bigint> {
  if (r.kind === 'ok') return openingBuyFact(r.value.openingBuyTokens);
  return { kind: 'unreadable', detail: why(r, 'the launch transaction could not be found') };
}

export function holdingFact(r: Read<{ amount: bigint; accountExists: boolean }>): Fact<bigint> {
  if (r.kind === 'ok') return { kind: 'ok', value: r.value.amount };
  return { kind: 'unreadable', detail: why(r, 'no answer') };
}
