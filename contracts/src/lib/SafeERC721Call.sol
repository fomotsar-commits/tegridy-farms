// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title SafeERC721Call
/// @notice Bounded-returndata helpers for `transferFrom` and `ownerOf` against
///         attacker-controlled ERC721 contracts.
///
///         AUDIT FIX (pass-8): GAS-01 — a malicious whitelisted ERC721 can
///         return up to ~16 MB of returndata from `transferFrom` or `ownerOf`,
///         OOG-griefing every caller. Solidity's `try/catch` ALWAYS performs
///         `returndatacopy(0, 0, returndatasize())` before the catch fires —
///         the `gas:` modifier bounds inner gas but does NOT bound the copy.
///         Result: a 16 MB returndata blows past the tx gas limit, bricking
///         lender-side `claimDefault` permanently. Same vector breaks
///         `claimStuckCollateral` (the documented fallback).
///
///         These helpers cap the returndata copy at zero bytes (`safeTransferFromBounded`)
///         or 32 bytes (`safeOwnerOfBounded`), exactly matching what each caller
///         actually needs from the call. Returndata above the cap is discarded
///         at the EVM level — no copy, no gas bomb, no OOG.
///
/// @dev Pattern reference:
///        - Nomad `ExcessivelySafeCall` (the canonical implementation; this
///          library is a use-case-specific subset of that pattern).
///        - Solady `LibCall.callContract` with bounded returndata.
///        - OpenZeppelin v5 `Address.functionCall` does NOT bound returndata —
///          this is the key distinction.
///
/// @dev Library is `internal`-linkage only; functions inline into every consumer
///      with no extra deploy footprint or storage slot. No upgrade surface.
library SafeERC721Call {
    /// @notice ERC721 transferFrom selector: `transferFrom(address,address,uint256)`.
    bytes4 internal constant TRANSFER_FROM_SELECTOR = 0x23b872dd;
    /// @notice ERC721 ownerOf selector: `ownerOf(uint256)`.
    bytes4 internal constant OWNER_OF_SELECTOR = 0x6352211e;

    /// @notice Attempts `transferFrom(from, to, id)` on `coll` with bounded
    ///         returndata copy (zero bytes — ERC721.transferFrom returns void
    ///         per spec, so any returndata is wasted).
    /// @param coll The ERC721 contract.
    /// @param from The current owner address.
    /// @param to   The recipient address.
    /// @param id   The token id to transfer.
    /// @return ok  True iff the call did not revert.
    /// @dev    The caller is responsible for verifying actual ownership change
    ///         via a paired `safeOwnerOfBounded` post-condition — `ok==true`
    ///         alone is insufficient against ERC721s that no-op `transferFrom`
    ///         (NFTLEND-NEW-H2 / LD-NEW-H2 attack class).
    function safeTransferFromBounded(
        address coll,
        address from,
        address to,
        uint256 id
    ) internal returns (bool ok) {
        // ABI-encode `transferFrom(from, to, id)` — 4-byte selector + 3 × 32-byte args.
        // Allocate calldata in memory, build it in-place.
        bytes memory data = abi.encodeWithSelector(TRANSFER_FROM_SELECTOR, from, to, id);
        assembly {
            // call(g, addr, value, in, insize, out, outsize)
            // Forward all remaining gas, no value, zero outsize → no returndata copy.
            ok := call(gas(), coll, 0, add(data, 0x20), mload(data), 0, 0)
        }
    }

    /// @notice Attempts `ownerOf(id)` on `coll` with returndata bounded to 32 bytes.
    /// @param coll  The ERC721 contract.
    /// @param id    The token id to query.
    /// @return ok    True iff the call did not revert AND returned ≥32 bytes.
    /// @return owner The address returned in the low 20 bytes of the response.
    /// @dev    Uses `staticcall` so the callee cannot mutate state.
    ///         Gas budgeted at 30,000 — sufficient for any honest ERC721 (~3k gas
    ///         for a single SLOAD + ABI return) and tight enough that a malicious
    ///         callee burning gas in a loop reverts via OOG without consuming the
    ///         caller's full budget.
    function safeOwnerOfBounded(address coll, uint256 id)
        internal
        view
        returns (bool ok, address owner)
    {
        bytes memory data = abi.encodeWithSelector(OWNER_OF_SELECTOR, id);
        assembly {
            // staticcall(g, addr, in, insize, out, outsize)
            // 30k gas, 32-byte out buffer at memory slot 0.
            let success := staticcall(30000, coll, add(data, 0x20), mload(data), 0, 32)
            // Require both call success AND ≥32 bytes returned. Truncating high
            // bits to address space is implicit in the cast.
            if and(success, gt(returndatasize(), 31)) {
                owner := mload(0)
                ok := 1
            }
        }
    }
}
