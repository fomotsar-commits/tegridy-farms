// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {NftfiPooledLendingVault} from "../src/nftfi/NftfiPooledLendingVault.sol";

/// @title  DeployNftFiPooledLending — one pool, one collection
/// @notice Deploys a single `NftfiPooledLendingVault`. Run it once per
///         collection you intend to open a book on; there is deliberately no
///         factory and no batch mode, because the isolation this product sells
///         is exactly the property a shared deployer would start to erode.
///
/// @dev NOTHING HERE HAS BEEN RUN. No address produced by this script exists in
///      frontend/src/lib/constants.ts, and until one does every surface reports
///      the pool as not deployed.
///
/// @dev THE FEE DIALS ARE NOT SET HERE AND MUST NOT BE. `originationFeeBps` and
///      `interestFeeBps` are zero out of the constructor. Turning either on is
///      a separate, deliberate `setFees` transaction after the audit wave named
///      in the vault's header, not a line in a deploy script that somebody runs
///      while thinking about something else.
///
/// @dev THE FLOOR IS NOT PUSHED HERE EITHER. A vault with no floor lends
///      nothing, which is the correct state for a pool nobody has funded. The
///      first `pushFloor` should carry the venue's own sanitized native floor
///      (price-capped, ETH-only, bundles excluded) — never a number copied off
///      a third-party marketplace, whose floor includes bundles, non-ETH
///      currencies and wash prints this venue's own book filters out.
///
/// @dev Env: WETH, COLLECTION, FEE_RECIPIENT (may be address(0) — that
///      permanently locks the fee dials at zero for this deployment),
///      DEPOSIT_CAP_WEI, MULTISIG.
contract DeployNftFiPooledLendingScript is Script {
    function run() external returns (address vault) {
        address weth = vm.envAddress("WETH");
        address collection = vm.envAddress("COLLECTION");
        address feeRecipient = vm.envOr("FEE_RECIPIENT", address(0));
        uint256 depositCapWei = vm.envOr("DEPOSIT_CAP_WEI", uint256(50 ether));
        address multisig = vm.envAddress("MULTISIG");

        require(weth != address(0) && collection != address(0), "zero env");
        require(multisig != address(0), "set MULTISIG");
        require(multisig.code.length > 0, "MULTISIG must be a contract (Safe)");
        require(block.chainid == 1, "MAINNET_ONLY");
        // A cap is the only thing standing between an unproven book and an
        // unbounded one. Refusing to deploy without it beats deploying with a
        // silent default nobody chose.
        require(depositCapWei > 0, "DEPOSIT_CAP_WEI must be set");

        vm.startBroadcast();
        NftfiPooledLendingVault v =
            new NftfiPooledLendingVault(weth, collection, feeRecipient, depositCapWei, msg.sender);
        console2.log("NftfiPooledLendingVault:", address(v));
        console2.log("collection:", collection);
        console2.log("depositCapWei:", depositCapWei);

        // Ownership moves to the Safe in the same broadcast; the Safe must then
        // call `acceptOwnership` as its own ceremony step.
        v.transferOwnership(multisig);
        console2.log("ownership proposed to:", multisig);
        vm.stopBroadcast();

        // Post-deploy, in this order, each as its own reviewed transaction:
        //   1. Safe: acceptOwnership()
        //   2. Safe: setLiquidationSink(<sink>)  — until this is set, `seize`
        //      and `surrender` revert, so no collateral can leave the vault by
        //      any path except repayment. That is the intended resting state
        //      for a pool that has not yet proven its liquidation route.
        //   3. Safe: setTerms(...) if the defaults are not the policy
        //   4. Safe: pushFloor(<sanitized native floor>) — starts the clock;
        //      goes stale in FLOOR_MAX_AGE and closes borrowing until re-pushed.
        //      NOTHING IN THIS REPO RE-PUSHES IT. There is no keeper.
        return address(v);
    }
}
