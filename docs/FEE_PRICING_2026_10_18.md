# Fee pricing pass, 2026-10-18: what changes, and the signing steps

The owner approved a pricing pass measured against each sector's leader ("Prepare all the
recommended fee changes. Hand me the Squads and Safe steps for anything on chain.").
Nothing below is sent by an agent: every on-chain step is signed by the owner.

## Where each change lands

| Change | Before | After | Lands in | Live when |
|---|---|---|---|---|
| Solana swap fee between SOL, USDC, USDT and staked SOL | 0.5% | 0.05% | PR #877 | #877 merges |
| CoW market swap fee | 0.5% | 0.25% | PR #877 | #877 merges |
| Paid API plans (billing off) | $99 / $499 / $2,000 | $49 / $199 / $799 | PR #877 | #877 merges |
| Marketplace fee (own listings, single-NFT offers) | 1% | 0.5% | PR #876 | #876 merges |
| NFT trading pools, new factory | 0.5% | 0.25% | PR #875 kit | the redeploy |
| Solana graduated pools, creator fee | 0.05% | 0.50% (0.75% total) | Squads step 1 below | proposal executes |
| Solana 0.25% pool tier (fee settings 2) | none | 0.25%, 16% to us | Squads step 2 below | proposal executes; usable once a tier picker ships |
| EVM curve split, all three chains | 40 / 25 / 35 | 50 / 25 / 25 | Safe steps below | each Safe tx executes |
| Card on-ramp partner fee | not set | 0.5% | provider dashboards + Vercel env | when on-ramp keys are set |

This PR (the registry rows and the curve page copy) merges **after** the Squads and Safe
steps execute. Before that, its registry rows would fail the daily registry-onchain job and
its copy would say 50% while the chain still says 40%.

## Solana: two Squads proposals

The tool is the local proposer page, already used for proposals 1 to 5.

1. Run `node C:\Users\jimbo\solana-launch-release-2026-09-26\squads-proposer\serve.mjs`.
2. Open http://127.0.0.1:5199/ in the browser that has Member A's wallet (`5QHzAqbGk3W8qGRBHCMyWjhLXf8YJcs3yPEh14Ymcwgz`).
3. Two new steps are at the bottom of the list.
   - **"Graduated pools: creator fee 0.05% to 0.50%"**
     - `update_amm_config(7, 5000)` on fee settings 0, `BHMteE8u6LAppswQmFmd2h7hp1fCfWtGahvVJnhRk8jW`.
     - Data `313cae889a1c74c8078813000000000000`.
     - No pool uses fee settings 0 today and the launcher is paused, so nobody pays it until launches open.
   - **"Fee settings 2 (a 0.25% swap fee tier)"**
     - `create_amm_config(2, 2500, 160000, 0, 150000000, 0)` at `4UjFf1iU27SqyJfDif6Ra9YcgPYDjv6ehs9V7YaSUbb8`.
     - Data `8934edd4d7756c680200c4090000000000000071020000000000000000000000000080d1f008000000000000000000000000`.
     - The vault pays about 0.00185 SOL of rent.
4. The page simulates each step as the vault before it shows a Sign button. Both simulated clean against mainnet on 2026-10-18 (3,021 and 8,408 CU).
5. Member A signs each create, at about 0.004 SOL each.
6. Member B (`6VHowW4pnD4WTGsXhqBp6yxGgC3EExVmYgebSrRNu2tY`) approves and executes both at https://app.squads.so/squads/GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd/transactions. They will be transactions #12 and #13.

## EVM: three Safe transactions, one per chain

Each is `setLaunchConfig((uint128,uint128,uint16,uint16,uint16,uint16,address))` with value 0.
- It has no timelock, and launches already made keep their split.
- Every field except the one or two named here is the live value read on 2026-10-18.
- Every call below succeeded as an `eth_call` from its owner Safe.

**Pick one variant.**
- **A** changes only the split.
- **B** also moves the 3.69% curve reserve from the deployer wallet to the treasury Safe. That is "Part B" of docs/SIGNING_SESSION_2026_08_28.md, prepared then and never sent. One transaction does both.

### Ethereum: from the Treasury Safe `0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d`

- To: `0xF4Dfa741aD63B3D95dC3Fc10D311caE507CE34dE`.
- Signers: `0x28d7CB2F4D73C2750Ba0055c771871fec79260f8` and `0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e`.

A (split only):
```
0x5aeac64e00000000000000000000000000000000000000000000000002ebf0919c80d7940000000000000000000000000000000000000000000000003782dace9d9000000000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000000000138800000000000000000000000000000000000000000000000000000000000009c4000000000000000000000000000000000000000000000000000000000000017100000000000000000000000014898258122c0740106391e6e8e4f17f3b6d456e
```
B (split, and reserve to `0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d`):
```
0x5aeac64e00000000000000000000000000000000000000000000000002ebf0919c80d7940000000000000000000000000000000000000000000000003782dace9d9000000000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000000000138800000000000000000000000000000000000000000000000000000000000009c400000000000000000000000000000000000000000000000000000000000001710000000000000000000000007d2620243edad69ec81a53c4a063b07995a4bd7d
```

### Base: from `0xBC4E8abe4b0F16FC65c5bCADd018b3C44c47Be5B`

- To: `0xa517A1cEfd961c0DDE8155a0Fa870aEE5bb0D060`.
- Signers: `0x14898258122C0740106391E6e8E4F17F3b6d456E` and `0x28d7CB2F4D73C2750Ba0055c771871fec79260f8`.

A:
```
0x5aeac64e0000000000000000000000000000000000000000000000000175f848ce406bca0000000000000000000000000000000000000000000000001bc16d674ec800000000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000000000138800000000000000000000000000000000000000000000000000000000000009c4000000000000000000000000000000000000000000000000000000000000017100000000000000000000000014898258122c0740106391e6e8e4f17f3b6d456e
```
B (reserve to the L2 Treasury Safe `0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0`):
```
0x5aeac64e0000000000000000000000000000000000000000000000000175f848ce406bca0000000000000000000000000000000000000000000000001bc16d674ec800000000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000000000138800000000000000000000000000000000000000000000000000000000000009c40000000000000000000000000000000000000000000000000000000000000171000000000000000000000000796c22ff58f24e4a5d07683d8a5c03ec54db38c0
```

### Robinhood 4663: from `0xBC4E8abe4b0F16FC65c5bCADd018b3C44c47Be5B`

- To: `0xA2e7E7Fae91846E4c92af7f4b43b24CDd9aBF4F5`.
- Signers: the same two as Base.

A:
```
0x5aeac64e00000000000000000000000000000000000000000000000001187a369ab050d700000000000000000000000000000000000000000000000014d1120d7b1600000000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000000000138800000000000000000000000000000000000000000000000000000000000009c4000000000000000000000000000000000000000000000000000000000000017100000000000000000000000014898258122c0740106391e6e8e4f17f3b6d456e
```
B (reserve to `0x796c22ff58F24e4a5d07683d8A5c03Ec54dB38C0`):
```
0x5aeac64e00000000000000000000000000000000000000000000000001187a369ab050d700000000000000000000000000000000000000000000000014d1120d7b1600000000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000000000138800000000000000000000000000000000000000000000000000000000000009c40000000000000000000000000000000000000000000000000000000000000171000000000000000000000000796c22ff58f24e4a5d07683d8a5c03ec54db38c0
```

**How to send each one.**
1. In app.safe.global, open that Safe on that chain.
2. Choose New transaction, then Transaction Builder, and turn on "Custom data".
3. Paste the To address, value 0, and the data. Both signers sign, and one executes.
4. If Safe's app does not list Robinhood Chain (this Safe there has never executed a transaction), use the direct `execTransaction` fallback in docs/SIGNING_SESSION_2026_08_28.md: both owners sign the Safe transaction hash and one submits it. Ask, and the exact script gets prepared.

## Checks after signing

```bash
cast call 0xF4Dfa741aD63B3D95dC3Fc10D311caE507CE34dE 'launchConfig()(uint128,uint128,uint16,uint16,uint16,uint16,address)' --rpc-url https://eth.drpc.org
cast call 0xa517A1cEfd961c0DDE8155a0Fa870aEE5bb0D060 'launchConfig()(uint128,uint128,uint16,uint16,uint16,uint16,address)' --rpc-url https://mainnet.base.org
cast call 0xA2e7E7Fae91846E4c92af7f4b43b24CDd9aBF4F5 'launchConfig()(uint128,uint128,uint16,uint16,uint16,uint16,address)' --rpc-url https://rpc.mainnet.chain.robinhood.com
```

Each should read creator 5000 and treasury 2500, plus the reserve recipient of the variant you sent.
- If you sent **variant B**, this PR's registry text must also say the reserve goes to the treasury Safe before it merges.

For Solana, the proposer page shows both steps as ALREADY DONE, and the registry check reads them:

```bash
node frontend/scripts/verify-addresses.mjs --onchain
```

## Card on-ramp

The partner fee is set in each provider's partner dashboard (Transak, MoonPay), not in code.
1. Set it to 0.5% there.
2. Set `VITE_ONRAMP_PARTNER_FEE_BPS=50` in Vercel Production and redeploy, so the site's disclosure matches. The value must equal the dashboard's.
3. Skip both until the on-ramp keys are set: the on-ramp is off today.
