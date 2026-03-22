// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/TegridyFarm.sol";
import "../src/FeeDistributor.sol";

contract DeployScript is Script {
    // TOWELI token on Ethereum Mainnet
    address constant TOWELI = 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D;

    // TOWELI/WETH Uniswap V2 LP Token
    address constant LP_TOKEN = 0x6682Ac593513cc0A6c25D0F3588e8fA4FF81104D;

    // Reward rate: ~0.8243 TOWELI per second ≈ 71,233 TOWELI per day ≈ 26M per year
    uint256 constant REWARD_PER_SECOND = 824300000000000000; // 0.8243e18

    // Pool allocation: 60% LP, 40% single-sided staking
    uint256 constant LP_ALLOC = 60;
    uint256 constant STAKING_ALLOC = 40;

    function run() external {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        // Optional: set a start time (unix timestamp). If 0, farm starts immediately when funded.
        uint256 farmStartTime = vm.envOr("FARM_START_TIME", uint256(0));
        // Optional: multisig address to transfer ownership to after deployment.
        address multisig = vm.envOr("MULTISIG_ADDRESS", address(0));

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy TegridyFarm
        TegridyFarm farm = new TegridyFarm(TOWELI, REWARD_PER_SECOND);
        console.log("TegridyFarm deployed at:", address(farm));

        // 2. Deploy FeeDistributor
        FeeDistributor distributor = new FeeDistributor(TOWELI);
        console.log("FeeDistributor deployed at:", address(distributor));

        // 3. Link distributor to farm
        distributor.setFarm(address(farm));
        console.log("FeeDistributor linked to farm");

        // 4. Add LP Pool (pid=0): TOWELI/WETH LP, 60% allocation
        farm.addPool(LP_ALLOC, IERC20(LP_TOKEN));
        console.log("Pool 0 added: TOWELI/WETH LP (60%)");

        // 5. Add Staking Pool (pid=1): TOWELI single-sided, 40% allocation
        farm.addPool(STAKING_ALLOC, IERC20(TOWELI));
        console.log("Pool 1 added: TOWELI Staking (40%)");

        // 6. Set start time if provided
        if (farmStartTime > 0) {
            farm.setStartTime(farmStartTime);
            console.log("Start time set to:", farmStartTime);
        }

        // 7. Transfer ownership to multisig if provided
        if (multisig != address(0)) {
            farm.transferOwnership(multisig);
            distributor.transferOwnership(multisig);
            console.log("Ownership transfer initiated to:", multisig);
            console.log("IMPORTANT: Multisig must call acceptOwnership() on both contracts!");
        }

        vm.stopBroadcast();

        console.log("");
        console.log("=== DEPLOYMENT COMPLETE ===");
        console.log("TegridyFarm:", address(farm));
        console.log("FeeDistributor:", address(distributor));
        console.log("");
        console.log("NEXT STEPS:");
        console.log("1. Update frontend/src/lib/constants.ts with deployed addresses");
        console.log("2. Run Fund.s.sol: set FARM_ADDRESS and FUND_AMOUNT env vars");
        if (multisig != address(0)) {
            console.log("3. Accept ownership from multisig on both contracts");
        }
        if (farmStartTime == 0) {
            console.log("3. Set start time: farm.setStartTime(timestamp)");
        }
    }
}
