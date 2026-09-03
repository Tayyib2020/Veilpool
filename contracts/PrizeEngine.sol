// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, ebool, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {IERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/interfaces/IERC7984ERC20Wrapper.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {VeilPool} from "./VeilPool.sol";
import {IYieldAdapter} from "./IYieldAdapter.sol";

/// @title VeilPool production MVP prize engine
/// @notice One-pool, one-tier confidential weighted draw with a modular yield layer.
/// @dev Principal synchronization is pool-level and asynchronous because the
///      ERC-4626 boundary accepts plaintext ERC-20 assets.
contract PrizeEngine is ZamaEthereumConfig {
    using SafeERC20 for IERC20;
    enum RoundState {
        Open,
        Locked,
        AwaitingTotalDecryption,
        DrawReady,
        Drawing,
        RetryRequired,
        Settled,
        Cancelled
    }

    uint64 public constant MAX_RANDOM_DOMAIN = uint64(1) << 63;
    uint256 public constant MAX_PARTICIPANTS = 10;
    uint8 public constant RETRY_CAP = 5;

    VeilPool private immutable _vault;
    IERC7984 private immutable _confidentialToken;
    address public immutable operator;

    uint256 public roundId;
    RoundState public roundState;
    uint64 public publicTotalWeight;
    uint64 public randomDomain;

    mapping(uint256 round => address[]) private _roundParticipants;
    mapping(uint256 round => euint64[]) private _roundEligibility;

    euint64 private _prizeReserve;
    euint64 private _roundPrize;
    euint64 private _totalWeight;
    euint64 private _acceptedTarget;
    euint64 private _winnerIndex;
    ebool private _hasAccepted;

    bool public prizeCommitted;
    bool public acceptanceDecryptionRequested;

    IYieldAdapter private _yieldAdapter;
    euint64 private _pendingPrincipalLiability;
    bytes32 public pendingPrincipalUnwrapRequest;
    bool public principalLiabilityRevealRequested;
    bool public principalUnwrapPending;
    uint64 public publicPrincipalLiability;
    /// @notice Harvested yield available for a future round, in vPOOL units.
    uint256 public unallocatedHarvestedYield;
    /// @notice Current round's committed harvested yield, in vPOOL units.
    uint256 public roundPrizeAmount;

    error InvalidVault();
    error InvalidToken();
    error InvalidOperator();
    error InvalidParticipantCount();
    error UnauthorizedOperator();
    error InvalidRoundState(RoundState expected, RoundState actual);
    error NoEligibleWeight();
    error RandomDomainOverflow(uint64 totalWeight);
    error PrizeNotCommitted();
    error PrizeAlreadyCommitted();
    error YieldAdapterAlreadySet();
    error InvalidYieldAdapter();
    error YieldAdapterNotConfigured();
    error PrincipalSyncAlreadyPending();
    error PrincipalSyncNotPending();
    error PrizeAmountOverflow();
    error NoYieldAvailable();
    error InsufficientHarvestedYield();
    error NoPrizeToCancel();

    event AggregateTotalRevealed(uint256 indexed roundId, uint64 totalWeight);
    event DrawRetryRequired(uint256 indexed roundId);
    event RoundSettled(uint256 indexed roundId);
    event EmptyRoundClosed(uint256 indexed roundId);
    event RoundOpened(uint256 indexed roundId);
    event PrincipalSyncRequested(uint256 indexed roundId);
    event PrincipalSyncCompleted(uint256 indexed roundId);
    event YieldHarvested(uint256 indexed roundId);
    event NoYieldRoundCancelled(uint256 indexed roundId);

    constructor(VeilPool vault_, IERC7984 confidentialToken_, address operator_)
        ZamaEthereumConfig()
    {
        if (address(vault_) == address(0)) revert InvalidVault();
        if (address(confidentialToken_) == address(0)) revert InvalidToken();
        if (operator_ == address(0)) revert InvalidOperator();
        if (vault_.maxParticipants() > MAX_PARTICIPANTS) revert InvalidParticipantCount();

        _vault = vault_;
        _confidentialToken = confidentialToken_;
        operator = operator_;
        roundId = 1;
        roundState = RoundState.Open;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert UnauthorizedOperator();
        _;
    }

    /// @notice Funds the separate prize reserve with confidential vPOOL.
    /// @dev The caller must authorize this engine as an ERC-7984 operator first.
    function fundPrize(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        euint64 transferred = _confidentialToken.confidentialTransferFrom(
            msg.sender,
            address(this),
            encryptedAmount,
            inputProof
        );
        FHE.allowThis(transferred);

        _prizeReserve = FHE.add(_prizeReserve, transferred);
        FHE.allowThis(_prizeReserve);
    }

    /// @notice Configures the one pool-level yield adapter exactly once.
    /// @dev The adapter must already be controlled by this engine.
    function setYieldAdapter(IYieldAdapter yieldAdapter_) external onlyOperator {
        if (address(yieldAdapter_) == address(0)) revert InvalidYieldAdapter();
        if (address(_yieldAdapter) != address(0)) revert YieldAdapterAlreadySet();
        if (yieldAdapter_.asset() != IERC7984ERC20Wrapper(address(_confidentialToken)).underlying()) {
            revert InvalidYieldAdapter();
        }
        if (yieldAdapter_.controller() != address(this)) revert InvalidYieldAdapter();
        _yieldAdapter = yieldAdapter_;
    }

    /// @notice Returns the configured yield adapter, or zero before configuration.
    function yieldAdapter() external view returns (address) {
        return address(_yieldAdapter);
    }

    /// @notice Requests an authorized public reveal of aggregate principal only.
    function requestPrincipalDeployment() external onlyOperator {
        _requireYieldAdapter();
        _requireState(RoundState.Open);
        if (principalLiabilityRevealRequested || principalUnwrapPending) revert PrincipalSyncAlreadyPending();

        _pendingPrincipalLiability = _vault.preparePrincipalLiabilityReveal();
        FHE.allowThis(_pendingPrincipalLiability);
        principalLiabilityRevealRequested = true;
        emit PrincipalSyncRequested(roundId);
    }

    /// @notice Verifies aggregate principal and starts its asynchronous unwrap.
    function finalizePrincipalDeployment(uint64 cleartextPrincipal, bytes calldata decryptionProof) external {
        _requireYieldAdapter();
        if (!principalLiabilityRevealRequested) revert PrincipalSyncNotPending();

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = euint64.unwrap(_pendingPrincipalLiability);
        FHE.checkSignatures(handles, abi.encode(cleartextPrincipal), decryptionProof);
        if (cleartextPrincipal > type(uint64).max) revert PrizeAmountOverflow();

        publicPrincipalLiability = cleartextPrincipal;
        principalLiabilityRevealRequested = false;
        uint256 deployed = _yieldAdapter.principalDeployed();
        if (uint256(cleartextPrincipal) <= deployed) return;

        uint64 delta = cleartextPrincipal - uint64(deployed);
        pendingPrincipalUnwrapRequest = _vault.unwrapPrincipalTo(address(_yieldAdapter), delta);
        principalUnwrapPending = true;
    }

    /// @notice Finalizes the wrapper's encrypted principal unwrap and deposits
    ///         the plaintext asset into ERC-4626.
    function finalizePrincipalUnwrap(
        bytes32 unwrapRequestId,
        uint64 cleartextAmount,
        bytes calldata decryptionProof
    ) external {
        _requireYieldAdapter();
        if (!principalUnwrapPending || unwrapRequestId != pendingPrincipalUnwrapRequest) {
            revert PrincipalSyncNotPending();
        }

        IERC7984ERC20Wrapper(address(_confidentialToken)).finalizeUnwrap(
            unwrapRequestId,
            cleartextAmount,
            decryptionProof
        );
        _yieldAdapter.deployPrincipal(cleartextAmount);
        principalUnwrapPending = false;
        pendingPrincipalUnwrapRequest = bytes32(0);
        emit PrincipalSyncCompleted(roundId);
    }

    /// @notice Returns all currently deployed principal to the vault's liquid
    ///         confidential balance before user withdrawals are processed.
    function restorePrincipalLiquidity() external onlyOperator {
        _requireYieldAdapter();
        uint256 amount = _yieldAdapter.principalDeployed();
        if (amount == 0) return;
        _yieldAdapter.withdrawPrincipal(amount, address(_vault));
        _vault.wrapUnderlyingToLiquid(amount);
    }

    /// @notice Harvests adapter surplus into the confidential prize reserve.
    /// @dev Restricted to OPEN so yield after a round snapshot belongs to a
    ///      future round rather than changing an already frozen prize.
    function harvestYield() external onlyOperator {
        _requireYieldAdapter();
        _requireState(RoundState.Open);

        uint256 harvestedUnderlying = _yieldAdapter.harvestYield(address(this));
        uint256 rate = IERC7984ERC20Wrapper(address(_confidentialToken)).rate();
        uint256 harvested = harvestedUnderlying / rate;
        if (harvested == 0) return;

        IERC20 asset_ = IERC20(_yieldAdapter.asset());
        asset_.forceApprove(address(_confidentialToken), harvested * rate);
        euint64 wrapped = IERC7984ERC20Wrapper(address(_confidentialToken)).wrap(address(this), harvested * rate);
        FHE.allowThis(wrapped);
        _prizeReserve = FHE.add(_prizeReserve, wrapped);
        FHE.allowThis(_prizeReserve);
        unallocatedHarvestedYield += harvested;
        emit YieldHarvested(roundId);
    }

    /// @notice Freezes the current VeilPool participant and eligibility snapshot.
    /// @dev Later deposits and withdrawals may change live positions, but not
    ///      the historical handles stored for this round.
    function lockRound() external onlyOperator {
        _requireState(RoundState.Open);

        (address[] memory participants, euint64[] memory eligibilities) = _vault.snapshotEligibility();
        if (participants.length < 2 || participants.length > MAX_PARTICIPANTS) {
            revert InvalidParticipantCount();
        }

        euint64 total = FHE.asEuint64(0);
        FHE.allowThis(total);
        for (uint256 i = 0; i < participants.length; ++i) {
            _roundParticipants[roundId].push(participants[i]);

            euint64 eligibility = eligibilities[i];
            FHE.allowThis(eligibility);
            _roundEligibility[roundId].push(eligibility);

            total = FHE.add(total, eligibility);
            FHE.allowThis(total);
        }

        _totalWeight = total;
        roundState = RoundState.Locked;
    }

    /// @notice Requests public decryption of the frozen aggregate only.
    function requestAggregateDecryption() external onlyOperator {
        _requireState(RoundState.Locked);
        FHE.makePubliclyDecryptable(_totalWeight);
        roundState = RoundState.AwaitingTotalDecryption;
    }

    /// @notice Verifies the asynchronous Zama public-decryption result.
    /// @dev The proof binds the clear total to this round's encrypted total.
    function finalizeAggregateReveal(uint64 cleartextTotalWeight, bytes calldata decryptionProof) external {
        _requireState(RoundState.AwaitingTotalDecryption);

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = euint64.unwrap(_totalWeight);
        FHE.checkSignatures(handles, abi.encode(cleartextTotalWeight), decryptionProof);
        if (cleartextTotalWeight > MAX_RANDOM_DOMAIN) revert RandomDomainOverflow(cleartextTotalWeight);

        publicTotalWeight = cleartextTotalWeight;
        roundState = RoundState.DrawReady;
        emit AggregateTotalRevealed(roundId, cleartextTotalWeight);
    }

    /// @notice Allocates a confidential amount from the separate reserve to this round.
    /// @dev Excess requests clamp to the reserve; no plaintext amount is emitted.
    function commitRoundPrize(externalEuint64 encryptedAmount, bytes calldata inputProof) external onlyOperator {
        if (roundState != RoundState.DrawReady && roundState != RoundState.RetryRequired) {
            revert InvalidRoundState(RoundState.DrawReady, roundState);
        }
        if (prizeCommitted) revert PrizeAlreadyCommitted();

        euint64 requested = FHE.fromExternal(encryptedAmount, inputProof);
        ebool withinReserve = FHE.le(requested, _prizeReserve);
        euint64 permitted = FHE.select(withinReserve, requested, _prizeReserve);
        FHE.allowThis(permitted);

        _prizeReserve = FHE.sub(_prizeReserve, permitted);
        FHE.allowThis(_prizeReserve);
        _roundPrize = permitted;
        FHE.allowThis(_roundPrize);
        prizeCommitted = true;
    }

    /// @notice Commits an exact public accounting slice of harvested yield.
    /// @dev The amount is aggregate yield, not a user balance or deposit.
    function commitHarvestedYield(uint256 amount) external onlyOperator {
        if (roundState != RoundState.DrawReady && roundState != RoundState.RetryRequired) {
            revert InvalidRoundState(RoundState.DrawReady, roundState);
        }
        if (prizeCommitted) revert PrizeAlreadyCommitted();
        if (amount == 0) revert NoYieldAvailable();
        if (amount > unallocatedHarvestedYield) revert InsufficientHarvestedYield();
        if (amount > type(uint64).max) revert PrizeAmountOverflow();

        euint64 committed = FHE.asEuint64(uint64(amount));
        FHE.allowThis(committed);
        _prizeReserve = FHE.sub(_prizeReserve, committed);
        FHE.allowThis(_prizeReserve);
        _roundPrize = committed;
        FHE.allowThis(_roundPrize);
        unallocatedHarvestedYield -= amount;
        roundPrizeAmount = amount;
        prizeCommitted = true;
    }

    /// @notice Executes a fresh fixed-cap encrypted rejection-sampling batch.
    /// @dev RetryRequired rounds re-enter this function with fresh ciphertexts.
    ///      No caller input controls randomness or the selected participant.
    function executeDraw() external onlyOperator {
        if (roundState != RoundState.DrawReady && roundState != RoundState.RetryRequired) {
            revert InvalidRoundState(RoundState.DrawReady, roundState);
        }
        if (publicTotalWeight == 0) revert NoEligibleWeight();
        if (!prizeCommitted) revert PrizeNotCommitted();

        uint64 domain = nextPowerOfTwo(publicTotalWeight);
        randomDomain = domain;
        acceptanceDecryptionRequested = false;
        roundState = RoundState.Drawing;

        euint64 publicTotal = FHE.asEuint64(publicTotalWeight);
        FHE.allowThis(publicTotal);
        euint64 acceptedTarget = FHE.asEuint64(0);
        FHE.allowThis(acceptedTarget);
        ebool accepted = FHE.asEbool(false);
        FHE.allowThis(accepted);

        if (publicTotalWeight == 1) {
            // The local mock cannot sample a one-element zero-bit domain.
            acceptedTarget = FHE.asEuint64(0);
            FHE.allowThis(acceptedTarget);
            accepted = FHE.asEbool(true);
            FHE.allowThis(accepted);
        } else {
            for (uint256 attempt = 0; attempt < RETRY_CAP; ++attempt) {
                euint64 candidate = _randomCandidate(domain);
                FHE.allowThis(candidate);

                ebool candidateInRange = FHE.lt(candidate, publicTotal);
                FHE.allowThis(candidateInRange);
                ebool chooseCandidate = FHE.and(candidateInRange, FHE.not(accepted));
                FHE.allowThis(chooseCandidate);

                acceptedTarget = FHE.select(chooseCandidate, candidate, acceptedTarget);
                FHE.allowThis(acceptedTarget);
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

        euint64[] storage eligibilities = _roundEligibility[roundId];
        for (uint256 i = 0; i < eligibilities.length; ++i) {
            cumulative = FHE.add(cumulative, eligibilities[i]);
            FHE.allowThis(cumulative);

            ebool belowCumulative = FHE.lt(acceptedTarget, cumulative);
            ebool firstCandidate = FHE.and(belowCumulative, FHE.not(found));
            ebool firstMatch = FHE.and(accepted, firstCandidate);
            euint64 index = FHE.asEuint64(uint64(i));

            selected = FHE.select(firstMatch, index, selected);
            found = FHE.or(found, firstMatch);
            FHE.allowThis(selected);
            FHE.allowThis(found);
        }

        _acceptedTarget = acceptedTarget;
        _hasAccepted = accepted;
        _winnerIndex = selected;
        FHE.allowThis(_acceptedTarget);
        FHE.allowThis(_hasAccepted);
        FHE.allowThis(_winnerIndex);
    }

    /// @notice Makes only the encrypted acceptance bit publicly decryptable.
    /// @dev A false result is a public, retryable outcome; candidate values stay private.
    function requestDrawAcceptance() external onlyOperator {
        _requireState(RoundState.Drawing);
        FHE.makePubliclyDecryptable(_hasAccepted);
        acceptanceDecryptionRequested = true;
    }

    /// @notice Verifies acceptance and either credits the confidential prize or enables retry.
    function finalizeDrawAcceptance(bool cleartextAccepted, bytes calldata decryptionProof) external {
        _requireState(RoundState.Drawing);
        if (!acceptanceDecryptionRequested) revert InvalidRoundState(RoundState.Drawing, roundState);

        bytes32[] memory handles = new bytes32[](1);
        handles[0] = ebool.unwrap(_hasAccepted);
        FHE.checkSignatures(handles, abi.encode(cleartextAccepted), decryptionProof);

        acceptanceDecryptionRequested = false;
        if (!cleartextAccepted) {
            roundState = RoundState.RetryRequired;
            emit DrawRetryRequired(roundId);
            return;
        }

        _creditWinner();
        roundState = RoundState.Settled;
        emit RoundSettled(roundId);
    }

    /// @notice Closes a round whose verified aggregate total is zero without drawing.
    function closeEmptyRound() external onlyOperator {
        _requireState(RoundState.DrawReady);
        if (publicTotalWeight != 0) revert NoEligibleWeight();
        roundState = RoundState.Cancelled;
        emit EmptyRoundClosed(roundId);
    }

    /// @notice Safely cancels a round when no harvested yield is available.
    function cancelNoYieldRound() external onlyOperator {
        _requireState(RoundState.DrawReady);
        if (prizeCommitted || unallocatedHarvestedYield != 0) revert NoPrizeToCancel();
        roundState = RoundState.Cancelled;
        emit NoYieldRoundCancelled(roundId);
    }

    /// @notice Opens a fresh round after successful confidential prize crediting.
    function startNextRound() external onlyOperator {
        if (roundState != RoundState.Settled && roundState != RoundState.Cancelled) {
            revert InvalidRoundState(RoundState.Settled, roundState);
        }
        ++roundId;
        prizeCommitted = false;
        roundPrizeAmount = 0;
        roundState = RoundState.Open;
        emit RoundOpened(roundId);
    }

    function nextPowerOfTwo(uint64 value) public pure returns (uint64) {
        if (value == 0) return 0;

        uint64 power = 1;
        while (power < value) {
            if (power >= MAX_RANDOM_DOMAIN) revert RandomDomainOverflow(value);
            power <<= 1;
        }
        return power;
    }

    function vault() external view returns (address) {
        return address(_vault);
    }

    function confidentialToken() external view returns (address) {
        return address(_confidentialToken);
    }

    function confidentialPrizeReserve() external view returns (euint64) {
        return _prizeReserve;
    }

    function confidentialRoundPrize() external view returns (euint64) {
        return _roundPrize;
    }

    function confidentialTotalWeight() external view returns (euint64) {
        return _totalWeight;
    }

    function confidentialAcceptedTarget() external view returns (euint64) {
        return _acceptedTarget;
    }

    function confidentialWinnerIndex() external view returns (euint64) {
        return _winnerIndex;
    }

    function confidentialHasAccepted() external view returns (ebool) {
        return _hasAccepted;
    }

    function confidentialPendingPrincipalLiability() external view returns (euint64) {
        return _pendingPrincipalLiability;
    }

    function roundParticipantCount(uint256 historicalRoundId) external view returns (uint256) {
        return _roundParticipants[historicalRoundId].length;
    }

    function roundParticipantAt(uint256 historicalRoundId, uint256 index) external view returns (address) {
        return _roundParticipants[historicalRoundId][index];
    }

    function confidentialFrozenEligibilityAt(uint256 historicalRoundId, uint256 index)
        external
        view
        returns (euint64)
    {
        return _roundEligibility[historicalRoundId][index];
    }

    function _creditWinner() internal {
        FHE.allowTransient(_roundPrize, address(_confidentialToken));
        euint64 transferredPrize = _confidentialToken.confidentialTransfer(address(_vault), _roundPrize);
        FHE.allowThis(transferredPrize);
        euint64 zero = FHE.asEuint64(0);
        FHE.allowThis(zero);

        address[] storage participants = _roundParticipants[roundId];
        for (uint256 i = 0; i < participants.length; ++i) {
            euint64 index = FHE.asEuint64(uint64(i));
            ebool indexMatch = FHE.eq(_winnerIndex, index);
            FHE.allowThis(indexMatch);
            ebool winner = FHE.and(_hasAccepted, indexMatch);
            FHE.allowThis(winner);

            euint64 prizeForParticipant = FHE.select(winner, transferredPrize, zero);
            FHE.allowThis(prizeForParticipant);
            FHE.allowTransient(prizeForParticipant, address(_vault));
            _vault.creditWinnings(participants[i], prizeForParticipant);
        }
    }

    function _randomCandidate(uint64 domain) internal virtual returns (euint64) {
        return FHE.randEuint64(domain);
    }

    function _requireYieldAdapter() internal view {
        if (address(_yieldAdapter) == address(0)) revert YieldAdapterNotConfigured();
    }

    function _requireState(RoundState expected) internal view {
        if (roundState != expected) revert InvalidRoundState(expected, roundState);
    }
}
