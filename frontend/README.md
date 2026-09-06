# VeilPool frontend

The VeilPool user application is available at `/app`, with the operator panel
at `/operator`. The photography-led landing page remains at `/` and
`/loading-preview` remains the branded loader review surface.

## Development

```bash
npm install
npm run dev
```

Validation commands:

```bash
npm run generate:abis
npm test
npm run typecheck
npm run build
```

`generate:abis` reads the authoritative Hardhat artifacts from the repository
and emits `src/contracts/generated.ts`. Run it after Solidity compilation when
contract interfaces change; no partial ABI fragments are maintained by hand.

## Configuration

Copy `.env.example` to ignored `.env.local`. The example contains the canonical
isolated addresses from `deployments/sepolia-v2-isolated.json`; use those exact
public values for a future approved Vercel build. See
[canonical configuration](../docs/canonical-sepolia.md). The following names are
the configuration schema (the example file supplies the actual addresses):

```bash
VITE_CHAIN_ID=11155111
VITE_SEPOLIA_RPC_URL=https://your-sepolia-rpc.example
VITE_EXPLORER_BASE_URL=https://sepolia.etherscan.io
VITE_ZAMA_RELAYER_URL=
VITE_VEILPOOL_ADDRESS=0x...
VITE_CONFIDENTIAL_TOKEN_ADDRESS=0x...
VITE_UNDERLYING_TOKEN_ADDRESS=0x...
VITE_PRIZE_ENGINE_ADDRESS=0x...
VITE_YIELD_ADAPTER_ADDRESS=0x...
VITE_OPERATOR_ADDRESS=0x...
```

`VITE_SEPOLIA_RPC_URL` is only used when a wallet does not already have
Sepolia and the app needs to call `wallet_addEthereumChain`; the app does not
invent or embed an RPC credential. Sepolia’s public Zama relayer is used by
default by `@zama-fhe/relayer-sdk`. Do not put private keys, seed phrases, or
relayer secrets in any `VITE_*` variable.

Without the three core addresses (VeilPool, confidential token, and
underlying token), the app stays usable as a visual shell and reports
“Contracts not configured” instead of pretending blockchain state exists.
PrizeEngine is optional for the user shell but required for actual public round
state, Phase 5 synchronization status, and the operator panel. The operator
panel can use `VITE_OPERATOR_ADDRESS` for its initial UX authorization check;
when a PrizeEngine is configured, the panel cross-checks that address against
the on-chain `operator()` getter. `VITE_YIELD_ADAPTER_ADDRESS` is optional
when the configured PrizeEngine exposes a non-zero `yieldAdapter()` address.

## Wallet and network

The app uses compatible EIP-1193 EVM wallets through ethers `BrowserProvider`
and EIP-6963 provider discovery. It supports disconnected, connecting,
connected, unsupported wallet, wrong-network, and wallet-error states. Sepolia
is chain ID 11155111; the network action uses `wallet_switchEthereumChain`,
then `wallet_addEthereumChain` only when an explicit `VITE_SEPOLIA_RPC_URL` is
available. No wallet brand is required by the connection architecture.

## Confidential client

This frontend uses `@zama-fhe/relayer-sdk` 0.4.x, the client paired by the
current Hardhat template with `@fhevm/solidity` 0.11.x. Encrypted uint64 inputs
are built with `createEncryptedInput(...).add64(...).encrypt()`. User reveals
use the SDK’s generated keypair, EIP-712 authorization signature, and
`userDecrypt` request for the connected wallet only. Plaintext financial
values live only in transient React state; they are never logged, persisted,
placed in URLs, or sent to analytics.

## User workflows

### Deposit

The guided deposit flow performs separate real transactions as needed:

1. Approve the underlying ERC-20 for the confidential wrapper.
2. Wrap the underlying amount into vPOOL.
3. Authorize VeilPool as an ERC-7984 operator for 30 days when not already authorized.
4. Encrypt the uint64 amount with the Zama Relayer SDK.
5. Submit `VeilPool.deposit(externalEuint64, inputProof)` and wait for confirmation.

The UI identifies wallet confirmation separately from network confirmation and
does not collapse multiple wallet transactions into one.

### Withdraw

The user must first reveal their own savings. The app validates the requested
amount for UX, encrypts it, then submits the real
`VeilPool.withdraw(externalEuint64, inputProof)` call. The contract remains the
security boundary and clamps the request to the confidential balance.

### Phase 5 synchronization boundary

The current contracts restrict principal deployment, restoration, and the
public aggregate-liability decryption flow to the configured PrizeEngine
operator. The user app therefore does not fabricate an underlying-token
receipt or expose operator controls. It reads
`principalLiabilityRevealRequested` and `principalUnwrapPending` and reports
“Principal restoration is awaiting protocol processing” when those states are
active.

### Reveals and winnings

Savings and winnings are encrypted by default. Reveal signs the official
user-decryption EIP-712 request for the connected account and contract handle.
Hide immediately removes the plaintext from React state. No winner identity or
other participant state is exposed. Eligibility remains encrypted and is shown
as a private protocol state without a public decryption control.

### Public round state

Round ID, lifecycle state, participant count, public aggregate total when the
contract exposes it, prize accounting fields, and synchronization flags are
read from the configured PrizeEngine/VeilPool contracts. Round states map to
the contract enum: `OPEN`, `LOCKED`, `AWAITING_TOTAL_DECRYPTION`, `DRAW_READY`,
`DRAWING`, `RETRY_REQUIRED`, `SETTLED`, and `CANCELLED`.

## Operator panel

Phase 6C adds `/operator` as a separate operator-only route. It does not
merge controls into `/app` and it never reads or decrypts individual user
balances, eligibility, winnings, winner identity, or encrypted randomness.

The panel exposes the public lifecycle from `PrizeEngine.RoundState` and only
renders actions supported by the current contracts: principal sync/finalizer
steps, restoration liquidity, yield harvest, round locking, aggregate public
decryption, harvested-yield prize commitment, empty/no-yield cancellation,
encrypted draw execution, draw-acceptance public decryption, and next-round
opening. It does not expose `commitRoundPrize` because that path requires a
separate confidential reserve funding decision; the panel uses the exact
public `commitHarvestedYield` accounting path when harvested yield exists.

Public decryption and wrapper unwrap finalization remain asynchronous. The
operator must wait for the Zama proof before the finalizer transaction is
submitted. Irreversible lifecycle actions use an explanation dialog, and all
transactions show wallet, confirmation, failure, and Sepolia explorer-link
states.

The privacy boundary is explicit: the operator can operate round state and
public aggregates, but cannot inspect per-user financial state or choose the
winner. Missing Sepolia deployment configuration renders a reviewable state
without fabricated protocol data. The current deployed Sepolia addresses are
recorded in the repository root README and `deployments/sepolia-v2-isolated.json`.

The operator health panel labels the yield source as “Controlled Sepolia
simulation”. It uses test assets only, not external DeFi yield or real-money
returns. The controller must inject actual mUNDER into `SepoliaYieldVault`
through its authorized `addTestYield` path before the existing adapter can
recognize share-value appreciation as generated yield.

## Accessibility and responsive behavior

The app uses semantic buttons, labels, alerts, live transaction status, a
keyboard-closeable modal, visible focus styles, reduced-motion handling, and
responsive layouts for mobile and desktop. The operator panel follows the
same accessibility and reduced-motion behavior.

## Known limitations and Phase 7

- Sepolia round transitions are operator-triggered rather than timer-driven.
- The frontend two-hour funded countdown is informational only.
- The participant cap is 10 cumulatively across this Sepolia deployment.
- The global participant registry is not reset per round; each next-round lock
  snapshots the current live registry.
- The Sepolia yield source is a controlled test-asset simulation, not real
  lending yield or real-money returns.
- Winnings withdrawal is supported by the canonical isolated VeilPool and its
  generated ABI. After an authorized positive winnings reveal, the user can
  withdraw winnings to their confidential wrapper without reducing savings or
  eligibility, then optionally unwrap to public test mUNDER. Confirmation is
  required before refreshing; reveal the updated winnings privately afterward.
- Adding winnings back to savings is not implemented.
- WalletConnect/mobile QR support is not implemented.
- A user withdrawal is a confidential vault withdrawal. The current Phase 5
  principal-restoration boundary remains operator-controlled and asynchronous.
- Operator address configuration is UX gating only; PrizeEngine's `onlyOperator`
  modifier remains the contract security boundary.
- Public decryption/finalization can fail or remain unavailable until the
  configured Zama relayer returns a valid proof.
