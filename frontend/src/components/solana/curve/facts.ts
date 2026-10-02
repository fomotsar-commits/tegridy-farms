import type { PublicKey } from '@solana/web3.js';
import type { Read } from '../../../lib/launcher/solana/curve';
import type { LaunchOrigin } from './ports';

/** A number we either read or could not. "Could not read" never renders as 0. */
export type Fact<T> = { kind: 'ok'; value: T } | { kind: 'unreadable'; detail: string };

function why(r: Exclude<Read<unknown>, { kind: 'ok' }>, absent: string): string {
  return r.kind === 'unreadable' ? r.detail : r.kind === 'absent' ? absent : `it did not decode (${r.reason})`;
}

const NOT_FOUND = 'the launch transaction could not be found';

/** The maker's create-buy: what the maker's own wallet got in the launch transaction, and what every other wallet got in it. */
export interface MakerBuy {
  tokens: bigint;
  othersTokens: bigint;
  /** How many other wallets got any. */
  others: number;
  /** The whole supply right after the launch transaction: the share is of this, never of today's supply. */
  birthSupply: bigint;
}

/** The $BAYLA a launch transaction burned and sent to the island's Workshop, in base units. */
export type PlantMoved = NonNullable<LaunchOrigin['plant']>;

/** The maker's figure from the per-wallet read: only the maker's own wallet counts as the maker's. */
export function makerBuyFact(maker: PublicKey, byOwner: LaunchOrigin['boughtByOwner'], birthSupply: bigint | null): Fact<MakerBuy> {
  if (byOwner === null || birthSupply === null || birthSupply <= 0n) {
    return { kind: 'unreadable', detail: 'the launch transaction’s token balances could not be read' };
  }
  let tokens = 0n;
  let othersTokens = 0n;
  let others = 0;
  for (const b of byOwner) {
    if (b.tokens <= 0n) continue;
    if (b.owner.equals(maker)) tokens += b.tokens;
    else {
      othersTokens += b.tokens;
      others++;
    }
  }
  return { kind: 'ok', value: { tokens, othersTokens, others, birthSupply } };
}

/** The maker's figure for the launch whose account names `creator`; a transaction naming anyone else is not read as it. */
export function makerBuyFromOrigin(r: Read<LaunchOrigin>, creator: PublicKey): Fact<MakerBuy> {
  if (r.kind !== 'ok') return { kind: 'unreadable', detail: why(r, NOT_FOUND) };
  if (!r.value.creator.equals(creator)) {
    return { kind: 'unreadable', detail: 'the launch transaction found names another maker than the launch account' };
  }
  return makerBuyFact(creator, r.value.boughtByOwner, r.value.birthSupply);
}

export function plantFromOrigin(r: Read<LaunchOrigin>): Fact<PlantMoved> {
  if (r.kind !== 'ok') return { kind: 'unreadable', detail: why(r, NOT_FOUND) };
  if (r.value.plant === null) return { kind: 'unreadable', detail: 'the launch transaction’s $BAYLA balances could not be read' };
  return { kind: 'ok', value: r.value.plant };
}

export function holdingFact(r: Read<{ amount: bigint; accountExists: boolean }>): Fact<bigint> {
  if (r.kind === 'ok') return { kind: 'ok', value: r.value.amount };
  return { kind: 'unreadable', detail: why(r, 'no answer') };
}
