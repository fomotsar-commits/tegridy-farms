// The REAL dispatchable selector sets of the two Doppler StreamableFeesLocker
// deployments, captured from mainnet runtime bytecode — not from the SDK's types.
//
// WHY THIS FILE EXISTS
// A hand-rolled frontend ABI can declare any function it likes; nothing in a unit test
// that mocks the client will ever notice that the deployed contract has no such
// function. That is exactly how `readMigrationStream` shipped a `streams(bytes32)` call
// against a locker that has never had one: every test passed, every call reverted, and
// the catch reported the token as "not graduated" forever. Mocks cannot catch
// selector drift; only the deployed bytecode can. So we pin against the bytecode.
//
// HOW IT WAS CAPTURED (2026-07-30, mainnet, https://ethereum-rpc.publicnode.com)
// eth_getCode on each address, then an opcode-walk that adds every PUSH4 immediate
// while SKIPPING each PUSH's immediate bytes. Skipping the immediates is the whole
// point: a naive substring scan finds selector-looking byte sequences inside constants
// and metadata and reports functions that do not exist.
//
// ⚠ These sets are a strict SUPERSET of the dispatch table — a PUSH4 is also how the
// compiler materialises custom-error selectors (0x4e487b71 = Panic(uint256)) and masks
// (0xffffffff). That asymmetry is fine, and it is what makes the sets useful:
//   - ABSENCE from the set is PROOF the contract cannot dispatch that selector.
//   - PRESENCE means the selector appears in code; for every selector we actually call
//     we additionally confirmed behaviour with a real eth_call (see below).
//
// eth_call cross-check, same session — the two contracts are exactly complementary:
//   V1 0xe24F…1eC6   streams(bytes32) -> REVERT      positions(uint256) -> 128 bytes
//   V2 0xce32…3d47   streams(bytes32) -> 288 bytes   positions(uint256) -> REVERT
// A revert PROVES absence for an auto-generated public-mapping getter: an unknown key
// returns zeros, it never reverts. V1 has a receive() but no fallback(), so unknown
// calldata reverts rather than silently succeeding.
//
// V1 IS THE CORRECT TARGET, verified on-chain rather than assumed: our launches migrate
// through uniswapV4Migrator 0x0820…205f5, whose immutable getters return
// locker() = 0xe24FC2F7…1eC6 and migratorHook() = 0x4053D4fa…E500. Retargeting the read
// at V2 to "get streams() back" would point at a locker our launches never touch.
//
// TO RE-CAPTURE (e.g. if a locker is redeployed):
//   node frontend/scripts/capture-locker-selectors.mjs

import type { Address } from 'viem';

export interface DeployedLocker {
  address: Address;
  /** Runtime bytecode length in bytes, as returned by eth_getCode. */
  runtimeBytes: number;
  /** keccak256 of the runtime bytecode — changes if the address is ever redeployed. */
  codeHash: `0x${string}`;
  /** Every PUSH4 immediate reachable as code (superset of the dispatch table). */
  selectors: readonly `0x${string}`[];
}

/**
 * StreamableFeesLocker **V1** — the locker uniswapV4Migrator.locker() actually returns,
 * i.e. the one that will hold our launches' LP positions. Keyed by UniV4 position
 * tokenId (uint256) via `positions`; it has NO PoolId-keyed `streams` getter.
 */
export const DEPLOYED_LOCKER_V1: DeployedLocker = {
  address: '0xe24fc2f7191e850e2d4514abb4d39305b1871ec6',
  runtimeBytes: 7198,
  codeHash: '0x885061be48b3fa5e73fbf4d2205f5ae74dc17132a04d6cc7758917f38560139b',
  selectors: [
    '0x0a85bd01',
    '0x118cdaa7',
    '0x150b7a02', // onERC721Received(address,address,uint256,bytes)
    '0x1559b7d7',
    '0x1916c98f',
    '0x1e4fbdf7',
    '0x2063bbc1',
    '0x2f83ad6c',
    '0x3c9fd939',
    '0x3d2cec6f',
    '0x3e8eb5a4', // updateBeneficiary(uint256,address)
    '0x4a719bd4', // releaseFees(uint256)
    '0x4e487b71', // Panic(uint256) — error selector, not a function
    '0x5c46a7ef',
    '0x6029bf9f', // distributeFees(uint256)
    '0x6ec9be11',
    '0x70a08231', // NOT dispatched by V1 — an OUTGOING ERC20 call the code builds
    '0x715018a6', // renounceOwnership()
    '0x791b98bc', // positionManager()
    '0x7ba03aad',
    '0x7deeb523',
    '0x880d6c75',
    '0x8da5cb5b', // owner()
    '0x90bfb865',
    '0x93f21393', // beneficiariesClaims(address,address)  <- we call this
    '0x99fbab88', // positions(uint256)                    <- we call this
    '0xa9059cbb',
    '0xab143c06',
    '0xdd46508f',
    '0xdf81c4e3', // revokeMigrator(address)
    '0xe5145d4a', // approveMigrator(address)
    '0xf2fde38b', // transferOwnership(address)
    '0xffffffff', // mask, not a function
  ],
};

/**
 * StreamableFeesLocker **V2** — recorded only to prove the two are NOT interchangeable.
 * It HAS `streams(bytes32)` and does NOT have `positions(uint256)`, which is why
 * importing the SDK's (V2-shaped) `streamableFeesLockerAbi` and pointing it at V1
 * produced a call that could never succeed. We do not read this contract.
 */
export const DEPLOYED_LOCKER_V2: DeployedLocker = {
  address: '0xce3212e6536f33cd6fbfee265224131353ca3d47',
  runtimeBytes: 9347,
  codeHash: '0x21e0d7fe632a7eaac901874f5f73b8a6fdf2cffa099deeebe708ffe1dc4a90da',
  selectors: [
    '0x0476982d',
    '0x09e43977',
    '0x0b0d9c09',
    '0x118cdaa7',
    '0x1564cf6c',
    '0x1e4fbdf7',
    '0x29610465',
    '0x2b1fd599',
    '0x2b6dc823',
    '0x2d35e7ed',
    '0x31f5e511',
    '0x37e81a19',
    '0x3a7be37b',
    '0x3c9fd939',
    '0x3d2cec6f',
    '0x48c89491',
    '0x4e487b71',
    '0x5210bb2b',
    '0x570c1085',
    '0x5a302347',
    '0x5ebb58fb',
    '0x6edcc523',
    '0x715018a6',
    '0x7deeb523',
    '0x7f7bd2df', // streams(bytes32) — present HERE, absent on V1
    '0x817db73b',
    '0x880d6c75',
    '0x8d5b0c86',
    '0x8da5cb5b',
    '0x90bfb865',
    '0x91dd7346',
    '0x93dafdf1',
    '0xa9059cbb',
    '0xab143c06',
    '0xcb7dd8f2',
    '0xd44f6738',
    '0xdc4c90d3',
    '0xdf81c4e3',
    '0xe5145d4a',
    '0xe5598293',
    '0xe736b3d1',
    '0xf2fde38b',
    '0xfc6e3bef',
    '0xffffffff',
  ],
};
