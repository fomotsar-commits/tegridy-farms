// The write path for /curve-launch: launch, buy, sell, graduate, release, pool swap.
//
// Load this module with a DYNAMIC import behind `isCurveWriteEnabled()`
// (`../curveWriteFlag`), so a build with writes off never downloads it.
//
//   config.ts    gate 1 (committed ids in production) and gate 2 (the chain), and
//                which actions may be offered
//   launch.ts    create a launch in one signature (mint, locked details, launch,
//                optional opening buy)
//   trade.ts     curve buy / sell
//   graduate.ts  finish graduation, release the platform reserve
//   poolSwap.ts  buy / sell in the graduated launch's own pool
//   prepare.ts   the one simulate-check-summarize path all of them use
//   intent.ts    decode a transaction back into steps; refuse any shape we never build
//   submit.ts    wallet signs only; we broadcast, re-send and settle the outcome
//   errors.ts    whose error, in plain English
//   budget.ts    compute limit and a capped priority fee
//   metaplex.ts  the Token Metadata instruction, encoded by hand
//
// Nothing here renders anything.

export * from './types';
export * from './config';
export * from './launch';
export * from './trade';
export * from './graduate';
export * from './poolSwap';
export * from './submit';
export * from './errors';
export {
  MAX_OWN_PRIORITY_LAMPORTS,
  MAX_COMPUTE_UNITS,
  LAMPORTS_PER_SIGNATURE,
} from './budget';
export { TX_SIZE_LIMIT } from './prepare';
export { decodeIntent, LIGHTHOUSE_PROGRAM_ID } from './intent';
export * from '../discover/metadata';
export * from '../discover/list';
export * from '../discover/pool';
