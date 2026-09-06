# VeilPool Sepolia deployment runbook

> Historical/deprecated V1 runbook. Do not execute these commands for the
> canonical isolated deployment. See [current configuration](canonical-sepolia.md).

Phase 7A prepares the deployment machinery but does not deploy contracts.
Never place private keys, mnemonics, RPC credentials, or decrypted
confidential values in this document or in the deployment artifact.

## Prerequisites

- Node.js 20 or newer and npm
- Sepolia RPC URL
- A deployer wallet funded with Sepolia ETH
- A separate operator wallet only when the operator differs from the deployer
- Review of the exact source and current Zama Sepolia configuration

The production testnet asset is `MockUnderlyingToken` (`mUNDER`), a six-decimal
test token with no monetary value. Yield is provided by
`SepoliaYieldVault`, a **controlled Sepolia ERC-4626 yield simulation using test
assets**. It is not an external lending protocol or real DeFi yield source.

## Environment

Set these values in a local untracked environment, never in chat:

```text
SEPOLIA_RPC_URL=
DEPLOYER_PRIVATE_KEY=
OPERATOR_ADDRESS=
OPERATOR_PRIVATE_KEY=
EXPLORER_BASE_URL=https://sepolia.etherscan.io
```

`OPERATOR_PRIVATE_KEY` is required only when `OPERATOR_ADDRESS` differs from
the deployer address. The deployment script never logs private keys or the
RPC URL.

## Compile and test

```bash
npm install
npm run compile
npm test
cd frontend
npm test
npm run typecheck
npm run build
```

## Deployment

After the environment is reviewed and explicitly approved, the exact command
is:

```bash
npm run deploy:sepolia
```

This invokes:

```bash
npx hardhat run scripts/deploy-sepolia.ts --network sepolia
```

The script refuses non-Sepolia networks, validates chain ID `11155111`,
validates key/address relationships, aborts on zero deployer ETH, and performs
no deployment transaction until all preflight checks pass.

## Deployment order and setup

The script derives this order from the current constructors:

1. `MockUnderlyingToken`
2. `VeilPoolConfidentialToken(underlyingToken)`
3. `VeilPool(confidentialToken, 10)`
4. `SepoliaYieldVault(underlyingToken, operator)`
5. `ERC4626YieldAdapter(underlyingToken, sepoliaYieldVault)`
6. `PrizeEngine(veilPool, confidentialToken, operator)`
7. `VeilPool.setPrizeEngine(prizeEngine)`
8. `ERC4626YieldAdapter.setController(prizeEngine)`
9. `PrizeEngine.setYieldAdapter(yieldAdapter)` from the operator

`ZamaEthereumConfig` supplies the installed Zama Sepolia configuration. No
manual FHE protocol addresses are supplied by the deployment script.

## Post-deployment checks

The script verifies the wrapper asset, vault token and engine relationships,
yield-vault asset and owner, adapter asset/vault/controller, engine operator
and adapter, participant limit `10`, empty participant registry, initial round
`1 / OPEN`, zero principal/prize accounting, and no pending unwrap request.

On success it writes the public-only `deployments/sepolia.json` artifact. If a
critical step fails after deployment has started, it writes
`deployments/sepolia.partial.json` containing the public addresses and hashes
already observed, without secrets.

The artifact also contains separate Sepolia explorer links for contract
addresses and deployment/setup transaction hashes, plus the public `VITE_*`
mapping needed by the existing frontend. It never overwrites a local frontend
environment file.

## Test-yield preparation

The authorized owner of `SepoliaYieldVault` must hold mUNDER, approve the vault,
and call `addTestYield(amount)`. The transfer is asset-backed, mints no shares,
and increases standard ERC-4626 share value. The existing adapter then
recognizes only excess managed assets as generated yield. The local
`MockYieldVault` and all experimental harnesses remain test-only and must not
be deployed.

## Security notes

- Do not use `MockYieldVault`, `WeightedDrawHarness`,
  `RejectionSamplingHarness`, or `PrizeEngineDeterministicHarness` in a
  deployment.
- Do not commit `.env`, `.env.local`, private keys, mnemonics, or RPC secrets.
- Do not log private balances, private eligibility, winnings, winner identity,
  or encrypted randomness.
- A successful deployment is not sufficient; review the relationship checks
  and public artifact before configuring the frontend.
