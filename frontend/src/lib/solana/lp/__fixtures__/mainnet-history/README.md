# The venue's real history on mainnet, as the node answered it

Raw JSON-RPC answers from Solana mainnet, read 2026-10-04T18:23Z through the keyless public RPC
(`https://api.mainnet-beta.solana.com`) at `finalized`, by `pull-mainnet-history.mjs` (the Wave 1
design session's `fixtures/` folder; it is not in this repo, and it signed and sent nothing). The reads
landed between slots 453336132 and 453336182; the newest transaction here is at slot 453333235
(2026-10-04T18:11:12Z). Nothing is edited. JSON only; no raw bytes.

| File | Method | Address |
|---|---|---|
| `pool.baylaSol.signatures.json` | `getSignaturesForAddress`, limit 1000, newest first | BAYLA/SOL pool `ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4` (8 entries) |
| `pool.baylaSol.transactions.json` | `getTransaction`, `encoding: 'json'`, `maxSupportedTransactionVersion: 0`; one row per signature, `{ signature, slot, blockTime, err, tx }` | the same pool |
| `owner.lp.D2CYpj.signatures.json`, `owner.lp.D2CYpj.transactions.json` | the same two methods | the owner's BAYLA/SOL share account `D2CYpjwm38TbHfwdLFw9Eh9hcxoUAMXJdWn33e7YEb93` (1 deposit) |
| `opener.lp.DKxZsj.signatures.json`, `opener.lp.DKxZsj.transactions.json` | the same two methods | the opener's share account `DKxZsjMKVtoRedcHuPRsjnso9Ezj6jVHwSmqnQwU3RJm` (the initialize and 1 deposit) |

What the history carries, read from these files: every transaction is legacy (no lookup table),
succeeded, and holds one top-level cp-swap instruction (program `EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT`):
the initialize at slot 453025316 and seven deposits from six wallets. No swap has ever reached the pool.
`txHistory.test.ts` pins the parse of all eight and the owner's deposit to the base unit; the ledger and
pool-past tests read them through `fakeRpcWithHistory` in `testkit.fixture.ts`.
