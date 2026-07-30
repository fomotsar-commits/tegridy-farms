# tegridy-launch — local development

## Verifying without the SBF toolchain

Two separate Windows limits hit this workspace. They have DIFFERENT causes and
different workarounds — do not conflate them.

### 1. `cargo` blocked by Application Control (`os error 4551`) — SOLVED

Cargo build scripts cannot execute from inside the OneDrive-synced repo path.
The fix is simply to put the build directory somewhere else:

```sh
export CARGO_TARGET_DIR="$LOCALAPPDATA/tgl_target"   # any non-OneDrive path
cargo check
```

With that, `cargo check` works fully — types, borrow checking, and Anchor macro
expansion are all verified locally. This catches essentially every class of error
short of codegen.

### 2. `cargo build-sbf` blocked by symlink privilege (`os error 1314`) — NOT solved

Installing platform-tools extracts symlinks, which needs the privilege that
Windows grants under Developer Mode (or elevation). `CARGO_TARGET_DIR` does NOT
help — the failure is in `~/.cache/solana`, not the target dir. This also affects
the existing cp-swap program, so it is environmental, not specific to this crate.

Enable via Settings → System → For developers → Developer Mode, or rely on CI.

### 3. Curve math needs neither of the above

`curve.rs` is dependency-free by design:

```sh
rustc --edition 2021 --test src/curve.rs -o /tmp/curve_test && /tmp/curve_test
```

## CI is still the SBF gate

`solana-ci.yml`'s `launch-curve` job runs the curve tests and the SBF build.
Note that `cargo build-sbf` **can exit 0 having compiled nothing** when
platform-tools is not yet installed on a runner — the job therefore asserts the
`.so` artifact exists rather than trusting the exit code. Do not remove that
assertion; it caught a vacuously-passing gate on 2026-07-28.
