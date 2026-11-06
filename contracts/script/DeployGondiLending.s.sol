// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";

/// @dev Gondi's admin and read surface, named as in their verified source
///      (contracts/vendor/gondi-v3.2/sources). Only what this script calls.
interface IGondiOwned {
    function owner() external view returns (address);
    function transferOwnership(address newOwner) external; // solmate Owned: one step
}

interface IGondiTwoStepOwned {
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function requestTransferOwner(address newOwner) external; // the Safe calls transferOwnership() after MIN_WAIT_TIME
}

interface IGondiAddressManager {
    function isWhitelisted(address entry) external view returns (bool);
}

interface IGondiLiquidationDistributor {
    function setLiquidator(address liquidator) external;
    function getLiquidator() external view returns (address);
}

interface IGondiLiquidator {
    function addLoanContract(address loanContract) external;
    function getValidLoanContracts() external view returns (address[] memory);
    function getLiquidationDistributor() external view returns (address);
    function getTriggerFee() external view returns (uint256);
    function getMaxExtension() external view returns (uint96);
    function getTimeForMainLenderToBuy() external view returns (uint256);
}

interface IGondiLoan {
    struct ProtocolFee {
        address recipient;
        uint256 fraction;
    }

    function getProtocolFee() external view returns (ProtocolFee memory);
    function getLiquidator() external view returns (address);
    function getCurrencyManager() external view returns (address);
    function getCollectionManager() external view returns (address);
    function getMaxTranches() external view returns (uint256);
    function getMinLockPeriod() external view returns (uint256);
    function getDelegateRegistry() external view returns (address);
    function getLoanManagerRegistry() external view returns (address);
    function getFlashActionContract() external view returns (address);
    function getLiquidationAuctionDuration() external view returns (uint48);
    function getMinImprovementApr() external view returns (uint256);
    function getTotalLoansIssued() external view returns (uint256);
}

/// @title  DeployGondiLending — Gondi's NFT lending contracts, unchanged, as our venue
/// @notice Deploys Gondi's v3.2 loan contract and the five contracts it needs, from the
///         bytecode in contracts/vendor/gondi-v3.2/build. That bytecode is Gondi's verified
///         source compiled with their exact settings, and it matches their own mainnet
///         deploys byte for byte (`node contracts/vendor/gondi-v3.2/build.mjs --mainnet <rpc>`).
///         Each creation code is also pinned by hash below, so a swapped build file stops the
///         script.
///
///         Every setting is Gondi's live value, read from their deploy txs on 2026-10-27,
///         except two:
///         - the protocol fee goes to OUR treasury, at 5% of the lender's interest
///           (Gondi: 20% to their own address);
///         - the allowed collections are Jungle Bay, Nakamigos and GNSS, and the only
///           currency is WETH.
///         Gondi's Purchase Bundler (the "Sell & Repay" add-on behind their 2026-03-09
///         exploit) is NOT deployed, and no flash-action contract is set, as on Gondi's own
///         live deploy.
/// @dev    Env: MULTISIG (the admin Safe; must be a contract), TREASURY, WETH,
///         PROTOCOL_FEE_BPS (default 500 = 5% of interest).
///         Ownership: the two allow-lists, the distributor and the registry move to MULTISIG
///         in the same broadcast (solmate Owned is one step). The loan contract and the
///         liquidator use Gondi's TwoStepOwned: this script requests the transfer and the
///         Safe calls `transferOwnership()` once MIN_WAIT_TIME (2 days) has passed.
contract DeployGondiLendingScript is Script {
    // ─── Gondi's mainnet values (deploy txs: see contracts/vendor/gondi-v3.2/settings) ───
    uint256 public constant MAX_TRANCHES = 10;
    uint256 public constant MIN_LOCK_PERIOD = 1500; // of 10000: Gondi's refinance lock
    uint256 public constant MIN_WAIT_TIME = 2 days; // TwoStepOwned delay
    uint256 public constant TRIGGER_FEE = 0; // liquidator: nobody is paid to start an auction
    uint96 public constant MAX_EXTENSION = 4 days;
    uint256 public constant TIME_FOR_MAIN_LENDER_TO_BUY = 2 days;
    address public constant DELEGATE_REGISTRY = 0x00000000000000447e69651d841bD8D104Bed493; // delegate.xyz v2
    address public constant FLASH_ACTION_CONTRACT = address(0);

    // ─── Ours ───
    uint256 public constant DEFAULT_PROTOCOL_FEE_BPS = 500; // 5% of the lender's interest
    address public constant JBAC = 0xd37264c71e9af940e49795F0d3a8336afAaFDdA9;
    address public constant NAKAMIGOS = 0xd774557b647330C91Bf44cfEAB205095f7E6c367;
    address public constant GNSS = 0xa1De9f93c56C290C48849B1393b09eB616D55dbb;

    // keccak256 of each creation code in vendor/gondi-v3.2/build (= Gondi's deploy tx input
    // minus constructor args).
    bytes32 public constant LOAN_MANAGER_REGISTRY_CODEHASH =
        0x60139cdd0623038fc980cc789517a79607ac419ba0cc6134e92f9beed853e012;
    bytes32 public constant ADDRESS_MANAGER_CODEHASH =
        0x46e0d01d19d240186ee5b8a3f7ed9ff919941ae4ff0ac067bd3db5043ff83aeb;
    bytes32 public constant LIQUIDATION_DISTRIBUTOR_CODEHASH =
        0x4928ee671b0d9b574e3bf6aa7bbc07a110d190ff3f04b8a298294c1f172d96a0;
    bytes32 public constant LIQUIDATOR_CODEHASH = 0x5e560219cd01d43ff067111efce2d59da2782b26825bf6156980d823d7e0403c;
    bytes32 public constant MULTI_SOURCE_LOAN_CODEHASH =
        0xe29351ffe8f7267c3c9cddcb61185aa37ac1b44202e30299a56f0c3f8e3726a9;

    struct Config {
        address multisig;
        address treasury;
        address weth;
        uint256 protocolFeeBps;
    }

    struct Deployed {
        address loanManagerRegistry;
        address currencyManager;
        address collectionManager;
        address liquidationDistributor;
        address liquidator;
        address loan;
    }

    function run() external returns (Deployed memory d) {
        Config memory cfg = Config({
            multisig: vm.envAddress("MULTISIG"),
            treasury: vm.envAddress("TREASURY"),
            weth: vm.envAddress("WETH"),
            protocolFeeBps: vm.envOr("PROTOCOL_FEE_BPS", DEFAULT_PROTOCOL_FEE_BPS)
        });
        _validate(cfg);
        bytes[5] memory code = _loadCode();

        vm.startBroadcast();
        console2.log("Deployer:", msg.sender);
        d = _deploy(cfg, code);
        vm.stopBroadcast();

        _assertDeployInvariants(cfg, d, msg.sender);
        console2.log("MultiSourceLoan (the loan contract):", d.loan);
        console2.log("AuctionWithBuyoutLoanLiquidator:", d.liquidator);
        console2.log("LiquidationDistributor:", d.liquidationDistributor);
        console2.log("AddressManager, currencies:", d.currencyManager);
        console2.log("AddressManager, collections:", d.collectionManager);
        console2.log("LoanManagerRegistry:", d.loanManagerRegistry);
        console2.log("");
        console2.log("=== NEXT (Safe, after 2 days) ===");
        console2.log("1. MULTISIG.transferOwnership() on the loan contract ->", d.loan);
        console2.log("2. MULTISIG.transferOwnership() on the liquidator ->", d.liquidator);
        console2.log("3. Put the loan contract's address in the site (frontend/src/lib/constants.ts).");
    }

    /// @notice Test entrypoint: same validation, code pins and read-backs. `deployer` plays
    ///         the broadcasting wallet (Gondi's registry takes its owner from tx.origin).
    function runForTest(Config memory cfg, address deployer) external returns (Deployed memory d) {
        _validate(cfg);
        bytes[5] memory code = _loadCode();
        vm.startBroadcast(deployer);
        d = _deploy(cfg, code);
        vm.stopBroadcast();
        _assertDeployInvariants(cfg, d, deployer);
    }

    function _validate(Config memory cfg) internal view {
        require(block.chainid == 1, "MAINNET_ONLY: gated features deploy to Ethereum mainnet");
        require(cfg.multisig != address(0) && cfg.treasury != address(0) && cfg.weth != address(0), "zero env");
        require(cfg.multisig.code.length > 0, "MULTISIG must be a contract (Safe)");
        require(cfg.weth.code.length > 0, "WETH has no code");
        require(cfg.protocolFeeBps <= 10_000, "fee above 100%");
    }

    function _loadCode() internal view returns (bytes[5] memory code) {
        code[0] = _creationCode("LoanManagerRegistry", LOAN_MANAGER_REGISTRY_CODEHASH);
        code[1] = _creationCode("AddressManager", ADDRESS_MANAGER_CODEHASH);
        code[2] = _creationCode("LiquidationDistributor", LIQUIDATION_DISTRIBUTOR_CODEHASH);
        code[3] = _creationCode("AuctionWithBuyoutLoanLiquidator", LIQUIDATOR_CODEHASH);
        code[4] = _creationCode("MultiSourceLoan", MULTI_SOURCE_LOAN_CODEHASH);
    }

    function _creationCode(string memory name, bytes32 expected) internal view returns (bytes memory code) {
        string memory path = string.concat(vm.projectRoot(), "/vendor/gondi-v3.2/build/", name, ".json");
        code = vm.parseJsonBytes(vm.readFile(path), ".bytecode");
        require(keccak256(code) == expected, string.concat(name, ": build file is not Gondi's pinned bytecode"));
    }

    function _deploy(Config memory cfg, bytes[5] memory code) internal returns (Deployed memory d) {
        address[] memory currencies = new address[](1);
        currencies[0] = cfg.weth;
        address[] memory collections = new address[](3);
        collections[0] = JBAC;
        collections[1] = NAKAMIGOS;
        collections[2] = GNSS;

        d.loanManagerRegistry = _create(code[0]);
        d.currencyManager = _create(bytes.concat(code[1], abi.encode(currencies)));
        d.collectionManager = _create(bytes.concat(code[1], abi.encode(collections)));
        d.liquidationDistributor = _create(bytes.concat(code[2], abi.encode(d.loanManagerRegistry)));
        d.liquidator = _create(
            bytes.concat(
                code[3],
                abi.encode(
                    d.liquidationDistributor,
                    d.currencyManager,
                    d.collectionManager,
                    d.loanManagerRegistry,
                    TRIGGER_FEE,
                    MAX_EXTENSION,
                    TIME_FOR_MAIN_LENDER_TO_BUY,
                    MIN_WAIT_TIME
                )
            )
        );
        d.loan = _create(
            bytes.concat(
                code[4],
                abi.encode(
                    d.liquidator,
                    IGondiLoan.ProtocolFee({recipient: cfg.treasury, fraction: cfg.protocolFeeBps}),
                    d.currencyManager,
                    d.collectionManager,
                    MAX_TRANCHES,
                    MIN_LOCK_PERIOD,
                    DELEGATE_REGISTRY,
                    d.loanManagerRegistry,
                    FLASH_ACTION_CONTRACT,
                    MIN_WAIT_TIME
                )
            )
        );

        // Wiring, exactly as on Gondi's deploy: distributor -> liquidator -> loan contract.
        IGondiLiquidationDistributor(d.liquidationDistributor).setLiquidator(d.liquidator);
        IGondiLiquidator(d.liquidator).addLoanContract(d.loan);

        // Ownership to the Safe.
        IGondiOwned(d.currencyManager).transferOwnership(cfg.multisig);
        IGondiOwned(d.collectionManager).transferOwnership(cfg.multisig);
        IGondiOwned(d.liquidationDistributor).transferOwnership(cfg.multisig);
        IGondiOwned(d.loanManagerRegistry).transferOwnership(cfg.multisig);
        IGondiTwoStepOwned(d.liquidator).requestTransferOwner(cfg.multisig);
        IGondiTwoStepOwned(d.loan).requestTransferOwner(cfg.multisig);
    }

    function _create(bytes memory initCode) internal returns (address deployed) {
        assembly {
            deployed := create(0, add(initCode, 0x20), mload(initCode))
        }
        require(deployed != address(0) && deployed.code.length > 0, "create failed");
    }

    function _assertDeployInvariants(Config memory cfg, Deployed memory d, address deployer) internal view {
        IGondiLoan loan = IGondiLoan(d.loan);
        IGondiLoan.ProtocolFee memory fee = loan.getProtocolFee();
        require(fee.recipient == cfg.treasury, "fee recipient != TREASURY");
        require(fee.fraction == cfg.protocolFeeBps, "fee != PROTOCOL_FEE_BPS");
        require(loan.getLiquidator() == d.liquidator, "loan: liquidator");
        require(loan.getCurrencyManager() == d.currencyManager, "loan: currency manager");
        require(loan.getCollectionManager() == d.collectionManager, "loan: collection manager");
        require(loan.getMaxTranches() == MAX_TRANCHES, "loan: max tranches");
        require(loan.getMinLockPeriod() == MIN_LOCK_PERIOD, "loan: min lock period");
        require(loan.getDelegateRegistry() == DELEGATE_REGISTRY, "loan: delegate registry");
        require(loan.getLoanManagerRegistry() == d.loanManagerRegistry, "loan: loan manager registry");
        require(loan.getFlashActionContract() == FLASH_ACTION_CONTRACT, "loan: flash action set");
        require(loan.getLiquidationAuctionDuration() == 3 days, "loan: auction duration != Gondi's");
        require(loan.getMinImprovementApr() == 1000, "loan: min improvement != Gondi's");
        require(loan.getTotalLoansIssued() == 0, "loan: not fresh");

        IGondiLiquidator liq = IGondiLiquidator(d.liquidator);
        address[] memory loans = liq.getValidLoanContracts();
        require(loans.length == 1 && loans[0] == d.loan, "liquidator: loan contract");
        require(liq.getLiquidationDistributor() == d.liquidationDistributor, "liquidator: distributor");
        require(liq.getTriggerFee() == TRIGGER_FEE, "liquidator: trigger fee");
        require(liq.getMaxExtension() == MAX_EXTENSION, "liquidator: max extension");
        require(liq.getTimeForMainLenderToBuy() == TIME_FOR_MAIN_LENDER_TO_BUY, "liquidator: buyout window");
        require(
            IGondiLiquidationDistributor(d.liquidationDistributor).getLiquidator() == d.liquidator,
            "distributor: liquidator"
        );

        IGondiAddressManager cur = IGondiAddressManager(d.currencyManager);
        IGondiAddressManager col = IGondiAddressManager(d.collectionManager);
        require(cur.isWhitelisted(cfg.weth), "WETH not allowed");
        require(
            col.isWhitelisted(JBAC) && col.isWhitelisted(NAKAMIGOS) && col.isWhitelisted(GNSS), "collection missing"
        );

        require(IGondiOwned(d.currencyManager).owner() == cfg.multisig, "currencies: owner");
        require(IGondiOwned(d.collectionManager).owner() == cfg.multisig, "collections: owner");
        require(IGondiOwned(d.liquidationDistributor).owner() == cfg.multisig, "distributor: owner");
        require(IGondiOwned(d.loanManagerRegistry).owner() == cfg.multisig, "registry: owner");
        require(IGondiTwoStepOwned(d.liquidator).owner() == deployer, "liquidator: owner");
        require(IGondiTwoStepOwned(d.liquidator).pendingOwner() == cfg.multisig, "liquidator: pending owner");
        require(IGondiTwoStepOwned(d.loan).owner() == deployer, "loan: owner");
        require(IGondiTwoStepOwned(d.loan).pendingOwner() == cfg.multisig, "loan: pending owner");
    }
}
