// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @title Toweli — Tegridy Farms governance & revenue-accrual token
/// @notice Fixed-supply ERC-20 token for Tegridy Farms protocol. Immutable supply,
///         no mint function, no burn entrypoint, no pause, no blocklist, no owner.
///         EIP-2612 permit() support included for gasless approvals.
///
/// @dev Canonical deployment is `0x420698CFdEDdEa6bc78D59bC17798113ad278F9D` on
///      Ethereum Mainnet. The vanity address prefix (`0x420698`) was produced via
///      CREATE2 salt-mining pre-deployment — see docs/TOKEN_DEPLOY.md.
///
///      This source file documents the intended and deployed behavior. The live
///      bytecode is verified on Etherscan; always prefer the verified source on
///      Etherscan as the canonical reference if any divergence is observed:
///      https://etherscan.io/token/0x420698CFdEDdEa6bc78D59bC17798113ad278F9D#code
///
/// @dev Design goals:
///      1. Fixed 1,000,000,000 supply, minted once in constructor, sent to deployer.
///      2. No owner — token has no admin surface; there is nothing to rug.
///      3. No mint / burn / pause / blocklist — token is pure ERC-20 + permit.
///      4. Compatible with Uniswap V2 routing, standard DEX adapters, and
///         account abstraction flows via ERC-2612 permit (now ERC-1271 / SCW
///         compatible — see DEEP-LIB-L3 below).
///
/// @dev AUDIT FIX: DEEP-LIB-I2 — EIP-712 version is locked to "1" forever.
///      OZ ERC20Permit's constructor passes `version = "1"` to EIP712, baked
///      into the domain separator hash. Any future Toweli derivative
///      (rebases, fork-deployments, multi-chain bridge wrappers, v2 contracts)
///      MUST keep `version = "1"` in their EIP712 init or every existing
///      `permit` signature on user-side will break: a different domain
///      separator yields a different signature digest, so previously-issued
///      signatures will not validate against the new contract. This is fine
///      for the canonical mainnet deployment but locks the version namespace
///      forever — there is no graceful "v2" upgrade path that preserves
///      cross-chain signature compatibility.
contract Toweli is ERC20, ERC20Permit {
    /// @notice 1,000,000,000 TOWELI, fixed, in 18 decimals.
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 ether;

    /// @dev AUDIT R014 (LOW): one-shot flag that allows the constructor to
    ///      perform the initial mint exactly once and then permanently
    ///      disables ALL future minting. The flag is set inside the
    ///      constructor before any external surface exists, so no caller
    ///      can ever observe `_initialMintDone == false` post-deploy.
    ///
    ///      OZ's ERC20._mint is non-virtual; OZ's recommended override hook
    ///      is `_update`. We intercept the mint path (from == address(0))
    ///      there: any non-constructor call into _update with from==0 must
    ///      revert. Burns (to==0) and normal transfers (both nonzero) are
    ///      passed through unchanged. There is no burn entrypoint exposed,
    ///      so the to==0 path is unreachable in practice but pass-through
    ///      preserves the correct ERC-20 semantics for completeness.
    /// @dev AUDIT L-T01 (2026-04-28): a single `bool` slot here is acceptable —
    ///      this contract has no other state that could pack into the same
    ///      32-byte slot (OwnableNoRenounce/ERC20Permit/ERC20 each maintain
    ///      their own slots, and there is no operational need for a future
    ///      uint128/bool/address neighbour). The 31 bytes of waste are a
    ///      one-time cost paid at deploy and never again — not worth a
    ///      pack-game refactor.
    bool private _initialMintDone;

    /// @dev AUDIT FIX: DEEP-LIB-L3 — EIP-2612 PERMIT_TYPEHASH copy. OZ
    ///      keeps `PERMIT_TYPEHASH` as `private` in `ERC20Permit`, which
    ///      forces us to re-derive it for the override. The hash MUST match
    ///      OZ's exactly so existing client-side signers (wagmi, ethers,
    ///      viem) produce signatures compatible with this contract. If OZ
    ///      ever changes the typehash literal, this constant must be
    ///      updated to match.
    bytes32 private constant PERMIT_TYPEHASH_LOCAL =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    /// @param recipient Address that receives the entire 1B TOWELI supply at deploy.
    ///                  Expected to be a multisig treasury that then distributes to
    ///                  LP seed, staking rewards, team, and community per the
    ///                  allocation in TOKENOMICS.md.
    constructor(address recipient)
        ERC20("Toweli", "TOWELI")
        ERC20Permit("Toweli")
    {
        require(recipient != address(0), "Toweli: zero recipient");
        // DEFERRED: DEEP-LIB-M4 — `recipient.code.length > 0` enforcement.
        //   Adding the contract-only requirement here would break:
        //     - contracts/test/Toweli.t.sol (uses `treasury = makeAddr("treasury")` → EOA)
        //     - contracts/test/AuditR014_Misc.t.sol (same EOA pattern)
        //     - contracts/script/DeployToweli.s.sol (passes env-derived address;
        //       deployer EOA could pass an EOA value at deploy time)
        //   The findings spec instructs: "If tests break excessively, defer this
        //   fix and add a `// DEFERRED: DEEP-LIB-M4` comment with rationale."
        //   The TOKENOMICS doc and deploy procedure (`docs/TOKEN_DEPLOY.md`)
        //   already specify a multisig recipient — operational discipline at
        //   deploy time is the practical defense for now. A future Toweli v2
        //   on a new chain (with fresh tests) can fold this guard in.
        // Initial mint — _update override below permits exactly this call
        // (because _initialMintDone is still false here).
        _mint(recipient, TOTAL_SUPPLY);
        _initialMintDone = true;
    }

    /// @notice AUDIT R014 (LOW): code-enforced immutable supply.
    ///         Permits exactly the constructor's initial mint, then reverts
    ///         on any subsequent attempt to mint regardless of caller. This
    ///         makes the "no mint function" promise an invariant of the
    ///         bytecode, not a property of the source surface.
    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0)) {
            // Mint path. Allowed exactly once, before _initialMintDone is set.
            require(!_initialMintDone, "MINT_DISABLED");
        }
        super._update(from, to, value);
    }

    /// @notice AUDIT FIX: DEEP-LIB-L3 — ERC-1271 / SCW compatible permit.
    ///         OZ's ERC20Permit.permit uses raw `ECDSA.recover`, which
    ///         requires an EOA signer. Smart-contract wallets (Safe, Argent,
    ///         AA / 4337 wallets) sign via ERC-1271 `isValidSignature` — they
    ///         have NO recoverable EOA, so the OZ default reverts on every
    ///         SCW permit. This override delegates to OZ's `SignatureChecker`,
    ///         which auto-detects EOA vs contract-wallet at the signer
    ///         address and dispatches to either ECDSA recover or
    ///         ERC-1271 staticcall — exact pattern used by USDC v2.2 and DAI.
    ///         The Tegridy Farms docs and Toweli's own NatSpec advertise
    ///         "Compatible with account abstraction flows via ERC-2612
    ///         permit"; without this override that claim is false for SCWs
    ///         (they have to fall back to a 2-tx approve + transfer flow).
    /// @dev    Re-implements the OZ permit logic to use SignatureChecker.
    ///         The signature is reassembled as `abi.encodePacked(r, s, v)`
    ///         (the standard 65-byte format `SignatureChecker` accepts).
    ///         Nonce / deadline / typehash semantics are unchanged so client-
    ///         side signing tooling (wagmi/ethers/viem) requires no changes.
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public override {
        if (block.timestamp > deadline) {
            revert ERC2612ExpiredSignature(deadline);
        }

        bytes32 structHash = keccak256(
            abi.encode(PERMIT_TYPEHASH_LOCAL, owner, spender, value, _useNonce(owner), deadline)
        );

        bytes32 hash = _hashTypedDataV4(structHash);

        // SignatureChecker dispatches to ECDSA.recover for EOAs and to
        // ERC-1271 staticcall (`isValidSignature`) for contract wallets.
        if (!SignatureChecker.isValidSignatureNow(owner, hash, abi.encodePacked(r, s, v))) {
            revert ERC2612InvalidSigner(address(0), owner);
        }

        _approve(owner, spender, value);
    }
}
