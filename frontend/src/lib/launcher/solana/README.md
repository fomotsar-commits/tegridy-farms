# Solana launcher — Meteora Dynamic Bonding Curve (DBC) leg

**Sub-brand, fee-capture only, gated.** This module lets the Tegridy sub-brand
launch memecoins on Solana through Meteora's audited **Dynamic Bonding Curve**
program and skim a partner trading fee — with **no TOWELI on Solana** and **no
custom Rust program of our own**.

- `dbc.ts` — **pure param builders + the Squads-vault invariant.** It never opens
  a `Connection`, never signs, and imports the SDK **type-only** (zero runtime
  SDK weight, matching the `airlock.ts` façade doctrine). It emits typed
  descriptors the operator's out-of-band signing wrapper feeds into the real SDK.
- `dbc.test.ts` — validation of the invariants below.

## Why the fee claimer MUST be a Squads vault

Meteora's `claimPartnerTradingFee` signer (`feeClaimer`) has **full custody** of
accrued partner fees — it can name **any** receiver on each claim. An EOA fee
claimer is therefore a single-key drain of all Solana revenue. So:

- `buildDbcPartnerConfig` refuses to build unless `feeClaimer` (and
  `leftoverReceiver`) are affirmed **Squads v4 vaults** (`asSquadsVault`).
- `claimPartnerFeesParams` refuses to build unless **both** the `feeClaimer`
  **and** the `receiver` are Squads vaults — fees can never be redirected to an EOA.

`asSquadsVault` is a syntactic + affirmation gate (rejects empty / malformed /
the default `1111…1111` system pubkey and brands the string). Off-chain we can't
prove multisig ownership without RPC, so **the wrapper SHOULD additionally verify
on-chain that the account is owned by the Squads program before the first real
launch.**

## Fee economics (disclosed, never a hidden dial)

Meteora takes a **fixed 20%** of every trade fee (`METEORA_PROTOCOL_FEE_PERCENT`).
The remaining **80%** is split creator/partner by `creatorTradingFeePercentage`
(creator's % of that 80%; default **60 → creator-majority**: 48% of total to the
creator, 32% to the Tegridy partner vault). `splitTradingFee()` computes the
published breakdown for the Fact Sheet.

**Anti-snipe:** launches open with a Jupiter-Studio-style decaying fee scheduler
(`DEFAULT_ANTI_SNIPE`: 99% → 1% exponential decay over 6h) so block-0 sniping is
unprofitable. The schedule is validated against the program's `[25, 9900]` bps
bounds and 12h max decay window.

**Token safety:** the curve pins an **immutable, no-mint** SPL token
(`TokenAuthorityOption.Immutable`), fees collected in the quote token, migration
to **DAMM v2**, and (by default) **100% partner-permanent-locked** migrated LP so
LP fees stream to the vault forever — the fee-capture flywheel.

## Verified program constants (mainnet-beta == devnet)

| Const | Value |
| --- | --- |
| `DYNAMIC_BONDING_CURVE_PROGRAM_ID` | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` |
| `LOCKER_PROGRAM_ID` | `LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn` |
| Meteora protocol fee | 20% |
| Fee bps bounds | `[25, 9900]` |
| Max anti-snipe decay | 43 200 s (12h) |

Network is chosen **only** by the RPC endpoint of the `Connection` you pass.

## Operator flow (the thin signing wrapper — out of band, not in the bundle)

`dbc.ts` produces base58/bigint descriptors. The operator's signing script maps
them to web3.js `PublicKey` / `BN` just before submitting:

```ts
import {
  DynamicBondingCurveClient,
  buildCurveWithMarketCap,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { PublicKey, Keypair, Connection } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
import {
  asSquadsVault,
  buildDbcPartnerConfig,
  buildLaunchParams,
  claimPartnerFeesParams,
  isSolanaLauncherEnabled,
} from './dbc';

if (!isSolanaLauncherEnabled()) throw new Error('Solana launcher is gated');

const connection = new Connection(RPC_URL, 'confirmed');
const client = DynamicBondingCurveClient.create(connection, 'confirmed');

// 1) Partner config-key (once). `config` is a fresh keypair that must sign.
const configKp = Keypair.generate();
const vault = asSquadsVault(SQUADS_VAULT_BASE58);
const { curve, accounts } = buildDbcPartnerConfig({
  feeClaimer: vault,
  config: configKp.publicKey.toBase58(),
  payer: payer.publicKey.toBase58(),
  initialMarketCap: 5_000,
  migrationMarketCap: 50_000, // quote-token units
});
const configParams = buildCurveWithMarketCap(curve); // → ConfigParameters
const cfgTx = await client.partner.createConfig({
  config: new PublicKey(accounts.config),
  feeClaimer: new PublicKey(accounts.feeClaimer),
  leftoverReceiver: new PublicKey(accounts.leftoverReceiver),
  quoteMint: new PublicKey(accounts.quoteMint),
  payer: new PublicKey(accounts.payer),
  ...configParams,
});
// sign with [payer, configKp] and send.

// 2) Launch a token against the config key.
const baseMintKp = Keypair.generate();
const p = buildLaunchParams(
  {
    config: accounts.config,
    baseMint: baseMintKp.publicKey.toBase58(),
    poolCreator: creator.toBase58(),
    payer: payer.publicKey.toBase58(),
  },
  { name: 'Tegridy Meme', symbol: 'TMEME', uri: 'ipfs://…' },
);
const poolTx = await client.pool.createPool({
  name: p.name,
  symbol: p.symbol,
  uri: p.uri,
  config: new PublicKey(p.config),
  baseMint: new PublicKey(p.baseMint),
  poolCreator: new PublicKey(p.poolCreator),
  payer: new PublicKey(p.payer),
});
// sign with [payer, baseMintKp] and send.

// 3) Claim partner fees to the vault (never an EOA).
const c = claimPartnerFeesParams({ feeClaimer: vault, pool: POOL_BASE58, payer: payer.publicKey.toBase58() });
const claimTx = await client.partner.claimPartnerTradingFee({
  feeClaimer: new PublicKey(c.feeClaimer),
  payer: new PublicKey(c.payer),
  pool: new PublicKey(c.pool),
  receiver: new PublicKey(c.receiver),
  maxBaseAmount: new BN(c.maxBaseAmount.toString()),
  maxQuoteAmount: new BN(c.maxQuoteAmount.toString()),
});
```

## Gating + wizard integration (not yet wired)

`SOLANA_LAUNCHER_ENABLED = false` in `dbc.ts`; `isSolanaLauncherEnabled()` is the
gate. To surface a gated Solana launch wizard later:

1. Build `frontend/src/pages/SolanaLaunchPage.tsx` that renders the standard
   "SOON" placeholder while `!isSolanaLauncherEnabled()`, mirroring the EVM
   launcher's `isLauncherEnabled()` gate in `../config.ts`.
2. Behind the gate: collect token meta + market-cap band, call the builders here
   to preview the Fact Sheet (fee split, anti-snipe schedule, LP lock), and hand
   the descriptors to the operator signing wrapper — the submit path stays
   unreachable until an operator flips `SOLANA_LAUNCHER_ENABLED` **and** a real
   Squads vault is configured.

No new dependencies; the SDK and `@solana/web3.js` are already installed.
