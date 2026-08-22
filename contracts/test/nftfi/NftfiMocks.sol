// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @dev WETH-shaped ERC20. The nftfi contracts never unwrap, so `deposit` is
///      only here to let a test fund an actor the way the real thing would.
contract MockWethNftfi is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockCollection is ERC721 {
    uint256 private _next = 1;

    constructor(string memory n, string memory s) ERC721(n, s) {}

    function mint(address to) external returns (uint256 id) {
        id = _next++;
        _mint(to, id);
    }
}

/// @dev A collection whose `transferFrom` silently does nothing. The vault must
///      refuse to hand out a loan against collateral it did not actually take —
///      `ok == true` from a bounded call proves the call did not revert, never
///      that a token moved.
contract NoOpTransferCollection is ERC721 {
    uint256 private _next = 1;

    constructor() ERC721("NoOp", "NOOP") {}

    function mint(address to) external returns (uint256 id) {
        id = _next++;
        _mint(to, id);
    }

    function transferFrom(address, address, uint256) public pure override {
        return;
    }
}
