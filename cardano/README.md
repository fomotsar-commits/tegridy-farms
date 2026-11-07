# cardano/

The venue's own Cardano pools. Nothing here is deployed.

- `minswap-dex-v2/`: Minswap V2's audited contracts at `c3293ad4`, with **two reviewed patches**:
  the fee-share floor, 1666 to 1333 parts in 10,000, so the venue can take 13.33% of the fee (the
  owner's ruling, 2026-10-24); and a **pool creation fee**, a fixed amount of lovelace (73 ADA to
  start) the factory makes every new pool pay to the treasury, both named by two fields added to
  the GlobalSetting (the owner's ruling, 2026-10-25). The patch is
  `guards/upstream/minswap-dex-v2.diff`, pinned by hash.
- `role-timelock/`: our one new validator. It holds every admin role in Minswap's GlobalSetting,
  so a change is announced on chain, waits 48 hours, and needs both owner keys (CertiK's MIN-01,
  fixed without touching Minswap's code). That is also how the pool creation fee is re-set, and
  the lock refuses a GlobalSetting that pays it anywhere but the treasury. `lib/amm_dex_v2/` there
  is Minswap's library, same patch.
- `minswap-tests/factory_validator.ak`: our tests of the factory's Pool Creation and its fee,
  appended by `prove-build.mjs` to a staged copy of the factory validator (Aiken v1.0.24 tests
  reach a validator only from its own module).
- `guards/provenance.mjs`: every copied file is upstream's at the pin, or upstream's plus exactly
  the reviewed patch, by hash, with no clone.
- `guards/prove-build.mjs`: the pinned compiler (Aiken v1.0.24-alpha+982eff4) turns our copy, with
  the patch undone, into Minswap's six mainnet scripts byte for byte; with the patch, exactly the
  authen policy, factory, pool and pool batching change, and only the GlobalSetting type (two
  fields appended); the factory tests pass; and the role timelock's tests pass and its
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
