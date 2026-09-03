// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Controlled Sepolia ERC-4626 yield simulation
/// @notice A testnet-only ERC-4626 vault for the VeilPool demonstration.
/// @dev This is not an external DeFi integration or a source of real yield.
///      The owner may inject actual underlying test assets without receiving
///      shares, increasing the standard ERC-4626 share value.
contract SepoliaYieldVault is ERC4626, Ownable {
    using SafeERC20 for IERC20;

    error InvalidAsset();
    error InvalidYieldAmount();

    constructor(IERC20 asset_, address yieldController_)
        ERC20("Controlled Sepolia Yield Simulation Share", "csYS"
        )
        ERC4626(asset_)
        Ownable(yieldController_)
    {
        if (address(asset_) == address(0)) revert InvalidAsset();
    }

    /// @notice Injects real mUNDER test assets without minting shares.
    /// @dev The resulting increase in totalAssets raises the value of shares
    ///      under OpenZeppelin's standard ERC-4626 conversion mechanics.
    function addTestYield(uint256 amount) external onlyOwner {
        if (amount == 0) revert InvalidYieldAmount();
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
    }
}
