#!/usr/bin/env python3
"""Assert the COMMITTED bayla-ladder IDL still describes the program CI just built.

    check_committed_idl.py <committed.json> <freshly-built.json>

WHY THIS EXISTS
---------------
`anchor build` is the only thing that emits an IDL, and it cannot run on the
operator's machine (the SBF toolchain needs a symlink privilege Windows refuses).
For most of this program's life the only IDL in existence lived inside a CI
artifact with a 30-day retention, so the deployed program's interface description
had an expiry date and nobody could write a client without re-running a workflow.

`idl/bayla_ladder.json` is now committed. A committed generated file is only worth
having if something keeps it honest, and this is that something: `ladder-constraints`
already runs `anchor build` on every push, so the fresh IDL is sitting right there —
compare it.

WHAT IT IGNORES, AND WHY EXACTLY TWO THINGS
-------------------------------------------
Every build of this program patches two compile-time identities before compiling:

  * `declare_id!`                -> surfaces as the IDL's top-level `address`
  * `deployer::ID` (cfg-gated)   -> surfaces as the `address` pin on
                                    `initialize_pool`'s `payer` account

CI generates throwaway keys for both, the artifact workflow takes them as inputs,
and devnet and mainnet differ in the second by construction. Comparing them would
red on every run and teach everyone to ignore this gate. So they are normalised —
and NOTHING ELSE IS. `grep -n 'cfg(feature = "devnet")' programs/bayla-ladder/src/lib.rs`
finds exactly two sites: the `deployer::ID` arms, and one inside `mod tests`. There
is no other cfg-dependent surface, so every remaining byte of the IDL — every
discriminator, account name, ordering, flag, arg, event, error and type — is
build-independent and must match exactly.

Normalising is not the same as not looking. Both pins are asserted PRESENT and
plausible first: a build in which `initialize_pool.payer` has lost its `address`
has lost the deployer gate entirely (the pool becomes creatable by anyone), and a
normaliser that quietly tolerated the field's absence would report that as a match.
That is the `unreadable must not read as fine` failure, and it is the one this file
is most at risk of committing.

Exits 0 on match, 1 on drift, 2 on a usage/parse problem.
"""

import json
import sys

PIN = "<patched-per-build>"


def _load(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        print(f"::error::{path} does not exist — cannot compare")
        sys.exit(2)
    except json.JSONDecodeError as exc:
        print(f"::error::{path} is not valid JSON: {exc}")
        sys.exit(2)


def _payer_pin(idl, label):
    """The `address` on initialize_pool's payer — i.e. `deployer::ID`, compiled in."""
    ix = next(
        (i for i in idl.get("instructions", []) if i.get("name") == "initialize_pool"),
        None,
    )
    if ix is None:
        print(f"::error::{label}: no `initialize_pool` instruction — this is not a bayla-ladder IDL")
        sys.exit(1)
    payer = next((a for a in ix.get("accounts", []) if a.get("name") == "payer"), None)
    if payer is None:
        print(f"::error::{label}: initialize_pool has no `payer` account — the account list moved")
        sys.exit(1)
    return ix, payer


def _normalise(idl, label):
    """Blank the two patched identities, having first proven they are really there."""
    addr = idl.get("address")
    if not isinstance(addr, str) or not addr:
        print(f"::error::{label}: no top-level `address` — the program id is missing from the IDL")
        sys.exit(1)

    _ix, payer = _payer_pin(idl, label)
    deployer = payer.get("address")
    if not isinstance(deployer, str) or not deployer:
        print(
            f"::error::{label}: initialize_pool's payer carries NO `address` pin. "
            "That is the deployer gate (audit L-5) — without it ANY wallet can create a pool."
        )
        sys.exit(1)
    if deployer == addr:
        print(
            f"::error::{label}: deployer == program id — audit L-5, initialize_pool would be UNCALLABLE"
        )
        sys.exit(1)

    idl["address"] = PIN
    payer["address"] = PIN
    return idl


def _paths(node, prefix=""):
    """Flatten to leaf path -> value so a mismatch can be reported by location."""
    if isinstance(node, dict):
        for k, v in node.items():
            yield from _paths(v, f"{prefix}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _paths(v, f"{prefix}[{i}]")
    else:
        yield prefix, node


def main(argv):
    if len(argv) != 3:
        print(__doc__)
        return 2
    committed_path, fresh_path = argv[1], argv[2]

    committed = _normalise(_load(committed_path), f"committed ({committed_path})")
    fresh = _normalise(_load(fresh_path), f"fresh build ({fresh_path})")

    if committed == fresh:
        n_ix = len(fresh.get("instructions", []))
        n_acct = len(fresh.get("accounts", []))
        print(
            f"  OK — the committed IDL matches this build: {n_ix} instructions, "
            f"{n_acct} accounts, identical apart from the two patched identities."
        )
        return 0

    a = dict(_paths(committed))
    b = dict(_paths(fresh))
    print("::error::the committed IDL no longer describes the program that was just built.")
    print(f"::error::Re-run solana-deploy-artifact and replace {committed_path} (see idl/README.md).")
    shown = 0
    for key in sorted(set(a) | set(b)):
        if a.get(key, "<absent>") != b.get(key, "<absent>"):
            print(f"  {key}: committed={a.get(key, '<absent>')!r} built={b.get(key, '<absent>')!r}")
            shown += 1
            if shown >= 40:
                print("  … further differences suppressed")
                break
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
