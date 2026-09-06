# Isolated Sepolia deployment preparation

Status: **prepared locally, not deployed**. No live preflight, deployment,
compensation, migration or yield injection was executed during this preparation.
V1 and current V2, their records, Solidity, and frontend configuration are unchanged.

**Controlled Sepolia simulation / Test assets only.** This is not lending yield.

## Architecture and exact seven-transaction plan

Reuse only:

- MockUnderlyingToken: `0x60FAC1d70af4e4b6f7eF973787bddd37763508bc`
- VeilPoolConfidentialToken: `0xfbC3096644cc41bAa6768897c0de286F79D1578a`

Deployer/operator/yield-vault owner:
`0x51133dfa694940Fe4ebC785a5CE11B54f5C86048`.

Execute in this order, only after explicit approval:

1. Deploy `SepoliaYieldVault(existingUnderlying, operator)`.
2. Deploy `VeilPool(existingWrapper, 10)`.
3. Deploy `ERC4626YieldAdapter(existingUnderlying, newYieldVault)`.
4. Deploy `PrizeEngine(newVeilPool, existingWrapper, operator)`.
5. New VeilPool: `setPrizeEngine(newEngine)`.
6. New adapter: `setController(newEngine)`.
7. New engine: `setYieldAdapter(newAdapter)`.

There are no approval, ownership-transfer, funding or lifecycle transactions in
this script. Constructors make the deployer the one-time wiring admin; the
deployer must equal the configured operator. No new Solidity functionality is
required. The old adapter's immutable vault, old engine's one-time adapter, and
old VeilPool's one-time engine preclude rewiring either historical deployment.

The new yield vault has a separate asset balance, share supply and exchange rate.
Test-yield injections there cannot reprice shares of the old shared yield vault.
V1/current V2 adapters remain permanently bound to their old yield vault. The
reused ERC-20 and ERC-7984 wrapper have per-holder balances; neither introduces
an ERC-4626 exchange-rate link between the two yield vaults.

The yield vault is standard permissionless ERC-4626, not an adapter allowlist.
If third parties independently acquire shares in the new vault, they too benefit
from its donations. Isolation here means separation from V1/current V2's existing
adapter investments, not an exclusive-shareholder guarantee.

## Checks and evidence

`scripts/deploy-sepolia-v2-isolated.ts` checks before broadcasting:

- Sepolia network/chain `11155111`, pinned V1 and V2 records/addresses, matching
  deployer/operator, and nonzero operator ETH.
- Compiled reusable token/wrapper bytecode (Solidity immutable slots masked),
  underlying asset, decimals 6 and wrapper rate 1.
- Bytecode at historical contract addresses and all historical
  vault/engine/adapter references, asset references and yield-vault owner.
- A public accounting snapshot of both historical deployments. The known V2
  principal shortfall is recorded, not compensated or treated as new-pool funds.
- No existing isolated attempt journal.

After setup it checks all new references, owner/operator, cap 10, empty registry,
Round 1 OPEN, zero public/confidential initial accounting, no pending sync or
acceptance flags, no funding, zero new yield-vault assets/shares, no historical
adapter shares there, and `supportsWinningsWithdrawal() == true`. An `eth_call`
of `withdrawWinnings(bytes32,bytes)` must dispatch and return `NotParticipant`
because the fresh registry is empty; this is not a funded claim or broadcast.

It rechecks old references and compares the public accounting snapshots. Any
difference stops completion for manual reconciliation, even if caused by another
user rather than the script. Avoid concurrent V1/V2 operations during deployment.

The only output journal is `deployments/sepolia-v2-isolated.json`. It is created
exclusively and stores hashes of both historical records, new/reused addresses,
active step, nonce, transaction hash, confirmation block/gas, legacy accounting
before/after, and final verification status. Intent is saved before broadcast;
hashes are saved before waiting for confirmation. Writes flush to disk. Existing
partial/complete journals are never automatically resumed or overwritten.

On failure: STOP, inspect journal/nonce/receipt read-only, and reconcile any
ambiguous broadcast before approving a recovery plan. A 180-second confirmation
timeout does not imply the transaction failed. The error handler distinguishes
pre-journal failures from existing-journal failures, and suppresses credential-
bearing RPC exception bodies. No frontend environment files are generated.

## Commands

From the project root. The existing Hardhat config needs dotenv preloaded before
reading `SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, and `OPERATOR_ADDRESS`. Do not
print the existing root `.env` or copy it into frontend config.

Local validation (no root dotenv preload):

```powershell
npm run compile
npx tsc --noEmit --project tsconfig.json
npx hardhat test test/SepoliaIsolatedDeployment.ts --network hardhat
npx hardhat test --network hardhat
```

Optional read-only Sepolia preflight, when approved:

```powershell
$env:DEPLOYMENT_PREFLIGHT_ONLY = '1'
try {
  node -r dotenv/config ./node_modules/hardhat/internal/cli/cli.js run scripts/deploy-sepolia-v2-isolated.ts --network sepolia --no-compile
} finally {
  Remove-Item Env:DEPLOYMENT_PREFLIGHT_ONLY
}
```

Actual deployment command, **only after approval**, with preflight-only unset:

```powershell
node -r dotenv/config ./node_modules/hardhat/internal/cli/cli.js run scripts/deploy-sepolia-v2-isolated.ts --network sepolia --no-compile
```

Compile and validate first; `--no-compile` uses those artifacts. Gas funding,
current RPC health, and live relationship checks remain execution-time gates.

## Fresh deployment behavior and historical balances

The isolated pool starts at Round 1 OPEN with zero participants, principal,
winnings, reserve, committed prize, unallocated yield, adapter shares and
underlying yield-vault assets. It supports confidential winnings withdrawals
only for winnings credited in this new pool. Users must authorize the new vault
and deposit anew. No V1/current V2 balances are imported, erased or unlocked.

Do not point the frontend at a partial deployment. A later configuration change
requires separate approval. The existing initial-Round-1 monitor limitation
(no constructor `RoundOpened` event and old scan-start block) is not addressed
by this deployment preparation; core contract operations are independent of it.

## Current V2 two-base-unit shortfall — separate diagnosis

This analysis uses the read-only snapshot previously observed at Sepolia block
11,646,944. No new live reads or compensation were performed in this task.
The local fixture reconstructs the aggregate ERC-4626 state and a production
V2 principal deployment, not V1's full transaction history/private positions.

Observed shared vault after V2's 90,000,000-unit principal deposit:

- Assets `A = 365,000,002`; shares `S = 174,869,337`.
- V1 adapter shares `131,750,871`; V2 adapter shares `43,118,466`.
- V2 principal recorded `90,000,000`; managed assets `89,999,998`.

OpenZeppelin ERC-4626 uses virtual assets/shares, offset zero here:

```text
minted shares = floor(assetsDeposited * (supplyBefore + 1) / (assetsBefore + 1))
managed assets = floor(holderShares * (totalAssets + 1) / (totalSupply + 1))

floor(90,000,000 * 131,750,872 / 275,000,003) = 43,118,466 shares
floor(43,118,466 * 365,000,003 / 174,869,338) = 89,999,998 assets
```

This exactly reproduces the two-unit gap. The adapter records the full deposited
asset amount as principal, but the share allocation and subsequent asset quote
round down. At this exchange rate a share is worth more than two underlying base
units, so a universal one-base-unit loss assumption is invalid. See
[OpenZeppelin's ERC-4626 rounding guidance](https://docs.openzeppelin.com/contracts/5.x/erc4626).

`restorePrincipalLiquidity()` requests the full recorded 90,000,000 from the
adapter. `withdrawPrincipal()` checks that against `managedAssets()` and reverts
with `InsufficientManagedAssets` (`0x09feda75`) before redemption. Sending two
underlying units directly to the adapter does **not** help: `managedAssets()`
counts only the value of its yield-vault shares, not loose ERC-20 balances.

### Smallest technical recovery candidate — NOT authorized/executed on Sepolia

At the recorded exchange rate, a sponsor could obtain one extra vault share
directly for the V2 adapter via standard ERC-4626 `mint(1, v2Adapter)`:

- `previewMint(1) = 3` underlying base units (0.000003 mUNDER).
- Approval of those three units would be needed if allowance is insufficient.
- V2 managed assets would become `90,000,001` with principal still `90,000,000`.
- The existing operator `restorePrincipalLiquidity()` would then succeed.

The local test verifies the full flow and an important side effect: while V1's
integer asset quote is unchanged immediately after the sponsored share mint,
the subsequent rounded-up share burn during V2 restoration increases V1's
computed managed assets by **one base unit**. V1's share balance is unchanged,
but its computed accounting is not. Thus this candidate does **not** meet a
strict zero-V1-accounting-impact constraint. No live recovery command is provided.

A transfer of an already-existing share from a willing independent shareholder
would avoid changing vault supply/assets at transfer time, but all real shares
in this snapshot belong to V1 and V2; there is no such external holding evidenced.
Restoration itself also has rounding effects. Never take shares from V1, inject
into the shared vault, or assume a live quote remains unchanged without separate
approval and fresh read-only checks.

**Recommendation:** leave current V2 balances untouched while preparing the fresh
isolated pool. Treat recovery as a separate decision: either explicitly approve
the bounded shared-vault accounting effect after revalidation, or retain the
strict no-impact constraint. No proven in-place recovery satisfying that strict
constraint is established here. The isolated deployment does not depend on it.

## Local validation — 2026-09-06

- Solidity compile and TypeChain: PASS (artifacts already current).
- Root TypeScript, including deployment scripts and tests: PASS.
- New deployment tests: 8 passing; local recovery-diagnosis tests: 3 passing.
- Full contract suite: **80 passing, 0 failing**. This includes the existing
  winnings, principal, draw, yield, wrapper and ACL coverage.
- The new tests use fresh fixtures: snapshot rewinds initially exposed an empty
  public-decryption result in the installed FHE mock during a later existing
  test. Fresh fixtures resolved the suite interaction without changing contracts,
  dependencies, existing tests, or weakening assertions.
- Local isolation test: 90,000,000 principal plus a 12,000,000 test donation in
  the dedicated vault produced 11,999,999 generated-yield units, with both old
  adapters' accounting unchanged. These are local fixture results, not Sepolia
  transactions or a promise about future rounding at different exchange rates.
- `deployments/sepolia-v2-isolated.json` has not been created. No live preflight,
  transactions, frontend/config changes, commits or pushes were performed.
