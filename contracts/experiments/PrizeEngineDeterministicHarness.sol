// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint64} from "@fhevm/solidity/lib/FHE.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {PrizeEngine} from "../PrizeEngine.sol";
import {VeilPool} from "../VeilPool.sol";

/// @title Test-only PrizeEngine retry harness
/// @notice Never deploy this contract. It replaces FHE randomness with fixed
///         encrypted values so the retry branch can be tested deterministically.
contract PrizeEngineDeterministicHarness is PrizeEngine {
    bool public forceReject;

    constructor(VeilPool vault_, IERC7984 confidentialToken_, address operator_)
        PrizeEngine(vault_, confidentialToken_, operator_)
    {}

    function setForceReject(bool forceReject_) external {
        forceReject = forceReject_;
    }

    function _randomCandidate(uint64 domain) internal override returns (euint64) {
        return FHE.asEuint64(forceReject ? domain - 1 : 0);
    }
}
