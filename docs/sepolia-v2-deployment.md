# Sepolia V2 deployment preparation — winnings withdrawal

> Historical/deprecated shared-vault V2 preparation notes. It was subsequently
> deployed, but is not the canonical target. Preserve its evidence/positions.
> See [canonical isolated deployment](canonical-sepolia.md). Status below is the
> original preparation-time status, not an instruction to deploy again.

Status: **prepared, not deployed**. Approval is required before running the
deployment command. No production frontend configuration is changed by this
script. `deployments/sepolia.json` remains the authoritative historical V1 record.

Controlled Sepolia simulation / Test assets only. This is not real lending yield.

## Reuse and isolation review

| Contract | Decision | Reason |
| --- | --- | --- |
| MockUnderlyingToken | Reuse `0x60FAC1d70af4e4b6f7eF973787bddd37763508bc` | Ordinary six-decimal mock ERC-20; no pool/controller binding; unrestricted test mint is unchanged. |
| VeilPoolConfidentialToken | Reuse `0xfbC3096644cc41bAa6768897c0de286F79D1578a` | Immutable underlying, ordinary per-holder ERC-7984 balances/operator permissions; no globally assigned VeilPool/controller. V2 receives no access to V1's balance. |
| SepoliaYieldVault | Reuse `0xecF8Abb70E79aF0E9428388b66F8498b474040b1` | Immutable asset, standard per-holder ERC-4626 shares. Owner controls test donations, not adapter selection. Ownership is retained, not transferred. |
| VeilPool | New | Non-upgradeable. V1 cannot acquire `withdrawWinnings(bytes32,bytes)`. Its engine is also assigned once. |
| PrizeEngine | New | Immutable vault/token/operator references and one-time yield adapter. Must reference the new vault. |
| ERC4626YieldAdapter | New | Immutable asset/vault/admin and one-time controller, already assigned to the V1 engine. Cannot repoint it. |

This is a new empty pool, **not a migration**. Old principal, private positions,
rounds, and winnings stay with the old contracts. Historical V1 winnings do not
become claimable just because V2 supports claims. The reused wrapper's existing
wallet balances remain at the same wrapper; new deposits require participant
authorization of the **new** VeilPool as operator. The deploy script does not
authorize any participant or move assets. V2 starts at Round **1**, not the next
V1 round, with a new empty registry (cap 10).

The shared yield vault is not an isolated yield source: future donations change
the exchange rate for **all** outstanding shares, including any V1 adapter shares.
Neither adapter can withdraw the other's shares; each tracks its own principal.
Existing dust stays in the vault. Do not promise all of a later 12 mUNDER test
donation will accrue to V2, or that future conversion dust is always exactly one
unit. Review both adapters' shares and the live exchange rate before funding V2.
See [OpenZeppelin's ERC-4626 exchange-rate and rounding guidance](https://docs.openzeppelin.com/contracts/5.x/erc4626).
Strict yield isolation would require a different plan with a new yield vault;
the minimal deployment deliberately reuses it without changing its permissions.

## Script gates and sequence

`scripts/deploy-sepolia-v2.ts` pins the historical six addresses and operator
`0x51133dfa694940Fe4ebC785a5CE11B54f5C86048`. Before broadcasting it checks:

- Hardhat network `sepolia`, actual chain ID `11155111`, matching configured
  deployer/operator, completed historical record, and nonzero deployer ETH.
- Bytecode at all historical addresses; exact reusable implementation bytecode
  against local compiled sources, masking Solidity immutable slots. Then checks
  actual immutable asset/rate values, six decimals, wrapper rate 1, yield-vault
  ownership, every old vault/engine/adapter relationship, and no old adapter
  principal shortfall. A code mismatch is a blocker for review, not bypassed.
- No existing `deployments/sepolia-v2.json` attempt. Even a partial record blocks
  an automatic rerun. No V1 record or `.env` file is ever rewritten.

All six transactions use the same authorized deployer/operator:

1. Deploy `VeilPool(existingWrapper, 10)`.
2. Deploy `ERC4626YieldAdapter(existingUnderlying, existingYieldVault)`.
3. Deploy `PrizeEngine(newVeilPool, existingWrapper, operator)`.
4. New VeilPool: `setPrizeEngine(newPrizeEngine)` (deployer/admin).
5. New adapter: `setController(newPrizeEngine)` (deployer/admin).
6. New engine: `setYieldAdapter(newAdapter)` (operator).

**Expected total: six Sepolia transactions.** No approval/ownership-transfer,
mint, wrap, principal sync, yield, round, claim or participant transaction is
needed for this setup. Nonzero ETH is only a basic check, not a guarantee of
enough gas for all six transactions; review funding and current gas before use.

After wiring, the script verifies all new relationships, retained old wiring,
empty registry, Round 1 OPEN, zero new principal/prize/yield/liquidity, no pending
sync/decryption flags, and no V2 shares. It verifies
`supportsWinningsWithdrawal() == true` and performs an **eth_call only** of the
actual `withdrawWinnings(bytes32,bytes)` entry point from the unregistered signer:
it must dispatch and return `NotParticipant`. This proves API presence, not a
live funded claim; claim behavior is covered by the existing local contract suite.

## Commands (from the project root)

The existing Hardhat config reads `process.env` and does **not** load `.env`.
Preload the already-installed dotenv before Hardhat reads network configuration.
Do not print or paste the root `.env`. Required keys: `SEPOLIA_RPC_URL`,
`DEPLOYER_PRIVATE_KEY`, `OPERATOR_ADDRESS`. Their configured identities must match
the operator above. No dependency changes are required.

Read-only preflight (PowerShell, when approved to contact Sepolia):

```powershell
$env:DEPLOYMENT_PREFLIGHT_ONLY = '1'
node -r dotenv/config ./node_modules/hardhat/internal/cli/cli.js run scripts/deploy-sepolia-v2.ts --network sepolia
Remove-Item Env:DEPLOYMENT_PREFLIGHT_ONLY
```

Deploy **only after explicit approval**, with `DEPLOYMENT_PREFLIGHT_ONLY` unset:

```powershell
node -r dotenv/config ./node_modules/hardhat/internal/cli/cli.js run scripts/deploy-sepolia-v2.ts --network sepolia
```

Local/static validation (no dotenv preload; hardhat's local test accounts only):

```powershell
npm run compile
npx tsc --noEmit --project tsconfig.json
npx hardhat test test/SepoliaV2Deployment.ts --network hardhat
npx hardhat test --network hardhat
```

## Evidence and failures

The script exclusively creates `deployments/sepolia-v2.json`, initially partial.
It contains all three reused and three new addresses, operator/deployer,
historical-record hash, deployment/setup step labels, nonce, broadcast hash,
confirmed block and gas, and final verification status. Before sending each
transaction it saves intent/nonce; immediately after submission it saves the hash,
then waits for one confirmation (up to 180 seconds). Only verified completion
marks the record complete. No production `VITE_*` values are changed or generated.

On any failure, STOP. Do not delete the partial record and rerun. A timeout or
network error may still mean a transaction was broadcast/mined. Inspect the active
step, sender nonce, transaction hash and receipts read-only before choosing a
separately approved recovery plan. A process/disk failure may leave incomplete
journal data; this also requires manual chain reconciliation, not blind redeploy.
Provider exception bodies are suppressed to avoid leaking RPC credentials.

Local validation does not attest to current Sepolia ownership, liquidity, gas,
network availability or FHE service health. Those gates run again immediately
before an approved real deployment. No logic changes were needed for this plan.

## Preparation validation — 2026-09-06

- Solidity compile / TypeChain: PASS (compiled artifacts already current).
- Root TypeScript, including the new script and tests: PASS.
- Targeted V2 deployment tests: 10 passing, 0 failing.
- Complete local contract suite: 69 passing, 0 failing (includes those 10 tests
  and the existing confidential winnings, principal, draw, yield and ACL tests).
- Only the new script, its tests and this runbook were added. Historical deployment,
  Solidity, frontend, dependencies and environment configuration are unchanged.
- No live RPC preflight or Sepolia transaction was executed. No V2 deployment
  record exists yet; the approved execution will create it.
