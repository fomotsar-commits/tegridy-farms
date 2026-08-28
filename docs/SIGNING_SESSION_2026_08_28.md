# The signing session — 11 transactions, one sitting

Every number below was read LIVE on 2026-08-28 02:30 UTC; every selector was derived with
`cast sig`, never recalled. Two signers needed: the operator key `0x14898258122C0740106391E6e8E4F17F3b6d456E`
and the mainnet signer `0x28d7CB2F4D73C2750Ba0055c771871fec79260f8` (both 2-of-2 Safes use this pair;
the mainnet Treasury Safe uses `0x28d7…60f8` + `0xE9B7…f53e`).

**Two deadlines. Everything else is undated but should ride the same sitting.**

| What | Deadline | Consequence of missing |
|---|---|---|
| Base `acceptFeeToSetter` | **2026-09-02 07:20 UTC** (epoch 1788333647) | Proposal expires; deployer EOA must re-propose + a fresh 24h wait. Annoying, not fatal. |
| RH `acceptFeeToSetter` | **2026-09-03 05:02 UTC** (epoch 1788411726) | Same. |
| Reserve repoints (Part B) | **Before the first curve launch** (`launchCount` is 0 on all three chains as of this doc) | The repoint stops reaching launches already created — in-flight launches carry the EOA recipient to graduation FOREVER (`l.reserveRecipient` is snapshotted at create; `setLaunchConfig` is future-launches-only). |

Both windows are OPEN now (each 24h timelock has elapsed).

---

## Part A — the 2-of-2 accept ceremony (8 tx: 4 on Base, 4 on Robinhood)

All eight execute **FROM the L2 multisig Safe `0xBC4E8abe4b0F16FC65c5bCADd018b3C44c47Be5B`**
(same address on both chains), via Safe's Transaction Builder: paste the `To` address, leave
value 0, use "custom data" with the calldata below (no ABI needed — both calls take no
arguments, so the calldata IS the 4-byte selector).

⚠️ **This Safe has NEVER executed on either chain (nonce 0)** — the registry and the 08-15
sweep both flag "prove it signs before depending on it" (the never-proven-Safe shape cost
8.4 SOL on Solana). The ceremony is self-solving if you ORDER it right: the TWAP
`acceptOwnership` is the cheapest, lowest-stakes tx — it doubles as the smoke test. If tx 1
executes, the Safe signs; continue. If it fails, STOP — nothing is lost (ownership stays
pending) and the Safe itself is the problem to debug.

Calldata (derived): `acceptOwnership()` = `0x79ba5097` · `acceptFeeToSetter()` = `0x2dd072a0`.

### Base 8453 — in this order

| # | To | Calldata | What it completes |
|---|---|---|---|
| 1 | `0xB021651dACaD5dabf83ef587297E093DfA0c95Ec` (TegridyTWAP) | `0x79ba5097` | TWAP owner: deployer → Safe. **The smoke test.** |
| 2 | `0xa24C7287eC56A7DEFDc70033803451240e267a52` (SwapFeeRouter) | `0x79ba5097` | SFR owner → Safe |
| 3 | `0xcb03207ae13076F520b8c81Ea4FE6F08F8bC63b2` (SwapFeeRouterAdmin) | `0x79ba5097` | Admin owner → Safe |
| 4 | `0x12a249A027AA7DdF184E824b4bb63ba031A39fEC` (TegridyFactory) | `0x2dd072a0` | feeToSetter → Safe. **Deadline Sept 2 07:20 UTC.** |

### Robinhood 4663 — in this order

| # | To | Calldata | What it completes |
|---|---|---|---|
| 1 | `0xa24C7287eC56A7DEFDc70033803451240e267a52` (TegridyTWAP) | `0x79ba5097` | TWAP owner → Safe. **Smoke test for the 4663 instance.** |
| 2 | `0xE9F83A07b071748E795d2489651d5310fA098Db8` (SwapFeeRouter) | `0x79ba5097` | SFR owner → Safe |
| 3 | `0xdFdd6D72539A425dC917F49FB834901105cA98c9` (SwapFeeRouterAdmin) | `0x79ba5097` | Admin owner → Safe |
| 4 | `0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3` (TegridyFactory) | `0x2dd072a0` | feeToSetter → Safe. **Deadline Sept 3 05:02 UTC.** |

(Note the address swap across chains: 4663's TWAP sits at Base's SwapFeeRouter address and
vice versa — same-deployer CREATE nonce math. Copy rows exactly; never infer from the other
chain.)

⚠️ **If app.safe.global does not list Robinhood Chain 4663**: the Safes are canonical 1.4.1
instances, so the fallback is signing `execTransaction` directly (both owners sign the Safe
tx hash, one submits) — the same in-process-ethers pattern that deployed the 4663 leg
(`rh-resume.js` precedent, nonce-pinned legacy txs at 0.1 gwei). Say the word and the exact
script gets prepared; it needs no new decisions, only the two signatures.

All eight were verified pending on-chain 2026-08-28: every `pendingOwner()` /
`pendingFeeToSetter()` reads `0xBC4E…Be5B` — the ceremony cannot send anything to a wrong
target; each call only CLAIMS a transfer already proposed to this exact Safe.

Per [[reference_factory_guardian_after_acceptance]]: any future guardian rotation happens
AFTER `acceptFeeToSetter`, never before. (The L2 factories had guardians wired at
construction — nothing to rotate today; noted so nobody reorders a future session.)

## Part B — reserve custody repoints (3 tx: one per chain, BEFORE launch #1)

The 3.69% ecosystem reserve currently pays the deployer EOA `0x1489…456E` on all three
launchers. `reserveRecipient` is **snapshotted per-launch at create** — unlike `treasury`,
it can never be migrated for a launch that already exists. `launchCount` is 0 everywhere,
so today the fix is one owner tx per chain; after the first launch it is permanent for
everything in flight.

Each tx calls `setLaunchConfig((uint128,uint128,uint16,uint16,uint16,uint16,address))`
(`0x5aeac64e`) with the SIX live config fields byte-identical to chain state (re-read
2026-08-28) and ONLY the recipient changed to the chain's Treasury Safe. The contract
re-validates every floor on-chain (`ConfigOutOfBounds` guards), so a mis-paste reverts
rather than half-applying.

### B1 — Ethereum mainnet: FROM the Treasury Safe `0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d`
To `0xF4Dfa741aD63B3D95dC3Fc10D311caE507CE34dE` (TegridyCurveLauncher), value 0. New
recipient = the Treasury Safe itself. Unchanged: virtualEth 210526315789473684 (≈0.2105),
graduationEth 4 ETH, fee 100 bps, split 4000/2500, reserve 369.

```
0x5aeac64e00000000000000000000000000000000000000000000000002ebf0919c80d7940000000000000000000000000000000000000000000000003782dace9d90000000000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000fa000000000000000000000000000000000000000000000000000000000000009c400000000000000000000000000000000000000000000000000000000000001710000000000000000000000007d2620243edad69ec81a53c4a063b07995a4bd7d
```

### B2 — Base 8453: FROM `0xBC4E8abe4b0F16FC65c5bCADd018b3C44c47Be5B`
To `0xa517A1cEfd961c0DDE8155a0Fa870aEE5bb0D060`, value 0. New recipient = L2 Treasury Safe
`0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0`. Unchanged: virtualEth 105263157894736842,
graduationEth 2 ETH, 100, 4000/2500, 369.

```
0x5aeac64e0000000000000000000000000000000000000000000000000175f848ce406bca0000000000000000000000000000000000000000000000001bc16d674ec8000000000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000fa000000000000000000000000000000000000000000000000000000000000009c40000000000000000000000000000000000000000000000000000000000000171000000000000000000000000796c22ff58f24e4a5d07683d8a5c03ec54db38c0
```

### B3 — Robinhood 4663: FROM `0xBC4E8abe4b0F16FC65c5bCADd018b3C44c47Be5B`
To `0xA2e7E7Fae91846E4c92af7f4b43b24CDd9aBF4F5`, value 0. New recipient = the same L2
Treasury Safe. Unchanged: virtualEth 78947368421052631, graduationEth 1.5 ETH, 100,
4000/2500, 369.

```
0x5aeac64e00000000000000000000000000000000000000000000000001187a369ab050d700000000000000000000000000000000000000000000000014d1120d7b16000000000000000000000000000000000000000000000000000000000000000000640000000000000000000000000000000000000000000000000000000000000fa000000000000000000000000000000000000000000000000000000000000009c40000000000000000000000000000000000000000000000000000000000000171000000000000000000000000796c22ff58f24e4a5d07683d8a5c03ec54db38c0
```

(B1 is signed by the MAINNET Treasury Safe pair `0x28d7…60f8` + `0xE9B7…f53e` — a different
second signer than the L2 Safes. The frontend's `ECOSYSTEM_RESERVE_RECIPIENT` constant and
the registry's reserve-recipient notes should be updated in the same day's change-set; that
is a Claude task, not a signing task — say when Part B is executed.)

## Post-flight — paste-and-run verification (any shell with cast)

```bash
C=~/.foundry/bin/cast.exe; B=https://mainnet.base.org; R=https://rpc.mainnet.chain.robinhood.com; E=https://eth.drpc.org
# Ceremony: every line must print the MULTISIG Safe 0xBC4E…Be5B
$C call 0xB021651dACaD5dabf83ef587297E093DfA0c95Ec "owner()(address)" --rpc-url $B
$C call 0xa24C7287eC56A7DEFDc70033803451240e267a52 "owner()(address)" --rpc-url $B
$C call 0xcb03207ae13076F520b8c81Ea4FE6F08F8bC63b2 "owner()(address)" --rpc-url $B
$C call 0x12a249A027AA7DdF184E824b4bb63ba031A39fEC "feeToSetter()(address)" --rpc-url $B
$C call 0xa24C7287eC56A7DEFDc70033803451240e267a52 "owner()(address)" --rpc-url $R
$C call 0xE9F83A07b071748E795d2489651d5310fA098Db8 "owner()(address)" --rpc-url $R
$C call 0xdFdd6D72539A425dC917F49FB834901105cA98c9 "owner()(address)" --rpc-url $R
$C call 0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3 "feeToSetter()(address)" --rpc-url $R
# Repoints: the LAST field of each tuple must be the chain's Treasury Safe, not 0x1489…
$C call 0xF4Dfa741aD63B3D95dC3Fc10D311caE507CE34dE "launchConfig()((uint128,uint128,uint16,uint16,uint16,uint16,address))" --rpc-url $E
$C call 0xa517A1cEfd961c0DDE8155a0Fa870aEE5bb0D060 "launchConfig()((uint128,uint128,uint16,uint16,uint16,uint16,address))" --rpc-url $B
$C call 0xA2e7E7Fae91846E4c92af7f4b43b24CDd9aBF4F5 "launchConfig()((uint128,uint128,uint16,uint16,uint16,uint16,address))" --rpc-url $R
```

After Part A, the deployer EOA holds NO privileged role on any L2 contract; after Part B,
no future launch's reserve can land on a single key. That closes the last two custody items
the launchpad itself was waiting on.
