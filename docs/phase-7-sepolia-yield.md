# Phase 7 Sepolia yield source

VeilPool’s Sepolia demonstration uses a **controlled Sepolia ERC-4626 yield
simulation using test assets**. The source is `SepoliaYieldVault`, which is
constructed with the deployed `MockUnderlyingToken` (`mUNDER`) address and an
explicit yield-controller owner.

`mUNDER` has no monetary value. It is a six-decimal test token with a test mint
function and must not be presented as USDT, real money, or a live DeFi asset.
`SepoliaYieldVault` is not an external lending protocol and does not claim
real protocol yield. The authorized controller must approve actual mUNDER and
call `addTestYield(amount)`. The vault transfers those assets in, mints no
shares, and relies on OpenZeppelin ERC-4626 conversion mechanics for the share
value to appreciate.

The downstream architecture is unchanged: `ERC4626YieldAdapter` tracks
principal separately from managed assets, recognizes only excess assets as
generated yield, and passes harvested yield into the separate confidential
PrizeEngine reserve. The FHE draw and settlement remain onchain. Injecting
test assets does not alter individual encrypted balances or eligibility.

The local `MockYieldVault` remains test-only and must not be deployed. Replacing
`SepoliaYieldVault` with a production yield-bearing ERC-4626 source is an
integration boundary; it does not require changing the confidential prize
architecture.

## Deployment set update

The intended Sepolia testnet order is:

1. `MockUnderlyingToken` — test asset only
2. `VeilPoolConfidentialToken`
3. `VeilPool`
4. `SepoliaYieldVault` — controlled testnet simulation
5. `ERC4626YieldAdapter`
6. `PrizeEngine`
7. Configure the vault admin, adapter controller, and PrizeEngine operator

Deployment remains blocked until `SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY`,
and `OPERATOR_ADDRESS` are supplied through local environment configuration.
An `OPERATOR_PRIVATE_KEY` is needed only when setup or subsequent operator
transactions are automated from a wallet distinct from the deployer.
