# cardano/

The venue's own Cardano pools. Nothing here is deployed.

- `minswap-dex-v2/`: Minswap V2's audited contracts at `c3293ad4`, **never edited**. Our deploy
  changes only its parameters.
- `role-timelock/`: our one new validator. It holds every admin role in Minswap's GlobalSetting,
  so a change is announced on chain, waits 48 hours, and needs both owner keys (CertiK's MIN-01,
  fixed without touching Minswap's code). `lib/amm_dex_v2/` there is Minswap's library, unchanged.
- `guards/provenance.mjs`: every copied file is upstream's at the pin, by hash, with no clone.
- `guards/prove-build.mjs`: the pinned compiler (Aiken v1.0.24-alpha+982eff4) turns our copy into
  Minswap's six mainnet scripts byte for byte, and the role timelock's tests pass and its
  `plutus.json` is the committed one.

What the audit covers, the deploy parameters, and the owner's open decisions:
[docs/CARDANO_AUDIT_SCOPE.md](../docs/CARDANO_AUDIT_SCOPE.md). CI: `.github/workflows/cardano-ci.yml`.

Run locally (Aiken v1.0.24-alpha from its GitHub release):

```bash
node cardano/guards/provenance.mjs && node cardano/guards/provenance.mjs --self-test
```

```bash
AIKEN=/path/to/aiken node cardano/guards/prove-build.mjs --chain
```

Licence: Minswap's `LICENSE.md` says GPL-3.0, its `aiken.toml` and `plutus.json` say Apache-2.0.
Until a lawyer reads it, both folders are treated as GPL-3.0 (the stricter reading).
