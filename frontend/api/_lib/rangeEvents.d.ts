/** The range program's id (rangeEvents.js). */
export const RANGE_PROGRAM_ID: string;
export const POOL_STATE: Readonly<Record<string, number | number[]>>;
export const AMM_CONFIG: Readonly<Record<string, number | number[]>>;
export const EVENTS: Readonly<Record<'SwapEvent' | 'CollectProtocolFeeEvent' | 'PoolCreatedEvent', { disc: string; fields: [string, string][] }>>;
export const COLLECT_BY: Readonly<Record<string, 'vault' | 'workshop'>>;
export function eventLength(name: keyof typeof EVENTS): number;
export function base58(bytes: Uint8Array): string;
export function fromBase64(s: string): Uint8Array;

export interface RangePoolCounters {
  ammConfig: string;
  mint0: string;
  mint1: string;
  vault0: string;
  vault1: string;
  decimals0: number;
  decimals1: number;
  tickSpacing: number;
  sqrtPriceX64: bigint;
  protocolFees0: bigint;
  protocolFees1: bigint;
  fundFees0: bigint;
  fundFees1: bigint;
}
export function decodePool(data: string | Uint8Array): RangePoolCounters;
export function decodeAmmConfigRates(data: string | Uint8Array): { tradeFeeRate: number; protocolFeeRate: number; fundFeeRate: number };

export interface RangeSwapEvent {
  name: 'SwapEvent';
  pool: string;
  sender: string;
  tokenAccount0: string;
  tokenAccount1: string;
  amount0: bigint;
  transferFee0: bigint;
  amount1: bigint;
  transferFee1: bigint;
  zeroForOne: boolean;
  sqrtPriceX64: bigint;
  liquidity: bigint;
  tick: number;
  tradeFee0: bigint;
  tradeFee1: bigint;
}
export interface RangeCollectEvent {
  name: 'CollectProtocolFeeEvent';
  pool: string;
  recipient0: string;
  recipient1: string;
  amount0: bigint;
  amount1: bigint;
  /** Who collected: the team's vault (collect_protocol_fee) or the Workshop (collect_fund_fee). */
  by?: 'vault' | 'workshop';
}
export interface RangePoolCreatedEvent {
  name: 'PoolCreatedEvent';
  mint0: string;
  mint1: string;
  tickSpacing: number;
  pool: string;
  sqrtPriceX64: bigint;
  tick: number;
  vault0: string;
  vault1: string;
}
export type RangeEvent = RangeSwapEvent | RangeCollectEvent | RangePoolCreatedEvent;
export function decodeEvent(data: Uint8Array): RangeEvent | null;

export function programFrames(logMessages: string[], programId?: string): { truncated: boolean; malformed: boolean; events: { ix: string | null; data: string }[] };

export type RangeTxRead =
  | { status: 'failed' | 'no-log' | 'truncated' | 'malformed' }
  | { status: 'undecodable'; why: string }
  | { status: 'ok'; events: (RangeEvent & { index: number })[] };
/** A getTransaction answer (encoding "json"); only `meta.err` and `meta.logMessages` are read. */
export function rangeTxEvents(tx: { meta?: { err?: unknown; logMessages?: string[] | null } } | null | undefined, programId?: string): RangeTxRead;
