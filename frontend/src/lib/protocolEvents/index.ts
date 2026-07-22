// Proof-of-life protocol-events core — public barrel.
//
// Pure, network-free, React-free. The React seam (wallet reads + cross-poll memory)
// lives in src/hooks/useProtocolEvents.ts, which imports from here.

export type { PulseItem, PulseKind } from './types';

export {
  diffCounters,
  DEFAULT_DELTA_THRESHOLDS,
} from './onchainDeltas';
export type {
  RevenueSnapshot,
  PolSnapshot,
  CounterSnapshot,
  DeltaThresholds,
} from './onchainDeltas';

export { launchOutcomesToEvents } from './launchEvents';
export type { LaunchEventOptions } from './launchEvents';

export { mergeProtocolEvents } from './merge';
export type { MergeOptions } from './merge';
