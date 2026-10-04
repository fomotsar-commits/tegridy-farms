// Where the site's swap fee goes on a trade through one of our own pools.
//
// Derived, never typed: the team vault's associated wrapped-SOL account. It is the same
// account Jupiter's SOL-side platform fee lands in (jupiter.ts feeAccountFor(SOL_MINT)
// with the vault as VITE_SOLANA_FEE_ACCOUNT) and the pool program's opening-fee
// receiver (write/config.ts CP_CREATE_POOL_FEE_RECEIVER); siteFee.test.ts pins all three
// equal.
//
// OUR ROUTE NEVER SYNCS THIS ACCOUNT. The fee is one TransferChecked of wrapped SOL into
// it. A System transfer plus SyncNative would make mainnet's token program re-price the
// account's stored rent reserve and credit it far more than the fee (write/wsol.ts
// syncCredit).
//
// Kept apart from siteFee.ts on purpose: the derivation runs when this module loads and
// throws under jsdom (a realm mismatch inside web3.js), so only code that already
// derives addresses (the write layer, node tests) imports this file.

import { PLATFORM_TREASURY_VAULT, WSOL_MINT } from '../../launcher/solana/curve/program';
import { associatedTokenAddress } from '../../launcher/solana/curve/ix';

/** ATA(wSOL, PLATFORM_TREASURY_VAULT) under the classic token program. The vault is off-curve; the derivation allows that. */
export const SITE_FEE_WSOL_ACCOUNT = associatedTokenAddress(WSOL_MINT, PLATFORM_TREASURY_VAULT);
