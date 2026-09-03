// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, ebool, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title Experimental encrypted weighted-draw harness
/// @notice Phase 3 feasibility spike only; not production PrizeEngine code.
/// @dev The installed FHE API supports a plaintext power-of-two random bound,
///      so this harness measures a fixed-domain target and encrypted range check.
contract WeightedDrawHarness is ZamaEthereumConfig {
    enum Phase {
        Open,
        Locked,
        Drawing,
        Settled
    }

    address[] private _participants;
    euint64[] private _eligibility;

    uint64 public immutable randomUpperBound;
    Phase public phase;

    euint64 private _totalWeight;
    euint64 private _randomTarget;
    euint64 private _selectedIndex;
    ebool private _hasWinner;
    ebool private _targetInRange;

    error InvalidRandomUpperBound();
    error InvalidParticipantSet();
    error InvalidEligibilityLength();
    error InvalidPhase(Phase expected, Phase actual);

    constructor(address[] memory participants_, uint64 randomUpperBound_)
        ZamaEthereumConfig()
    {
        if (randomUpperBound_ == 0 || (randomUpperBound_ & (randomUpperBound_ - 1)) != 0) {
            revert InvalidRandomUpperBound();
        }
        if (participants_.length == 0) revert InvalidParticipantSet();

        for (uint256 i = 0; i < participants_.length; ++i) {
            if (participants_[i] == address(0)) revert InvalidParticipantSet();
            for (uint256 j = 0; j < i; ++j) {
                if (participants_[i] == participants_[j]) revert InvalidParticipantSet();
            }
            _participants.push(participants_[i]);
        }

        randomUpperBound = randomUpperBound_;
        phase = Phase.Open;
    }

    /// @notice Freezes encrypted eligibility inputs before randomness is generated.
    /// @dev All handles in inputProof are verified against this harness and caller.
    function lock(externalEuint64[] calldata encryptedEligibility, bytes calldata inputProof) external {
        _requirePhase(Phase.Open);
        if (encryptedEligibility.length != _participants.length) revert InvalidEligibilityLength();

        for (uint256 i = 0; i < encryptedEligibility.length; ++i) {
            euint64 weight = FHE.fromExternal(encryptedEligibility[i], inputProof);
            FHE.allowThis(weight);
            _eligibility.push(weight);
        }

        phase = Phase.Locked;
    }

    /// @notice Computes one encrypted weighted selection over the frozen snapshot.
    /// @dev The target is sampled from [0, randomUpperBound). If it is outside the
    ///      encrypted total, hasWinner is false rather than silently selecting anyone.
    function draw() external {
        _requirePhase(Phase.Locked);
        phase = Phase.Drawing;

        euint64 total = FHE.asEuint64(0);
        FHE.allowThis(total);
        for (uint256 i = 0; i < _eligibility.length; ++i) {
            total = FHE.add(total, _eligibility[i]);
            FHE.allowThis(total);
        }

        euint64 target = FHE.randEuint64(randomUpperBound);
        FHE.allowThis(target);
        ebool inRange = FHE.lt(target, total);
        FHE.allowThis(inRange);

        euint64 cumulative = FHE.asEuint64(0);
        FHE.allowThis(cumulative);
        euint64 selected = FHE.asEuint64(0);
        FHE.allowThis(selected);
        ebool found = FHE.asEbool(false);
        FHE.allowThis(found);

        for (uint256 i = 0; i < _eligibility.length; ++i) {
            cumulative = FHE.add(cumulative, _eligibility[i]);
            FHE.allowThis(cumulative);

            ebool belowCumulative = FHE.lt(target, cumulative);
            ebool firstMatch = FHE.and(belowCumulative, FHE.not(found));
            euint64 index = FHE.asEuint64(uint64(i));
            selected = FHE.select(firstMatch, index, selected);
            found = FHE.or(found, firstMatch);

            FHE.allowThis(selected);
            FHE.allowThis(found);
        }

        _totalWeight = total;
        _randomTarget = target;
        _selectedIndex = selected;
        _hasWinner = found;
        _targetInRange = inRange;
    }

    /// @notice Begins the intended public-reveal stage after encrypted computation.
    /// @dev No reveal permission is granted before this explicit settlement step.
    function settle() external {
        _requirePhase(Phase.Drawing);

        FHE.makePubliclyDecryptable(_totalWeight);
        FHE.makePubliclyDecryptable(_randomTarget);
        FHE.makePubliclyDecryptable(_selectedIndex);
        FHE.makePubliclyDecryptable(_hasWinner);
        FHE.makePubliclyDecryptable(_targetInRange);
        phase = Phase.Settled;
    }

    function participantCount() external view returns (uint256) {
        return _participants.length;
    }

    function participantAt(uint256 index) external view returns (address) {
        return _participants[index];
    }

    function eligibilityAt(uint256 index) external view returns (euint64) {
        return _eligibility[index];
    }

    function totalWeight() external view returns (euint64) {
        return _totalWeight;
    }

    function randomTarget() external view returns (euint64) {
        return _randomTarget;
    }

    function selectedIndex() external view returns (euint64) {
        return _selectedIndex;
    }

    function hasWinner() external view returns (ebool) {
        return _hasWinner;
    }

    function targetInRange() external view returns (ebool) {
        return _targetInRange;
    }

    function _requirePhase(Phase expected) internal view {
        if (phase != expected) revert InvalidPhase(expected, phase);
    }
}
