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

## The same pool on 2026-10-10, after its first three swaps

Read again 2026-10-10T03:20Z from the same RPC, the same two methods and the same options, at
`finalized`. Nothing is edited. The eight rows above came back identical, entry for entry.

| File | What |
|---|---|
| `pool.baylaSol.2026-10-10.signatures.json` | the pool's whole history: 34 entries, newest first (slot 455001013, 2026-10-09T21:03:24Z) |
| `pool.baylaSol.2026-10-10.transactions.json` | one row per signature, the same row shape as above |
| `opener.lp.DKxZsj.2026-10-10.signatures.json` | the opener's share account `DKxZsjMKVtoRedcHuPRsjnso9Ezj6jVHwSmqnQwU3RJm`: 4 entries. Its transactions are four of the pool's 34 rows, so they are not stored twice |

What the history carries: every transaction is legacy and succeeded; the initialize, 30 deposits from
19 wallets, 3 swaps (wrapped SOL in: 10,000,000, 369,000,000 and 122,000,000 lamports), no withdrawal.
The pool was unchanged between the newest row and the read: at slot 455105163 its SOL vault held
25,648,407,921 lamports (801,600 of them the venue's uncollected cut), its BAYLA vault 5,414,845,326,496
units, `lp_supply` was 372,631,821,673, `open_time` 1791055084, and its price record's last update was
1791514249 (the third swap). `mainnetSwaps.test.ts` replays these files to those balances, then reads
the opener's position through the ledger and the pool's two pages through the pool past.
