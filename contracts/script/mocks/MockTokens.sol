// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title MockTOWELI - Testnet ERC20 token
contract MockTOWELI is ERC20 {
    constructor() ERC20("Towelie", "TOWELI") {
        _mint(msg.sender, 1_000_000_000 ether); // 1B supply
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title MockJBAC - Testnet ERC721 NFT (JBAC boost NFT)
contract MockJBAC is ERC721 {
    uint256 private _nextId = 1;

    constructor() ERC721("JBAC NFT", "JBAC") {}

    function mint(address to) external returns (uint256) {
        uint256 id = _nextId++;
        _mint(to, id);
        return id;
    }

    function mintBatch(address to, uint256 count) external {
        for (uint256 i = 0; i < count; i++) {
            _mint(to, _nextId++);
        }
    }
}

/// @title MockWETH - Testnet WETH (deposit/withdraw ETH)
contract MockWETH is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function deposit() external payable {
        _mint(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        _burn(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "ETH_TRANSFER_FAILED");
    }

    receive() external payable {
        _mint(msg.sender, msg.value);
    }
}
