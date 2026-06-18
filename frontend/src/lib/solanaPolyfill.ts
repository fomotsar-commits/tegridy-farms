// Buffer / global polyfill for the Solana libs (@solana/web3.js, @solana/
// spl-token, wallet-adapter), which assume a Node-ish `global` and `Buffer`.
// The EVM stack (viem/ethers) needs neither, so vite.config installs no global
// polyfill. We scope this to the lazy Solana chunk by importing THIS module
// FIRST — before any @solana/* import — in both the Solana page entry and the
// providers. ES modules evaluate imports depth-first in source order, so Buffer
// and global are installed before web3.js's top-level code runs.
//
// Side-effect-only module: `import '../lib/solanaPolyfill';`
import { Buffer } from 'buffer';

const g = globalThis as unknown as { Buffer?: typeof Buffer; global?: typeof globalThis };
if (typeof g.Buffer === 'undefined') g.Buffer = Buffer;
if (typeof g.global === 'undefined') g.global = globalThis;
