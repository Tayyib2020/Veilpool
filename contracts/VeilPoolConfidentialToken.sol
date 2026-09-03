// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {ERC7984} from "@openzeppelin/confidential-contracts/token/ERC7984/ERC7984.sol";
import {ERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/token/ERC7984/extensions/ERC7984ERC20Wrapper.sol";

/// @dev Phase 1 only: OpenZeppelin ERC-7984 wrapper around the underlying ERC-20.
contract VeilPoolConfidentialToken is ERC7984ERC20Wrapper, ZamaEthereumConfig {
    constructor(IERC20 underlying_)
        ERC7984("VeilPool Confidential Token", "vPOOL", "")
        ERC7984ERC20Wrapper(underlying_)
        ZamaEthereumConfig()
    {}
}
