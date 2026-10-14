# tegridy-clmm: the venue's range-pool program (phase 0, not deployed)

Raydium's concentrated-liquidity program, `raydium-io/raydium-clmm` at commit
`ed1eb41519d5355755f7df52b43fa9610938b60b` (Apache-2.0, see `LICENSE`), copied as it is.
Only its identity changed: every address upstream hard-codes for itself is the venue's
(admin, fee owners and the spare-SOL collector are the venue's two-signature vault), and its
name, links and memos say memetics.finance. Its program id is a placeholder that no release
build accepts.

Three CI checks in `.github/workflows/solana-ci.yml` hold that:

- `solana/guards/clmm-provenance.sh`: same files as upstream, only the identity files differ,
  and the change inside them hashes to the reviewed value.
- `solana/guards/key-guard.mjs`: every key in this copy and in `../tegridy-amm/programs/cp-swap`
  is named in `solana/guards/allowed-keys.json`, and none is a key upstream hard-codes.
- the build: compiles with `--features placeholder-id`, and is refused without it.

Its own workspace, because upstream builds with Anchor 1.0.2 and Solana 3.1.10 and the three
programs in `../tegridy-amm` stay on Anchor 0.32.1. Plan, costs and owner decisions:
`docs/RANGE_POOLS_PLAN.md`.
