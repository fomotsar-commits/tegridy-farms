// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import {TegridyStaking} from "../src/TegridyStaking.sol";
import {TegridyStakingJbacVault} from "../src/TegridyStakingJbacVault.sol";
import {TegridyStakingAdmin} from "../src/TegridyStakingAdmin.sol";
import {StakingMonitorView} from "../src/StakingMonitorView.sol";
import {TegridyTokenURIReader} from "../src/TegridyTokenURIReader.sol";
import {TegridyLPFarming} from "../src/TegridyLPFarming.sol";
import {RevenueDistributor} from "../src/RevenueDistributor.sol";
import {ReferralSplitter} from "../src/ReferralSplitter.sol";
import {SwapFeeRouterAdmin} from "../src/SwapFeeRouterAdmin.sol";

/// @title  DeployStakingRelease1 — the staking release (75% early exit, M-S6, M-S7, M-G3)
/// @notice Deploys, on Ethereum mainnet, the new staking stack next to the old one:
///           libraries  StakingViewLib + StakingRewardLib (linked, deployed by forge itself)
///           1 TegridyStaking (early exit 75%)      6 TegridyTokenURIReader
///           2 TegridyStakingJbacVault              7 TegridyLPFarming
///           3 TegridyStakingAdmin                  8 RevenueDistributor
///           4 StakingMonitorView                   9 ReferralSplitter
///         and starts the two 48-hour clocks that point the live SwapFeeRouter at the new
///         RevenueDistributor and ReferralSplitter. It does NOT execute them, fund anything,
///         or touch the old contracts. Step 2 is `ExecuteStakingRelease1Repoint.s.sol`.
///
/// @dev    WHY StakingRewardLib IS DEPLOYED AGAIN, although the 2026-10-14 findings doc said it
///         could be reused: the live copy (0xb86A763a92A24e0951658E52d54CE50A5D52C1Ea) predates
///         five later fixes and does NOT contain 4 of the 7 functions this TegridyStaking calls
///         (getReward, kick, settleRewardsOnTransfer, claimUnsettledForTokenId: selectors
///         151ae175 44e22c47 f83aa170 53042621 are absent from its bytecode, read 2026-10-14).
///         Linking to it would make every claim, exit and NFT transfer revert. So do NOT pass
///         `--libraries ...StakingRewardLib:0xb86A...`; let forge deploy both libraries.
///
///         VALUES. Every value is copied from the live contract it replaces, read at run time,
///         and compared against what was read on 2026-10-14 (block 26,190,643). If anything has
///         moved since, the run aborts before sending: look at why first.
///         Three values are NOT copied, all owner rulings (2026-10-18; the cap raised 2026-10-30):
///           - per-wallet stake cap 10,000,000 TOWELI (owner 2026-10-30; it was 1,000,000 from
///             2026-10-18). The old contract's 50,000 is still asserted;
///           - NO whole-pool cap: `maxTotalStaked` is left at its constructor default, uncapped
///             (the old contract's 5,000,000 is still asserted);
///           - NO reward rate: the contract starts at 0 and sets its own rate from each funding,
///             the funds plus what is still scheduled spread over four years (REWARDS_DURATION).
///             Step 2 (`FundStakingRelease1.s.sol`) is what starts the payouts.
///
///         OWNER. Must be broadcast BY the address that owns every live contract today,
///         0x14898258122C0740106391E6e8E4F17F3b6d456E. Each new contract is owned by its
///         deployer, so ownership ends exactly where it is now; there is no transfer step.
///
///         forge script script/DeployStakingRelease1.s.sol --rpc-url mainnet \
///           --sender 0x14898258122C0740106391E6e8E4F17F3b6d456E --interactive --broadcast --slow
contract DeployStakingRelease1Script is Script {
    // ─── Live mainnet contracts (frontend/scripts/addresses.json) ────────────
    address constant OLD_STAKING = 0xcaDc93E96De58EA554c71ca609974625615E046D;
    address constant OLD_STAKING_ADMIN = 0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3;
    address constant OLD_JBAC_VAULT = 0x28317bf362d43b40fceCEbf2390c43Db558c3f14;
    address constant OLD_LP_FARM = 0x1171268AE5B69791c47Fd589b7825932c957e149;
    address constant OLD_REV_DIST = 0xF993316E2fC079de4358c489A935E01e03E23E17;
    address constant OLD_REF_SPLITTER = 0x6B3442dAcB62d40BA39fCe9b3CDa350FEa6f7e4c;
    address constant SWAP_FEE_ROUTER = 0x6d5791A660e79175F74C6D639584C98422d5956E;
    address constant SWAP_FEE_ROUTER_ADMIN = 0xa517A1cEfd961c0DDE8155a0Fa870aEE5bb0D060;

    // ─── Values read on chain 2026-10-14 (block 26,190,643); asserted again at run time ──
    address constant OWNER = 0x14898258122C0740106391E6e8E4F17F3b6d456E;
    address constant TOWELI = 0x420698CFdEDdEa6bc78D59bC17798113ad278F9D;
    address constant JBAC = 0xd37264c71e9af940e49795F0d3a8336afAaFDdA9;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant TREASURY = 0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d; // Safe
    address constant PAUSE_GUARDIAN = 0xCDCA0F0621ce34012AD61bBD140f327EB778F354; // Safe
    address constant TEGRIDY_LP = 0x55875887B43C2E23aE424AF0FC8606Fdb058a481; // LP farm's staking token
    uint256 constant OLD_MAX_STAKE_PER_USER = 50_000e18;
    uint256 constant MAX_STAKE_PER_USER = 10_000_000e18; // owner 2026-10-30: the new contract's cap (was 1,000,000)
    uint256 constant OLD_MAX_TOTAL_STAKED = 5_000_000e18;
    uint256 constant MAX_UNSETTLED_REWARDS = 100_000e18; // constructor default; asserted, not set
    uint256 constant LP_REWARDS_DURATION = 7 days;
    uint256 constant REFERRAL_FEE_BPS = 2000;

    uint256 constant NEW_EARLY_EXIT_BPS = 7500;

    struct Deployed {
        address staking;
        address jbacVault;
        address stakingAdmin;
        address monitorView;
        address tokenURIReader;
        address lpFarm;
        address revenueDistributor;
        address referralSplitter;
    }

    function run() external returns (Deployed memory d) {
        require(block.chainid == 1, "MAINNET_ONLY");

        _assertLiveStillMatches();

        vm.startBroadcast();
        require(msg.sender == OWNER, "sender must be the owner 0x14898258122C0740106391E6e8E4F17F3b6d456E");

        // 1-3. Staking + its two one-shot sisters. Libraries are linked and deployed by forge.
        TegridyStaking staking = new TegridyStaking(TOWELI, JBAC, TREASURY);
        d.staking = address(staking);
        TegridyStakingJbacVault vault = new TegridyStakingJbacVault(JBAC, d.staking);
        d.jbacVault = address(vault);
        staking.setJbacVault(d.jbacVault);
        TegridyStakingAdmin admin = new TegridyStakingAdmin(d.staking);
        d.stakingAdmin = address(admin);
        staking.setStakingAdmin(d.stakingAdmin);
        staking.setPauseGuardian(PAUSE_GUARDIAN);
        staking.setMaxStakePerUser(MAX_STAKE_PER_USER);

        // 4-7. Readers and the LP farm: each binds the new staking as an immutable.
        d.monitorView = address(new StakingMonitorView(d.staking));
        d.tokenURIReader = address(new TegridyTokenURIReader(d.staking));
        d.lpFarm = address(new TegridyLPFarming(TOWELI, TEGRIDY_LP, d.staking, TREASURY, LP_REWARDS_DURATION));

        // 8. RevenueDistributor (ETH fee share to stakers of the NEW contract).
        RevenueDistributor revDist = new RevenueDistributor(d.staking, TREASURY, WETH);
        d.revenueDistributor = address(revDist);
        revDist.setPauseGuardian(PAUSE_GUARDIAN);

        // 9. ReferralSplitter: approve the live swap router, then lock the instant setter.
        ReferralSplitter splitter = new ReferralSplitter(REFERRAL_FEE_BPS, d.staking, TREASURY, WETH);
        d.referralSplitter = address(splitter);
        splitter.setApprovedCaller(SWAP_FEE_ROUTER, true);
        splitter.completeSetup();

        // Start the two 48h clocks on the live router's admin. Executed by step 2, not here.
        SwapFeeRouterAdmin(SWAP_FEE_ROUTER_ADMIN).proposeRevenueDistributor(d.revenueDistributor);
        SwapFeeRouterAdmin(SWAP_FEE_ROUTER_ADMIN).proposeReferralSplitterChange(d.referralSplitter);

        vm.stopBroadcast();

        _assertDeployed(d);
        _log(d);
    }

    /// Every value this script copies must still be what the live contracts hold.
    function _assertLiveStillMatches() internal view {
        TegridyStaking old = TegridyStaking(OLD_STAKING);
        require(old.owner() == OWNER, "live staking owner moved");
        require(address(old.rewardToken()) == TOWELI, "live staking rewardToken moved");
        require(address(old.jbacNFT()) == JBAC, "live staking jbacNFT moved");
        require(old.treasury() == TREASURY, "live staking treasury moved");
        require(old.pauseGuardian() == PAUSE_GUARDIAN, "live staking pauseGuardian moved");
        require(old.maxStakePerUser() == OLD_MAX_STAKE_PER_USER, "live maxStakePerUser moved");
        require(old.maxTotalStaked() == OLD_MAX_TOTAL_STAKED, "live maxTotalStaked moved");
        require(old.maxUnsettledRewards() == MAX_UNSETTLED_REWARDS, "live maxUnsettledRewards moved");
        require(old.restakingContract() == address(0), "live staking has a restaking contract now");
        require(old.EARLY_WITHDRAWAL_PENALTY_BPS() == 2500, "this is not the 25% contract");

        TegridyLPFarming farm = TegridyLPFarming(OLD_LP_FARM);
        require(farm.owner() == OWNER, "live LP farm owner moved");
        require(address(farm.rewardToken()) == TOWELI, "live LP farm rewardToken moved");
        require(address(farm.stakingToken()) == TEGRIDY_LP, "live LP farm stakingToken moved");
        require(farm.treasury() == TREASURY, "live LP farm treasury moved");
        require(farm.rewardsDuration() == LP_REWARDS_DURATION, "live LP farm rewardsDuration moved");

        RevenueDistributor rd = RevenueDistributor(payable(OLD_REV_DIST));
        require(rd.owner() == OWNER, "live RevenueDistributor owner moved");
        require(rd.treasury() == TREASURY, "live RevenueDistributor treasury moved");
        require(address(rd.weth()) == WETH, "live RevenueDistributor weth moved");
        require(rd.pauseGuardian() == PAUSE_GUARDIAN, "live RevenueDistributor pauseGuardian moved");
        require(address(rd.restakingContract()) == address(0), "live RevenueDistributor has restaking now");

        ReferralSplitter rs = ReferralSplitter(payable(OLD_REF_SPLITTER));
        require(rs.owner() == OWNER, "live ReferralSplitter owner moved");
        require(rs.treasury() == TREASURY, "live ReferralSplitter treasury moved");
        require(rs.weth() == WETH, "live ReferralSplitter weth moved");
        require(rs.referralFeeBps() == REFERRAL_FEE_BPS, "live referral fee moved");
        require(rs.approvedCallers(SWAP_FEE_ROUTER), "live splitter no longer approves the router");

        require(TegridyStakingAdmin(OLD_STAKING_ADMIN).owner() == OWNER, "live staking admin owner moved");
        SwapFeeRouterAdmin sfra = SwapFeeRouterAdmin(SWAP_FEE_ROUTER_ADMIN);
        require(sfra.owner() == OWNER, "router admin owner moved");
        require(sfra.revenueDistributorChangeTime() == 0, "a router distributor change is already queued");
        require(sfra.referralSplitterChangeTime() == 0, "a router splitter change is already queued");
        (bool ok, bytes memory ret) = SWAP_FEE_ROUTER.staticcall(abi.encodeWithSignature("revenueDistributor()"));
        require(ok && abi.decode(ret, (address)) == OLD_REV_DIST, "router no longer points at the old distributor");
        (ok, ret) = SWAP_FEE_ROUTER.staticcall(abi.encodeWithSignature("referralSplitter()"));
        require(ok && abi.decode(ret, (address)) == OLD_REF_SPLITTER, "router no longer points at the old splitter");
    }

    function _assertDeployed(Deployed memory d) internal view {
        TegridyStaking s = TegridyStaking(d.staking);
        require(s.EARLY_WITHDRAWAL_PENALTY_BPS() == NEW_EARLY_EXIT_BPS, "new staking is not 75%");
        require(s.owner() == OWNER && s.pendingOwner() == address(0), "staking owner");
        require(s.rewardRate() == 0 && s.periodFinish() == 0, "pays nothing until step 2 funds it");
        require(s.REWARDS_DURATION() == 4 * 365 days, "rewards are spread over four years");
        require(address(s.rewardToken()) == TOWELI && address(s.jbacNFT()) == JBAC, "tokens");
        require(s.treasury() == TREASURY, "treasury");
        require(s.jbacVault() == d.jbacVault && s.stakingAdmin() == d.stakingAdmin, "sisters");
        require(s.pauseGuardian() == PAUSE_GUARDIAN, "guardian");
        require(s.maxStakePerUser() == MAX_STAKE_PER_USER && s.maxTotalStaked() == type(uint256).max, "caps");
        require(s.maxUnsettledRewards() == MAX_UNSETTLED_REWARDS, "unsettled cap");
        require(TegridyStakingJbacVault(d.jbacVault).staking() == d.staking, "vault -> staking");
        require(address(TegridyStakingAdmin(d.stakingAdmin).staking()) == d.staking, "admin -> staking");
        require(TegridyStakingAdmin(d.stakingAdmin).owner() == OWNER, "admin owner");
        require(address(StakingMonitorView(d.monitorView).staking()) == d.staking, "view -> staking");
        require(address(TegridyTokenURIReader(d.tokenURIReader).staking()) == d.staking, "uri -> staking");
        TegridyLPFarming f = TegridyLPFarming(d.lpFarm);
        require(address(f.tegridyStaking()) == d.staking && f.owner() == OWNER, "farm");
        require(address(f.stakingToken()) == TEGRIDY_LP && f.treasury() == TREASURY, "farm config");
        RevenueDistributor rd = RevenueDistributor(payable(d.revenueDistributor));
        require(address(rd.votingEscrow()) == d.staking && rd.owner() == OWNER, "distributor");
        require(rd.treasury() == TREASURY && rd.pauseGuardian() == PAUSE_GUARDIAN, "distributor config");
        ReferralSplitter rs = ReferralSplitter(payable(d.referralSplitter));
        require(address(rs.stakingContract()) == d.staking && rs.owner() == OWNER, "splitter");
        require(rs.approvedCallers(SWAP_FEE_ROUTER) && rs.setupComplete(), "splitter wiring");
        require(rs.referralFeeBps() == REFERRAL_FEE_BPS && rs.treasury() == TREASURY, "splitter config");
        SwapFeeRouterAdmin sfra = SwapFeeRouterAdmin(SWAP_FEE_ROUTER_ADMIN);
        require(sfra.pendingRevenueDistributor() == d.revenueDistributor, "router distributor proposal");
        require(sfra.pendingReferralSplitter() == d.referralSplitter, "router splitter proposal");
    }

    function _log(Deployed memory d) internal view {
        console2.log("=== STAKING RELEASE 1 DEPLOYED (early exit 75%) ===");
        console2.log("TegridyStaking          ", d.staking);
        console2.log("TegridyStakingJbacVault ", d.jbacVault);
        console2.log("TegridyStakingAdmin     ", d.stakingAdmin);
        console2.log("StakingMonitorView      ", d.monitorView);
        console2.log("TegridyTokenURIReader   ", d.tokenURIReader);
        console2.log("TegridyLPFarming        ", d.lpFarm);
        console2.log("RevenueDistributor      ", d.revenueDistributor);
        console2.log("ReferralSplitter        ", d.referralSplitter);
        console2.log("reward rate: 0 until step 2; then funds / 1,460 days per day");
        console2.log("stake cap per wallet (TOWELI)", MAX_STAKE_PER_USER / 1e18);
        console2.log("stake cap, whole pool: none");
        uint256 readyAt = SwapFeeRouterAdmin(SWAP_FEE_ROUTER_ADMIN).revenueDistributorChangeTime();
        console2.log("router re-point ready at (unix)", readyAt);
        console2.log("router re-point expires at (unix)", readyAt + 7 days);
        console2.log("");
        console2.log("NEXT (owner):");
        console2.log(" a) fund the new staking (FundStakingRelease1.s.sol). It pays nothing until then;");
        console2.log("    the funds are then paid out over four years, funds / 1,460 per day.");
        console2.log(" b) after the ready time and within 7 days: ExecuteStakingRelease1Repoint.s.sol");
        console2.log(" c) site: new addresses + 75% copy, old contract kept for its 16 positions");
    }
}
