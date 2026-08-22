# Vendored: Uniswap `merkle-distributor`

| field | value |
|---|---|
| upstream | https://github.com/Uniswap/merkle-distributor |
| commit | `25a79e8ec8c22076a735b1a675b961c8184e7931` (2022-11-21, "specify gpl license") |
| files | `contracts/MerkleDistributor.sol`, `contracts/interfaces/IMerkleDistributor.sol` |
| license | **GPL-3.0-or-later** (as declared by the SPDX line at that commit) |

## Diff against upstream

`interfaces/IMerkleDistributor.sol` — byte-identical, zero deltas.

`MerkleDistributor.sol` — exactly one delta:

```diff
-pragma solidity =0.8.17;
+pragma solidity ^0.8.17;
```

The upstream pin `=0.8.17` cannot compile under this repo's `solc = "0.8.26"`
(foundry.toml). Widening to a caret range is the smallest change that admits the
repo compiler; no statement, expression, storage slot, event, error, or function
signature is touched. The claim bitmap, the `keccak256(abi.encodePacked(index,
account, amount))` leaf encoding, and the `MerkleProof.verify` call are the
core math and are untouched.

Regenerate the diff to re-verify:

```
curl -sL https://raw.githubusercontent.com/Uniswap/merkle-distributor/25a79e8ec8c22076a735b1a675b961c8184e7931/contracts/MerkleDistributor.sol \
  | diff - src/vendor/uniswap-merkle-distributor/MerkleDistributor.sol
curl -sL https://raw.githubusercontent.com/Uniswap/merkle-distributor/25a79e8ec8c22076a735b1a675b961c8184e7931/contracts/interfaces/IMerkleDistributor.sol \
  | diff - src/vendor/uniswap-merkle-distributor/interfaces/IMerkleDistributor.sol
```

Verified 2026-08-18. Expected output — the first diff prints exactly this one
hunk and nothing else:

```
2c2
< pragma solidity =0.8.17;
---
> pragma solidity ^0.8.17;
```

The second diff must print nothing at all. Any additional hunk means the
vendored copy drifted and the airdrop rail must not be deployed until it is
reconciled.

## License note — OPERATOR DECISION REQUIRED

The repo root LICENSE is MIT. This upstream is GPL-3.0-or-later, not MIT (the
build note that called it MIT predates the 2022-11-21 relicense commit named
above). Every file that inherits from or instantiates `MerkleDistributor`
therefore carries `SPDX-License-Identifier: GPL-3.0-or-later`:

- `src/vendor/uniswap-merkle-distributor/**`
- `src/TegridyAirdropDistributor.sol`
- `src/AirdropFactory.sol`
- `script/DeployAirdropFactory.s.sol`
- `test/AirdropFactory.t.sol`, `test/invariants/AirdropDistributorInvariants.t.sol`

This is a licensing question, not an engineering one, and it is not resolved
here. The operator either accepts GPL-3.0-or-later on the airdrop module and
records it in `NOTICE.md`, or replaces the base with an MIT-licensed
merkle-claim implementation before deploy.
