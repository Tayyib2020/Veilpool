// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, ebool, euint64, externalEuint64} from "@fhevm/solidity/lib/FHE.sol";
import {ZamaEthereumConfig} from "@fhevm/solidity/config/ZamaConfig.sol";
import {IERC7984} from "@openzeppelin/confidential-contracts/interfaces/IERC7984.sol";
import {IERC7984ERC20Wrapper} from "@openzeppelin/confidential-contracts/interfaces/IERC7984ERC20Wrapper.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IERC7984WrapperEncryptedUnwrap {
    function unwrap(address from, address to, euint64 amount) external returns (bytes32);
}

/// @title VeilPool confidential vault
/// @notice Phase 2 MVP vault for confidential principal and eligibility accounting.
/// @dev Eligibility equals balance in this phase. The separate field preserves the
///      public deposit/withdraw interface for a future time-weighted implementation.
contract VeilPool is ZamaEthereumConfig {
    using SafeERC20 for IERC20;
    struct Position {
        euint64 balance;
        euint64 eligibility;
        euint64 winnings;
        uint256 joinedRound;
    }

    IERC7984 private immutable _confidentialToken;
    uint256 public constant PRODUCTION_MAX_PARTICIPANTS = 10;

    /// @dev Bounded by the Phase 3/3.5 local FHE depth benchmark.
    uint256 public immutable maxParticipants;
    address private immutable _admin;
    address private _prizeEngine;

    mapping(address participant => Position position) private _positions;
    mapping(address participant => bool registered) private _registered;
    address[] private _participants;
    euint64 private _principalLiability;

    error InvalidToken();
    error InvalidMaxParticipants();
    error MaxParticipantsReached();
    error NotParticipant();
    error UnauthorizedAdmin();
    error InvalidPrizeEngine();
    error PrizeEngineAlreadySet();
    error UnauthorizedPrizeEngine();

    event ParticipantRegistered(address indexed participant);
    event DepositRecorded(address indexed participant);
    event WithdrawalRecorded(address indexed participant);

    constructor(IERC7984 confidentialToken_, uint256 maxParticipants_)
        ZamaEthereumConfig()
    {
        if (address(confidentialToken_) == address(0)) revert InvalidToken();
        if (maxParticipants_ == 0 || maxParticipants_ > PRODUCTION_MAX_PARTICIPANTS) {
            revert InvalidMaxParticipants();
        }

        _confidentialToken = confidentialToken_;
        maxParticipants = maxParticipants_;
        _admin = msg.sender;
    }

    /// @notice Deposits an encrypted amount after this vault is made an ERC-7984 operator.
    /// @dev The token's returned encrypted amount is the source of truth for accounting.
    function deposit(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        _register(msg.sender);

        euint64 transferred = _confidentialToken.confidentialTransferFrom(
            msg.sender,
            address(this),
            encryptedAmount,
            inputProof
        );
        _recordDeposit(msg.sender, transferred);

        emit DepositRecorded(msg.sender);
    }

    /// @notice Withdraws up to the caller's encrypted internal balance.
    /// @dev The requested amount is clamped homomorphically and accounting uses the
    ///      confidential token's actual returned transfer amount.
    function withdraw(externalEuint64 encryptedAmount, bytes calldata inputProof) external {
        if (!_registered[msg.sender]) revert NotParticipant();

        Position storage position = _positions[msg.sender];
        euint64 requested = FHE.fromExternal(encryptedAmount, inputProof);
        ebool withinBalance = FHE.le(requested, position.balance);
        euint64 permitted = FHE.select(withinBalance, requested, position.balance);
        FHE.allowThis(permitted);
        FHE.allowTransient(permitted, address(_confidentialToken));

        euint64 transferred = _confidentialToken.confidentialTransfer(msg.sender, permitted);
        FHE.allowThis(transferred);
        _recordWithdrawal(msg.sender, transferred);

        emit WithdrawalRecorded(msg.sender);
    }

    function confidentialToken() external view returns (address) {
        return address(_confidentialToken);
    }

    /// @notice Authorizes the production PrizeEngine integration once.
    /// @dev This is configuration, not a decryption or winner-selection role.
    function setPrizeEngine(address prizeEngine_) external {
        if (msg.sender != _admin) revert UnauthorizedAdmin();
        if (prizeEngine_ == address(0)) revert InvalidPrizeEngine();
        if (_prizeEngine != address(0)) revert PrizeEngineAlreadySet();
        _prizeEngine = prizeEngine_;
    }

    function prizeEngine() external view returns (address) {
        return _prizeEngine;
    }

    /// @notice Returns the current participant and eligibility handles to the
    ///         authorized PrizeEngine for one atomic round snapshot.
    /// @dev The transient allowance expires at the end of this transaction;
    ///      PrizeEngine persists only the snapshot handles it receives.
    function snapshotEligibility()
        external
        returns (address[] memory participants, euint64[] memory eligibilities)
    {
        if (msg.sender != _prizeEngine) revert UnauthorizedPrizeEngine();

        participants = _participants;
        eligibilities = new euint64[](_participants.length);
        for (uint256 i = 0; i < _participants.length; ++i) {
            euint64 eligibility = _positions[_participants[i]].eligibility;
            // Derive a fresh snapshot handle so the participant ACL on the
            // live eligibility handle is not inherited by the PrizeEngine.
            euint64 snapshot = FHE.add(eligibility, FHE.asEuint64(0));
            FHE.allowThis(snapshot);
            FHE.allowTransient(snapshot, msg.sender);
            eligibilities[i] = snapshot;
        }
    }

    /// @notice Returns the encrypted aggregate of all live principal balances.
    /// @dev This is a pool-level synchronization value, not a user balance.
    function confidentialPrincipalLiability() external view returns (euint64) {
        return _principalLiability;
    }

    /// @notice Creates the authorized public-decryption request used to
    ///         synchronize principal with the plaintext ERC-4626 adapter.
    function preparePrincipalLiabilityReveal() external returns (euint64 snapshot) {
        if (msg.sender != _prizeEngine) revert UnauthorizedPrizeEngine();
        snapshot = FHE.add(_principalLiability, FHE.asEuint64(0));
        FHE.allowThis(snapshot);
        FHE.allowTransient(snapshot, msg.sender);
        FHE.makePubliclyDecryptable(snapshot);
    }

    /// @notice Starts an asynchronous pool-level principal unwrap.
    /// @dev Only the aggregate amount is sent through this boundary. The
    ///      wrapper clamps the burn to the vault's current confidential balance.
    function unwrapPrincipalTo(address recipient, uint64 amount) external returns (bytes32 requestId) {
        if (msg.sender != _prizeEngine) revert UnauthorizedPrizeEngine();
        if (recipient == address(0)) revert InvalidPrizeEngine();

        euint64 encryptedAmount = FHE.asEuint64(amount);
        FHE.allowThis(encryptedAmount);
        FHE.allowTransient(encryptedAmount, address(_confidentialToken));
        requestId = IERC7984WrapperEncryptedUnwrap(address(_confidentialToken)).unwrap(
            address(this),
            recipient,
            encryptedAmount
        );
    }

    /// @notice Wraps plaintext principal returned by the adapter into liquid
    ///         confidential vPOOL owned by this vault.
    function wrapUnderlyingToLiquid(uint256 amount) external returns (euint64 wrapped) {
        if (msg.sender != _prizeEngine) revert UnauthorizedPrizeEngine();
        IERC20 underlying = IERC20(IERC7984ERC20Wrapper(address(_confidentialToken)).underlying());
        underlying.forceApprove(address(_confidentialToken), amount);
        wrapped = IERC7984ERC20Wrapper(address(_confidentialToken)).wrap(address(this), amount);
        FHE.allowThis(wrapped);
    }

    /// @notice Credits a confidential prize to an existing participant.
    /// @dev PrizeEngine transfers the separately funded prize tokens to this
    ///      vault before calling this hook. Principal balances are untouched.
    function creditWinnings(address participant, euint64 amount) external {
        if (msg.sender != _prizeEngine) revert UnauthorizedPrizeEngine();
        if (!_registered[participant]) revert NotParticipant();

        Position storage position = _positions[participant];
        FHE.allowThis(amount);
        euint64 updatedWinnings = FHE.add(position.winnings, amount);
        FHE.allowThis(updatedWinnings);
        FHE.allow(updatedWinnings, participant);
        position.winnings = updatedWinnings;
    }

    function participantCount() public view returns (uint256) {
        return _participants.length;
    }

    function participantAt(uint256 index) external view returns (address) {
        return _participants[index];
    }

    function isParticipant(address participant) external view returns (bool) {
        return _registered[participant];
    }

    function confidentialBalanceOf(address participant) external view returns (euint64) {
        return _positions[participant].balance;
    }

    function confidentialEligibilityOf(address participant) external view returns (euint64) {
        return _positions[participant].eligibility;
    }

    function confidentialWinningsOf(address participant) external view returns (euint64) {
        return _positions[participant].winnings;
    }

    function joinedRoundOf(address participant) external view returns (uint256) {
        return _positions[participant].joinedRound;
    }

    function _register(address participant) internal {
        if (_registered[participant]) return;
        if (_participants.length >= maxParticipants) revert MaxParticipantsReached();

        _registered[participant] = true;
        _participants.push(participant);

        euint64 zeroWinnings = FHE.asEuint64(0);
        FHE.allowThis(zeroWinnings);
        FHE.allow(zeroWinnings, participant);
        _positions[participant].winnings = zeroWinnings;

        emit ParticipantRegistered(participant);
    }

    function _recordDeposit(address participant, euint64 transferred) internal {
        Position storage position = _positions[participant];
        FHE.allowThis(transferred);

        euint64 updatedBalance = FHE.add(position.balance, transferred);
        FHE.allowThis(updatedBalance);
        FHE.allow(updatedBalance, participant);

        position.balance = updatedBalance;
        position.eligibility = updatedBalance;

        _principalLiability = FHE.add(_principalLiability, transferred);
        FHE.allowThis(_principalLiability);
    }

    function _recordWithdrawal(address participant, euint64 transferred) internal {
        Position storage position = _positions[participant];
        euint64 updatedBalance = FHE.sub(position.balance, transferred);
        FHE.allowThis(updatedBalance);
        FHE.allow(updatedBalance, participant);

        position.balance = updatedBalance;
        position.eligibility = updatedBalance;

        _principalLiability = FHE.sub(_principalLiability, transferred);
        FHE.allowThis(_principalLiability);
    }
}
