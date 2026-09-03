// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @title VeilPool yield adapter interface
/// @notice Pool-controlled boundary between confidential principal and a
///         standard plaintext ERC-4626 vault.
interface IYieldAdapter {
    function asset() external view returns (address);
    function yieldVault() external view returns (address);
    function controller() external view returns (address);
    function principalDeployed() external view returns (uint256);
    function managedAssets() external view returns (uint256);
    function generatedYield() external view returns (uint256);

    function deployPrincipal(uint256 assets) external returns (uint256 shares);
    function withdrawPrincipal(uint256 assets, address receiver) external returns (uint256 shares);
    function harvestYield(address receiver) external returns (uint256 assets);
}
