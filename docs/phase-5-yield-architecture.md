# VeilPool Phase 5 — Yield Layer

Phase 5 adds one modular yield path to the Phase 4 one-pool PrizeEngine:

```text
confidential vPOOL principal
        │  pool-level aggregate reveal + ERC-7984 unwrap/finalize
        ▼
ERC4626YieldAdapter ── plaintext ERC-20 ── SepoliaYieldVault (controlled testnet simulation)
        │
        ├── principalDeployed: tracked principal only
        └── generatedYield: managed assets minus tracked principal
```

The application does not allocate plaintext balances per user. `VeilPool`
maintains an encrypted aggregate principal liability, updated from the actual
confidential transfer result on deposit and withdrawal. `PrizeEngine` may
request public decryption of that aggregate only, then starts the official
OpenZeppelin `ERC7984ERC20Wrapper.unwrap` request. A later proof-backed
`finalizeUnwrap` transfers plaintext underlying to the adapter, which deposits
it into ERC-4626.

This boundary is necessary because ERC-4626 is a plaintext ERC-20 interface;
an encrypted per-user vPOOL amount cannot be passed directly into a standard
ERC-4626 vault. It is intentionally a pool-level synchronization operation,
not a user-level disclosure. The public aggregate is operational accounting,
while participant balances, eligibility, transfer amounts, and winnings stay
encrypted.

## Yield and prize separation

`ERC4626YieldAdapter.principalDeployed` is increased only when principal is
deployed and decreased only when principal is restored. `generatedYield` is
the adapter's managed assets in excess of that tracked principal. Harvesting
withdraws only the surplus. The engine wraps harvested underlying back into
confidential vPOOL, adds it to the separate encrypted prize reserve, and tracks
the aggregate harvested amount as `unallocatedHarvestedYield` for exact public
reserve accounting.

Harvesting is allowed only while a round is `Open`. Therefore yield accrued
after a round is locked cannot change that round's prize snapshot; it remains
in the adapter until the next open round is started and harvested.

`commitHarvestedYield` can commit only an available harvested slice. It cannot
create a prize when no yield is available. A no-yield `DrawReady` round can be
cancelled with `cancelNoYieldRound`. RetryRequired reuses the same committed
encrypted round prize exactly once; a retry does not re-harvest or duplicate
the reserve.

## Liquidity synchronization limitation

Because wrapper unwrapping is asynchronous, principal restoration is an
explicit operator action: `restorePrincipalLiquidity` withdraws all tracked
principal from ERC-4626 to the vault and wraps it into liquid vPOOL before
user confidential withdrawals are expected. The engine does not pretend that a
plaintext ERC-4626 withdrawal and a confidential user withdrawal are atomic in
one transaction. The adapter leaves generated yield deployed when principal
is restored, so harvesting remains separate from principal liquidity.

## Privacy and events

The project emits no custom plaintext principal, deposit, withdrawal, balance,
or confidential transfer amount. Existing application events contain only
addresses, round identifiers, or the explicitly disclosed aggregate total.
OpenZeppelin ERC-7984 wrapper events may contain ciphertext handles; those are
not plaintext amounts. The tests verify this distinction and retain the
official asynchronous unwrap flow.

## Controlled Sepolia simulation

`SepoliaYieldVault` is a controlled Sepolia ERC-4626 yield simulation using
test assets. It is not an external lending protocol or a source of real yield.
Its owner transfers additional mUNDER through `addTestYield`, which increases
total assets without minting shares and exercises standard ERC-4626 share-value
appreciation. The local `MockYieldVault` remains test-only and must not be
deployed.

## Scope

This spike includes `IYieldAdapter`, `ERC4626YieldAdapter`, the local
`MockYieldVault`, principal synchronization, harvest accounting, and the
PrizeEngine integration tests. It does not add frontend code, multiple pools,
tiers, TWAB, governance, referrals, NFTs, or a production external yield
protocol.

References:

- [OpenZeppelin Confidential Contracts ERC-7984 API](https://docs.openzeppelin.com/confidential-contracts/api/token)
- [OpenZeppelin Contracts ERC-4626 API](https://docs.openzeppelin.com/contracts/5.x/erc4626)
- [Zama public decryption and proof verification](https://docs.zama.org/protocol/solidity-guides/smart-contract/oracle)
