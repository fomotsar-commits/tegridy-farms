// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyFactory} from "../src/TegridyFactory.sol";
import {TegridyRouter} from "../src/TegridyRouter.sol";
import {SwapFeeRouter} from "../src/SwapFeeRouter.sol";
import {SwapFeeRouterAdmin} from "../src/SwapFeeRouterAdmin.sol";
import {BaseChainConfig} from "./base/BaseChainConfig.sol";
import {RobinhoodChainConfig} from "./robinhood/RobinhoodChainConfig.sol";

/// @title  DeployPoolOpeningFeeAMM — a new coin-pool factory + router that charge 0.006 ETH to open a pool,
///         and the SwapFeeRouter that takes the venue's swap fee on their pools
/// @notice Ethereum, Base and Robinhood Chain (owner rulings 2026-10-25 "0.006 eth on all evm", and
///         2026-11-07 "Add Base + Robinhood too": there the fee goes to the TREASURY Safe 0x796c…, not
///         to the fee-remittance Safe the old factories pay). The same contracts on all three; per
///         chain only the addresses differ. On Base and Robinhood the old factories
///         (0x12a249A0… and 0x4B134C08…) are the same free code and stay as they are, like Ethereum's.
///         Owner ruling 2026-10-25. The live factory 0xa24C7287eC56A7DEFDc70033803451240e267a52 is
///         immutable and opens pools for free, and the live router 0xE9F83A07b071748E795d2489651d5310fA098Db8
///         is bound to it, so the fee ships as a new pair of contracts. The old ones keep working:
///         the one existing pool stays there, and anyone calling the old factory directly still
///         opens for free. Runbook: docs/POOL_OPENING_FEE_EVM.md.
///
///         The live SwapFeeRouter 0x6d5791A660e79175F74C6D639584C98422d5956E is bound for good to
///         the OLD router, so pools on the new factory get their own: the same contract, the same
///         fee, treasury, RevenueDistributor and ReferralSplitter, bound to the new router. Same
///         two-contract shape as DeploySwapFeeRouterUniswap.s.sol (SwapFeeRouter + its admin).
/// @dev    Env: FEE_TO_SETTER (admin Safe: the factory's feeToSetter, and the pending owner of the
///         SwapFeeRouter and its admin), GUARDIAN (the factory's instant pair-disable, a Safe),
///         TREASURY (feeTo, and the SwapFeeRouter's treasury), WETH, REVENUE_DISTRIBUTOR,
///         REFERRAL_SPLITTER (zero allowed: then the referrer share goes to the treasury),
///         SWAP_FEE_BPS (default 50, the live SwapFeeRouter's), PAUSE_GUARDIAN (optional on Ethereum),
///         SEQUENCER_FEED (Base and Robinhood only, required there).
///         The factory's roles are set in its constructor. The SwapFeeRouter and its admin are
///         handed to FEE_TO_SETTER by two-step transfer: the Safe calls acceptOwnership() on each.
/// @dev    Base and Robinhood copy that chain's live SwapFeeRouter (DeployBaseMVP / DeployRobinhoodMVP):
///         REVENUE_DISTRIBUTOR is the fee-remittance Safe (no veTOWELI there), no referral
///         splitter, a pause guardian, and the L2 sequencer-uptime feed (audit H-13: without it
///         the first fee conversion reverts). On Robinhood forge's `--broadcast` dies
///         (`Chain 4663 not supported`): dry-run this script there, then replay it with
///         `cast send` (docs/ROBINHOOD_CAST_REPLAY.md).
contract DeployPoolOpeningFeeAMMScript is Script {
    uint256 public constant EXPECTED_OPENING_FEE = 0.006 ether;
    uint256 public constant DEFAULT_SWAP_FEE_BPS = 50;
    uint256 internal constant EIP7702_DESIGNATOR_LENGTH = 23;

    struct Config {
        address feeToSetter;
        address guardian;
        address treasury;
        address weth;
        address revenueDistributor;
        address referralSplitter;
        uint256 swapFeeBps;
        address pauseGuardian;
        address sequencerFeed;
    }

    struct Deployed {
        TegridyFactory factory;
        TegridyRouter router;
        SwapFeeRouter swapFeeRouter;
        SwapFeeRouterAdmin swapFeeRouterAdmin;
    }

    function run() external returns (Deployed memory d) {
        Config memory cfg = Config({
            feeToSetter: vm.envAddress("FEE_TO_SETTER"),
            guardian: vm.envAddress("GUARDIAN"),
            treasury: vm.envAddress("TREASURY"),
            weth: vm.envAddress("WETH"),
            revenueDistributor: vm.envAddress("REVENUE_DISTRIBUTOR"),
            referralSplitter: vm.envOr("REFERRAL_SPLITTER", address(0)),
            swapFeeBps: vm.envOr("SWAP_FEE_BPS", DEFAULT_SWAP_FEE_BPS),
            pauseGuardian: vm.envOr("PAUSE_GUARDIAN", address(0)),
            sequencerFeed: block.chainid == 1 ? address(0) : vm.envAddress("SEQUENCER_FEED")
        });
        _validate(cfg);

        vm.startBroadcast();
        console2.log("Deployer:", msg.sender);
        d = _deploy(cfg);
        vm.stopBroadcast();

        _assertDeployInvariants(cfg, d);
        console2.log("TegridyFactory deployed:", address(d.factory));
        console2.log("TegridyRouter deployed:", address(d.router));
        console2.log("SwapFeeRouter deployed:", address(d.swapFeeRouter));
        console2.log("SwapFeeRouterAdmin deployed:", address(d.swapFeeRouterAdmin));
        console2.log("Opening fee (wei):", d.factory.POOL_OPENING_FEE());
        console2.log("Swap fee (bps):", d.swapFeeRouter.feeBps());
        console2.log("");
        console2.log("=== NEXT (operator): docs/POOL_OPENING_FEE_EVM.md, step 3 ===");
    }

    /// @notice Test entrypoint: same validation and read-backs, no env or broadcast.
    function runForTest(Config memory cfg) external returns (Deployed memory d) {
        _validate(cfg);
        d = _deploy(cfg);
        _assertDeployInvariants(cfg, d);
    }

    function _deploy(Config memory cfg) internal returns (Deployed memory d) {
        d.factory = new TegridyFactory(cfg.feeToSetter, cfg.treasury, cfg.guardian);
        d.router = new TegridyRouter(address(d.factory), cfg.weth);
        d.swapFeeRouter = new SwapFeeRouter(
            address(d.router), cfg.treasury, cfg.swapFeeBps, cfg.referralSplitter, cfg.revenueDistributor
        );
        // L2 only, one-shot, before ownership leaves (DeployBaseMVP's order).
        if (cfg.sequencerFeed != address(0)) d.swapFeeRouter.setSequencerFeed(cfg.sequencerFeed);
        d.swapFeeRouterAdmin = new SwapFeeRouterAdmin(address(d.swapFeeRouter));
        d.swapFeeRouter.setSwapFeeRouterAdmin(address(d.swapFeeRouterAdmin));
        if (cfg.pauseGuardian != address(0)) d.swapFeeRouter.setPauseGuardian(cfg.pauseGuardian);
        d.swapFeeRouter.transferOwnership(cfg.feeToSetter);
        d.swapFeeRouterAdmin.transferOwnership(cfg.feeToSetter);
    }

    function _validate(Config memory cfg) internal view {
        require(cfg.feeToSetter != address(0) && cfg.guardian != address(0), "set FEE_TO_SETTER and GUARDIAN");
        require(cfg.treasury != address(0) && cfg.weth != address(0), "zero env");
        require(cfg.revenueDistributor != address(0), "set REVENUE_DISTRIBUTOR");
        require(cfg.swapFeeBps == DEFAULT_SWAP_FEE_BPS, "SWAP_FEE_BPS != the live SwapFeeRouter's 50");
        require(
            block.chainid == 1 || block.chainid == BaseChainConfig.CHAIN_ID
                || block.chainid == RobinhoodChainConfig.CHAIN_ID,
            "CHAIN: Ethereum, Base or Robinhood only"
        );
        // The live factory has the hot deployer EOA in both roles (SAFE_REHOME_RUNBOOK.md).
        // This one starts on Safes: a plain EOA (no code) or a 7702-delegated one (23 bytes) is refused.
        _requireSafe(cfg.feeToSetter, "FEE_TO_SETTER must be a contract (Safe)");
        _requireSafe(cfg.guardian, "GUARDIAN must be a contract (Safe)");
        if (block.chainid == 1) {
            require(cfg.sequencerFeed == address(0), "SEQUENCER_FEED is for Base and Robinhood");
            return;
        }
        // Base and Robinhood: the live SwapFeeRouter's shape there, nothing else.
        address chainWeth =
            block.chainid == BaseChainConfig.CHAIN_ID ? BaseChainConfig.WETH : RobinhoodChainConfig.WETH;
        require(cfg.weth == chainWeth, "WETH != this chain's WETH");
        require(cfg.referralSplitter == address(0), "no referral splitter off Ethereum (no veTOWELI)");
        require(cfg.pauseGuardian != address(0), "set PAUSE_GUARDIAN");
        // The opening fee is paid to feeTo inside a 30k-gas transfer; a typo'd EOA would take it for good.
        _requireSafe(cfg.treasury, "TREASURY must be a contract (Safe)");
        _requireSafe(cfg.revenueDistributor, "REVENUE_DISTRIBUTOR must be the fee-remittance Safe");
        // Same round dialect the live SwapFeeRouter's feed answers in (SequencerCheck's gates).
        BaseChainConfig.requireUptimeDialect(cfg.sequencerFeed, "SEQUENCER_FEED");
    }

    function _requireSafe(address account, string memory reason) internal view {
        uint256 codeLen = account.code.length;
        require(codeLen > 0 && codeLen != EIP7702_DESIGNATOR_LENGTH, reason);
    }

    function _assertDeployInvariants(Config memory cfg, Deployed memory d) internal view {
        TegridyFactory factory = d.factory;
        require(factory.POOL_OPENING_FEE() == EXPECTED_OPENING_FEE, "opening fee != 0.006 ETH");
        require(factory.feeTo() == cfg.treasury, "feeTo != TREASURY");
        require(factory.feeToSetter() == cfg.feeToSetter, "feeToSetter != FEE_TO_SETTER");
        require(factory.guardian() == cfg.guardian, "guardian != GUARDIAN");
        require(factory.allPairsLength() == 0, "fresh factory has pairs");
        require(d.router.factory() == address(factory), "router not bound to the new factory");
        require(d.router.WETH() == cfg.weth, "router WETH != WETH");

        SwapFeeRouter sfr = d.swapFeeRouter;
        require(address(sfr.router()) == address(d.router), "SwapFeeRouter not bound to the new router");
        require(sfr.WETH() == cfg.weth, "SwapFeeRouter WETH != WETH");
        require(address(sfr.uniFactory()) == address(factory), "SwapFeeRouter factory != the new factory");
        require(sfr.feeBps() == cfg.swapFeeBps, "swap fee != SWAP_FEE_BPS");
        require(sfr.treasury() == cfg.treasury, "SwapFeeRouter treasury != TREASURY");
        require(sfr.revenueDistributor() == cfg.revenueDistributor, "distributor != REVENUE_DISTRIBUTOR");
        require(address(sfr.referralSplitter()) == cfg.referralSplitter, "splitter != REFERRAL_SPLITTER");
        require(sfr.swapFeeRouterAdmin() == address(d.swapFeeRouterAdmin), "admin not wired");
        require(sfr.sequencerFeed() == cfg.sequencerFeed, "SwapFeeRouter sequencerFeed != SEQUENCER_FEED");
        require(sfr.pauseGuardian() == cfg.pauseGuardian, "SwapFeeRouter pauseGuardian != PAUSE_GUARDIAN");
        require(sfr.pendingOwner() == cfg.feeToSetter, "SwapFeeRouter not handed to FEE_TO_SETTER");
        require(d.swapFeeRouterAdmin.pendingOwner() == cfg.feeToSetter, "admin not handed to FEE_TO_SETTER");
    }
}
