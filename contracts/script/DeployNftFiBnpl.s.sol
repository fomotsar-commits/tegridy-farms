// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {NftfiBnpl} from "../src/nftfi/NftfiBnpl.sol";
import {NftfiPooledLendingVault} from "../src/nftfi/NftfiPooledLendingVault.sol";

/// @title  DeployNftFiBnpl — the instalment desk for one pool
/// @notice Binds to an already-deployed `NftfiPooledLendingVault` and inherits
///         its collection. One desk per pool.
///
/// @dev NOTHING HERE HAS BEEN RUN, and `saleFeeBps` is zero out of the
///      constructor.
///
/// @dev THE ORDER MATTERS AND IT IS NOT COSMETIC. The desk can only open a plan
///      while the vault's `loanDuration` outlasts the whole instalment schedule
///      plus its grace. Deploying this against a vault on a short term produces
///      a desk that reverts every purchase — which is the safe failure, but a
///      confusing one, so check it here rather than discovering it from a
///      buyer's reverted transaction.
///
/// @dev Env: WETH, VAULT, FEE_RECIPIENT (may be address(0) — that permanently
///      locks the sale-fee dial at zero for this deployment), MULTISIG.
contract DeployNftFiBnplScript is Script {
    function run() external returns (address desk) {
        address weth = vm.envAddress("WETH");
        address vault = vm.envAddress("VAULT");
        address feeRecipient = vm.envOr("FEE_RECIPIENT", address(0));
        address multisig = vm.envAddress("MULTISIG");

        require(weth != address(0) && vault != address(0), "zero env");
        require(multisig != address(0), "set MULTISIG");
        require(multisig.code.length > 0, "MULTISIG must be a contract (Safe)");
        require(block.chainid == 1, "MAINNET_ONLY");

        NftfiPooledLendingVault v = NftfiPooledLendingVault(vault);
        require(v.asset() == weth, "VAULT asset mismatch");
        require(
            v.loanDuration() >= 90 days + 3 days,
            "VAULT loanDuration shorter than the instalment schedule + grace"
        );

        vm.startBroadcast();
        NftfiBnpl b = new NftfiBnpl(weth, vault, feeRecipient, msg.sender);
        console2.log("NftfiBnpl:", address(b));
        console2.log("vault:", vault);
        console2.log("collection:", b.collection());

        b.transferOwnership(multisig);
        console2.log("ownership proposed to:", multisig);
        vm.stopBroadcast();

        // Post-deploy, each as its own reviewed transaction:
        //   1. Safe: acceptOwnership()
        //   2. Safe: setDepositBps(...) if 25% is not the policy
        //   3. The vault's liquidation sink must already be set, or a forfeited
        //      plan cannot be wound up at all. Check it before the first plan,
        //      not after the first default.
        return address(b);
    }
}
