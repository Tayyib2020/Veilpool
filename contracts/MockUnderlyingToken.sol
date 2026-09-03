// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Minimal test-only underlying asset. Six decimals keep wrapper rate() at 1.
contract MockUnderlyingToken is ERC20 {
    constructor() ERC20("Mock Underlying Token", "mUNDER") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
