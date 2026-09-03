// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IYieldAdapter} from "./IYieldAdapter.sol";

/// @title ERC4626YieldAdapter
/// @notice Holds pool principal in one standard ERC-4626 vault and keeps
///         generated yield separately measurable and harvestable.
/// @dev The controller is the production PrizeEngine. No per-user plaintext
///      allocation is maintained by this adapter.
contract ERC4626YieldAdapter is IYieldAdapter {
    using SafeERC20 for IERC20;

    IERC20 private immutable _asset;
    IERC4626 private immutable _yieldVault;
    address private immutable _admin;
    address private _controller;
    uint256 private _principalDeployed;

    error InvalidAsset();
    error InvalidYieldVault();
    error AssetMismatch();
    error UnauthorizedAdmin();
    error ControllerAlreadySet();
    error UnauthorizedController();
    error InsufficientPrincipal();
    error InsufficientManagedAssets();
    error InvalidReceiver();

    constructor(IERC20 asset_, IERC4626 yieldVault_) {
        if (address(asset_) == address(0)) revert InvalidAsset();
        if (address(yieldVault_) == address(0)) revert InvalidYieldVault();
        if (yieldVault_.asset() != address(asset_)) revert AssetMismatch();
        _asset = asset_;
        _yieldVault = yieldVault_;
        _admin = msg.sender;
    }

    modifier onlyController() {
        if (msg.sender != _controller) revert UnauthorizedController();
        _;
    }

    function setController(address controller_) external {
        if (msg.sender != _admin) revert UnauthorizedAdmin();
        if (controller_ == address(0)) revert UnauthorizedController();
        if (_controller != address(0)) revert ControllerAlreadySet();
        _controller = controller_;
    }

    function asset() external view returns (address) {
        return address(_asset);
    }

    function yieldVault() external view returns (address) {
        return address(_yieldVault);
    }

    function controller() external view returns (address) {
        return _controller;
    }

    function principalDeployed() external view returns (uint256) {
        return _principalDeployed;
    }

    function managedAssets() public view returns (uint256) {
        return _yieldVault.convertToAssets(_yieldVault.balanceOf(address(this)));
    }

    function generatedYield() public view returns (uint256) {
        uint256 assets = managedAssets();
        return assets > _principalDeployed ? assets - _principalDeployed : 0;
    }

    function deployPrincipal(uint256 assets) external onlyController returns (uint256 shares) {
        _asset.forceApprove(address(_yieldVault), assets);
        shares = _yieldVault.deposit(assets, address(this));
        _principalDeployed += assets;
    }

    function withdrawPrincipal(uint256 assets, address receiver)
        external
        onlyController
        returns (uint256 shares)
    {
        if (receiver == address(0)) revert InvalidReceiver();
        if (assets > _principalDeployed) revert InsufficientPrincipal();
        if (assets > managedAssets()) revert InsufficientManagedAssets();
        shares = _yieldVault.withdraw(assets, receiver, address(this));
        _principalDeployed -= assets;
    }

    function harvestYield(address receiver) external onlyController returns (uint256 assets) {
        if (receiver == address(0)) revert InvalidReceiver();
        assets = generatedYield();
        if (assets == 0) return 0;
        _yieldVault.withdraw(assets, receiver, address(this));
    }
}
