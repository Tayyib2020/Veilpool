# VeilPool

VeilPool is a confidential prize-savings prototype for Zama fhEVM. Users
deposit an ERC-20 test asset through an ERC-7984 confidential wrapper; private
savings and draw eligibility remain encrypted while public round lifecycle and
aggregate accounting remain verifiable.

This repository contains the Solidity protocol, Hardhat tests and deployment
scripts, the reviewer-facing React/Vite frontend, and the completed Phase 7C
Sepolia evidence. It is a testnet demonstration, not a production financial
product.

## Canonical isolated Sepolia deployment

Network: Sepolia, chain ID `11155111`.

| Contract | Address |
| --- | --- |
| MockUnderlyingToken (mUNDER) | `0x60FAC1d70af4e4b6f7eF973787bddd37763508bc` |
| Confidential ERC-7984 wrapper | `0xfbC3096644cc41bAa6768897c0de286F79D1578a` |
| VeilPool | `0x139C2fe98FcE4E2D178d04127bf357C7e04FBEc6` |
| Dedicated Sepolia yield vault | `0xa072afCe9da7Bc93d398AE0985Bc64cFCf3B70F1` |
| ERC-4626 yield adapter | `0x8Af52321c4B4cb4A9937FE7c3cD32fe452521A13` |
| PrizeEngine | `0xfD9ED0c82b0Cb98741a21fc7fb1f39b898A1b008` |

Operator: `0x51133dfa694940Fe4ebC785a5CE11B54f5C86048`.
Authoritative evidence: [deployments/sepolia-v2-isolated.json](deployments/sepolia-v2-isolated.json).
See [canonical configuration and E2E evidence](docs/canonical-sepolia.md).
V1 and the previous shared-vault V2 are historical/deprecated targets; their
records and positions remain intact, with no migration. Preserve isolated
Round #1 SETTLED as the live demo; do not start Round #2 without approval.

Current intended reviewer URL: [https://veilpool.vercel.app/](https://veilpool.vercel.app/)

The remote Vercel configuration has not been changed by this canonicalization
pass. Updating its public build-time variables requires separate approval.

Deployment addresses are public configuration, never credentials. Private
keys, RPC API keys and wallet secrets must remain in ignored environment files.

## Architecture and privacy model

The underlying ERC-20 is wrapped into an OpenZeppelin ERC-7984 confidential
token. VeilPool stores encrypted savings, eligibility, principal liability and
winnings using fhEVM types and ACL permissions. A participant can request
authorized decryption of their own handles; the operator can process public
aggregate lifecycle steps but cannot decrypt individual balances or choose a
winner. Public events expose ciphertext handles and lifecycle metadata, not
plaintext confidential amounts.

The frontend uses compatible EIP-1193 EVM wallets with EIP-6963 discovery,
ethers 6, and the Zama relayer SDK. It supports `/`, `/app`, and `/operator`.
The landing page and app routes use responsive layouts for mobile and desktop.

## Local setup

Requirements: Node.js 20+ and npm 7+.

```bash
npm install
copy .env.example .env
npm run compile
npm test

cd frontend
npm install
copy .env.example .env.local
npm run dev
```

Fill local environment files with the required values. Use placeholders from
`.env.example` and `frontend/.env.example`; never commit `.env`, `.env.local`,
RPC credentials, private keys or seed phrases.

Frontend validation:

```bash
cd frontend
npm test
npm run typecheck
npm run build
```

Contract validation:

```bash
npm run compile
npm test
```

## Round lifecycle

The current lifecycle is `OPEN → LOCKED → DRAWING → SETTLED` (or
`CANCELLED`). While open, deposits can contribute to the next frozen snapshot.
At lock time, the live registry and encrypted eligibility are snapshotted.
Aggregate eligibility is publicly decrypted with a proof, yield is committed as
the prize, encrypted randomness selects by balance-weighted eligibility, and
acceptance is publicly decrypted before settlement. Participant-authorized
reveals expose only the connected participant's own savings and winnings.

On Sepolia, round transitions are operator-triggered. The frontend's two-hour
funded deposit countdown is informational only; it does not start, lock, draw, or settle
rounds automatically. VeilPool is designed for predictable recurring rounds,
such as weekly rounds, in a future production deployment.

## Yield and Phase 7C evidence

The Sepolia yield path is a controlled test-asset simulation through
the dedicated isolated `SepoliaYieldVault`, not real lending yield or real-money returns. ERC-4626
share/asset conversion produced the documented one-base-unit floor-rounding
boundary while preserving principal separately from prize accounting.

The canonical isolated E2E, including confidential winnings withdrawal and
optional unwrap to public mUNDER, is recorded in [docs/canonical-sepolia.md](docs/canonical-sepolia.md).
Historical V1 lifecycle evidence is preserved in
[docs/phase-7c-sepolia-e2e.md](docs/phase-7c-sepolia-e2e.md), including two
confidential participants, aggregate eligibility decryption, Zama encrypted
randomness draw, settlement, participant-authorized reveals, principal
restoration, private withdrawal, and final wrapper unwrap validation.

## Known limitations

- Sepolia round transitions are operator-triggered rather than timer-driven.
- The frontend two-hour funded countdown is informational only.
- The participant cap is 10 cumulatively across this Sepolia deployment.
- VeilPool uses one global participant registry; it is not reset per round.
- Each new round snapshots the current live registry when the operator locks it.
- Sepolia yield is a controlled test-asset simulation, not real DeFi yield.
- Winnings withdrawal is supported on the canonical isolated deployment: it
  transfers only winnings into the caller's confidential wrapper, not principal.
  Optional unwrap makes the returned test-token amount public.
- Adding winnings back to savings is not implemented.
- WalletConnect/mobile QR support is not implemented; compatible injected EVM
  wallets are supported through EIP-1193/EIP-6963.
- Public FHE decryption and proof finalization depend on relayer availability.
- The deployed testnet contracts and mUNDER are not intended for monetary use.

## Feature freeze

Phase 7C protocol validation is complete. The protocol feature freeze remains
active: deployment configuration, documentation, accessibility fixes and
critical bug fixes are allowed; new Solidity functionality, redeployment,
TWAB, add-winnings-to-savings, new pool mechanics and
architectural changes require explicit review.
