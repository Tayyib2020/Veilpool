# Confidential winnings withdrawal

`VeilPool.withdrawWinnings(bytes32,bytes)` accepts an encrypted uint64 input bound
to the VeilPool address and the calling participant. It homomorphically clamps
the request to that participant's winnings, transfers confidential ERC-7984 tokens
to the caller, and deducts only the actual returned transfer amount from winnings.
Savings, eligibility, and aggregate principal liability are untouched.

The updated winnings handle permits the vault and participant to use it. No
public decryption is requested. The existing address-only `WithdrawalRecorded`
event is emitted even for a zero claim. Transaction sender, method, and ERC-7984
transfer endpoints remain public metadata; the action does not publicly prove
that the sender won because zero-winnings participants can also call it. A user
who later unwraps explicitly crosses the existing public-asset privacy boundary.

The frontend enables the action only after the contract's read-only
`supportsWinningsWithdrawal()` returns true and the participant reveals positive
winnings. Unsupported contracts or failed capability reads leave it unavailable.
Confirmation clears the transient revealed winnings so the user can authorize a
fresh reveal. No optimistic plaintext balance subtraction is performed.

## Deployment implications

The canonical isolated deployment now supports this API and completed live
winnings withdrawal and optional public unwrap. See
[canonical evidence](canonical-sepolia.md). The following explains why historical
V1 required replacement; it is not an instruction to redeploy again. The new
canonical stack uses a dedicated yield vault to isolate controlled donations.

The historical V1 Sepolia VeilPool is not upgradeable and cannot acquire this API.
A new VeilPool is required. PrizeEngine's vault reference is immutable, so it
also requires a new deployment. The yield adapter's controller is set once to
the engine, so a new adapter is required for that new engine. The underlying
token, confidential wrapper and ERC-4626 yield vault can technically be reused
after reviewing liquidity and accounting; their redeployment is not required by
this API. No production addresses have been changed here.

Existing private positions and winnings remain on the old vault. This feature
does not migrate them or unlock historical winnings there. No existing state
import/upgrade mechanism is introduced. Any migration requires a separately
reviewed plan; do not imply that pointing the UI at new contracts moves balances.

No draw, randomness, settlement, principal withdrawal, or yield code is changed.
