// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, ebool, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";

/// @title Experimental confidential rejection-sampling harness
/// @notice Phase 3.5 design spike only; this is not production PrizeEngine code.
/// @dev The aggregate total is the only value made publicly decryptable before
///      the draw. A fixed number of encrypted candidates are generated and the
///      first candidate below the public total is selected homomorphically.
contract RejectionSamplingHarness is ZamaEthereumConfig {
    enum Phase {
        Open,
        AggregateRevealPending,
        AggregateRevealed,
        Drawing,
        Settled
    }

    uint64 private constant MAX_RANDOM_DOMAIN = uint64(1) << 63;

    address[] private _participants;
    euint64[] private _eligibility;

    uint8 public immutable retryCap;
    uint64 public publicTotalWeight;
    uint64 public randomDomain;
    Phase public phase;

    euint64 private _totalWeight;
    euint64 private _acceptedTarget;
    euint64 private _selectedIndex;
    ebool private _hasAccepted;
    ebool private _hasWinner;

    event AggregateTotalRevealed(uint64 totalWeight);

    error InvalidRetryCap();
    error InvalidParticipantSet();
    error InvalidEligibilityLength();
    error InvalidPhase(Phase expected, Phase actual);
    error NoEligibleWeight();
    error RandomDomainOverflow(uint64 totalWeight);

    constructor(address[] memory participants_, uint8 retryCap_)
        ZamaEthereumConfig()
    {
        if (retryCap_ == 0) revert InvalidRetryCap();
        if (participants_.length == 0) revert InvalidParticipantSet();

        for (uint256 i = 0; i < participants_.length; ++i) {
            if (participants_[i] == address(0)) revert InvalidParticipantSet();
            for (uint256 j = 0; j < i; ++j) {
                if (participants_[i] == participants_[j]) revert InvalidParticipantSet();
            }
            _participants.push(participants_[i]);
        }

        retryCap = retryCap_;
        phase = Phase.Open;
    }

    /// @notice Freezes encrypted eligibility and requests public decryption of
    ///         the aggregate only.
    /// @dev Individual eligibility handles remain contract-authorized only.
    function lock(externalEuint64[] calldata encryptedEligibility, bytes calldata inputProof) external {
        _requirePhase(Phase.Open);
        if (encryptedEligibility.length != _participants.length) revert InvalidEligibilityLength();

        euint64 total = FHE.asEuint64(0);
        FHE.allowThis(total);
        for (uint256 i = 0; i < encryptedEligibility.length; ++i) {
            euint64 weight = FHE.fromExternal(encryptedEligibility[i], inputProof);
            FHE.allowThis(weight);
            _eligibility.push(weight);

            total = FHE.add(total, weight);
            FHE.allowThis(total);
        }

        _totalWeight = total;
        FHE.makePubliclyDecryptable(total);
        phase = Phase.AggregateRevealPending;
    }

    /// @notice Verifies the asynchronous public decryption result for the
    ///         aggregate total and advances the round to draw construction.
    /// @dev The caller supplies the KMS proof returned by the public-decrypt
    ///      service; no individual eligibility handle is included in the proof.
    function finalizeAggregateReveal(uint64 cleartextTotalWeight, bytes calldata decryptionProof) external {
        _requirePhase(Phase.AggregateRevealPending);

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = euint64.unwrap(_totalWeight);
        FHE.checkSignatures(handles, abi.encode(cleartextTotalWeight), decryptionProof);

        publicTotalWeight = cleartextTotalWeight;
        phase = Phase.AggregateRevealed;
        emit AggregateTotalRevealed(cleartextTotalWeight);
    }

    /// @notice Generates a fixed number of encrypted candidates and selects the
    ///         first candidate satisfying r < publicTotalWeight.
    /// @dev Rejected candidates are never stored, emitted, or made decryptable.
    ///      A fixed cap avoids an unbounded loop and does not expose a rejection
    ///      count. If every candidate is rejected, hasAccepted and hasWinner are
    ///      false after settlement.
    function draw() external {
        _requirePhase(Phase.AggregateRevealed);
        if (publicTotalWeight == 0) revert NoEligibleWeight();

        uint64 domain = nextPowerOfTwo(publicTotalWeight);
        randomDomain = domain;
        phase = Phase.Drawing;

        euint64 publicTotal = FHE.asEuint64(publicTotalWeight);
        FHE.allowThis(publicTotal);

        euint64 acceptedTargetValue = FHE.asEuint64(0);
        FHE.allowThis(acceptedTargetValue);
        ebool accepted = FHE.asEbool(false);
        FHE.allowThis(accepted);

        if (publicTotalWeight == 1) {
            // The only member of [0, 1) is zero. This branch also avoids a
            // zero-bit bounded-random edge case in the local mock executor.
            acceptedTargetValue = FHE.asEuint64(0);
            FHE.allowThis(acceptedTargetValue);
            accepted = FHE.asEbool(true);
            FHE.allowThis(accepted);
        } else {
            for (uint256 attempt = 0; attempt < retryCap; ++attempt) {
                euint64 candidate = FHE.randEuint64(domain);
                FHE.allowThis(candidate);

                ebool candidateInRange = FHE.lt(candidate, publicTotal);
                FHE.allowThis(candidateInRange);
                ebool chooseCandidate = FHE.and(candidateInRange, FHE.not(accepted));
                FHE.allowThis(chooseCandidate);

                acceptedTargetValue = FHE.select(chooseCandidate, candidate, acceptedTargetValue);
                FHE.allowThis(acceptedTargetValue);
                accepted = FHE.or(accepted, chooseCandidate);
                FHE.allowThis(accepted);
            }
        }

        euint64 cumulative = FHE.asEuint64(0);
        FHE.allowThis(cumulative);
        euint64 selected = FHE.asEuint64(0);
        FHE.allowThis(selected);
        ebool found = FHE.asEbool(false);
        FHE.allowThis(found);

        for (uint256 i = 0; i < _eligibility.length; ++i) {
            cumulative = FHE.add(cumulative, _eligibility[i]);
            FHE.allowThis(cumulative);

            ebool belowCumulative = FHE.lt(acceptedTargetValue, cumulative);
            ebool firstCandidate = FHE.and(belowCumulative, FHE.not(found));
            ebool firstMatch = FHE.and(accepted, firstCandidate);
            euint64 index = FHE.asEuint64(uint64(i));

            selected = FHE.select(firstMatch, index, selected);
            found = FHE.or(found, firstMatch);
            FHE.allowThis(selected);
            FHE.allowThis(found);
        }

        _acceptedTarget = acceptedTargetValue;
        _hasAccepted = accepted;
        _selectedIndex = selected;
        _hasWinner = found;
    }

    /// @notice Makes the accepted target and winner result public only after
    ///         the encrypted draw has completed.
    function settle() external {
        _requirePhase(Phase.Drawing);

        FHE.makePubliclyDecryptable(_acceptedTarget);
        FHE.makePubliclyDecryptable(_hasAccepted);
        FHE.makePubliclyDecryptable(_selectedIndex);
        FHE.makePubliclyDecryptable(_hasWinner);
        phase = Phase.Settled;
    }

    /// @notice Returns the smallest representable power of two >= value.
    /// @dev Values above 2^63 cannot be represented as an euint64 RNG bound:
    ///      their next power of two would be 2^64.
    function nextPowerOfTwo(uint64 value) public pure returns (uint64) {
        if (value == 0) return 0;

        uint64 power = 1;
        while (power < value) {
            if (power >= MAX_RANDOM_DOMAIN) revert RandomDomainOverflow(value);
            power <<= 1;
        }
        return power;
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

    function acceptedTarget() external view returns (euint64) {
        return _acceptedTarget;
    }

    function selectedIndex() external view returns (euint64) {
        return _selectedIndex;
    }

    function hasAccepted() external view returns (ebool) {
        return _hasAccepted;
    }

    function hasWinner() external view returns (ebool) {
        return _hasWinner;
    }

    function _requirePhase(Phase expected) internal view {
        if (phase != expected) revert InvalidPhase(expected, phase);
    }
}
