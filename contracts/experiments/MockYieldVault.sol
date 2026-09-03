// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {MockUnderlyingToken} from "../MockUnderlyingToken.sol";

/// @title MockYieldVault
/// @notice Test-only ERC-4626 vault whose share price rises when test yield is accrued.
contract MockYieldVault is ERC4626 {
    constructor(IERC20 asset_)
        ERC20("Mock Yield Vault Share", "myvSHARE")
        ERC4626(asset_)
    {}

    function accrueYield(uint256 assets) external {
        MockUnderlyingToken(asset()).mint(address(this), assets);
    }
}
