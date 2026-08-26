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

/// @dev A vault whose `repay` applies less than its `quoteRepay` implied — the
///      drift `NftfiBnpl.payInstalment`'s one-comparison check exists to refuse.
///      The real vault's quote and clamp agree today only because two contracts'
///      arithmetic coincides, so the break can only be staged here: `quoteRepay`
///      reports `quotedDue` while `repay` clamps against a smaller `actualDue`,
///      which is what any future divergence would look like from the desk's
///      side of the call.
contract ShortApplyVault {
    address public immutable collection;
    address private immutable _weth;

    uint256 public originationFeeBps;
    uint256 public aprBps;
    uint256 public loanDuration = 120 days;

    uint256 public quotedDue;
    uint256 public actualDue;

    constructor(address weth_, address collection_) {
        _weth = weth_;
        collection = collection_;
    }

    function asset() external view returns (address) {
        return _weth;
    }

    function borrow(uint256 tokenId, uint256 requestedWei, address) external returns (uint256) {
        ERC721(collection).transferFrom(msg.sender, address(this), tokenId);
        quotedDue = requestedWei;
        actualDue = requestedWei;
        ERC20(_weth).transfer(msg.sender, requestedWei);
        return 0;
    }

    function quoteRepay(uint256) external view returns (uint256 principal, uint256 interest) {
        return (quotedDue, 0);
    }

    function repay(uint256, uint256 amount) external returns (uint256 paid) {
        paid = amount > actualDue ? actualDue : amount;
        ERC20(_weth).transferFrom(msg.sender, address(this), paid);
        actualDue -= paid;
        // Keep the quote from reaching zero on an under-application so the
        // desk's settle branch stays out of the picture: the test is about the
        // stranded difference, not about a spurious release.
        quotedDue -= paid;
    }

    function setActualDue(uint256 d) external {
        actualDue = d;
    }
}
