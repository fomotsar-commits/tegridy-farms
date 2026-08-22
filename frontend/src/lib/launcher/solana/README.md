# Solana launcher — Meteora Dynamic Bonding Curve (DBC) leg

**Sub-brand, fee-capture only, gated.** This module lets the Tegridy sub-brand
launch memecoins on Solana through Meteora's audited **Dynamic Bonding Curve**
program and skim a partner trading fee — with **no TOWELI on Solana** and **no
custom Rust program of our own**.

- `dbc.ts` — **pure param builders + the Squads-vault invariant.** It never opens
  a `Connection`, never signs, and imports the SDK **type-only** (zero runtime
  SDK weight, matching the `airlock.ts` façade doctrine). It emits typed
  descriptors the operator's out-of-band signing wrapper feeds into the real SDK.
- `squads.ts` — **on-chain Squads v4 vault verification.** Derives the canonical
  vault PDA from a multisig + vault index (`deriveSquadsVaultPda`) and confirms it
  on-chain (`verifySquadsVault`). This is the real invariant behind the off-chain
  `SquadsVault` brand — see "Why the fee claimer MUST be a Squads vault" below.
- `dbcClient.ts` — **the thin signing wrapper** (out of band, never bundled). Pulls
  in the real `@meteora-ag` SDK, maps `dbc.ts`'s base58/bigint descriptors to
  web3.js `PublicKey` / anchor `BN`, verifies every fee authority is a Squads vault
  on-chain, and partial-signs the ephemeral keypairs it owns. Exports
  `createPartnerConfig` / `launchToken` / `claimPartnerFees`.
- `../../../../scripts/solana-dbc-operator.mjs` — **the runnable operator harness**
  that drives `dbcClient.ts` from the CLI (config from ENV/CLI only). See "Operator
  flow" below.
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
the default `1111…1111` system pubkey and brands the string). Off-chain it
**cannot** prove multisig custody — that needs an RPC round-trip — so the wrapper
verifies it on-chain via `squads.ts` before building any real tx.

**The verification is subtle** (see `squads.ts` for the full rationale): the real
Squads v4 vault is a **System-owned PDA** derived from the multisig
(`seeds = ["multisig", <multisig>, "vault", u8 index]`), **not** the Squads-owned
config account. A naive "owner == Squads program" check would therefore *reject the
real vault* and only pass the config account — which can never sign a claim — a
funds-lock trap. Instead, the operator supplies each fee address **together with its
provenance** (parent multisig + vault index) as a `vaultProvenance` map. The wrapper
(1) re-derives the canonical vault PDA from that provenance and requires the fee
address to equal it, (2) confirms the parent multisig account is Squads-owned, and
(3) confirms that parent is a genuine `Multisig` account — matched on its 8-byte
Anchor discriminator — whose **threshold is >= 2**. Step (3) is what rejects both a
1-of-1 multisig (a single-key drain wearing a multisig's clothes) and any other
Squads-owned account type. Missing provenance for any vault **fails closed**.

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

That default is a *fallback*, not a recommendation: a 99% opening fee makes a
launch effectively untradeable for most of its first day, and a DBC config cannot
be edited afterwards. `create-config` therefore takes `--opening-fee-bps`,
`--resting-fee-bps` and `--decay-seconds` (`feeSchedule.ts`), prints what it
resolved, and refuses an opening fee above 5000 bps without an explicit
`--i-understand-anti-snipe`.

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

## Operator flow (the harness + the signing wrapper — out of band, not in the bundle)

`dbc.ts` produces base58/bigint descriptors. **`dbcClient.ts`** maps them to web3.js
`PublicKey` / anchor `BN`, verifies the vault provenance on-chain, stamps the
`feePayer` + `recentBlockhash` the Meteora SDK never sets (anchor's `.transaction()`
returns a bare `new Transaction()`; without both, `partialSign`/`serialize` throw and
nothing can be built at all), partial-signs the ephemeral keypairs, and returns the tx.
**`scripts/solana-dbc-operator.mjs`** is the
runnable driver — it reads every secret from ENV/CLI (nothing hardcoded), derives the
Squads vault PDA from the multisig + vault index, and either prints the partial-signed
tx (default, for out-of-band Squads co-signing) or broadcasts it (`--send`).

### Run it

Runs on the repo's Node 24 with **no extra deps and no build step** — an inline
`module.register` loader makes the bundler-targeted TS graph load under Node
(extensionless `.ts` resolution, `stripTypeScriptTypes`, an `import.meta.env` shim for
`solana.ts`, and the `@coral-xyz/anchor` `BN` CJS-interop rewrite). Run from `frontend/`:

```sh
# Pure helper — print the vault PDA for a multisig + index (no RPC, no gate):
SQUADS_MULTISIG=<multisig-base58> SQUADS_VAULT_INDEX=0 \
  node scripts/solana-dbc-operator.mjs derive-vault

# 1) Partner config-key (once per fee policy):
SOLANA_RPC_URL=https://your-keyed-rpc \
OPERATOR_KEYPAIR=/abs/path/payer.json \
SQUADS_MULTISIG=<multisig-base58> SQUADS_VAULT_INDEX=0 \
  node scripts/solana-dbc-operator.mjs create-config \
    --initial-market-cap 5000 --migration-market-cap 50000 \
    --opening-fee-bps 2000 --resting-fee-bps 100 --decay-seconds 21600
# → prints the resolved FEE SCHEDULE, the CONFIG ADDRESS (record it), and a
#   partial-signed tx (or --send).
#
# State the fee schedule. Omitting those three flags inherits DEFAULT_ANTI_SNIPE
# (9900 bps opening = 99%), and a DBC config is IMMUTABLE — the only correction is
# a new config and a new Squads ceremony. create-config REFUSES an opening fee
# above 5000 bps unless --i-understand-anti-snipe is passed, and prints whatever it
# resolved before the transaction.

# 2) Launch a token against that config key:
SOLANA_RPC_URL=… OPERATOR_KEYPAIR=… \
  node scripts/solana-dbc-operator.mjs launch \
    --config <config-address> --name 'Tegridy Meme' --symbol TMEME --uri ipfs://…

# 3) Claim partner fees back to the vault (print-only — the vault co-signs in Squads):
SOLANA_RPC_URL=… OPERATOR_KEYPAIR=… \
SQUADS_MULTISIG=<multisig-base58> SQUADS_VAULT_INDEX=0 \
  node scripts/solana-dbc-operator.mjs claim --pool <pool-address>
```

`node scripts/solana-dbc-operator.mjs help` lists every flag.

### The wrapper API it drives

The harness calls these three `dbcClient.ts` entry points. Each takes a
`vaultProvenance` map (`{ [vaultAddress]: { multisig, vaultIndex } }`) that the
harness builds from `SQUADS_MULTISIG` + `SQUADS_VAULT_INDEX`, and each throws while
`SOLANA_LAUNCHER_ENABLED === false`:

```ts
import { DynamicBondingCurveClient } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Keypair } from '@solana/web3.js';
import { asSquadsVault, buildDbcPartnerConfig, buildLaunchParams, claimPartnerFeesParams } from './dbc';
import { deriveSquadsVaultPda } from './squads';
import { createPartnerConfig, launchToken, claimPartnerFees } from './dbcClient';

const client = DynamicBondingCurveClient.create(connection, 'confirmed');

// Derive the vault PDA from provenance so the on-chain address ALWAYS matches what
// the wrapper re-derives + verifies (verifySquadsVault). A wrong index fails closed.
const vaultAddr = deriveSquadsVaultPda(SQUADS_MULTISIG, SQUADS_VAULT_INDEX);
const vault = asSquadsVault(vaultAddr);
const vaultProvenance = { [vaultAddr]: { multisig: SQUADS_MULTISIG, vaultIndex: SQUADS_VAULT_INDEX } };

// 1) createConfig — the wrapper runs buildCurveWithMarketCap + client.partner.createConfig,
//    verifies feeClaimer + leftoverReceiver on-chain, and partial-signs configKp.
const configKp = Keypair.generate();
const partnerConfig = buildDbcPartnerConfig({
  feeClaimer: vault,
  config: configKp.publicKey.toBase58(),
  payer: payer.publicKey.toBase58(),
  initialMarketCap: 5_000,
  migrationMarketCap: 50_000, // quote-token units
});
const cfgTx = await createPartnerConfig(client, partnerConfig, signerOrUndefined, configKp, vaultProvenance);

// 2) launchToken — the wrapper calls client.creator.createPool (NOT client.pool) and
//    partial-signs the base-mint keypair. No vault verify here: the fee authority is
//    inherited from the config created above.
const baseMintKp = Keypair.generate();
const launchParams = buildLaunchParams(
  { config: partnerConfig.accounts.config, baseMint: baseMintKp.publicKey.toBase58(), poolCreator, payer },
  { name: 'Tegridy Meme', symbol: 'TMEME', uri: 'ipfs://…' },
);
const poolTx = await launchToken(client, launchParams, signerOrUndefined, baseMintKp);

// 3) claimPartnerFees — the wrapper verifies feeClaimer AND receiver are the vault,
//    then calls client.partner.claimPartnerTradingFeeToReceiver (explicit receiver).
const claimParams = claimPartnerFeesParams({ feeClaimer: vault, receiver: vault, pool: POOL, payer });
const claimTx = await claimPartnerFees(client, claimParams, undefined, vaultProvenance);
```

`signerOrUndefined` is a `WalletSigner` (a `signTransaction`-capable wallet) when you
want the wrapper to co-sign, or `undefined` to get the partial-signed tx back for
out-of-band Squads co-signing. **A `claim` is always co-signed by the vault** (a Squads
PDA that signs via `invoke_signed`), so it can never be broadcast by the operator alone
— the harness rejects `claim --send`.

### Blockhash / expiry

Every returned tx carries `feePayer` (the descriptor's `payer`), `recentBlockhash` and
`lastValidBlockHeight`. The blockhash is fetched at **`finalized`** commitment — a
confirmed-only blockhash can be dropped by a fork switch and would silently invalidate a
tx sitting in a multisig ceremony — and is fetched *after* the vault verification so the
operator gets the largest share of the window. The window is ~150 slots (~60-90s) and
the harness prints the remaining slots next to the base64.

That window binds **only** if you co-sign and broadcast the printed transaction as-is.
Importing it into a Squads proposal stores the *instructions*; the later
`vaultTransactionExecute` carries its own fresh blockhash, so an expired print is
harmless on that path. A durable nonce would remove the window outright but needs a
funded nonce account plus a nonce-authority signature on every build — new on-chain
state and a second signer for a problem the Squads path does not have.

## Gating + wizard integration (preview page LIVE; no in-app submit)

`SOLANA_LAUNCHER_ENABLED = true` in `dbc.ts` since 2026-07-27 — `/solana-launch` renders a
config PREVIEW with no signer and no submit path. `isSolanaLauncherEnabled()` is the
gate. To surface a gated Solana launch wizard later:

1. ~~Build `frontend/src/pages/SolanaLaunchPage.tsx`~~ — **DONE.** It exists and is
   routed at `frontend/src/App.tsx`. It collects token meta + market-cap band and
   previews the Fact Sheet (fee split, anti-snipe schedule, LP lock) from the builders
   here. It has **no signer and no submit path** — that is the design, not an omission.
2. ~~**Still open before a first real Solana launch**~~ — **both cleared 2026-08-01:**
   - ✅ A DBC partner config of ours now exists on **mainnet** — `create-config --send`
     has been run by the operator, so there *is* something to launch against. What has
     **not** happened is a launch: no token has gone through this rail yet, and the
     Fact-Sheet numbers on `/solana-launch` remain builder defaults, not observed history.
   - ✅ `verifySquadsVault` (squads.ts) now enforces the account **discriminator and a
     threshold >= 2**. It previously checked only program-ownership and PDA derivation,
     so a Squads *ProgramConfig* fed in place of a `Multisig` would pass — producing a
     config whose `feeClaimer` no one can ever sign for, stranding 100% of partner fees
     irreversibly. That guard is closed; a 1-of-1 multisig is now rejected too.

No new dependencies; the SDK and `@solana/web3.js` are already installed.

## Not part of this leg — `curve/`

The `curve/` subdirectory lives here but belongs to a **different program**: our own
`tegridy-launch` bonding curve (`solana/tegridy-amm/programs/tegridy-launch/`), not
Meteora's DBC. It is the **single** implementation of that program's client — quote
maths, account decoders, instruction builders, reads, plot geometry, operator pre-flight
and formatting — and it serves `/curve-launch`, `components/launcher/CurveChart.tsx` and
`scripts/tegridy-launch-operator.mjs` alike.

`CurveLaunchPage` mounts `CurveChart` (always `source: 'chain'`, only where a decoded
`curve` account is in hand), so the plotted curve and the numbers beside it come from
one read and one derivation. The chart shipped built, tested and rendered by nothing
for a while — `CurveLaunchPage.test.tsx` now asserts it is on screen, because the
chart's own suite renders the component directly and cannot see that it is unmounted.

**That program has been live on mainnet since 2026-08-08**
(`CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED`, slot 438,055,726), with `global`
initialized. This paragraph said "not deployed to any cluster" for four days afterwards.

What is still true, and is the part that mattered: no surface may imply a market it has
not read. `readDeployment` runs before anything else, and **graduation does not work** —
cp-swap's `AmmConfig` does not exist, so `migrate_to_amm` fails `AmmNotConfigured`
(6015) until an operator runs `create-amm-config` and then `update-global` on
`scripts/tegridy-launch-operator.mjs`. The interface these files are written against is
`docs/OWN_CURVE_FRONTEND_CONTRACT.md`, which also lists what each file in `curve/` owns.

⚠️ `curve/math.ts` is the only place quote arithmetic for this program may live. The
page, the chart and the operator CLI each once carried their own transcription of
`curve.rs`; they disagreed, and one of the disagreements was a real bug (the `u128`
ceiling on the two config-time functions). Adding a fourth copy is a defect, whatever
it is for.
